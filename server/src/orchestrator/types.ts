import type { GateDecision, GateKind, Project, RoleId, ServerEvent, Ticket, TicketMode } from '@office/shared';

export { ConflictError, ValidationError } from '../errors';

export interface Scheduler { after(ms: number, fn: () => void): () => void }

export const realScheduler: Scheduler = {
  after(ms, fn) { const h = setTimeout(fn, ms); return () => clearTimeout(h); },
};

/** mode: how the PM treats the request (missing = 'ticket', the pre-mode behaviour; the API defaults to 'auto'). */
export interface StartOptions { parentTicketId?: string; mode?: TicketMode }

export interface Orchestrator {
  startTicket(project: Project, text: string, opts?: StartOptions): Ticket;
  /** Re-run a failed/interrupted ticket from its interrupted stage (claude only; else ConflictError). */
  resume(ticketId: string): Ticket;
  /** Re-queue a ticket recovered from the log after a restart. */
  adopt(project: Project, ticket: Ticket): void;
  decide(ticketId: string, gate: GateKind, decision: GateDecision, note?: string): void;
  sendMessage(ticketId: string, text: string): void;
  cancel(ticketId: string): void;
  current(projectId: string): Ticket | undefined;
  queue(projectId: string): Ticket[];
  find(ticketId: string): Ticket | undefined;
  onEvent(cb: (e: ServerEvent) => void): void;
  busyRoles(projectId: string): RoleId[];
  /** Server stop: abort live runs and wait briefly for their processes to end. */
  shutdown?(): Promise<void>;
}
