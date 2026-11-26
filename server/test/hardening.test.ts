import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import WebSocket from 'ws';
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Project, RoleId, ServerEvent } from '@office/shared';
import { createOffice, type Office } from '../src/app';
import { SimulatedOrchestrator } from '../src/orchestrator/simulated';
import { TicketLog } from '../src/ticketLog';
import { ProjectStore } from '../src/store';
import { boot } from '../src/boot';
import { tmp, projectDir, ManualScheduler } from './helpers';

let office: Office | undefined;
let sched: ManualScheduler;
let dataDir: string;
const start = async (assetsDir?: string) => {
  dataDir = tmp();
  sched = new ManualScheduler();
  const log = new TicketLog(join(dataDir, 'projects'));
  const orchestrator = new SimulatedOrchestrator({ log, scheduler: sched, random: () => 0.99, stageMs: [100, 200] });
  office = createOffice({ dataDir, orchestrator, log, assetsDir });
  await new Promise<void>(r => office!.server.listen(0, '127.0.0.1', () => r()));
  return office;
};
const srv = () => office!.server;
const wsUrl = () => `ws://127.0.0.1:${(srv().address() as AddressInfo).port}/ws`;
const TEAM: RoleId[] = ['pm', 'techlead', 'frontend', 'backend', 'qa'];
const add = (over: Record<string, unknown> = {}) =>
  request(srv()).post('/api/projects').send({ name: 'Shop', folder: projectDir(), accent: 'cyan', team: TEAM, ...over });
const saved = () => {
  const f = join(dataDir, 'projects.json');
  return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')).projects as Project[]) : [];
};

afterEach(() => { office?.close(); office = undefined; });

describe('#1 scaffold before persisting', () => {
  it('POST: a folder whose .claude is a file gives 400 and saves nothing', async () => {
    await start();
    const folder = projectDir();
    writeFileSync(join(folder, '.claude'), 'not a folder');
    const r = await add({ folder });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/^Can't write \.claude\/agents in /);
    expect(saved()).toEqual([]);
    expect((await request(srv()).get('/api/projects')).body).toEqual([]);
  });

  it('PATCH: a failing scaffold gives 400 and keeps the old team', async () => {
    await start();
    const folder = projectDir();
    const p = (await add({ folder })).body as Project;
    // .claude/agents becomes a file: new role files can't be written
    const agents = join(folder, '.claude', 'agents');
    rmSync(agents, { recursive: true });
    writeFileSync(agents, 'x');
    const r = await request(srv()).patch(`/api/projects/${p.id}`).send({ team: [...p.team, 'writer'] });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/^Can't write \.claude\/agents in /);
    expect(saved()[0].team).toEqual(p.team);
    expect(office!.store.get(p.id)!.team).toEqual(p.team);
  });
});

describe('#2 cross-site access', () => {
  it('refuses a WebSocket from a foreign Origin', async () => {
    await start();
    const res = await new Promise<string>(resolve => {
      const ws = new WebSocket(wsUrl(), { origin: 'http://evil.example' });
      ws.on('open', () => { ws.close(); resolve('open'); });
      ws.on('unexpected-response', (_req, r) => resolve(`status ${r.statusCode}`));
      ws.on('error', () => resolve('error'));
    });
    expect(res).not.toBe('open');
  });

  it('accepts a WebSocket from a localhost Origin and with no Origin', async () => {
    await start();
    for (const origin of ['http://localhost:5173', 'http://127.0.0.1:5173', undefined]) {
      const first = await new Promise<string>((resolve, reject) => {
        const ws = new WebSocket(wsUrl(), origin ? { origin } : {});
        ws.on('message', d => { ws.close(); resolve(JSON.parse(String(d)).type); });
        ws.on('error', reject);
      });
      expect(first).toBe('snapshot');
    }
  });

  it('rejects a foreign Origin on REST with 403', async () => {
    await start();
    const r = await request(srv()).post('/api/projects').set('Origin', 'https://evil.example').send({ name: 'x' });
    expect(r.status).toBe(403);
    expect((await request(srv()).get('/api/projects').set('Origin', 'http://localhost.evil.example')).status).toBe(403);
    expect((await request(srv()).get('/api/projects').set('Origin', 'http://localhost:5173')).status).toBe(200);
  });

  it('requires application/json on mutations (415)', async () => {
    await start();
    const p = (await add()).body as Project;
    const t = (await request(srv()).post(`/api/projects/${p.id}/tickets`).send({ text: 'x' })).body;
    expect((await request(srv()).post(`/api/tickets/${t.id}/cancel`).set('Content-Type', 'text/plain').send('x')).status).toBe(415);
    expect((await request(srv()).post(`/api/tickets/${t.id}/cancel`)).status).toBe(415);
    expect((await request(srv()).delete(`/api/projects/${p.id}`)).status).toBe(415);
    expect((await request(srv()).post(`/api/tickets/${t.id}/cancel`).send({})).status).toBe(200);
  });
});

describe('#3 torn log line', () => {
  it('skips an unparseable (truncated) last line', () => {
    const dir = tmp();
    const log = new TicketLog(dir);
    const ticket = { id: 't1', projectId: 'p1', title: 'x', text: 'x', status: 'queued', stage: null, agentStates: {}, createdAt: '2026-01-01' };
    log.append({ type: 'ticket.created', ticket, projectId: 'p1', ticketId: 't1', seq: 1, ts: '' } as ServerEvent);
    log.append({ type: 'ticket.stage', stage: 'plan', roles: ['pm'], projectId: 'p1', ticketId: 't1', seq: 2, ts: '' } as ServerEvent);
    appendFileSync(join(dir, 'p1', 't1.jsonl'), '{"type":"agent.state","ro');
    expect(log.read('p1', 't1')).toHaveLength(2);
    const rec = new TicketLog(dir).recover();
    expect(rec[0]).toMatchObject({ id: 't1', status: 'failed', reason: 'interrupted' });
  });
});

describe('#4 a role removed during the plan gate is not summoned', () => {
  it('uses the live team when the plan is approved', async () => {
    await start();
    const msgs: ServerEvent[] = [];
    const p = (await add({ team: [...TEAM, 'writer'] })).body as Project;
    const t = (await request(srv()).post(`/api/projects/${p.id}/tickets`).send({ text: 'Add a login page' })).body;
    sched.flush();
    const r = await request(srv()).patch(`/api/projects/${p.id}`).send({ team: ['pm', 'techlead', 'backend', 'qa'] });
    expect(r.status).toBe(200);
    const ws = new WebSocket(wsUrl());
    await new Promise(res => ws.on('open', res));
    ws.on('message', d => msgs.push(JSON.parse(String(d))));
    await request(srv()).post(`/api/tickets/${t.id}/gates/plan`).send({ decision: 'approved' });
    sched.flush();
    await new Promise(res => setTimeout(res, 50));
    ws.close();
    const roles = new Set(msgs.flatMap((e: any) => e.type === 'agent.state' ? [e.role] : e.type === 'ticket.stage' ? e.roles : []));
    expect(roles.has('frontend')).toBe(false);
    expect(roles.has('writer')).toBe(false);
    expect(roles.has('backend')).toBe(true);
  });
});

describe('#5 error status', () => {
  it('malformed JSON is 400, a missing asset is 404', async () => {
    const assets = tmp();
    await start(assets);
    const r = await request(srv()).post('/api/projects').set('Content-Type', 'application/json').send('{"name":');
    expect(r.status).toBe(400);
    expect((await request(srv()).get('/assets/nope.png')).status).toBe(404);
  });
});

describe('#6 input validation', () => {
  it('strips surrounding quotes and stores the resolved absolute folder', async () => {
    await start();
    const folder = projectDir('quoted one');
    const r = await add({ folder: `"${folder}"` });
    expect(r.status).toBe(201);
    expect(r.body.folder).toBe(join(folder));
    expect(existsSync(join(folder, '.claude/agents/pm.md'))).toBe(true);
  });

  it('rejects a relative folder with 400', async () => {
    await start();
    const r = await add({ folder: 'some/relative/dir' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/absolute/i);
  });

  it('a non-string name is 400 on POST and PATCH', async () => {
    await start();
    expect((await add({ name: 42 })).status).toBe(400);
    const p = (await add()).body as Project;
    expect((await request(srv()).patch(`/api/projects/${p.id}`).send({ name: 42 })).status).toBe(400);
    expect((await request(srv()).patch(`/api/projects/${p.id}`).send({ team: 'pm' })).status).toBe(400);
  });

  it('an invalid gate decision is 400', async () => {
    await start();
    const p = (await add()).body as Project;
    const t = (await request(srv()).post(`/api/projects/${p.id}/tickets`).send({ text: 'x' })).body;
    sched.flush();
    const r = await request(srv()).post(`/api/tickets/${t.id}/gates/plan`).send({ decision: 'retry' });
    expect(r.status).toBe(400);
  });
});

describe('#11 restart', () => {
  it('marks a running ticket interrupted and starts the queued one', () => {
    const dir = tmp();
    const folder = projectDir();
    const p = new ProjectStore(join(dir, 'projects.json')).add({ name: 'Shop', folder, accent: 'cyan', team: TEAM });
    const log = new TicketLog(join(dir, 'projects'));
    const base = { projectId: p.id, ts: '' };
    const tk = (id: string, createdAt: string) => ({ id, projectId: p.id, title: id, text: id, status: 'queued', stage: null, agentStates: {}, createdAt });
    log.append({ ...base, type: 'ticket.created', ticket: tk('run', '2026-01-01T00:00:00Z'), ticketId: 'run', seq: 1 } as ServerEvent);
    log.append({ ...base, type: 'ticket.stage', stage: 'plan', roles: ['pm'], ticketId: 'run', seq: 2 } as ServerEvent);
    log.append({ ...base, type: 'agent.state', role: 'pm', state: 'planning', ticketId: 'run', seq: 3 } as ServerEvent);
    log.append({ ...base, type: 'ticket.created', ticket: tk('wait', '2026-01-01T00:01:00Z'), ticketId: 'wait', seq: 1 } as ServerEvent);

    const s = new ManualScheduler();
    const b = boot({ dataDir: dir, scheduler: s, stageMs: [100, 200], random: () => 0.99, forceMode: 'simulated' });
    try {
      const after = new TicketLog(join(dir, 'projects'));
      expect(after.read(p.id, 'run').at(-1)).toMatchObject({ type: 'ticket.failed', reason: 'interrupted' });
      expect(b.orchestrator.current(p.id)?.id).toBe('wait');
      const waitEvents = after.read(p.id, 'wait');
      expect(waitEvents.some(e => e.type === 'ticket.stage' && (e as any).stage === 'plan')).toBe(true);
      s.flush();
      expect(b.orchestrator.current(p.id)?.openGate).toBe('plan');
      const seqs = after.read(p.id, 'wait').map(e => (e as any).seq);
      expect(new Set(seqs).size).toBe(seqs.length);
    } finally { b.office.close(); }
  });
});
