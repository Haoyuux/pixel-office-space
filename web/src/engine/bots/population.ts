import type { Ticker } from 'pixi.js';
import type { Project, RoleId } from '@office/shared';
import { dirFrom } from '../iso';
import { loadCharacter } from '../assets';
import type { PieceMeta } from '../pieces';
import type { BuildingLayout, Spot } from '../layout/types';
import { WalkGrid } from '../walkgrid';
import type { OfficeScene } from '../render/scene';
import { Bot } from './bot';
import { OfficeLife, diffRoster, type Intent } from './officeLife';
import { SimClock, MAX_DT } from './simClock';

const LIFE_TICK_MS = 250;
const WAVE_MS = 2400, WAVE_RANGE = 4;

interface Plan { intent: Intent; step: number; holding: boolean; left: number; arrivedAll: boolean }

/** Owns the bots of the current layout and drives them from OfficeLife intents. */
export class Population {
  readonly bots = new Map<string, Bot>();
  life: OfficeLife | null = null;
  grid: WalkGrid | null = null;
  private plans = new Map<string, Plan>();
  private released = new Set<string>();
  /** look key per bot id, for the roster diff */
  private keys = new Map<string, string>();
  private leaving = new Set<Bot>();
  private working = new Set<string>();
  private since = 0;
  private gen = 0;
  /** Office life runs on this clamped clock, not wall time: after a hidden tab the bots don't all become due at once. */
  private clock = new SimClock();
  private tick = (t: Ticker) => this.update(Math.min(MAX_DT, t.deltaMS));

  constructor(private scene: OfficeScene, private ticker: Ticker, private random: () => number = Math.random) {
    ticker.add(this.tick);
  }

  destroy(): void {
    this.ticker.remove(this.tick);
    this.gen++;
    this.clear();
  }

  /**
   * Sync the bots with a new layout/roster (call after scene.setLayout(layout)). Bots whose id and look are
   * unchanged are kept as they are, mid-activity; new team members are created (seated at their desk unless
   * `onAdded` places them) and removed ones are taken out (destroyed at once unless `onRemoved` animates them).
   */
  async build(layout: BuildingLayout, projects: Project[], meta: Record<string, PieceMeta>): Promise<void> {
    const gen = ++this.gen;
    const roster = projects.flatMap(p => p.team.filter(r => layout.seats[`${p.id}:${r}`])
      .map(role => ({ id: `${p.id}:${role}`, p, role, look: p.looks[role], key: `${p.looks[role].character}/${p.looks[role].palette}` })));
    const diff = diffRoster(this.keys, roster);
    for (const id of diff.remove) this.remove(id);
    const grid = this.grid = new WalkGrid(layout, meta);
    for (const b of this.bots.values()) b.setGrid(grid);
    if (this.life) this.life.setLayout(layout.spots, layout.seats);
    else {
      this.life = new OfficeLife({ spots: layout.spots, seats: layout.seats, random: this.random, now: this.clock.now, isNight: () => this.scene.night });
      this.since = LIFE_TICK_MS;
    }
    const adds = roster.filter(r => diff.add.includes(r.id));
    const sheets = await Promise.all(adds.map(r => loadCharacter(r.look)));
    if (gen !== this.gen || this.scene.layout !== layout || !this.life) return;
    adds.forEach((r, i) => {
      const seat = layout.seats[r.id].seat;
      const bot = new Bot({ id: r.id, projectId: r.p.id, role: r.role, look: r.look, sheets: sheets[i], grid, at: seat });
      bot.sit(seat);
      bot.attach(this.scene);
      this.bots.set(r.id, bot);
      this.keys.set(r.id, r.key);
      this.life!.register(bot);
      if (this.released.has(r.id)) this.life!.release(r.id);
      this.hooks.onAdded?.(bot, seat);
    });
  }

  /** Optional hooks for Task 10 (walk in from the door and wave / walk out to the hallway end). */
  hooks: {
    onAdded?: (bot: Bot, seat: Spot) => void;
    /** Resolve when the bot may be destroyed; it keeps being updated until then. */
    onRemoved?: (bot: Bot) => Promise<void> | void;
  } = {};

  private remove(id: string): void {
    const bot = this.bots.get(id);
    this.bots.delete(id); this.keys.delete(id); this.plans.delete(id);
    this.life?.unregister(id);
    this.setWorking(id, false);
    if (!bot) return;
    const done = this.hooks.onRemoved?.(bot);
    if (!done) { bot.destroy(); return; }
    this.leaving.add(bot);
    void Promise.resolve(done).finally(() => { this.leaving.delete(bot); bot.destroy(); });
  }

  /** Task 10 (ticket director) takes the bot over: it stops idling and its spots are freed. */
  release(botId: string): void {
    this.released.add(botId);
    this.life?.release(botId);
    this.plans.delete(botId);
    this.setWorking(botId, false);
    const b = this.bots.get(botId);
    if (b) b.bubble(null);
  }

  resume(botId: string): void {
    this.released.delete(botId);
    this.life?.resume(botId);
  }

  update(dt: number): void {
    dt = this.clock.step(dt);
    for (const b of this.bots.values()) b.update(dt);
    for (const b of this.leaving) b.update(dt);
    if (!this.life) return;
    this.since += dt;
    if (this.since >= LIFE_TICK_MS) {
      this.since = 0;
      for (const i of this.life.tick()) this.start(i);
    }
    for (const [id, plan] of this.plans) this.advance(id, plan, dt);
  }

  // ---------------------------------------------------------------------------------------------

  private clear(): void {
    for (const id of this.working) { const [p, r] = id.split(':'); this.scene.setWorking(p, r as RoleId, false); }
    this.working.clear();
    for (const b of [...this.bots.values(), ...this.leaving]) b.destroy();
    this.bots.clear(); this.plans.clear(); this.keys.clear(); this.leaving.clear();
    this.life = null;
  }

  private start(intent: Intent): void {
    const bot = this.bots.get(intent.botId);
    if (!bot) return;
    bot.bubble(null);
    const plan: Plan = { intent, step: 0, holding: false, left: 0, arrivedAll: false };
    this.plans.set(bot.id, plan);
    this.walk(bot, plan);
  }

  private walk(bot: Bot, plan: Plan): void {
    const spot = plan.intent.spots[plan.step];
    const seat = this.scene.layout?.seats[bot.id]?.seat;
    if (!(seat && spot.id === seat.id && bot.seated && bot.mx === seat.mx && bot.my === seat.my)) this.setWorking(bot.id, false);
    bot.goTo(spot, () => {
      if (this.plans.get(bot.id) !== plan) return;
      this.arrive(bot, plan, spot);
      // a chat's clock starts when both partners are there (advance()), so they leave together
      if (plan.step === 0 && plan.intent.activity !== 'chat') this.life?.arrived(bot.id);
      plan.holding = true;
      plan.left = plan.intent.holdMs[plan.step];
    });
  }

  private arrive(bot: Bot, plan: Plan, spot: Spot): void {
    const act = plan.intent.activity, afterCoffee = act === 'coffee' && plan.step > 0;
    if (spot.pose === 'sit') {
      bot.play(afterCoffee || (act === 'table' && this.random() < 0.5) ? 'drinking' : 'idle');
      bot.sit(spot);
    } else {
      bot.face(spot.facing);
      bot.play(spot.pose === 'drink' || afterCoffee ? 'drinking' : 'idle');
    }
    if (spot.tags.includes('seat')) this.setWorking(bot.id, true);
    if (act === 'chat') {
      const partner = plan.intent.partnerId ? this.plans.get(plan.intent.partnerId) : undefined;
      const theirs = partner?.intent.spots[0];
      if (theirs && spot.pose !== 'sit') bot.face(dirFrom(theirs.mx - spot.mx, theirs.my - spot.my));
    }
    if (act === 'wander') {
      // wave at a passing bot (or now and then at nobody in particular)
      const near = [...this.bots.values()].find(o => o !== bot && o.walking && Math.hypot(o.mx - bot.mx, o.my - bot.my) < WAVE_RANGE);
      if (near || this.random() < 0.3) {
        if (near) bot.face(dirFrom(near.mx - bot.mx, near.my - bot.my));
        bot.play('waving');
      }
    }
  }

  private advance(id: string, plan: Plan, dt: number): void {
    const bot = this.bots.get(id);
    if (!bot || !plan.holding) return;
    const { intent } = plan;
    if (intent.activity === 'chat') {
      const other = intent.partnerId ? this.plans.get(intent.partnerId) : undefined;
      const together = other?.intent.partnerId === id && other.intent.activity === 'chat';
      if (!together) bot.bubble(null); // partner was summoned away
      else if (!plan.arrivedAll && other.holding) {
        plan.arrivedAll = other.arrivedAll = true;
        plan.left = other.left = intent.holdMs[0];
        for (const b of [id, intent.partnerId!]) { this.bots.get(b)?.bubble('💬'); this.life?.arrived(b); }
      }
    }
    const held = intent.holdMs[plan.step] - plan.left;
    plan.left -= dt;
    if (intent.activity === 'wander' && held + dt >= WAVE_MS && held < WAVE_MS) bot.play('idle');
    if (plan.left > 0 || plan.step >= intent.spots.length - 1) return;
    plan.step++; plan.holding = false;
    this.walk(bot, plan);
  }

  /** Always forwarded: the ticket director may have switched the monitor while it owned the bot. */
  private setWorking(botId: string, on: boolean): void {
    if (on) this.working.add(botId); else this.working.delete(botId);
    const [p, r] = botId.split(':');
    this.scene.setWorking(p, r as RoleId, on);
  }
}
