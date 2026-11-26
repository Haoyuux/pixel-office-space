import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import WebSocket from 'ws';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { ServerEvent } from '@office/shared';
import { createOffice, type Office } from '../src/app';
import { SimulatedOrchestrator } from '../src/orchestrator/simulated';
import { TicketLog } from '../src/ticketLog';
import { tmp, projectDir, ManualScheduler } from './helpers';

let office: Office;
let sched: ManualScheduler;
const boot = async () => {
  const dataDir = tmp();
  sched = new ManualScheduler();
  const log = new TicketLog(join(dataDir, 'projects'));
  const orchestrator = new SimulatedOrchestrator({ log, scheduler: sched, random: () => 0.99, stageMs: [100, 200] });
  office = createOffice({ dataDir, orchestrator, log });
  await new Promise<void>(r => office.server.listen(0, '127.0.0.1', () => r()));
  return office;
};
const url = () => `ws://127.0.0.1:${(office.server.address() as AddressInfo).port}/ws`;
const connect = () => new Promise<{ ws: WebSocket; msgs: ServerEvent[] }>(resolve => {
  const ws = new WebSocket(url()); const msgs: ServerEvent[] = [];
  ws.on('message', d => { msgs.push(JSON.parse(String(d))); if (msgs.length === 1) resolve({ ws, msgs }); });
});
const addProject = (folder = projectDir()) =>
  request(office.server).post('/api/projects').send({ name: 'Shop', folder, accent: 'cyan', team: ['pm', 'techlead', 'frontend', 'backend', 'qa'] });

afterEach(() => office?.close());

describe('REST + WebSocket', () => {
  it('rejects a missing folder with 400', async () => {
    await boot();
    const r = await addProject(join(tmp(), 'nope'));
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/Folder not found/);
  });

  it('creates a project, writes agent files and broadcasts project.added', async () => {
    await boot();
    const { ws, msgs } = await connect();
    const folder = projectDir('with space');
    const r = await addProject(folder);
    expect(r.status).toBe(201);
    expect(r.body.slot).toBe(0);
    expect(existsSync(join(folder, '.claude/agents/pm.md'))).toBe(true);
    await new Promise(res => setTimeout(res, 50));
    expect(msgs.map(m => m.type)).toContain('project.added');
    ws.close();
  });

  it('blocks removing a busy role with 409 and allows a free one', async () => {
    await boot();
    const p = (await addProject()).body;
    const t = (await request(office.server).post(`/api/projects/${p.id}/tickets`).send({ text: 'Add login' })).body;
    sched.flush();
    await request(office.server).post(`/api/tickets/${t.id}/gates/plan`).send({ decision: 'approved' });
    const busy = await request(office.server).patch(`/api/projects/${p.id}`).send({ team: ['pm', 'techlead', 'backend', 'qa'] });
    expect(busy.status).toBe(409);
    const free = await request(office.server).patch(`/api/projects/${p.id}`).send({ team: [...p.team, 'writer'] });
    expect(free.status).toBe(200);
  });

  it('sends a snapshot with the open gate to a socket connecting mid-ticket', async () => {
    await boot();
    const p = (await addProject()).body;
    await request(office.server).post(`/api/projects/${p.id}/tickets`).send({ text: 'Add login' });
    sched.flush();
    const { ws, msgs } = await connect();
    const snap = msgs[0] as Extract<ServerEvent, { type: 'snapshot' }>;
    expect(snap.type).toBe('snapshot');
    expect(snap.snapshot.tickets[0].openGate).toBe('plan');
    ws.close();
  });

  it('accepts a gate decision once, then 409', async () => {
    await boot();
    const p = (await addProject()).body;
    const t = (await request(office.server).post(`/api/projects/${p.id}/tickets`).send({ text: 'x' })).body;
    sched.flush();
    expect((await request(office.server).post(`/api/tickets/${t.id}/gates/plan`).send({ decision: 'approved' })).status).toBe(200);
    expect((await request(office.server).post(`/api/tickets/${t.id}/gates/plan`).send({ decision: 'approved' })).status).toBe(409);
  });

  it('rejects messages to a ticket that is not running', async () => {
    await boot();
    const p = (await addProject()).body;
    const t = (await request(office.server).post(`/api/projects/${p.id}/tickets`).send({ text: 'x' })).body;
    await request(office.server).post(`/api/tickets/${t.id}/cancel`);
    expect((await request(office.server).post(`/api/tickets/${t.id}/messages`).send({ text: 'hi' })).status).toBe(409);
  });

  it('deleting a project cancels its running ticket and broadcasts project.removed', async () => {
    await boot();
    const { ws, msgs } = await connect();
    const p = (await addProject()).body;
    await request(office.server).post(`/api/projects/${p.id}/tickets`).send({ text: 'x' });
    expect((await request(office.server).delete(`/api/projects/${p.id}`)).status).toBe(200);
    await new Promise(res => setTimeout(res, 50));
    const types = msgs.map(m => m.type);
    expect(types.indexOf('ticket.cancelled')).toBeLessThan(types.indexOf('project.removed'));
    ws.close();
  });

  it('returns ticket history with events', async () => {
    await boot();
    const p = (await addProject()).body;
    const t = (await request(office.server).post(`/api/projects/${p.id}/tickets`).send({ text: 'x' })).body;
    sched.flush();
    const r = await request(office.server).get(`/api/projects/${p.id}/tickets?limit=20`);
    expect(r.body.tickets[0].id).toBe(t.id);
    expect(r.body.events[t.id].length).toBeGreaterThan(3);
  });
});
