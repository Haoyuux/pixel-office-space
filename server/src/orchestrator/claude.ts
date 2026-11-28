import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  applyTicketEvent, type AgentState, type Attachment, type GateDecision, type GateKind, type Plan, type PlanTask, type Project, type RoleId,
  type RepoDetection, type RepoRef, type ServerEvent, type Stage, type Ticket, type TicketMode, type Workspace,
} from '@office/shared';
import { ConflictError, ValidationError, type Orchestrator, type StartOptions, type StopOutcome } from './types';
import { titleOf } from './fakeContent';
import type { TicketLog } from '../ticketLog';
import { killLiveSync, type Effort, type RunOptions, type RunResult, type RunnerEvent } from '../claude/runner';
import * as realGit from '../claude/git';
import { newTranslateContext, openStreams, translate, type TranslateContext } from '../claude/translate';
import { attachmentsDir, attachmentsNote } from '../attachments';
import { MAX_TURNS, ROLE_TOOLS } from '../claude/roles';
import {
  bouncePrompt, CONTINUE, deliverNotesPrompt, diffSummary, fixJsonPrompt, followUpPrompt, planPrompt, previousContext,
  projectDocsRule, repoContext, reviewPrompt, SHARED_MODULES_RULE, stagePrompt, teamMemoryBlock, testPrompt, withOwnerNotes,
} from '../claude/prompts';
import type { MemoryStore } from '../memory';
import { Installer, needsApproval, parseInstallRequests } from '../installer';
import { extractJson, isProse, pmValidator, reviewValidator, testValidator, type PmReply } from '../claude/parse';

export { ConflictError };

/** The subset of ClaudeRunner the orchestrator needs (tests inject a fake). */
export interface Runner { run(o: RunOptions): Promise<RunResult> }
export type GitApi = Pick<typeof realGit,
  'isRepo' | 'hasCommit' | 'baseInfo' | 'createWorktree' | 'commitAll' | 'diff' | 'mergeIntoBase' | 'removeWorktree' | 'slug'
  | 'attachWorktree' | 'branchExists' | 'excludePath' | 'detectRepos'>;

export interface ClaudeOrchestratorOptions {
  log: TicketLog;
  runner: Runner;
  git?: GitApi;
  /** Worktrees live in workspacePath(dataDir, projectId, ticketId) — short on purpose (Windows 260-char paths). */
  dataDir: string;
  now?: () => Date;
  /** Current project record (Resume after a restart rebuilds the run from the log). */
  getProject?: (id: string) => Project | undefined;
  /** Repo detection at ticket start (the server stores it on the project). */
  onDetect?: (projectId: string, d: RepoDetection) => void;
  /** Streaming text deltas are coalesced to at most one event per this many ms per message (tests: 0). */
  deltaIntervalMs?: number;
  /** Team memory: read into every agent prompt; the PM's lessons are added when a ticket/answer completes. */
  memory?: Pick<MemoryStore, 'list' | 'learn'>;
  /** Runs the npm installs agents ask for (`INSTALL:` lines) in the owner's folder. */
  installer?: Pick<Installer, 'install' | 'lockOnly'>;
}

export const STOPPED_TEXT = 'Stopped by you.';

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
  plan: ['approved', 'changes'], final: ['approved', 'changes'], stuck: ['retry', 'accept', 'cancel'], install: ['approved', 'skip'],
};
export const MAX_BOUNCES = 3;
export const NOT_A_GIT_REPO = 'not-a-git-repo';
const EDITORS: RoleId[] = ['frontend', 'backend', 'devops', 'uiux', 'writer'];
const TEST_FILE = /(^|[\\/])(tests?|__tests__|spec)[\\/]|\.(test|spec)\.[a-z0-9]+$/i;
const MAP_FILE = path.join('.claude', 'office', 'project-map.md');
const AGENTS_DIR = path.join('.claude', 'agents');

interface Issue { role: RoleId; file?: string; note: string }

/** One repo's worktree for a ticket. Single-repo projects have one unit named '' whose path is the workspace. */
interface Unit {
  name: string; /** the owner's repo */ repo: string; /** its worktree */ path: string; branch: string;
  base: { branch: string; head: string }; merged?: boolean;
  /** `<path>/node_modules` is a junction to the owner's repo's node_modules. */
  sharedModules?: boolean;
}
/** Where the non-PM roles work: the one worktree (single repo) or a plain folder holding one worktree per repo. */
interface Ws {
  path: string; multi: boolean; units: Unit[];
  /** Multi-repo: the parent folder's CLAUDE.md / docs were copied into `<path>/_project/`. */
  docs?: boolean;
}

interface Run {
  ticket: Ticket; project: Project; seq: number;
  plan?: Plan; projectMap?: string;
  /** The PM's lessons for the team memory (plan/answer JSON "memory"), added once the ticket ends done. */
  lessons?: string[];
  bounces: Record<BounceFrom, number>; stuckFrom?: BounceFrom; lastIssues: Issue[];
  /** The last fix round (bounce) changed no files: a plain "one more round" would repeat it. */
  idleBounce?: boolean;
  sessions: Partial<Record<RoleId, string>>;
  /** Per-role chain so two runs never share a session concurrently. */
  locks: Map<RoleId, Promise<unknown>>;
  aborts: Set<AbortController>;
  inflight: Set<Promise<unknown>>;
  /** Translate contexts of the live runs (their streaming text is kept when the owner stops). */
  streams: Set<TranslateContext>;
  notes: Partial<Record<RoleId, string[]>>;
  ws?: Ws;
  /** Multi-repo project: the repos detected when the ticket started. */
  repos?: RepoRef[];
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
  /** New packages agents asked for: they wait for the owner's OK (install gate) at the end of the stage. */
  pendingInstalls: InstallAsk[];
  /** An install ran during the current review/test stage. */
  installed: boolean;
  /** The stage already re-ran once because of an install since the last bounce. */
  installRerun: Partial<Record<BounceFrom, boolean>>;
  /** The stage the install gate continues. */
  installFrom?: WorkStage;
}
interface InstallAsk { role: RoleId; repo: string; specs: string[] }

class Ended extends Error { constructor() { super('ticket ended'); this.name = 'Ended'; } }
class StageFailed extends Error {}

export class ClaudeOrchestrator implements Orchestrator {
  private runs = new Map<string, Run>();
  private currentByProject = new Map<string, string>();
  private queues = new Map<string, string[]>();
  private listeners: ((e: ServerEvent) => void)[] = [];
  private pending = new Set<Promise<unknown>>();
  private git: GitApi;
  private installer: Pick<Installer, 'install' | 'lockOnly'>;
  private installSeq = 0;
  private now: () => Date;
  /** Server is stopping: runs are aborted but tickets are left as they are (the next boot marks them interrupted). */
  private stopping = false;

  constructor(private opts: ClaudeOrchestratorOptions) {
    this.git = opts.git ?? realGit;
    this.installer = opts.installer ?? new Installer();
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
      ...(opts.mode ? { mode: opts.mode } : {}),
      ...(opts.attachments?.length ? { attachments: opts.attachments.map(a => ({ ...a })) } : {}),
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
    if (ticket.workspace) run.ws = restoreWs(project.folder, ticket.workspace);
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
    // the same round again would change nothing: the team needs the owner's direction this time
    if (gate === 'stuck' && decision === 'retry' && run.idleBounce && !note?.trim()) {
      throw new ValidationError('The last round changed no files, so another round as is would fail the same way. Add a note telling the team what to do (or Accept / Cancel).');
    }
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
    if (gate === 'install') return this.bg(run, () => this.decideInstall(run, decision));
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

  sendMessage(ticketId: string, text: string, attachments: Attachment[] = []): void {
    const run = this.runs.get(ticketId);
    if (!run || (run.ticket.status !== 'running' && run.ticket.status !== 'waiting')) throw new ConflictError('Ticket is not running');
    this.emit(run, { type: 'user.message', text, ...(attachments.length ? { attachments } : {}) });
    const states = run.ticket.agentStates;
    const active = (Object.keys(states) as RoleId[]).find(r => WORKING.includes(states[r]!)) ?? 'pm';
    (run.notes[active] ??= []).push(attachments.length ? `${text}\n  ${attachmentsNote(attachments).replace(/\n/g, '\n  ')}` : text);
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

  /**
   * Stop (■ / Esc). While the PM is still answering or planning (nothing changed yet) its run is aborted and the
   * ticket ends done: the streamed text so far is kept as the final message, then "Stopped by you.". Queued tickets
   * and tickets past the plan (a change at a gate or in a work stage) are cancelled, as with Cancel.
   */
  stop(ticketId: string): StopOutcome {
    const run = this.runs.get(ticketId);
    if (!run) throw new ConflictError('Unknown ticket');
    const queued = (this.queues.get(run.project.id) ?? []).includes(ticketId);
    if (!queued && (run.ended || this.currentByProject.get(run.project.id) !== ticketId)) throw new ConflictError('Ticket is not active');
    const planning = !queued && !run.plan && !run.ticket.openGate && (run.ticket.stage === null || run.ticket.stage === 'plan');
    if (!planning) { this.cancel(ticketId); return 'cancelled'; }
    for (const ctx of run.streams) {
      for (const s of openStreams(ctx)) {
        if (s.text.trim()) this.emit(run, { type: 'agent.message', role: s.role, text: s.text, streaming: false, messageId: s.messageId });
      }
    }
    this.message(run, 'pm', STOPPED_TEXT);
    this.finish(run, 'done', '', { stopped: true });
    return 'stopped';
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
      aborts: new Set(), inflight: new Set(), streams: new Set(), notes: {}, usage: { turns: 0, costUsd: 0, durationMs: 0 }, ended: false,
      inherited: new Set(), continuing: new Set(), pendingInstalls: [], installed: false, installRerun: {},
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
    // detection runs at every ticket start: repos may have been added to a multi-repo folder since
    const found = await this.git.detectRepos(folder);
    this.alive(run);
    try { this.opts.onDetect?.(run.project.id, found); } catch { /* storing it is best effort */ }
    if (found.kind === 'multi') run.repos = found.repos;
    else run.repos = undefined;
    // an Ask only reads the owner's folder: it needs no git
    const needsGit = run.ticket.mode !== 'ask';
    if (needsGit && (found.kind === 'none' || (found.kind === 'single' && !(await this.git.hasCommit(folder))))) {
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
    if (run.ws) {
      // refresh the fallback context with what the branch already holds (best effort)
      const files = await this.diffAll(run).catch(() => []);
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
    // an owner note on the plan means a plan is wanted; tickets from before modes existed are tickets
    const mode: TicketMode = note ? 'ticket' : (run.ticket.mode ?? 'ticket');
    if (!note && run.continuing.has('pm') && run.sessions.pm) {
      resume = run.sessions.pm;
      prompt = `As the project manager, reply with the full ${mode === 'ask' ? 'answer' : mode === 'auto' ? 'answer or plan' : 'plan'} ` +
        'as one fenced ```json block in the required shape.';
      fresh = (run.fallback ?? '') + planPrompt(run.ticket, run.project, readMap(), mode);
    } else if (!note && run.parent && !run.plan) {
      fresh = (run.fallback ?? '') + planPrompt(run.ticket, run.project, readMap(), mode);
      if (run.inherited.has('pm') && run.sessions.pm) { resume = run.sessions.pm; prompt = followUpPrompt(run.ticket, run.project, mode); }
      else prompt = fresh;
    } else if (note && run.sessions.pm) {
      this.message(run, 'pm', `Re-planning with your note: "${titleOf(note)}"`);
      resume = run.sessions.pm;
      prompt = `The owner asked for changes to your plan:\n<owner-note>\n${note}\n</owner-note>\n` +
        `Revise the plan and reply with the full corrected plan as one fenced \`\`\`json block in the same shape as before.`;
    } else {
      if (note) this.message(run, 'pm', `Re-planning with your note: "${titleOf(note)}"`);
      prompt = planPrompt(run.ticket, run.project, readMap(), mode);
      if (note) prompt += `\n\nOwner note on the previous plan:\n<owner-note>\n${note}\n</owner-note>`;
    }
    prompt = this.withNotes(run, 'pm', this.ctx(run, prompt));
    if (fresh) fresh = this.ctx(run, fresh);
    const what = mode === 'ask' ? 'answer' : mode === 'auto' ? 'answer or plan' : 'plan';
    // outside ticket mode a reply that is clearly prose (no JSON at all) is the answer, not a failure
    const prose = mode === 'ticket' ? undefined : (text: string): PmReply => ({ kind: 'answer', answer: text.trim() });
    const reply = await this.structured(run, 'pm', 'plan', folder, prompt, resume, pmValidator(run.project.team, mode), what, fresh, prose);
    if (reply.memory?.length) run.lessons = [...(run.lessons ?? []), ...reply.memory];
    if (reply.kind === 'answer') return this.answer(run, reply.answer);
    const { projectMap, ...clean } = reply.plan;
    run.plan = clean;
    if (projectMap) run.projectMap = projectMap;
    this.emit(run, { type: 'ticket.plan', plan: clean });
    this.message(run, 'pm', `Plan ready: ${clean.tasks.length} tasks. Waiting for your approval.`);
    this.state(run, 'pm', 'waiting');
    this.emit(run, { type: 'gate.open', gate: 'plan', payload: clean });
  }

  /** Ask: the PM answered. No gate, no worktree, no other roles; the ticket is done (usage is emitted by finish). */
  private answer(run: Run, text: string) {
    this.alive(run);
    this.message(run, 'pm', text);
    this.emit(run, { type: 'ticket.answered' });
    this.finish(run, 'done');
  }

  private async prepareWorktree(run: Run) {
    const folder = run.project.folder;
    if (run.ws) {
      // Resume: the worktrees may have been removed since; re-attach the branches
      await this.attachAll(run.ws);
      this.alive(run);
      await this.provisionAgents(run);
      return;
    }
    const pws = run.parent?.workspace;
    if (pws && !pws.merged) {
      const ws = restoreWs(folder, pws);
      let all = true;
      for (const u of ws.units) if (!(await this.git.branchExists(u.repo, u.branch))) { all = false; break; }
      if (all) {
        for (const u of ws.units) {
          // partly merged parent: that repo's work is in its base now, so diff/merge from where the base is today
          if (u.merged) u.base = { ...u.base, head: (await this.git.baseInfo(u.repo)).head };
          delete u.merged;
        }
        // follow-up of an unmerged ticket: continue on the same branch(es) (worktrees recreated if removed)
        run.ws = ws;
        await this.attachAll(ws);
        this.alive(run);
        await this.provisionAgents(run);
        this.workspace(run);
        this.log(run, 'pm', `Continuing on ${branchesOf(ws.units)}`);
        return;
      }
    }
    const wsPath = workspacePath(this.opts.dataDir, run.project.id, run.ticket.id);
    const branch = `office/${this.git.slug(run.ticket.title)}-${run.ticket.id.slice(0, 6)}`;
    if (run.repos?.length) {
      // multi-repo: the workspace is a plain folder with one worktree per repo, same branch name in each
      fs.mkdirSync(wsPath, { recursive: true });
      const ws: Ws = { path: wsPath, multi: true, units: [] };
      try {
        for (const r of run.repos) {
          const info = await this.git.baseInfo(r.path);
          const wt = await this.git.createWorktree(r.path, path.join(wsPath, r.name), branch, info.head);
          ws.units.push({ name: r.name, repo: r.path, path: wt.path, branch: wt.branch, base: { branch: info.branch, head: info.head } });
        }
      } catch (e) {
        await this.removeWs(run, ws);
        throw e;
      }
      run.ws = ws;
    } else {
      const info = await this.git.baseInfo(folder);
      this.alive(run);
      const wt = await this.git.createWorktree(folder, wsPath, branch, info.head);
      run.ws = { path: wt.path, multi: false, units: [{ name: '', repo: folder, path: wt.path, branch: wt.branch, base: { branch: info.branch, head: info.head } }] };
    }
    if (run.ended || this.stopping) { await this.removeWs(run, run.ws); throw new Ended(); }
    await this.shareModules(run.ws);
    await this.provisionAgents(run);
    this.workspace(run);
    const ws = run.ws;
    if (run.projectMap && !ws.multi) {
      const f = path.join(ws.path, MAP_FILE);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, run.projectMap);
    }
    const detached = ws.units.filter(u => u.base.branch === 'HEAD');
    if (detached.length) {
      const where = ws.multi ? `${detached.map(u => u.name).join(', ')} ${detached.length > 1 ? 'are' : 'is'}` : 'your project folder is';
      this.message(run, 'pm', `Heads-up: ${where} on a detached HEAD (not on a branch). I will work on a new branch, ` +
        'but it cannot be merged automatically at the end; you will get the commands to run.');
    }
    if (!ws.multi) {
      const u = ws.units[0];
      this.log(run, 'pm', `Working on branch ${u.branch} (base ${u.base.branch} @ ${u.base.head.slice(0, 7)})`);
    } else {
      this.log(run, 'pm', `Working on branch ${ws.units[0].branch} in ` +
        ws.units.map(u => `${u.name} (base ${u.base.branch} @ ${u.base.head.slice(0, 7)}${u.branch !== ws.units[0].branch ? `, branch ${u.branch}` : ''})`).join(', '));
    }
  }

  /** Re-attach every unit's branch whose worktree is gone (Resume / follow-up after the worktree was removed). */
  private async attachAll(ws: Ws) {
    if (ws.multi) fs.mkdirSync(ws.path, { recursive: true });
    for (const u of ws.units) {
      if (!fs.existsSync(path.join(u.path, '.git'))) u.path = (await this.git.attachWorktree(u.repo, u.path, u.branch)).path;
    }
    await this.shareModules(ws);
  }

  /**
   * A worktree has no node_modules (ignored files are not checked out): link each one to the owner's repo copy
   * (a junction, so no admin rights on Windows) and exclude it so commitAll never picks the link up.
   */
  private async shareModules(ws: Ws) {
    for (const u of ws.units) {
      const own = path.join(u.repo, 'node_modules');
      const mine = path.join(u.path, 'node_modules');
      if (isLink(mine)) { u.sharedModules = true; continue; }
      if (!fs.existsSync(own) || fs.existsSync(mine)) continue;
      try {
        fs.symlinkSync(own, mine, 'junction');
        await this.git.excludePath(u.path, '/node_modules');
        u.sharedModules = true;
      } catch { /* best effort: the agent can still install into the worktree */ }
    }
  }

  /**
   * Remove every unit's worktree (branches kept) and the workspace folder. Never throws: a file still locked
   * (dotnet/MSBuild, a test runner) must not fail a ticket whose work is done; leftovers are reported in the log.
   */
  private async removeWs(run: Run, ws: Ws) {
    const left: string[] = [];
    for (const u of ws.units) {
      // drop the node_modules junction first so the removal never descends into the owner's node_modules
      const mine = path.join(u.path, 'node_modules');
      try { if (isLink(mine)) unlinkDir(mine); } catch { left.push(mine); continue; }
      try { await this.git.removeWorktree(u.repo, u.path); } catch { left.push(u.path); }
    }
    if (ws.multi) {
      try { fs.rmSync(ws.path, { recursive: true, force: true, maxRetries: 5 }); } catch { left.push(ws.path); }
    }
    if (left.length) {
      try { this.log(run, 'pm', `Could not remove ${[...new Set(left)].join(', ')} (files in use?) — left for manual cleanup; your work is safe.`); }
      catch { /* the run may be gone */ }
    }
  }

  /** The branch diff of every unit; multi-repo paths are prefixed with `<repo>/`. */
  private async diffAll(run: Run) {
    const ws = run.ws!;
    const out: { path: string; patch: string }[] = [];
    for (const u of ws.units) {
      const files = await this.git.diff(u.repo, u.base.head, u.branch);
      out.push(...(ws.multi ? files.map(f => ({ ...f, path: `${u.name}/${f.path}` })) : files));
    }
    return out;
  }

  /**
   * Is a review/test item's file inside one of the workspace's repos (where the devs can fix it)? Absolute paths are
   * taken relative to the workspace (or the owner's folder). Single repo: anything not climbing out of it, including no
   * file at all. Multi-repo: a path starting with a repo's folder, or one that exists (or whose folder exists) in some
   * repo; no file at all, or one found in no repo (e.g. the parent folder's docs), is outside.
   */
  private inRepos(run: Run, file: string): boolean {
    const ws = run.ws;
    if (!ws) return true;
    // backslashes → '/', and drop a ":12" / ":12:5" line suffix
    let f = file.trim().replace(/\\/g, '/').replace(/(:\d+)+$/, '');
    if (path.isAbsolute(f) || /^[a-z]:\//i.test(f)) {
      const under = [ws.path, run.project.folder].map(b => path.relative(b, f)).find(r => r && !r.startsWith('..') && !path.isAbsolute(r));
      if (under === undefined) return false;
      f = under.replace(/\\/g, '/');
    }
    f = f ? path.posix.normalize(f).replace(/^\.\//, '') : '';
    if (f === '..' || f.startsWith('../')) return false;
    if (!ws.multi) return true;
    if (!f || f === '.') return false;
    const first = f.split('/')[0].toLowerCase();
    if (ws.units.some(u => u.name.toLowerCase() === first)) return true;
    // no repo prefix (reviewers often write "src/app/x.ts"): a real issue when the file, or the folder it would go
    // in, exists in some repo (several = ambiguous, still the builders' call); outside only when it is in none
    const dir = path.posix.dirname(f);
    return ws.units.some(u => fs.existsSync(path.join(u.path, f)) || (dir !== '.' && fs.existsSync(path.join(u.path, dir))));
  }

  /** Multi-repo projects: tell the agent which subfolders are repos. */
  private ctx(run: Run, prompt: string, role: RoleId = 'pm'): string {
    const names = run.ws?.multi ? run.ws.units.map(u => u.name) : (run.repos ?? []).map(r => r.name);
    const parts = [prompt];
    if (names.length) parts.push(repoContext(names));
    // the PM works in the owner's folder and reads the parent docs there; the others get the workspace copy
    if (role !== 'pm' && run.ws?.docs) parts.push(projectDocsRule(run.project.folder, PROJECT_DOCS_DIR));
    if (run.ws?.units.some(u => u.sharedModules)) parts.push(SHARED_MODULES_RULE);
    const files = attachmentsNote(run.ticket.attachments);
    if (files) parts.push(files);
    const memory = this.memoryOf(run);
    if (memory) parts.push(memory);
    return parts.join('\n\n');
  }

  /** The project's team memory block (read fresh for every prompt); never fails a run. */
  private memoryOf(run: Run): string {
    try { return teamMemoryBlock(this.opts.memory?.list(run.project.id) ?? []); } catch { return ''; }
  }

  /**
   * The owner's `.claude/agents/*.md` are often untracked (scaffolded into a pre-existing repo), so a worktree made
   * from HEAD lacks them and `--agent <role>` would not find its definition: copy the missing ones in, and exclude
   * the folder so commitAll never commits them.
   */
  private async provisionAgents(run: Run) {
    if (!run.ws) return;
    const src = path.join(run.project.folder, AGENTS_DIR);
    const dst = path.join(run.ws.path, AGENTS_DIR);
    const files = fs.existsSync(src) ? fs.readdirSync(src).filter(f => f.endsWith('.md')) : [];
    for (const f of files) {
      if (fs.existsSync(path.join(dst, f))) continue; // tracked in the repo (or already copied): keep the branch's copy
      fs.mkdirSync(dst, { recursive: true });
      fs.copyFileSync(path.join(src, f), path.join(dst, f));
    }
    // a multi-repo workspace root is not a repo: nothing to exclude there
    if (!run.ws.multi) await this.git.excludePath(run.ws.path, '/.claude/agents/');
    this.alive(run);
    this.provisionDocs(run);
  }

  /**
   * Multi-repo: project rules and docs live in the owner's parent folder, outside every repo (so outside the
   * workspace). Copy `CLAUDE.md` + `docs/**\/*.md` (≤ 2 MB in total) into `<workspace>/_project/` for the non-PM roles
   * to read. A copy rather than `--add-dir`: that is not confirmed read-only under acceptEdits, and the owner's files
   * must stay untouched. The workspace root is not a repo, so the copy is never committed.
   */
  private provisionDocs(run: Run) {
    const ws = run.ws;
    if (!ws?.multi || ws.units.some(u => u.name.toLowerCase() === PROJECT_DOCS_DIR)) return;
    const parent = run.project.folder;
    const files: string[] = [];
    if (isFile(path.join(parent, 'CLAUDE.md'))) files.push('CLAUDE.md');
    files.push(...markdownUnder(parent, 'docs'));
    let budget = PROJECT_DOCS_MAX;
    const skipped: string[] = [];
    let copied = 0;
    for (const rel of files) {
      const src = path.join(parent, rel);
      const size = fs.statSync(src).size;
      if (size > budget) { skipped.push(rel); continue; }
      const dst = path.join(ws.path, PROJECT_DOCS_DIR, rel);
      try {
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(src, dst);
        budget -= size;
        copied++;
      } catch { skipped.push(rel); }
    }
    // a copy from an earlier run (resume) still counts when nothing could be copied this time
    ws.docs = copied > 0 || fs.existsSync(path.join(ws.path, PROJECT_DOCS_DIR));
    if (skipped.length) this.log(run, 'pm', `Project docs: not copied (over the 2 MB budget or unreadable): ${skipped.join(', ')}`);
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
    const files = await this.diffAll(run);
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
    const cwd = run.ws!.path;
    const team = run.project.team;

    if (stage === 'review' || stage === 'test') {
      const issues: Issue[] = [];
      const unassigned: Issue[] = [];
      let approved = true;
      /** Some verdict said "not approved" with no items at all: never turned into a pass by the guard below. */
      let bare = false;
      run.installed = false;
      const summary = stage === 'review' ? diffSummary(await this.diffAll(run)) : '';
      this.alive(run);
      const remarks = (role: RoleId, notes: string[]) => {
        if (notes.length) this.message(run, role, `Notes (not blocking):\n${notes.map(n => `- ${n}`).join('\n')}`);
      };
      await Promise.all(roles.map(async role => {
        if (stage === 'review') {
          const v = await this.structured(run, role, 'review', cwd, this.withNotes(run, role, this.ctx(run, reviewPrompt(run.plan!, summary), role)), run.sessions[role], reviewValidator(team), 'review');
          if (!v.approved || v.issues.length || v.unassigned.length) approved = false;
          if (!v.approved && !v.issues.length && !v.unassigned.length) bare = true;
          issues.push(...v.issues); unassigned.push(...v.unassigned);
          remarks(role, v.notes);
        } else {
          const v = await this.structured(run, role, 'test', cwd, this.withNotes(run, role, this.ctx(run, testPrompt(run.plan!), role)), run.sessions[role], testValidator(team), 'test results');
          if (!v.passed || v.failures.length || v.unassigned.length) approved = false;
          if (!v.passed && !v.failures.length && !v.unassigned.length) bare = true;
          issues.push(...v.failures); unassigned.push(...v.unassigned);
          remarks(role, v.notes);
        }
      }));
      this.alive(run);
      if (stage === 'test') await this.commit(run, 'office: test (qa)');
      if (run.pendingInstalls.length) return this.openInstallGate(run, stage);
      for (const r of roles) this.state(run, r, 'waiting');
      // fair review: an item on a file outside every repo can't be fixed by the devs → a PM note, never a bounce
      const outside = [...issues, ...unassigned].filter(i => i.file !== undefined && !this.inRepos(run, i.file));
      const drop = (list: Issue[]) => list.splice(0, list.length, ...list.filter(i => !outside.includes(i)));
      drop(issues); drop(unassigned);
      if (outside.length) {
        this.message(run, 'pm', `Noted, not sent back (outside the repos, so the team can't change it here):\n` +
          outside.map(i => `- [${i.role}] ${i.file ? i.file + ': ' : ''}${i.note}`).join('\n'));
      }
      if (unassigned.length) {
        this.message(run, 'pm', `Some ${stage} findings are for roles not on this team; passing them to the builders:\n` +
          unassigned.map(i => `- [${i.role}] ${i.file ? i.file + ': ' : ''}${i.note}`).join('\n'));
      }
      const all: Issue[] = [...issues, ...unassigned];
      // only outside-the-repo items: nothing the team can fix, so it passes (unless a verdict rejected without items)
      if (!all.length && outside.length && !bare) approved = true;
      // a bare "not approved" with no items still goes to the builders
      if (!approved && !all.length) all.push({ role: 'pm', note: `The ${stage === 'review' ? 'review' : 'tests'} did not pass.` });
      issues.splice(0, issues.length, ...this.route(run, stage, all));
      if (approved || !issues.length) {
        run.installRerun[stage] = false;
        // no further step is pending for these roles: deliver any owner notes that arrived during the stage
        for (const r of roles) await this.deliverNotes(run, r);
        return this.next(run, stage);
      }
      // packages were installed while reviewing/testing: the failure may have been the missing packages
      if (run.installed && !run.installRerun[stage]) {
        run.installRerun[stage] = true;
        this.message(run, 'pm', `Packages were installed during the ${stage}; running it again.`);
        return this.runStage(run, stage);
      }
      run.lastIssues = issues;
      run.bounces[stage]++;
      const who = stage === 'review' ? roles[0] : 'qa';
      if (run.bounces[stage] >= MAX_BOUNCES) {
        run.stuckFrom = stage;
        this.message(run, who, `This has bounced ${MAX_BOUNCES} times. I need your call.`);
        this.emit(run, { type: 'gate.open', gate: 'stuck', payload: { from: stage, bounces: run.bounces[stage], issues, ...(run.idleBounce ? { unchanged: true } : {}) } });
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
      const prompt = this.ctx(run, stagePrompt(stage, role, merged, run.plan!, this.takeNotes(run, role)), role);
      return this.exec(run, role, stage, cwd, prompt, run.sessions[role]);
    }));
    this.alive(run);
    // messages that arrived during this stage: no further step is pending for these roles, deliver now
    await Promise.all(roles.map(r => this.deliverNotes(run, r)));
    await this.commit(run, `office: ${stage} (${roles.join(', ')})`);
    for (const r of roles) this.state(run, r, 'waiting');
    if (run.pendingInstalls.length) return this.openInstallGate(run, stage);
    return this.next(run, stage);
  }

  /** Resume each owning dev's session with its issues, in parallel, then commit. */
  private async bounce(run: Run, issues: Issue[]) {
    this.alive(run);
    const owners = [...new Set(issues.map(i => i.role))];
    run.installRerun = {};
    this.emit(run, { type: 'ticket.stage', stage: 'build', roles: owners });
    for (const r of owners) this.state(run, r, 'coding');
    await Promise.all(owners.map(role => {
      const mine = issues.filter(i => i.role === role);
      const notes = this.takeNotes(run, role);
      const extra = notes.length ? mine.concat(notes.map(n => ({ role, note: `Owner: ${n}` }))) : mine;
      return this.exec(run, role, 'build', run.ws!.path, bouncePrompt(extra), run.sessions[role]);
    }));
    this.alive(run);
    run.idleBounce = !(await this.commit(run, `office: fixes (${owners.join(', ')})`));
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
    const ws = run.ws!;
    const changed: Unit[] = [];
    /** Units whose package.json changed: npm install in the owner's folder once merged (package-lock catches up). */
    const pkg = new Set<Unit>();
    for (const u of ws.units) {
      const files = await this.git.diff(u.repo, u.base.head, u.branch);
      if (files.length) changed.push(u);
      if (u.sharedModules && files.some(f => f.path === 'package.json')) pkg.add(u);
    }
    this.alive(run);
    if (!changed.length) {
      this.message(run, 'pm', 'No changes were made — nothing to merge.');
      await this.removeWs(run, ws);
      this.finish(run, 'done');
      return;
    }
    if (!ws.multi) {
      const u = ws.units[0];
      const res = await this.git.mergeIntoBase(u.repo, u.branch, u.base.branch);
      this.alive(run);
      if (res.merged) {
        u.merged = true;
        this.workspace(run, true);
        this.message(run, 'pm', `Merged ${u.branch} into ${u.base.branch}.`);
      } else {
        this.message(run, 'pm', `Merge pending: ${res.reason}\nYour work is safe on branch ${u.branch}. To merge it yourself, run:\n${res.instructions}`);
      }
    } else {
      await this.mergeAll(run, changed);
    }
    if (ws.multi && run.projectMap) {
      // the workspace root is not a repo: after approval the project map goes straight into the owner's folder
      const f = path.join(run.project.folder, MAP_FILE);
      if (!fs.existsSync(f)) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, run.projectMap); }
    }
    for (const u of changed) if (u.merged && pkg.has(u)) await this.runInstall(run, 'pm', u, [], false);
    await this.removeWs(run, ws);
    this.finish(run, 'done');
  }

  // ---- package installs (agents ask with INSTALL lines; never run npm against the shared node_modules) ----

  /** Read the INSTALL lines of a reply: declared packages install now, new ones wait for the owner's OK. */
  private async takeInstalls(run: Run, role: RoleId, text: string) {
    const ws = run.ws!;
    for (const req of parseInstallRequests(text ?? '')) {
      const unit = req.repo ? ws.units.find(u => u.name === req.repo) : ws.units.length === 1 ? ws.units[0] : undefined;
      const tell = (n: string) => (run.notes[role] ??= []).push(`Office: ${n}`);
      if (!unit) {
        tell(`INSTALL needs one of these repo names: ${ws.units.map(u => `INSTALL ${u.name}: …`).join(', ')}. Nothing was installed.`);
        continue;
      }
      if (req.bad.length) tell(`${req.bad.map(b => `"${b}"`).join(', ')} is not a valid package spec; nothing was installed for it.`);
      if (!unit.sharedModules) {
        tell(`${unit.name || 'this repo'} has its own node_modules in your worktree: install there yourself.`);
        continue;
      }
      if (!req.specs.length && req.bad.length) continue;
      if (!req.specs.length || !needsApproval(unit.repo, req.specs).length) await this.runInstall(run, role, unit, [], false);
      else run.pendingInstalls.push({ role, repo: unit.name, specs: req.specs });
    }
  }

  /** npm in the owner's repo folder, shown in the feed as a tool block; a failure goes to the agent. */
  private async runInstall(run: Run, role: RoleId, unit: Unit, specs: string[], noSave: boolean) {
    const where = run.ws?.multi ? ` in ${unit.name}` : '';
    const toolId = `install-${++this.installSeq}`;
    const label = `npm install${noSave ? ' --no-save' : ''}${specs.length ? ' ' + specs.join(' ') : ''}${where}`;
    this.emit(run, { type: 'agent.tool', role, tool: 'npm', summary: label, status: 'running', toolId });
    const res = await this.installer.install(unit.repo, specs, { noSave });
    if (run.ended) return;
    this.emit(run, { type: 'agent.tool', role, tool: 'npm', summary: label, detail: res.output, status: res.ok ? 'ok' : 'error', toolId });
    if (res.ok) {
      run.installed = true;
      this.message(run, 'pm', `📦 Installed packages${where}${role === 'pm' ? '' : ` for ${role}`}.`);
      // the owner's lockfile is never written (--no-save): the ticket's own lockfile catches up in its worktree
      if (role !== 'pm' && fs.existsSync(path.join(unit.path, 'package.json'))) {
        const lock = await this.installer.lockOnly(unit.path);
        if (run.ended) return;
        if (!lock.ok) (run.notes[role] ??= []).push(`Office: updating package-lock.json${where} failed:
${lock.output}`);
      }
    } else {
      if (role !== 'pm') (run.notes[role] ??= []).push(`Office: npm install failed${where}:\n${res.output}`);
      this.message(run, 'pm', `npm install failed${where}. ${role === 'pm' ? 'Run it yourself in the project folder.' : `Told ${role}.`}`);
    }
  }

  private openInstallGate(run: Run, stage: WorkStage) {
    run.installFrom = stage;
    for (const r of this.rolesFor(run, stage)) this.state(run, r, 'waiting');
    this.message(run, 'pm', 'New packages need your OK.');
    this.emit(run, { type: 'gate.open', gate: 'install', payload: { from: stage, requests: run.pendingInstalls } });
  }

  private async decideInstall(run: Run, decision: GateDecision) {
    const asks = run.pendingInstalls.splice(0);
    const from = run.installFrom ?? 'build';
    run.installFrom = undefined;
    for (const a of asks) {
      const unit = run.ws!.units.find(u => u.name === a.repo);
      if (decision === 'approved' && unit) await this.runInstall(run, a.role, unit, a.specs, true);
      else (run.notes[a.role] ??= []).push(`Office: the owner declined installing ${a.specs.join(' ')}. Do without them.`);
    }
    this.alive(run);
    if (from === 'review' || from === 'test') return this.runStage(run, from);
    await Promise.all([...new Set(asks.map(a => a.role))].map(r => this.deliverNotes(run, r)));
    return this.next(run, from);
  }

  /**
   * Multi-repo final merge: preflight every changed repo first (on its base branch, clean); any problem → merge none.
   * Then merge them one by one; a failure stops there and reports what was merged (with revert lines) and what wasn't.
   */
  private async mergeAll(run: Run, changed: Unit[]) {
    const manual = (u: Unit) => `cd "${u.repo}"\ngit checkout ${u.base.branch}\ngit merge --no-ff ${u.branch}`;
    const problems: { u: Unit; reason: string; instructions: string }[] = [];
    for (const u of changed) {
      const info = await this.git.baseInfo(u.repo);
      if (u.base.branch === 'HEAD') {
        problems.push({ u, reason: 'the work started from a detached HEAD, so there is no branch to merge into',
          instructions: `cd "${u.repo}"\ngit checkout <your-branch>\ngit merge --no-ff ${u.branch}` });
      } else if (info.branch === 'HEAD') {
        problems.push({ u, reason: 'the repo is not on a branch (detached HEAD)', instructions: manual(u) });
      } else if (info.branch !== u.base.branch) {
        problems.push({ u, reason: `the base branch "${u.base.branch}" is not checked out (currently on "${info.branch}")`, instructions: manual(u) });
      } else if (!info.clean) {
        problems.push({ u, reason: 'it has uncommitted changes',
          instructions: `cd "${u.repo}"\n# commit or stash your changes, then:\ngit checkout ${u.base.branch}\ngit merge --no-ff ${u.branch}` });
      }
    }
    this.alive(run);
    if (problems.length) {
      const instr = changed.map(u => `# ${u.name}\n${problems.find(p => p.u === u)?.instructions ?? manual(u)}`).join('\n\n');
      this.message(run, 'pm', `Nothing was merged: ${problems.map(p => `${p.u.name}: ${p.reason}`).join('; ')}.\n` +
        `Your work is safe on ${branchesOf(changed)} in ${changed.map(u => u.name).join(', ')}. To merge it yourself, run:\n${instr}`);
      return;
    }
    const merged: { u: Unit; sha: string }[] = [];
    for (let i = 0; i < changed.length; i++) {
      const u = changed[i];
      const res = await this.git.mergeIntoBase(u.repo, u.branch, u.base.branch);
      if (res.merged) {
        u.merged = true;
        merged.push({ u, sha: (await this.git.baseInfo(u.repo)).head });
        continue;
      }
      const rest = changed.slice(i + 1);
      this.workspace(run);
      const undo = merged.length
        ? `Already merged: ${merged.map(m => m.u.name).join(', ')}. To undo, run:\n${merged.map(m => `cd "${m.u.repo}"\ngit revert -m 1 ${m.sha}`).join('\n')}\n`
        : '';
      const instr = [`# ${u.name}\n${res.instructions}`, ...rest.map(r => `# ${r.name}\n${manual(r)}`)].join('\n\n');
      this.message(run, 'pm', `Merge stopped at ${u.name}: ${res.reason}\n${undo}` +
        `Not merged: ${[u, ...rest].map(r => r.name).join(', ')}. Your work is safe on ${branchesOf([u, ...rest])}. To merge it yourself, run:\n${instr}`);
      return;
    }
    this.workspace(run, true);
    this.message(run, 'pm', merged.map(m => `Merged ${m.u.branch} into ${m.u.base.branch} in ${m.u.name}.`).join('\n'));
  }

  // ---- runs ----

  /** A run whose final text must parse; one fixJson resume, then fail showing the role's text. */
  private async structured<T>(
    run: Run, role: RoleId, stage: Exclude<Stage, 'done'>, cwd: string, prompt: string, resume: string | undefined,
    validate: (v: unknown) => T | null, what: string, fresh?: string, prose?: (text: string) => T,
  ): Promise<T> {
    const r1 = await this.exec(run, role, stage, cwd, prompt, resume, fresh);
    const v1 = extractJson(r1.result, validate);
    if (v1) return v1;
    if (prose && isProse(r1.result)) return prose(r1.result);
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

  /** The project's model, read fresh on every run (a change applies to the next run, also on resume); none for default. */
  private modelOf(run: Run): { model?: string } {
    const m = (this.opts.getProject?.(run.project.id) ?? run.project).model;
    return m && m !== 'default' ? { model: m } : {};
  }

  /**
   * Chat answers run at medium effort: an Ask, or an auto request in a thread whose previous turn was an answer.
   * Planning a change (and every other role) keeps the CLI's default.
   */
  private effortOf(run: Run, role: RoleId, stage: Exclude<Stage, 'done'>): { effort?: Effort } {
    if (role !== 'pm' || stage !== 'plan' || run.plan) return {};
    const mode = run.ticket.mode ?? 'ticket';
    return mode === 'ask' || (mode === 'auto' && run.parent?.answered) ? { effort: 'medium' } : {};
  }

  /** Uploaded files live outside every repo: once the project has any, every run may read them (--add-dir). */
  private addDirsOf(run: Run): { addDirs?: string[] } {
    const dir = attachmentsDir(this.opts.dataDir, run.project.id);
    return fs.existsSync(dir) ? { addDirs: [dir] } : {};
  }

  private async execNow(run: Run, role: RoleId, stage: Exclude<Stage, 'done'>, cwd: string, prompt: string, resume?: string): Promise<RunResult> {
    this.alive(run);
    const ac = new AbortController();
    run.aborts.add(ac);
    const ctx = newTranslateContext(cwd, { minIntervalMs: this.opts.deltaIntervalMs });
    run.streams.add(ctx);
    const maxTurns = MAX_TURNS[stage === 'plan' ? 'plan' : stage];
    let res: RunResult;
    try {
      res = await this.opts.runner.run({
        cwd, role, prompt, resume, allowedTools: ROLE_TOOLS[role], maxTurns, signal: ac.signal, ...this.modelOf(run),
        ...this.effortOf(run, role, stage), ...this.addDirsOf(run),
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
      run.streams.delete(ctx);
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
    if (role !== 'pm' && run.ws) await this.takeInstalls(run, role, res.result);
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
    // a non-PM role only ever works in the worktree: with none yet, keep the notes for its next step
    if (role !== 'pm' && !run.ws) return;
    const notes = this.takeNotes(run, role);
    const stage = role === 'pm' ? 'plan' : (PIPELINE.find(s => STAGE_ROLES[s].includes(role)) ?? 'build');
    const cwd = role === 'pm' ? run.project.folder : run.ws!.path;
    try { await this.exec(run, role, stage, cwd, deliverNotesPrompt(notes), run.sessions[role]); }
    catch (err) {
      if (err instanceof Ended || run.ended) return;
      this.log(run, role, `[${role}] could not deliver your note: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private workspace(run: Run, merged = false) {
    const ws = run.ws;
    if (!ws) return;
    const first = ws.units[0];
    const w: Workspace = { branch: first.branch, worktree: ws.path, base: { ...first.base }, ...(merged ? { merged } : {}) };
    if (ws.multi) {
      w.repos = ws.units.map(u => ({
        name: u.name, path: u.path, branch: u.branch, base: { ...u.base }, detached: u.base.branch === 'HEAD',
        ...(u.merged ? { merged: true } : {}),
      }));
    }
    this.emit(run, { type: 'ticket.workspace', workspace: w });
  }

  /** Commit every unit's worktree (ones with no changes are skipped). */
  /** Commits every unit; true when any of them had changes (a git double that returns nothing counts as changed). */
  private async commit(run: Run, msg: string): Promise<boolean> {
    if (!run.ws) return false;
    let changed = false;
    for (const u of run.ws.units) if ((await this.git.commitAll(u.path, msg)) !== false) changed = true;
    this.alive(run);
    return changed;
  }

  private alive(run: Run) { if (run.ended || this.stopping) throw new Ended(); }

  private finish(run: Run, how: 'done' | 'cancelled' | 'failed', reason = '', done: { stopped?: boolean } = {}) {
    if (run.ended) return;
    run.ended = true;
    for (const ac of run.aborts) ac.abort();
    run.aborts.clear();
    // cancel removes the worktree (branch kept); a failed ticket keeps it so its work can be inspected/resumed
    if (how === 'cancelled' && run.ws) {
      const ws = run.ws;
      const inflight = [...run.inflight];
      const p = Promise.allSettled(inflight).then(() => this.removeWs(run, ws)).catch(() => undefined);
      this.pending.add(p);
      void p.finally(() => this.pending.delete(p));
    }
    const roles = Object.keys(run.ticket.agentStates) as RoleId[];
    if (run.usage.turns || run.usage.costUsd || run.usage.durationMs) this.emit(run, { type: 'ticket.usage', ...run.usage });
    if (how === 'done') {
      for (const r of roles) this.state(run, r, 'done');
      this.emit(run, { type: 'ticket.done', ...(done.stopped ? { stopped: true } : {}) });
      this.learn(run);
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

  /** The ticket/answer completed: the PM's lessons go into the team memory (best effort). */
  private learn(run: Run) {
    if (!run.lessons?.length || !this.opts.memory) return;
    try { this.opts.memory.learn(run.project.id, run.lessons, run.ticket.id); }
    catch (err) { console.error(err); }
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

const isLink = (p: string) => { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } };
const isFile = (p: string) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const PROJECT_DOCS_DIR = '_project';
const PROJECT_DOCS_MAX = 2 * 1024 * 1024;
/** `<dir>/**\/*.md` under root (relative paths, sorted; dot-folders, node_modules and links skipped). */
function markdownUnder(root: string, dir: string): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(path.join(root, dir), { withFileTypes: true }); } catch { return out; }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = path.join(dir, e.name);
    if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') out.push(...markdownUnder(root, rel));
    else if (e.isFile() && /\.md$/i.test(e.name)) out.push(rel);
  }
  return out;
}
/** Remove a junction/symlink itself (never its target's contents). */
function unlinkDir(p: string) {
  try { fs.unlinkSync(p); } catch { fs.rmdirSync(p); }
}
/** "branch X", or "branches angular: X, aspnet-core: Y" when a repo needed a different name. */
function branchesOf(units: Unit[]): string {
  const names = [...new Set(units.map(u => u.branch))];
  if (names.length === 1) return `branch ${names[0]}`;
  return `branches ${units.map(u => `${u.name}: ${u.branch}`).join(', ')}`;
}

/** Short per-ticket workspace folder: deep repos (e.g. ASP.NET Zero) exceed Windows' 260-char path limit otherwise. */
export const workspacePath = (dataDir: string, projectId: string, ticketId: string) =>
  path.join(dataDir, 'wt', projectId.slice(0, 8), ticketId.slice(0, 8));

/** Rebuild the per-repo worktrees from a persisted workspace (old single-repo shape has no `repos`). */
function restoreWs(folder: string, w: Workspace): Ws {
  if (w.repos?.length) {
    return {
      path: w.worktree, multi: true,
      // the parent-docs copy outlives a restart: keep the prompt hint for it
      ...(fs.existsSync(path.join(w.worktree, PROJECT_DOCS_DIR)) ? { docs: true } : {}),
      units: w.repos.map(r => ({
        name: r.name, repo: path.join(folder, r.name), path: r.path, branch: r.branch, base: { ...r.base },
        ...(r.merged ? { merged: true } : {}),
      })),
    };
  }
  return { path: w.worktree, multi: false, units: [{ name: '', repo: folder, path: w.worktree, branch: w.branch, base: { ...w.base } }] };
}

const roleName = (r: RoleId) => r === 'pm' ? 'The PM' : `The ${r} agent`;
