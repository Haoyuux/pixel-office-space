import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  applyTicketEvent, type AgentState, type GateDecision, type GateKind, type Plan, type PlanTask, type Project, type RoleId,
  type ServerEvent, type Stage, type Ticket,
} from '@office/shared';
import { ConflictError, ValidationError, type Orchestrator } from './types';
import { titleOf } from './fakeContent';
import type { TicketLog } from '../ticketLog';
import type { RunOptions, RunResult, RunnerEvent } from '../claude/runner';
import * as realGit from '../claude/git';
import { newTranslateContext, translate } from '../claude/translate';
import { MAX_TURNS, ROLE_TOOLS } from '../claude/roles';
import { bouncePrompt, fixJsonPrompt, planPrompt, reviewPrompt, stagePrompt, testPrompt } from '../claude/prompts';
import { extractJson, planValidator, reviewValidator, testValidator, type PlanWithMap } from '../claude/parse';

export { ConflictError };

/** The subset of ClaudeRunner the orchestrator needs (tests inject a fake). */
export interface Runner { run(o: RunOptions): Promise<RunResult> }
export type GitApi = Pick<typeof realGit,
  'isRepo' | 'hasCommit' | 'baseInfo' | 'createWorktree' | 'commitAll' | 'diff' | 'mergeIntoBase' | 'removeWorktree' | 'slug'>;

export interface ClaudeOrchestratorOptions {
  log: TicketLog;
  runner: Runner;
  git?: GitApi;
  /** Worktrees live in <dataDir>/worktrees/<projectId>/<ticketId>. */
  dataDir: string;
  now?: () => Date;
}

type WorkStage = 'design' | 'build' | 'review' | 'test' | 'docs';
type BounceFrom = 'review' | 'test';
const PIPELINE: WorkStage[] = ['design', 'build', 'review', 'test', 'docs'];
const STAGE_ROLES: Record<WorkStage, RoleId[]> = {
  design: ['uiux'], build: ['frontend', 'backend', 'devops'], review: ['techlead', 'security'], test: ['qa'], docs: ['writer'],
};
const STAGE_STATE: Record<Exclude<Stage, 'done'>, AgentState> = {
  plan: 'planning', design: 'designing', build: 'coding', review: 'reviewing', test: 'testing', docs: 'documenting',
};
const BUSY: AgentState[] = ['summoned', 'planning', 'designing', 'coding', 'reviewing', 'testing', 'documenting', 'waiting'];
const WORKING: AgentState[] = ['planning', 'designing', 'coding', 'reviewing', 'testing', 'documenting'];
const GATE_DECISIONS: Record<GateKind, GateDecision[]> = {
  plan: ['approved', 'changes'], final: ['approved', 'changes'], stuck: ['retry', 'accept', 'cancel'],
};
export const MAX_BOUNCES = 3;
export const NOT_A_GIT_REPO = 'not-a-git-repo';
const MAP_FILE = path.join('.claude', 'office', 'project-map.md');

interface Issue { role: RoleId; file?: string; note: string }

interface Run {
  ticket: Ticket; project: Project; seq: number;
  plan?: Plan; projectMap?: string;
  bounces: Record<BounceFrom, number>; stuckFrom?: BounceFrom; lastIssues: Issue[];
  sessions: Partial<Record<RoleId, string>>;
  /** Per-role chain so two runs never share a session concurrently. */
  locks: Map<RoleId, Promise<unknown>>;
  aborts: Set<AbortController>;
  inflight: Set<Promise<unknown>>;
  notes: Partial<Record<RoleId, string[]>>;
  base?: { branch: string; head: string };
  wt?: { path: string; branch: string };
  usage: { turns: number; costUsd: number; durationMs: number };
  /** Set once the ticket ended (done/failed/cancelled): late async results are dropped. */
  ended: boolean;
}

class Ended extends Error { constructor() { super('ticket ended'); this.name = 'Ended'; } }
class StageFailed extends Error {}

export class ClaudeOrchestrator implements Orchestrator {
  private runs = new Map<string, Run>();
  private currentByProject = new Map<string, string>();
  private queues = new Map<string, string[]>();
  private listeners: ((e: ServerEvent) => void)[] = [];
  private pending = new Set<Promise<unknown>>();
  private git: GitApi;
  private now: () => Date;

  constructor(private opts: ClaudeOrchestratorOptions) {
    this.git = opts.git ?? realGit;
    this.now = opts.now ?? (() => new Date());
  }

  onEvent(cb: (e: ServerEvent) => void) { this.listeners.push(cb); }

  /** Resolves once no background work is pending (tests). */
  async idle(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  startTicket(project: Project, text: string): Ticket {
    const ticket: Ticket = {
      id: randomUUID(), projectId: project.id, title: titleOf(text), text, status: 'queued', stage: null,
      agentStates: {}, createdAt: this.now().toISOString(),
    };
    const run = this.newRun(project, ticket, 0);
    this.emit(run, { type: 'ticket.created', ticket });
    this.enqueue(run);
    return run.ticket;
  }

  adopt(project: Project, ticket: Ticket): void {
    const run = this.newRun(project, ticket, 1_000_000);
    run.sessions = { ...(ticket.sessions ?? {}) };
    this.enqueue(run);
  }

  decide(ticketId: string, gate: GateKind, decision: GateDecision, note?: string): void {
    if (!GATE_DECISIONS[gate]?.includes(decision)) throw new ValidationError(`Decision ${decision} is not valid for ${gate}`);
    const run = this.runs.get(ticketId);
    if (!run || run.ended || run.ticket.openGate !== gate) throw new ConflictError(`Gate ${gate} is not open`);
    this.emit(run, { type: 'gate.closed', gate, decision, note });
    if (gate === 'plan') {
      if (decision === 'changes') return this.bg(run, () => this.runPlan(run, note));
      this.summonTeam(run);
      return this.bg(run, async () => { await this.prepareWorktree(run); await this.next(run, null); });
    }
    if (gate === 'final') {
      if (decision === 'changes') return this.bg(run, () => this.reworkFinal(run, note));
      return this.bg(run, () => this.approveFinal(run));
    }
    // stuck
    if (decision === 'cancel') { this.finish(run, 'cancelled'); return; }
    const from = run.stuckFrom ?? 'review';
    run.stuckFrom = undefined;
    if (decision === 'retry') {
      run.bounces[from] = 0;
      if (note) for (const i of run.lastIssues) i.note = `${i.note}\nOwner note: ${note}`;
      return this.bg(run, async () => { await this.bounce(run, run.lastIssues); await this.runStage(run, from); });
    }
    run.bounces = { review: 0, test: 0 };
    return this.bg(run, () => this.next(run, from));
  }

  sendMessage(ticketId: string, text: string): void {
    const run = this.runs.get(ticketId);
    if (!run || (run.ticket.status !== 'running' && run.ticket.status !== 'waiting')) throw new ConflictError('Ticket is not running');
    this.emit(run, { type: 'user.message', text });
    const states = run.ticket.agentStates;
    const active = (Object.keys(states) as RoleId[]).find(r => WORKING.includes(states[r]!)) ?? 'pm';
    (run.notes[active] ??= []).push(text);
    this.message(run, active, `Got it — "${titleOf(text)}". I'll take that into account on my next step.`);
  }

  cancel(ticketId: string): void {
    const run = this.runs.get(ticketId);
    if (!run) throw new ConflictError('Unknown ticket');
    const q = this.queues.get(run.project.id) ?? [];
    if (q.includes(ticketId)) {
      this.queues.set(run.project.id, q.filter(id => id !== ticketId));
      run.ended = true;
      this.emit(run, { type: 'ticket.cancelled' });
      return;
    }
    if (run.ended || this.currentByProject.get(run.project.id) !== ticketId) throw new ConflictError('Ticket is not active');
    this.finish(run, 'cancelled');
  }

  current(projectId: string) { const id = this.currentByProject.get(projectId); return id ? this.runs.get(id)!.ticket : undefined; }
  queue(projectId: string) { return (this.queues.get(projectId) ?? []).map(id => this.runs.get(id)!.ticket); }
  find(ticketId: string) { return this.runs.get(ticketId)?.ticket; }
  busyRoles(projectId: string): RoleId[] {
    const t = this.current(projectId);
    if (!t) return [];
    return (Object.keys(t.agentStates) as RoleId[]).filter(r => BUSY.includes(t.agentStates[r]!));
  }

  // ---- pipeline ----

  private newRun(project: Project, ticket: Ticket, seq: number): Run {
    const run: Run = {
      ticket, project, seq, bounces: { review: 0, test: 0 }, lastIssues: [], sessions: {}, locks: new Map(),
      aborts: new Set(), inflight: new Set(), notes: {}, usage: { turns: 0, costUsd: 0, durationMs: 0 }, ended: false,
    };
    this.runs.set(ticket.id, run);
    return run;
  }

  /** Run an async pipeline step in the background; errors fail the ticket (unless it already ended). */
  private bg(run: Run, fn: () => Promise<void>): void {
    const p = fn().catch((err: unknown) => {
      if (run.ended || err instanceof Ended) return;
      this.finish(run, 'failed', err instanceof Error ? err.message : String(err));
    });
    this.pending.add(p);
    void p.finally(() => this.pending.delete(p));
  }

  private enqueue(run: Run) {
    const pid = run.project.id;
    if (!this.currentByProject.has(pid)) { this.currentByProject.set(pid, run.ticket.id); this.bg(run, () => this.start(run)); }
    else this.queues.set(pid, [...(this.queues.get(pid) ?? []), run.ticket.id]);
  }

  private async start(run: Run) {
    const folder = run.project.folder;
    if (!(await this.git.isRepo(folder)) || !(await this.git.hasCommit(folder))) {
      this.alive(run);
      this.message(run, 'pm', `"${folder}" is not a git repository with at least one commit. ` +
        'Pixel Office works on a git branch so your files stay safe. Use "Initialize git" and try again.');
      this.finish(run, 'failed', NOT_A_GIT_REPO);
      return;
    }
    await this.runPlan(run);
  }

  private async runPlan(run: Run, note?: string) {
    this.alive(run);
    this.emit(run, { type: 'ticket.stage', stage: 'plan', roles: ['pm'] });
    if (!run.ticket.agentStates.pm) this.state(run, 'pm', 'summoned');
    this.state(run, 'pm', 'planning');
    const folder = run.project.folder;
    let prompt: string;
    let resume: string | undefined;
    if (note && run.sessions.pm) {
      this.message(run, 'pm', `Re-planning with your note: "${titleOf(note)}"`);
      resume = run.sessions.pm;
      prompt = `The owner asked for changes to your plan:\n<owner-note>\n${note}\n</owner-note>\n` +
        `Revise the plan and reply with the full corrected plan as one fenced \`\`\`json block in the same shape as before.`;
    } else {
      if (note) this.message(run, 'pm', `Re-planning with your note: "${titleOf(note)}"`);
      const mapFile = path.join(folder, MAP_FILE);
      const map = fs.existsSync(mapFile) ? fs.readFileSync(mapFile, 'utf8') : undefined;
      prompt = planPrompt(run.ticket, run.project, map);
      if (note) prompt += `\n\nOwner note on the previous plan:\n<owner-note>\n${note}\n</owner-note>`;
    }
    const plan = await this.structured(run, 'pm', 'plan', folder, prompt, resume, planValidator(run.project.team), 'plan');
    const { projectMap, ...clean } = plan;
    run.plan = clean;
    if (projectMap) run.projectMap = projectMap;
    this.emit(run, { type: 'ticket.plan', plan: clean });
    this.message(run, 'pm', `Plan ready: ${clean.tasks.length} tasks. Waiting for your approval.`);
    this.state(run, 'pm', 'waiting');
    this.emit(run, { type: 'gate.open', gate: 'plan', payload: clean });
  }

  private async prepareWorktree(run: Run) {
    if (run.wt) return;
    const folder = run.project.folder;
    const info = await this.git.baseInfo(folder);
    this.alive(run);
    run.base = { branch: info.branch, head: info.head };
    const wtPath = path.join(this.opts.dataDir, 'worktrees', run.project.id, run.ticket.id);
    const branch = `office/${this.git.slug(run.ticket.title)}-${run.ticket.id.slice(0, 6)}`;
    run.wt = await this.git.createWorktree(folder, wtPath, branch, info.head);
    if (run.ended) { await this.git.removeWorktree(folder, run.wt.path); throw new Ended(); }
    if (run.projectMap) {
      const f = path.join(run.wt.path, MAP_FILE);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, run.projectMap);
    }
    this.log(run, 'pm', `Working on branch ${run.wt.branch} (base ${info.branch} @ ${info.head.slice(0, 7)})`);
  }

  private tasked(run: Run): Set<RoleId> {
    const team = run.project.team;
    return new Set((run.plan?.tasks ?? []).map(t => t.role).filter(r => team.includes(r)));
  }

  private rolesFor(run: Run, stage: WorkStage): RoleId[] {
    const tasked = this.tasked(run);
    return STAGE_ROLES[stage].filter(r => tasked.has(r));
  }

  private summonTeam(run: Run) {
    for (const r of this.tasked(run)) if (r !== 'pm') this.state(run, r, 'summoned');
  }

  private async next(run: Run, after: WorkStage | null): Promise<void> {
    this.alive(run);
    const start = after ? PIPELINE.indexOf(after) + 1 : 0;
    const stage = PIPELINE.slice(start).find(s => this.rolesFor(run, s).length > 0);
    if (stage) return this.runStage(run, stage);
    await this.commit(run, 'office: final');
    const files = await this.git.diff(run.project.folder, run.base!.head, run.wt!.branch);
    this.alive(run);
    this.emit(run, { type: 'ticket.diff', files });
    this.message(run, 'pm', 'All stages done. Please review the final changes.');
    this.emit(run, { type: 'gate.open', gate: 'final', payload: null });
  }

  private async runStage(run: Run, stage: WorkStage): Promise<void> {
    this.alive(run);
    const roles = this.rolesFor(run, stage);
    this.emit(run, { type: 'ticket.stage', stage, roles });
    for (const r of roles) this.state(run, r, STAGE_STATE[stage]);
    const cwd = run.wt!.path;
    const team = run.project.team;

    if (stage === 'review' || stage === 'test') {
      const issues: Issue[] = [];
      const unassigned: Issue[] = [];
      let approved = true;
      await Promise.all(roles.map(async role => {
        if (stage === 'review') {
          const v = await this.structured(run, role, 'review', cwd, this.withNotes(run, role, reviewPrompt(run.plan!)), run.sessions[role], reviewValidator(team), 'review');
          if (!v.approved || v.issues.length || v.unassigned.length) approved = false;
          issues.push(...v.issues); unassigned.push(...v.unassigned);
        } else {
          const v = await this.structured(run, role, 'test', cwd, this.withNotes(run, role, testPrompt(run.plan!)), run.sessions[role], testValidator(team), 'test results');
          if (!v.passed || v.failures.length || v.unassigned.length) approved = false;
          issues.push(...v.failures); unassigned.push(...v.unassigned);
        }
      }));
      this.alive(run);
      if (stage === 'test') await this.commit(run, 'office: test (qa)');
      for (const r of roles) this.state(run, r, 'waiting');
      if (unassigned.length) {
        this.message(run, 'pm', `Some ${stage} findings are for roles not on this team, so no one can fix them automatically:\n` +
          unassigned.map(i => `- [${i.role}] ${i.file ? i.file + ': ' : ''}${i.note}`).join('\n'));
      }
      // nobody on the team owns the problems (or a bare "not approved"): give them to the builders
      if (!approved && !issues.length) {
        const builders = this.rolesFor(run, 'build');
        const note = unassigned.length ? unassigned.map(i => i.note).join('\n') : `The ${stage === 'review' ? 'review' : 'tests'} did not pass.`;
        for (const b of builders) issues.push({ role: b, note });
      }
      if (approved || !issues.length) return this.next(run, stage);
      run.lastIssues = issues;
      run.bounces[stage]++;
      const who = stage === 'review' ? roles[0] : 'qa';
      if (run.bounces[stage] >= MAX_BOUNCES) {
        run.stuckFrom = stage;
        this.message(run, who, `This has bounced ${MAX_BOUNCES} times. I need your call.`);
        this.emit(run, { type: 'gate.open', gate: 'stuck', payload: { from: stage, bounces: run.bounces[stage], issues } });
        return;
      }
      this.message(run, who, stage === 'review'
        ? `Found ${issues.length} issue(s). Sending it back:\n${issues.map(i => `- [${i.role}] ${i.file ? i.file + ': ' : ''}${i.note}`).join('\n')}`
        : `Tests failed. Sending it back:\n${issues.map(i => `- [${i.role}] ${i.note}`).join('\n')}`);
      await this.bounce(run, issues);
      return this.runStage(run, stage);
    }

    // design / build / docs: tasked roles work in parallel in the same worktree
    await Promise.all(roles.map(role => {
      const task = run.plan!.tasks.filter(t => t.role === role);
      const merged: PlanTask = { role, text: task.map(t => t.text).join('\n'), files: task.flatMap(t => t.files) };
      const prompt = stagePrompt(stage, role, merged, run.plan!, this.takeNotes(run, role));
      return this.exec(run, role, stage, cwd, prompt, run.sessions[role]);
    }));
    this.alive(run);
    await this.commit(run, `office: ${stage} (${roles.join(', ')})`);
    for (const r of roles) this.state(run, r, 'waiting');
    return this.next(run, stage);
  }

  /** Resume each owning dev's session with its issues, in parallel, then commit. */
  private async bounce(run: Run, issues: Issue[]) {
    this.alive(run);
    const owners = [...new Set(issues.map(i => i.role))];
    this.emit(run, { type: 'ticket.stage', stage: 'build', roles: owners });
    for (const r of owners) this.state(run, r, 'coding');
    await Promise.all(owners.map(role => {
      const mine = issues.filter(i => i.role === role);
      const notes = this.takeNotes(run, role);
      const extra = notes.length ? mine.concat(notes.map(n => ({ role, note: `Owner: ${n}` }))) : mine;
      return this.exec(run, role, 'build', run.wt!.path, bouncePrompt(extra), run.sessions[role]);
    }));
    this.alive(run);
    await this.commit(run, `office: fixes (${owners.join(', ')})`);
    for (const r of owners) this.state(run, r, 'waiting');
  }

  private async reworkFinal(run: Run, note?: string) {
    const builders = this.rolesFor(run, 'build');
    if (note) {
      this.message(run, 'pm', `Passing your note to the team: "${titleOf(note)}"`);
      for (const r of builders.length ? builders : [...this.tasked(run)]) (run.notes[r] ??= []).push(note);
    }
    if (builders.length) return this.runStage(run, 'build');
    return this.next(run, null);
  }

  private async approveFinal(run: Run) {
    const folder = run.project.folder;
    const { branch } = run.wt!;
    const res = await this.git.mergeIntoBase(folder, branch, run.base!.branch);
    this.alive(run);
    if (res.merged) {
      this.message(run, 'pm', `Merged ${branch} into ${run.base!.branch}.`);
    } else {
      this.message(run, 'pm', `Merge pending: ${res.reason}\nYour work is safe on branch ${branch}. To merge it yourself, run:\n${res.instructions}`);
    }
    await this.git.removeWorktree(folder, run.wt!.path).catch(() => undefined);
    this.finish(run, 'done');
  }

  // ---- runs ----

  /** A run whose final text must parse; one fixJson resume, then fail showing the role's text. */
  private async structured<T>(
    run: Run, role: RoleId, stage: Exclude<Stage, 'done'>, cwd: string, prompt: string, resume: string | undefined,
    validate: (v: unknown) => T | null, what: string,
  ): Promise<T> {
    const r1 = await this.exec(run, role, stage, cwd, prompt, resume);
    const v1 = extractJson(r1.result, validate);
    if (v1) return v1;
    this.log(run, role, `[${role}] reply had no valid JSON ${what}; asking again`);
    const r2 = await this.exec(run, role, stage, cwd, fixJsonPrompt(), run.sessions[role] ?? r1.sessionId);
    const v2 = extractJson(r2.result, validate);
    if (v2) return v2;
    this.alive(run);
    this.message(run, role, r2.result || r1.result || '(no reply)');
    throw new StageFailed(`${roleName(role)} did not return a valid ${what}. Its reply is shown in the feed.`);
  }

  private exec(run: Run, role: RoleId, stage: Exclude<Stage, 'done'>, cwd: string, prompt: string, resume?: string): Promise<RunResult> {
    const prev = run.locks.get(role) ?? Promise.resolve();
    const p = prev.catch(() => undefined).then(() => this.execNow(run, role, stage, cwd, prompt, resume ?? run.sessions[role]));
    run.locks.set(role, p);
    run.inflight.add(p);
    void p.catch(() => undefined).finally(() => run.inflight.delete(p));
    return p;
  }

  private async execNow(run: Run, role: RoleId, stage: Exclude<Stage, 'done'>, cwd: string, prompt: string, resume?: string): Promise<RunResult> {
    this.alive(run);
    const ac = new AbortController();
    run.aborts.add(ac);
    const ctx = newTranslateContext(cwd);
    const maxTurns = MAX_TURNS[stage === 'plan' ? 'plan' : stage];
    let res: RunResult;
    try {
      res = await this.opts.runner.run({
        cwd, role, prompt, resume, allowedTools: ROLE_TOOLS[role], maxTurns, signal: ac.signal,
        onEvent: (e: RunnerEvent) => {
          if (run.ended) return;
          if (e.kind === 'init') this.session(run, role, e.sessionId);
          for (const p of translate(role, e, ctx)) this.emit(run, p as Record<string, unknown> & { type: ServerEvent['type'] });
        },
      });
    } catch (err) {
      if (run.ended) throw new Ended();
      throw new StageFailed(`${roleName(role)} run failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      run.aborts.delete(ac);
    }
    if (run.ended) throw new Ended();
    run.usage.turns += res.numTurns || 0;
    run.usage.costUsd += res.costUsd || 0;
    run.usage.durationMs += res.durationMs || 0;
    if (res.sessionId) this.session(run, role, res.sessionId);
    if (res.isError || (res.exitCode !== null && res.exitCode !== 0) || (res.subtype && res.subtype !== 'success')) {
      const why = res.subtype === 'error_max_turns' ? `hit the turn limit (${maxTurns})` : (res.result || res.subtype || `exit ${res.exitCode}`);
      throw new StageFailed(`${roleName(role)} could not finish the ${stage} step: ${why}`);
    }
    return res;
  }

  private session(run: Run, role: RoleId, sessionId: string) {
    if (run.sessions[role] === sessionId) return;
    run.sessions[role] = sessionId;
    this.emit(run, { type: 'agent.session', role, sessionId });
  }

  private takeNotes(run: Run, role: RoleId): string[] {
    const n = run.notes[role] ?? [];
    delete run.notes[role];
    return n;
  }

  private withNotes(run: Run, role: RoleId, prompt: string): string {
    const n = this.takeNotes(run, role);
    return n.length ? `${prompt}\n\n<owner-notes>\n${n.map(x => `- ${x}`).join('\n')}\n</owner-notes>` : prompt;
  }

  private async commit(run: Run, msg: string) {
    if (!run.wt) return;
    await this.git.commitAll(run.wt.path, msg);
    this.alive(run);
  }

  private alive(run: Run) { if (run.ended) throw new Ended(); }

  private finish(run: Run, how: 'done' | 'cancelled' | 'failed', reason = '') {
    if (run.ended) return;
    run.ended = true;
    for (const ac of run.aborts) ac.abort();
    run.aborts.clear();
    // cancel removes the worktree (branch kept); a failed ticket keeps it so its work can be inspected/resumed
    if (how === 'cancelled' && run.wt) {
      const wt = run.wt;
      const inflight = [...run.inflight];
      const p = Promise.allSettled(inflight).then(() => this.git.removeWorktree(run.project.folder, wt.path)).catch(() => undefined);
      this.pending.add(p);
      void p.finally(() => this.pending.delete(p));
    }
    const roles = Object.keys(run.ticket.agentStates) as RoleId[];
    if (run.usage.turns || run.usage.costUsd || run.usage.durationMs) this.emit(run, { type: 'ticket.usage', ...run.usage });
    if (how === 'done') {
      for (const r of roles) this.state(run, r, 'done');
      this.emit(run, { type: 'ticket.done' });
    } else if (how === 'cancelled') this.emit(run, { type: 'ticket.cancelled' });
    else this.emit(run, { type: 'ticket.failed', reason });
    for (const r of roles) this.state(run, r, 'idle');
    const pid = run.project.id;
    this.currentByProject.delete(pid);
    const [nextId, ...rest] = this.queues.get(pid) ?? [];
    this.queues.set(pid, rest);
    if (nextId) {
      const nxt = this.runs.get(nextId)!;
      this.currentByProject.set(pid, nextId);
      this.bg(nxt, () => this.start(nxt));
    }
  }

  // ---- emit helpers ----

  private state(run: Run, role: RoleId, state: AgentState) { this.emit(run, { type: 'agent.state', role, state }); }
  private log(run: Run, role: RoleId, line: string) { this.emit(run, { type: 'log.raw', role, line }); }
  private message(run: Run, role: RoleId, text: string) {
    this.emit(run, { type: 'agent.message', role, text, streaming: false, messageId: randomUUID() });
    this.log(run, role, `[${role}] ${text}`);
  }
  private emit(run: Run, partial: Record<string, unknown> & { type: ServerEvent['type'] }) {
    const e = { ...partial, projectId: run.project.id, ticketId: run.ticket.id, seq: ++run.seq, ts: this.now().toISOString() } as ServerEvent;
    run.ticket = applyTicketEvent(run.ticket, e)!;
    this.opts.log.append(e);
    for (const l of this.listeners) l(e);
  }
}

const roleName = (r: RoleId) => r === 'pm' ? 'The PM' : `The ${r} agent`;
