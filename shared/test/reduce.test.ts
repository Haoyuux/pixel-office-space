import { describe, it, expect } from 'vitest';
import { applyTicketEvent } from '../src/reduce';
import type { Ticket } from '../src/types';

const t0: Ticket = { id: 't', projectId: 'p', title: 'x', text: 'x', status: 'queued', stage: null, agentStates: {}, createdAt: '' };
const base = { projectId: 'p', ticketId: 't', ts: '', seq: 1 };

describe('applyTicketEvent', () => {
  it('tracks stage, agent state, gates and terminal status', () => {
    let t = applyTicketEvent(undefined, { ...base, type: 'ticket.created', ticket: t0 })!;
    expect(t.status).toBe('queued');
    t = applyTicketEvent(t, { ...base, type: 'ticket.stage', stage: 'plan', roles: ['pm'] })!;
    expect(t).toMatchObject({ status: 'running', stage: 'plan' });
    t = applyTicketEvent(t, { ...base, type: 'agent.state', role: 'pm', state: 'planning' })!;
    expect(t.agentStates.pm).toBe('planning');
    t = applyTicketEvent(t, { ...base, type: 'gate.open', gate: 'plan', payload: null })!;
    expect(t).toMatchObject({ status: 'waiting', openGate: 'plan' });
    t = applyTicketEvent(t, { ...base, type: 'gate.closed', gate: 'plan', decision: 'approved' })!;
    expect(t.openGate).toBeUndefined();
    expect(t.status).toBe('running');
    t = applyTicketEvent(t, { ...base, type: 'ticket.failed', reason: 'interrupted' })!;
    expect(t).toMatchObject({ status: 'failed', reason: 'interrupted' });
  });

  it('ticket.answered marks the ticket answered (mode kept from creation)', () => {
    let t = applyTicketEvent(undefined, { ...base, type: 'ticket.created', ticket: { ...t0, mode: 'ask' } })!;
    t = applyTicketEvent(t, { ...base, type: 'ticket.answered' })!;
    t = applyTicketEvent(t, { ...base, type: 'ticket.done' })!;
    expect(t).toMatchObject({ mode: 'ask', answered: true, status: 'done', stage: 'done' });
  });

  it('does not mutate its input', () => {
    const t = applyTicketEvent(undefined, { ...base, type: 'ticket.created', ticket: t0 })!;
    applyTicketEvent(t, { ...base, type: 'ticket.stage', stage: 'plan', roles: ['pm'] });
    expect(t.status).toBe('queued');
  });
});
