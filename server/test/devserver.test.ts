import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DevServerState, Project, ServerEvent } from '@office/shared';
import { createOffice, type Office } from '../src/app';
import { SimulatedOrchestrator } from '../src/orchestrator/simulated';
import { TicketLog } from '../src/ticketLog';
import { DevServers, runTarget, urlsIn, stripAnsi } from '../src/devserver';
import { tmp, projectDir, ManualScheduler } from './helpers';

const until = async (ok: () => boolean, ms = 20000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise(r => setTimeout(r, 50));
  }
};

/** A folder whose `dev` script prints a Vite-like banner and keeps running. */
const appFolder = (scripts: Record<string, string> = {
  dev: 'node -e "console.log(\'  Local:   http://localhost:4321/\');console.log(\'  Network: http://192.168.1.5:4321/\');setInterval(()=>{},1000)"',
  build: 'node -e "console.log(1)"',
}) => {
  const d = projectDir('app');
  writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'app', scripts }));
  return d;
};

describe('dev server helpers', () => {
  it('finds local URLs (bind addresses become localhost) and strips ANSI', () => {
    expect(urlsIn('\x1b[32m➜\x1b[39m  Local:   \x1b[36mhttp://localhost:\x1b[1m5173\x1b[22m/\x1b[39m')).toEqual([{ url: 'http://localhost:5173/', local: true }]);
    expect(urlsIn('ready on http://0.0.0.0:3000.')).toEqual([{ url: 'http://localhost:3000', local: true }]);
    expect(urlsIn('Network: http://192.168.1.5:3000/')[0].local).toBe(false);
    expect(stripAnsi('\x1b[1mhi\x1b[22m')).toBe('hi');
  });

  it('picks dev, then start; null without package.json; looks into repos', () => {
    expect(runTarget({ folder: appFolder() })?.script).toBe('dev');
    expect(runTarget({ folder: appFolder({ start: 'x', build: 'y' }) })?.script).toBe('start');
    expect(runTarget({ folder: appFolder({ build: 'y' }) })?.script).toBeUndefined();
    const empty = projectDir('empty');
    expect(runTarget({ folder: empty })).toBeNull();
    const repo = appFolder();
    expect(runTarget({ folder: empty, repos: [{ name: 'web', path: repo }] })?.cwd).toBe(repo);
  });
});

describe('DevServers', () => {
  let ds: DevServers | undefined;
  afterEach(async () => { await ds?.shutdown(); ds = undefined; });

  it('starts npm run dev, reports the local URL, streams the log, stops the tree', async () => {
    ds = new DevServers({ graceMs: 500 });
    const events: ServerEvent[] = [];
    ds.onEvent(e => events.push(e));
    const s = ds.start({ id: 'p1', folder: appFolder() });
    expect(s).toMatchObject({ status: 'starting', script: 'dev' });
    expect(() => ds!.start({ id: 'p1', folder: appFolder() })).toThrow(/already running/);
    await until(() => ds!.state('p1').status === 'running');
    expect(ds.state('p1').url).toBe('http://localhost:4321/');
    await until(() => events.some(e => e.type === 'devserver.log' && e.lines.some(l => l.includes('Network'))));
    expect(ds.log('p1')[0]).toMatch(/^\$ npm run dev/);
    ds.stop('p1');
    await until(() => ds!.state('p1').status === 'stopped');
    expect(events.filter(e => e.type === 'devserver.updated').map(e => (e as { state: DevServerState }).state.status))
      .toEqual(['starting', 'running', 'stopped']);
  }, 30000);

  it('a script that ends is exited with its code; unknown / missing scripts are refused', async () => {
    ds = new DevServers();
    const folder = appFolder({ dev: 'node -e "console.log(\'boom\');process.exit(3)"' });
    ds.start({ id: 'p2', folder });
    await until(() => ds!.state('p2').status === 'exited');
    expect(ds.state('p2')).toMatchObject({ exitCode: 3, error: expect.stringMatching(/code 3/) });
    expect(ds.log('p2')).toContain('boom');
    expect(() => ds!.start({ id: 'p3', folder }, 'nope')).toThrow(/no "nope" script/);
    expect(() => ds!.start({ id: 'p4', folder: appFolder({ build: 'x' }) })).toThrow(/no dev \/ start/);
    expect(() => ds!.start({ id: 'p5', folder: projectDir('none') })).toThrow(/No package.json/);
  }, 30000);
});

describe('npm install', () => {
  it('install: true runs npm install in the folder and ends by itself', async () => {
    const ds = new DevServers();
    const s = ds.start({ id: 'i1', folder: appFolder() }, undefined, true);
    expect(s).toMatchObject({ status: 'starting', script: 'install' });
    await until(() => ds.state('i1').status === 'exited', 60000);
    expect(ds.state('i1').exitCode).toBe(0);
    expect(ds.log('i1')[0]).toMatch(/^\$ npm install/);
  }, 70000);
});

describe('dev server API', () => {
  let office: Office | undefined;
  afterEach(async () => { await office?.devServers.shutdown(); office?.close(); office = undefined; });

  it('GET / start / stop; 409 twice; snapshot lists it; delete project stops it', async () => {
    const dataDir = tmp();
    const log = new TicketLog(join(dataDir, 'projects'));
    office = createOffice({ dataDir, log, orchestrator: new SimulatedOrchestrator({ log, scheduler: new ManualScheduler() }), devServers: new DevServers({ graceMs: 500 }) });
    const folder = appFolder();
    const p = (await request(office.server).post('/api/projects').send({ name: 'Folio', folder, accent: 'cyan', team: ['pm', 'frontend'] })).body as Project;
    const get = await request(office.server).get(`/api/projects/${p.id}/devserver`);
    expect(get.body).toMatchObject({ state: { status: 'idle' }, scripts: ['dev', 'build'], defaultScript: 'dev', log: [] });

    const start = await request(office.server).post(`/api/projects/${p.id}/devserver/start`).send({});
    expect(start.status).toBe(200);
    expect(start.body.status).toBe('starting');
    expect((await request(office.server).post(`/api/projects/${p.id}/devserver/start`).send({})).status).toBe(409);
    await until(() => office!.devServers.state(p.id).status === 'running');

    const stop = await request(office.server).post(`/api/projects/${p.id}/devserver/stop`).send({});
    expect(stop.status).toBe(200);
    await until(() => office!.devServers.state(p.id).status === 'stopped');

    await request(office.server).post(`/api/projects/${p.id}/devserver/start`).send({ script: 'dev' });
    await until(() => office!.devServers.state(p.id).status === 'running');
    const live = office.devServers;
    await request(office.server).delete(`/api/projects/${p.id}`).send({});
    expect(live.state(p.id).status).toBe('idle');
    expect((await request(office.server).post(`/api/projects/${p.id}/devserver/start`).send({})).status).toBe(404);
  }, 40000);
});
