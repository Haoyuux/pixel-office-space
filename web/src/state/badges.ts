import type { Ticket } from '@office/shared';

/** How long a room shows `✓ done` after a ticket finishes. */
export const DONE_BADGE_MS = 5000;

/**
 * Status badge over a room's nameplate: `⏸ N waiting` while a gate waits for the owner, `… working` while a ticket
 * runs, `✓ done` for 5 s after one finished (`doneAt` = when, same clock as `now`), otherwise none.
 */
export function roomBadge(tickets: Ticket[], projectId: string, doneAt: number | undefined, now: number): string | null {
  const mine = tickets.filter(t => t.projectId === projectId);
  const waiting = mine.filter(t => t.status === 'waiting').length;
  if (waiting) return `⏸ ${waiting} waiting`;
  if (mine.some(t => t.status === 'running')) return '… working';
  if (doneAt !== undefined && now - doneAt < DONE_BADGE_MS) return '✓ done';
  return null;
}
