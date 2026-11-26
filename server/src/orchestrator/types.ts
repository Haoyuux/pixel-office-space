import type { GateDecision, GateKind, Project, RoleId, ServerEvent, Ticket } from '@office/shared';

export class ConflictError extends Error {}

export interface Scheduler { after(ms: number, fn: () => void): () => void }

export const realScheduler: Scheduler = {
  after(ms, fn) { const h = setTimeout(fn, ms); return () => clearTimeout(h); },
};

export interface Orchestrator {
  startTicket(project: Project, text: string): Ticket;
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
}
