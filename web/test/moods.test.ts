import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CHARACTERS, type Project, type RoleId, type ServerEvent, type Ticket } from '@office/shared';
import { buildLayout } from '../src/engine/layout/building';
import { parsePieces } from '../src/engine/pieces';
import type { Spot } from '../src/engine/layout/types';
import { OfficeLife, OUT_CAP, DAY_WEIGHTS, type ActivityId, type Intent } from '../src/engine/bots/officeLife';
import { PERSONALITIES, personalityOf, personalWeights, type Personality } from '../src/engine/bots/personality';
import { Moods, MOOD_MS, TIRED_MS, botLabel, type Mood } from '../src/engine/bots/mood';
import { Director, DONE_MS, HAPPY_EMOTES_MS, type DirectorBot } from '../src/engine/bots/director';

const META = parsePieces(readFileSync(resolve(__dirname, '../../assets/office/Isometric_Pixel_Props/pieces.csv'), 'utf8'));
const TEAM: RoleId[] = ['pm', 'techlead', 'frontend', 'backend', 'qa'];
const proj = (id: string, slot: number, team = TEAM): Project =>
  ({ id, name: id, folder: '.', accent: 'cyan', team, slot, looks: {} as Project['looks'], createdAt: '' });
const L = buildLayout([proj('a', 0), proj('b', 1)], META);
const BOTS = ['a', 'b'].flatMap(p => TEAM.map(r => `${p}:${r}`));
const SEEDS = [7, 1, 2, 3, 11];

function seeded(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function world(seed: number, personality: (id: string) => Personality | undefined, night = false) {
  let t = 0;
  const life = new OfficeLife({ spots: L.spots, seats: L.seats, random: seeded(seed), now: () => t, isNight: () => night });
  for (const id of BOTS) life.register({ id, personality: personality(id) });
  const current = new Map<string, Intent>();
  const step = (ms: number) => { t += ms; const out = life.tick(); for (const i of out) current.set(i.botId, i); return out; };
  return { life, current, step };
}

/** Every intent over `ticks` steps of 5 s (each bot's arrival counted at once). */
function run(seed: number, personality: (id: string) => Personality | undefined, ticks = 600, night = false) {
  const w = world(seed, personality, night);
  const all: Intent[] = [];
  for (let k = 0; k < ticks; k++) {
    const out = w.step(5000);
    for (const i of out) w.life.arrived(i.botId);
    all.push(...out);
  }
  return { ...w, all };
}

const share = (intents: Intent[], act: ActivityId) => intents.filter(i => !i.filler && i.activity === act).length / Math.max(1, intents.filter(i => !i.filler).length);

describe('personalities', () => {
  it('every character has one; ids are unique; the label reads like the spec', () => {
    for (const c of CHARACTERS) expect(personalityOf(c)).toBeDefined();
    expect(new Set(Object.values(PERSONALITIES).map(p => p.id)).size).toBe(CHARACTERS.length);
    expect(personalityOf('Nobody')).toBeUndefined();
    expect(botLabel('Clara', 'qa', personalityOf('Clara'), 'neutral')).toBe('Clara · QA Engineer · coffee lover · 😊');
    expect(botLabel('Leo', 'pm', personalityOf('Leo'), 'happy')).toBe('Leo · Project Manager · social · 😄');
  });

  it('personalWeights multiplies the base weights for the time of day (missing = ×1)', () => {
    const w = personalWeights(DAY_WEIGHTS, PERSONALITIES.Clara, false);
    expect(w.coffee).toBeCloseTo(DAY_WEIGHTS.coffee * 2.5);
    expect(w.desk).toBe(DAY_WEIGHTS.desk);
    const owl = PERSONALITIES.Otto;
    expect(personalWeights(DAY_WEIGHTS, owl, true).desk).toBeCloseTo(DAY_WEIGHTS.desk * owl.night!.desk!);
    expect(personalWeights(DAY_WEIGHTS, owl, false).desk).toBeCloseTo(DAY_WEIGHTS.desk * owl.day!.desk!);
    expect(personalWeights(DAY_WEIGHTS, undefined, false)).toEqual(DAY_WEIGHTS);
  });

  it('a coffee lover goes for coffee clearly more often than a plain bot', () => {
    const lover = (id: string) => (id.endsWith(':qa') ? PERSONALITIES.Clara : undefined);
    let mine = 0, plain = 0;
    for (const seed of SEEDS) {
      const { all } = run(seed, lover);
      mine += share(all.filter(i => i.botId.endsWith(':qa')), 'coffee');
      plain += share(all.filter(i => i.botId.endsWith(':backend')), 'coffee');
    }
    expect(mine / SEEDS.length).toBeGreaterThan(1.6 * (plain / SEEDS.length));
  });

  it('at night a night owl works its desk more than a plain bot, an early bird less (night weights)', () => {
    const who = (id: string) => (id.startsWith('a:') ? PERSONALITIES.Otto : id.endsWith(':qa') || id.endsWith(':backend') ? PERSONALITIES.Nina : undefined);
    let owl = 0, bird = 0, plain = 0;
    for (const seed of SEEDS) {
      const { all } = run(seed, who, 600, true);
      owl += share(all.filter(i => i.botId.startsWith('a:')), 'desk');
      bird += share(all.filter(i => i.botId === 'b:qa' || i.botId === 'b:backend'), 'desk');
      plain += share(all.filter(i => i.botId === 'b:pm' || i.botId === 'b:techlead' || i.botId === 'b:frontend'), 'desk');
    }
    expect(owl).toBeGreaterThan(1.3 * plain);
    expect(bird).toBeLessThan(0.8 * plain);
  });

  it('a gamer picks arcade spots for lounge / wander far more than a plain bot', () => {
    const gamer = (id: string) => (id.startsWith('a:') ? PERSONALITIES.Hugo : undefined);
    const arcade = (is: Intent[]) => {
      const out = is.filter(i => i.activity === 'lounge' || i.activity === 'wander').flatMap(i => i.spots).filter(s => s.room === 'lounge');
      return out.filter(s => s.tags.includes('arcade')).length / Math.max(1, out.length);
    };
    let g = 0, p = 0;
    for (const seed of SEEDS) {
      const { all } = run(seed, gamer);
      g += arcade(all.filter(i => i.botId.startsWith('a:')));
      p += arcade(all.filter(i => i.botId.startsWith('b:')));
    }
    expect(g).toBeGreaterThan(1.5 * p);
  });

  it('caps, spot exclusivity and the cooldown still hold with personalities', () => {
    const everyone = (id: string) => Object.values(PERSONALITIES)[BOTS.indexOf(id)];
    for (const seed of SEEDS.slice(0, 3)) {
      const w = world(seed, everyone);
      const recent = new Map<string, ActivityId[]>();
      for (let k = 0; k < 400; k++) {
        const out = w.step(5000);
        for (const i of out) {
          w.life.arrived(i.botId);
          const h = recent.get(i.botId) ?? [];
          if (!i.filler && h.length >= 2) expect(h.slice(-2)).not.toContain(i.activity);
          recent.set(i.botId, [...h, i.activity].slice(-2));
        }
        const held = new Map<string, string>();
        let outside = 0;
        for (const [id, i] of w.current) {
          for (const s of i.spots) { expect(held.get(s.id) ?? id).toBe(id); held.set(s.id, id); }
          if (i.spots.some(s => s.room !== id.split(':')[0])) outside++;
        }
        expect(outside).toBeLessThanOrEqual(Math.floor(OUT_CAP * BOTS.length));
      }
    }
  });
});

describe('urge (tired bot)', () => {
  it('after resume + urge, the next activity is coffee or lounge', () => {
    let hits = 0;
    const seeds = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    for (const seed of seeds) {
      const w = world(seed, () => undefined);
      for (let k = 0; k < 40; k++) for (const i of w.step(5000)) w.life.arrived(i.botId);
      w.life.release('a:frontend');
      w.step(5000);
      w.life.resume('a:frontend');
      w.life.urge('a:frontend', ['coffee', 'lounge']);
      let next: Intent | undefined;
      for (let k = 0; k < 10 && !next; k++) next = w.step(250).find(i => i.botId === 'a:frontend');
      if (next && (next.activity === 'coffee' || next.activity === 'lounge')) hits++;
    }
    expect(hits).toBeGreaterThanOrEqual(8);
  });
});

describe('Moods', () => {
  let t: number, m: Moods;
  beforeEach(() => { t = 0; m = new Moods(() => t); });
  it('a mood decays back to neutral after MOOD_MS', () => {
    expect(m.mood('x')).toBe('neutral');
    m.set('x', 'happy');
    t += MOOD_MS - 1;
    expect(m.mood('x')).toBe('happy');
    t += 1;
    expect(m.mood('x')).toBe('neutral');
  });
  it('work accumulates across working spells; endStint reports > TIRED_MS and starts over', () => {
    m.working('x', true); t += 6 * 60000; m.working('x', false);
    t += 20 * 60000; // waiting at a gate does not count
    m.working('x', true); t += 3 * 60000;
    expect(m.worked('x')).toBe(9 * 60000);
    expect(m.endStint('x')).toBe(false);
    m.working('x', true); t += TIRED_MS + 1;
    expect(m.endStint('x')).toBe(true);
    expect(m.worked('x')).toBe(0);
  });
});

// ------------------------------------------------------------------------------------------------
// Director: mood transitions

const D = buildLayout([proj('p', 0)], META);
const T: Ticket = { id: 't', projectId: 'p', title: 'Add login', text: 'Add login', status: 'queued', stage: null, agentStates: {}, createdAt: '' };

class FakeBot implements DirectorBot {
  seated = false; mx = D.hallEnd.mx; my = D.hallEnd.my;
  bubbles: (string | null)[] = [];
  emotes: string[] = [];
  moods: Mood[] = [];
  constructor(readonly id: string, readonly projectId: string, readonly role: RoleId) {}
  goTo(_t: Spot | { mx: number; my: number }, then?: () => void) { this.seated = false; then?.(); }
  sit(s: Spot) { this.seated = true; this.mx = s.mx; this.my = s.my; }
  stand() { this.seated = false; }
  play() {}
  face() {}
  bubble(k: string | null) { this.bubbles.push(k); }
  emote(k: string) { this.emotes.push(k); }
  setMood(m: Mood) { this.moods.push(m); }
  get bubble0() { return this.bubbles[this.bubbles.length - 1] ?? null; }
}

describe('Director moods', () => {
  let bots: Map<string, FakeBot>, urges: string[], timers: { at: number; fn: () => void }[], clock: number, seq: number, director: Director;
  const tick = (ms: number) => {
    const end = clock + ms;
    for (;;) {
      const due = timers.filter(x => x.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      timers.splice(timers.indexOf(due), 1); clock = due.at; due.fn();
    }
    clock = end;
  };
  const ev = (e: Record<string, unknown>): ServerEvent => ({ projectId: 'p', ticketId: 't', ts: '', seq: ++seq, ...e } as ServerEvent);
  const state = (role: RoleId, s: string) => director.apply(ev({ type: 'agent.state', role, state: s }));
  const stage = (st: string, roles: RoleId[]) => director.apply(ev({ type: 'ticket.stage', stage: st, roles }));
  const bot = (r: RoleId) => bots.get(`p:${r}`)!;

  beforeEach(() => {
    seq = 0; clock = 0; timers = []; urges = [];
    bots = new Map(TEAM.map(r => [`p:${r}`, new FakeBot(`p:${r}`, 'p', r)]));
    const scene = { layout: D, setWorking() {}, setWhiteboard() {}, setTrophies() {} };
    director = new Director(scene, { release() {}, resume() {}, urge: (id, acts) => urges.push(`${id} ${acts.join(',')}`) }, bots, null,
      { after: (ms, fn) => { timers.push({ at: clock + ms, fn }); }, doneCount: () => 1, now: () => clock });
    director.apply({ type: 'snapshot', snapshot: { projects: [proj('p', 0)], tickets: [] }, ts: '' });
    director.apply(ev({ type: 'ticket.created', ticket: T }));
  });

  it('done → happy: 😄 a few times over the next minutes after the hand-back, then back to neutral', () => {
    stage('build', ['frontend']);
    state('frontend', 'coding');
    tick(60000);
    director.apply(ev({ type: 'ticket.done' }));
    expect(director.moodOf('p:frontend')).toBe('happy');
    tick(DONE_MS);
    expect(bot('frontend').moods.at(-1)).toBe('happy');
    expect(bot('frontend').emotes).toEqual([]);
    tick(HAPPY_EMOTES_MS[0]);
    expect(bot('frontend').emotes).toEqual(['😄']);
    tick(HAPPY_EMOTES_MS[2]);
    expect(bot('frontend').emotes).toEqual(['😄', '😄', '😄']);
    tick(MOOD_MS);
    expect(director.moodOf('p:frontend')).toBe('neutral');
    expect(bot('frontend').moods.at(-1)).toBe('neutral');
    expect(urges).toEqual([]);
  });

  it('a bounce from review makes the builders grumpy: 😤 once, when their fix is in (never over the work bubble)', () => {
    stage('build', ['frontend']);
    state('frontend', 'coding');
    state('frontend', 'idle');
    stage('review', ['techlead']);
    state('techlead', 'reviewing');
    stage('build', ['frontend']); // sent back
    expect(director.moodOf('p:frontend')).toBe('grumpy');
    expect(director.moodOf('p:backend')).toBe('neutral');
    expect(bot('frontend').moods.at(-1)).toBe('grumpy');
    state('frontend', 'coding');
    expect(bot('frontend').bubble0).toBe('…');
    expect(bot('frontend').emotes).toEqual([]);
    state('frontend', 'idle');
    expect(bot('frontend').emotes).toEqual(['😤']);
    state('frontend', 'coding');
    state('frontend', 'idle');
    expect(bot('frontend').emotes).toEqual(['😤']);
  });

  it('a bounce from test (QA) counts too', () => {
    stage('build', ['backend']);
    stage('test', ['qa']);
    stage('build', ['backend']);
    expect(director.moodOf('p:backend')).toBe('grumpy');
  });

  it('more than 10 min of work → tired: 😮‍💨 at the hand-back and its next idle activity is coffee or lounge', () => {
    stage('build', ['frontend', 'backend']);
    state('frontend', 'coding'); state('backend', 'coding');
    tick(4 * 60000);
    state('backend', 'idle'); // backend: 4 min only
    tick(7 * 60000);
    director.apply(ev({ type: 'ticket.failed', reason: 'boom' }));
    expect(director.moodOf('p:frontend')).toBe('tired');
    expect(director.moodOf('p:backend')).toBe('neutral');
    tick(5000);
    expect(urges).toEqual(['p:frontend coffee,lounge']);
    expect(bot('frontend').emotes).toEqual(['😮‍💨']);
    expect(bot('backend').emotes).toEqual([]);
  });

  it('a long done ticket: tired urge, then the happy emotes', () => {
    stage('build', ['frontend']);
    state('frontend', 'coding');
    tick(TIRED_MS + 60000);
    director.apply(ev({ type: 'ticket.done' }));
    tick(DONE_MS + 10000);
    expect(urges).toEqual(['p:frontend coffee,lounge']);
    expect(bot('frontend').emotes).toEqual(['😮‍💨', '😄']);
    expect(director.moodOf('p:frontend')).toBe('happy');
  });

  it('no emotes for a bot summoned again before the hand-back', () => {
    stage('build', ['frontend']);
    state('frontend', 'coding');
    director.apply(ev({ type: 'ticket.done' }));
    director.apply({ ...ev({ type: 'ticket.created', ticket: { ...T, id: 't2' } }), ticketId: 't2' } as ServerEvent);
    director.apply({ ...ev({ type: 'agent.state', role: 'frontend', state: 'coding' }), ticketId: 't2' } as ServerEvent);
    tick(HAPPY_EMOTES_MS[2] + DONE_MS + 1000);
    expect(bot('frontend').emotes).toEqual([]);
  });
});
