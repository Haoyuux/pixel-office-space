import type { ConversationMeta, ServerEvent, Ticket } from '@office/shared';
import { useOffice } from './store';

/**
 * WebSocket feed (Vite proxies /ws to the server). The server sends a `snapshot` first on every connection, so a
 * reconnect needs no catch-up protocol: the snapshot rebuilds the current state and duplicate events are ignored by
 * the store (seq <= lastSeq).
 */

type Listener = (e: ServerEvent) => void;
const listeners = new Set<Listener>();

/** Called for every event the store accepted (not for duplicates). Returns an unsubscribe function. */
export function onServerEvent(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function dispatch(e: ServerEvent): void {
  if (!useOffice.getState().apply(e)) return;
  for (const l of listeners) l(e);
  // history fills in done tickets (trophies) and anything missed while disconnected
  if (e.type === 'snapshot') for (const p of e.snapshot.projects) void loadHistory(p.id);
}

const MIN_DELAY = 1000, MAX_DELAY = 5000;

export function connectSocket(url = defaultUrl()): () => void {
  let ws: WebSocket | null = null, stopped = false, delay = MIN_DELAY;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const open = () => {
    ws = new WebSocket(url);
    ws.onopen = () => { delay = MIN_DELAY; };
    ws.onmessage = m => {
      let e: ServerEvent;
      try { e = JSON.parse(String(m.data)); } catch { return; }
      dispatch(e);
    };
    ws.onclose = () => {
      ws = null;
      if (stopped) return;
      timer = setTimeout(open, delay);
      delay = Math.min(MAX_DELAY, delay * 2);
    };
    ws.onerror = () => ws?.close();
  };
  open();
  return () => { stopped = true; clearTimeout(timer); ws?.close(); };
}

function defaultUrl(): string {
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
}

/** History replay for a project's drawer: GET /api/projects/:id/tickets?limit=100, merged into the store. */
export async function loadHistory(projectId: string): Promise<void> {
  try {
    const r = await fetch(`/api/projects/${encodeURIComponent(projectId)}/tickets?limit=100`);
    if (!r.ok) return;
    const body = await r.json() as { tickets: Ticket[]; events: Record<string, ServerEvent[]>; conversations?: Record<string, ConversationMeta> };
    useOffice.getState().applyHistory(projectId, body.tickets ?? [], body.events ?? {});
    if (body.conversations && typeof body.conversations === 'object') useOffice.getState().setConversations(body.conversations);
  } catch { /* offline: the next snapshot retries */ }
}

/** Live mode: connect, and fetch a project's history whenever its drawer opens (it gets selected). */
export function startOffice(): () => void {
  const stop = connectSocket();
  const unsub = useOffice.subscribe((s, prev) => {
    if (s.selectedProjectId && s.selectedProjectId !== prev.selectedProjectId) void loadHistory(s.selectedProjectId);
  });
  return () => { unsub(); stop(); };
}
