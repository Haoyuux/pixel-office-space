import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { roleDef, type RoleId, type Ticket, type TicketMode } from '@office/shared';
import { useOffice } from '../state/store';
import { api, paths } from './api';
import { accentCss, canResume, isActive, isFinished, relativeDate, roleEmoji, roleShort, STATUS_ICON } from './format';
import { ClaudeBanner } from './claudeStatus';
import { Feed } from './Feed';
import { RawLog } from './RawLog';
import { Changes } from './Changes';
import { GitBanner } from './GitBanner';
import { PlanView } from './PlanView';
import { PipelineBar } from './PipelineBar';
import { TeamDialog } from './TeamDialog';

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
  const tickets = useMemo(() => Object.values(all).filter(t => t.projectId === projectId).sort(byNewest), [all, projectId]);
  const active = tickets.find(isActive);
  const queued = tickets.filter(t => t.status === 'queued');
  const [chosen, setChosen] = useState<string | null>(null);
  const shown = tickets.find(t => t.id === chosen) ?? active ?? tickets[0];
  const [tab, setTab] = useState<Tab>('feed');
  const [team, setTeam] = useState(false);
  const [past, setPast] = useState(false);
  // a finished ticket the owner picked from the list: the composer continues it
  const picked = tickets.find(t => t.id === chosen);
  const continueFrom = picked && isFinished(picked) ? picked : undefined;
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
          <span className={`po-badge ${mode}`} title="Who works this project's tickets (change it in Team)">{mode === 'claude' ? 'Claude Code' : 'Simulated'}</span>
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
          <span aria-hidden>🎫</span>
          {shown ? <span className="po-ticket-title" title={shown.title}>{shown.title}</span>
            : <span className="po-dim po-grow">no tickets yet — describe one below</span>}
          {shown && <span className={`po-chip ${shown.status}`}>{shown.status === 'waiting' ? '⏸ waiting for you' : shown.status}</span>}
          {queued.length > 0 && <span className="po-chip queued" title={queued.map(t => t.title).join('\n')}>+{queued.length} queued</span>}
          {tickets.length > 0 && (
            <button type="button" className={`po-hbtn${past ? ' on' : ''}`} aria-expanded={past} onClick={() => setPast(o => !o)}>
              Past conversations · {tickets.length}
            </button>
          )}
        </div>
        {past && (
          <ul className="po-past" aria-label="Past conversations">
            {tickets.map(t => {
              const roles = Object.keys(t.agentStates) as RoleId[];
              return (
                <li key={t.id}>
                  <button type="button" className={`po-past-item${t.id === shown?.id ? ' on' : ''}`} onClick={() => { setChosen(t.id); setPast(false); }}>
                    <span className="po-past-title">{STATUS_ICON[t.status]} {t.title}</span>
                    <span className="po-past-meta">
                      <span className="po-dim">{relativeDate(t.createdAt)}</span>
                      <span className={`po-chip ${t.status}`}>{t.status}</span>
                      {t.answered && <span className="po-chip answered" title="The PM answered; nothing was changed">✓ answered</span>}
                      {roles.length > 0 && <span title={roles.map(roleShort).join(', ')}>{roles.map(roleEmoji).join('')}</span>}
                      {t.usage && <span className="po-dim" title="Uses your Claude plan — not charged">{t.usage.turns} turns</span>}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <PipelineBar team={project.team} ticket={shown} />
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

      <div className="po-body">
        {!shown ? <div className="po-scroll"><div className="po-empty po-welcome">
            <div className="po-welcome-title">{project.name} is ready.</div>
            <div>Type a ticket below — the PM plans it, you approve, the team builds it.</div>
          </div></div>
          : tab === 'feed' ? <Feed ticketId={shown.id} onShow={setTab} />
          : tab === 'raw' ? <RawLog ticketId={shown.id} />
          : tab === 'changes' ? <Changes ticketId={shown.id} repos={project.repos?.map(r => r.name)} />
          : <PlanView ticket={shown} />}
      </div>

      <Composer key={continueFrom?.id ?? ''} projectId={project.id} active={active} continueFrom={continueFrom} onCreated={() => setChosen(null)} />
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

const MODES: { id: TicketMode; label: string; hint: string }[] = [
  { id: 'auto', label: 'Auto', hint: 'The PM decides: answers a question, plans a change' },
  { id: 'ask', label: 'Ask', hint: 'Just an answer — nothing is changed' },
  { id: 'ticket', label: 'Ticket', hint: 'Always plan and build (plan gate, team, final review)' },
];

/** Auto · Ask · Ticket: how the PM treats a new request. */
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

/** Input box: no running ticket → new ticket (or a follow-up of the picked finished ticket); running → message to the team, or a queued ticket with the toggle on. */
function Composer({ projectId, active, continueFrom, onCreated }: { projectId: string; active: Ticket | undefined; continueFrom?: Ticket; onCreated: () => void }) {
  const [text, setText] = useState('');
  const [mode, setMode] = useState<TicketMode>('auto');
  const [asTicket, setAsTicket] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const continuing = !!continueFrom && !asTicket;
  const creating = !active || asTicket || continuing;

  const send = async () => {
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true); setError(null);
    const r = continuing ? await api('POST', paths.tickets(projectId), { text: t, parentTicketId: continueFrom!.id, mode })
      : creating ? await api('POST', paths.tickets(projectId), { text: t, mode }) : await api('POST', paths.messages(active!.id), { text: t });
    setBusy(false);
    if (!r.ok) { setError(r.error); return; }
    setText('');
    if (creating) { setAsTicket(false); onCreated(); }
    box.current?.focus();
  };
  const key = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); }
  };
  const hint = continuing ? 'Continue this conversation…' : !active ? (mode === 'ask' ? 'ask a question…' : 'describe a new ticket…')
    : asTicket ? 'queue a new ticket…' : 'message the team…';
  const rows = Math.min(6, Math.max(1, text.split('\n').length));

  return (
    <footer className="po-composer">
      {error && <div className="po-error" role="alert">{error}</div>}
      <div className={`po-input${creating ? ' ticket' : ''}`}>
        <span className="po-prompt" aria-hidden>›</span>
        <textarea ref={box} aria-label="Message" rows={rows} style={{ overflowY: rows >= 6 ? 'auto' : 'hidden' }} value={text} placeholder={hint}
          spellCheck={false} onChange={e => setText(e.target.value)} onKeyDown={key} />
        <button type="button" className="po-btn primary po-send" disabled={busy || !text.trim()} onClick={() => void send()}>
          {continuing && !active ? 'Continue' : creating ? (active ? 'Queue' : 'Create') : 'Send'}
        </button>
      </div>
      <div className="po-composer-foot">
        {active || continueFrom ? (
          <label className="po-toggle">
            <input type="checkbox" checked={asTicket} onChange={e => setAsTicket(e.target.checked)} />
            <span>New ticket instead</span>
          </label>
        ) : <span className="po-dim">creates a ticket</span>}
        {continuing && <span className="po-dim po-follow-of">follow-up of “{continueFrom!.title}”</span>}
        <span className="po-grow" />
        {creating && <ModeSwitch mode={mode} onChange={setMode} />}
        <span className="po-dim">⏎ send · ⇧⏎ newline</span>
      </div>
    </footer>
  );
}
