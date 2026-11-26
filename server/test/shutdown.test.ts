import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Project, RoleId } from '@office/shared';
import { ClaudeOrchestrator } from '../src/orchestrator/claude';
import { ClaudeRunner, killLiveSync, livePids } from '../src/claude/runner';
import { TicketLog } from '../src/ticketLog';

{
  const cfg = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'po-gitcfg-')), 'gitconfig');
  fs.writeFileSync(cfg, '');
  process.env.GIT_CONFIG_GLOBAL = cfg;
  process.env.GIT_CONFIG_NOSYSTEM = '1';
}
const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(here, 'fixtures', 'fake-claude.mjs');
const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const hbs: string[] = [];
afterEach(() => {
  for (const hb of hbs.splice(0)) { try { process.kill(Number(fs.readFileSync(hb + '.pid', 'utf8'))); } catch { /* dead */ } }
});

function mkRepo(): string {
  const d = tmp('po-repo-');
  fs.writeFileSync(path.join(d, 'a.txt'), 'a\n');
  const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@t', ...a], { cwd: d });
  git('init', '-q', '-b', 'main'); git('add', '-A'); git('commit', '-q', '-m', 'init');
  return d;
}
const project = (folder: string): Project =>
  ({ id: 'p1', name: 'Shop', folder, accent: 'cyan', team: ['pm', 'frontend'] as RoleId[], slot: 0, looks: {} as any, createdAt: '' });

async function hangingBeat(): Promise<string> {
  const hb = path.join(tmp('hb-'), 'beat');
  hbs.push(hb);
  return hb;
}
async function waitFor(cond: () => boolean, ms = 8000) {
  for (let t = 0; t < ms && !cond(); t += 50) await sleep(50);
  expect(cond()).toBe(true);
}
async function beatStopped(hb: string) {
  await sleep(300);
  const b1 = fs.readFileSync(hb, 'utf8');
  await sleep(500);
  expect(fs.readFileSync(hb, 'utf8')).toBe(b1);
}

describe('shutdown', () => {
  it('ClaudeOrchestrator.shutdown aborts an in-flight run and the claude process tree is gone', async () => {
    const hb = await hangingBeat();
    const runner = new ClaudeRunner({ bin: process.execPath, binArgs: [FAKE, 'hang', hb], killGraceMs: 300 });
    const o = new ClaudeOrchestrator({ log: new TicketLog(path.join(tmp('po-data-'), 'tickets')), runner, dataDir: tmp('po-data-') });
    const t = o.startTicket(project(mkRepo()), 'Add a link');
    await waitFor(() => fs.existsSync(hb) && livePids().length === 1);
    const [pid] = livePids();
    await o.shutdown();
    expect(livePids()).toEqual([]);
    expect(alive(pid)).toBe(false);
    await beatStopped(hb);
    // the ticket is left as it was (recovery on the next boot marks it interrupted), not failed by the abort
    expect(o.find(t.id)!.status).not.toBe('failed');
  }, 20000);

  it('killLiveSync kills still-running children synchronously', async () => {
    const hb = await hangingBeat();
    const runner = new ClaudeRunner({ bin: process.execPath, binArgs: [FAKE, 'hang', hb], killGraceMs: 300 });
    const p = runner.run({ cwd: os.tmpdir(), role: 'pm', prompt: 'hi', allowedTools: [], maxTurns: 1, onEvent: () => {} });
    p.catch(() => {});
    await waitFor(() => fs.existsSync(hb) && livePids().length === 1);
    const [pid] = livePids();
    killLiveSync();
    expect(alive(pid)).toBe(false);
    await beatStopped(hb);
    await p.then(() => null, () => null);
    expect(livePids()).toEqual([]);
  }, 20000);
});
