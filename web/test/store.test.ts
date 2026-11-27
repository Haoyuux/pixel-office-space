import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Project, ServerEvent, Ticket } from '@office/shared';
import { useOffice, resetOffice, initialNight } from '../src/state/store';

const P: Project = { id: 'p', name: 'Shop', folder: '.', accent: 'cyan', team: ['pm', 'frontend'], slot: 0, looks: {} as Project['looks'], createdAt: '' };
const T: Ticket = { id: 't', projectId: 'p', title: 'Add login', text: 'Add login', status: 'queued', stage: null, agentStates: {}, createdAt: '' };
let seq = 0;
const ev = (e: Record<string, unknown>): ServerEvent => ({ projectId: 'p', ticketId: 't', ts: `2026-11-26T10:00:${String(seq).padStart(2, '0')}Z`, seq: ++seq, ...e } as ServerEvent);
const apply = (e: ServerEvent) => useOffice.getState().apply(e);
const feed = () => useOffice.getState().feed.t ?? [];

beforeEach(() => { resetOffice(); seq = 0; });

describe('ask vs ticket', () => {
  it('ticket.answered marks the ticket answered and the last PM message as the answer; the raw JSON reply is dropped', () => {
    apply(ev({ type: 'ticket.created', ticket: { ...T, mode: 'auto' } }));
    apply(ev({ type: 'ticket.stage', stage: 'plan', roles: ['pm'] }));
    apply(ev({ type: 'agent.message', role: 'pm', text: 'Looking.', streaming: false, messageId: 'm0' }));
    apply(ev({ type: 'agent.message', role: 'pm', text: '```json\n{"kind": "answer", "answer": "Save"}\n```', streaming: false, messageId: 'm1' }));
    apply(ev({ type: 'agent.message', role: 'pm', text: '## Buttons\n- Save', streaming: false, messageId: 'm2' }));
    apply(ev({ type: 'ticket.answered' }));
    apply(ev({ type: 'ticket.done' }));
    expect(useOffice.getState().tickets.t).toMatchObject({ answered: true, mode: 'auto', status: 'done' });
    const msgs = feed().filter(f => f.kind === 'message');
    expect(msgs.map(m => m.id)).toEqual(['m0', 'm2']);
    expect(msgs[1].answer).toBe(true);
    expect(msgs[0].answer).toBeUndefined();
  });
});

describe('office store', () => {
  it('a snapshot and then the same events again do not duplicate feed items', () => {
    const snap: ServerEvent = { type: 'snapshot', snapshot: { projects: [P], tickets: [T] }, ts: '' };
    const events = [
      ev({ type: 'ticket.created', ticket: T }),
      ev({ type: 'ticket.stage', stage: 'plan', roles: ['pm'] }),
      ev({ type: 'agent.message', role: 'pm', text: 'Planning.', streaming: false, messageId: 'm1' }),
      ev({ type: 'agent.tool', role: 'pm', tool: 'Read', summary: 'Read src/a.ts', status: 'ok', toolId: 'x1' }),
      ev({ type: 'log.raw', role: 'pm', line: '[pm] Read src/a.ts' }),
    ];
    apply(snap);
    events.forEach(apply);
    const once = feed().length;
    const raw = useOffice.getState().raw.t.length;
    expect(once).toBe(3); // stage, message, tool
    // reconnect: the fresh snapshot carries the server's current state, then the same events are replayed
    apply({ type: 'snapshot', snapshot: { projects: [P], tickets: [{ ...T, status: 'running', stage: 'plan' }] }, ts: '' });
    events.forEach(apply);
    expect(feed()).toHaveLength(once);
    expect(useOffice.getState().raw.t).toHaveLength(raw);
    expect(useOffice.getState().lastSeq.t).toBe(5);
    expect(useOffice.getState().projects.p.name).toBe('Shop');
    expect(useOffice.getState().tickets.t.stage).toBe('plan');
  });

  it('concatenates streaming message chunks with one messageId into one item', () => {
    apply(ev({ type: 'ticket.created', ticket: T }));
    for (const text of ['Hel', 'lo ', 'there'])
      apply(ev({ type: 'agent.message', role: 'frontend', text, streaming: true, messageId: 'm' }));
    const msgs = feed().filter(f => f.kind === 'message');
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ text: 'Hello there', role: 'frontend', id: 'm' });
  });

  it('gate.open adds a gate item and sets openGate; gate.closed clears it', () => {
    apply(ev({ type: 'ticket.created', ticket: T }));
    apply(ev({ type: 'gate.open', gate: 'plan', payload: null }));
    expect(useOffice.getState().tickets.t.openGate).toBe('plan');
    const gates = feed().filter(f => f.kind === 'gate');
    expect(gates).toHaveLength(1);
    expect(gates[0].text).toContain('plan');
    apply(ev({ type: 'gate.closed', gate: 'plan', decision: 'approved' }));
    expect(useOffice.getState().tickets.t.openGate).toBeUndefined();
    expect(feed().filter(f => f.kind === 'gate')[0].status).toBe('approved');
  });

  it('history replay fills in events missed before the live ones, without duplicates', () => {
    const all = [
      ev({ type: 'ticket.created', ticket: T }),
      ev({ type: 'ticket.stage', stage: 'plan', roles: ['pm'] }),
      ev({ type: 'agent.message', role: 'pm', text: 'one', streaming: false, messageId: 'm1' }),
      ev({ type: 'agent.message', role: 'pm', text: 'two', streaming: false, messageId: 'm2' }),
    ];
    apply({ type: 'snapshot', snapshot: { projects: [P], tickets: [{ ...T, status: 'running', stage: 'plan' }] }, ts: '' });
    apply(all[3]); // page opened mid-ticket: only the latest event arrived live
    expect(feed()).toHaveLength(1);
    useOffice.getState().applyHistory('p', [T], { t: all });
    expect(feed().map(f => f.text)).toEqual(['plan', 'one', 'two']);
    useOffice.getState().applyHistory('p', [T], { t: all });
    expect(feed()).toHaveLength(3);
    expect(useOffice.getState().tickets.t.stage).toBe('plan');
  });
});

describe('day/night default', () => {
  const fakeStorage = (init: Record<string, string> = {}) => {
    const m = new Map(Object.entries(init));
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, map: m };
  };
  it('opens in night mode when nothing is remembered', () => {
    expect(initialNight(fakeStorage())).toBe(true);
  });
  it('restores the remembered choice', () => {
    expect(initialNight(fakeStorage({ 'pixel-office.night': '1' }))).toBe(true);
    expect(initialNight(fakeStorage({ 'pixel-office.night': '0' }))).toBe(false);
  });
  it('survives storage that throws', () => {
    expect(initialNight({ getItem: () => { throw new Error('blocked'); } } as any)).toBe(true);
  });
  it('setNight remembers the choice', () => {
    const s = fakeStorage();
    vi.stubGlobal('localStorage', s);
    useOffice.getState().setNight(true);
    expect(s.map.get('pixel-office.night')).toBe('1');
    useOffice.getState().setNight(false);
    expect(s.map.get('pixel-office.night')).toBe('0');
    vi.unstubAllGlobals();
  });
});
