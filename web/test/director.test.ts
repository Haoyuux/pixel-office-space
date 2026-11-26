import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Project, RoleId, ServerEvent, Ticket } from '@office/shared';
import { buildLayout } from '../src/engine/layout/building';
import { parsePieces } from '../src/engine/pieces';
import type { Spot } from '../src/engine/layout/types';
import { Director, type DirectorBot } from '../src/engine/bots/director';
import { OfficeLife } from '../src/engine/bots/officeLife';

const META = parsePieces(readFileSync(resolve(__dirname, '../../assets/office/Isometric_Pixel_Props/pieces.csv'), 'utf8'));
const TEAM: RoleId[] = ['pm', 'techlead', 'frontend', 'backend', 'qa'];
const proj = (team = TEAM): Project => ({ id: 'p', name: 'Shop', folder: '.', accent: 'cyan', team, slot: 0, looks: {} as Project['looks'], createdAt: '' });
const L = buildLayout([proj()], META);
const T: Ticket = { id: 't', projectId: 'p', title: 'Add login', text: 'Add login', status: 'queued', stage: null, agentStates: {}, createdAt: '' };

class FakeBot implements DirectorBot {
  calls: string[] = [];
  seated = false; mx: number; my: number;
  pending: (() => void) | undefined;
  target: { mx: number; my: number } | null = null;
  bubbleKind: string | null = null;
  constructor(readonly id: string, readonly projectId: string, readonly role: RoleId) {
    // idling somewhere in the hallway
    this.mx = L.hallEnd.mx; this.my = L.hallEnd.my;
  }
  goTo(t: Spot | { mx: number; my: number }, then?: () => void) {
    this.calls.push(`goTo ${'id' in t ? t.id : `${t.mx},${t.my}`}`);
    this.seated = false; this.target = { mx: t.mx, my: t.my }; this.pending = then;
  }
  /** finish the current walk */
  arrive() { const cb = this.pending; this.pending = undefined; if (this.target) { this.mx = this.target.mx; this.my = this.target.my; } cb?.(); }
  sit(s: Spot) { this.calls.push(`sit ${s.id}`); this.seated = true; this.mx = s.mx; this.my = s.my; this.pending = undefined; }
  stand() { this.calls.push('stand'); this.seated = false; }
  play(c: string) { this.calls.push(`play ${c}`); }
  face(d: string) { this.calls.push(`face ${d}`); }
  bubble(k: string | null) { this.calls.push(`bubble ${k}`); this.bubbleKind = k; }
}

let bots: Map<string, FakeBot>, life: string[], scene: { layout: typeof L; calls: string[]; setWorking: (p: string, r: RoleId, on: boolean) => void; setWhiteboard: (p: string, t: string | null) => void; setTrophies: (p: string, n: number) => void };
let timers: { at: number; fn: () => void }[], clock: number, director: Director, seq: number, done: number;
const tick = (ms: number) => {
  clock += ms;
  for (;;) {
    const due = timers.filter(t => t.at <= clock).sort((a, b) => a.at - b.at)[0];
    if (!due) break;
    timers.splice(timers.indexOf(due), 1); due.fn();
  }
};
const ev = (e: Record<string, unknown>): ServerEvent => ({ projectId: 'p', ticketId: 't', ts: '', seq: ++seq, ...e } as ServerEvent);
const state = (role: RoleId, s: string) => director.apply(ev({ type: 'agent.state', role, state: s }));
const bot = (r: RoleId) => bots.get(`p:${r}`)!;

beforeEach(() => {
  seq = 0; clock = 0; timers = []; life = []; done = 0;
  bots = new Map(TEAM.map(r => [`p:${r}`, new FakeBot(`p:${r}`, 'p', r)]));
  scene = {
    layout: L, calls: [],
    setWorking(p, r, on) { this.calls.push(`working ${p}:${r} ${on}`); },
    setWhiteboard(p, t) { this.calls.push(`whiteboard ${p} ${t}`); },
    setTrophies(p, n) { this.calls.push(`trophies ${p} ${n}`); },
  };
  director = new Director(scene, { release: id => life.push(`release ${id}`), resume: id => life.push(`resume ${id}`) }, bots, null,
    { after: (ms, fn) => { timers.push({ at: clock + ms, fn }); }, doneCount: () => done });
  director.apply({ type: 'snapshot', snapshot: { projects: [proj()], tickets: [] }, ts: '' });
});

describe('Director', () => {
  it('summoned frontend is released and walks to its seat, then sits', () => {
    state('frontend', 'summoned');
    expect(life).toContain('release p:frontend');
    expect(bot('frontend').calls).toContain(`goTo ${L.seats['p:frontend'].seat.id}`);
    bot('frontend').arrive();
    expect(bot('frontend').calls).toContain(`sit ${L.seats['p:frontend'].seat.id}`);
  });

  it('PM goes to the whiteboard first, then its seat, and shows ! at the plan gate', () => {
    director.apply(ev({ type: 'ticket.created', ticket: T }));
    director.apply(ev({ type: 'ticket.stage', stage: 'plan', roles: ['pm'] }));
    expect(scene.calls).toContain('whiteboard p Add login');
    state('pm', 'summoned'); state('pm', 'planning');
    const pm = bot('pm');
    expect(pm.calls.filter(c => c.startsWith('goTo'))).toEqual(['goTo whiteboard:p']);
    expect(pm.bubbleKind).toBe('…');
    expect(scene.calls).toContain('working p:pm true');
    pm.arrive();
    tick(5000);
    expect(pm.calls).toContain(`goTo ${L.seats['p:pm'].seat.id}`);
    pm.arrive();
    expect(pm.seated).toBe(true);
    state('pm', 'waiting');
    director.apply(ev({ type: 'gate.open', gate: 'plan', payload: null }));
    expect(pm.bubbleKind).toBe('!');
    expect(bot('frontend').bubbleKind).toBe(null);
    director.apply(ev({ type: 'gate.closed', gate: 'plan', decision: 'approved' }));
    expect(pm.bubbleKind).toBe(null);
  });

  it('tech lead stands at each coder review spot in turn, then returns to its seat', () => {
    for (const r of ['techlead', 'frontend', 'backend'] as RoleId[]) { state(r, 'summoned'); bot(r).arrive(); }
    director.apply(ev({ type: 'ticket.stage', stage: 'build', roles: ['frontend', 'backend'] }));
    director.apply(ev({ type: 'ticket.stage', stage: 'review', roles: ['techlead'] }));
    state('techlead', 'reviewing');
    const tl = bot('techlead');
    expect(tl.calls.filter(c => c.startsWith('goTo')).at(-1)).toBe('goTo review:p:frontend');
    tl.arrive(); tick(10000);
    expect(tl.calls.filter(c => c.startsWith('goTo')).at(-1)).toBe('goTo review:p:backend');
    tl.arrive(); tick(10000);
    expect(tl.calls.filter(c => c.startsWith('goTo')).at(-1)).toBe(`goTo ${L.seats['p:techlead'].seat.id}`);
    tl.arrive();
    expect(tl.seated).toBe(true);
  });

  it('final gate puts ! on every summoned bot; ticket.done waves, ✓ and resumes all summoned bots', () => {
    const team: RoleId[] = ['pm', 'frontend', 'backend'];
    director.apply(ev({ type: 'ticket.created', ticket: T }));
    director.apply(ev({ type: 'ticket.stage', stage: 'build', roles: ['frontend', 'backend'] }));
    for (const r of team) { state(r, 'summoned'); bot(r).arrive(); state(r, 'waiting'); }
    director.apply(ev({ type: 'gate.open', gate: 'final', payload: null }));
    for (const r of team) expect(bot(r).bubbleKind).toBe('!');
    expect(bot('qa').bubbleKind).toBe(null);
    director.apply(ev({ type: 'gate.closed', gate: 'final', decision: 'approved' }));
    for (const r of team) state(r, 'done');
    for (const r of team) { expect(bot(r).calls).toContain('play waving'); expect(bot(r).bubbleKind).toBe('✓'); }
    done = 7;
    director.apply(ev({ type: 'ticket.done' }));
    expect(scene.calls).toContain('trophies p 5');
    expect(scene.calls).toContain('whiteboard p null');
    tick(10000);
    for (const r of team) expect(life).toContain(`resume p:${r}`);
    expect(life).not.toContain('resume p:qa');
  });

  it('cancelled shows ✗ briefly, then resumes', () => {
    state('frontend', 'summoned'); bot('frontend').arrive(); state('frontend', 'coding');
    director.apply(ev({ type: 'ticket.cancelled' }));
    expect(bot('frontend').bubbleKind).toBe('✗');
    expect(scene.calls).toContain('working p:frontend false');
    tick(10000);
    expect(life).toContain('resume p:frontend');
  });

  it('an added role walks in from the room door to its seat and waves', () => {
    director.apply({ type: 'project.updated', project: proj([...TEAM, 'writer']), projectId: 'p', ts: '' });
    const w = new FakeBot('p:writer', 'p', 'writer');
    bots.set(w.id, w);
    director.onAdded(w, L.seats['p:writer'].seat);
    expect(life).toContain('release p:writer');
    const door = L.rooms.find(r => r.id === 'p')!.door!;
    expect(Math.abs(w.my - (door.y0 + door.y1) / 2)).toBeLessThan(0.01);
    expect(Math.abs(w.mx - door.x)).toBeLessThan(1);
    expect(w.calls.at(-1)).toBe(`goTo ${L.seats['p:writer'].seat.id}`);
    w.arrive();
    expect(w.calls).toContain('play waving');
    tick(10000);
    expect(w.seated).toBe(true);
    expect(life).toContain('resume p:writer');
  });

  it('bots added by the initial build stay where they are', () => {
    const q = bot('qa');
    q.calls = [];
    director.onAdded(q, L.seats['p:qa'].seat);
    expect(q.calls).toEqual([]);
    expect(life).toEqual([]);
  });

  it("a removed role's bot walks to the hallway end and is then removed", async () => {
    director.apply({ type: 'project.updated', project: proj(TEAM.filter(r => r !== 'qa')), projectId: 'p', ts: '' });
    const q = bot('qa');
    let removed = false;
    const p = director.onRemoved(q);
    expect(p).toBeInstanceOf(Promise);
    void Promise.resolve(p).then(() => { removed = true; });
    expect(q.calls.at(-1)).toBe(`goTo ${L.hallEnd.mx},${L.hallEnd.my}`);
    await Promise.resolve();
    expect(removed).toBe(false);
    q.arrive();
    await p;
    expect(removed).toBe(true);
  });

  it('restores a summoned bot that appears after the snapshot (page opened mid-ticket)', () => {
    const d2 = new Director(scene, { release: id => life.push(`release ${id}`), resume: id => life.push(`resume ${id}`) }, new Map(), null, { after: () => {} });
    d2.apply({ type: 'snapshot', snapshot: { projects: [proj()], tickets: [{ ...T, status: 'waiting', stage: 'plan', openGate: 'plan', agentStates: { pm: 'waiting' } }] }, ts: '' });
    expect(life).toContain('release p:pm');
    expect(scene.calls).toContain('whiteboard p Add login');
    const pm = new FakeBot('p:pm', 'p', 'pm');
    d2.onAdded(pm, L.seats['p:pm'].seat);
    expect(pm.bubbleKind).toBe('!');
    expect(pm.seated).toBe(true);
  });

  it('a ticket cancelled while the PM stands at the whiteboard: no walk or sit after life resumes', () => {
    director.apply(ev({ type: 'ticket.created', ticket: T }));
    director.apply(ev({ type: 'ticket.stage', stage: 'plan', roles: ['pm'] }));
    state('pm', 'summoned'); state('pm', 'planning');
    const pm = bot('pm');
    pm.arrive(); // at the whiteboard, BOARD_MS hold starts
    tick(500);
    director.apply(ev({ type: 'ticket.cancelled' }));
    tick(2600); // FAIL_MS: resumed
    expect(life).toContain('resume p:pm');
    const n = pm.calls.length;
    tick(10000); // the board timer would have fired here
    pm.arrive();
    expect(pm.calls.slice(n).filter(c => c.startsWith('goTo') || c.startsWith('sit'))).toEqual([]);
  });

  it('working -> idle mid-ticket turns the monitor off and clears the bubble, keeping the duty', () => {
    state('frontend', 'summoned'); bot('frontend').arrive(); state('frontend', 'coding');
    expect(bot('frontend').bubbleKind).toBe('…');
    scene.calls = [];
    state('frontend', 'idle');
    expect(scene.calls).toContain('working p:frontend false');
    expect(bot('frontend').bubbleKind).toBe(null);
    director.apply(ev({ type: 'ticket.done' }));
    tick(10000);
    expect(life).toContain('resume p:frontend');
  });

  it('a removed member that was working gets its monitor turned off', () => {
    state('qa', 'summoned'); bot('qa').arrive(); state('qa', 'testing');
    director.apply({ type: 'project.updated', project: proj(TEAM.filter(r => r !== 'qa')), projectId: 'p', ts: '' });
    scene.calls = [];
    void director.onRemoved(bot('qa'));
    expect(scene.calls).toContain('working p:qa false');
  });

  it('a snapshot that ends a duty clears the bubble', () => {
    state('backend', 'summoned'); bot('backend').arrive(); state('backend', 'coding');
    director.apply({ type: 'snapshot', snapshot: { projects: [proj()], tickets: [] }, ts: '' });
    expect(life).toContain('resume p:backend');
    expect(bot('backend').bubbleKind).toBe(null);
  });

  it('destroy() stops pending timers from acting', () => {
    state('frontend', 'summoned'); bot('frontend').arrive();
    director.apply(ev({ type: 'ticket.cancelled' }));
    director.destroy();
    tick(10000);
    expect(life).not.toContain('resume p:frontend');
  });

  it("office life's first desk intent cannot take over a walking-in bot", () => {
    let now = 0;
    const real = new OfficeLife({ spots: L.spots, seats: L.seats, random: () => 0.5, now: () => now, isNight: () => false });
    const d = new Director(scene, real, bots, null, { after: (ms, fn) => { timers.push({ at: clock + ms, fn }); } });
    d.apply({ type: 'snapshot', snapshot: { projects: [proj()], tickets: [] }, ts: '' });
    d.apply({ type: 'project.updated', project: proj([...TEAM, 'writer']), projectId: 'p', ts: '' });
    const w = new FakeBot('p:writer', 'p', 'writer');
    bots.set(w.id, w);
    real.register(w); // Population registers, then calls the hook
    d.onAdded(w, L.seats['p:writer'].seat);
    now += 1000;
    expect(real.tick().filter(i => i.botId === w.id)).toEqual([]);
    w.arrive(); tick(10000);
    expect(w.seated).toBe(true);
    now += 1000;
    const next = real.tick().filter(i => i.botId === w.id);
    expect(next).toHaveLength(1); // back in office life after the wave
  });
});
