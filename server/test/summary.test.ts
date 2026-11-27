import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import { join } from 'node:path';
import type { Project, ServerEvent, Summary, Ticket } from '@office/shared';
import { createOffice, type Office } from '../src/app';
import { SimulatedOrchestrator } from '../src/orchestrator/simulated';
import { TicketLog } from '../src/ticketLog';
import { tmp, projectDir, ManualScheduler } from './helpers';

let office: Office;
let log: TicketLog;
const boot = () => {
  const dataDir = tmp();
  log = new TicketLog(join(dataDir, 'projects'));
  const orchestrator = new SimulatedOrchestrator({ log, scheduler: new ManualScheduler(), random: () => 0.99, stageMs: [100, 200] });
  office = createOffice({ dataDir, orchestrator, log });
  return office;
};
afterEach(() => office?.close());

const addProject = async (name: string) =>
  (await request(office.server).post('/api/projects').send({ name, folder: projectDir(), accent: 'cyan', team: ['pm', 'frontend', 'qa'] })).body as Project;

const T = (h: number) => new Date(Date.UTC(2026, 10, 27, h)).toISOString();
/** Writes a ticket's log: events are [type, hour, extra] after the ticket.created at `created`. */
function ticket(projectId: string, id: string, created: number, evs: [ServerEvent['type'], number, Record<string, unknown>?][], over: Partial<Ticket> = {}) {
  let seq = 0;
  const base = (type: string, h: number, extra: Record<string, unknown> = {}) =>
    log.append({ type, projectId, ticketId: id, seq: ++seq, ts: T(h), ...extra } as unknown as ServerEvent);
  base('ticket.created', created, {
    ticket: { id, projectId, title: `Title ${id}`, text: 'x', status: 'queued', stage: null, agentStates: {}, createdAt: T(created), ...over },
  });
  for (const [type, h, extra] of evs) base(type, h, extra);
}
const get = async (q = '') => (await request(office.server).get(`/api/summary${q}`));

describe('GET /api/summary', () => {
  it('per project: counts, waiting gates (regardless of since), recent items newest first, usage since; totals', async () => {
    boot();
    const a = await addProject('Shop');
    const b = await addProject('Blog');
    // before the window: finished at 8 (not counted, not an item)
    ticket(a.id, 'old', 7, [['ticket.usage', 8, { turns: 5, costUsd: 1, durationMs: 1000 }], ['ticket.done', 8]]);
    // a gate opened before the window is still waiting
    ticket(a.id, 'gate', 7, [['ticket.stage', 7, { stage: 'plan', roles: ['pm'] }], ['gate.open', 7, { gate: 'plan', payload: null }]]);
    // done in the window; its usage grew from 2 → 6 turns across the window boundary
    ticket(a.id, 'chg', 9, [['ticket.usage', 9, { turns: 2, costUsd: 0.2, durationMs: 200 }], ['ticket.resumed', 11, { stage: 'build' }],
      ['ticket.usage', 12, { turns: 6, costUsd: 0.5, durationMs: 700 }], ['ticket.done', 12]]);
    // answered follow-up of chg (its root is chg)
    ticket(a.id, 'ans', 13, [['ticket.answered', 13], ['ticket.usage', 13, { turns: 1, costUsd: 0.1, durationMs: 100 }], ['ticket.done', 13]],
      { parentTicketId: 'chg', mode: 'auto' });
    ticket(b.id, 'bad', 11, [['ticket.failed', 11, { reason: 'boom' }]]);

    const r = await get(`?since=${encodeURIComponent(T(10))}`);
    expect(r.status).toBe(200);
    const s = r.body as Summary;
    expect(s.since).toBe(T(10));
    const shop = s.projects.find(p => p.projectId === a.id)!;
    expect(shop).toMatchObject({ name: 'Shop', finished: 1, failed: 0, answered: 1 });
    expect(shop.waiting).toEqual([{ ticketId: 'gate', rootId: 'gate', title: 'Title gate', gate: 'plan' }]);
    expect(shop.items).toEqual([
      { ticketId: 'ans', rootId: 'chg', title: 'Title ans', kind: 'chat', status: 'done', at: T(13) },
      { ticketId: 'chg', rootId: 'chg', title: 'Title chg', kind: 'ticket', status: 'done', at: T(12) },
    ]);
    expect(shop.usage.turns).toBe(5);
    expect(shop.usage.costUsd).toBeCloseTo(0.4);
    expect(shop.usage.durationMs).toBe(600);
    const blog = s.projects.find(p => p.projectId === b.id)!;
    expect(blog).toMatchObject({ name: 'Blog', finished: 0, failed: 1, answered: 0, waiting: [] });
    expect(blog.items).toEqual([{ ticketId: 'bad', rootId: 'bad', title: 'Title bad', kind: 'ticket', status: 'failed', at: T(11) }]);
    expect(s.totals).toMatchObject({ finished: 1, failed: 1, answered: 1, waiting: 1 });
    expect(s.totals.usage.turns).toBe(5);
  });

  it('a ticket that failed and was resumed into running is not counted failed; soft-deleted conversations are left out', async () => {
    boot();
    const a = await addProject('Shop');
    ticket(a.id, 'res', 11, [['ticket.failed', 11, { reason: 'interrupted' }], ['ticket.resumed', 12, { stage: 'build' }]]);
    ticket(a.id, 'del', 11, [['ticket.done', 12]]);
    await request(office.server).patch('/api/conversations/del').send({ title: 'x' });
    await request(office.server).delete('/api/conversations/del').send({});
    const s = (await get(`?since=${encodeURIComponent(T(10))}`)).body as Summary;
    const shop = s.projects[0];
    expect(shop).toMatchObject({ finished: 0, failed: 0 });
    expect(shop.items.map(i => [i.ticketId, i.status])).toEqual([['res', 'running']]);
  });

  it('since: invalid → 400; missing → the last 24 hours; empty office → zero totals', async () => {
    boot();
    expect((await get('?since=yesterday-ish')).status).toBe(400);
    const r = await get();
    expect(r.status).toBe(200);
    expect(Date.now() - Date.parse(r.body.since)).toBeGreaterThan(23.9 * 3600_000);
    expect(r.body).toMatchObject({ projects: [], totals: { finished: 0, failed: 0, answered: 0, waiting: 0, usage: { turns: 0, costUsd: 0, durationMs: 0 } } });
  });

  it('behind the request guards (foreign origin refused)', async () => {
    boot();
    expect((await request(office.server).get('/api/summary').set('Origin', 'http://evil.example')).status).toBe(403);
  });
});
