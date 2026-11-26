import { create } from 'zustand';
import { applyTicketEvent, type DiffFile, type Project, type RoleId, type ServerEvent, type Ticket, type TicketEvent } from '@office/shared';

export interface FeedItem {
  kind: 'message' | 'tool' | 'gate' | 'user' | 'stage';
  role?: RoleId;
  text: string;
  detail?: string;
  status?: string;
  id: string;
  ts: string;
}

export interface OfficeState {
  projects: Record<string, Project>;
  tickets: Record<string, Ticket>;
  feed: Record<string, FeedItem[]>;
  raw: Record<string, string[]>;
  lastSeq: Record<string, number>;
  /** Latest fake diff per ticket (Changes tab). */
  diffs: Record<string, DiffFile[]>;
  selectedProjectId: string | null;
  roleFilter: RoleId | 'all';
  night: boolean;
  /** A snapshot has arrived (the office can be drawn). */
  synced: boolean;
  /** Applies one server event; returns false when it was a duplicate (seq <= lastSeq) and was ignored. */
  apply(e: ServerEvent): boolean;
  /** History replay (GET /api/projects/:id/tickets): merges the events by seq and rebuilds those tickets. */
  applyHistory(projectId: string, tickets: Ticket[], events: Record<string, ServerEvent[]>): void;
  select(projectId: string | null): void;
  setRoleFilter(f: RoleId | 'all'): void;
  setNight(on: boolean): void;
}

/** Every applied ticket event, by ticket, ordered by seq (the source the feed is rebuilt from on history replay). */
const logs = new Map<string, TicketEvent[]>();

const isTicketEvent = (e: ServerEvent): e is TicketEvent => 'seq' in e && typeof e.seq === 'number' && 'ticketId' in e;

interface TicketView { feed: FeedItem[]; raw: string[]; diff?: DiffFile[] }

/** Folds one ticket event into that ticket's feed/raw/diff (returns new arrays when they change). */
function fold(v: TicketView, e: TicketEvent): TicketView {
  const item = (i: Omit<FeedItem, 'ts'>): FeedItem => ({ ...i, ts: e.ts });
  const push = (i: FeedItem) => ({ ...v, feed: [...v.feed, i] });
  switch (e.type) {
    case 'agent.message': {
      const at = v.feed.findIndex(f => f.kind === 'message' && f.id === e.messageId);
      if (at < 0) return push(item({ kind: 'message', role: e.role, text: e.text, id: e.messageId, status: e.streaming ? 'streaming' : undefined }));
      const feed = [...v.feed];
      feed[at] = { ...feed[at], text: feed[at].text + e.text, status: e.streaming ? 'streaming' : undefined };
      return { ...v, feed };
    }
    case 'agent.tool': {
      const at = v.feed.findIndex(f => f.kind === 'tool' && f.id === e.toolId);
      const next = item({ kind: 'tool', role: e.role, text: e.summary, detail: e.detail, status: e.status, id: e.toolId });
      if (at < 0) return push(next);
      const feed = [...v.feed];
      feed[at] = { ...next, ts: feed[at].ts, detail: e.detail ?? feed[at].detail };
      return { ...v, feed };
    }
    case 'gate.open':
      return push(item({ kind: 'gate', text: e.gate, status: 'open', id: `gate:${e.seq}`,
        detail: e.payload == null ? undefined : typeof e.payload === 'string' ? e.payload : JSON.stringify(e.payload) }));
    case 'gate.closed': {
      let at = -1;
      for (let i = v.feed.length - 1; i >= 0; i--) if (v.feed[i].kind === 'gate' && v.feed[i].text === e.gate && v.feed[i].status === 'open') { at = i; break; }
      if (at < 0) return v;
      const feed = [...v.feed];
      feed[at] = { ...feed[at], status: e.decision, ...(e.note ? { detail: e.note } : {}) };
      return { ...v, feed };
    }
    case 'user.message': return push(item({ kind: 'user', text: e.text, id: `user:${e.seq}` }));
    case 'ticket.stage': return push(item({ kind: 'stage', text: e.stage, detail: e.roles.join(', '), id: `stage:${e.seq}` }));
    case 'ticket.done': return push(item({ kind: 'stage', text: 'done', id: `end:${e.seq}` }));
    case 'ticket.failed': return push(item({ kind: 'stage', text: 'failed', detail: e.reason, id: `end:${e.seq}` }));
    case 'ticket.cancelled': return push(item({ kind: 'stage', text: 'cancelled', id: `end:${e.seq}` }));
    case 'log.raw': return { ...v, raw: [...v.raw, e.line] };
    case 'ticket.diff': return { ...v, diff: e.files };
    default: return v;
  }
}

const initial = () => ({
  projects: {} as Record<string, Project>, tickets: {} as Record<string, Ticket>, feed: {} as Record<string, FeedItem[]>,
  raw: {} as Record<string, string[]>, lastSeq: {} as Record<string, number>, diffs: {} as Record<string, DiffFile[]>,
  selectedProjectId: null as string | null, roleFilter: 'all' as RoleId | 'all', night: false, synced: false,
});

export const useOffice = create<OfficeState>()((set, get) => ({
  ...initial(),

  apply(e) {
    const s = get();
    if (e.type === 'snapshot') {
      // the server's current state wins; feed, raw log and lastSeq are kept so replayed events stay deduplicated
      const projects = Object.fromEntries(e.snapshot.projects.map(p => [p.id, p]));
      const tickets = { ...s.tickets };
      for (const t of e.snapshot.tickets) tickets[t.id] = t;
      set({ projects, tickets, synced: true, selectedProjectId: s.selectedProjectId && projects[s.selectedProjectId] ? s.selectedProjectId : null });
      return true;
    }
    if (e.type === 'project.added' || e.type === 'project.updated') { set({ projects: { ...s.projects, [e.project.id]: e.project } }); return true; }
    if (e.type === 'project.removed') {
      const { [e.projectId]: _gone, ...projects } = s.projects;
      set({ projects, selectedProjectId: s.selectedProjectId === e.projectId ? null : s.selectedProjectId });
      return true;
    }
    if (!isTicketEvent(e)) return false;
    const id = e.ticketId;
    if (e.seq <= (s.lastSeq[id] ?? 0)) return false;
    const log = logs.get(id) ?? [];
    log.push(e);
    logs.set(id, log);
    const v = fold({ feed: s.feed[id] ?? [], raw: s.raw[id] ?? [], diff: s.diffs[id] }, e);
    const t = applyTicketEvent(s.tickets[id], e);
    set({
      lastSeq: { ...s.lastSeq, [id]: e.seq },
      ...(t && t !== s.tickets[id] ? { tickets: { ...s.tickets, [id]: t } } : {}),
      ...(v.feed !== s.feed[id] ? { feed: { ...s.feed, [id]: v.feed } } : {}),
      ...(v.raw !== s.raw[id] ? { raw: { ...s.raw, [id]: v.raw } } : {}),
      ...(v.diff && v.diff !== s.diffs[id] ? { diffs: { ...s.diffs, [id]: v.diff } } : {}),
    });
    return true;
  },

  applyHistory(_projectId, list, events) {
    const s = get();
    const tickets = { ...s.tickets }, feed = { ...s.feed }, raw = { ...s.raw }, lastSeq = { ...s.lastSeq }, diffs = { ...s.diffs };
    let changed = false;
    const ids = new Set([...list.map(t => t.id), ...Object.keys(events)]);
    for (const id of ids) {
      const have = logs.get(id) ?? [];
      const seen = new Set(have.map(e => e.seq));
      const extra = (events[id] ?? []).filter(isTicketEvent).filter(e => !seen.has(e.seq));
      const base = list.find(t => t.id === id);
      if (!extra.length) { if (base && !tickets[id]) { tickets[id] = base; changed = true; } continue; }
      changed = true;
      const merged = [...have, ...extra].sort((a, b) => a.seq - b.seq);
      logs.set(id, merged);
      let v: TicketView = { feed: [], raw: [] };
      let t: Ticket | undefined = merged[0].type === 'ticket.created' ? undefined : (tickets[id] ?? base);
      for (const e of merged) { v = fold(v, e); t = applyTicketEvent(t, e); }
      feed[id] = v.feed; raw[id] = v.raw;
      if (v.diff) diffs[id] = v.diff;
      if (t) tickets[id] = t;
      lastSeq[id] = Math.max(lastSeq[id] ?? 0, merged[merged.length - 1].seq);
    }
    if (changed) set({ tickets, feed, raw, lastSeq, diffs });
  },

  select(projectId) { set({ selectedProjectId: projectId }); },
  setRoleFilter(f) { set({ roleFilter: f }); },
  setNight(on) { set({ night: on }); },
}));

/** Back to an empty office (tests). */
export function resetOffice(): void {
  logs.clear();
  useOffice.setState(initial());
}

/** Done tickets of a project known to the client (trophies). */
export const doneCount = (s: Pick<OfficeState, 'tickets'>, projectId: string): number =>
  Object.values(s.tickets).filter(t => t.projectId === projectId && t.status === 'done').length;

