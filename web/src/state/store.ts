import { create } from 'zustand';
import { applyTicketEvent, DEV_LOG_MAX, type Attachment, type ConversationMeta, type DevServerState, type DiffFile, type Project, type RoleId, type ServerEvent, type Ticket, type TicketEvent } from '@office/shared';

export interface FeedItem {
  kind: 'message' | 'tool' | 'gate' | 'user' | 'stage';
  role?: RoleId;
  text: string;
  detail?: string;
  status?: string;
  id: string;
  ts: string;
  /** The PM's answer to an Ask (rendered as markdown-ish text). */
  answer?: boolean;
  /** Tool name of a tool item (Read, Grep, Bash…): tool-activity grouping. */
  tool?: string;
  /** Files attached to an owner message. */
  attachments?: Attachment[];
}

/** The PM's raw structured reply carrying an answer (shown again, cleanly, as the answer message). */
const RAW_ANSWER = /```json[\s\S]*"kind"\s*:\s*"answer"/;

export interface OfficeState {
  projects: Record<string, Project>;
  tickets: Record<string, Ticket>;
  feed: Record<string, FeedItem[]>;
  raw: Record<string, string[]>;
  lastSeq: Record<string, number>;
  /** Latest fake diff per ticket (Changes tab). */
  diffs: Record<string, DiffFile[]>;
  /** Conversation meta by root ticket id (title, pinned, deleted). */
  conversations: Record<string, ConversationMeta>;
  selectedProjectId: string | null;
  roleFilter: RoleId | 'all';
  night: boolean;
  /** A snapshot has arrived (the office can be drawn). */
  synced: boolean;
  /** Applies one server event; returns false when it was a duplicate (seq <= lastSeq) and was ignored. */
  apply(e: ServerEvent): boolean;
  /** History replay (GET /api/projects/:id/tickets): merges the events by seq and rebuilds those tickets. */
  applyHistory(projectId: string, tickets: Ticket[], events: Record<string, ServerEvent[]>): void;
  /** Merges conversation meta (history response, PATCH/DELETE replies). */
  setConversations(meta: Record<string, ConversationMeta>): void;
  select(projectId: string | null): void;
  setRoleFilter(f: RoleId | 'all'): void;
  setNight(on: boolean): void;
  /** Notification chime on/off (🔔 toolbar button), remembered in this browser. */
  soundOn: boolean;
  setSound(on: boolean): void;
  /** The conversation the open drawer shows (null = no drawer, or the welcome view). */
  openConv: { projectId: string; rootId: string } | null;
  /** The conversation last shown per project (the drawer reopens on it, even after its ticket finished). */
  lastConv: Record<string, string>;
  /** /new: the drawer opens on the welcome view next time. */
  forgetConv(projectId: string): void;
  setOpenConv(c: { projectId: string; rootId: string } | null): void;
  /** A request to open a conversation from outside the drawer (notification, summary board); `n` makes repeats distinct. */
  openRequest: { projectId: string; rootId: string; n: number } | null;
  /** Selects the project and opens that conversation in its drawer. */
  openConversation(projectId: string, rootId: string): void;
  /** Notified items the owner has not looked at yet (tab title count), oldest first. */
  unseen: { key: string; projectId: string; rootId: string }[];
  addUnseen(u: { key: string; projectId: string; rootId: string }): void;
  /** The owner viewed that conversation: its items are seen. */
  clearUnseen(rootId: string): void;
  /** Bumped on every `memory.updated` (the Memory tab refetches). */
  memoryRev: Record<string, number>;
  /** ▶ Run: each project's dev server (missing = idle) and its recent output lines. */
  devServers: Record<string, DevServerState>;
  devLogs: Record<string, string[]>;
  /** GET /api/projects/:id/devserver reply (state + log) replaces what the client has. */
  setDevServer(projectId: string, state: DevServerState, log: string[]): void;
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
      if (e.streaming && v.feed[at].status !== 'streaming') return v; // a late delta after the final text
      const feed = [...v.feed];
      // deltas append; the final full text (streaming: false, same id) replaces what streamed so far
      feed[at] = { ...feed[at], text: e.streaming ? feed[at].text + e.text : e.text, status: e.streaming ? 'streaming' : undefined };
      return { ...v, feed };
    }
    case 'agent.tool': {
      const at = v.feed.findIndex(f => f.kind === 'tool' && f.id === e.toolId);
      const next = item({ kind: 'tool', role: e.role, text: e.summary, detail: e.detail, status: e.status, id: e.toolId, tool: e.tool });
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
    case 'user.message': return push(item({ kind: 'user', text: e.text, id: `user:${e.seq}`, ...(e.attachments?.length ? { attachments: e.attachments } : {}) }));
    case 'ticket.stage': return push(item({ kind: 'stage', text: e.stage, detail: e.roles.join(', '), id: `stage:${e.seq}` }));
    case 'ticket.answered': {
      // the answer is the PM's last message; its raw JSON reply before it is noise
      let at = -1;
      for (let i = v.feed.length - 1; i >= 0; i--) if (v.feed[i].kind === 'message' && v.feed[i].role === 'pm') { at = i; break; }
      if (at < 0) return v;
      const feed = v.feed.map((f, i) => (i === at ? { ...f, answer: true } : f))
        .filter((f, i) => i === at || !(f.kind === 'message' && f.role === 'pm' && RAW_ANSWER.test(f.text)));
      return { ...v, feed };
    }
    case 'ticket.done': return push(item({ kind: 'stage', text: 'done', id: `end:${e.seq}`, ...(e.stopped ? { detail: 'stopped' } : {}) }));
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
  conversations: {} as Record<string, ConversationMeta>,
  selectedProjectId: null as string | null, roleFilter: 'all' as RoleId | 'all', night: initialNight(), synced: false,
  soundOn: initialSound(), openConv: null as OfficeState['openConv'], lastConv: {} as Record<string, string>, openRequest: null as OfficeState['openRequest'],
  unseen: [] as OfficeState['unseen'], memoryRev: {} as Record<string, number>,
  devServers: {} as Record<string, DevServerState>, devLogs: {} as Record<string, string[]>,
});

const NIGHT_KEY = 'pixel-office.night';
type NightStorage = Pick<Storage, 'getItem'>;
/** Night by default; the owner's last ☀/🌙 choice is remembered in this browser. */
export function initialNight(storage: NightStorage | undefined = typeof localStorage === 'undefined' ? undefined : localStorage): boolean {
  try { return storage?.getItem(NIGHT_KEY) !== '0'; } catch { return true; }
}

const SOUND_KEY = 'pixel-office.sound';
/** Sound on by default; the owner's last choice is remembered in this browser. */
export function initialSound(storage: NightStorage | undefined = typeof localStorage === 'undefined' ? undefined : localStorage): boolean {
  try { return storage?.getItem(SOUND_KEY) !== '0'; } catch { return true; }
}
let openN = 0;

export const useOffice = create<OfficeState>()((set, get) => ({
  ...initial(),

  apply(e) {
    const s = get();
    if (e.type === 'snapshot') {
      // the server's current state wins; feed, raw log and lastSeq are kept so replayed events stay deduplicated
      const projects = Object.fromEntries(e.snapshot.projects.map(p => [p.id, p]));
      const tickets = { ...s.tickets };
      for (const t of e.snapshot.tickets) tickets[t.id] = t;
      const devServers = e.snapshot.devServers ? Object.fromEntries(e.snapshot.devServers.map(d => [d.projectId, d])) : s.devServers;
      set({ projects, tickets, synced: true, devServers, ...(e.snapshot.conversations ? { conversations: { ...e.snapshot.conversations } } : {}), selectedProjectId: s.selectedProjectId && projects[s.selectedProjectId] ? s.selectedProjectId : null });
      return true;
    }
    if (e.type === 'project.added' || e.type === 'project.updated') { set({ projects: { ...s.projects, [e.project.id]: e.project } }); return true; }
    if (e.type === 'project.removed') {
      const { [e.projectId]: _gone, ...projects } = s.projects;
      const { [e.projectId]: _ds, ...devServers } = s.devServers;
      set({ projects, devServers, selectedProjectId: s.selectedProjectId === e.projectId ? null : s.selectedProjectId });
      return true;
    }
    if (e.type === 'conversation.updated') { set({ conversations: { ...s.conversations, [e.rootId]: e.meta } }); return true; }
    if (e.type === 'memory.updated') { set({ memoryRev: { ...s.memoryRev, [e.projectId]: (s.memoryRev[e.projectId] ?? 0) + 1 } }); return true; }
    if (e.type === 'devserver.updated') { set({ devServers: { ...s.devServers, [e.projectId]: e.state } }); return true; }
    if (e.type === 'devserver.log') {
      const lines = [...(e.reset ? [] : s.devLogs[e.projectId] ?? []), ...e.lines].slice(-DEV_LOG_MAX);
      set({ devLogs: { ...s.devLogs, [e.projectId]: lines } });
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

  setConversations(meta) { set(s => ({ conversations: { ...s.conversations, ...meta } })); },
  setDevServer(projectId, state, log) {
    set(s => ({ devServers: { ...s.devServers, [projectId]: state }, devLogs: { ...s.devLogs, [projectId]: log.slice(-DEV_LOG_MAX) } }));
  },
  select(projectId) { set({ selectedProjectId: projectId }); },
  setRoleFilter(f) { set({ roleFilter: f }); },
  setNight(on) {
    try { localStorage.setItem(NIGHT_KEY, on ? '1' : '0'); } catch { /* storage unavailable: still toggle */ }
    set({ night: on });
  },
  setSound(on) {
    try { localStorage.setItem(SOUND_KEY, on ? '1' : '0'); } catch { /* storage unavailable: still toggle */ }
    set({ soundOn: on });
  },
  setOpenConv(c) {
    const cur = get().openConv;
    if (c?.projectId === cur?.projectId && c?.rootId === cur?.rootId) return;
    set(s => ({ openConv: c, ...(c ? { lastConv: { ...s.lastConv, [c.projectId]: c.rootId } } : {}) }));
  },
  forgetConv(projectId) {
    set(s => { const { [projectId]: _gone, ...lastConv } = s.lastConv; return { lastConv }; });
  },
  openConversation(projectId, rootId) {
    set({ selectedProjectId: projectId, roleFilter: 'all', openRequest: { projectId, rootId, n: ++openN } });
  },
  addUnseen(u) { set(s => (s.unseen.some(x => x.key === u.key) ? s : { unseen: [...s.unseen, u] })); },
  clearUnseen(rootId) { set(s => (s.unseen.some(x => x.rootId === rootId) ? { unseen: s.unseen.filter(x => x.rootId !== rootId) } : s)); },
}));

/** Back to an empty office (tests). */
export function resetOffice(): void {
  logs.clear();
  useOffice.setState(initial());
}

/** Done tickets of a project known to the client (trophies). */
export const doneCount = (s: Pick<OfficeState, 'tickets'>, projectId: string): number =>
  Object.values(s.tickets).filter(t => t.projectId === projectId && t.status === 'done').length;

