import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import WebSocket from 'ws';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { MemoryEntry, Project, ServerEvent } from '@office/shared';
import { createOffice, type Office } from '../src/app';
import { SimulatedOrchestrator } from '../src/orchestrator/simulated';
import { TicketLog } from '../src/ticketLog';
import { boot as bootServer } from '../src/boot';
import type { RunOptions, RunResult } from '../src/claude/runner';
import { tmp, projectDir, ManualScheduler } from './helpers';

let office: Office;
let log: TicketLog;
let dataDir: string;
const boot = async () => {
  dataDir = tmp();
  log = new TicketLog(join(dataDir, 'projects'));
  const orchestrator = new SimulatedOrchestrator({ log, scheduler: new ManualScheduler(), random: () => 0.99, stageMs: [100, 200] });
  office = createOffice({ dataDir, orchestrator, log });
  await new Promise<void>(r => office.server.listen(0, '127.0.0.1', () => r()));
  return office;
};
const connect = () => new Promise<{ ws: WebSocket; msgs: ServerEvent[] }>(resolve => {
  const ws = new WebSocket(`ws://127.0.0.1:${(office.server.address() as AddressInfo).port}/ws`); const msgs: ServerEvent[] = [];
  ws.on('message', d => { msgs.push(JSON.parse(String(d))); if (msgs.length === 1) resolve({ ws, msgs }); });
});
const settle = () => new Promise(r => setTimeout(r, 50));
const addProject = async (name = 'Shop', folder = projectDir()) =>
  (await request(office.server).post('/api/projects').send({ name, folder, accent: 'cyan', team: ['pm', 'techlead', 'frontend', 'backend', 'qa'] })).body as Project;

afterEach(() => office?.close());

describe('team memory API', () => {
  it('GET / POST / PATCH / DELETE entries; memory.updated broadcast; file under dataDir, never the repo', async () => {
    await boot();
    const folder = projectDir();
    const p = await addProject('Shop', folder);
    const { ws, msgs } = await connect();
    const base = `/api/projects/${p.id}/memory`;
    expect((await request(office.server).get(base)).body).toEqual({ entries: [] });

    const r = await request(office.server).post(base).send({ text: 'Run tests with npm test -w server' });
    expect(r.status).toBe(201);
    const e = r.body as MemoryEntry;
    expect(e).toMatchObject({ text: 'Run tests with npm test -w server', source: 'owner' });

    const u = await request(office.server).patch(`${base}/${e.id}`).send({ text: 'Run tests with vitest' });
    expect(u.status).toBe(200);
    expect(u.body).toMatchObject({ id: e.id, text: 'Run tests with vitest' });
    expect((await request(office.server).get(base)).body.entries.map((x: MemoryEntry) => x.text)).toEqual(['Run tests with vitest']);

    expect((await request(office.server).delete(`${base}/${e.id}`).send({})).body).toEqual({ ok: true });
    expect((await request(office.server).get(base)).body).toEqual({ entries: [] });

    await settle();
    const updates = msgs.filter(m => m.type === 'memory.updated');
    expect(updates).toHaveLength(3);
    expect(updates[0]).toMatchObject({ projectId: p.id });
    expect(typeof updates[0].ts).toBe('string');
    ws.close();

    expect(existsSync(join(dataDir, 'memory', `${p.id}.json`))).toBe(true);
    expect(readdirSync(join(folder, '.claude')).filter(f => /memory/i.test(f))).toEqual([]);
  });

  it('errors: 400 for bad text, 404 for an unknown project or entry', async () => {
    await boot();
    const p = await addProject();
    const base = `/api/projects/${p.id}/memory`;
    expect((await request(office.server).post(base).send({})).status).toBe(400);
    expect((await request(office.server).post(base).send({ text: 'x'.repeat(301) })).status).toBe(400);
    expect((await request(office.server).get('/api/projects/nope/memory')).status).toBe(404);
    expect((await request(office.server).post('/api/projects/nope/memory').send({ text: 'a' })).status).toBe(404);
    expect((await request(office.server).patch(`${base}/nope`).send({ text: 'a' })).status).toBe(404);
    expect((await request(office.server).delete(`${base}/nope`).send({})).status).toBe(404);
  });

  it('removing the project removes its memory', async () => {
    await boot();
    const p = await addProject();
    await request(office.server).post(`/api/projects/${p.id}/memory`).send({ text: 'A fact' });
    await request(office.server).delete(`/api/projects/${p.id}`).send({});
    expect(existsSync(join(dataDir, 'memory', `${p.id}.json`))).toBe(false);
  });

  it('booted server: the PM\'s answer lessons reach the memory API and the clients (memory.updated); the prompt carries memory', async () => {
    const prompts: string[] = [];
    const answer = { kind: 'answer', answer: 'Two buttons.', memory: ['Leave lives in src/leave'] };
    const runner = {
      run(o: RunOptions): Promise<RunResult> {
        prompts.push(o.prompt);
        o.onEvent({ kind: 'init', sessionId: 's1', model: 'm' });
        const result = '```json\n' + JSON.stringify(answer) + '\n```';
        return Promise.resolve({ sessionId: 's1', result, isError: false, subtype: 'success', numTurns: 1, costUsd: 0.01, durationMs: 5, exitCode: 0 });
      },
    };
    const b = bootServer({ dataDir: tmp(), runner });
    office = b.office;
    await new Promise<void>(r => office.server.listen(0, '127.0.0.1', () => r()));
    const p = await addProject();
    await request(office.server).post(`/api/projects/${p.id}/memory`).send({ text: 'Owner fact' });
    const { ws, msgs } = await connect();
    await request(office.server).post(`/api/projects/${p.id}/tickets`).send({ text: 'Which buttons?', mode: 'ask' });
    await b.claude.idle();
    await settle();
    expect(prompts[0]).toContain('<team-memory>\n- Owner fact\n</team-memory>');
    const entries = (await request(office.server).get(`/api/projects/${p.id}/memory`)).body.entries as MemoryEntry[];
    expect(entries.map(e => [e.text, e.source])).toEqual([['Owner fact', 'owner'], ['Leave lives in src/leave', 'pm']]);
    const types = msgs.map(m => m.type);
    expect(types).toContain('memory.updated');
    expect(types.indexOf('memory.updated')).toBeGreaterThan(types.indexOf('ticket.done'));
    ws.close();
  });

  it('memory routes sit behind the request guards (foreign origin refused)', async () => {
    await boot();
    const p = await addProject();
    const r = await request(office.server).post(`/api/projects/${p.id}/memory`).set('Origin', 'http://evil.example').send({ text: 'x' });
    expect(r.status).toBe(403);
  });
});
