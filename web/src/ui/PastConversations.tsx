import { useState, type RefObject } from 'react';
import type { ConversationMeta, RoleId } from '@office/shared';
import { useOffice } from '../state/store';
import { api, paths } from './api';
import { kindIcon, kindStatus, kindTitle, relativeDate, roleEmoji, roleShort } from './format';
import type { Thread } from './threads';

/** A conversation's title: the owner's rename or the server's auto title, else the root's title. */
export const threadTitle = (th: Pick<Thread, 'root'>, meta: ConversationMeta | undefined) => meta?.title?.trim() || kindTitle(th.root);

/** Live (not deleted) threads, pinned first (each group keeps its most-recent-first order). */
export function visibleThreads(threads: Thread[], meta: Record<string, ConversationMeta>): Thread[] {
  const live = threads.filter(th => !meta[th.root.id]?.deleted);
  return [...live.filter(th => meta[th.root.id]?.pinned), ...live.filter(th => !meta[th.root.id]?.pinned)];
}

/** Search: the title, every ticket's text and title, and the conversation's messages. */
function matches(th: Thread, meta: ConversationMeta | undefined, feeds: ReturnType<typeof useOffice.getState>['feed'], q: string): boolean {
  if (threadTitle(th, meta).toLowerCase().includes(q)) return true;
  return th.tickets.some(t => kindTitle(t).toLowerCase().includes(q) || t.text.toLowerCase().includes(q)
    || (feeds[t.id] ?? []).some(f => (f.kind === 'message' || f.kind === 'user') && f.text.toLowerCase().includes(q)));
}

type Reply = { rootId?: string; projectId?: string; title?: string; pinned?: boolean; deleted?: boolean };

/** PATCH / DELETE /api/conversations/:rootId; the reply (or the change) is applied to the store at once. */
async function save(rootId: string, projectId: string, change: Partial<ConversationMeta> | 'delete'): Promise<string | null> {
  const r = change === 'delete' ? await api<Reply>('DELETE', paths.conversation(rootId)) : await api<Reply>('PATCH', paths.conversation(rootId), change);
  if (!r.ok) return r.error;
  const prev = useOffice.getState().conversations[rootId];
  const d = r.data && typeof r.data === 'object' ? r.data : {};
  const next: ConversationMeta = {
    ...prev, projectId,
    ...(change === 'delete' ? { deleted: true } : change),
    ...(typeof d.title === 'string' ? { title: d.title } : {}),
    ...(typeof d.pinned === 'boolean' ? { pinned: d.pinned } : {}),
    ...(typeof d.deleted === 'boolean' ? { deleted: d.deleted } : {}),
  };
  useOffice.getState().setConversations({ [d.rootId ?? rootId]: next });
  return null;
}

/** The Past conversations popover: search box, rows with rename (inline), 📌 pin and 🗑 delete (inline confirm). */
export function PastConversations({ projectId, threads, openRoot, filter, onFilter, inputRef, onOpen, onClose }: {
  projectId: string; threads: Thread[]; openRoot: string | undefined;
  filter: string; onFilter: (q: string) => void; inputRef: RefObject<HTMLInputElement>;
  onOpen: (rootId: string) => void; onClose: () => void;
}) {
  const meta = useOffice(s => s.conversations);
  const feeds = useOffice(s => s.feed);
  const [renaming, setRenaming] = useState<{ id: string; text: string } | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ id: string; text: string } | null>(null);
  const q = filter.trim().toLowerCase();
  const shown = q ? threads.filter(th => matches(th, meta[th.root.id], feeds, q)) : threads;

  const run = async (id: string, change: Partial<ConversationMeta> | 'delete') => {
    if (busy) return;
    setBusy(true); setError(null);
    const err = await save(id, projectId, change);
    setBusy(false);
    if (err) { setError({ id, text: err }); return; }
    setRenaming(null); setConfirm(null);
  };
  const rename = (id: string, current: string) => {
    const t = renaming?.text.trim() ?? '';
    if (!t || t === current) { setRenaming(null); return; }
    void run(id, { title: t });
  };

  return (
    <div className="po-past-wrap">
      <input ref={inputRef} className="po-past-filter" aria-label="Filter conversations" placeholder="search titles and messages…" value={filter}
        spellCheck={false} onChange={e => onFilter(e.target.value)}
        onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }} />
      <ul className="po-past" aria-label="Past conversations">
        {shown.length === 0 && <li className="po-dim po-past-none">no conversation matches</li>}
        {shown.map(th => {
          const { root, latest, tickets: ts } = th;
          const m = meta[root.id];
          const title = threadTitle(th, m);
          const roles = [...new Set(ts.flatMap(t => Object.keys(t.agentStates) as RoleId[]))];
          const turns = ts.reduce((n, t) => n + (t.usage?.turns ?? 0), 0);
          const editing = renaming?.id === root.id;
          return (
            <li key={root.id} className={`po-past-row${m?.pinned ? ' pinned' : ''}`}>
              {editing ? (
                <input className="po-past-rename" aria-label="Conversation title" autoFocus value={renaming.text} maxLength={120}
                  onChange={e => setRenaming({ id: root.id, text: e.target.value })}
                  onKeyDown={e => {
                    if (e.key === 'Enter') { e.preventDefault(); rename(root.id, title); }
                    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setRenaming(null); }
                  }} onBlur={() => rename(root.id, title)} />
              ) : (
                <button type="button" className={`po-past-item${root.id === openRoot ? ' on' : ''}`} onClick={() => onOpen(root.id)}>
                  <span className="po-past-title">{m?.pinned && <span aria-label="pinned">📌 </span>}{kindIcon(latest)} {title}</span>
                  <span className="po-past-meta">
                    <span className="po-dim">{relativeDate(latest.createdAt)}</span>
                    <span className={`po-chip ${latest.status}`}>{kindStatus(latest)}</span>
                    <span className="po-dim" title="Messages in this conversation">{ts.length} message{ts.length === 1 ? '' : 's'}</span>
                    {roles.length > 0 && <span title={roles.map(roleShort).join(', ')}>{roles.map(roleEmoji).join('')}</span>}
                    {turns > 0 && <span className="po-dim" title="Uses your Claude plan — not charged">{turns} turns</span>}
                  </span>
                </button>
              )}
              {!editing && confirm !== root.id && (
                <span className="po-past-actions">
                  <button type="button" className="po-msg-act" aria-label="Rename conversation" title="Rename" onClick={() => setRenaming({ id: root.id, text: title })}>✎</button>
                  <button type="button" className={`po-msg-act${m?.pinned ? ' on' : ''}`} aria-label={m?.pinned ? 'Unpin conversation' : 'Pin conversation'} aria-pressed={!!m?.pinned}
                    title={m?.pinned ? 'Unpin' : 'Pin to the top'} disabled={busy} onClick={() => void run(root.id, { pinned: !m?.pinned })}>📌</button>
                  <button type="button" className="po-msg-act danger" aria-label="Delete conversation" title="Delete" onClick={() => setConfirm(root.id)}>🗑</button>
                </span>
              )}
              {confirm === root.id && (
                <div className="po-confirm po-past-confirm" role="group" aria-label="Confirm delete">
                  <span>Delete <b>{title}</b>? It is hidden from this list (logs are kept).</span>
                  <div className="po-actions">
                    <button type="button" className="po-btn ghost" onClick={() => setConfirm(null)}>Keep it</button>
                    <button type="button" className="po-btn danger" disabled={busy} onClick={() => void run(root.id, 'delete')}>Delete</button>
                  </div>
                </div>
              )}
              {error?.id === root.id && <div className="po-error" role="alert">{error.text}</div>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
