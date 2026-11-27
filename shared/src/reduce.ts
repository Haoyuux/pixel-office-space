import type { Ticket } from './types';
import type { ServerEvent } from './events';

/** Pure reducer: rebuilds a ticket's state from its events. Used by the server log and the client store. */
export function applyTicketEvent(t: Ticket | undefined, e: ServerEvent): Ticket | undefined {
  if (e.type === 'ticket.created') return { ...e.ticket, agentStates: { ...e.ticket.agentStates } };
  if (!t) return t;
  switch (e.type) {
    case 'ticket.stage': return { ...t, stage: e.stage, status: t.openGate ? 'waiting' : 'running' };
    case 'agent.state': return { ...t, agentStates: { ...t.agentStates, [e.role]: e.state } };
    case 'ticket.plan': return { ...t, plan: e.plan };
    case 'gate.open': return { ...t, openGate: e.gate, status: 'waiting' };
    case 'gate.closed': { const { openGate: _g, ...rest } = t; return { ...rest, status: 'running' }; }
    case 'ticket.answered': return { ...t, answered: true };
    case 'ticket.done': { const { openGate: _g, ...rest } = t; return { ...rest, status: 'done', stage: 'done' }; }
    case 'ticket.failed': { const { openGate: _g, ...rest } = t; return { ...rest, status: 'failed', reason: e.reason }; }
    case 'ticket.cancelled': { const { openGate: _g, ...rest } = t; return { ...rest, status: 'cancelled' }; }
    case 'agent.session': return { ...t, sessions: { ...t.sessions, [e.role]: e.sessionId } };
    case 'ticket.usage': return { ...t, usage: { turns: e.turns, costUsd: e.costUsd, durationMs: e.durationMs } };
    case 'ticket.workspace': return { ...t, workspace: { ...e.workspace } };
    case 'ticket.resumed': { const { reason: _r, openGate: _g, ...rest } = t; return { ...rest, status: e.queued ? 'queued' : 'running' }; }
    default: return t;
  }
}

export const isTerminal = (t: Ticket) => t.status === 'done' || t.status === 'failed' || t.status === 'cancelled';
