import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { Project, RoleId, ServerEvent } from '@office/shared';
import { ClaudeOrchestrator, NOT_A_GIT_REPO } from '../src/orchestrator/claude';
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
const make = () => {
  runner = new FakeRunner(); events = []; dataDir = tmp('po-data-');
  const o = new ClaudeOrchestrator({ log: new TicketLog(path.join(dataDir, 'tickets')), runner, dataDir });
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
    const wt = path.join(dataDir, 'worktrees', 'p1', t.id);
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
    expect(git(path.join(dataDir, 'worktrees', 'p1', t.id), 'log', '--format=%s')).toContain('office: fixes (backend)');
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

  it('final approve → merged into the base when clean (base advanced); usage emitted', async () => {
    const o = make();
    const t = await toFinal(o, repo);
    const before = git(repo, 'rev-parse', 'HEAD');
    o.decide(t.id, 'final', 'approved');
    await o.idle();
    expect(o.find(t.id)!.status).toBe('done');
    expect(git(repo, 'rev-parse', 'HEAD')).not.toBe(before);
    expect(fs.existsSync(path.join(repo, 'ui.txt'))).toBe(true);
    expect(fs.existsSync(path.join(dataDir, 'worktrees', 'p1', t.id))).toBe(false);
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
    const wt = path.join(dataDir, 'worktrees', 'p1', t.id);
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
    expect(fs.existsSync(path.join(dataDir, 'worktrees', 'p1', t.id))).toBe(false);
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
    const wt = path.join(dataDir, 'worktrees', 'p1', t.id);
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
    expect(fs.existsSync(path.join(dataDir, 'worktrees', 'p1', t.id))).toBe(false);
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
    expect(fe.o.cwd).toBe(path.join(dataDir, 'worktrees', 'p1', t.id));
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
