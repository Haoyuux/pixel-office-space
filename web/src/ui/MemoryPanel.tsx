import { useCallback, useEffect, useRef, useState } from 'react';
import { MEMORY_MAX_CHARS, MEMORY_MAX_ENTRIES, type MemoryEntry } from '@office/shared';
import { useOffice } from '../state/store';
import { api, paths } from './api';
import { relativeDate } from './format';

/** Entries from a memory reply: `{ entries }` (the store file's shape) or a bare list. */
function entriesOf(data: unknown): MemoryEntry[] | null {
  const list = Array.isArray(data) ? data : (data as { entries?: unknown } | null)?.entries;
  return Array.isArray(list) ? list.filter((e): e is MemoryEntry => !!e && typeof e === 'object' && typeof (e as MemoryEntry).id === 'string') : null;
}

/**
 * Team memory (M3 §3): durable project facts every agent prompt gets. The owner adds, edits and deletes entries;
 * the PM adds lessons it learned (source 'pm'). Refetched on `memory.updated`.
 */
export function MemoryPanel({ projectId }: { projectId: string }) {
  const rev = useOffice(s => s.memoryRev[projectId] ?? 0);
  const [entries, setEntries] = useState<MemoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const live = useRef(true);
  useEffect(() => () => { live.current = false; }, []);

  const load = useCallback(async () => {
    const r = await api('GET', paths.memory(projectId));
    if (!live.current) return;
    if (!r.ok) { setError(r.error); setEntries(e => e ?? []); return; }
    setEntries(entriesOf(r.data) ?? []);
  }, [projectId]);
  useEffect(() => { void load(); }, [load, rev]);

  /** One mutation at a time; the list is refetched afterwards (the reply may carry it too). */
  const mutate = async (req: () => ReturnType<typeof api>): Promise<boolean> => {
    if (busy) return false;
    setBusy(true); setError(null);
    const r = await req();
    if (!live.current) return false;
    setBusy(false);
    if (!r.ok) { setError(r.error); return false; }
    const list = entriesOf(r.data);
    if (list) setEntries(list);
    void load();
    return true;
  };

  const add = async () => {
    const text = draft.trim();
    if (!text) return;
    if (await mutate(() => api('POST', paths.memory(projectId), { text }))) setDraft('');
  };
  const save = async () => {
    if (!editing) return;
    const text = editing.text.trim();
    if (!text) return;
    if (await mutate(() => api('PATCH', paths.memoryEntry(projectId, editing.id), { text }))) setEditing(null);
  };
  const remove = (id: string) => void mutate(() => api('DELETE', paths.memoryEntry(projectId, id)));

  const full = (entries?.length ?? 0) >= MEMORY_MAX_ENTRIES;
  return (
    <div className="po-scroll po-memory" role="region" aria-label="Team memory">
      <p className="po-hint po-dim">
        What the team remembers about this project — every agent reads it before working. Add durable facts and rules
        (conventions, commands, do&apos;s and don&apos;ts); the PM adds lessons it learns. Stored with Pixel Office, never in your repo.
      </p>
      {error && <div className="po-error" role="alert">{error}</div>}
      {entries === null ? <div className="po-dim" role="status">Loading…</div>
        : entries.length === 0 ? <div className="po-dim po-memory-empty">Nothing remembered yet.</div>
        : <ul className="po-memory-list" aria-label="Memory entries">
          {entries.map(e => (
            <li key={e.id} className="po-memory-item">
              {editing?.id === e.id ? <div className="po-memory-edit">
                <textarea aria-label="Edit memory entry" value={editing.text} maxLength={MEMORY_MAX_CHARS} rows={3} autoFocus
                  onChange={ev => setEditing({ id: e.id, text: ev.target.value })}
                  onKeyDown={ev => {
                    if (ev.key === 'Escape') { ev.stopPropagation(); setEditing(null); }
                    if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); void save(); }
                  }} />
                <div className="po-actions">
                  <span className="po-dim po-memory-count">{editing.text.length}/{MEMORY_MAX_CHARS}</span>
                  <button type="button" className="po-btn ghost" onClick={() => setEditing(null)}>Cancel</button>
                  <button type="button" className="po-btn primary" disabled={busy || !editing.text.trim()} onClick={() => void save()}>Save</button>
                </div>
              </div> : <>
                <div className="po-memory-text">{e.text}</div>
                <div className="po-memory-meta">
                  <span className={`po-memory-src ${e.source}`}>{e.source === 'pm' ? 'learned by the PM' : 'you'}</span>
                  <span className="po-dim">{relativeDate(e.at)}</span>
                  <span className="po-grow" />
                  <button type="button" className="po-msg-act" aria-label={`Edit: ${e.text}`} title="Edit" disabled={busy} onClick={() => setEditing({ id: e.id, text: e.text })}>✎</button>
                  <button type="button" className="po-msg-act danger" aria-label={`Delete: ${e.text}`} title="Delete" disabled={busy} onClick={() => remove(e.id)}>🗑</button>
                </div>
              </>}
            </li>
          ))}
        </ul>}
      <div className="po-memory-add">
        <textarea aria-label="New memory entry" placeholder={full ? `Memory is full (${MEMORY_MAX_ENTRIES} entries) — delete one first` : 'e.g. Run tests with npm test -w web; never edit generated files in dist/'}
          value={draft} maxLength={MEMORY_MAX_CHARS} rows={2} disabled={full}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void add(); } }} />
        <div className="po-actions">
          <span className="po-dim po-memory-count">{entries?.length ?? 0}/{MEMORY_MAX_ENTRIES} entries · {draft.length}/{MEMORY_MAX_CHARS}</span>
          <button type="button" className="po-btn primary" disabled={busy || full || !draft.trim()} onClick={() => void add()}>Remember</button>
        </div>
      </div>
    </div>
  );
}
