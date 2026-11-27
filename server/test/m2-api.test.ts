import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import { join } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import type { Project, Ticket } from '@office/shared';
import { createOffice, type Office } from '../src/app';
import { boot } from '../src/boot';
import { SimulatedOrchestrator } from '../src/orchestrator/simulated';
import { RoutingOrchestrator } from '../src/orchestrator/routing';
import type { Orchestrator } from '../src/orchestrator/types';
import { ClaudeSystem, parseAuthStatus, type Exec } from '../src/claude/system';
import { TicketLog } from '../src/ticketLog';
import type { RunOptions, RunResult } from '../src/claude/runner';
import { tmp, projectDir, ManualScheduler } from './helpers';

const TEAM = ['pm', 'techlead', 'frontend', 'backend', 'qa'];
let office: Office | undefined;
afterEach(() => { office?.close(); office = undefined; });

/** A runner that never finishes (keeps a claude ticket running) — no real CLI. */
const hangingRunner = { calls: [] as RunOptions[], run(o: RunOptions): Promise<RunResult> { this.calls.push(o); return new Promise(() => undefined); } };

function bootFake(extra: Partial<Parameters<typeof boot>[0]> = {}) {
  const dataDir = tmp();
  const sched = new ManualScheduler();
  const b = boot({ dataDir, scheduler: sched, stageMs: [100, 200], random: () => 0.99, runner: hangingRunner, ...extra });
  office = b.office;
  return { ...b, sched, dataDir };
}
const add = (o: Office, body: Record<string, unknown> = {}) =>
  request(o.server).post('/api/projects').send({ name: 'Shop', folder: projectDir(), accent: 'cyan', team: TEAM, ...body });

describe('agents mode + routing', () => {
  it('new projects default to claude; agentsMode validated', async () => {
    const { office: o } = bootFake();
    expect((await add(o)).body.agentsMode).toBe('claude');
    expect((await add(o, { agentsMode: 'simulated' })).body.agentsMode).toBe('simulated');
    expect((await add(o, { agentsMode: 'robots' })).status).toBe(400);
  });

  it('a simulated project runs on the simulated orchestrator; a claude project on claude', async () => {
    const b = bootFake();
    const sim = (await add(b.office, { agentsMode: 'simulated' })).body as Project;
    const cl = (await add(b.office)).body as Project;
    const st = (await request(b.office.server).post(`/api/projects/${sim.id}/tickets`).send({ text: 'Sim ticket' })).body as Ticket;
    const ct = (await request(b.office.server).post(`/api/projects/${cl.id}/tickets`).send({ text: 'Real ticket' })).body as Ticket;
    expect(st.agentsMode).toBe('simulated');
    expect(ct.agentsMode).toBe('claude');
    expect(b.simulated.find(st.id)).toBeTruthy();
    expect(b.claude.find(ct.id)).toBeTruthy();
    b.sched.flush();
    expect(b.orchestrator.find(st.id)!.openGate).toBe('plan'); // simulated still works end-to-end to its gate
  });

  it('PATCH agentsMode → 409 while a ticket is running; ok when idle', async () => {
    const b = bootFake();
    const p = (await add(b.office, { agentsMode: 'simulated' })).body as Project;
    expect((await request(b.office.server).patch(`/api/projects/${p.id}`).send({ agentsMode: 'claude' })).body.agentsMode).toBe('claude');
    await request(b.office.server).patch(`/api/projects/${p.id}`).send({ agentsMode: 'simulated' });
    const t = (await request(b.office.server).post(`/api/projects/${p.id}/tickets`).send({ text: 'x' })).body as Ticket;
    const r = await request(b.office.server).patch(`/api/projects/${p.id}`).send({ agentsMode: 'claude' });
    expect(r.status).toBe(409);
    await request(b.office.server).post(`/api/tickets/${t.id}/cancel`).send({});
    expect((await request(b.office.server).patch(`/api/projects/${p.id}`).send({ agentsMode: 'claude' })).status).toBe(200);
  });

  it('PATCH model: validated, saved, even while a ticket runs (applies to the next run)', async () => {
    const b = bootFake();
    const p = (await add(b.office, { agentsMode: 'simulated' })).body as Project;
    expect(p.model).toBeUndefined();
    expect((await request(b.office.server).patch(`/api/projects/${p.id}`).send({ model: 'gpt-4' })).status).toBe(400);
    await request(b.office.server).post(`/api/projects/${p.id}/tickets`).send({ text: 'x' });
    const r = await request(b.office.server).patch(`/api/projects/${p.id}`).send({ model: 'sonnet' });
    expect(r.status).toBe(200);
    expect(r.body.model).toBe('sonnet');
    expect(b.office.store.get(p.id)!.model).toBe('sonnet');
    expect((await request(b.office.server).patch(`/api/projects/${p.id}`).send({ model: 'default' })).body.model).toBe('default');
  });

  it('projects saved before agentsMode existed are treated as claude', async () => {
    const dataDir = tmp();
    const { ProjectStore } = await import('../src/store');
    const s = new ProjectStore(join(dataDir, 'projects.json'));
    const p = s.add({ name: 'Old', folder: projectDir(), accent: 'cyan', team: ['pm'] });
    const fs = await import('node:fs');
    const raw = JSON.parse(fs.readFileSync(join(dataDir, 'projects.json'), 'utf8'));
    delete raw.projects[0].agentsMode;
    fs.writeFileSync(join(dataDir, 'projects.json'), JSON.stringify(raw));
    expect(new ProjectStore(join(dataDir, 'projects.json')).get(p.id)!.agentsMode).toBe('claude');
  });

  it('recovered tickets without agentsMode (pre-M2) stay simulated; claude Resume refuses them', async () => {
    const dataDir = tmp();
    const { ProjectStore } = await import('../src/store');
    const p = new ProjectStore(join(dataDir, 'projects.json')).add({ name: 'Shop', folder: projectDir(), accent: 'cyan', team: ['pm', 'frontend'] });
    expect(p.agentsMode).toBe('claude');
    const log = new TicketLog(join(dataDir, 'projects'));
    const base = { projectId: p.id, ts: '' };
    const tk = (id: string) => ({ id, projectId: p.id, title: id, text: id, status: 'queued', stage: null, agentStates: {}, createdAt: '2026-01-01T00:00:00Z' });
    log.append({ ...base, type: 'ticket.created', ticket: tk('old-run'), ticketId: 'old-run', seq: 1 } as any);
    log.append({ ...base, type: 'ticket.stage', stage: 'build', roles: ['frontend'], ticketId: 'old-run', seq: 2 } as any);
    log.append({ ...base, type: 'ticket.created', ticket: tk('old-wait'), ticketId: 'old-wait', seq: 1 } as any);
    const runner = { calls: 0, run() { this.calls++; return new Promise<RunResult>(() => undefined); } };
    const b = boot({ dataDir, scheduler: new ManualScheduler(), stageMs: [100, 200], random: () => 0.99, runner });
    office = b.office;
    expect(b.simulated.find('old-wait')).toBeTruthy();
    expect(b.claude.find('old-wait')).toBeUndefined();
    const r = await request(b.office.server).post('/api/tickets/old-run/resume').send({});
    expect(r.status).toBe(409);
    expect(runner.calls).toBe(0);
  });

  it('RoutingOrchestrator sends ticket calls to the owner', () => {
    const calls: string[] = [];
    const stub = (name: string, owns: string): Orchestrator => ({
      startTicket: () => { calls.push(`${name}.start`); return {} as Ticket; }, resume: () => { calls.push(`${name}.resume`); return {} as Ticket; },
      adopt: () => calls.push(`${name}.adopt`), decide: () => calls.push(`${name}.decide`), sendMessage: () => calls.push(`${name}.msg`),
      cancel: () => calls.push(`${name}.cancel`), current: () => undefined, queue: () => [],
      find: id => id === owns ? ({ id } as Ticket) : undefined, onEvent: () => undefined, busyRoles: () => [],
    });
    const r = new RoutingOrchestrator({ claude: stub('c', 'tc'), simulated: stub('s', 'ts') });
    r.startTicket({ agentsMode: 'simulated' } as Project, 'x');
    r.startTicket({} as Project, 'x');
    r.sendMessage('ts', 'hi'); r.cancel('tc'); r.resume('tc');
    expect(calls).toEqual(['s.start', 'c.start', 's.msg', 'c.cancel', 'c.resume']);
    expect(() => r.decide('nope', 'plan', 'approved')).toThrow(/Unknown ticket/);
  });
});

describe('follow-ups + resume REST', () => {
  it('POST tickets with parentTicketId → follow-up; unknown parent → 404', async () => {
    const b = bootFake();
    const p = (await add(b.office, { agentsMode: 'simulated' })).body as Project;
    const t1 = (await request(b.office.server).post(`/api/projects/${p.id}/tickets`).send({ text: 'first' })).body as Ticket;
    const t2 = await request(b.office.server).post(`/api/projects/${p.id}/tickets`).send({ text: 'again', parentTicketId: t1.id });
    expect(t2.status).toBe(201);
    expect(t2.body.parentTicketId).toBe(t1.id);
    expect((await request(b.office.server).post(`/api/projects/${p.id}/tickets`).send({ text: 'x', parentTicketId: 'nope' })).status).toBe(404);
  });

  it('POST tickets takes mode (default auto, validated); a simulated ask is answered and done', async () => {
    const b = bootFake();
    const p = (await add(b.office, { agentsMode: 'simulated' })).body as Project;
    const post = (body: Record<string, unknown>) => request(b.office.server).post(`/api/projects/${p.id}/tickets`).send(body);
    expect((await post({ text: 'x', mode: 'chat' })).status).toBe(400);
    expect((await post({ text: 'x', mode: 3 })).status).toBe(400);
    const a = (await post({ text: 'first' })).body as Ticket;
    expect(a.mode).toBe('auto');
    await request(b.office.server).post(`/api/tickets/${a.id}/cancel`).send({});
    const q = (await post({ text: 'what is here?', mode: 'ask' })).body as Ticket;
    expect(q.mode).toBe('ask');
    b.sched.flush();
    expect(b.orchestrator.find(q.id)).toMatchObject({ status: 'done', answered: true });
    const t = (await post({ text: 'do it', mode: 'ticket', parentTicketId: q.id })).body as Ticket;
    expect(t).toMatchObject({ mode: 'ticket', parentTicketId: q.id });
  });

  it('POST /api/tickets/:id/resume → 409 for simulated or non-failed, 404 unknown', async () => {
    const b = bootFake();
    const p = (await add(b.office, { agentsMode: 'simulated' })).body as Project;
    const t = (await request(b.office.server).post(`/api/projects/${p.id}/tickets`).send({ text: 'x' })).body as Ticket;
    expect((await request(b.office.server).post(`/api/tickets/${t.id}/resume`).send({})).status).toBe(409);
    expect((await request(b.office.server).post('/api/tickets/nope/resume').send({})).status).toBe(404);
  });
});

describe('git-init + system', () => {
  type G = { isRepo: (d: string) => Promise<boolean>; hasCommit?: (d: string) => Promise<boolean>; gitInit: (d: string) => Promise<void> };
  const mk = (g: G, exec?: Exec) => {
    const git = { hasCommit: async () => true, ...g };
    const dataDir = tmp();
    const log = new TicketLog(join(dataDir, 'projects'));
    const orchestrator = new SimulatedOrchestrator({ log, scheduler: new ManualScheduler() });
    office = createOffice({ dataDir, orchestrator, log, git, claudeSystem: exec ? new ClaudeSystem(exec) : undefined });
    return office;
  };

  it('git-init runs gitInit only on request; 409 when already a repo', async () => {
    const inits: string[] = [];
    let repo = false;
    const o = mk({ isRepo: async () => repo, gitInit: async d => { inits.push(d); } });
    const p = (await add(o)).body as Project;
    expect(inits).toEqual([]);
    const r = await request(o.server).post(`/api/projects/${p.id}/git-init`).send({});
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true });
    expect(typeof r.body.message).toBe('string');
    expect(inits).toEqual([p.folder]);
    repo = true;
    expect((await request(o.server).post(`/api/projects/${p.id}/git-init`).send({})).status).toBe(409);
    expect(inits).toHaveLength(1);
  });

  it('git-init on a repo with no commits runs gitInit (initial commit), not 409', async () => {
    const inits: string[] = [];
    const o = mk({ isRepo: async () => true, hasCommit: async () => false, gitInit: async d => { inits.push(d); } });
    const p = (await add(o)).body as Project;
    const r = await request(o.server).post(`/api/projects/${p.id}/git-init`).send({});
    expect(r.status).toBe(200);
    expect(inits).toEqual([p.folder]);
  });

  it('origin/JSON guards apply to the new routes', async () => {
    const inits: string[] = [];
    const o = mk({ isRepo: async () => false, gitInit: async d => { inits.push(d); } }, async () => ({ code: 0, stdout: '' }));
    const p = (await add(o)).body as Project;
    expect((await request(o.server).post(`/api/projects/${p.id}/git-init`).set('Origin', 'http://evil.example').send({})).status).toBe(403);
    expect((await request(o.server).post(`/api/projects/${p.id}/git-init`).set('Content-Type', 'text/plain').send('x')).status).toBe(415);
    expect((await request(o.server).post('/api/tickets/x/resume').set('Content-Type', 'text/plain').send('x')).status).toBe(415);
    expect((await request(o.server).get('/api/system/claude').set('Origin', 'http://evil.example')).status).toBe(403);
    expect(inits).toEqual([]);
  });

  /** Real `claude auth status --text` output from the owner's machine (organization/email redacted). */
  const AUTH = readFileSync(new URL('./fixtures/auth-status.txt', import.meta.url), 'utf8');

  it('GET /api/system/claude → shape without email/organization; cached 60 s', async () => {
    const calls: string[][] = [];
    const exec: Exec = async args => { calls.push(args); return args[0] === '--version' ? { code: 0, stdout: '2.1.332 (Claude Code)\n' } : { code: 0, stdout: AUTH }; };
    const o = mk({ isRepo: async () => true, gitInit: async () => undefined }, exec);
    const r = await request(o.server).get('/api/system/claude');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ found: true, version: '2.1.332', loggedIn: true, accountType: 'Claude Ultra account', signInEndsAt: '2026-12-20T08:54:14.645Z' });
    expect(JSON.stringify(r.body)).not.toMatch(/example\.com|Example Org|redacted|email|organization/i);
    await request(o.server).get('/api/system/claude');
    expect(calls).toEqual([['--version'], ['auth', 'status', '--text']]);
  });

  it('ClaudeSystem: not found, logged out, cache expiry', async () => {
    expect(await new ClaudeSystem(async () => ({ code: -1, stdout: '' })).status())
      .toEqual({ found: false, version: null, loggedIn: false, accountType: null, signInEndsAt: null });
    const out = await new ClaudeSystem(async a => a[0] === '--version' ? { code: 0, stdout: '2.0.0' } : { code: 1, stdout: 'Not logged in. Run claude and /login' }).status();
    expect(out).toMatchObject({ found: true, version: '2.0.0', loggedIn: false, accountType: null });
    let t = 0, n = 0;
    const s = new ClaudeSystem(async () => { n++; return { code: 0, stdout: '1.0.0' }; }, 60_000, () => t);
    await s.status(); t = 59_999; await s.status();
    expect(n).toBe(2);
    t = 60_000; await s.status();
    expect(n).toBe(4);
    expect(parseAuthStatus('Not logged in').loggedIn).toBe(false);
    expect(parseAuthStatus('Login method: user@example.com').accountType).toBeNull();
    expect(parseAuthStatus(AUTH)).toEqual({ loggedIn: true, accountType: 'Claude Ultra account', signInEndsAt: '2026-12-20T08:54:14.645Z' });
    expect(parseAuthStatus('Organization: X\nEmail: a@b.c').loggedIn).toBe(false);
  });
});

describe('multi-repo detection (API)', () => {
  {
    const cfg = join(tmp(), 'gitconfig');
    writeFileSync(cfg, '');
    process.env.GIT_CONFIG_GLOBAL = cfg;
    process.env.GIT_CONFIG_NOSYSTEM = '1';
  }
  const mkSub = (parent: string, name: string) => {
    const d = join(parent, name);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'a.txt'), 'a');
    const g = (...a: string[]) => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], { cwd: d });
    g('init', '-q'); g('add', '-A'); g('commit', '-q', '-m', 'init');
  };

  it('add stores repos (sorted) + gitKind; update re-detects', async () => {
    const { office: o } = bootFake();
    const folder = projectDir();
    mkSub(folder, 'aspnet-core'); mkSub(folder, 'angular');
    const r = await add(o, { folder });
    expect(r.status).toBe(201);
    expect(r.body.gitKind).toBe('multi');
    expect(r.body.repos).toEqual([{ name: 'angular', path: join(folder, 'angular') }, { name: 'aspnet-core', path: join(folder, 'aspnet-core') }]);
    mkSub(folder, 'mobile');
    const u = await request(o.server).patch(`/api/projects/${r.body.id}`).send({ name: 'HRMS' });
    expect(u.body.repos.map((x: { name: string }) => x.name)).toEqual(['angular', 'aspnet-core', 'mobile']);
    expect((await request(o.server).get('/api/projects')).body[0].repos).toHaveLength(3);
    const plain = await add(o);
    expect(plain.body.gitKind).toBe('none');
    expect(plain.body.repos).toBeUndefined();
  });

  it('ticket start re-detects repos and updates the stored project', async () => {
    const { office: o, claude } = bootFake();
    const folder = projectDir();
    const p = (await add(o, { folder })).body as Project;
    expect(p.gitKind).toBe('none');
    mkSub(folder, 'angular');
    await request(o.server).post(`/api/projects/${p.id}/tickets`).send({ text: 'x' });
    const deadline = Date.now() + 5000;
    while (!o.store.get(p.id)!.repos && Date.now() < deadline) await new Promise(r => setTimeout(r, 10));
    expect(o.store.get(p.id)!.gitKind).toBe('multi');
    expect(o.store.get(p.id)!.repos!.map(r => r.name)).toEqual(['angular']);
    await claude.shutdown(10);
  });

  it('git-init is refused (409) for a parent whose sub-repos have no commits yet', async () => {
    const inits: string[] = [];
    const dataDir = tmp();
    const log = new TicketLog(join(dataDir, 'projects'));
    const orchestrator = new SimulatedOrchestrator({ log, scheduler: new ManualScheduler() });
    const folder = projectDir();
    mkdirSync(join(folder, 'angular'));
    execFileSync('git', ['init', '-q'], { cwd: join(folder, 'angular') });
    office = createOffice({ dataDir, orchestrator, log, git: { isRepo: async () => false, hasCommit: async () => false, gitInit: async d => { inits.push(d); } } });
    const p = (await add(office, { folder })).body as Project;
    const r = await request(office.server).post(`/api/projects/${p.id}/git-init`).send({});
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/angular/);
    expect(inits).toEqual([]);
  });

  it('git-init is refused (409) for a parent of repos and never runs', async () => {
    const inits: string[] = [];
    const dataDir = tmp();
    const log = new TicketLog(join(dataDir, 'projects'));
    const orchestrator = new SimulatedOrchestrator({ log, scheduler: new ManualScheduler() });
    const folder = projectDir();
    mkSub(folder, 'angular');
    office = createOffice({ dataDir, orchestrator, log, git: { isRepo: async () => false, hasCommit: async () => false, gitInit: async d => { inits.push(d); } } });
    const p = (await add(office, { folder })).body as Project;
    expect(p.gitKind).toBe('multi');
    const r = await request(office.server).post(`/api/projects/${p.id}/git-init`).send({});
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/angular/);
    expect(inits).toEqual([]);
  });
});
