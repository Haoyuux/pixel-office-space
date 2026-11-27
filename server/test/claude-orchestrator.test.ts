import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { Project, RoleId, ServerEvent } from '@office/shared';
import { ClaudeOrchestrator, NOT_A_GIT_REPO, type GitApi, workspacePath } from '../src/orchestrator/claude';
import * as realGit from '../src/claude/git';
import type { RunOptions, RunResult } from '../src/claude/runner';
import { TicketLog } from '../src/ticketLog';

{
  const cfg = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'po-gitcfg-')), 'gitconfig');
  fs.writeFileSync(cfg, '');
  process.env.GIT_CONFIG_GLOBAL = cfg;
  process.env.GIT_CONFIG_NOSYSTEM = '1';
}
const tmp = (p = 'po-orch-') => fs.mkdtempSync(path.join(os.tmpdir(), p));
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();
function mkRepo(): string {
  const d = tmp('po-repo-');
  fs.writeFileSync(path.join(d, 'a.txt'), 'a\n');
  git(d, 'init', '-q', '-b', 'main');
  git(d, 'add', '-A');
  git(d, 'commit', '-q', '-m', 'init');
  return d;
}

const CORE: RoleId[] = ['pm', 'techlead', 'frontend', 'backend', 'qa'];
const project = (folder: string, team: RoleId[] = CORE, id = 'p1'): Project =>
  ({ id, name: 'Shop', folder, accent: 'cyan', team, slot: 0, looks: {} as any, createdAt: '' });

const fence = (o: unknown) => 'Here you go.\n```json\n' + JSON.stringify(o) + '\n```';
const PLAN = {
  summary: 'Add link', acceptance: ['link shows'], areas: ['src'],
  tasks: [{ role: 'frontend', text: 'UI link', files: ['ui.txt'] }, { role: 'backend', text: 'API', files: ['api.txt'] },
    { role: 'techlead', text: 'Review', files: [] }, { role: 'qa', text: 'Test it', files: [] }],
  projectMap: '# map',
};

type Kind = 'plan' | 'replan' | 'fixjson' | 'stage' | 'review' | 'test' | 'bounce';
const kindOf = (p: string): Kind =>
  p.includes('did not contain valid JSON') ? 'fixjson'
    : p.includes('asked for changes to your plan') ? 'replan'
      : p.includes('project manager') ? 'plan'
        : p.includes('Review/test found problems') ? 'bounce'
          : p.includes('Review the changes') ? 'review'
            : p.includes('You are QA') ? 'test' : 'stage';

interface Call { o: RunOptions; kind: Kind; started: number; ended?: number }
type Reply = { result?: string; write?: Record<string, string>; hang?: boolean; delay?: number; isError?: boolean; subtype?: string };

class FakeRunner {
  calls: Call[] = [];
  tick = 0;
  sess = 0;
  script: (c: Call, n: number) => Reply | undefined = () => undefined;
  run(o: RunOptions): Promise<RunResult> {
    const c: Call = { o, kind: kindOf(o.prompt), started: ++this.tick };
    this.calls.push(c);
    const n = this.calls.filter(x => x.o.role === o.role && x.kind === c.kind).length;
    const reply = this.script(c, n) ?? this.defaults(c);
    const sessionId = o.resume ?? `${o.role}-s${++this.sess}`;
    return new Promise((resolve, reject) => {
      const abort = () => { c.ended = ++this.tick; const e = new Error('aborted'); e.name = 'AbortError'; reject(e); };
      if (o.signal?.aborted) return abort();
      o.signal?.addEventListener('abort', abort);
      o.onEvent({ kind: 'init', sessionId, model: 'm' });
      if (reply.hang) return;
      setTimeout(() => {
        if (o.signal?.aborted) return;
        o.onEvent({ kind: 'tool_use', id: `t${this.tick}`, name: 'Read', input: { file_path: 'a.txt' } });
        o.onEvent({ kind: 'tool_result', id: `t${this.tick}`, isError: false, content: 'ok' });
        for (const [f, body] of Object.entries(reply.write ?? {})) fs.writeFileSync(path.join(o.cwd, f), body);
        if (reply.result) o.onEvent({ kind: 'text', text: reply.result });
        c.ended = ++this.tick;
        resolve({
          sessionId, result: reply.result ?? '', isError: !!reply.isError, subtype: reply.subtype ?? 'success',
          numTurns: 2, costUsd: 0.01, durationMs: 100, exitCode: reply.isError ? 1 : 0,
        });
      }, reply.delay ?? 5);
    });
  }
  defaults(c: Call): Reply {
    const role = c.o.role;
    switch (c.kind) {
      case 'plan': case 'replan': case 'fixjson': return { result: fence(PLAN) };
      case 'review': return { result: fence({ approved: true, issues: [] }) };
      case 'test': return { result: fence({ passed: true, failures: [] }) };
      case 'bounce': return { result: 'fixed', write: { [`${role}-fix.txt`]: `fix ${this.tick}\n` } };
      default: return { result: 'done', write: { [role === 'frontend' ? 'ui.txt' : `${role}.txt`]: `${role}\n` }, delay: 20 };
    }
  }
  of(role: RoleId, kind?: Kind) { return this.calls.filter(c => c.o.role === role && (!kind || c.kind === kind)); }
}

let runner: FakeRunner;
let events: ServerEvent[];
let dataDir: string;
const make = (git?: GitApi) => {
  runner = new FakeRunner(); events = []; dataDir = tmp('po-data-');
  const o = new ClaudeOrchestrator({ log: new TicketLog(path.join(dataDir, 'tickets')), runner, dataDir, git });
  o.onEvent(e => events.push(e));
  return o;
};
const states = (role: RoleId) => events.filter((e: any) => e.type === 'agent.state' && e.role === role).map((e: any) => e.state);
const gates = () => events.filter(e => e.type === 'gate.open').map((e: any) => e.gate);
const of = <T extends ServerEvent['type']>(t: T) => events.filter(e => e.type === t) as Extract<ServerEvent, { type: T }>[];
const pmText = () => of('agent.message').filter(m => m.role === 'pm').map(m => m.text).join('\n');

async function toPlanGate(o: ClaudeOrchestrator, repo: string, team = CORE) {
  const t = o.startTicket(project(repo, team), 'Add forgot password link');
  await o.idle();
  return t;
}
async function toFinal(o: ClaudeOrchestrator, repo: string, team = CORE) {
  const t = await toPlanGate(o, repo, team);
  o.decide(t.id, 'plan', 'approved');
  await o.idle();
  return t;
}

describe('ClaudeOrchestrator', () => {
  let repo: string;
  beforeEach(() => { repo = mkRepo(); });

  it('preflight: a non-git folder fails with not-a-git-repo', async () => {
    const o = make();
    const t = o.startTicket(project(tmp('po-nogit-')), 'x');
    await o.idle();
    expect(o.find(t.id)!.status).toBe('failed');
    expect(o.find(t.id)!.reason).toBe(NOT_A_GIT_REPO);
    expect(runner.calls).toHaveLength(0);
    expect(o.current('p1')).toBeUndefined();
  });

  it('plan JSON ok → plan gate with the plan; PM runs read-only in the project folder', async () => {
    const o = make();
    const t = await toPlanGate(o, repo);
    expect(gates()).toEqual(['plan']);
    const plan = of('ticket.plan')[0].plan;
    expect(plan.tasks.map(x => x.role)).toEqual(['frontend', 'backend', 'techlead', 'qa']);
    expect((plan as any).projectMap).toBeUndefined();
    expect(of('gate.open')[0].payload).toEqual(plan);
    const pm = runner.of('pm')[0].o;
    expect(pm.cwd).toBe(repo);
    expect(pm.allowedTools).toEqual(['Read', 'Glob', 'Grep']);
    expect(pm.resume).toBeUndefined();
    expect(of('agent.session')[0]).toMatchObject({ role: 'pm', sessionId: 'pm-s1' });
    expect(o.find(t.id)!.sessions).toEqual({ pm: 'pm-s1' });
    expect(states('pm')).toEqual(['summoned', 'planning', 'waiting']);
    expect(of('agent.tool').map(e => e.status)).toEqual(['running', 'ok']);
    expect(o.find(t.id)!.status).toBe('waiting');
  });

  it('bad plan JSON → one fixJson resume → ok', async () => {
    const o = make();
    runner.script = c => c.kind === 'plan' ? { result: 'I think we should add a link.' } : undefined;
    await toPlanGate(o, repo);
    expect(runner.of('pm').map(c => c.kind)).toEqual(['plan', 'fixjson']);
    expect(runner.of('pm', 'fixjson')[0].o.resume).toBe('pm-s1');
    expect(gates()).toEqual(['plan']);
  });

  it('still bad JSON → failed, showing the PM text', async () => {
    const o = make();
    runner.script = c => c.o.role === 'pm' ? { result: 'Prose only, sorry.' } : undefined;
    const t = await toPlanGate(o, repo);
    expect(runner.of('pm')).toHaveLength(2);
    expect(o.find(t.id)!.status).toBe('failed');
    expect(pmText()).toContain('Prose only, sorry.');
    expect(o.find(t.id)!.reason).toMatch(/valid plan/);
    expect(states('pm').at(-1)).toBe('idle');
  });

  it('a run that reports an error result fails the ticket', async () => {
    const o = make();
    runner.script = c => c.o.role === 'pm' ? { result: 'Not logged in', isError: true } : undefined;
    const t = await toPlanGate(o, repo);
    expect(o.find(t.id)!.status).toBe('failed');
    expect(o.find(t.id)!.reason).toContain('Not logged in');
  });

  it('plan changes → PM session resumed with the note', async () => {
    const o = make();
    const t = await toPlanGate(o, repo);
    o.decide(t.id, 'plan', 'changes', 'Also add a test');
    await o.idle();
    const re = runner.of('pm', 'replan');
    expect(re).toHaveLength(1);
    expect(re[0].o.resume).toBe('pm-s1');
    expect(re[0].o.prompt).toContain('Also add a test');
    expect(gates()).toEqual(['plan', 'plan']);
  });

  it('approve → worktree, parallel build, commit, review, test, final diff from git', async () => {
    const o = make();
    const t = await toFinal(o, repo);
    const fe = runner.of('frontend', 'stage')[0], be = runner.of('backend', 'stage')[0];
    // both start before either ends
    expect(Math.max(fe.started, be.started)).toBeLessThan(Math.min(fe.ended!, be.ended!));
    const wt = workspacePath(dataDir, 'p1', t.id);
    expect(fe.o.cwd).toBe(wt);
    expect(fe.o.prompt).toContain('UI link');
    expect(fs.existsSync(path.join(wt, '.claude', 'office', 'project-map.md'))).toBe(true);
    const branch = `office/add-forgot-password-link-${t.id.slice(0, 6)}`;
    expect(git(repo, 'branch', '--list', branch)).toContain(branch);
    expect(git(wt, 'log', '--format=%s')).toContain('office: build (frontend, backend)');
    expect(runner.of('techlead', 'review')[0].o.cwd).toBe(wt);
    expect(runner.of('qa', 'test')).toHaveLength(1);
    expect(gates()).toEqual(['plan', 'final']);
    const files = of('ticket.diff')[0].files.map(f => f.path).sort();
    expect(files).toEqual(['.claude/office/project-map.md', 'backend.txt', 'ui.txt']);
    expect(of('ticket.stage').map(e => e.stage)).toEqual(['plan', 'build', 'review', 'test']);
    // owner's working copy untouched
    expect(fs.existsSync(path.join(repo, 'ui.txt'))).toBe(false);
  });

  it('agent states match the M1 sequence (so the office animates)', async () => {
    const o = make();
    const t = await toFinal(o, repo);
    o.decide(t.id, 'final', 'approved');
    await o.idle();
    expect(states('pm')).toEqual(['summoned', 'planning', 'waiting', 'done', 'idle']);
    expect(states('frontend')).toEqual(['summoned', 'coding', 'waiting', 'done', 'idle']);
    expect(states('techlead')).toEqual(['summoned', 'reviewing', 'waiting', 'done', 'idle']);
    expect(states('qa')).toEqual(['summoned', 'testing', 'waiting', 'done', 'idle']);
    expect(o.busyRoles('p1')).toEqual([]);
  });

  it('busyRoles reflects the active ticket', async () => {
    const o = make();
    const t = await toPlanGate(o, repo);
    expect(o.busyRoles('p1')).toEqual(['pm']);
    runner.script = c => c.kind === 'stage' ? { hang: true } : undefined;
    o.decide(t.id, 'plan', 'approved');
    await new Promise(r => setTimeout(r, 300));
    expect(o.busyRoles('p1').sort()).toEqual(['backend', 'frontend', 'pm', 'qa', 'techlead']);
    o.cancel(t.id);
    await o.idle();
    expect(o.busyRoles('p1')).toEqual([]);
  });

  it('review bounce → owning dev resumed with issues; 3 bounces → stuck; accept continues', async () => {
    const o = make();
    runner.script = c => c.kind === 'review'
      ? { result: fence({ approved: false, issues: [{ role: 'backend', file: 'backend.txt', note: 'missing error handling' }] }) }
      : undefined;
    const t = await toFinal(o, repo);
    const bounces = runner.of('backend', 'bounce');
    expect(bounces).toHaveLength(2);
    expect(bounces[0].o.resume).toBe(runner.of('backend', 'stage')[0].o.resume ?? of('agent.session').find(e => e.role === 'backend')!.sessionId);
    expect(bounces[0].o.prompt).toContain('missing error handling');
    expect(runner.of('frontend', 'bounce')).toHaveLength(0);
    expect(runner.of('techlead', 'review')).toHaveLength(3);
    expect(gates()).toEqual(['plan', 'stuck']);
    expect(git(workspacePath(dataDir, 'p1', t.id), 'log', '--format=%s')).toContain('office: fixes (backend)');
    runner.script = () => undefined;
    o.decide(t.id, 'stuck', 'accept');
    await o.idle();
    expect(gates()).toEqual(['plan', 'stuck', 'final']);
    expect(runner.of('qa', 'test')).toHaveLength(1);
  });

  it('stuck retry bounces again and re-reviews; stuck cancel cancels', async () => {
    const o = make();
    let approve = false;
    runner.script = c => c.kind === 'review' && !approve
      ? { result: fence({ approved: false, issues: [{ role: 'frontend', file: 'ui.txt', note: 'bad' }] }) }
      : undefined;
    const t = await toFinal(o, repo);
    expect(gates().at(-1)).toBe('stuck');
    approve = true;
    o.decide(t.id, 'stuck', 'retry', 'try harder');
    await o.idle();
    expect(runner.of('frontend', 'bounce').at(-1)!.o.prompt).toContain('try harder');
    expect(gates().at(-1)).toBe('final');

    const repo2 = mkRepo();
    approve = false;
    const t2 = o.startTicket(project(repo2, CORE, 'p2'), 'Second');
    await o.idle();
    o.decide(t2.id, 'plan', 'approved');
    await o.idle();
    o.decide(t2.id, 'stuck', 'cancel');
    await o.idle();
    expect(o.find(t2.id)!.status).toBe('cancelled');
  });

  it('QA failures bounce to the owning dev; unassigned items go to the PM feed', async () => {
    const o = make();
    runner.script = (c, n) => c.kind === 'test' && n === 1
      ? { result: fence({ passed: false, failures: [{ role: 'frontend', note: 'link 404' }, { role: 'devops', note: 'CI missing' }] }) }
      : undefined;
    await toFinal(o, repo);
    expect(runner.of('frontend', 'bounce')).toHaveLength(1);
    expect(runner.of('frontend', 'bounce')[0].o.prompt).toContain('link 404');
    expect(runner.of('qa', 'test')).toHaveLength(2);
    expect(pmText()).toContain('CI missing');
    expect(gates()).toEqual(['plan', 'final']);
  });

  it('fair review: an issue on a file outside the repo is a PM note, never a bounce; reviewer notes are shown', async () => {
    const o = make();
    const outside = path.join(path.dirname(repo), 'elsewhere', 'RULES.md');
    runner.script = (c, n) => c.kind === 'review' && n === 1
      ? { result: fence({ approved: false, notes: ['QA has not run yet'], issues: [
        { role: 'frontend', file: '../docs/tickets/ticket-register.md', note: 'register not updated' },
        { role: 'backend', file: outside, note: 'rules file' }] }) }
      : undefined;
    await toFinal(o, repo);
    expect(runner.calls.filter(c => c.kind === 'bounce')).toHaveLength(0);
    expect(runner.of('techlead', 'review')).toHaveLength(1);
    expect(gates()).toEqual(['plan', 'final']);
    expect(pmText()).toContain('../docs/tickets/ticket-register.md');
    expect(pmText()).toContain('register not updated');
    expect(of('agent.message').some(m => m.role === 'techlead' && m.text.startsWith('Notes') && m.text.includes('QA has not run yet'))).toBe(true);
  });

  it('fair review: a bare rejection from another reviewer still bounces when the rest was outside-the-repo notes', async () => {
    const o = make();
    runner.script = (c, n) => c.kind !== 'review' || n !== 1 ? undefined
      : c.o.role === 'techlead' ? { result: fence({ approved: false, issues: [{ role: 'frontend', file: '../RULES.md', note: 'rules' }] }) }
        : { result: fence({ approved: false, issues: [] }) };
    await toFinal(o, repo, [...CORE, 'security']);
    expect(runner.of('security', 'review').length).toBeGreaterThan(0);
    const b = runner.calls.filter(c => c.kind === 'bounce');
    expect(b.length).toBeGreaterThan(0);
    expect(b[0].o.prompt).toContain('did not pass');
    expect(b.some(c => c.o.prompt.includes('RULES.md'))).toBe(false);
  });

  it('final approve → merged into the base when clean (base advanced); usage emitted', async () => {
    const o = make();
    const t = await toFinal(o, repo);
    const before = git(repo, 'rev-parse', 'HEAD');
    o.decide(t.id, 'final', 'approved');
    await o.idle();
    expect(o.find(t.id)!.status).toBe('done');
    expect(git(repo, 'rev-parse', 'HEAD')).not.toBe(before);
    expect(fs.existsSync(path.join(repo, 'ui.txt'))).toBe(true);
    expect(fs.existsSync(workspacePath(dataDir, 'p1', t.id))).toBe(false);
    const u = of('ticket.usage');
    expect(u).toHaveLength(1);
    expect(u[0].turns).toBe(2 * runner.calls.length);
    expect(u[0].costUsd).toBeCloseTo(0.01 * runner.calls.length);
    expect(o.find(t.id)!.usage!.turns).toBe(u[0].turns);
  });

  it('pre-existing repo with untracked agent files: worktree gets them, they are never committed, merge succeeds', async () => {
    const agents = path.join(repo, '.claude', 'agents');
    fs.mkdirSync(agents, { recursive: true });
    for (const r of CORE) fs.writeFileSync(path.join(agents, `${r}.md`), `agent ${r}\n`);
    const o = make();
    const t = await toFinal(o, repo);
    const wt = workspacePath(dataDir, 'p1', t.id);
    expect(fs.readFileSync(path.join(wt, '.claude', 'agents', 'frontend.md'), 'utf8')).toBe('agent frontend\n');
    expect(git(wt, 'ls-files', '.claude/agents')).toBe('');
    expect(git(wt, 'status', '--porcelain', '--untracked-files=all')).toBe('');
    const files = of('ticket.diff')[0].files.map(f => f.path);
    expect(files.some(f => f.startsWith('.claude/agents'))).toBe(false);
    o.decide(t.id, 'final', 'approved');
    await o.idle();
    expect(o.find(t.id)!.status).toBe('done');
    expect(pmText()).toMatch(/Merged office\//);
    expect(fs.existsSync(path.join(repo, 'ui.txt'))).toBe(true);
  });

  it('final approve with no changes on the branch → no merge, PM says so, done', async () => {
    const o = make();
    const { projectMap: _, ...noMap } = PLAN;
    runner.script = c => c.kind === 'plan' ? { result: fence(noMap) } : c.kind === 'stage' ? { result: 'nothing to do' } : undefined;
    const t = await toFinal(o, repo);
    expect(of('ticket.diff')[0].files).toEqual([]);
    const before = git(repo, 'rev-parse', 'HEAD');
    o.decide(t.id, 'final', 'approved');
    await o.idle();
    expect(o.find(t.id)!.status).toBe('done');
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(before);
    expect(pmText()).toContain('No changes were made — nothing to merge');
    expect(pmText()).not.toMatch(/Merged /);
    expect(o.find(t.id)!.workspace?.merged).toBeUndefined();
    expect(fs.existsSync(workspacePath(dataDir, 'p1', t.id))).toBe(false);
  });

  it('notes for a non-PM role are never delivered in the owner folder (kept until there is a worktree)', async () => {
    const o = make();
    const t = await toPlanGate(o, repo);
    const run = (o as any).runs.get(t.id);
    expect(run.wt).toBeUndefined();
    run.notes.frontend = ['Use blue'];
    run.sessions.frontend = 'frontend-old';
    await (o as any).deliverNotes(run, 'frontend');
    await o.idle();
    expect(runner.of('frontend')).toHaveLength(0);
    expect(run.notes.frontend).toEqual(['Use blue']);
    expect(runner.calls.every(c => c.o.role === 'pm' || c.o.cwd !== repo)).toBe(true);
  });

  it('final approve with a dirty tree → done anyway with merge-pending instructions', async () => {
    const o = make();
    const t = await toFinal(o, repo);
    fs.writeFileSync(path.join(repo, 'dirty.txt'), 'x');
    const before = git(repo, 'rev-parse', 'HEAD');
    o.decide(t.id, 'final', 'approved');
    await o.idle();
    expect(o.find(t.id)!.status).toBe('done');
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(before);
    const msg = pmText();
    expect(msg).toMatch(/Merge pending/);
    expect(msg).toContain('git merge --no-ff office/');
    expect(git(repo, 'branch', '--list', 'office/*')).toContain('office/');
  });

  it('final changes → note passed to builders, build runs again', async () => {
    const o = make();
    const t = await toFinal(o, repo);
    o.decide(t.id, 'final', 'changes', 'Make it blue');
    await o.idle();
    expect(runner.of('frontend', 'stage')).toHaveLength(2);
    expect(runner.of('frontend', 'stage')[1].o.prompt).toContain('Make it blue');
    expect(runner.of('frontend', 'stage')[1].o.resume).toBeDefined();
    expect(gates()).toEqual(['plan', 'final', 'final']);
  });

  it('cancel → runner aborted, worktree removed, branch kept, agents idle', async () => {
    const o = make();
    const t = await toPlanGate(o, repo);
    runner.script = c => c.kind === 'stage' ? { hang: true } : undefined;
    o.decide(t.id, 'plan', 'approved');
    await until(() => runner.of('frontend', 'stage').length === 1);
    const wt = workspacePath(dataDir, 'p1', t.id);
    expect(fs.existsSync(wt)).toBe(true);
    const running = runner.of('frontend', 'stage')[0];
    expect(running.ended).toBeUndefined();
    o.cancel(t.id);
    await o.idle();
    expect(running.o.signal!.aborted).toBe(true);
    expect(o.find(t.id)!.status).toBe('cancelled');
    expect(fs.existsSync(wt)).toBe(false);
    expect(git(repo, 'branch', '--list', 'office/*')).toContain('office/');
    expect(states('frontend').at(-1)).toBe('idle');
    expect(states('pm').at(-1)).toBe('idle');
    expect(of('ticket.cancelled')).toHaveLength(1);
    expect(of('ticket.failed')).toHaveLength(0);
  });

  it('sendMessage → user.message + ack, note goes into the role’s next prompt', async () => {
    const o = make();
    const t = await toPlanGate(o, repo);
    o.sendMessage(t.id, 'Use the brand color');
    expect(of('user.message')[0].text).toBe('Use the brand color');
    expect(of('agent.message').at(-1)!.role).toBe('pm');
    o.decide(t.id, 'plan', 'changes', 'tweak');
    await o.idle();
    expect(of('gate.open')).toHaveLength(2);
  });

  it('queues tickets per project and starts the next one when the first ends', async () => {
    const o = make();
    const t1 = await toPlanGate(o, repo);
    const t2 = o.startTicket(project(repo), 'Second ticket');
    const other = o.startTicket(project(mkRepo(), CORE, 'p2'), 'Other project');
    await o.idle();
    expect(o.queue('p1').map(t => t.id)).toEqual([t2.id]);
    expect(o.current('p2')!.id).toBe(other.id);
    expect(o.find(t2.id)!.status).toBe('queued');
    o.cancel(t1.id);
    await o.idle();
    expect(o.current('p1')!.id).toBe(t2.id);
    expect(o.find(t2.id)!.openGate).toBe('plan');
  });

  it('review/test run automatically when only a builder is tasked', async () => {
    const o = make();
    runner.script = c => c.kind === 'plan' ? { result: fence({ ...PLAN, tasks: [{ role: 'backend', text: 'API', files: [] }] }) } : undefined;
    await toFinal(o, repo, [...CORE, 'security']);
    expect(runner.of('techlead', 'review')).toHaveLength(1);
    expect(runner.of('security', 'review')).toHaveLength(1);
    expect(runner.of('qa', 'test')).toHaveLength(1);
    expect(runner.of('frontend')).toHaveLength(0);
    expect(states('techlead')[0]).toBe('summoned');
  });

  it('issues for roles that cannot edit (or untasked) go to all tasked builders', async () => {
    const o = make();
    runner.script = (c, n) => c.kind === 'review' && n === 1
      ? { result: fence({ approved: false, issues: [{ role: 'security', file: 'a.txt', note: 'secret leak' }, { role: 'pm', file: '', note: 'scope' }] }) }
      : c.kind === 'plan' ? { result: fence({ ...PLAN, tasks: [{ role: 'backend', text: 'API', files: [] }] }) } : undefined;
    await toFinal(o, repo, [...CORE, 'security']);
    expect(runner.of('security', 'bounce')).toHaveLength(0);
    expect(runner.of('pm', 'bounce')).toHaveLength(0);
    expect(runner.of('frontend', 'bounce')).toHaveLength(0); // untasked
    const b = runner.of('backend', 'bounce');
    expect(b).toHaveLength(1);
    expect(b[0].o.prompt).toContain('secret leak');
    expect(b[0].o.prompt).toContain('scope');
  });

  it('issues for a tasked editable role go to that role only', async () => {
    const o = make();
    runner.script = (c, n) => c.kind === 'review' && n === 1
      ? { result: fence({ approved: false, issues: [{ role: 'frontend', file: 'ui.txt', note: 'ugly' }] }) } : undefined;
    await toFinal(o, repo);
    expect(runner.of('frontend', 'bounce')).toHaveLength(1);
    expect(runner.of('backend', 'bounce')).toHaveLength(0);
  });

  it('detached HEAD base is noted at approval and the merge is refused', async () => {
    const o = make();
    git(repo, 'checkout', '-q', '--detach');
    const t = await toFinal(o, repo);
    expect(pmText()).toMatch(/detached HEAD/i);
    o.decide(t.id, 'final', 'approved');
    await o.idle();
    expect(o.find(t.id)!.status).toBe('done');
    expect(pmText()).toMatch(/Merge pending/);
    expect(pmText()).toMatch(/not on a branch/i);
  });

  it('cancel is refused once the final merge has started', async () => {
    const o = make();
    const t = await toFinal(o, repo);
    o.decide(t.id, 'final', 'approved');
    expect(() => o.cancel(t.id)).toThrow(/merging/);
    await o.idle();
    expect(o.find(t.id)!.status).toBe('done');
  });

  it('cancel during review aborts the reviewer and removes the worktree', async () => {
    const o = make();
    runner.script = c => c.kind === 'review' ? { hang: true } : undefined;
    const t = await toPlanGate(o, repo);
    o.decide(t.id, 'plan', 'approved');
    for (let i = 0; i < 100 && !runner.of('techlead', 'review').length; i++) await new Promise(r => setTimeout(r, 20));
    const rv = runner.of('techlead', 'review')[0];
    o.cancel(t.id);
    await o.idle();
    expect(rv.o.signal!.aborted).toBe(true);
    expect(o.find(t.id)!.status).toBe('cancelled');
    expect(fs.existsSync(workspacePath(dataDir, 'p1', t.id))).toBe(false);
    expect(states('techlead').at(-1)).toBe('idle');
  });

  it('one parallel builder failing aborts its sibling and fails the ticket', async () => {
    const o = make();
    runner.script = c => c.kind === 'stage' && c.o.role === 'frontend' ? { hang: true }
      : c.kind === 'stage' && c.o.role === 'backend' ? { result: 'boom', isError: true, delay: 30 } : undefined;
    const t = await toPlanGate(o, repo);
    o.decide(t.id, 'plan', 'approved');
    await o.idle();
    expect(o.find(t.id)!.status).toBe('failed');
    expect(runner.of('frontend', 'stage')[0].o.signal!.aborted).toBe(true);
    expect(o.find(t.id)!.reason).toContain('boom');
  });

  it('error_max_turns fails with a turn-limit reason', async () => {
    const o = make();
    runner.script = c => c.kind === 'stage' && c.o.role === 'backend' ? { result: '', isError: true, subtype: 'error_max_turns' } : undefined;
    const t = await toFinal(o, repo);
    expect(o.find(t.id)!.status).toBe('failed');
    expect(o.find(t.id)!.reason).toMatch(/turn limit \(80\)/);
  });

  it('an owner note reaches the role’s next prompt (PM re-plan and builder)', async () => {
    const o = make();
    const t = await toPlanGate(o, repo);
    o.sendMessage(t.id, 'Use the brand color');
    o.decide(t.id, 'plan', 'changes', 'tweak');
    await o.idle();
    const re = runner.of('pm', 'replan')[0].o.prompt;
    expect(re).toContain('<owner-notes>');
    expect(re).toContain('Use the brand color');
    runner.script = (c, n) => c.kind === 'stage' && c.o.role === 'frontend' ? { result: 'ok', delay: 200 }
      : c.kind === 'review' && n === 1 ? { result: fence({ approved: false, issues: [{ role: 'frontend', file: 'ui.txt', note: 'x' }] }) } : undefined;
    o.decide(t.id, 'plan', 'approved');
    for (let i = 0; i < 100 && !runner.of('frontend', 'stage').length; i++) await new Promise(r => setTimeout(r, 10));
    o.sendMessage(t.id, 'Rounded corners please');
    await o.idle();
    const later = runner.calls.filter(c => c.o.role === 'frontend').slice(1).map(c => c.o.prompt).join('\n');
    expect(later).toContain('Rounded corners please');
  });

  it('adopt seeds usage from the recovered ticket', async () => {
    const o = make();
    const t = await toPlanGate(o, repo);
    const recovered = { ...o.find(t.id)!, usage: { turns: 10, costUsd: 1, durationMs: 1000 } };
    const o2 = make();
    o2.adopt(project(repo), recovered);
    await o2.idle();
    o2.cancel(t.id);
    await o2.idle();
    expect(of('ticket.usage').at(-1)!.turns).toBe(10 + 2);
  });

  it('never runs two runs on one session at once', async () => {
    const o = make();
    const t = await toPlanGate(o, repo);
    runner.script = c => c.kind === 'stage' ? { result: 'ok', delay: 50 } : undefined;
    o.decide(t.id, 'plan', 'approved');
    o.sendMessage(t.id, 'hello');
    await o.idle();
    const bySession = new Map<string, Call[]>();
    for (const c of runner.calls) if (c.o.resume) bySession.set(c.o.resume, [...(bySession.get(c.o.resume) ?? []), c]);
    for (const cs of bySession.values()) {
      for (let i = 1; i < cs.length; i++) expect(cs[i].started).toBeGreaterThan(cs[i - 1].ended!);
    }
  });
});

const until = async (cond: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error('timeout'); await new Promise(r => setTimeout(r, 5)); }
};
const tevents = (id: string) => events.filter((e: any) => e.ticketId === id) as any[];

describe('ClaudeOrchestrator: follow-ups, resume, messages', () => {
  let repo: string;
  beforeEach(() => { repo = mkRepo(); });

  async function doneUnmerged(o: ClaudeOrchestrator) {
    const t = await toFinal(o, repo);
    fs.writeFileSync(path.join(repo, 'dirty.txt'), 'x');
    o.decide(t.id, 'final', 'approved');
    await o.idle();
    fs.rmSync(path.join(repo, 'dirty.txt'));
    return t;
  }

  it('follow-up resumes the parent PM session; re-tasked devs resume theirs; unmerged → same branch (worktree recreated)', async () => {
    const o = make();
    const t1 = await doneUnmerged(o);
    const parent = o.find(t1.id)!;
    expect(parent.workspace?.merged).toBeUndefined();
    expect(fs.existsSync(parent.workspace!.worktree)).toBe(false);
    const t2 = o.startTicket(project(repo), 'Also add a help link', { parentTicketId: t1.id });
    expect(t2.parentTicketId).toBe(t1.id);
    expect(t2.agentsMode).toBe('claude');
    await o.idle();
    const pm = runner.of('pm', 'plan').at(-1)!;
    expect(pm.o.resume).toBe(parent.sessions!.pm);
    expect(pm.o.prompt).toContain('follow-up');
    expect(pm.o.prompt).toContain('Also add a help link');
    o.decide(t2.id, 'plan', 'approved');
    await o.idle();
    const fe = runner.of('frontend', 'stage').at(-1)!;
    expect(fe.o.resume).toBe(parent.sessions!.frontend);
    const ws = o.find(t2.id)!.workspace!;
    expect(ws.branch).toBe(parent.workspace!.branch);
    expect(fe.o.cwd).toBe(parent.workspace!.worktree);
    expect(git(ws.worktree, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(parent.workspace!.branch);
    // the inherited sessions are persisted in the follow-up's own log (Resume after restart)
    expect(tevents(t2.id).filter(e => e.type === 'agent.session').map(e => e.role)).toContain('pm');
  });

  it('follow-up of a merged parent → new branch from the current base', async () => {
    const o = make();
    const t1 = await toFinal(o, repo);
    o.decide(t1.id, 'final', 'approved');
    await o.idle();
    expect(o.find(t1.id)!.workspace!.merged).toBe(true);
    const t2 = o.startTicket(project(repo), 'Next thing', { parentTicketId: t1.id });
    await o.idle();
    o.decide(t2.id, 'plan', 'approved');
    await o.idle();
    const ws = o.find(t2.id)!.workspace!;
    expect(ws.branch).not.toBe(o.find(t1.id)!.workspace!.branch);
    expect(ws.base.head).toBe(git(repo, 'rev-parse', 'HEAD'));
  });

  it('expired parent session → fresh session with the parent plan + diff summary', async () => {
    const o = make();
    const t1 = await doneUnmerged(o);
    const old = o.find(t1.id)!.sessions!.pm;
    runner.script = c => c.o.role === 'pm' && c.o.resume === old ? { isError: true, result: 'No conversation found', subtype: 'error_during_execution' } : undefined;
    const t2 = o.startTicket(project(repo), 'More', { parentTicketId: t1.id });
    await o.idle();
    const pms = runner.of('pm').slice(-2);
    expect(pms[0].o.resume).toBe(old);
    expect(pms[1].o.resume).toBeUndefined();
    expect(pms[1].o.prompt).toContain('<previous-work>');
    expect(pms[1].o.prompt).toContain('Add link');
    expect(pms[1].o.prompt).toContain('ui.txt');
    expect(o.find(t2.id)!.openGate).toBe('plan');
    expect(o.find(t2.id)!.sessions!.pm).not.toBe(old);
  });

  it('follow-up while the parent is running is queued (never two runs on one session)', async () => {
    const o = make();
    const t1 = await toPlanGate(o, repo);
    const t2 = o.startTicket(project(repo), 'Follow', { parentTicketId: t1.id });
    await o.idle();
    expect(o.queue('p1').map(t => t.id)).toEqual([t2.id]);
    expect(runner.of('pm')).toHaveLength(1);
    o.cancel(t1.id);
    await o.idle();
    expect(runner.of('pm').at(-1)!.o.resume).toBe(o.find(t1.id)!.sessions!.pm);
    expect(runner.of('pm').at(-1)!.started).toBeGreaterThan(runner.of('pm')[0].ended!);
  });

  it('interrupted ticket → resume re-runs the interrupted stage with the stored sessions after a restart', async () => {
    const o = make();
    runner.script = c => c.o.role === 'frontend' && c.kind === 'stage' ? { hang: true } : undefined;
    const t = await toPlanGate(o, repo);
    o.decide(t.id, 'plan', 'approved');
    await until(() => runner.of('frontend', 'stage').length === 1 && runner.of('backend', 'stage')[0]?.ended !== undefined);
    const feSession = o.find(t.id)!.sessions!.frontend!;
    // restart: a new orchestrator over the same log
    const log = new TicketLog(path.join(dataDir, 'tickets'));
    const rec = log.recover().find(x => x.id === t.id)!;
    expect(rec.reason).toBe('interrupted');
    const r2 = new FakeRunner();
    const o2 = new ClaudeOrchestrator({ log, runner: r2, dataDir, getProject: () => project(repo) });
    const resumed = o2.resume(t.id);
    expect(resumed.status).not.toBe('failed');
    await o2.idle();
    const fe = r2.of('frontend', 'stage')[0];
    expect(fe.o.resume).toBe(feSession);
    expect(fe.o.prompt.startsWith('Continue where you left off.')).toBe(true);
    expect(fe.o.cwd).toBe(workspacePath(dataDir, 'p1', t.id));
    expect(r2.of('pm')).toHaveLength(0);
    expect(o2.find(t.id)!.openGate).toBe('final');
    expect(() => o2.resume(t.id)).toThrow(/active/);
  });

  it('resume with an expired stored session → fresh session given the plan + changes so far', async () => {
    const o = make();
    runner.script = c => c.o.role === 'frontend' && c.kind === 'stage' ? { hang: true } : undefined;
    const t = await toPlanGate(o, repo);
    o.decide(t.id, 'plan', 'approved');
    await until(() => runner.of('frontend', 'stage').length === 1 && runner.of('backend', 'stage')[0]?.ended !== undefined);
    const feSession = o.find(t.id)!.sessions!.frontend!;
    const log = new TicketLog(path.join(dataDir, 'tickets'));
    log.recover();
    const r2 = new FakeRunner();
    r2.script = c => c.o.resume === feSession ? { isError: true, result: 'No conversation found', subtype: 'error_during_execution' } : undefined;
    const o2 = new ClaudeOrchestrator({ log, runner: r2, dataDir, getProject: () => project(repo) });
    o2.resume(t.id);
    await o2.idle();
    const fes = r2.of('frontend', 'stage');
    expect(fes[0].o.resume).toBe(feSession);
    expect(fes[1].o.resume).toBeUndefined();
    expect(fes[1].o.prompt).toContain('<previous-work>');
    expect(fes[1].o.prompt).toContain('Add link');
    expect(fes[1].o.prompt).not.toContain('Continue where you left off.');
    expect(o2.find(t.id)!.openGate).toBe('final');
  });

  it('resume while another ticket runs → ticket shows queued until it starts', async () => {
    const o = make();
    runner.script = c => c.o.role === 'frontend' && c.kind === 'stage' ? { hang: true } : undefined;
    const t = await toPlanGate(o, repo);
    o.decide(t.id, 'plan', 'approved');
    await until(() => runner.of('frontend', 'stage').length === 1);
    const log = new TicketLog(path.join(dataDir, 'tickets'));
    log.recover();
    const o2 = new ClaudeOrchestrator({ log, runner: new FakeRunner(), dataDir, getProject: () => project(repo) });
    const other = o2.startTicket(project(repo), 'Other work');
    await o2.idle();
    expect(o2.resume(t.id).status).toBe('queued');
    o2.cancel(other.id);
    await o2.idle();
    expect(o2.find(t.id)!.openGate).toBe('final');
  });

  it('resume refuses tickets that did not fail', async () => {
    const o = make();
    const t = await toPlanGate(o, repo);
    expect(() => o.resume(t.id)).toThrow(/active/);
    o.cancel(t.id);
    await o.idle();
    expect(() => o.resume(t.id)).toThrow(/failed or interrupted/);
  });

  it('mid-ticket message → immediate ack, prepended in <owner-notes> to the role’s next prompt', async () => {
    const o = make();
    runner.script = (c, n) => c.o.role === 'techlead' && c.kind === 'review' && n === 1
      ? { result: fence({ approved: false, issues: [{ role: 'backend', file: 'api.txt', note: 'fix' }] }), delay: 150 } : undefined;
    const t = await toPlanGate(o, repo);
    o.decide(t.id, 'plan', 'approved');
    await until(() => runner.of('techlead', 'review').length === 1);
    o.sendMessage(t.id, 'Check the error handling');
    const ack = of('agent.message').at(-1)!;
    expect(ack.role).toBe('techlead');
    expect(ack.text).toMatch(/Got it/);
    await o.idle();
    const second = runner.of('techlead', 'review')[1];
    expect(second.o.prompt.indexOf('<owner-notes>')).toBeGreaterThan(-1);
    expect(second.o.prompt.indexOf('<owner-notes>')).toBeLessThan(second.o.prompt.indexOf('Review the changes'));
    expect(second.o.prompt).toContain('Check the error handling');
  });

  it('message with no further step pending → role session resumed with it after its current run ends', async () => {
    const o = make();
    runner.script = c => c.o.role === 'frontend' && c.kind === 'stage' && !c.o.prompt.includes('owner-notes')
      ? { result: 'done', write: { 'ui.txt': 'ui\n' }, delay: 120 } : undefined;
    const t = await toPlanGate(o, repo);
    o.decide(t.id, 'plan', 'approved');
    await until(() => runner.of('frontend', 'stage').length === 1 && runner.of('backend', 'stage')[0]?.ended !== undefined);
    o.sendMessage(t.id, 'Make the link bold');
    await o.idle();
    const fes = runner.of('frontend');
    const delivery = fes.find(c => c.o.prompt.includes('Make the link bold'))!;
    expect(delivery).toBeTruthy();
    expect(delivery.o.resume).toBe(o.find(t.id)!.sessions!.frontend);
    expect(delivery.started).toBeGreaterThan(fes[0].ended!);
    // delivered before the stage commit and the review
    expect(delivery.ended!).toBeLessThan(runner.of('techlead', 'review')[0].started);
  });

  it('PM note at the plan gate is held for a re-plan; on approval the PM session is resumed with it', async () => {
    const o = make();
    const t = await toPlanGate(o, repo);
    o.sendMessage(t.id, 'Keep it small');
    await o.idle();
    expect(runner.of('pm')).toHaveLength(1);
    o.decide(t.id, 'plan', 'approved');
    await o.idle();
    const last = runner.of('pm').at(-1)!;
    expect(last.o.prompt).toContain('Keep it small');
    expect(last.o.resume).toBe(o.find(t.id)!.sessions!.pm);
    expect(o.find(t.id)!.openGate).toBe('final');
  });

  it('PM note at the final gate resumes the PM session right away', async () => {
    const o = make();
    const t = await toFinal(o, repo);
    const n = runner.of('pm').length;
    o.sendMessage(t.id, 'Nice work');
    await o.idle();
    expect(runner.of('pm')).toHaveLength(n + 1);
    expect(runner.of('pm').at(-1)!.o.prompt).toContain('Nice work');
  });
});

describe('ClaudeOrchestrator: ask vs ticket', () => {
  let repo: string;
  beforeEach(() => { repo = mkRepo(); });
  const ANSWER = { kind: 'answer', answer: '## Buttons\n- Save\n- Cancel' };
  const ask = async (o: ClaudeOrchestrator, mode: 'auto' | 'ask' | 'ticket', text = 'List all the buttons in Leave') => {
    const t = o.startTicket(project(repo), text, { mode });
    await o.idle();
    return t;
  };
  const expectAnswered = (o: ClaudeOrchestrator, id: string, text: string) => {
    const t = o.find(id)!;
    expect(t.status).toBe('done');
    expect(t.answered).toBe(true);
    expect(pmText()).toContain(text);
    const types = events.map(e => e.type);
    expect(types.indexOf('ticket.answered')).toBeGreaterThan(-1);
    expect(types.indexOf('ticket.answered')).toBeLessThan(types.indexOf('ticket.done'));
    expect(types).toContain('ticket.usage');
    expect(types).not.toContain('gate.open');
    expect(types).not.toContain('ticket.plan');
    expect(types).not.toContain('ticket.workspace');
    expect(runner.calls.every(c => c.o.role === 'pm')).toBe(true);
    expect(fs.existsSync(workspacePath(dataDir, 'p1', id))).toBe(false);
    expect(states('pm').slice(-2)).toEqual(['done', 'idle']);
    expect(o.current('p1')).toBeUndefined();
  };

  it('auto: the PM may answer → answer message, ticket.answered, done (no gate, worktree or other roles)', async () => {
    const o = make();
    runner.script = c => c.o.role === 'pm' ? { result: fence(ANSWER) } : undefined;
    const t = await ask(o, 'auto');
    expect(t.mode).toBe('auto');
    expect(o.find(t.id)!.mode).toBe('auto');
    const p = runner.of('pm')[0].o.prompt;
    expect(p).toContain('"kind": "answer"');
    expect(p).toContain('"kind": "plan"');
    expect(runner.of('pm')).toHaveLength(1);
    expectAnswered(o, t.id, '- Save\n- Cancel');
  });

  it('auto: a plan reply still goes to the plan gate', async () => {
    const o = make();
    runner.script = c => c.o.role === 'pm' ? { result: fence({ kind: 'plan', ...PLAN }) } : undefined;
    const t = await ask(o, 'auto', 'Add a forgot password link');
    expect(o.find(t.id)!.openGate).toBe('plan');
    expect(o.find(t.id)!.answered).toBeUndefined();
  });

  it('auto: prose without any JSON is treated as the answer (no fixJson retry)', async () => {
    const o = make();
    runner.script = c => c.o.role === 'pm' ? { result: 'There are two buttons: Save and Cancel.' } : undefined;
    const t = await ask(o, 'auto');
    expect(runner.of('pm').map(c => c.kind)).toEqual(['plan']);
    expectAnswered(o, t.id, 'There are two buttons: Save and Cancel.');
  });

  it('auto: prose carrying a broken plan ("summary"/"tasks") gets the fixJson retry, not an answer', async () => {
    const o = make();
    runner.script = (c, n) => c.o.role !== 'pm' ? undefined
      : c.kind === 'plan' && n === 1 ? { result: 'Plan: "summary": "Add link", "tasks": [ {"role": "frontend"' } : undefined;
    const t = await ask(o, 'auto', 'Add a forgot password link');
    expect(runner.of('pm').map(c => c.kind)).toEqual(['plan', 'fixjson']);
    expect(o.find(t.id)!.openGate).toBe('plan');
    expect(o.find(t.id)!.answered).toBeUndefined();
  });

  it('auto: broken JSON still gets the one fixJson retry', async () => {
    const o = make();
    runner.script = (c, n) => c.o.role !== 'pm' ? undefined
      : c.kind === 'plan' && n === 1 ? { result: '```json\n{ "kind": "answer", \n```' } : { result: fence(ANSWER) };
    const t = await ask(o, 'auto');
    expect(runner.of('pm').map(c => c.kind)).toEqual(['plan', 'fixjson']);
    expectAnswered(o, t.id, '- Save');
  });

  it('ask: the prompt requires an answer and never a plan; a plan reply is refused', async () => {
    const o = make();
    runner.script = (c) => c.o.role !== 'pm' ? undefined
      : c.kind === 'plan' ? { result: fence(PLAN) } : { result: fence(ANSWER) };
    const t = await ask(o, 'ask');
    const p = runner.of('pm')[0].o.prompt;
    expect(p).toContain('"kind": "answer"');
    expect(p).not.toContain('"tasks"');
    expect(runner.of('pm').map(c => c.kind)).toEqual(['plan', 'fixjson']);
    expectAnswered(o, t.id, '- Save');
  });

  it('ask: prose is the answer', async () => {
    const o = make();
    runner.script = c => c.o.role === 'pm' ? { result: 'Save and Cancel.' } : undefined;
    const t = await ask(o, 'ask');
    expectAnswered(o, t.id, 'Save and Cancel.');
  });

  it('ask needs no git: a plain folder is answered (auto/ticket still require a repo)', async () => {
    const o = make();
    runner.script = c => c.o.role === 'pm' ? { result: fence(ANSWER) } : undefined;
    const plain = tmp('po-plain-');
    const t = o.startTicket(project(plain), 'What is in here?', { mode: 'ask' });
    await o.idle();
    expect(o.find(t.id)).toMatchObject({ status: 'done', answered: true });
    expect(runner.of('pm')[0].o.cwd).toBe(plain);
  });

  it('ticket: the prompt only offers a plan; an answer reply is not accepted', async () => {
    const o = make();
    runner.script = (c) => c.o.role !== 'pm' ? undefined : c.kind === 'plan' ? { result: fence(ANSWER) } : { result: fence(PLAN) };
    const t = await ask(o, 'ticket');
    const p = runner.of('pm')[0].o.prompt;
    expect(p).not.toContain('"kind": "answer"');
    expect(runner.of('pm').map(c => c.kind)).toEqual(['plan', 'fixjson']);
    expect(o.find(t.id)!.openGate).toBe('plan');
    expect(o.find(t.id)!.answered).toBeUndefined();
  });

  it('a follow-up on an answered ticket resumes the PM session (and can become a plan)', async () => {
    const o = make();
    runner.script = c => c.o.role === 'pm' && c.kind === 'plan' && runner.of('pm').length === 1 ? { result: fence(ANSWER) } : undefined;
    const t1 = await ask(o, 'auto');
    expect(o.find(t1.id)!.answered).toBe(true);
    events = [];
    const t2 = o.startTicket(project(repo), 'ok, now write that to docs/buttons.md', { parentTicketId: t1.id, mode: 'auto' });
    await o.idle();
    const pm = runner.of('pm').at(-1)!.o;
    expect(pm.resume).toBe('pm-s1');
    expect(pm.prompt).toContain('follow-up');
    expect(pm.prompt).toContain('"kind": "answer"');
    expect(o.find(t2.id)!.openGate).toBe('plan');
  });
});

// real git in two repos per test: slower than the single-repo cases, especially when the suites run in parallel
describe('ClaudeOrchestrator: multi-repo projects', { timeout: 30_000 }, () => {
  let parent: string;
  let fe: string, be: string;
  const NAMES = ['angular', 'aspnet-core'];
  const wsOf = (id: string) => workspacePath(dataDir, 'p1', id);
  const writes = () => {
    runner.script = (c): Reply | undefined => c.kind !== 'stage' ? undefined
      : c.o.role === 'frontend' ? { result: 'done', write: { 'angular/ui.txt': 'ui\n' } }
        : c.o.role === 'backend' ? { result: 'done', write: { 'aspnet-core/api.txt': 'api\n' } } : undefined;
  };
  beforeEach(() => {
    parent = tmp('po-multi-');
    for (const n of NAMES) {
      const d = path.join(parent, n);
      fs.mkdirSync(d);
      fs.writeFileSync(path.join(d, 'a.txt'), `${n}\n`);
      git(d, 'init', '-q', '-b', 'main'); git(d, 'add', '-A'); git(d, 'commit', '-q', '-m', 'init');
    }
    fe = path.join(parent, 'angular'); be = path.join(parent, 'aspnet-core');
    const agents = path.join(parent, '.claude', 'agents');
    fs.mkdirSync(agents, { recursive: true });
    for (const r of CORE) fs.writeFileSync(path.join(agents, `${r}.md`), `agent ${r}\n`);
  });

  it('a parent of repos is not "not a git repo"; PM plans in the parent with the repos named', async () => {
    const o = make();
    const t = await toPlanGate(o, parent);
    expect(o.find(t.id)!.status).toBe('waiting');
    const pm = runner.of('pm')[0].o;
    expect(pm.cwd).toBe(parent);
    expect(pm.prompt).toContain('angular/');
    expect(pm.prompt).toContain('aspnet-core/');
  });

  it('workspace: one worktree per repo on the same branch, agents copied, non-PM cwd = workspace, per-repo commits, prefixed diff', async () => {
    const o = make();
    const t = await toPlanGate(o, parent);
    writes();
    o.decide(t.id, 'plan', 'approved');
    await o.idle();
    const ws = wsOf(t.id);
    const w = o.find(t.id)!.workspace!;
    expect(w.worktree).toBe(ws);
    expect(w.repos!.map(r => r.name)).toEqual(NAMES);
    for (const r of w.repos!) {
      expect(r.path).toBe(path.join(ws, r.name));
      expect(r.branch).toBe(w.branch);
      expect(r.base.branch).toBe('main');
      expect(r.detached).toBe(false);
      expect(git(r.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(w.branch);
    }
    expect(w.repos![0].base.head).toBe(git(fe, 'rev-parse', 'HEAD'));
    expect(w.repos![1].base.head).toBe(git(be, 'rev-parse', 'HEAD'));
    expect(fs.readFileSync(path.join(ws, '.claude', 'agents', 'frontend.md'), 'utf8')).toBe('agent frontend\n');
    for (const role of ['frontend', 'backend', 'techlead', 'qa'] as RoleId[]) {
      for (const c of runner.of(role)) expect(c.o.cwd).toBe(ws);
    }
    expect(runner.of('frontend', 'stage')[0].o.prompt).toContain('aspnet-core/');
    expect(git(path.join(ws, 'angular'), 'log', '--format=%s')).toContain('office: build (frontend, backend)');
    expect(git(path.join(ws, 'aspnet-core'), 'log', '--format=%s')).toContain('office: build (frontend, backend)');
    const files = of('ticket.diff').at(-1)!.files.map(f => f.path).sort();
    expect(files).toEqual(['angular/ui.txt', 'aspnet-core/api.txt']);
    const review = runner.of('techlead', 'review')[0].o.prompt;
    expect(review).toContain('angular/ui.txt');
    expect(review).toMatch(/aspnet-core\/api\.txt \(\+1/);
    expect(o.find(t.id)!.openGate).toBe('final');
    // owner's repos untouched before approval
    expect(fs.existsSync(path.join(fe, 'ui.txt'))).toBe(false);
  });

  it('fair review: the ticket register in the parent folder (outside every repo) is a note, not a bounce', async () => {
    const o = make();
    writes();
    const base = runner.script;
    runner.script = (c, n) => c.kind === 'review'
      ? { result: fence({ approved: false, issues: [{ role: 'frontend', file: 'docs/tickets/ticket-register.md', note: 'add the ticket to the register' }] }) }
      : base(c, n);
    const t = await toPlanGate(o, parent);
    o.decide(t.id, 'plan', 'approved');
    await o.idle();
    expect(runner.calls.filter(c => c.kind === 'bounce')).toHaveLength(0);
    expect(runner.of('techlead', 'review')).toHaveLength(1);
    expect(o.find(t.id)!.openGate).toBe('final');
    expect(pmText()).toContain('docs/tickets/ticket-register.md');
  });

  it('fair review: an issue with no file inside a repo is a note; one inside a repo still bounces', async () => {
    const o = make();
    writes();
    const base = runner.script;
    runner.script = (c, n) => c.kind === 'review' && n === 1
      ? { result: fence({ approved: false, issues: [
        { role: 'techlead', file: '', note: 'QA has not checked it yet' },
        { role: 'frontend', file: 'angular/ui.txt', note: 'typo in the label' }] }) }
      : base(c, n);
    const t = await toPlanGate(o, parent);
    o.decide(t.id, 'plan', 'approved');
    await o.idle();
    const b = runner.calls.filter(c => c.kind === 'bounce');
    expect(b.map(c => c.o.role)).toEqual(['frontend']);
    expect(b[0].o.prompt).toContain('typo in the label');
    expect(b[0].o.prompt).not.toContain('QA has not checked');
    expect(pmText()).toContain('QA has not checked it yet');
    expect(o.find(t.id)!.openGate).toBe('final');
  });

  it('re-detects repos at ticket start (project record without repos still works as multi-repo)', async () => {
    const o = make();
    const t = await toPlanGate(o, parent);
    writes();
    o.decide(t.id, 'plan', 'approved');
    await o.idle();
    expect(o.find(t.id)!.workspace!.repos).toHaveLength(2);
  });

  it('final approve merges every changed repo, never an unchanged one; cleans up worktrees + workspace', async () => {
    const o = make();
    const t = await toPlanGate(o, parent);
    runner.script = c => c.kind === 'stage' && c.o.role === 'frontend' ? { result: 'done', write: { 'angular/ui.txt': 'ui\n' } }
      : c.kind === 'stage' ? { result: 'done' } : undefined;
    o.decide(t.id, 'plan', 'approved');
    await o.idle();
    const beHead = git(be, 'rev-parse', 'HEAD');
    const feHead = git(fe, 'rev-parse', 'HEAD');
    o.decide(t.id, 'final', 'approved');
    await o.idle();
    expect(o.find(t.id)!.status).toBe('done');
    expect(git(fe, 'rev-parse', 'HEAD')).not.toBe(feHead);
    expect(fs.existsSync(path.join(fe, 'ui.txt'))).toBe(true);
    expect(git(be, 'rev-parse', 'HEAD')).toBe(beHead);
    expect(fs.existsSync(wsOf(t.id))).toBe(false);
    expect(git(fe, 'worktree', 'list')).not.toContain(t.id);
    expect(git(be, 'worktree', 'list')).not.toContain(t.id);
    expect(pmText()).toMatch(/Merged office\/.* into main in angular/);
    const w = o.find(t.id)!.workspace!;
    expect(w.merged).toBe(true);
    expect(w.repos!.find(r => r.name === 'angular')!.merged).toBe(true);
    expect(w.repos!.find(r => r.name === 'aspnet-core')!.merged).toBeUndefined();
  });

  it('preflight: one changed repo dirty → nothing merged, per-repo instructions, done', async () => {
    const o = make();
    const t = await toPlanGate(o, parent);
    writes();
    o.decide(t.id, 'plan', 'approved');
    await o.idle();
    const heads = [git(fe, 'rev-parse', 'HEAD'), git(be, 'rev-parse', 'HEAD')];
    fs.writeFileSync(path.join(be, 'dirty.txt'), 'x');
    o.decide(t.id, 'final', 'approved');
    await o.idle();
    expect(o.find(t.id)!.status).toBe('done');
    expect([git(fe, 'rev-parse', 'HEAD'), git(be, 'rev-parse', 'HEAD')]).toEqual(heads);
    const text = pmText();
    expect(text).toMatch(/Nothing was merged/);
    expect(text).toContain('aspnet-core');
    expect(text).toContain(`cd "${fe}"`);
    expect(text).toContain(`cd "${be}"`);
    expect(o.find(t.id)!.workspace!.merged).toBeUndefined();
  });

  it('a merge failing part-way: earlier repos merged (with revert lines), later ones not (with manual commands)', async () => {
    const o = make();
    const t = await toPlanGate(o, parent);
    writes();
    o.decide(t.id, 'plan', 'approved');
    await o.idle();
    // the owner commits a conflicting file in aspnet-core meanwhile
    fs.writeFileSync(path.join(be, 'api.txt'), 'mine\n');
    git(be, 'add', '-A'); git(be, 'commit', '-q', '-m', 'mine');
    const beHead = git(be, 'rev-parse', 'HEAD');
    o.decide(t.id, 'final', 'approved');
    await o.idle();
    expect(o.find(t.id)!.status).toBe('done');
    const feMerge = git(fe, 'rev-parse', 'HEAD');
    expect(git(fe, 'log', '-1', '--format=%s')).toMatch(/^Merge office\//);
    expect(git(be, 'rev-parse', 'HEAD')).toBe(beHead);
    const text = pmText();
    expect(text).toContain(`git revert -m 1 ${feMerge}`);
    expect(text).toMatch(/aspnet-core.*not merged/is);
    expect(text).toContain(`cd "${be}"`);
    const w = o.find(t.id)!.workspace!;
    expect(w.merged).toBeUndefined();
    expect(w.repos!.find(r => r.name === 'angular')!.merged).toBe(true);
  });

  it('cancel removes every repo worktree and the workspace folder; branches kept', async () => {
    const o = make();
    const t = await toPlanGate(o, parent);
    runner.script = c => c.kind === 'stage' ? { hang: true } : undefined;
    o.decide(t.id, 'plan', 'approved');
    await until(() => runner.of('frontend', 'stage').length === 1);
    expect(fs.existsSync(path.join(wsOf(t.id), 'angular', '.git'))).toBe(true);
    o.cancel(t.id);
    await o.idle();
    expect(fs.existsSync(wsOf(t.id))).toBe(false);
    for (const r of [fe, be]) {
      expect(git(r, 'branch', '--list', 'office/*')).toContain('office/');
      expect(git(r, 'worktree', 'list')).not.toContain(t.id);
    }
  });

  it('resume after a restart rebuilds the workspace from the log (worktrees recreated)', async () => {
    const o = make();
    runner.script = c => c.o.role === 'frontend' && c.kind === 'stage' ? { hang: true }
      : c.o.role === 'backend' && c.kind === 'stage' ? { result: 'done', write: { 'aspnet-core/api.txt': 'api\n' } } : undefined;
    const t = await toPlanGate(o, parent);
    o.decide(t.id, 'plan', 'approved');
    await until(() => runner.of('frontend', 'stage').length === 1 && runner.of('backend', 'stage')[0]?.ended !== undefined);
    await o.shutdown(50);
    const log = new TicketLog(path.join(dataDir, 'tickets'));
    log.recover();
    // the workspace was removed meanwhile
    for (const r of [fe, be]) git(r, 'worktree', 'remove', '--force', path.join(wsOf(t.id), path.basename(r)));
    fs.rmSync(wsOf(t.id), { recursive: true, force: true });
    const r2 = new FakeRunner();
    // (the interrupted stage's uncommitted work went with the removed worktree: both builders redo theirs)
    r2.script = (c): Reply | undefined => c.kind !== 'stage' ? undefined
      : c.o.role === 'frontend' ? { result: 'done', write: { 'angular/ui.txt': 'ui\n' } }
        : c.o.role === 'backend' ? { result: 'done', write: { 'aspnet-core/api.txt': 'api\n' } } : undefined;
    const ev: ServerEvent[] = [];
    const o2 = new ClaudeOrchestrator({ log, runner: r2, dataDir, getProject: () => project(parent) });
    o2.onEvent(e => ev.push(e));
    o2.resume(t.id);
    await o2.idle();
    expect(r2.of('frontend', 'stage')[0].o.cwd).toBe(wsOf(t.id));
    expect(o2.find(t.id)!.openGate).toBe('final');
    const diff = ev.filter(e => e.type === 'ticket.diff').at(-1) as Extract<ServerEvent, { type: 'ticket.diff' }>;
    expect(diff.files.map(f => f.path).sort()).toEqual(['angular/ui.txt', 'aspnet-core/api.txt']);
  });

  it('parent docs: CLAUDE.md + docs/**/*.md (≤ 2 MB) copied into <workspace>/_project for non-PM roles; owner files untouched', async () => {
    const o = make();
    fs.writeFileSync(path.join(parent, 'CLAUDE.md'), '# rules\n');
    fs.mkdirSync(path.join(parent, 'docs', 'tickets'), { recursive: true });
    fs.writeFileSync(path.join(parent, 'docs', 'tickets', 'ticket-register.md'), '| id |\n');
    fs.writeFileSync(path.join(parent, 'docs', 'logo.png'), 'png');
    fs.writeFileSync(path.join(parent, 'docs', 'x-big.md'), 'a'.repeat(1_500_000));
    fs.writeFileSync(path.join(parent, 'docs', 'y-big.md'), 'b'.repeat(1_000_000));
    const t = await toPlanGate(o, parent);
    writes();
    o.decide(t.id, 'plan', 'approved');
    await o.idle();
    const proj = path.join(wsOf(t.id), '_project');
    expect(fs.readFileSync(path.join(proj, 'CLAUDE.md'), 'utf8')).toBe('# rules\n');
    expect(fs.readFileSync(path.join(proj, 'docs', 'tickets', 'ticket-register.md'), 'utf8')).toBe('| id |\n');
    expect(fs.existsSync(path.join(proj, 'docs', 'logo.png'))).toBe(false);
    expect(fs.existsSync(path.join(proj, 'docs', 'x-big.md'))).toBe(true);
    expect(fs.existsSync(path.join(proj, 'docs', 'y-big.md'))).toBe(false); // over the 2 MB budget
    for (const role of ['frontend', 'backend', 'techlead', 'qa'] as RoleId[]) {
      const first = runner.of(role).find(c => c.kind !== 'bounce')!.o;
      expect(first.prompt).toContain('_project/');
      expect(first.prompt).toContain(path.join(parent, 'CLAUDE.md'));
      expect(first.addDirs).toBeUndefined(); // read-only copies, not --add-dir (which acceptEdits could write to)
    }
    expect(runner.of('pm')[0].o.prompt).not.toContain('_project');
    expect(fs.readFileSync(path.join(parent, 'docs', 'tickets', 'ticket-register.md'), 'utf8')).toBe('| id |\n');
    expect(of('ticket.diff').at(-1)!.files.map(f => f.path).some(p => p.includes('_project'))).toBe(false);
  });

  it('review guard: a path without the repo prefix that exists in a repo (or its folder does) is a real issue', async () => {
    const o = make();
    fs.mkdirSync(path.join(fe, 'src', 'app'), { recursive: true });
    fs.writeFileSync(path.join(fe, 'src', 'app', 'x.ts'), 'x\n');
    git(fe, 'add', '-A'); git(fe, 'commit', '-q', '-m', 'src');
    writes();
    const base = runner.script;
    runner.script = (c, n) => c.kind === 'review' && n === 1
      ? { result: fence({ approved: false, issues: [
        { role: 'frontend', file: 'src\\app\\x.ts:12', note: 'null check missing' },
        { role: 'frontend', file: 'src/app/new-file.ts', note: 'create the helper' },
        { role: 'frontend', file: 'docs/tickets/ticket-register.md:3', note: 'register' }] }) }
      : base(c, n);
    const t = await toPlanGate(o, parent);
    o.decide(t.id, 'plan', 'approved');
    await o.idle();
    const b = runner.of('frontend', 'bounce');
    expect(b).toHaveLength(1);
    expect(b[0].o.prompt).toContain('null check missing');
    expect(b[0].o.prompt).toContain('create the helper');
    expect(b[0].o.prompt).not.toContain('register');
    expect(pmText()).toContain('docs/tickets/ticket-register.md');
    expect(o.find(t.id)!.openGate).toBe('final');
  });

  it('resume keeps the parent-docs hint when <workspace>/_project exists (even if the parent docs are gone)', async () => {
    const o = make();
    fs.writeFileSync(path.join(parent, 'CLAUDE.md'), '# rules\n');
    runner.script = c => c.o.role === 'frontend' && c.kind === 'stage' ? { hang: true }
      : c.o.role === 'backend' && c.kind === 'stage' ? { result: 'done', write: { 'aspnet-core/api.txt': 'api\n' } } : undefined;
    const t = await toPlanGate(o, parent);
    o.decide(t.id, 'plan', 'approved');
    await until(() => runner.of('frontend', 'stage').length === 1 && runner.of('backend', 'stage')[0]?.ended !== undefined);
    await o.shutdown(50);
    const log = new TicketLog(path.join(dataDir, 'tickets'));
    log.recover();
    fs.rmSync(path.join(parent, 'CLAUDE.md'));
    expect(fs.existsSync(path.join(wsOf(t.id), '_project', 'CLAUDE.md'))).toBe(true);
    const r2 = new FakeRunner();
    const o2 = new ClaudeOrchestrator({ log, runner: r2, dataDir, getProject: () => project(parent) });
    o2.resume(t.id);
    await o2.idle();
    expect(r2.of('frontend', 'stage')[0].o.prompt).toContain('_project/');
    expect(r2.of('techlead', 'review')[0].o.prompt).toContain('_project/');
  });

  it('parent docs: none in the parent → no _project folder and no prompt line', async () => {
    const o = make();
    const t = await toPlanGate(o, parent);
    writes();
    o.decide(t.id, 'plan', 'approved');
    await o.idle();
    expect(fs.existsSync(path.join(wsOf(t.id), '_project'))).toBe(false);
    expect(runner.of('frontend', 'stage')[0].o.prompt).not.toContain('_project');
  });

  it('follow-up of an unmerged multi-repo parent continues on the same branch in every repo', async () => {
    const o = make();
    const t1 = await toPlanGate(o, parent);
    writes();
    o.decide(t1.id, 'plan', 'approved');
    await o.idle();
    fs.writeFileSync(path.join(fe, 'dirty.txt'), 'x');
    o.decide(t1.id, 'final', 'approved');
    await o.idle();
    fs.rmSync(path.join(fe, 'dirty.txt'));
    const pw = o.find(t1.id)!.workspace!;
    expect(fs.existsSync(pw.worktree)).toBe(false);
    const t2 = o.startTicket(project(parent), 'More', { parentTicketId: t1.id });
    await o.idle();
    o.decide(t2.id, 'plan', 'approved');
    await o.idle();
    const w = o.find(t2.id)!.workspace!;
    expect(w.worktree).toBe(pw.worktree);
    for (const r of w.repos!) {
      expect(r.branch).toBe(pw.branch);
      expect(git(r.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(pw.branch);
    }
  });

  it('follow-up after a partial merge: merged repos get their current HEAD as the new base', async () => {
    const o = make();
    const t1 = await toPlanGate(o, parent);
    writes();
    o.decide(t1.id, 'plan', 'approved');
    await o.idle();
    fs.writeFileSync(path.join(be, 'api.txt'), 'mine\n');
    git(be, 'add', '-A'); git(be, 'commit', '-q', '-m', 'mine');
    const beBase = o.find(t1.id)!.workspace!.repos![1].base.head;
    o.decide(t1.id, 'final', 'approved');
    await o.idle();
    expect(o.find(t1.id)!.workspace!.repos![0].merged).toBe(true);
    const t2 = o.startTicket(project(parent), 'More', { parentTicketId: t1.id });
    await o.idle();
    o.decide(t2.id, 'plan', 'approved');
    await o.idle();
    const w = o.find(t2.id)!.workspace!;
    expect(w.repos![0].base.head).toBe(git(fe, 'rev-parse', 'HEAD'));
    expect(w.repos![1].base.head).toBe(beBase);
    expect(of('ticket.diff').at(-1)!.files.map(f => f.path)).not.toContain('angular/ui.txt');
  });

  it('a cleanup failure after the merge (Windows file locks) never fails the ticket', async () => {
    const o = make({ ...realGit, removeWorktree: async () => { throw new Error('EBUSY: resource busy or locked'); } });
    const t = await toPlanGate(o, parent);
    writes();
    o.decide(t.id, 'plan', 'approved');
    await o.idle();
    const rm = fs.rmSync;
    const ws = wsOf(t.id);
    (fs as any).rmSync = (p: fs.PathLike, opts?: fs.RmOptions) => {
      if (path.resolve(String(p)) === path.resolve(ws)) throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
      return rm(p, opts);
    };
    try {
      o.decide(t.id, 'final', 'approved');
      await o.idle();
    } finally { (fs as any).rmSync = rm; }
    expect(o.find(t.id)!.status).toBe('done');
    expect(fs.existsSync(path.join(fe, 'ui.txt'))).toBe(true);
    expect(o.find(t.id)!.workspace!.merged).toBe(true);
    expect(of('log.raw').map(e => e.line).join('\n')).toMatch(/left for manual cleanup/);
    for (const r of [fe, be]) git(r, 'worktree', 'remove', '--force', path.join(ws, path.basename(r)));
  });

  it('node_modules: junction to the owner\'s copy, never committed, unlinked before removal (owner copy survives)', async () => {
    const nm = path.join(fe, 'node_modules');
    fs.mkdirSync(path.join(nm, 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(nm, 'pkg', 'marker.txt'), 'keep\n');
    fs.writeFileSync(path.join(fe, '.gitignore'), 'node_modules/\n');
    git(fe, 'add', '-A'); git(fe, 'commit', '-q', '-m', 'ignore');
    const o = make();
    const t = await toPlanGate(o, parent);
    let linked = false;
    runner.script = (c): Reply | undefined => {
      if (c.kind !== 'stage') return undefined;
      const wnm = path.join(c.o.cwd, 'angular', 'node_modules');
      linked ||= fs.lstatSync(wnm).isSymbolicLink() && fs.existsSync(path.join(wnm, 'pkg', 'marker.txt'));
      return c.o.role === 'frontend' ? { result: 'done', write: { 'angular/ui.txt': 'ui\n' } } : { result: 'done' };
    };
    o.decide(t.id, 'plan', 'approved');
    await o.idle();
    expect(linked).toBe(true);
    expect(fs.existsSync(path.join(wsOf(t.id), 'aspnet-core', 'node_modules'))).toBe(false);
    expect(runner.of('frontend', 'stage')[0].o.prompt).toMatch(/never run npm install/);
    expect(git(path.join(wsOf(t.id), 'angular'), 'ls-files')).not.toMatch(/node_modules/);
    expect(of('ticket.diff').at(-1)!.files.map(f => f.path)).toEqual(['angular/ui.txt']);
    o.decide(t.id, 'final', 'approved');
    await o.idle();
    expect(o.find(t.id)!.status).toBe('done');
    expect(fs.existsSync(wsOf(t.id))).toBe(false);
    expect(fs.readFileSync(path.join(nm, 'pkg', 'marker.txt'), 'utf8')).toBe('keep\n');
    expect(git(fe, 'status', '--porcelain')).toBe('');
  });
});


describe('short worktree paths (Windows 260-char limit)', () => {
  it('keeps the workspace path short: <dataDir>/wt/<8>/<8>', () => {
    const p = workspacePath('D:/data', '7f3c2a1b-1111-2222-3333-444444444444', '9e8d7c6b-5555-6666-7777-888888888888');
    expect(p).toBe(path.join('D:/data', 'wt', '7f3c2a1b', '9e8d7c6b'));
  });
});
