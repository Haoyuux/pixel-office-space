import type { Seat, Spot } from '../layout/types';
import { personalWeights, type Personality } from './personality';

/** Idle office life (spec §7.1): a pure, seeded activity picker. No Pixi; time and randomness are injected. */

export type ActivityId = 'desk' | 'coffee' | 'table' | 'bar' | 'lounge' | 'chat' | 'wander';
export const ACTIVITIES: ActivityId[] = ['desk', 'coffee', 'table', 'bar', 'lounge', 'chat', 'wander'];

export const DAY_WEIGHTS: Record<ActivityId, number> = { desk: 4, coffee: 3, table: 2, bar: 1, lounge: 2, chat: 2, wander: 2 };
export const NIGHT_WEIGHTS: Record<ActivityId, number> = { desk: 2, coffee: 2, table: 2, bar: 3, lounge: 4, chat: 3, wander: 1 };

/** Seconds [min, max] per activity (spec §7.1). Coffee is a two-step run: machine, then table or own desk. */
const DURATION: Record<ActivityId, [number, number]> = {
  desk: [30, 90], coffee: [15, 30], table: [30, 60], bar: [30, 60], lounge: [40, 90], chat: [20, 40], wander: [10, 20],
};
const COFFEE_AFTER: [number, number] = [15, 30];
/** First desk stint after a bot enters, so the office doesn't stand up all at once. */
const FIRST_DESK: [number, number] = [5, 40];
/** Share of idle bots allowed outside their own room at once. */
export const OUT_CAP = 0.6;
/** Chat partner comes from the initiator's project with this probability (when both kinds are free). */
export const SAME_PROJECT = 0.6;
const COOLDOWN = 2;
/** How many later picks still try an owed (previously infeasible) activity before it is dropped. */
const OWED_TRIES = 3;
/** Chance a bot with spot preferences takes a free preferred spot over any free spot of the activity. */
export const PREFER = 0.75;

export interface Intent {
  botId: string;
  activity: ActivityId;
  /** Spots to visit in order; all are reserved from intent creation until the bot's next intent or release. */
  spots: Spot[];
  /** How long to stay at each spot (same length as `spots`). */
  holdMs: number[];
  /** Total stay; the next intent comes this long after creation, or after `arrived()` if that is called. */
  durationMs: number;
  partnerId?: string;
  /** Stand-in while the bot's chosen activity is blocked (see OfficeLife.pick); not a weighted pick. */
  filler?: boolean;
}

export interface LifeBot {
  id: string /* projectId:role */;
  /** Multiplies the activity weights and prefers some spots (personality.ts); none = the plain weights. */
  personality?: Personality;
}

export interface OfficeLifeOptions {
  spots: Spot[];
  seats: Record<string, Seat>;
  random: () => number;
  now: () => number;
  isNight: () => boolean;
}

interface State {
  id: string; projectId: string;
  history: ActivityId[];
  current: Intent | null;
  until: number;
  released: boolean;
  fresh: boolean;
  /** A rolled activity that was infeasible: tried first on the next picks (it keeps the long-run mix on weight). */
  owed: ActivityId | null;
  owedTries: number;
  personality?: Personality;
  /** Activities wanted first on the next picks (a tired bot: coffee or lounge), tried before the weighted roll. */
  urge: ActivityId[] | null;
  urgeTries: number;
}

/**
 * The cooldown (never one of the last 2 activities) skews long-run frequencies away from the raw weights
 * (heavy activities are suppressed, light ones boosted). Solve for base weights whose cooldown chain has
 * the spec weights as its stationary activity distribution.
 */
export function calibrate(target: Record<ActivityId, number>): Record<ActivityId, number> {
  const A = ACTIVITIES, n = A.length, tot = A.reduce((s, a) => s + target[a], 0);
  const want = A.map(a => target[a] / tot);
  let w = [...want];
  for (let iter = 0; iter < 200; iter++) {
    // states: (older, latest) with older != latest; power-iterate the stationary distribution
    let pi = new Float64Array(n * n).fill(0);
    for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) if (a !== b) pi[a * n + b] = 1 / (n * (n - 1));
    for (let k = 0; k < 200; k++) {
      const next = new Float64Array(n * n);
      for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) {
        const p = pi[a * n + b];
        if (!p) continue;
        let z = 0;
        for (let c = 0; c < n; c++) if (c !== a && c !== b) z += w[c];
        for (let c = 0; c < n; c++) if (c !== a && c !== b) next[b * n + c] += p * w[c] / z;
      }
      pi = next;
    }
    const f = new Array(n).fill(0);
    for (let b = 0; b < n; b++) for (let c = 0; c < n; c++) f[c] += pi[b * n + c];
    let err = 0;
    w = w.map((x, i) => { err = Math.max(err, Math.abs(f[i] / want[i] - 1)); return x * want[i] / f[i]; });
    if (err < 1e-4) break;
  }
  return Object.fromEntries(A.map((a, i) => [a, w[i]])) as Record<ActivityId, number>;
}

/**
 * A weight is the share of a bot's activities spent on it. The cooldown chain is calibrated on those shares; a
 * chat, though, gives two bots a chat (the initiator and the invited partner), so the initiator's roll for chat
 * uses half the calibrated weight.
 */
const initiation = (w: Record<ActivityId, number>) => ({ ...w, chat: w.chat / 2 });
const CAL_DAY = initiation(calibrate(DAY_WEIGHTS)), CAL_NIGHT = initiation(calibrate(NIGHT_WEIGHTS));
/** Calibrated roll weights per personality and time of day (the multiplied weights are the long-run target). */
const CAL_PERSONAL = new Map<string, Record<ActivityId, number>>();
function rollWeights(p: Personality | undefined, night: boolean): Record<ActivityId, number> {
  if (!p) return night ? CAL_NIGHT : CAL_DAY;
  const key = `${p.id}:${night ? 'n' : 'd'}`;
  let w = CAL_PERSONAL.get(key);
  if (!w) { w = initiation(calibrate(personalWeights(night ? NIGHT_WEIGHTS : DAY_WEIGHTS, p, night))); CAL_PERSONAL.set(key, w); }
  return w;
}

export class OfficeLife {
  private bots = new Map<string, State>();
  private held = new Map<string, string>(); // spotId -> botId
  private byTag = new Map<string, Spot[]>();
  private byId = new Map<string, Spot>();
  /** Bots that were due but found nothing feasible on the last tick (inside, cap full, desk cooling down). */
  private waiting = new Set<string>();
  private yielding = false;

  constructor(private o: OfficeLifeOptions) { this.index(o.spots); }

  private index(spots: Spot[]): void {
    this.byId.clear(); this.byTag.clear();
    for (const s of spots) {
      this.byId.set(s.id, s);
      for (const t of s.tags) { if (!this.byTag.has(t)) this.byTag.set(t, []); this.byTag.get(t)!.push(s); }
    }
  }

  register(bot: LifeBot): void {
    if (this.bots.has(bot.id)) return;
    this.bots.set(bot.id, {
      id: bot.id, projectId: bot.id.split(':')[0], history: [], current: null, until: -Infinity,
      released: false, fresh: true, owed: null, owedTries: 0, personality: bot.personality, urge: null, urgeTries: 0,
    });
  }

  /** The bot left the office (team member or project removed): forget it and free its spots. */
  unregister(botId: string): void {
    const b = this.bots.get(botId);
    if (!b) return;
    this.free(b);
    this.bots.delete(botId);
    this.waiting.delete(botId);
  }

  /**
   * The building changed. Spots are matched by id (rooms never move, slots are stable): reservations and
   * current intents carry over; an intent whose spot is gone ends now, so the bot re-picks on the next tick.
   */
  setLayout(spots: Spot[], seats: Record<string, Seat>): void {
    this.o = { ...this.o, spots, seats };
    this.index(spots);
    for (const id of [...this.held.keys()]) if (!this.byId.has(id)) this.held.delete(id);
    for (const b of this.bots.values()) {
      const cur = b.current;
      if (!cur) continue;
      const fresh = cur.spots.map(s => this.byId.get(s.id));
      if (fresh.every(Boolean)) cur.spots = fresh as Spot[];
      else { for (const s of fresh) if (s && this.held.get(s.id) === b.id) this.held.delete(s.id); b.current = null; b.until = -Infinity; }
    }
  }

  /** The bot has been summoned (ticket work): its spots are freed and it gets no intents until resume(). */
  release(botId: string): void {
    const b = this.bots.get(botId);
    if (!b) return;
    this.free(b);
    b.current = null; b.released = true; this.waiting.delete(botId);
  }

  /** Back to idle life: the next tick gives it a fresh intent. */
  resume(botId: string): void {
    const b = this.bots.get(botId);
    if (!b || !b.released) return;
    // the ticket stint breaks the routine, so the cooldown starts over (and the desk fallback in tick() is open)
    b.released = false; b.until = -Infinity; b.fresh = false; b.history = [];
  }

  /**
   * The bot wants one of these activities next (e.g. tired after a long ticket: coffee or lounge). Its next picks try
   * them first, still within the cooldown, the out-of-room cap and feasibility; after a few blocked tries it gives up.
   */
  urge(botId: string, activities: ActivityId[]): void {
    const b = this.bots.get(botId);
    if (!b || !activities.length) return;
    b.urge = [...activities]; b.urgeTries = 0;
  }

  /** The bot reached its first spot: its stay is counted from now (walking time is not part of it). */
  arrived(botId: string): void {
    const b = this.bots.get(botId);
    if (b?.current) b.until = this.o.now() + b.current.durationMs;
  }

  /** Which bot holds a spot, if any. */
  holder(spotId: string): string | undefined { return this.held.get(spotId); }

  tick(): Intent[] {
    const now = this.o.now(), out: Intent[] = [], taken = new Set<string>();
    const due = this.shuffle([...this.bots.values()].filter(b => !b.released && now >= b.until));
    for (const b of due) {
      if (taken.has(b.id)) continue;
      if (b.fresh) {
        b.fresh = false;
        out.push(this.assign(b, 'desk', [this.seat(b)], [this.ms(FIRST_DESK)]));
        taken.add(b.id);
        continue;
      }
      // cap rotation: an outside bot gives its slot to a stuck in-room bot when it can find something in its room
      this.yielding = this.mustYield(b);
      let made = this.pick(b, taken);
      if (!made && this.yielding) { this.yielding = false; made = this.pick(b, taken); }
      this.yielding = false;
      // nothing allowed is feasible (cap full, desk cooling down): stay put and try again next tick
      if (!made) { this.waiting.add(b.id); continue; }
      this.waiting.delete(b.id);
      for (const i of made) { out.push(i); taken.add(i.botId); }
    }
    return out;
  }

  // ---------------------------------------------------------------------------------------------

  /**
   * Weighted roll over the activities the cooldown allows. If the rolled activity is infeasible right now (no free
   * spot, cap reached, no free partner) the bot does not idle: it rolls again among the feasible ones on the same
   * tick, marked `filler`, and the blocked activity is owed: tried first on its next few picks. That keeps the long-run
   * mix of chosen activities on the §7.1 weights even where capacity is tight (2 lounge seats, the 60% cap).
   */
  private pick(b: State, taken: Set<string>): Intent[] | null {
    const w = rollWeights(b.personality, this.o.isNight());
    const ok = ACTIVITIES.filter(a => !b.history.slice(-COOLDOWN).includes(a));
    if (b.urge) {
      const urged = this.urged(b, ok, taken);
      if (urged) return urged;
    }
    const owed = b.owed && ok.includes(b.owed) ? b.owed : null;
    const want = owed ?? this.roll(ok, w);
    const made = want && this.fulfil(b, want, taken);
    if (made) { b.owed = null; return made; }
    if (owed) { if (++b.owedTries >= OWED_TRIES) b.owed = null; }
    else { b.owed = want; b.owedTries = 0; }
    const rest = ok.filter(a => a !== want);
    while (rest.length) {
      const a = this.roll(rest, w)!;
      const filler = this.fulfil(b, a, taken);
      if (filler) { for (const i of filler) i.filler = true; return filler; }
      rest.splice(rest.indexOf(a), 1);
    }
    return null;
  }

  /** An urged activity (random order among the allowed ones), or null; the urge ends when met or after OWED_TRIES. */
  private urged(b: State, ok: ActivityId[], taken: Set<string>): Intent[] | null {
    const want = this.shuffle(b.urge!.filter(a => ok.includes(a)));
    for (const a of want) {
      const made = this.fulfil(b, a, taken);
      if (made) { b.urge = null; return made; }
    }
    if (++b.urgeTries >= OWED_TRIES) b.urge = null;
    return null;
  }

  private roll(ok: ActivityId[], w: Record<ActivityId, number>): ActivityId | null {
    if (!ok.length) return null;
    let x = this.o.random() * ok.reduce((s, a) => s + w[a], 0);
    for (const a of ok) { x -= w[a]; if (x < 0) return a; }
    return ok[ok.length - 1];
  }

  private fulfil(b: State, act: ActivityId, taken: Set<string>): Intent[] | null {
    const leave = this.mayLeave([b]) && !this.yielding;
    const prefer = b.personality?.prefer;
    const pick = (spots: Spot[]) => {
      // a preferred free spot (arcade, reading nook, sofa) wins most of the time
      const liked = prefer ? spots.filter(s => s.tags.some(t => prefer.includes(t))) : [];
      const from = liked.length && this.o.random() < PREFER ? liked : spots;
      return from.length ? from[Math.floor(this.o.random() * from.length)] : null;
    };
    const dur = this.ms(DURATION[act]);
    switch (act) {
      case 'desk': return [this.assign(b, act, [this.seat(b)], [dur])];
      case 'coffee': {
        if (!leave) return null;
        const machine = pick(this.freeTagged('coffee', b));
        if (!machine) return null;
        const table = this.o.random() < 0.5 ? pick(this.freeTagged('table', b)) : null;
        return [this.assign(b, act, [machine, table ?? this.seat(b)], [dur, this.ms(COFFEE_AFTER)])];
      }
      case 'table': case 'bar': case 'lounge': {
        if (!leave) return null;
        const s = pick(this.freeTagged(act, b));
        return s ? [this.assign(b, act, [s], [dur])] : null;
      }
      case 'wander': {
        const s = pick(this.freeTagged('wander', b).filter(s => s.room === b.projectId || (leave && !this.isProjectRoom(s.room))));
        return s ? [this.assign(b, act, [s], [dur])] : null;
      }
      case 'chat': {
        if (this.yielding) return null;
        const pairs = this.freeTagged('chat', b).filter(s => s.pair && this.isFree(this.byId.get(s.pair), b));
        const mine = pick(pairs);
        if (!mine) return null;
        const partner = this.partnerFor(b, taken);
        if (!partner) return null;
        const theirs = this.byId.get(mine.pair!)!;
        const a = this.assign(b, act, [mine], [dur]);
        const p = this.assign(partner, act, [theirs], [dur]);
        a.partnerId = partner.id; p.partnerId = b.id;
        return [a, p];
      }
    }
  }

  private partnerFor(b: State, taken: Set<string>): State | null {
    const free = [...this.bots.values()].filter(o => o !== b && !o.released && !o.fresh && !taken.has(o.id)
      && o.current?.activity !== 'chat' && !o.history.slice(-COOLDOWN).includes('chat') && !this.mustYield(o) && this.mayLeave([b, o]));
    const same = free.filter(o => o.projectId === b.projectId), other = free.filter(o => o.projectId !== b.projectId);
    const list = (this.o.random() < SAME_PROJECT ? (same.length ? same : other) : (other.length ? other : same));
    return list.length ? list[Math.floor(this.o.random() * list.length)] : null;
  }

  /**
   * Cap rotation: while the cap is full and an in-room bot is stuck waiting for a slot, a bot that is already out
   * comes back in on its next pick instead of hogging the slot.
   */
  private mustYield(b: State): boolean {
    if (!this.isOutside(b) || ![...this.waiting].some(id => { const o = this.bots.get(id); return o && !o.released && !this.isOutside(o); })) return false;
    const idle = [...this.bots.values()].filter(o => !o.released);
    return idle.filter(o => this.isOutside(o)).length >= Math.floor(OUT_CAP * idle.length);
  }

  /** Would sending these bots outside their rooms keep the out-of-room count within the cap? */
  private mayLeave(group: State[]): boolean {
    const idle = [...this.bots.values()].filter(b => !b.released);
    const outside = idle.filter(b => this.isOutside(b)).length;
    const extra = group.filter(b => !this.isOutside(b)).length;
    return outside + extra <= Math.floor(OUT_CAP * idle.length);
  }

  private isOutside(b: State): boolean { return !!b.current?.spots.some(s => s.room !== b.projectId); }
  private isProjectRoom(room: string): boolean { return room !== 'hall' && room !== 'lounge' && room !== 'cafeteria'; }

  private seat(b: State): Spot {
    const s = this.o.seats[b.id]?.seat;
    if (!s) throw new Error(`No seat for bot ${b.id}`);
    return s;
  }

  /** Free spots with a tag, never another project's room (bots only visit their own room and the shared space). */
  private freeTagged(tag: string, b: State): Spot[] {
    return (this.byTag.get(tag) ?? []).filter(s => this.isFree(s, b) && (s.room === b.projectId || !this.isProjectRoom(s.room)));
  }

  private isFree(s: Spot | undefined, b: State): boolean {
    if (!s) return false;
    const h = this.held.get(s.id);
    return h === undefined || h === b.id;
  }

  private assign(b: State, activity: ActivityId, spots: Spot[], holdMs: number[]): Intent {
    this.free(b);
    this.waiting.delete(b.id);
    for (const s of spots) this.held.set(s.id, b.id);
    const durationMs = holdMs.reduce((x, y) => x + y, 0);
    const intent: Intent = { botId: b.id, activity, spots, holdMs, durationMs };
    b.current = intent;
    b.until = this.o.now() + durationMs;
    b.history.push(activity);
    if (b.history.length > 8) b.history.shift();
    return intent;
  }

  private free(b: State): void {
    for (const s of b.current?.spots ?? []) if (this.held.get(s.id) === b.id) this.held.delete(s.id);
  }

  private ms([lo, hi]: [number, number]): number { return Math.round((lo + this.o.random() * (hi - lo)) * 1000); }

  private shuffle<T>(a: T[]): T[] {
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(this.o.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  }
}

/** Roster diff on a rebuild: bots whose id and look are unchanged are kept; a changed look is a remove + add. */
export function diffRoster(prev: Map<string, string>, next: { id: string; key: string }[]): { keep: string[]; add: string[]; remove: string[] } {
  const keep: string[] = [], add: string[] = [], remove: string[] = [];
  const nextIds = new Set(next.map(n => n.id));
  for (const n of next) {
    const k = prev.get(n.id);
    if (k === n.key) keep.push(n.id);
    else { add.push(n.id); if (k !== undefined) remove.push(n.id); }
  }
  for (const id of prev.keys()) if (!nextIds.has(id)) remove.push(id);
  return { keep, add, remove };
}
