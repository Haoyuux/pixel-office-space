import { describe, it, expect } from 'vitest';
import type { Project, ServerEvent, RoleId } from '@office/shared';
import { SimulatedOrchestrator, ConflictError } from '../src/orchestrator/simulated';
import { TicketLog } from '../src/ticketLog';
import { tmp } from './helpers';

export class ManualScheduler {
  private q: { at: number; fn: () => void; dead: boolean }[] = [];
  now = 0;
  after(ms: number, fn: () => void) {
    const e = { at: this.now + ms, fn, dead: false };
    this.q.push(e);
    return () => { e.dead = true; };
  }
  flush() {
    let guard = 0;
    while (this.q.some(e => !e.dead) && guard++ < 100000) {
      this.q.sort((a, b) => a.at - b.at);
      const e = this.q.shift()!;
      if (e.dead) continue;
      this.now = e.at;
      e.fn();
    }
  }
}

const project = (team: RoleId[]): Project => ({ id: 'p1', name: 'Shop', folder: '.', accent: 'cyan', team, slot: 0, looks: {} as any, createdAt: '' });
const CORE: RoleId[] = ['pm', 'techlead', 'frontend', 'backend', 'qa'];

let sched: ManualScheduler;
let events: ServerEvent[];
let log: TicketLog;
let logDir: string;
const make = (random: () => number = () => 0.99) => {
  sched = new ManualScheduler(); events = []; logDir = tmp(); log = new TicketLog(logDir);
  const o = new SimulatedOrchestrator({ log, scheduler: sched, random, stageMs: [100, 200] });
  o.onEvent(e => events.push(e));
  return o;
};
const types = () => events.map(e => e.type);
const states = (role: RoleId) => events.filter((e: any) => e.type === 'agent.state' && e.role === role).map((e: any) => e.state);
const stages = () => events.filter(e => e.type === 'ticket.stage').map((e: any) => e.stage);
const gates = () => events.filter(e => e.type === 'gate.open').map((e: any) => e.gate);

describe('SimulatedOrchestrator', () => {
  it('runs the happy path through both gates', () => {
    const o = make();
    const t = o.startTicket(project(CORE), 'Add forgot password link');
    sched.flush();
    expect(types().slice(0, 2)).toEqual(['ticket.created', 'ticket.stage']);
    expect(states('pm')).toContain('planning');
    expect(types()).toContain('ticket.plan');
    expect(gates()).toEqual(['plan']);
    expect(o.current('p1')!.status).toBe('waiting');

    o.decide(t.id, 'plan', 'approved'); sched.flush();
    const plan = (events.find(e => e.type === 'ticket.plan') as any).plan;
    const tasked = [...new Set<string>(plan.tasks.map((x: any) => x.role))].filter(r => r !== 'pm').sort();
    const summoned = events.filter((e: any) => e.type === 'agent.state' && e.state === 'summoned' && e.role !== 'pm').map((e: any) => e.role).sort();
    expect(summoned).toEqual(tasked);
    expect(stages()).toEqual(['plan', 'build', 'review', 'test']);
    expect(states('frontend')).toContain('coding');
    expect(states('techlead')).toContain('reviewing');
    expect(states('qa')).toContain('testing');
    expect(gates()).toEqual(['plan', 'final']);

    o.decide(t.id, 'final', 'approved'); sched.flush();
    expect(types()).toContain('ticket.done');
    expect(states('frontend').slice(-2)).toEqual(['done', 'idle']);
    expect(o.current('p1')).toBeUndefined();
  });

  it('adds design only with uiux and docs only with writer', () => {
    let o = make();
    let t = o.startTicket(project(CORE), 'Add a login page'); sched.flush();
    o.decide(t.id, 'plan', 'approved'); sched.flush();
    expect(stages()).not.toContain('design');
    expect(stages()).not.toContain('docs');
    o = make();
    t = o.startTicket(project([...CORE, 'uiux', 'writer']), 'Add a login page'); sched.flush();
    o.decide(t.id, 'plan', 'approved'); sched.flush();
    expect(stages()).toEqual(['plan', 'design', 'build', 'review', 'test', 'docs']);
  });

  it('opens the stuck gate after 3 review bounces; retry resets, accept moves to test', () => {
    const o = make(() => 0.01); // every review bounces
    const t = o.startTicket(project(CORE), 'x'); sched.flush();
    o.decide(t.id, 'plan', 'approved'); sched.flush();
    expect(stages().filter(s => s === 'review').length).toBe(3);
    expect(gates().at(-1)).toBe('stuck');
    o.decide(t.id, 'stuck', 'retry'); sched.flush();
    expect(stages().filter(s => s === 'review').length).toBe(6);
    o.decide(t.id, 'stuck', 'accept'); sched.flush();
    expect(stages()).toContain('test');
  });

  it('cancel from the stuck gate ends the ticket', () => {
    const o = make(() => 0.01);
    const t = o.startTicket(project(CORE), 'x'); sched.flush();
    o.decide(t.id, 'plan', 'approved'); sched.flush();
    o.decide(t.id, 'stuck', 'cancel'); sched.flush();
    expect(types()).toContain('ticket.cancelled');
  });

  it('rejects deciding a gate that is not open, and deciding twice', () => {
    const o = make();
    const t = o.startTicket(project(CORE), 'x');
    expect(() => o.decide(t.id, 'final', 'approved')).toThrow(ConflictError);
    sched.flush();
    o.decide(t.id, 'plan', 'approved');
    expect(() => o.decide(t.id, 'plan', 'approved')).toThrow(ConflictError);
  });

  it('queues a second ticket and starts it after the first ends', () => {
    const o = make();
    const a = o.startTicket(project(CORE), 'a');
    const b = o.startTicket(project(CORE), 'b');
    expect(b.status).toBe('queued');
    expect(o.queue('p1').map(t => t.id)).toEqual([b.id]);
    sched.flush(); o.cancel(a.id); sched.flush();
    expect(o.current('p1')!.id).toBe(b.id);
  });

  it('sendMessage echoes the user and gets an acknowledgement from the active role', () => {
    const o = make();
    const t = o.startTicket(project(CORE), 'x');
    o.sendMessage(t.id, 'use the existing mailer');
    const i = types().indexOf('user.message');
    expect(i).toBeGreaterThan(-1);
    const ack = events.slice(i + 1).find(e => e.type === 'agent.message') as any;
    expect(ack.role).toBe('pm');
  });

  it('sendMessage on a finished ticket throws ConflictError', () => {
    const o = make();
    const t = o.startTicket(project(CORE), 'x');
    o.cancel(t.id);
    expect(() => o.sendMessage(t.id, 'hi')).toThrow(ConflictError);
  });

  it('busyRoles lists working roles of the current ticket', () => {
    const o = make();
    const t = o.startTicket(project(CORE), 'x'); sched.flush();
    expect(o.busyRoles('p1')).toEqual(['pm']);
    o.decide(t.id, 'plan', 'approved');
    expect(o.busyRoles('p1').sort()).toEqual(['backend', 'frontend', 'pm', 'qa', 'techlead']);
  });

  it('logs every event with increasing seq per ticket', () => {
    const o = make();
    const t = o.startTicket(project(CORE), 'x'); sched.flush();
    const logged = log.read('p1', t.id);
    expect(logged.length).toBe(events.filter((e: any) => e.ticketId === t.id).length);
    expect(logged.map((e: any) => e.seq)).toEqual(logged.map((_, i) => i + 1));
  });

  it('recover marks an unfinished ticket as interrupted', () => {
    const o = make();
    const t = o.startTicket(project(CORE), 'x'); sched.flush();
    const rec = new TicketLog(logDir).recover();
    expect(rec.find(x => x.id === t.id)).toMatchObject({ status: 'failed', reason: 'interrupted' });
    expect(new TicketLog(logDir).read('p1', t.id).at(-1)!.type).toBe('ticket.failed');
  });

  it('recover keeps a never-started ticket queued', () => {
    const o = make();
    o.startTicket(project(CORE), 'a');
    const b = o.startTicket(project(CORE), 'b');
    const rec = new TicketLog(logDir).recover();
    expect(rec.find(x => x.id === b.id)!.status).toBe('queued');
  });
});
