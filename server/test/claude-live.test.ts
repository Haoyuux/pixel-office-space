import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { Project, RoleId, ServerEvent } from '@office/shared';
import { ClaudeOrchestrator } from '../src/orchestrator/claude';
import { ClaudeRunner } from '../src/claude/runner';
import { scaffoldAgents } from '../src/scaffold';
import { TicketLog } from '../src/ticketLog';

const LIVE = process.env.OFFICE_LIVE === '1';
const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));

// Opt-in: runs the REAL claude CLI (uses your Claude subscription). OFFICE_LIVE=1 npx vitest run test/claude-live.test.ts
describe.skipIf(!LIVE)('live claude ticket (OFFICE_LIVE=1)', () => {
  it('adds multiply end to end', async () => {
    const cfg = path.join(tmp('po-livecfg-'), 'gitconfig');
    fs.writeFileSync(cfg, '');
    process.env.GIT_CONFIG_GLOBAL = cfg;
    process.env.GIT_CONFIG_NOSYSTEM = '1';
    const git = (cwd: string, ...a: string[]) =>
      execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], { cwd, encoding: 'utf8' }).trim();

    const repo = tmp('po-live-repo-');
    fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'live', version: '1.0.0', scripts: { test: 'node --test' } }, null, 2));
    fs.writeFileSync(path.join(repo, 'sum.js'), 'function sum(a, b) { return a + b; }\nmodule.exports = { sum };\n');
    fs.writeFileSync(path.join(repo, 'sum.test.js'),
      "const test = require('node:test');\nconst assert = require('node:assert');\nconst { sum } = require('./sum');\ntest('sum', () => { assert.strictEqual(sum(1, 2), 3); });\n");
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'init');

    const team: RoleId[] = ['pm', 'backend', 'qa'];
    scaffoldAgents(repo, team);
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'agents');
    const project: Project = { id: 'live', name: 'Live', folder: repo, accent: 'cyan', team, slot: 0, looks: {} as any, createdAt: '' };
    const dataDir = tmp('po-live-data-');
    const orch = new ClaudeOrchestrator({ log: new TicketLog(path.join(dataDir, 'tickets')), runner: new ClaudeRunner(), dataDir });

    let usage: { turns: number; costUsd: number; durationMs: number } | undefined;
    let done = false;
    let failed: string | undefined;
    orch.onEvent((e: ServerEvent) => {
      if (e.type === 'gate.open') {
        const decision = e.gate === 'stuck' ? 'accept' : 'approved';
        setTimeout(() => orch.decide(e.ticketId, e.gate, decision), 50);
      }
      if (e.type === 'ticket.usage') usage = { turns: e.turns, costUsd: e.costUsd, durationMs: e.durationMs };
      if (e.type === 'ticket.done') done = true;
      if (e.type === 'ticket.failed') failed = e.reason;
      if (e.type === 'agent.tool' || e.type === 'ticket.stage') console.log('LIVE', e.type, (e as any).stage ?? (e as any).summary);
    });

    orch.startTicket(project, 'Add a multiply(a, b) function to sum.js next to sum, exported, with a test in sum.test.js.');
    await orch.idle();

    console.log('LIVE usage', JSON.stringify(usage), 'failed:', failed);
    expect(done).toBe(true);
    expect(git(repo, 'branch', '--show-current')).toBe('main');
    expect(fs.readFileSync(path.join(repo, 'sum.js'), 'utf8')).toMatch(/multiply/);
    expect(fs.readFileSync(path.join(repo, 'sum.test.js'), 'utf8')).toMatch(/multiply/);
    execFileSync('npm', ['test'], { cwd: repo, stdio: 'pipe', shell: true });
  }, 15 * 60_000);
});
