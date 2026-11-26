import { randomUUID } from 'node:crypto';
import {
  applyTicketEvent, type AgentState, type GateDecision, type GateKind, type Plan, type Project, type RoleId,
  type ServerEvent, type Stage, type Ticket,
} from '@office/shared';
import { ConflictError, ValidationError, type Orchestrator, type Scheduler, type StartOptions } from './types';
import { makeDiff, makePlan, makeWork, titleOf } from './fakeContent';
import type { TicketLog } from '../ticketLog';

export { ConflictError };

type WorkStage = 'design' | 'build' | 'review' | 'test' | 'docs';
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
export const REVIEW_BOUNCE = 0.25;
export const TEST_BOUNCE = 0.15;
const MAX_BOUNCES = 3;

interface Run {
  ticket: Ticket; project: Project; seq: number; cancels: (() => void)[];
  plan?: Plan; bounces: { review: number; test: number }; stuckFrom?: 'review' | 'test';
}

export interface SimulatedOptions { log: TicketLog; scheduler: Scheduler; random?: () => number; stageMs?: [number, number] }

export class SimulatedOrchestrator implements Orchestrator {
  private runs = new Map<string, Run>();
  private currentByProject = new Map<string, string>();
  private queues = new Map<string, string[]>();
  private listeners: ((e: ServerEvent) => void)[] = [];
  private random: () => number;
  private stageMs: [number, number];

  constructor(private opts: SimulatedOptions) {
    this.random = opts.random ?? Math.random;
    this.stageMs = opts.stageMs ?? [10000, 40000];
  }

  onEvent(cb: (e: ServerEvent) => void) { this.listeners.push(cb); }

  startTicket(project: Project, text: string, opts: StartOptions = {}): Ticket {
    const ticket: Ticket = {
      id: randomUUID(), projectId: project.id, title: titleOf(text), text, status: 'queued', stage: null,
      agentStates: {}, createdAt: new Date().toISOString(), agentsMode: 'simulated',
      ...(opts.parentTicketId ? { parentTicketId: opts.parentTicketId } : {}),
    };
    const run: Run = { ticket, project, seq: 0, cancels: [], bounces: { review: 0, test: 0 } };
    this.runs.set(ticket.id, run);
    this.emit(run, { type: 'ticket.created', ticket });
    this.enqueue(run);
    return run.ticket;
  }

  resume(_ticketId: string): Ticket { throw new ConflictError('Simulated tickets cannot be resumed'); }

  adopt(project: Project, ticket: Ticket): void {
    const run: Run = { ticket, project, seq: 1_000_000, cancels: [], bounces: { review: 0, test: 0 } };
    this.runs.set(ticket.id, run);
    this.enqueue(run);
  }

  decide(ticketId: string, gate: GateKind, decision: GateDecision, note?: string): void {
    if (!GATE_DECISIONS[gate]?.includes(decision)) throw new ValidationError(`Decision ${decision} is not valid for ${gate}`);
    const run = this.runs.get(ticketId);
    if (!run || run.ticket.openGate !== gate) throw new ConflictError(`Gate ${gate} is not open`);
    this.emit(run, { type: 'gate.closed', gate, decision, note });
    if (gate === 'plan') {
      if (decision === 'changes') return this.runPlan(run, note);
      this.summonTeam(run);
      return this.next(run, null);
    }
    if (gate === 'final') {
      if (decision === 'changes') return this.reworkAfter(run, note);
      return this.finish(run, 'done');
    }
    // stuck
    if (decision === 'cancel') return this.finish(run, 'cancelled');
    const from = run.stuckFrom ?? 'review';
    run.stuckFrom = undefined;
    if (decision === 'retry') { run.bounces[from] = 0; return this.reworkAfter(run, note); }
    run.bounces = { review: 0, test: 0 };
    return this.next(run, from);
  }

  sendMessage(ticketId: string, text: string): void {
    const run = this.runs.get(ticketId);
    if (!run || (run.ticket.status !== 'running' && run.ticket.status !== 'waiting')) throw new ConflictError('Ticket is not running');
    this.emit(run, { type: 'user.message', text });
    const states = run.ticket.agentStates;
    const active = (Object.keys(states) as RoleId[]).find(r => WORKING.includes(states[r]!)) ?? 'pm';
    this.message(run, active, `Got it — "${titleOf(text)}". I'll take that into account.`);
  }

  cancel(ticketId: string): void {
    const run = this.runs.get(ticketId);
    if (!run) throw new ConflictError('Unknown ticket');
    const q = this.queues.get(run.project.id) ?? [];
    if (q.includes(ticketId)) {
      this.queues.set(run.project.id, q.filter(id => id !== ticketId));
      this.emit(run, { type: 'ticket.cancelled' });
      return;
    }
    if (this.currentByProject.get(run.project.id) !== ticketId) throw new ConflictError('Ticket is not active');
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

  private enqueue(run: Run) {
    const pid = run.project.id;
    if (!this.currentByProject.has(pid)) { this.currentByProject.set(pid, run.ticket.id); this.runPlan(run); }
    else this.queues.set(pid, [...(this.queues.get(pid) ?? []), run.ticket.id]);
  }

  private runPlan(run: Run, note?: string) {
    this.emit(run, { type: 'ticket.stage', stage: 'plan', roles: ['pm'] });
    if (!run.ticket.agentStates.pm) this.state(run, 'pm', 'summoned');
    this.state(run, 'pm', 'planning');
    if (note) this.message(run, 'pm', `Re-planning with your note: "${titleOf(note)}"`);
    this.work(run, 'plan', ['pm'], () => {
      run.plan = makePlan(run.project, run.ticket.text);
      this.emit(run, { type: 'ticket.plan', plan: run.plan });
      this.message(run, 'pm', `Plan ready: ${run.plan.tasks.length} tasks. Waiting for your approval.`);
      this.state(run, 'pm', 'waiting');
      this.emit(run, { type: 'gate.open', gate: 'plan', payload: run.plan });
    });
  }

  /** Roles with a plan task that are still on the team (a role can be removed while the plan gate is open). */
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

  /** Continue with the first pipeline stage after `after` (null = from the start). */
  private next(run: Run, after: WorkStage | null) {
    const start = after ? PIPELINE.indexOf(after) + 1 : 0;
    const stage = PIPELINE.slice(start).find(s => this.rolesFor(run, s).length > 0);
    if (stage) return this.runStage(run, stage);
    this.emit(run, { type: 'ticket.diff', files: makeDiff(run.plan!) });
    this.message(run, 'pm', 'All stages done. Please review the final changes.');
    this.emit(run, { type: 'gate.open', gate: 'final', payload: null });
  }

  /** Send the work back to the builders (or the earliest stage that has roles). */
  private reworkAfter(run: Run, note?: string) {
    if (note) this.message(run, 'pm', `Passing your note to the team: "${titleOf(note)}"`);
    if (this.rolesFor(run, 'build').length) return this.runStage(run, 'build');
    return this.next(run, null);
  }

  private runStage(run: Run, stage: WorkStage) {
    const roles = this.rolesFor(run, stage);
    this.emit(run, { type: 'ticket.stage', stage, roles });
    for (const r of roles) this.state(run, r, STAGE_STATE[stage]);
    this.work(run, stage, roles, () => {
      for (const r of roles) this.state(run, r, 'waiting');
      if ((stage === 'review' || stage === 'test') && this.random() < (stage === 'review' ? REVIEW_BOUNCE : TEST_BOUNCE)) {
        run.bounces[stage]++;
        const who = stage === 'review' ? roles[0] : 'qa';
        if (run.bounces[stage] >= MAX_BOUNCES) {
          run.stuckFrom = stage;
          this.message(run, who, `This has bounced ${MAX_BOUNCES} times. I need your call.`);
          this.emit(run, { type: 'gate.open', gate: 'stuck', payload: { from: stage, bounces: run.bounces[stage] } });
          return;
        }
        this.message(run, who, stage === 'review' ? 'Found an issue: missing error handling. Sending it back.' : 'A test failed. Sending it back to the developer.');
        return this.reworkAfter(run);
      }
      this.next(run, stage);
    });
  }

  private work(run: Run, stage: Exclude<Stage, 'done'>, roles: RoleId[], done: () => void) {
    const [lo, hi] = this.stageMs;
    const dur = lo + this.random() * (hi - lo);
    const n = 3 + Math.floor(this.random() * 6);
    for (let i = 0; i < n; i++) {
      const role = roles[i % roles.length];
      const files = run.plan?.tasks.find(t => t.role === role)?.files ?? [];
      this.later(run, (dur * (i + 1)) / (n + 1), () => {
        const w = makeWork(role, stage, i, files, this.random);
        if (w.kind === 'message') this.message(run, role, w.summary);
        else {
          const toolId = randomUUID();
          this.emit(run, { type: 'agent.tool', role, tool: w.tool!, summary: w.summary, detail: w.detail, status: 'ok', toolId });
          this.emit(run, { type: 'log.raw', role, line: `[${role}] ${w.summary}` });
        }
      });
    }
    this.later(run, dur, done);
  }

  private finish(run: Run, how: 'done' | 'cancelled' | 'failed', reason = '') {
    for (const c of run.cancels) c();
    run.cancels = [];
    const roles = Object.keys(run.ticket.agentStates) as RoleId[];
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
    if (nextId) { this.currentByProject.set(pid, nextId); this.runPlan(this.runs.get(nextId)!); }
  }

  // ---- emit helpers ----

  private later(run: Run, ms: number, fn: () => void) { run.cancels.push(this.opts.scheduler.after(ms, fn)); }
  private state(run: Run, role: RoleId, state: AgentState) { this.emit(run, { type: 'agent.state', role, state }); }
  private message(run: Run, role: RoleId, text: string) {
    this.emit(run, { type: 'agent.message', role, text, streaming: false, messageId: randomUUID() });
    this.emit(run, { type: 'log.raw', role, line: `[${role}] ${text}` });
  }
  private emit(run: Run, partial: Record<string, unknown> & { type: ServerEvent['type'] }) {
    const e = { ...partial, projectId: run.project.id, ticketId: run.ticket.id, seq: ++run.seq, ts: new Date().toISOString() } as ServerEvent;
    run.ticket = applyTicketEvent(run.ticket, e)!;
    this.opts.log.append(e);
    for (const l of this.listeners) l(e);
  }
}
