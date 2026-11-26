import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Project, RoleId } from '@office/shared';
import { buildLayout } from '../src/engine/layout/building';
import { parsePieces } from '../src/engine/pieces';
import { OfficeLife, diffRoster, DAY_WEIGHTS, NIGHT_WEIGHTS, type ActivityId, type Intent } from '../src/engine/bots/officeLife';

const META = parsePieces(readFileSync(resolve(__dirname, '../../assets/office/Isometric_Pixel_Props/pieces.csv'), 'utf8'));
const TEAM: RoleId[] = ['pm', 'techlead', 'frontend', 'backend', 'qa'];
const proj = (id: string, slot: number): Project =>
  ({ id, name: id, folder: '.', accent: 'cyan', team: TEAM, slot, looks: {} as Project['looks'], createdAt: '' });
const L = buildLayout([proj('a', 0), proj('b', 1)], META);
const BOTS = ['a', 'b'].flatMap(p => TEAM.map(r => `${p}:${r}`));
const projectOf = (botId: string) => botId.split(':')[0];
const SEEDS = [7, 1, 2, 3, 11];
const ACTS: ActivityId[] = ['desk', 'coffee', 'table', 'bar', 'lounge', 'chat', 'wander'];

/** mulberry32: small seeded PRNG */
function seeded(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function world(seed = 1, night = false) {
  let t = 0;
  const life = new OfficeLife({ spots: L.spots, seats: L.seats, random: seeded(seed), now: () => t, isNight: () => night });
  for (const id of BOTS) life.register({ id });
  /** current intent per bot, as an observer outside OfficeLife would track it */
  const current = new Map<string, Intent>();
  const step = (ms: number) => { t += ms; const out = life.tick(); for (const i of out) current.set(i.botId, i); return out; };
  return { life, current, step, get t() { return t; } };
}

/**
 * Share of each bot's chosen activities (a chat counts for both partners: the weight is the share of time-slots
 * a bot spends chatting). `filler` intents (stand-ins while the chosen activity is blocked) are left out.
 */
function frequencies(intents: Intent[]) {
  const n: Record<string, number> = Object.fromEntries(ACTS.map(a => [a, 0]));
  for (const i of intents) if (!i.filler) n[i.activity] += 1;
  const total = Object.values(n).reduce((a, b) => a + b, 0);
  return Object.fromEntries(ACTS.map(a => [a, n[a] / total])) as Record<ActivityId, number>;
}
const share = (w: Record<ActivityId, number>) => {
  const total = ACTS.reduce((a, k) => a + w[k], 0);
  return Object.fromEntries(ACTS.map(a => [a, w[a] / total])) as Record<ActivityId, number>;
};

/** Frequencies averaged over SEEDS (layout-coupled: 2 lounge seats, 2 bar spots, 3 table chairs, 2 chat pairs). */
function averaged(night: boolean) {
  const runs = SEEDS.map(seed => frequencies(run(night, 1000, 5000, seed)));
  return Object.fromEntries(ACTS.map(a => [a, runs.reduce((s, r) => s + r[a], 0) / runs.length])) as Record<ActivityId, number>;
}

function run(night: boolean, ticks = 1000, ms = 5000, seed = 7) {
  const w = world(seed, night);
  const all: Intent[] = [];
  for (let k = 0; k < ticks; k++) all.push(...w.step(ms));
  return all.filter(i => i.durationMs > 0 && !(i.activity === 'desk' && all.indexOf(i) < BOTS.length));
}

describe('OfficeLife', () => {
  it('uses the spec §7.1 weights', () => {
    expect(DAY_WEIGHTS).toEqual({ desk: 4, coffee: 3, table: 2, bar: 1, lounge: 2, chat: 2, wander: 2 });
    expect(NIGHT_WEIGHTS).toEqual({ desk: 2, coffee: 2, table: 2, bar: 3, lounge: 4, chat: 3, wander: 1 });
  });

  it('starts every bot at its own desk', () => {
    const w = world();
    const first = w.step(0);
    expect(first.map(i => i.botId).sort()).toEqual([...BOTS].sort());
    for (const i of first) {
      expect(i.activity).toBe('desk');
      expect(i.spots[0].id).toBe(L.seats[i.botId].seat.id);
    }
  });

  it('follows the day weights within ±25% over 1000 ticks with 10 bots', () => {
    // Averaged over several fixed seeds: a single seed is deterministic but only a few % inside the bound.
    // Layout-coupled: the margins depend on the breakroom's spot counts (2 lounge seats, 2 bar spots, 3 table chairs).
    const f = averaged(false);
    const want = share(DAY_WEIGHTS);
    for (const a of ACTS) {
      expect.soft(Math.abs(f[a] - want[a]) / want[a], `${a}: got ${f[a].toFixed(3)} want ${want[a].toFixed(3)}`).toBeLessThanOrEqual(0.25);
    }
  });

  it('raises bar and lounge at night', () => {
    const day = averaged(false), night = averaged(true);
    const dayW = share(DAY_WEIGHTS), nightW = share(NIGHT_WEIGHTS);
    expect(night.bar).toBeGreaterThan(day.bar * 0.75 * (nightW.bar / dayW.bar));
    expect(night.lounge).toBeGreaterThan(day.lounge * 0.75 * (nightW.lounge / dayW.lounge));
    expect(night.desk).toBeLessThan(day.desk);
    for (const a of ACTS) {
      expect.soft(Math.abs(night[a] - nightW[a]) / nightW[a], `${a}: got ${night[a].toFixed(3)} want ${nightW[a].toFixed(3)}`).toBeLessThanOrEqual(0.25);
    }
  });

  it('never lets two bots hold the same spot; a spot stays reserved until its intent ends', () => {
    const w = world(3);
    for (let k = 0; k < 2000; k++) {
      const out = w.step(1000);
      const holder = new Map<string, string>();
      for (const [bot, i] of w.current) for (const s of i.spots) {
        expect(holder.get(s.id), `spot ${s.id} held by ${holder.get(s.id)} and ${bot}`).toBeUndefined();
        holder.set(s.id, bot);
      }
      // the library's own bookkeeping agrees with the observer
      for (const [spot, bot] of holder) expect(w.life.holder(spot)).toBe(bot);
      for (const i of out) for (const s of i.spots) expect(w.life.holder(s.id)).toBe(i.botId);
    }
  });

  it('only sends a bot to its own seat, never to someone else\'s', () => {
    const w = world(4);
    for (let k = 0; k < 1000; k++) for (const i of w.step(3000)) {
      for (const s of i.spots) if (s.tags.includes('seat')) expect(s.id).toBe(L.seats[i.botId].seat.id);
    }
  });

  it('never repeats either of a bot\'s last 2 activities', () => {
    const w = world(5);
    const hist = new Map<string, ActivityId[]>();
    for (let k = 0; k < 1500; k++) for (const i of w.step(4000)) {
      const h = hist.get(i.botId) ?? [];
      expect(h.slice(-2), `${i.botId} repeated ${i.activity}`).not.toContain(i.activity);
      hist.set(i.botId, [...h, i.activity]);
    }
    expect([...hist.values()].every(h => h.length > 20)).toBe(true);
  });

  it('keeps at most 60% of idle bots outside their own room', () => {
    for (const night of [false, true]) {
      const w = world(6, night);
      let peak = 0;
      for (let k = 0; k < 1500; k++) {
        w.step(2000);
        const out = [...w.current].filter(([bot, i]) => i.spots.some(s => s.room !== projectOf(bot))).length;
        peak = Math.max(peak, out);
        expect(out).toBeLessThanOrEqual(Math.floor(0.6 * BOTS.length));
      }
      expect(peak).toBe(6); // the cap is actually reached, not just respected trivially
    }
  });

  it('counts the cap against idle bots only (released bots are not idle)', () => {
    const w = world(8);
    w.step(0);
    for (const id of BOTS.slice(0, 5)) { w.life.release(id); w.current.delete(id); }
    for (let k = 0; k < 800; k++) {
      w.step(2000);
      const out = [...w.current].filter(([bot, i]) => i.spots.some(s => s.room !== projectOf(bot))).length;
      expect(out).toBeLessThanOrEqual(3); // floor(0.6 * 5)
    }
  });

  it('chat reserves two paired spots and a partner, same project ≈60% of the time', () => {
    const w = world(9);
    let chats = 0, same = 0;
    for (let k = 0; k < 20000 && chats < 500; k++) {
      const out = w.step(3000);
      const inChat = out.filter(i => i.activity === 'chat');
      expect(inChat.length % 2).toBe(0);
      for (const a of inChat) {
        expect(a.partnerId).toBeDefined();
        const b = inChat.find(i => i.botId === a.partnerId)!;
        expect(b, `partner ${a.partnerId} got no chat intent`).toBeDefined();
        expect(b.partnerId).toBe(a.botId);
        expect(a.spots).toHaveLength(1);
        expect(a.spots[0].pair).toBe(b.spots[0].id);
        expect(b.spots[0].pair).toBe(a.spots[0].id);
        expect(a.spots[0].tags).toContain('chat');
        expect(a.durationMs).toBe(b.durationMs);
        if (a.botId < b.botId) { chats++; if (projectOf(a.botId) === projectOf(b.botId)) same++; }
      }
    }
    expect(chats).toBeGreaterThanOrEqual(500);
    expect(Math.abs(same / chats - 0.6)).toBeLessThanOrEqual(0.15);
  });

  it('release frees the bot\'s spots at once and silences it until resume', () => {
    const w = world(10);
    let victim: Intent | undefined;
    for (let k = 0; k < 500 && !victim; k++) victim = w.step(3000).find(i => i.spots.some(s => s.room === 'breakroom'));
    expect(victim).toBeDefined();
    const id = victim!.botId;
    w.life.release(id);
    for (const s of victim!.spots) expect(w.life.holder(s.id)).toBeUndefined();
    for (let k = 0; k < 300; k++) expect(w.step(3000).some(i => i.botId === id || i.partnerId === id)).toBe(false);
    w.life.resume(id);
    const back = w.step(0).find(i => i.botId === id) ?? (() => { for (let k = 0; k < 20; k++) { const f = w.step(3000).find(i => i.botId === id); if (f) return f; } })();
    expect(back).toBeDefined();
  });

  it('only issues a new intent once the current one has run its duration (arrived() restarts the clock)', () => {
    const w = world(11);
    w.step(0);
    const started = new Map<string, number>();
    for (const id of BOTS) started.set(id, 0);
    for (let k = 0; k < 500; k++) {
      const before = new Map(w.current);
      for (const i of w.step(1000)) {
        const prev = before.get(i.botId);
        // partners can be pulled out early to chat; everyone else waits out the full duration
        if (prev && i.activity !== 'chat') expect(w.t - started.get(i.botId)!).toBeGreaterThanOrEqual(prev.durationMs);
        started.set(i.botId, w.t);
      }
    }
    // arrived(): the duration counts from arrival, not from intent creation
    const w2 = world(12);
    const [first] = w2.step(0);
    w2.step(first.durationMs - 1);
    w2.life.arrived(first.botId);
    expect(w2.step(first.durationMs - 1).some(i => i.botId === first.botId)).toBe(false);
  });
  it('re-rolls a blocked pick on the same tick: a due bot only lingers when its desk is cooling down and nothing else is feasible', () => {
    // no lounge seats at all, so every lounge roll is blocked
    const spots = L.spots.filter(s => !s.tags.includes('lounge'));
    let t = 0;
    const life = new OfficeLife({ spots, seats: L.seats, random: seeded(21), now: () => t, isNight: () => true });
    for (const id of BOTS) life.register({ id });
    const cur = new Map<string, { i: Intent; at: number }>();
    const hist = new Map<string, ActivityId[]>();
    let due = 0, lingered = 0;
    for (let k = 0; k < 3000; k++) {
      t += 1000;
      const out = life.tick();
      const got = new Set(out.map(i => i.botId));
      const outside = [...cur].filter(([bot, c]) => c.i.spots.some(s => s.room !== projectOf(bot))).length;
      for (const [bot, c] of cur) {
        if (t < c.at + c.i.durationMs) continue;
        due++;
        if (got.has(bot)) continue;
        lingered++;
        // allowed only when the bot is inside, the cap is full and its cooldown blocks the desk
        // (the only other in-room activity, wander at the room's shelf, may be cooling down or taken)
        expect(c.i.spots.some(s => s.room !== projectOf(bot))).toBe(false);
        expect(outside).toBeGreaterThan(0);
        expect(hist.get(bot)!.slice(-2)).toContain('desk');
      }
      for (const i of out) {
        expect(i.activity).not.toBe('lounge');
        cur.set(i.botId, { i, at: t });
        hist.set(i.botId, [...(hist.get(i.botId) ?? []), i.activity]);
      }
    }
    expect(due).toBeGreaterThan(500);
    expect(due - lingered).toBeGreaterThan(500);
  });

  it('follows a layout change: kept bots keep their reservations, removed bots free theirs', () => {
    const w = world(13);
    for (let k = 0; k < 40; k++) w.step(3000);
    const keptBot = BOTS.find(id => id.startsWith('a:'))!;
    const kept = w.current.get(keptBot)!;
    // project b leaves; a new project c arrives in slot 2
    const L2 = buildLayout([proj('a', 0), proj('c', 2)], META);
    for (const id of BOTS.filter(id => id.startsWith('b:'))) w.life.unregister(id);
    w.life.setLayout(L2.spots, L2.seats);
    for (const r of TEAM) w.life.register({ id: `c:${r}` });
    for (const s of kept.spots) if (L2.spots.some(q => q.id === s.id)) expect(w.life.holder(s.id)).toBe(keptBot);
    for (const s of L.spots) { const h = w.life.holder(s.id); if (h) expect(h.startsWith('b:')).toBe(false); }
    const ids = new Set(L2.spots.map(s => s.id));
    for (let k = 0; k < 300; k++) for (const i of w.step(3000)) {
      expect(i.botId.startsWith('b:')).toBe(false);
      for (const s of i.spots) expect(ids.has(s.id), `stale spot ${s.id}`).toBe(true);
    }
  });
});

describe('diffRoster', () => {
  it('keeps unchanged bots, adds new ones, removes gone ones and replaces a changed look', () => {
    const prev = new Map([['a:pm', 'Clara/a'], ['a:qa', 'Hugo/b'], ['b:pm', 'Leo/c']]);
    const d = diffRoster(prev, [{ id: 'a:pm', key: 'Clara/a' }, { id: 'a:qa', key: 'Hugo/c' }, { id: 'c:pm', key: 'Nina/a' }]);
    expect(d.keep).toEqual(['a:pm']);
    expect(d.add.sort()).toEqual(['a:qa', 'c:pm']);
    expect(d.remove.sort()).toEqual(['a:qa', 'b:pm']);
  });
});

describe('SimClock (office life after a hidden tab)', () => {
  it('a long gap advances the clock by one clamped step, so bots do not all become due at once', async () => {
    const { SimClock, MAX_DT } = await import('../src/engine/bots/simClock');
    const clock = new SimClock();
    const life = new OfficeLife({ spots: L.spots, seats: L.seats, random: seeded(5), now: clock.now, isNight: () => false });
    for (const id of BOTS) life.register({ id });
    expect(life.tick()).toHaveLength(BOTS.length); // first desk stint for everyone (5–40 s)
    for (let i = 0; i < 20; i++) { clock.step(250); life.tick(); } // 5 s of normal frames
    const before = clock.now();
    clock.step(10 * 60_000); // the tab was hidden for 10 minutes
    expect(clock.now() - before).toBe(MAX_DT);
    expect(life.tick().length).toBeLessThan(BOTS.length / 2);
  });

  it('ignores negative steps', async () => {
    const { SimClock } = await import('../src/engine/bots/simClock');
    const c = new SimClock(); c.step(-50); expect(c.now()).toBe(0);
  });
});
