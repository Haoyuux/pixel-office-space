import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react';
import type { Attachment, Ticket, TicketMode } from '@office/shared';
import { api, paths, type Result } from './api';
import { isActive } from './format';
import { parseCommand, suggest, type CommandName } from './slash';

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

/** Attachments: at most 10 MB each (the server checks the type). */
export const MAX_ATTACHMENT = 10 * 1024 * 1024;

interface Chip { key: number; name: string; status: 'uploading' | 'ready' | 'error'; id?: string; error?: string }

/** A File's bytes as base64 (FileReader: works everywhere, jsdom included). */
export function fileBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onerror = () => reject(fr.error ?? new Error('read failed'));
    fr.onload = () => { const s = String(fr.result ?? ''); resolve(s.slice(s.indexOf(',') + 1)); };
    fr.readAsDataURL(file);
  });
}

/** `@partial` right before the caret (start of text or after a space). */
const MENTION = /(^|\s)@([^\s@]*)$/;

/** Texts the owner sent this session, per project (↑ recall in a fresh composer). */
const sessionSent = new Map<string, string[]>();
export const resetComposerHistory = () => sessionSent.clear();

/** What the drawer can do to the composer (edit-and-resend, Ctrl+/). */
export interface ComposerHandle {
  /** Puts text back in the box (edit the last message), caret at the end. */
  prefill(text: string): void;
  /** Ctrl+/: opens the slash menu. */
  openSlash(): void;
}

interface Props {
  projectId: string;
  /** The project's running ticket (any conversation). */
  active: Ticket | undefined;
  latest: Ticket | undefined;
  onCreated: (created: Ticket | undefined, followUp: boolean) => void;
  refocus?: { current: boolean };
  onCommand?: (name: CommandName, arg: string) => Promise<string | void>;
  /** Esc with no popup open (stops a running answer). */
  onEscape?: () => void;
  /** The owner's earlier messages in this conversation, oldest first (↑ recall). */
  history?: string[];
  /**
   * A plain message the office handles itself instead of the agents ("run my portfolio" → ▶ Run): returns the note
   * to show, or null to send the message as usual.
   */
  intercept?: (text: string) => Promise<string> | null;
}

interface Row { key: string; label: string; desc?: string }

/**
 * Input box. A conversation is open (`latest` = its newest ticket): running / waiting → message to the team; otherwise
 * a follow-up ticket of it. Nothing open → a new conversation (queued while another ticket runs). The toggle forces a new one.
 * Paste / drop files → attachment chips; `@` → file search; ↑ on an empty box recalls the previous message.
 */
export const Composer = forwardRef<ComposerHandle, Props>(function Composer(
  { projectId, active, latest, refocus, onCreated, onCommand, onEscape, intercept, history = [] }, ref,
) {
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
  const [chips, setChips] = useState<Chip[]>([]);
  const chipKey = useRef(0);
  const [dragging, setDragging] = useState(false);
  /** `@` file search results for the current mention (null = not searched yet). */
  const [files, setFiles] = useState<{ q: string; paths: string[] } | null>(null);
  /** Position in the recall list while ↑/↓ step through it (null = not recalling). */
  const [recall, setRecall] = useState<number | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const toTeam = !!latest && !asTicket && isActive(latest);
  const continuing = !!latest && !asTicket && !toTeam;
  const creating = !toTeam;

  const mention = dismissed ? null : MENTION.exec(text);
  const mentionQ = mention ? mention[2] : null;
  const commands = dismissed ? [] : suggest(text);
  const fileRows: Row[] = mentionQ !== null && files?.q === mentionQ ? files.paths.map(p => ({ key: p, label: p })) : [];
  const rows: Row[] = commands.length ? commands.map(c => ({ key: c.label, label: c.label, desc: c.desc })) : fileRows;
  const sel = rows.length ? Math.min(pick, rows.length - 1) : 0;
  const recallList = history.length ? history : sessionSent.get(projectId) ?? [];

  useEffect(() => { if (refocus?.current) { refocus.current = false; box.current?.focus(); } }, [refocus]);

  // `@` file search (debounced; a stale answer is dropped)
  useEffect(() => {
    if (mentionQ === null) return;
    let live = true;
    const t = setTimeout(async () => {
      const r = await api<unknown>('GET', paths.files(projectId, mentionQ));
      if (!live || !r.ok) return;
      const d = r.data as { files?: unknown; paths?: unknown } | unknown[];
      const list = Array.isArray(d) ? d : Array.isArray(d?.files) ? d.files : Array.isArray(d?.paths) ? d.paths : [];
      setFiles({ q: mentionQ, paths: list.filter((x): x is string => typeof x === 'string').slice(0, 30) });
    }, 120);
    return () => { live = false; clearTimeout(t); };
  }, [mentionQ, projectId]);

  const edit = (v: string) => { setText(v); setPick(0); setDismissed(false); setNote(null); setRecall(null); };
  const caretEnd = () => requestAnimationFrame(() => { const b = box.current; if (b) { b.focus(); b.selectionStart = b.selectionEnd = b.value.length; } });

  useImperativeHandle(ref, () => ({
    prefill(t: string) { edit(t); caretEnd(); },
    openSlash() { if (!text.trim()) edit('/'); box.current?.focus(); },
  }), [text]);

  // ---- attachments ----
  const addFiles = (list: FileList | File[] | null | undefined) => {
    for (const file of Array.from(list ?? [])) {
      const key = ++chipKey.current;
      const name = file.name || 'pasted-file';
      if (file.size > MAX_ATTACHMENT) {
        setChips(c => [...c, { key, name, status: 'error', error: 'too large (max 10 MB)' }]);
        continue;
      }
      setChips(c => [...c, { key, name, status: 'uploading' }]);
      void (async () => {
        let r: Result<Attachment>;
        try {
          r = await api<Attachment>('POST', paths.attachments(projectId), { name, dataBase64: await fileBase64(file) });
        } catch (e) { r = { ok: false, status: 0, error: (e as Error).message }; }
        const done: Partial<Chip> = r.ok && r.data && typeof r.data.id === 'string'
          ? { status: 'ready', id: r.data.id, name: r.data.name || name }
          : { status: 'error', error: r.ok ? 'upload failed' : r.error };
        setChips(c => c.map(x => (x.key === key ? { ...x, ...done } : x)));
      })();
    }
  };
  const removeChip = (key: number) => setChips(c => c.filter(x => x.key !== key));
  const uploading = chips.some(c => c.status === 'uploading');
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const fs = e.clipboardData?.files;
    if (fs?.length) { e.preventDefault(); addFiles(fs); }
  };
  const onDrop = (e: DragEvent) => {
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault(); setDragging(false); addFiles(e.dataTransfer.files);
  };
  const onDragOver = (e: DragEvent) => {
    if (![...(e.dataTransfer?.types ?? [])].includes('Files')) return;
    e.preventDefault(); setDragging(true);
  };
  const filePick = useRef<HTMLInputElement>(null);

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

  /** Picks a popup row: runs a command, or puts `@path ` in place of the mention. */
  const choose = (i: number, complete = false) => {
    if (commands.length) {
      const c = commands[i];
      if (complete) edit(c.complete); else void runCommand(c.run);
      return;
    }
    const p = fileRows[i]?.label;
    if (!p || !mention) return;
    edit(`${text.slice(0, mention.index + mention[1].length)}@${p} `);
    caretEnd();
  };

  const send = async () => {
    const t = text.trim();
    if (t.startsWith('/') && !chips.length) { void runCommand(t); return; }
    if (!t || busy || uploading) return;
    // "run my portfolio": the office starts the dev server (never while talking to a running team)
    const handled = !toTeam && !chips.length ? intercept?.(t) : null;
    if (handled) {
      setText(''); setRecall(null); setError(null);
      sessionSent.set(projectId, [...(sessionSent.get(projectId) ?? []), t].slice(-50));
      const out = await handled;
      if (out) setNote(out);
      box.current?.focus();
      return;
    }
    const ids = chips.filter(c => c.status === 'ready' && c.id).map(c => c.id!);
    const att = ids.length ? { attachments: ids } : {};
    setBusy(true); setError(null);
    const r = toTeam ? await api<Ticket>('POST', paths.messages(latest!.id), { text: t, ...att })
      : await api<Ticket>('POST', paths.tickets(projectId), continuing ? { text: t, parentTicketId: latest!.id, mode, ...att } : { text: t, mode, ...att });
    setBusy(false);
    if (!r.ok) { setError(r.error); return; }
    sessionSent.set(projectId, [...(sessionSent.get(projectId) ?? []), t].slice(-50));
    setText(''); setChips([]); setRecall(null);
    if (creating) {
      const created = r.data && typeof r.data === 'object' && typeof r.data.id === 'string' ? r.data : undefined;
      setAsTicket(false); onCreated(created, continuing);
    }
    box.current?.focus();
  };

  const key = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (rows.length) {
      const n = rows.length;
      if (e.key === 'ArrowDown') { e.preventDefault(); setPick((sel + 1) % n); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setPick((sel - 1 + n) % n); return; }
      if (e.key === 'Escape') { e.preventDefault(); setDismissed(true); return; }
      if (e.key === 'Tab') { e.preventDefault(); choose(sel, true); return; }
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); choose(sel); return; }
    }
    if (e.key === 'Escape' && mention && !dismissed) { e.preventDefault(); setDismissed(true); return; }
    // ↑ on an empty box (or while stepping through) recalls earlier messages; ↓ steps back toward the newest
    const recalling = recall !== null && text === recallList[recall];
    if (e.key === 'ArrowUp' && recallList.length && (!text || recalling)) {
      e.preventDefault();
      const i = recalling ? Math.max(0, recall! - 1) : recallList.length - 1;
      setText(recallList[i]); setRecall(i); caretEnd();
      return;
    }
    if (e.key === 'ArrowDown' && recalling) {
      e.preventDefault();
      if (recall! + 1 < recallList.length) { setText(recallList[recall! + 1]); setRecall(recall! + 1); caretEnd(); }
      else { setText(''); setRecall(null); }
      return;
    }
    if (e.key === 'Escape') { e.preventDefault(); onEscape?.(); return; }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); }
  };
  const hint = continuing ? 'Continue this conversation…' : toTeam ? 'message the team…' : active ? 'queue a new ticket…'
    : mode === 'ask' ? 'Ask a question…' : mode === 'ticket' ? 'Describe a change…' : 'Ask anything, or describe a change…';
  const lines = Math.min(6, Math.max(1, text.split('\n').length));
  const unknown = text.startsWith('/') && !commands.length && !dismissed && !parseCommand(text)?.known && !/\s/.test(text.trim());

  return (
    <footer className={`po-composer${dragging ? ' dragging' : ''}`} onDragOver={onDragOver} onDragLeave={() => setDragging(false)} onDrop={onDrop}>
      {error && <div className="po-error" role="alert">{error}</div>}
      {rows.length > 0 && (
        <ul className="po-slash" role="listbox" aria-label={commands.length ? 'Commands' : 'Files'}>
          {rows.map((r, i) => (
            <li key={r.key} role="option" aria-selected={i === sel} className={i === sel ? 'on' : ''}
              onMouseEnter={() => setPick(i)} onMouseDown={e => { e.preventDefault(); choose(i); }}>
              {commands.length ? <><span className="po-slash-cmd">{r.label}</span> <span className="po-slash-desc">{r.desc}</span></>
                : <span className="po-slash-file">@{r.label}</span>}
            </li>
          ))}
        </ul>
      )}
      {mentionQ !== null && !commands.length && files?.q === mentionQ && !files.paths.length && (
        <div className="po-slash-note" role="status">No file matches “{mentionQ}”</div>
      )}
      {(note || unknown) && <div className="po-slash-note" role="status">{unknown ? 'Unknown command — type /help' : note}</div>}
      {chips.length > 0 && (
        <ul className="po-chips" aria-label="Attachments">
          {chips.map(c => (
            <li key={c.key} className={`po-att ${c.status}`} title={c.error ?? c.name}>
              <span aria-hidden>{c.status === 'uploading' ? '⏳' : c.status === 'error' ? '⚠' : '📎'}</span>
              <span className="po-att-name">{c.name}</span>
              {c.status === 'uploading' && <span className="po-dim">uploading…</span>}
              {c.status === 'error' && <span className="po-error-text">{c.error}</span>}
              <button type="button" className="po-att-x" aria-label={`Remove ${c.name}`} onClick={() => removeChip(c.key)}>×</button>
            </li>
          ))}
        </ul>
      )}
      <div className={`po-input${creating ? ' ticket' : ''}`}>
        <span className="po-prompt" aria-hidden>›</span>
        <textarea ref={box} aria-label="Message" rows={lines} style={{ overflowY: lines >= 6 ? 'auto' : 'hidden' }} value={text} placeholder={hint}
          spellCheck={false} onChange={e => edit(e.target.value)} onKeyDown={key} onPaste={onPaste} />
        <button type="button" className="po-icon po-attach" aria-label="Attach files" title="Attach files (or paste / drop them)" onClick={() => filePick.current?.click()}>📎</button>
        <input ref={filePick} type="file" multiple hidden onChange={e => { addFiles(e.target.files); e.target.value = ''; }} />
        <button type="button" className="po-btn primary po-send" disabled={busy || uploading || !text.trim()} onClick={() => void send()}>
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
        <span className="po-dim">⏎ send · ⇧⏎ newline · @ file</span>
      </div>
    </footer>
  );
});
