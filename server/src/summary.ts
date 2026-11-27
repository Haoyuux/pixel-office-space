import type {
  ConversationMeta, Project, ProjectSummary, ServerEvent, Summary, SummaryItem, SummaryUsage, SummaryWaiting, Ticket,
} from '@office/shared';

/** Recent items listed per project (newest first). */
export const SUMMARY_ITEMS_MAX = 50;

type Entry = { ticket: Ticket; events: ServerEvent[] };
const TERMINAL = new Set<ServerEvent['type']>(['ticket.done', 'ticket.failed', 'ticket.cancelled']);
const zero = (): SummaryUsage => ({ turns: 0, costUsd: 0, durationMs: 0 });
const addUsage = (a: SummaryUsage, b: SummaryUsage) => { a.turns += b.turns; a.costUsd += b.costUsd; a.durationMs += b.durationMs; };
const at = (e: ServerEvent) => Date.parse(e.ts ?? '');

/**
 * What happened since `since` (ms), per project, from the ticket logs. Counts and items use events with ts ≥ since:
 * finished / failed / answered count tickets whose current state is that end reached in the window (a failed
 * ticket resumed since is not failed); usage is what the ticket.usage totals grew by in the window. `waiting` lists
 * the currently open gates regardless of since. Soft-deleted conversations are left out (their usage still counts).
 */
export function buildSummary(
  since: number, projects: Project[], entriesOf: (projectId: string) => Entry[], conversations: Record<string, ConversationMeta>,
): Summary {
  const out: ProjectSummary[] = projects.map(p => projectSummary(since, p, entriesOf(p.id), conversations));
  const totals = { finished: 0, failed: 0, answered: 0, waiting: 0, usage: zero() };
  for (const p of out) {
    totals.finished += p.finished; totals.failed += p.failed; totals.answered += p.answered; totals.waiting += p.waiting.length;
    addUsage(totals.usage, p.usage);
  }
  return { since: new Date(since).toISOString(), projects: out, totals };
}

function projectSummary(since: number, p: Project, entries: Entry[], conversations: Record<string, ConversationMeta>): ProjectSummary {
  const byId = new Map(entries.map(e => [e.ticket.id, e.ticket]));
  const rootOf = (t: Ticket): string => {
    const seen = new Set<string>();
    let cur = t;
    while (cur.parentTicketId && !seen.has(cur.id)) {
      seen.add(cur.id);
      const parent = byId.get(cur.parentTicketId);
      if (!parent) break;
      cur = parent;
    }
    return cur.id;
  };
  const s: ProjectSummary = { projectId: p.id, name: p.name, finished: 0, failed: 0, answered: 0, waiting: [], items: [], usage: zero() };
  for (const { ticket: t, events } of entries) {
    addUsage(s.usage, usageGrowth(since, events));
    const rootId = rootOf(t);
    if (conversations[rootId]?.deleted) continue;
    if (t.openGate && t.status === 'waiting') {
      const w: SummaryWaiting = { ticketId: t.id, rootId, title: t.title, gate: t.openGate };
      s.waiting.push(w);
    }
    const recent = events.filter(e => at(e) >= since);
    if (!recent.length) continue;
    const end = [...events].reverse().find(e => TERMINAL.has(e.type));
    if (end && at(end) >= since) {
      if (t.status === 'done') { if (t.answered) s.answered++; else s.finished++; }
      else if (t.status === 'failed') s.failed++;
    }
    const last = recent.reduce((a, b) => (at(b) >= at(a) ? b : a));
    const item: SummaryItem = {
      ticketId: t.id, rootId, title: t.title, kind: t.answered || t.mode === 'ask' ? 'chat' : 'ticket', status: t.status, at: last.ts!,
    };
    s.items.push(item);
  }
  s.items.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  s.items.splice(SUMMARY_ITEMS_MAX);
  return s;
}

/** ticket.usage carries per-ticket totals: the growth in the window = the last total in it minus the last before it. */
function usageGrowth(since: number, events: ServerEvent[]): SummaryUsage {
  let before = zero(), after: SummaryUsage | undefined;
  for (const e of events) {
    if (e.type !== 'ticket.usage') continue;
    const u = { turns: e.turns || 0, costUsd: e.costUsd || 0, durationMs: e.durationMs || 0 };
    if (at(e) >= since) after = u; else before = u;
  }
  if (!after) return zero();
  return {
    turns: Math.max(0, after.turns - before.turns),
    costUsd: Math.max(0, after.costUsd - before.costUsd),
    durationMs: Math.max(0, after.durationMs - before.durationMs),
  };
}
