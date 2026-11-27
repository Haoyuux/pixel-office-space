import type {
  Project, Ticket, Stage, RoleId, AgentState, GateKind, GateDecision, Plan, DiffFile, Workspace, Attachment, ConversationMeta,
} from './types';

export interface Snapshot {
  projects: Project[]; tickets: Ticket[];
  /** Conversation meta by root ticket id (all projects, deleted ones included with deleted: true). */
  conversations?: Record<string, ConversationMeta>;
}

interface Base { projectId: string; ts: string }
interface TBase extends Base { ticketId: string; seq: number }

export type ServerEvent =
  | ({ type: 'snapshot'; snapshot: Snapshot } & Partial<Base>)
  | ({ type: 'project.added' | 'project.updated'; project: Project } & Base)
  | ({ type: 'project.removed' } & Base)
  | ({ type: 'ticket.created'; ticket: Ticket } & TBase)
  | ({ type: 'ticket.stage'; stage: Stage; roles: RoleId[] } & TBase)
  /** stopped: the owner pressed Stop (the ticket ends done with the text streamed so far). */
  | ({ type: 'ticket.done'; stopped?: boolean } & TBase)
  /** The PM answered the request (Ask) instead of planning; ticket.done follows. */
  | ({ type: 'ticket.answered' } & TBase)
  | ({ type: 'ticket.failed'; reason: string } & TBase)
  | ({ type: 'ticket.cancelled' } & TBase)
  | ({ type: 'agent.state'; role: RoleId; state: AgentState } & TBase)
  /**
   * streaming: true = a text delta (append to the message with this messageId); the finished text follows with
   * streaming: false and the same messageId (replace). Messages that never streamed arrive once with streaming: false.
   */
  | ({ type: 'agent.message'; role: RoleId; text: string; streaming: boolean; messageId: string } & TBase)
  | ({ type: 'agent.tool'; role: RoleId; tool: string; summary: string; detail?: string; status: 'running' | 'ok' | 'error'; toolId: string } & TBase)
  | ({ type: 'gate.open'; gate: GateKind; payload: unknown } & TBase)
  | ({ type: 'gate.closed'; gate: GateKind; decision: GateDecision; note?: string } & TBase)
  | ({ type: 'ticket.plan'; plan: Plan } & TBase)
  | ({ type: 'ticket.diff'; files: DiffFile[] } & TBase)
  | ({ type: 'log.raw'; role: RoleId; line: string } & TBase)
  | ({ type: 'user.message'; text: string; attachments?: Attachment[] } & TBase)
  /** Conversation meta changed (rename, pin, delete, auto title). */
  | ({ type: 'conversation.updated'; rootId: string; meta: ConversationMeta } & Base)
  | ({ type: 'agent.session'; role: RoleId; sessionId: string } & TBase)
  /** Per-ticket totals across all runs (cost is an estimate). */
  | ({ type: 'ticket.usage'; turns: number; costUsd: number; durationMs: number } & TBase)
  | ({ type: 'ticket.workspace'; workspace: Workspace } & TBase)
  /** A failed/interrupted ticket was resumed (Resume button). */
  | ({ type: 'ticket.resumed'; stage: Stage | null; queued?: boolean } & TBase)
  /** A project's team memory changed (GET /api/projects/:id/memory for the entries). */
  | ({ type: 'memory.updated' } & Base);

export type TicketEvent = Extract<ServerEvent, { seq: number }>;
export type EventOf<T extends ServerEvent['type']> = Extract<ServerEvent, { type: T }>;
