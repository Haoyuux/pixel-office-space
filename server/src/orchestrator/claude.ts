import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  applyTicketEvent, type AgentState, type GateDecision, type GateKind, type Plan, type PlanTask, type Project, type RoleId,
  type ServerEvent, type Stage, type Ticket, type Workspace,
} from '@office/shared';
import { ConflictError, ValidationError, type Orchestrator, type StartOptions } from './types';
import { titleOf } from './fakeContent';
import type { TicketLog } from '../ticketLog';
import { killLiveSync, type RunOptions, type RunResult, type RunnerEvent } from '../claude/runner';
import * as realGit from '../claude/git';
import { newTranslateContext, translate } from '../claude/translate';
import { MAX_TURNS, ROLE_TOOLS } from '../claude/roles';
import {
  bouncePrompt, CONTINUE, deliverNotesPrompt, fixJsonPrompt, followUpPrompt, planPrompt, previousContext, reviewPrompt,
  stagePrompt, testPrompt, withOwnerNotes,
} from '../claude/prompts';
import { extractJson, planValidator, reviewValidator, testValidator, type PlanWithMap } from '../claude/parse';

export { ConflictError };

/** The subset of ClaudeRunner the orchestrator needs (tests inject a fake). */
export interface Runner { run(o: RunOptions): Promise<RunResult> }
export type GitApi = Pick<typeof realGit,
  'isRepo' | 'hasCommit' | 'baseInfo' | 'createWorktree' | 'commitAll' | 'diff' | 'mergeIntoBase' | 'removeWorktree' | 'slug'
  | 'attachWorktree' | 'branchExists' | 'excludePath'>;

export interface ClaudeOrchestratorOptions {
  log: TicketLog;
  runner: Runner;
  git?: GitApi;
  /** Worktrees live in <dataDir>/worktrees/<projectId>/<ticketId>. */
  dataDir: string;
  now?: () => Date;
  /** Current project record (Resume after a restart rebuilds the run from the log). */
  getProject?: (id: string) => Project | undefined;
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
const EDITORS: RoleId[] = ['frontend', 'backend', 'devops', 'uiux', 'writer'];
const TEST_FILE = /(^|[\\/])(tests?|__tests__|spec)[\\/]|\.(test|spec)\.[a-z0-9]+$/i;
const MAP_FILE = path.join('.claude', 'office', 'project-map.md');
const AGENTS_DIR = path.join('.claude', 'agents');

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
  /** The final merge is in progress: cancel is refused. */
  merging?: boolean;
  /** Set once the ticket ended (done/failed/cancelled): late async results are dropped. */
  ended: boolean;
  /** Follow-up: the parent ticket (loaded when this ticket starts, after the parent ended). */
  parent?: Ticket;
  /** Roles whose session came from the parent: if resuming it fails, fall back to a fresh session + context. */
  inherited: Set<RoleId>;
  fallback?: string;
  /** Resume (interrupted): roles whose next prompt starts with "Continue where you left off." */
  continuing: Set<RoleId>;
  resumeFrom?: { stage: Stage | null };
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
  /** Server is stopping: runs are aborted but tickets are left as they are (the next boot marks them interrupted). */
  private stopping = false;

  constructor(private opts: ClaudeOrchestratorOptions) {
    this.git = opts.git ?? realGit;
    this.now = opts.now ?? (() => new Date());
  }

  onEvent(cb: (e: ServerEvent) => void) { this.listeners.push(cb); }

  /** Resolves once no background work is pending (tests). */
  async idle(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  /**
   * Server stop: abort every live run, wait up to `waitMs` for the runs to end (the runner kills each process tree),
   * then force-kill any claude process still alive. Tickets are not failed: the next boot recovers them as interrupted.
   */
  async shutdown(waitMs = 7000): Promise<void> {
    this.stopping = true;
    const inflight: Promise<unknown>[] = [];
    for (const run of this.runs.values()) {
      for (const ac of run.aborts) ac.abort();
      run.aborts.clear();
      inflight.push(...run.inflight);
    }
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.allSettled(inflight),
      new Promise<void>(r => { timer = setTimeout(r, waitMs); timer.unref?.(); }),
    ]);
    clearTimeout(timer);
    killLiveSync();
  }

  startTicket(project: Project, text: string, opts: StartOptions = {}): Ticket {
    const ticket: Ticket = {
      id: randomUUID(), projectId: project.id, title: titleOf(text), text, status: 'queued', stage: null,
      agentStates: {}, createdAt: this.now().toISOString(), agentsMode: 'claude',
      ...(opts.parentTicketId ? { parentTicketId: opts.parentTicketId } : {}),
    };
    const run = this.newRun(project, ticket, 0);
    this.emit(run, { type: 'ticket.created', ticket });
    this.enqueue(run);
    return run.ticket;
  }

  adopt(project: Project, ticket: Ticket): void {
    const run = this.newRun(project, ticket, 1_000_000);
    run.sessions = { ...(ticket.sessions ?? {}) };
    if (ticket.usage) run.usage = { ...ticket.usage };
    this.enqueue(run);
  }

  /** Re-run a failed/interrupted ticket from its interrupted stage, resuming the stored sessions. */
  resume(ticketId: string): Ticket {
    const live = this.runs.get(ticketId);
    if (live && !live.ended) throw new ConflictError('Ticket is still active');
    const found = this.opts.log.find(ticketId);
    const ticket = found?.ticket ?? live?.ticket;
    if (!ticket) throw new ConflictError('Unknown ticket');
    if (ticket.status !== 'failed') throw new ConflictError('Only failed or interrupted tickets can be resumed');
    // tickets from before agents modes existed (no agentsMode) were all simulated: never resume them with real agents
    if (ticket.agentsMode !== 'claude') throw new ConflictError('Simulated tickets cannot be resumed');
    if (!Object.keys(ticket.sessions ?? {}).length && !ticket.workspace) {
      throw new ConflictError('Nothing to resume: this ticket has no stored agent sessions or branch');
    }
    const project = this.opts.getProject?.(ticket.projectId) ?? live?.project;
    if (!project) throw new ConflictError('Project not found');
    const seq = Math.max(0, ...(found?.events ?? []).map(e => (e as { seq?: number }).seq ?? 0), live?.seq ?? 0);
    const run = this.newRun(project, ticket, seq);
    run.sessions = { ...(ticket.sessions ?? {}) };
    run.plan = ticket.plan;
    if (ticket.usage) run.usage = { ...ticket.usage };
    if (ticket.workspace) {
      run.wt = { path: ticket.workspace.worktree, branch: ticket.workspace.branch };
      run.base = { ...ticket.workspace.base };
    }
    run.continuing = new Set(Object.keys(run.sessions) as RoleId[]);
    run.resumeFrom = { stage: ticket.stage };
    if (ticket.parentTicketId) run.parent = this.parentOf(ticket);
    // if a stored session has expired, the role restarts fresh with this ticket's plan + changes so far
    const files = (found?.events ?? []).filter(e => e.type === 'ticket.diff')
      .flatMap(e => (e as { files: { path: string }[] }).files.map(f => f.path));
    run.fallback = previousContext({ title: ticket.title, plan: ticket.plan, files: [...new Set(files)] });
    const queued = this.currentByProject.has(project.id);
    this.emit(run, { type: 'ticket.resumed', stage: ticket.stage, ...(queued ? { queued: true } : {}) });
    this.message(run, 'pm', `Resuming from the ${ticket.stage ?? 'plan'} stage.`);
    this.enqueue(run);
    return run.ticket;
  }

  decide(ticketId: string, gate: GateKind, decision: GateDecision, note?: string): void {
    if (!GATE_DECISIONS[gate]?.includes(decision)) throw new ValidationError(`Decision ${decision} is not valid for ${gate}`);
    const run = this.runs.get(ticketId);
    if (!run || run.ended || run.ticket.openGate !== gate) throw new ConflictError(`Gate ${gate} is not open`);
    this.emit(run, { type: 'gate.closed', gate, decision, note });
    if (gate === 'plan') {
      if (decision === 'changes') return this.bg(run, () => this.runPlan(run, note));
      this.summonTeam(run);
      // PM notes held for a re-plan: the plan was approved instead, so resume the PM with them now
      if (run.notes.pm?.length) this.bg(run, () => this.deliverNotes(run, 'pm'));
      return this.bg(run, async () => { await this.prepareWorktree(run); await this.next(run, null); });
    }
    if (gate === 'final') {
      if (decision === 'changes') return this.bg(run, () => this.reworkFinal(run, note));
      run.merging = true;
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
    // PM notes ride on its next step: the re-plan while planning / at the plan gate (delivered on approval otherwise).
    // Past the plan, the PM has no further step pending: resume its session with the note now (queued on its lock).
    const planPhase = states.pm === 'planning' || run.ticket.openGate === 'plan' || !run.plan;
    if (active === 'pm' && !planPhase && run.sessions.pm) this.bg(run, () => this.deliverNotes(run, 'pm'));
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
    if (run.merging) throw new ConflictError("Ticket is merging — can't cancel now");
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
      inherited: new Set(), continuing: new Set(),
    };
    this.runs.set(ticket.id, run);
    return run;
  }

  /** Run an async pipeline step in the background; errors fail the ticket (unless it already ended). */
  private bg(run: Run, fn: () => Promise<void>): void {
    const p = fn().catch((err: unknown) => {
      if (run.ended || this.stopping || err instanceof Ended) return;
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
    if (run.resumeFrom) return this.resumeStage(run);
    if (run.ticket.parentTicketId && !run.parent) this.inherit(run);
    await this.runPlan(run);
  }

  private parentOf(t: Ticket): Ticket | undefined {
    const id = t.parentTicketId!;
    const live = this.runs.get(id);
    return live?.ended || !live ? (this.opts.log.find(id)?.ticket ?? live?.ticket) : live.ticket;
  }

  /** Follow-up: take over the parent's sessions (each role resumes its own) and keep context for a fallback. */
  private inherit(run: Run) {
    const parent = this.parentOf(run.ticket);
    if (!parent) return;
    run.parent = parent;
    for (const [role, sid] of Object.entries(parent.sessions ?? {}) as [RoleId, string][]) {
      run.inherited.add(role);
      this.session(run, role, sid);
    }
    const files = (this.opts.log.find(parent.id)?.events ?? []).filter(e => e.type === 'ticket.diff')
      .flatMap(e => (e as { files: { path: string }[] }).files.map(f => f.path));
    run.fallback = previousContext({ title: parent.title, plan: parent.plan, files: [...new Set(files)] });
    this.log(run, 'pm', `Follow-up of "${parent.title}"`);
  }

  private async resumeStage(run: Run) {
    const stage = run.resumeFrom!.stage;
    run.resumeFrom = undefined;
    if (!run.plan || stage === null || stage === 'plan') {
      if (run.plan) {
        this.state(run, 'pm', 'waiting');
        this.emit(run, { type: 'gate.open', gate: 'plan', payload: run.plan });
        return;
      }
      return this.runPlan(run);
    }
    this.summonTeam(run);
    await this.prepareWorktree(run);
    if (run.base && run.wt) {
      // refresh the fallback context with what the branch already holds (best effort)
      const files = await this.git.diff(run.project.folder, run.base.head, run.wt.branch).catch(() => []);
      this.alive(run);
      if (files.length) run.fallback = previousContext({ title: run.ticket.title, plan: run.plan, files: files.map(f => f.path) });
    }
    if (stage === 'done') return this.next(run, 'docs');
    const work = stage as WorkStage;
    if (this.rolesFor(run, work).length) return this.runStage(run, work);
    return this.next(run, work);
  }

  private async runPlan(run: Run, note?: string) {
    this.alive(run);
    this.emit(run, { type: 'ticket.stage', stage: 'plan', roles: ['pm'] });
    if (!run.ticket.agentStates.pm) this.state(run, 'pm', 'summoned');
    this.state(run, 'pm', 'planning');
    const folder = run.project.folder;
    let prompt: string;
    let resume: string | undefined;
    let fresh: string | undefined;
    const mapFile = path.join(folder, MAP_FILE);
    const readMap = () => fs.existsSync(mapFile) ? fs.readFileSync(mapFile, 'utf8') : undefined;
    if (!note && run.continuing.has('pm') && run.sessions.pm) {
      resume = run.sessions.pm;
      prompt = 'As the project manager, reply with the full plan as one fenced ```json block in the required shape.';
      fresh = (run.fallback ?? '') + planPrompt(run.ticket, run.project, readMap());
    } else if (!note && run.parent && !run.plan) {
      fresh = (run.fallback ?? '') + planPrompt(run.ticket, run.project, readMap());
      if (run.inherited.has('pm') && run.sessions.pm) { resume = run.sessions.pm; prompt = followUpPrompt(run.ticket, run.project); }
      else prompt = fresh;
    } else if (note && run.sessions.pm) {
      this.message(run, 'pm', `Re-planning with your note: "${titleOf(note)}"`);
      resume = run.sessions.pm;
      prompt = `The owner asked for changes to your plan:\n<owner-note>\n${note}\n</owner-note>\n` +
        `Revise the plan and reply with the full corrected plan as one fenced \`\`\`json block in the same shape as before.`;
    } else {
      if (note) this.message(run, 'pm', `Re-planning with your note: "${titleOf(note)}"`);
      prompt = planPrompt(run.ticket, run.project, readMap());
      if (note) prompt += `\n\nOwner note on the previous plan:\n<owner-note>\n${note}\n</owner-note>`;
    }
    prompt = this.withNotes(run, 'pm', prompt);
    const plan = await this.structured(run, 'pm', 'plan', folder, prompt, resume, planValidator(run.project.team), 'plan', fresh);
    const { projectMap, ...clean } = plan;
    run.plan = clean;
    if (projectMap) run.projectMap = projectMap;
    this.emit(run, { type: 'ticket.plan', plan: clean });
    this.message(run, 'pm', `Plan ready: ${clean.tasks.length} tasks. Waiting for your approval.`);
    this.state(run, 'pm', 'waiting');
    this.emit(run, { type: 'gate.open', gate: 'plan', payload: clean });
  }

  private async prepareWorktree(run: Run) {
    const folder = run.project.folder;
    if (run.wt) {
      // Resume: the worktree may have been removed since; re-attach the branch
      if (!fs.existsSync(path.join(run.wt.path, '.git'))) run.wt = await this.git.attachWorktree(folder, run.wt.path, run.wt.branch);
      this.alive(run);
      await this.provisionAgents(run);
      return;
    }
    const pws = run.parent?.workspace;
    if (pws && !pws.merged && await this.git.branchExists(folder, pws.branch)) {
      // follow-up of an unmerged ticket: continue on the same branch (worktree recreated if removed)
      run.base = { ...pws.base };
      run.wt = await this.git.attachWorktree(folder, pws.worktree, pws.branch);
      this.alive(run);
      await this.provisionAgents(run);
      this.workspace(run);
      this.log(run, 'pm', `Continuing on branch ${run.wt.branch}`);
      return;
    }
    const info = await this.git.baseInfo(folder);
    this.alive(run);
    run.base = { branch: info.branch, head: info.head };
    const wtPath = path.join(this.opts.dataDir, 'worktrees', run.project.id, run.ticket.id);
    const branch = `office/${this.git.slug(run.ticket.title)}-${run.ticket.id.slice(0, 6)}`;
    run.wt = await this.git.createWorktree(folder, wtPath, branch, info.head);
    if (run.ended) { await this.git.removeWorktree(folder, run.wt.path); throw new Ended(); }
    await this.provisionAgents(run);
    this.workspace(run);
    if (run.projectMap) {
      const f = path.join(run.wt.path, MAP_FILE);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, run.projectMap);
    }
    if (info.branch === 'HEAD') {
      this.message(run, 'pm', 'Heads-up: your project folder is on a detached HEAD (not on a branch). I will work on a new branch, ' +
        'but it cannot be merged automatically at the end; you will get the commands to run.');
    }
    this.log(run, 'pm', `Working on branch ${run.wt.branch} (base ${info.branch} @ ${info.head.slice(0, 7)})`);
  }

  /**
   * The owner's `.claude/agents/*.md` are often untracked (scaffolded into a pre-existing repo), so a worktree made
   * from HEAD lacks them and `--agent <role>` would not find its definition: copy the missing ones in, and exclude
   * the folder so commitAll never commits them.
   */
  private async provisionAgents(run: Run) {
    if (!run.wt) return;
    const src = path.join(run.project.folder, AGENTS_DIR);
    const dst = path.join(run.wt.path, AGENTS_DIR);
    const files = fs.existsSync(src) ? fs.readdirSync(src).filter(f => f.endsWith('.md')) : [];
    for (const f of files) {
      if (fs.existsSync(path.join(dst, f))) continue; // tracked in the repo (or already copied): keep the branch's copy
      fs.mkdirSync(dst, { recursive: true });
      fs.copyFileSync(path.join(src, f), path.join(dst, f));
    }
    await this.git.excludePath(run.wt.path, '/.claude/agents/');
    this.alive(run);
  }

  /**
   * Roles with a plan task that are still on the team (a role can be removed while the plan gate is open). Reviewers
   * (techlead, security) and QA on the team are always included once any design/build role is tasked, so review and
   * test never depend on the PM tasking them.
   */
  private tasked(run: Run): Set<RoleId> {
    const team = run.project.team;
    const set = new Set((run.plan?.tasks ?? []).map(t => t.role).filter(r => team.includes(r)));
    if ([...STAGE_ROLES.design, ...STAGE_ROLES.build].some(r => set.has(r))) {
      for (const r of [...STAGE_ROLES.review, ...STAGE_ROLES.test]) if (team.includes(r)) set.add(r);
    }
    return set;
  }

  /**
   * Route review/test issues to roles that can fix them: tasked editable roles keep theirs (qa only for test files
   * flagged by review); everything else (pm, reviewers, untasked or off-team roles) goes to every tasked builder.
   */
  private route(run: Run, stage: BounceFrom, issues: Issue[]): Issue[] {
    const tasked = this.tasked(run);
    const can = (i: Issue) => tasked.has(i.role) && (EDITORS.includes(i.role)
      || (i.role === 'qa' && stage === 'review' && !!i.file && TEST_FILE.test(i.file)));
    let fixers = this.rolesFor(run, 'build');
    if (!fixers.length) fixers = [...tasked].filter(r => EDITORS.includes(r));
    const out: Issue[] = [];
    for (const i of issues) {
      if (can(i)) out.push(i);
      else for (const f of fixers) out.push({ role: f, file: i.file, note: `[for ${i.role}] ${i.note}` });
    }
    return out;
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
        this.message(run, 'pm', `Some ${stage} findings are for roles not on this team; passing them to the builders:\n` +
          unassigned.map(i => `- [${i.role}] ${i.file ? i.file + ': ' : ''}${i.note}`).join('\n'));
      }
      const all: Issue[] = [...issues, ...unassigned];
      // a bare "not approved" with no items still goes to the builders
      if (!approved && !all.length) all.push({ role: 'pm', note: `The ${stage === 'review' ? 'review' : 'tests'} did not pass.` });
      issues.splice(0, issues.length, ...this.route(run, stage, all));
      if (approved || !issues.length) {
        // no further step is pending for these roles: deliver any owner notes that arrived during the stage
        for (const r of roles) await this.deliverNotes(run, r);
        return this.next(run, stage);
      }
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
    // messages that arrived during this stage: no further step is pending for these roles, deliver now
    await Promise.all(roles.map(r => this.deliverNotes(run, r)));
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

  /**
   * Final "Request changes": the note goes straight to every tasked builder and Build re-runs. Deliberate deviation
   * from design §5 step 9 ("PM decides which devs" by resuming the PM's session), ratified by the designer.
   */
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
      this.workspace(run, true);
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
    validate: (v: unknown) => T | null, what: string, fresh?: string,
  ): Promise<T> {
    const r1 = await this.exec(run, role, stage, cwd, prompt, resume, fresh);
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

  /**
   * Queue a run on the role's session (never two at once). A resumed session that came from a parent ticket or
   * from Resume ("Continue where you left off.") and fails (expired) falls back to a fresh session given the plan + diff.
   */
  private exec(run: Run, role: RoleId, stage: Exclude<Stage, 'done'>, cwd: string, prompt: string, resume?: string, fresh?: string): Promise<RunResult> {
    const prev = run.locks.get(role) ?? Promise.resolve();
    const p = prev.catch(() => undefined).then(async () => {
      const sid = resume ?? run.sessions[role];
      let text = prompt;
      const continuing = !!sid && run.continuing.delete(role);
      if (continuing) text = `${CONTINUE}\n\n${prompt}`;
      if (!sid || !(run.inherited.has(role) || continuing)) return this.execNow(run, role, stage, cwd, text, sid);
      try {
        const r = await this.execNow(run, role, stage, cwd, text, sid);
        run.inherited.delete(role);
        return r;
      } catch (err) {
        if (!(err instanceof StageFailed)) throw err;
        run.inherited.delete(role);
        delete run.sessions[role];
        this.log(run, role, `[${role}] previous conversation could not be resumed; starting fresh with its summary`);
        return this.execNow(run, role, stage, cwd, fresh ?? (run.fallback ?? '') + prompt, undefined);
      }
    });
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
      if (run.ended || this.stopping) throw new Ended();
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
    return withOwnerNotes(prompt, this.takeNotes(run, role));
  }

  /** Resume the role's session with its pending owner notes (queued behind its current run). Never fails the ticket. */
  private async deliverNotes(run: Run, role: RoleId): Promise<void> {
    if (!run.notes[role]?.length || !run.sessions[role] || run.ended) return;
    const notes = this.takeNotes(run, role);
    const stage = role === 'pm' ? 'plan' : (PIPELINE.find(s => STAGE_ROLES[s].includes(role)) ?? 'build');
    const cwd = role === 'pm' || !run.wt ? run.project.folder : run.wt.path;
    try { await this.exec(run, role, stage, cwd, deliverNotesPrompt(notes), run.sessions[role]); }
    catch (err) {
      if (err instanceof Ended || run.ended) return;
      this.log(run, role, `[${role}] could not deliver your note: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private workspace(run: Run, merged = false) {
    if (!run.wt || !run.base) return;
    const ws: Workspace = { branch: run.wt.branch, worktree: run.wt.path, base: { ...run.base }, ...(merged ? { merged } : {}) };
    this.emit(run, { type: 'ticket.workspace', workspace: ws });
  }

  private async commit(run: Run, msg: string) {
    if (!run.wt) return;
    await this.git.commitAll(run.wt.path, msg);
    this.alive(run);
  }

  private alive(run: Run) { if (run.ended || this.stopping) throw new Ended(); }

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
