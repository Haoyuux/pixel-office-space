import type { AgentState, GateKind, Project, RoleId, ServerEvent, Stage, Ticket } from '@office/shared';
import type { Clip } from '../assets';
import type { Dir } from '../iso';
import type { BuildingLayout, Spot } from '../layout/types';
import type { BubbleKind } from './bot';

/**
 * The ticket director (spec §7.3): turns server events into bot behaviour. It takes bots over from office life
 * while they work on a ticket (life.release), walks them to the whiteboard / their seat / a coder's desk, shows the
 * status bubbles and monitors, and hands them back (life.resume) when the ticket ends. It also animates team changes
 * (walk in from the room door, walk out to the hallway end) through the Population hooks onAdded / onRemoved.
 */

export interface DirectorBot {
  readonly id: string;
  readonly projectId: string;
  readonly role: RoleId;
  seated: boolean;
  mx: number;
  my: number;
  goTo(target: Spot | { mx: number; my: number }, then?: () => void): void;
  sit(spot: Spot): void;
  stand(): void;
  play(clip: Clip): void;
  face(dir: Dir): void;
  bubble(kind: BubbleKind | null): void;
}

export interface DirectorScene {
  readonly layout: BuildingLayout | null;
  setWorking(projectId: string, role: RoleId, on: boolean): void;
  setWhiteboard(projectId: string, title: string | null): void;
  setTrophies(projectId: string, n: number): void;
}

export interface DirectorLife { release(botId: string): void; resume(botId: string): void }
export interface DirectorBots { get(botId: string): DirectorBot | undefined }
export interface DirectorGrid { walkable(mx: number, my: number): boolean }

export interface DirectorOptions {
  /** Timer (tests inject a fake clock). */
  after?: (ms: number, fn: () => void) => void;
  /** Done tickets known for a project (trophies); defaults to counting the ticket.done events seen. */
  doneCount?: (projectId: string) => number;
}

/** How long the PM stands at the whiteboard before going to its seat. */
export const BOARD_MS = 3500;
/** How long the tech lead stands beside each coder's desk. */
export const REVIEW_MS = 4000;
/** Wave length (done, walk-in). */
export const WAVE_MS = 2400;
/** After the done wave, ✓ fades (bot.ts: 3 s + 0.6 s); then the bot goes back to office life. */
export const DONE_MS = 3600;
/** ✗ shown this long on failed / cancelled. */
export const FAIL_MS = 2500;
/** A bot walking out is despawned after this at the latest. */
const LEAVE_TIMEOUT_MS = 60000;
export const MAX_TROPHIES = 5;

const WORKING: AgentState[] = ['planning', 'designing', 'coding', 'reviewing', 'testing', 'documenting'];
/** States in which a role is on duty for the ticket (summoned and not yet released). */
const ON_DUTY: AgentState[] = ['summoned', 'waiting', ...WORKING];
const CODERS: RoleId[] = ['frontend', 'backend', 'devops', 'uiux'];

interface Duty { ticketId: string; state: AgentState }
interface TicketInfo { projectId: string; title: string; stage: Stage | null; gate?: GateKind; buildRoles: RoleId[]; board: boolean }

const botId = (projectId: string, role: RoleId) => `${projectId}:${role}`;
const near = (a: { mx: number; my: number }, b: { mx: number; my: number }) => Math.hypot(a.mx - b.mx, a.my - b.my) < 0.05;

export class Director {
  private teams = new Map<string, Set<RoleId>>();
  private tickets = new Map<string, TicketInfo>();
  /** projectId -> ticket being worked on */
  private active = new Map<string, string>();
  private duty = new Map<string, Duty>();
  /** Bots that joined via project.updated: walk in when the Population creates them. */
  private arriving = new Set<string>();
  /** Bots whose role was removed via project.updated: walk out when the Population removes them. */
  private leaving = new Set<string>();
  /** Movement token per bot: a newer movement invalidates the callbacks of an older one. */
  private moves = new Map<string, number>();
  private doneSeen = new Map<string, number>();
  private after: (ms: number, fn: () => void) => void;
  private dead = false;
  private timers = new Set<ReturnType<typeof setTimeout>>();

  constructor(private scene: DirectorScene, private life: DirectorLife, private bots: DirectorBots,
    private grid: DirectorGrid | null = null, private opts: DirectorOptions = {}) {
    const raw = opts.after ?? ((ms: number, fn: () => void) => {
      const h = setTimeout(() => { this.timers.delete(h); fn(); }, ms);
      this.timers.add(h);
    });
    this.after = (ms, fn) => raw(ms, () => { if (!this.dead) fn(); });
  }

  /** Teardown: pending timers no longer act. */
  destroy(): void {
    this.dead = true;
    for (const h of this.timers) clearTimeout(h);
    this.timers.clear();
  }

  apply(e: ServerEvent): void {
    switch (e.type) {
      case 'snapshot': return this.snapshot(e.snapshot.projects, e.snapshot.tickets);
      case 'project.added': this.teams.set(e.project.id, new Set(e.project.team)); return;
      case 'project.updated': return this.teamChanged(e.project);
      case 'project.removed': {
        this.teams.delete(e.projectId); this.active.delete(e.projectId);
        for (const id of [...this.duty.keys()]) if (id.startsWith(`${e.projectId}:`)) this.duty.delete(id);
        return;
      }
      case 'ticket.created': {
        this.tickets.set(e.ticketId, this.info(e.ticket));
        if (!this.active.has(e.projectId)) this.scene.setWhiteboard(e.projectId, e.ticket.title);
        return;
      }
      case 'ticket.stage': {
        const t = this.tickets.get(e.ticketId) ?? this.placeholder(e.ticketId, e.projectId);
        t.stage = e.stage;
        if (e.stage === 'build') t.buildRoles = e.roles;
        this.active.set(e.projectId, e.ticketId);
        this.scene.setWhiteboard(e.projectId, t.title);
        return;
      }
      case 'agent.state': return this.state(e.projectId, e.ticketId, e.role, e.state);
      case 'gate.open': case 'gate.closed': {
        const t = this.tickets.get(e.ticketId) ?? this.placeholder(e.ticketId, e.projectId);
        t.gate = e.type === 'gate.open' ? e.gate : undefined;
        for (const [id, d] of this.duty) if (d.ticketId === e.ticketId) this.render(id);
        return;
      }
      case 'ticket.done': {
        const n = this.opts.doneCount ? this.opts.doneCount(e.projectId) : (this.doneSeen.get(e.projectId) ?? 0) + 1;
        this.doneSeen.set(e.projectId, n);
        this.scene.setTrophies(e.projectId, Math.min(MAX_TROPHIES, n));
        return this.end(e.projectId, e.ticketId, 'done');
      }
      case 'ticket.failed': case 'ticket.cancelled': return this.end(e.projectId, e.ticketId, 'failed');
      default: return;
    }
  }

  /** Population hook: a bot was created (initial build, a new team member, or a bot that is on duty). */
  onAdded(bot: DirectorBot, seat: Spot): void {
    if (this.duty.has(bot.id)) {
      // the page opened (or the layout rebuilt) mid-ticket: the bot is at work at its desk
      this.life.release(bot.id);
      if (!(bot.seated && near(bot, seat))) bot.sit(seat);
      this.render(bot.id, bot);
      return;
    }
    if (!this.arriving.delete(bot.id)) return;
    const from = this.doorOf(bot.projectId);
    if (!from) return;
    this.life.release(bot.id);
    const tok = this.move(bot.id);
    bot.stand();
    bot.mx = from.mx; bot.my = from.my;
    bot.goTo(seat, () => {
      if (!this.current(bot.id, tok)) return;
      bot.face('SW');
      bot.play('waving');
      this.after(WAVE_MS, () => {
        if (!this.current(bot.id, tok)) return;
        bot.sit(seat);
        if (!this.duty.has(bot.id)) this.life.resume(bot.id);
      });
    });
  }

  /** Population hook: a bot is being taken out. A removed team member walks to the hallway end first. */
  onRemoved(bot: DirectorBot): Promise<void> | void {
    this.arriving.delete(bot.id);
    if (this.duty.delete(bot.id)) this.off(bot.id);
    const tok = this.move(bot.id);
    const end = this.scene.layout?.hallEnd;
    if (!this.leaving.delete(bot.id) || !end) return;
    bot.bubble(null);
    return new Promise<void>(resolve => {
      bot.goTo(end, () => { if (this.current(bot.id, tok)) resolve(); });
      this.after(LEAVE_TIMEOUT_MS, resolve);
    });
  }

  // ---------------------------------------------------------------------------------------------

  private info(t: Ticket): TicketInfo {
    return { projectId: t.projectId, title: t.title, stage: t.stage, gate: t.openGate, buildRoles: [], board: t.stage !== null && t.stage !== 'plan' };
  }

  private placeholder(ticketId: string, projectId: string): TicketInfo {
    const t: TicketInfo = { projectId, title: '', stage: null, buildRoles: [], board: true };
    this.tickets.set(ticketId, t);
    return t;
  }

  private snapshot(projects: Project[], tickets: Ticket[]): void {
    const was = new Map(this.active);
    this.teams = new Map(projects.map(p => [p.id, new Set(p.team)]));
    this.active.clear();
    const want = new Map<string, Duty>();
    for (const t of tickets) {
      const prev = this.tickets.get(t.id);
      const info = this.info(t);
      if (prev) { info.buildRoles = prev.buildRoles; info.board = prev.board || info.board; }
      // a ticket already past planning, or seen mid-plan on load, does not send the PM to the whiteboard again
      if (t.status === 'running' || t.status === 'waiting') info.board = true;
      this.tickets.set(t.id, info);
      if (t.status !== 'running' && t.status !== 'waiting') continue;
      this.active.set(t.projectId, t.id);
      this.scene.setWhiteboard(t.projectId, t.title);
      for (const [r, s] of Object.entries(t.agentStates) as [RoleId, AgentState][])
        if (ON_DUTY.includes(s)) want.set(botId(t.projectId, r), { ticketId: t.id, state: s });
    }
    for (const [pid] of was) if (!this.active.has(pid) && this.teams.has(pid)) this.scene.setWhiteboard(pid, null);
    // bots whose ticket ended while we were away go back to office life
    for (const [id] of this.duty) if (!want.has(id)) {
      this.duty.delete(id); this.off(id); this.move(id);
      this.bots.get(id)?.bubble(null);
      this.life.resume(id);
    }
    for (const [id, d] of want) {
      const had = this.duty.get(id);
      this.duty.set(id, d);
      if (!had) { this.life.release(id); this.toSeat(id); }
      this.render(id);
    }
  }

  private teamChanged(p: Project): void {
    const before = this.teams.get(p.id) ?? new Set<RoleId>();
    const now = new Set(p.team);
    for (const r of now) if (!before.has(r)) { this.arriving.add(botId(p.id, r)); this.leaving.delete(botId(p.id, r)); }
    for (const r of before) if (!now.has(r)) { this.leaving.add(botId(p.id, r)); this.arriving.delete(botId(p.id, r)); }
    this.teams.set(p.id, now);
  }

  private state(projectId: string, ticketId: string, role: RoleId, s: AgentState): void {
    const id = botId(projectId, role);
    const t = this.tickets.get(ticketId) ?? this.placeholder(ticketId, projectId);
    const had = this.duty.get(id);
    const mine = had?.ticketId === ticketId ? had : undefined;
    if (s === 'idle') {
      // not working any more, but still on duty until the ticket ends (end() hands it back to office life)
      if (!mine || mine.state === 'done' || mine.state === 'failed') return;
      const prev = mine.state;
      mine.state = s;
      if (prev === 'reviewing') this.toSeat(id);
      this.render(id);
      return;
    }
    if (s === 'done' || s === 'failed') {
      if (!mine) return;
      mine.state = s;
      this.off(id);
      const bot = this.bots.get(id);
      if (s === 'failed') bot?.bubble('✗');
      else if (bot) this.wave(bot);
      return;
    }
    const prev = mine?.state;
    if (!mine) { this.duty.set(id, { ticketId, state: s }); this.life.release(id); }
    else mine.state = s;
    const toBoard = role === 'pm' && t.stage === 'plan' && !t.board && (s === 'summoned' || s === 'planning');
    if (toBoard) this.toBoard(id, t);
    else if (role === 'techlead' && s === 'reviewing' && prev !== 'reviewing') this.review(id, ticketId);
    else if (!mine || (prev === 'reviewing' && s !== 'reviewing')) this.toSeat(id);
    this.render(id);
  }

  /** Bubble + monitor for an on-duty bot, from its state and the ticket's open gate. */
  private render(id: string, bot = this.bots.get(id)): void {
    const d = this.duty.get(id);
    if (!d) return;
    const [pid, role] = id.split(':') as [string, RoleId];
    if (d.state === 'done') { bot?.bubble('✓'); return; }
    if (d.state === 'failed') { bot?.bubble('✗'); return; }
    const working = WORKING.includes(d.state);
    this.scene.setWorking(pid, role, working);
    if (!bot) return;
    if (working) { bot.bubble('…'); return; }
    const gate = this.tickets.get(d.ticketId)?.gate;
    const owner = d.state !== 'idle' && (gate === 'final' || ((gate === 'plan' || gate === 'stuck') && role === 'pm'));
    bot.bubble(owner ? '!' : null);
  }

  private end(projectId: string, ticketId: string, how: 'done' | 'failed'): void {
    const t = this.tickets.get(ticketId);
    if (t) t.gate = undefined;
    if (this.active.get(projectId) === ticketId) { this.active.delete(projectId); this.scene.setWhiteboard(projectId, null); }
    for (const [id, d] of [...this.duty]) {
      if (d.ticketId !== ticketId) continue;
      this.duty.delete(id);
      this.off(id);
      this.move(id); // in-flight walks / timers (whiteboard hold, review tour) must not act after the hand-back
      const bot = this.bots.get(id);
      if (how === 'failed') bot?.bubble('✗');
      else if (bot && d.state !== 'done') this.wave(bot);
      this.after(how === 'done' ? DONE_MS : FAIL_MS, () => {
        if (this.duty.has(id)) return; // summoned again (next ticket in the queue)
        if (how === 'failed') this.bots.get(id)?.bubble(null);
        this.life.resume(id);
      });
    }
  }

  private off(id: string): void {
    const [pid, role] = id.split(':') as [string, RoleId];
    this.scene.setWorking(pid, role, false);
  }

  private wave(bot: DirectorBot): void {
    const tok = this.move(bot.id);
    const seat = this.seatOf(bot.id);
    bot.stand();
    bot.face('SW');
    bot.play('waving');
    bot.bubble('✓');
    this.after(WAVE_MS, () => {
      if (!this.current(bot.id, tok)) return;
      bot.play('idle');
      if (seat && near(bot, seat)) bot.sit(seat);
    });
  }

  private toSeat(id: string): void {
    const bot = this.bots.get(id), seat = this.seatOf(id);
    const tok = this.move(id);
    if (!bot || !seat) return;
    if (bot.seated && near(bot, seat)) return;
    bot.goTo(seat, () => { if (this.current(id, tok)) bot.sit(seat); });
  }

  private toBoard(id: string, t: TicketInfo): void {
    t.board = true;
    const bot = this.bots.get(id);
    const spot = this.scene.layout?.spots.find(s => s.id === `whiteboard:${t.projectId}`);
    if (!bot || !spot) return this.toSeat(id);
    const tok = this.move(id);
    bot.goTo(spot, () => {
      if (!this.current(id, tok)) return;
      bot.face(spot.facing);
      bot.play('idle');
      this.after(BOARD_MS, () => { if (this.current(id, tok) && this.duty.has(id)) this.toSeat(id); });
    });
  }

  /** Tech lead: stand at each coder's review spot in turn, then back to its seat. */
  private review(id: string, ticketId: string): void {
    const t = this.tickets.get(ticketId);
    const bot = this.bots.get(id), layout = this.scene.layout;
    if (!t || !bot || !layout) return;
    const pid = t.projectId;
    const fromBuild = t.buildRoles.filter(r => r !== 'techlead');
    const coders = (fromBuild.length ? fromBuild
      : CODERS.filter(r => this.duty.get(botId(pid, r))?.ticketId === ticketId))
      .map(r => layout.seats[botId(pid, r)]?.review).filter((s): s is Spot => !!s);
    const tok = this.move(id);
    const step = (i: number) => {
      if (!this.current(id, tok) || this.duty.get(id)?.state !== 'reviewing') return;
      if (i >= coders.length) return this.toSeat(id);
      const spot = coders[i];
      bot.goTo(spot, () => {
        if (!this.current(id, tok)) return;
        bot.face(spot.facing);
        bot.play('idle');
        this.after(REVIEW_MS, () => step(i + 1));
      });
    };
    step(0);
  }

  private seatOf(id: string): Spot | undefined { return this.scene.layout?.seats[id]?.seat; }

  /** Hallway side of the project's room door. */
  private doorOf(projectId: string): { mx: number; my: number } | null {
    const room = this.scene.layout?.rooms.find(r => r.id === projectId);
    const door = room?.door;
    if (!room || !door) return null;
    const my = (door.y0 + door.y1) / 2;
    const out = room.side === 'left' ? 0.5 : -0.5;
    for (const dx of [out, 0, -out]) if (!this.grid || this.grid.walkable(door.x + dx, my)) return { mx: door.x + dx, my };
    return { mx: door.x, my };
  }

  private move(id: string): number {
    const n = (this.moves.get(id) ?? 0) + 1;
    this.moves.set(id, n);
    return n;
  }

  private current(id: string, tok: number): boolean { return this.moves.get(id) === tok; }
}
