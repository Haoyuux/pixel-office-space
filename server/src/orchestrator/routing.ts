import type { GateDecision, GateKind, Project, RoleId, ServerEvent, Ticket } from '@office/shared';
import { ConflictError, type Orchestrator, type StartOptions } from './types';

export type Mode = 'claude' | 'simulated';
export const modeOf = (p: Project): Mode => p.agentsMode ?? 'claude';

/** Dispatches per project by `project.agentsMode` (missing = claude). Ticket-level calls go to whoever owns it. */
export class RoutingOrchestrator implements Orchestrator {
  constructor(private readonly byMode: Record<Mode, Orchestrator>) {}

  private all(): Orchestrator[] { return [...new Set(Object.values(this.byMode))]; }
  private owner(ticketId: string): Orchestrator | undefined { return this.all().find(o => o.find(ticketId)); }

  startTicket(project: Project, text: string, opts?: StartOptions): Ticket { return this.byMode[modeOf(project)].startTicket(project, text, opts); }
  adopt(project: Project, ticket: Ticket): void { this.byMode[ticket.agentsMode ?? modeOf(project)].adopt(project, ticket); }
  /** Resume is a claude feature: the claude orchestrator rebuilds the ticket from the log. */
  resume(ticketId: string): Ticket { return (this.owner(ticketId) ?? this.byMode.claude).resume(ticketId); }
  decide(ticketId: string, gate: GateKind, decision: GateDecision, note?: string) { this.must(ticketId).decide(ticketId, gate, decision, note); }
  sendMessage(ticketId: string, text: string) { this.must(ticketId).sendMessage(ticketId, text); }
  cancel(ticketId: string) { this.must(ticketId).cancel(ticketId); }
  current(projectId: string) { for (const o of this.all()) { const t = o.current(projectId); if (t) return t; } return undefined; }
  queue(projectId: string) { return this.all().flatMap(o => o.queue(projectId)); }
  find(ticketId: string) { return this.owner(ticketId)?.find(ticketId); }
  onEvent(cb: (e: ServerEvent) => void) { for (const o of this.all()) o.onEvent(cb); }
  busyRoles(projectId: string): RoleId[] { return [...new Set(this.all().flatMap(o => o.busyRoles(projectId)))]; }

  private must(ticketId: string): Orchestrator {
    const o = this.owner(ticketId);
    if (!o) throw new ConflictError('Unknown ticket');
    return o;
  }
}
