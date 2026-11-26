import type { Project, Ticket, Stage, RoleId, AgentState, GateKind, GateDecision, Plan, DiffFile } from './types';

export interface Snapshot { projects: Project[]; tickets: Ticket[] }

interface Base { projectId: string; ts: string }
interface TBase extends Base { ticketId: string; seq: number }

export type ServerEvent =
  | ({ type: 'snapshot'; snapshot: Snapshot } & Partial<Base>)
  | ({ type: 'project.added' | 'project.updated'; project: Project } & Base)
  | ({ type: 'project.removed' } & Base)
  | ({ type: 'ticket.created'; ticket: Ticket } & TBase)
  | ({ type: 'ticket.stage'; stage: Stage; roles: RoleId[] } & TBase)
  | ({ type: 'ticket.done' } & TBase)
  | ({ type: 'ticket.failed'; reason: string } & TBase)
  | ({ type: 'ticket.cancelled' } & TBase)
  | ({ type: 'agent.state'; role: RoleId; state: AgentState } & TBase)
  | ({ type: 'agent.message'; role: RoleId; text: string; streaming: boolean; messageId: string } & TBase)
  | ({ type: 'agent.tool'; role: RoleId; tool: string; summary: string; detail?: string; status: 'running' | 'ok' | 'error'; toolId: string } & TBase)
  | ({ type: 'gate.open'; gate: GateKind; payload: unknown } & TBase)
  | ({ type: 'gate.closed'; gate: GateKind; decision: GateDecision; note?: string } & TBase)
  | ({ type: 'ticket.plan'; plan: Plan } & TBase)
  | ({ type: 'ticket.diff'; files: DiffFile[] } & TBase)
  | ({ type: 'log.raw'; role: RoleId; line: string } & TBase)
  | ({ type: 'user.message'; text: string } & TBase);

export type TicketEvent = Extract<ServerEvent, { seq: number }>;
export type EventOf<T extends ServerEvent['type']> = Extract<ServerEvent, { type: T }>;
