import type { ServerEvent, Ticket } from '@office/shared';

/** A ticket interrupted more often than this (counting this restart) waits for the owner's Resume. */
export const AUTO_RESUME_MAX = 3;

/**
 * Tickets the office was running when it stopped (a restart: code change, crash, Ctrl+C) are marked
 * failed/interrupted on boot. Resume them automatically, unless one keeps getting interrupted (a crash loop).
 * Returns the ids that were resumed.
 */
export function autoResume(
  ids: string[],
  log: { find(id: string): { events: ServerEvent[] } | undefined },
  orchestrator: { resume(id: string): Ticket },
): string[] {
  const out: string[] = [];
  for (const id of ids) {
    const events = log.find(id)?.events;
    if (!events) continue;
    const times = events.filter(e => e.type === 'ticket.failed' && (e as { reason?: string }).reason === 'interrupted').length;
    if (times > AUTO_RESUME_MAX) continue;
    try { orchestrator.resume(id); out.push(id); } catch { /* nothing to resume (simulated, no sessions): the owner decides */ }
  }
  return out;
}
