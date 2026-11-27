import type { Ticket } from '@office/shared';

/**
 * Conversations are threads: the chain of tickets linked by `parentTicketId` (the root has none, or its parent is
 * not known to the client). No server schema of its own.
 */
type Tickets = Record<string, Ticket>;

/** Oldest first (ties by id, so the order is stable). */
const byOldest = (a: Ticket, b: Ticket) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);

/** The root ticket id of the thread `ticketId` belongs to (itself when it has no known parent). */
export function rootOf(ticketId: string, tickets: Tickets): string {
  let id = ticketId;
  const seen = new Set<string>([id]);
  for (;;) {
    const parent = tickets[id]?.parentTicketId;
    if (!parent || !tickets[parent] || seen.has(parent)) return id;
    seen.add(parent);
    id = parent;
  }
}

/** Every ticket of the thread rooted at `rootId`, oldest → newest. */
export function threadOf(rootId: string, tickets: Tickets): Ticket[] {
  return Object.values(tickets).filter(t => rootOf(t.id, tickets) === rootId).sort(byOldest);
}

export interface Thread { root: Ticket; tickets: Ticket[]; latest: Ticket }

/** A project's threads, most recently active first. */
export function threadsOf(projectId: string, tickets: Tickets): Thread[] {
  const groups = new Map<string, Ticket[]>();
  for (const t of Object.values(tickets)) {
    if (t.projectId !== projectId) continue;
    const r = rootOf(t.id, tickets);
    groups.set(r, [...(groups.get(r) ?? []), t]);
  }
  return [...groups.values()].map(ts => {
    const sorted = ts.sort(byOldest);
    return { root: sorted[0], tickets: sorted, latest: sorted[sorted.length - 1] };
  }).sort((a, b) => byOldest(b.latest, a.latest));
}

