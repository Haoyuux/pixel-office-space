import type { Seat, Spot } from '../layout/types';

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
/** A wanted activity that stays blocked (no free spot, cap reached) this long is given up and re-rolled. */
const GIVE_UP_MS = 45_000;
const COOLDOWN = 2;

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
}

export interface LifeBot { id: string /* projectId:role */ }

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
  want: ActivityId | null;
  wantSince: number;
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

/** Chat needs a free pair and a free partner, and each chat puts it on the partner's cooldown too, so fewer chats get
 * started than picked. This factor (measured over seeded runs, see officeLife.test.ts) makes up for it. */
const CHAT_BOOST = 1.4;
const boost = (w: Record<ActivityId, number>) => ({ ...w, chat: w.chat * CHAT_BOOST });
const CAL_DAY = boost(calibrate(DAY_WEIGHTS)), CAL_NIGHT = boost(calibrate(NIGHT_WEIGHTS));

export class OfficeLife {
  private bots = new Map<string, State>();
  private held = new Map<string, string>(); // spotId -> botId
  private byTag = new Map<string, Spot[]>();
  private byId = new Map<string, Spot>();

  constructor(private o: OfficeLifeOptions) {
    for (const s of o.spots) {
      this.byId.set(s.id, s);
      for (const t of s.tags) { if (!this.byTag.has(t)) this.byTag.set(t, []); this.byTag.get(t)!.push(s); }
    }
  }

  register(bot: LifeBot): void {
    if (this.bots.has(bot.id)) return;
    this.bots.set(bot.id, {
      id: bot.id, projectId: bot.id.split(':')[0], history: [], current: null, until: -Infinity,
      released: false, fresh: true, want: null, wantSince: 0,
    });
  }

  /** The bot has been summoned (ticket work): its spots are freed and it gets no intents until resume(). */
  release(botId: string): void {
    const b = this.bots.get(botId);
    if (!b) return;
    this.free(b);
    b.current = null; b.released = true; b.want = null;
  }

  /** Back to idle life: the next tick gives it a fresh intent. */
  resume(botId: string): void {
    const b = this.bots.get(botId);
    if (!b || !b.released) return;
    // the ticket stint breaks the routine, so the cooldown starts over (and the desk fallback in tick() is open)
    b.released = false; b.until = -Infinity; b.fresh = false; b.history = [];
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
      if (b.want && now - b.wantSince > GIVE_UP_MS) b.want = null;
      if (!b.want) { b.want = this.roll(b); b.wantSince = now; }
      let made = this.fulfil(b, b.want, taken);
      // a bot back from ticket work holds no spot: rather than idle in limbo, it settles at its desk
      if (!made && !b.current && !b.history.slice(-COOLDOWN).includes('desk')) made = [this.assign(b, 'desk', [this.seat(b)], [this.ms(DURATION.desk)])];
      if (!made) continue; // linger where it is and try again next tick
      for (const i of made) { out.push(i); taken.add(i.botId); }
    }
    return out;
  }

  // ---------------------------------------------------------------------------------------------

  private roll(b: State): ActivityId {
    const w = this.o.isNight() ? CAL_NIGHT : CAL_DAY;
    const ok = ACTIVITIES.filter(a => !b.history.slice(-COOLDOWN).includes(a));
    const total = ok.reduce((s, a) => s + w[a], 0);
    let x = this.o.random() * total;
    for (const a of ok) { x -= w[a]; if (x < 0) return a; }
    return ok[ok.length - 1];
  }

  private fulfil(b: State, act: ActivityId, taken: Set<string>): Intent[] | null {
    const leave = this.mayLeave([b]);
    const pick = (spots: Spot[]) => spots.length ? spots[Math.floor(this.o.random() * spots.length)] : null;
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
      && o.current?.activity !== 'chat' && !o.history.slice(-COOLDOWN).includes('chat') && this.mayLeave([b, o]));
    const same = free.filter(o => o.projectId === b.projectId), other = free.filter(o => o.projectId !== b.projectId);
    const list = (this.o.random() < SAME_PROJECT ? (same.length ? same : other) : (other.length ? other : same));
    return list.length ? list[Math.floor(this.o.random() * list.length)] : null;
  }

  /** Would sending these bots outside their rooms keep the out-of-room count within the cap? */
  private mayLeave(group: State[]): boolean {
    const idle = [...this.bots.values()].filter(b => !b.released);
    const outside = idle.filter(b => this.isOutside(b)).length;
    const extra = group.filter(b => !this.isOutside(b)).length;
    return outside + extra <= Math.floor(OUT_CAP * idle.length);
  }

  private isOutside(b: State): boolean { return !!b.current?.spots.some(s => s.room !== b.projectId); }
  private isProjectRoom(room: string): boolean { return room !== 'hall' && room !== 'breakroom'; }

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
    for (const s of spots) this.held.set(s.id, b.id);
    const durationMs = holdMs.reduce((x, y) => x + y, 0);
    const intent: Intent = { botId: b.id, activity, spots, holdMs, durationMs };
    b.current = intent;
    b.until = this.o.now() + durationMs;
    b.history.push(activity);
    if (b.history.length > 8) b.history.shift();
    b.want = null;
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
