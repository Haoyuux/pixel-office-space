import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { roleDef, type Project, type RoleId, type Ticket, type TicketMode } from '@office/shared';
import { useOffice } from '../state/store';
import { api, paths } from './api';
import { accentCss, kindIcon, kindStatus, kindTitle, ticketKind, canResume, isActive, relativeDate, roleEmoji, roleShort, STATUS_ICON } from './format';
import { ClaudeBanner, useClaudeStatus } from './claudeStatus';
import { COMMANDS, MODEL_DESC, isModel, parseCommand, suggest, type CommandName } from './slash';
import { Feed } from './Feed';
import { RawLog } from './RawLog';
import { Changes } from './Changes';
import { GitBanner } from './GitBanner';
import { PlanView } from './PlanView';
import { PipelineBar } from './PipelineBar';
import { TeamDialog } from './TeamDialog';
import { rootOf, threadOf, threadsOf } from './threads';
import { loadHistory } from '../state/socket';

export const DRAWER_WIDTH = 560;
type Tab = 'feed' | 'raw' | 'changes' | 'plan';
const TABS: { id: Tab; label: string }[] = [{ id: 'feed', label: 'Feed' }, { id: 'raw', label: 'Raw log' }, { id: 'changes', label: 'Changes' }, { id: 'plan', label: 'Plan' }];

/** Newest first. */
const byNewest = (a: Ticket, b: Ticket) => b.createdAt.localeCompare(a.createdAt);

/** The project's console: header in its accent, ticket picker + pipeline, Feed / Raw log / Changes / Plan, input box. */
export function Drawer({ projectId }: { projectId: string }) {
  const project = useOffice(s => s.projects[projectId]);
  const all = useOffice(s => s.tickets);
  const roleFilter = useOffice(s => s.roleFilter);
  const diffs = useOffice(s => s.diffs);
  const tickets = useMemo(() => Object.values(all).filter(t => t.projectId === projectId).sort(byNewest), [all, projectId]);
  const threads = useMemo(() => threadsOf(projectId, all), [all, projectId]);
  const active = tickets.find(isActive);
  const queued = tickets.filter(t => t.status === 'queued');
  /** A ticket of the conversation the owner opened (any ticket of the thread: its root is looked up). */
  const [chosen, setChosen] = useState<string | null>(null);
  /** /new or /clear: nothing is shown and the next message starts a fresh conversation. */
  const [fresh, setFresh] = useState(false);
  // the open conversation: the one picked, else the one running; nothing → welcome + a fresh composer
  const openRoot = fresh ? undefined : (chosen && all[chosen] ? rootOf(chosen, all) : undefined) ?? (active ? rootOf(active.id, all) : undefined);
  const thread = useMemo(() => (openRoot ? threadOf(openRoot, all) : []), [openRoot, all]);
  /** The latest ticket of the conversation: header, pipeline, raw log, and what the composer continues. */
  const shown = thread[thread.length - 1];
  const latestWith = (has: (t: Ticket) => boolean) => [...thread].reverse().find(has) ?? shown;
  const [tab, setTab] = useState<Tab>('feed');
  const [team, setTeam] = useState(false);
  const [past, setPast] = useState(false);
  const [pastFilter, setPastFilter] = useState('');
  const pastBox = useRef<HTMLInputElement>(null);
  const [pastFocus, setPastFocus] = useState(0);
  /** A local card from /status or /help (not persisted). */
  const [card, setCard] = useState<null | 'status' | 'help'>(null);
  /** A command remounts the composer (new key): give the new box the focus. */
  const refocus = useRef(false);
  const [menu, setMenu] = useState<null | 'open' | 'delete' | 'cancel'>(null);
  const [menuError, setMenuError] = useState<string | null>(null);
  /** A menu request (cancel / delete) is in flight: further clicks are ignored. */
  const [menuBusy, setMenuBusy] = useState(false);
  const menuBusyRef = useRef(false);
  const close = () => useOffice.getState().select(null);

  // the role filter is global (a bot click sets it): drop it when it names a role this team doesn't have
  const team0 = project?.team;
  useEffect(() => {
    if (team0 && roleFilter !== 'all' && !team0.includes(roleFilter)) useOffice.getState().setRoleFilter('all');
  }, [team0, roleFilter]);

  useEffect(() => { if (pastFocus) pastBox.current?.focus(); }, [pastFocus]);

  // opening a conversation: fetch the history of any of its tickets the client has no feed for yet
  useEffect(() => {
    if (!openRoot) return;
    const feed = useOffice.getState().feed;
    if (threadOf(openRoot, useOffice.getState().tickets).some(t => !feed[t.id])) void loadHistory(projectId);
  }, [openRoot, projectId]);

  useEffect(() => {
    // Escape closes the menu, then the drawer; never while a dialog is open (it handles its own Escape) or while typing
    const key = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape' || team || document.querySelector('.po-modal') || e.target instanceof HTMLTextAreaElement) return;
      if (menu) setMenu(null); else close();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [team, menu]);

  if (!project) return null;
  const accent = accentCss(project.accent);
  const mode = project.agentsMode ?? 'claude';
  // Initialize git is offered only when no repo was found (never for a parent of repos)
  const needsGit = !project.repos?.length && project.gitKind !== 'multi'
    && /not-a-git-repo/.test(tickets[0]?.status === 'failed' ? tickets[0].reason ?? '' : '');

  /** Runs one menu request at a time; `done` runs on success, the server error shows inline otherwise. */
  const once = async (req: () => ReturnType<typeof api>, done: () => void) => {
    if (menuBusyRef.current) return;
    menuBusyRef.current = true; setMenuBusy(true); setMenuError(null);
    const r = await req();
    menuBusyRef.current = false; setMenuBusy(false);
    if (r.ok) done(); else setMenuError(r.error);
  };
  const remove = () => once(() => api('DELETE', paths.project(project.id)), close);
  const target = active;
  const cancelTicket = () => { if (target) void once(() => api('POST', paths.cancel(target.id)), () => setMenu(null)); };
  const q = pastFilter.trim().toLowerCase();
  const pastShown = q ? threads.filter(th => th.tickets.some(t => kindTitle(t).toLowerCase().includes(q))) : threads;
  /** Back to the welcome view: the next message starts a new conversation (nothing is lost). */
  const startFresh = () => { refocus.current = true; setChosen(null); setFresh(true); setPast(false); };

  /** Drawer-side slash commands; a returned string is shown under the composer as a hint. */
  const command = async (name: CommandName, arg: string): Promise<string | void> => {
    switch (name) {
      case 'resume':
        if (!threads.length) return 'No past conversations yet';
        setPastFilter(arg); setPast(true); setPastFocus(n => n + 1);
        return;
      case 'new': case 'clear':
        startFresh();
        return;
      case 'cancel':
        if (!active) return 'Nothing is running';
        setMenuError(null); setMenu('cancel');
        return;
      case 'status': case 'help': setCard(name); return;
      case 'team': setTeam(true); return;
      case 'model': {
        const m = arg.toLowerCase();
        if (!isModel(m)) return `Unknown model — pick ${Object.keys(MODEL_DESC).join(', ')}`;
        const r = await api<Project>('PATCH', paths.project(project.id), { model: m });
        if (!r.ok) return r.error;
        // the server broadcasts project.updated too; apply the reply now so the header updates at once
        const u = r.data;
        if (u && typeof u === 'object' && u.id === project.id) useOffice.setState(s => ({ projects: { ...s.projects, [u.id]: u } }));
        return `Model: ${m === 'default' ? "Claude Code's default" : m} (applies to the next run)`;
      }
      default: return;
    }
  };

  return (
    <aside className="po-drawer" style={{ ['--accent' as string]: accent, width: DRAWER_WIDTH }} aria-label={`${project.name} console`}>
      <header className="po-dh">
        <div className="po-dh-row">
          <span className="po-dh-dot" aria-hidden />
          <h2 className="po-dh-name">{project.name.toUpperCase()}</h2>
          <span className="po-dh-folder" title={project.folder}>{project.folder}</span>
          <span className="po-grow" />
          {!!project.repos?.length && (
            <span className="po-badge po-repos" title={`Multi-repo project: ${project.repos.map(r => r.path).join(', ')}`}>
              {project.repos.map(r => r.name).join(' · ')}
            </span>
          )}
          {project.model && project.model !== 'default' && (
            <span className="po-badge po-model" title="Claude model for this project's runs (change it with /model)">{project.model}</span>
          )}
          <span className={`po-badge ${mode}`} title="Who works this project's tickets (change it in Team)">{mode === 'claude' ? 'Claude Code' : 'Simulated'}</span>
          <button type="button" className="po-hbtn" aria-label="New conversation" title="New conversation (/new)" onClick={startFresh}>＋ New</button>
          <button type="button" className="po-hbtn" onClick={() => setTeam(true)} title="Edit team">Team · {project.team.length}</button>
          <button type="button" className={`po-hbtn${menu ? ' on' : ''}`} aria-label="Project menu" aria-expanded={!!menu} onClick={() => { setMenu(m => (m ? null : 'open')); setMenuError(null); }}>⋯</button>
          <button type="button" className="po-hbtn" aria-label="Close console" onClick={close}>✕</button>
        </div>
        {menu && (
          <div className="po-menu" role="menu">
            {menu === 'open' ? <>
              <button type="button" role="menuitem" disabled={!active} onClick={() => setMenu('cancel')}>⊘ Cancel running ticket…</button>
              <button type="button" role="menuitem" className="danger" onClick={() => setMenu('delete')}>🗑 Delete project…</button>
            </> : menu === 'cancel' ? <div className="po-confirm">
              <span>Cancel <b>{active?.title ?? 'the running ticket'}</b>? The team stops and the ticket ends as cancelled.</span>
              <div className="po-actions">
                <button type="button" className="po-btn ghost" onClick={() => setMenu('open')}>Keep running</button>
                <button type="button" className="po-btn danger" disabled={menuBusy || !active} onClick={cancelTicket}>Cancel ticket</button>
              </div>
            </div> : <div className="po-confirm">
              <span>Delete <b>{project.name}</b>? Its tickets are cancelled and the room is emptied. Files in the folder are kept.</span>
              <div className="po-actions">
                <button type="button" className="po-btn ghost" onClick={() => setMenu('open')}>Keep it</button>
                <button type="button" className="po-btn danger" disabled={menuBusy} onClick={() => void remove()}>Delete project</button>
              </div>
            </div>}
            {menuError && <div className="po-error" role="alert">{menuError}</div>}
          </div>
        )}
      </header>
      {mode === 'claude' && <ClaudeBanner />}
      {needsGit && <GitBanner projectId={project.id} />}

      <div className="po-ticketbar">
        <div className="po-ticket-row">
          <span aria-hidden>{kindIcon(shown)}</span>
          {shown ? <span className="po-ticket-title" title={kindTitle(shown)}>{kindTitle(shown)}</span>
            : <span className="po-dim po-grow">no conversations yet — ask below</span>}
          {shown && <span className={`po-chip ${shown.status}`}>{shown.status === 'waiting' ? '⏸ waiting for you' : kindStatus(shown)}</span>}
          {queued.length > 0 && <span className="po-chip queued" title={queued.map(t => t.title).join('\n')}>+{queued.length} queued</span>}
          {threads.length > 0 && (
            <button type="button" className={`po-hbtn${past ? ' on' : ''}`} aria-expanded={past} onClick={() => { setPast(o => !o); setPastFilter(''); }}>
              Past conversations · {threads.length}
            </button>
          )}
        </div>
        {past && <div className="po-past-wrap">
          <input ref={pastBox} className="po-past-filter" aria-label="Filter conversations" placeholder="filter by title…" value={pastFilter}
            spellCheck={false} onChange={e => setPastFilter(e.target.value)}
            onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); setPast(false); } }} />
          <ul className="po-past" aria-label="Past conversations">
            {pastShown.length === 0 && <li className="po-dim po-past-none">no conversation matches</li>}
            {pastShown.map(({ root, latest, tickets: ts }) => {
              const roles = [...new Set(ts.flatMap(t => Object.keys(t.agentStates) as RoleId[]))];
              const turns = ts.reduce((n, t) => n + (t.usage?.turns ?? 0), 0);
              return (
                <li key={root.id}>
                  <button type="button" className={`po-past-item${root.id === openRoot ? ' on' : ''}`} onClick={() => { setChosen(root.id); setFresh(false); setPast(false); }}>
                    <span className="po-past-title">{kindIcon(latest)} {kindTitle(root)}</span>
                    <span className="po-past-meta">
                      <span className="po-dim">{relativeDate(latest.createdAt)}</span>
                      <span className={`po-chip ${latest.status}`}>{kindStatus(latest)}</span>
                      <span className="po-dim" title="Messages in this conversation">{ts.length} message{ts.length === 1 ? '' : 's'}</span>
                      {roles.length > 0 && <span title={roles.map(roleShort).join(', ')}>{roles.map(roleEmoji).join('')}</span>}
                      {turns > 0 && <span className="po-dim" title="Uses your Claude plan — not charged">{turns} turns</span>}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>}
        {(!shown || ticketKind(shown) === 'ticket') && <PipelineBar team={project.team} ticket={shown} />}
        {shown?.status === 'failed' && shown.reason && (
          <div className="po-fail-row">
            <div className="po-error">failed: {shown.reason}</div>
            {canResume(shown) && <ResumeButton ticketId={shown.id} />}
          </div>
        )}
      </div>

      <nav className="po-tabs" role="tablist">
        {TABS.map(t => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'on' : ''} onClick={() => setTab(t.id)}>{t.label}</button>
        ))}
        <span className="po-grow" />
        <label className="po-filter">
          <span className="po-dim">filter</span>
          <select aria-label="Role filter" value={roleFilter} onChange={e => useOffice.getState().setRoleFilter(e.target.value as RoleId | 'all')}>
            <option value="all">All roles</option>
            {project.team.map(r => <option key={r} value={r}>{roleDef(r).emoji} {roleShort(r)}</option>)}
          </select>
        </label>
      </nav>

      {card && <CommandCard kind={card} project={project} onClose={() => setCard(null)} />}
      <div className="po-body">
        {!shown ? <div className="po-scroll"><div className="po-empty po-welcome">
            <div className="po-welcome-title">{project.name} is ready.</div>
            <div>Ask a question, or describe a change — the PM answers, or plans it for your approval.</div>
          </div></div>
          : tab === 'feed' ? <Feed ticketIds={thread.map(t => t.id)} onShow={setTab} />
          : tab === 'raw' ? <RawLog ticketId={shown.id} />
          : tab === 'changes' ? <Changes ticketId={latestWith(t => !!diffs[t.id]?.length).id} repos={project.repos?.map(r => r.name)} />
          : <PlanView ticket={latestWith(t => !!t.plan)} />}
      </div>

      <Composer key={openRoot ?? ''} projectId={project.id} active={active} latest={shown} refocus={refocus}
        onCreated={(created, followUp) => {
          // a follow-up stays in this conversation; a new conversation opens once its ticket arrives
          refocus.current = true; setFresh(false); setChosen(followUp ? openRoot ?? null : created?.id ?? null);
        }} onCommand={command} />
      {team && <TeamDialog project={project} onClose={() => setTeam(false)} />}
    </aside>
  );
}

/** Picks an interrupted / failed claude ticket up again; a 409 (e.g. another ticket running) shows inline. */
function ResumeButton({ ticketId }: { ticketId: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resume = async () => {
    setBusy(true); setError(null);
    const r = await api('POST', paths.resume(ticketId));
    setBusy(false);
    if (!r.ok) setError(r.error);
  };
  return <>
    <button type="button" className="po-btn primary" disabled={busy} onClick={() => void resume()}>Resume ▸</button>
    {error && <span className="po-error-text" role="alert">{error}</span>}
  </>;
}

/** /status and /help: a local card at the top of the feed area (never persisted). */
function CommandCard({ kind, project, onClose }: { kind: 'status' | 'help'; project: Project; onClose: () => void }) {
  return (
    <section className="po-cmdcard" role="region" aria-label={kind === 'status' ? 'Status' : 'Commands'}>
      <div className="po-cmdcard-head">
        <b>{kind === 'status' ? '/status' : 'Commands'}</b>
        <span className="po-grow" />
        <button type="button" className="po-hbtn" aria-label="Close card" onClick={onClose}>✕</button>
      </div>
      {kind === 'status' ? <StatusRows project={project} /> : (
        <dl className="po-cmdcard-grid">
          {COMMANDS.map(c => <div key={c.name}><dt>/{c.name}{c.args ? ` ${c.args}` : ''}</dt><dd>{c.desc}</dd></div>)}
        </dl>
      )}
    </section>
  );
}

function StatusRows({ project }: { project: Project }) {
  const s = useClaudeStatus();
  const ends = s?.signInEndsAt ? new Date(s.signInEndsAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—';
  const repos = project.repos?.length ? project.repos.map(r => r.name).join(', ')
    : project.gitKind === 'none' ? 'not a git repo' : 'single repo (the folder)';
  const rows: [string, string][] = [
    ['Claude Code', !s ? 'checking…' : s.found ? `found${s.version ? ` · v${s.version}` : ''}` : 'not installed'],
    ['Logged in', !s ? '…' : s.loggedIn ? 'yes' : 'no'],
    ['Account', s?.accountType ?? '—'],
    ['Sign-in ends', ends],
    ['Agents', (project.agentsMode ?? 'claude') === 'claude' ? 'Claude Code' : 'Simulated'],
    ['Model', !project.model || project.model === 'default' ? "default (Claude Code's default)" : project.model],
    ['Repos', repos],
  ];
  return <dl className="po-cmdcard-grid">{rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>;
}

const MODES: { id: TicketMode; label: string; hint: string }[] = [
  { id: 'auto', label: 'Auto', hint: 'The PM decides: answers a question, plans a change' },
  { id: 'ask', label: 'Chat', hint: 'Just an answer — nothing is changed' },
  { id: 'ticket', label: 'Change', hint: 'Always plan and build (plan gate, team, final review)' },
];

/** Auto · Chat · Change: how the PM treats a new request. */
function ModeSwitch({ mode, onChange }: { mode: TicketMode; onChange: (m: TicketMode) => void }) {
  return (
    <div className="po-mode" role="radiogroup" aria-label="Mode">
      {MODES.map(m => (
        <label key={m.id} className={`po-mode-opt${mode === m.id ? ' on' : ''}`} title={m.hint}>
          <input type="radio" name="po-mode" value={m.id} checked={mode === m.id} onChange={() => onChange(m.id)} />
          <span>{m.label}</span>
        </label>
      ))}
    </div>
  );
}

/**
 * Input box. A conversation is open (`latest` = its newest ticket): running / waiting → message to the team; otherwise
 * a follow-up ticket of it. Nothing open → a new conversation (queued while another ticket runs). The toggle forces a new one.
 */
function Composer({ projectId, active, latest, refocus, onCreated, onCommand }: {
  projectId: string;
  /** The project's running ticket (any conversation). */
  active: Ticket | undefined;
  latest: Ticket | undefined;
  onCreated: (created: Ticket | undefined, followUp: boolean) => void;
  refocus?: { current: boolean };
  onCommand?: (name: CommandName, arg: string) => Promise<string | void>;
}) {
  const [text, setText] = useState('');
  const [mode, setMode] = useState<TicketMode>('auto');
  const [asTicket, setAsTicket] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Feedback from a slash command (unknown command, nothing running…). */
  const [note, setNote] = useState<string | null>(null);
  const [pick, setPick] = useState(0);
  /** Esc closed the popup; it opens again when the text changes. */
  const [dismissed, setDismissed] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const toTeam = !!latest && !asTicket && isActive(latest);
  const continuing = !!latest && !asTicket && !toTeam;
  const creating = !toTeam;
  const rowsShown = dismissed ? [] : suggest(text);
  const sel = rowsShown.length ? Math.min(pick, rowsShown.length - 1) : 0;

  useEffect(() => { if (refocus?.current) { refocus.current = false; box.current?.focus(); } }, [refocus]);

  const edit = (v: string) => { setText(v); setPick(0); setDismissed(false); setNote(null); };

  /** Runs `/name arg` locally: never sent to the agents. */
  const runCommand = async (raw: string) => {
    const c = parseCommand(raw);
    setError(null);
    if (!c || !c.known) { setNote('Unknown command — type /help'); return; }
    const name = c.name as CommandName;
    if (name === 'model' && !c.arg) { edit('/model '); box.current?.focus(); return; } // shows the model picker
    setText(''); setPick(0); setDismissed(false); setNote(null);
    if (name === 'chat' || name === 'change' || name === 'auto') { setMode(name === 'chat' ? 'ask' : name === 'change' ? 'ticket' : 'auto'); return; }
    const out = await onCommand?.(name, c.arg);
    if (out) setNote(out);
  };

  const send = async () => {
    const t = text.trim();
    if (t.startsWith('/')) { void runCommand(t); return; }
    if (!t || busy) return;
    setBusy(true); setError(null);
    const r = toTeam ? await api<Ticket>('POST', paths.messages(latest!.id), { text: t })
      : await api<Ticket>('POST', paths.tickets(projectId), continuing ? { text: t, parentTicketId: latest!.id, mode } : { text: t, mode });
    setBusy(false);
    if (!r.ok) { setError(r.error); return; }
    setText('');
    if (creating) {
      const created = r.data && typeof r.data === 'object' && typeof r.data.id === 'string' ? r.data : undefined;
      setAsTicket(false); onCreated(created, continuing);
    }
    box.current?.focus();
  };
  const key = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (rowsShown.length) {
      const n = rowsShown.length;
      if (e.key === 'ArrowDown') { e.preventDefault(); setPick((sel + 1) % n); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setPick((sel - 1 + n) % n); return; }
      if (e.key === 'Escape') { e.preventDefault(); setDismissed(true); return; }
      if (e.key === 'Tab') { e.preventDefault(); edit(rowsShown[sel].complete); return; }
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void runCommand(rowsShown[sel].run); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); }
  };
  const hint = continuing ? 'Continue this conversation…' : toTeam ? 'message the team…' : active ? 'queue a new ticket…'
    : mode === 'ask' ? 'Ask a question…' : mode === 'ticket' ? 'Describe a change…' : 'Ask anything, or describe a change…';
  const rows = Math.min(6, Math.max(1, text.split('\n').length));
  const unknown = text.startsWith('/') && !rowsShown.length && !dismissed && !parseCommand(text)?.known && !/\s/.test(text.trim());

  return (
    <footer className="po-composer">
      {error && <div className="po-error" role="alert">{error}</div>}
      {rowsShown.length > 0 && (
        <ul className="po-slash" role="listbox" aria-label="Commands">
          {rowsShown.map((r, i) => (
            <li key={r.label} role="option" aria-selected={i === sel} className={i === sel ? 'on' : ''}
              onMouseEnter={() => setPick(i)} onMouseDown={e => { e.preventDefault(); void runCommand(r.run); }}>
              <span className="po-slash-cmd">{r.label}</span> <span className="po-slash-desc">{r.desc}</span>
            </li>
          ))}
        </ul>
      )}
      {(note || unknown) && <div className="po-slash-note" role="status">{unknown ? 'Unknown command — type /help' : note}</div>}
      <div className={`po-input${creating ? ' ticket' : ''}`}>
        <span className="po-prompt" aria-hidden>›</span>
        <textarea ref={box} aria-label="Message" rows={rows} style={{ overflowY: rows >= 6 ? 'auto' : 'hidden' }} value={text} placeholder={hint}
          spellCheck={false} onChange={e => edit(e.target.value)} onKeyDown={key} />
        <button type="button" className="po-btn primary po-send" disabled={busy || !text.trim()} onClick={() => void send()}>
          {continuing && !active ? 'Continue' : creating && active ? 'Queue' : 'Send'}
        </button>
      </div>
      <div className="po-composer-foot">
        {active || latest ? (
          <label className="po-toggle">
            <input type="checkbox" checked={asTicket} onChange={e => setAsTicket(e.target.checked)} />
            <span>New ticket instead</span>
          </label>
        ) : <span className="po-dim">Auto decides: questions get an answer, changes become a ticket</span>}
        {continuing && <span className="po-dim po-follow-of">follow-up of “{latest!.title}”</span>}
        <span className="po-grow" />
        {creating && <ModeSwitch mode={mode} onChange={setMode} />}
        <span className="po-dim">⏎ send · ⇧⏎ newline</span>
      </div>
    </footer>
  );
}
