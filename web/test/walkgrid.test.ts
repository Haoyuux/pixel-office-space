import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Project, RoleId } from '@office/shared';
import { buildLayout } from '../src/engine/layout/building';
import { parsePieces, footprint } from '../src/engine/pieces';
import { WalkGrid } from '../src/engine/walkgrid';
import { NEON_META } from '../src/engine/neon';

// like loadPieceMeta(): the neon props (arcades, poufs, ...) are obstacles too
const META = { ...parsePieces(readFileSync(resolve(__dirname, '../../assets/office/Isometric_Pixel_Props/pieces.csv'), 'utf8')), ...NEON_META };
const proj = (id: string, slot: number, team: RoleId[] = ['pm', 'techlead', 'frontend', 'backend', 'qa']): Project =>
  ({ id, name: id, folder: '.', accent: 'cyan', team, slot, looks: {} as Project['looks'], createdAt: '' });

const L4 = buildLayout([proj('a', 0), proj('b', 1), proj('c', 2), proj('d', 3)], META);
const G4 = new WalkGrid(L4, META);
const esp = L4.spots.find(s => s.id === 'espresso')!;
const seatA = L4.seats['a:frontend'].seat;

describe('WalkGrid', () => {
  it('path seat -> espresso exists and goes through the slot-0 door', () => {
    const p = G4.path(seatA, esp)!;
    expect(p).not.toBeNull();
    // smoothing drops collinear points, so find where the polyline crosses x = 14
    const full = [{ mx: seatA.mx, my: seatA.my }, ...p];
    const ys: number[] = [];
    for (let i = 1; i < full.length; i++) {
      const a = full[i - 1], b = full[i];
      if ((a.mx - 14) * (b.mx - 14) <= 0 && a.mx !== b.mx) ys.push(a.my + (b.my - a.my) * (14 - a.mx) / (b.mx - a.mx));
    }
    expect(ys.length).toBeGreaterThan(0);
    expect(ys.every(y => y >= 10 && y <= 12)).toBe(true);
  });

  it('cannot cross glass: slot 0 -> slot 2 goes via the hallway', () => {
    const c = L4.seats['c:frontend'].seat;
    const p = G4.path(seatA, c)!;
    expect(p).not.toBeNull();
    expect(p.some(q => q.mx > 14 && q.mx < 16)).toBe(true);
  });

  it('no path cell is inside a desk footprint', () => {
    const p = G4.path(seatA, esp)!;
    const solids = L4.pieces.filter(q => !q.lift && !['floor', 'wall', 'glass'].includes(q.tag ?? '') && META[q.piece]);
    for (const c of p.slice(1, -1)) for (const s of solids) {
      const f = footprint(META[s.piece], s.view);
      expect(Math.abs(c.mx - s.mx) < f.w / 2 && Math.abs(c.my - s.my) < f.d / 2, s.piece).toBe(false);
    }
  });

  it('smoothed segments stay on walkable ground (no corner cutting)', () => {
    const p = G4.path(seatA, esp)!;
    for (let i = 1; i < p.length; i++) {
      const a = p[i - 1], b = p[i];
      const steps = Math.round(Math.max(Math.abs(b.mx - a.mx), Math.abs(b.my - a.my)) / 0.5);
      for (let k = 1; k < steps; k++) {
        expect(G4.walkable(a.mx + (b.mx - a.mx) * k / steps, a.my + (b.my - a.my) * k / steps)).toBe(true);
      }
    }
  });

  it('unwalkable outside the building; null for an off-grid target', () => {
    expect(G4.walkable(-5, -5)).toBe(false);
    expect(G4.path(seatA, { mx: -5, my: -5 })).toBeNull();
  });

  it('farthest seat of 8 projects reaches the cafeteria in < 20 ms', () => {
    const L = buildLayout(Array.from({ length: 8 }, (_, i) => proj('p' + i, i)), META);
    const G = new WalkGrid(L, META);
    const e = L.spots.find(s => s.id === 'espresso')!;
    const seat = L.seats['p7:backend'].seat;
    G.path(seat, e);
    const t0 = performance.now();
    const p = G.path(seat, e);
    const dt = performance.now() - t0;
    expect(p).not.toBeNull();
    expect(dt).toBeLessThan(20);
  });

  it.each([0, 1, 3, 7])('every seat and every shared spot of a %i-project layout reaches the cafeteria coffee', n => {
    const L = buildLayout(Array.from({ length: n }, (_, i) => proj('p' + i, i)), META);
    const G = new WalkGrid(L, META);
    const e = L.spots.find(s => s.id === 'espresso')!;
    expect(e.room).toBe('cafeteria');
    for (const [k, v] of Object.entries(L.seats)) expect(G.path(v.seat, e), k).not.toBeNull();
    for (const s of L.spots.filter(q => q.room === 'lounge' || q.room === 'cafeteria' || q.room === 'hall')) expect(G.path(s, e), s.id).not.toBeNull();
  });

  it('A* cost equals Dijkstra optimum on random pairs', () => {
    const L = buildLayout(Array.from({ length: 6 }, (_, i) => proj('p' + i, i)), META);
    const G = new WalkGrid(L, META);
    const gg = G as unknown as { cols: number; rows: number; ox: number; oy: number; cell: number; open: Uint8Array;
      canStep(q: number, r: number, dq: number, dr: number): boolean };
    const W = gg.cols, n = W * gg.rows;
    const open: number[] = [];
    for (let i = 0; i < n; i++) if (gg.open[i]) open.push(i);
    const pt = (i: number) => ({ mx: gg.ox + ((i % W) + 0.5) * gg.cell, my: gg.oy + (Math.floor(i / W) + 0.5) * gg.cell });
    const dijkstra = (s: number) => {
      const d = new Float64Array(n).fill(Infinity); d[s] = 0;
      const done = new Uint8Array(n);
      for (;;) {
        let u = -1;
        for (let i = 0; i < n; i++) if (!done[i] && d[i] < Infinity && (u < 0 || d[i] < d[u])) u = i;
        if (u < 0) break;
        done[u] = 1;
        const q = u % W, r = Math.floor(u / W);
        for (const [dq, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
          if (!gg.canStep(q, r, dq, dr)) continue;
          const j = (r + dr) * W + q + dq, c = d[u] + (dq && dr ? Math.SQRT2 : 1);
          if (c < d[j]) d[j] = c;
        }
      }
      return d;
    };
    let seed = 12345;
    const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
    const len = (p: { mx: number; my: number }[]) => p.slice(1).reduce((a, b, i) => a + Math.hypot(b.mx - p[i].mx, b.my - p[i].my), 0) / gg.cell;
    for (let k = 0; k < 40; k++) {
      const s = open[Math.floor(rnd() * open.length)];
      const d = dijkstra(s);
      for (let m = 0; m < 25; m++) {
        const t = open[Math.floor(rnd() * open.length)];
        const p = G.path(pt(s), pt(t));
        if (d[t] === Infinity) { expect(p).toBeNull(); continue; }
        expect(p).not.toBeNull();
        expect(Math.abs(len([pt(s), ...p!.slice(s === t ? 1 : 0)]) - d[t])).toBeLessThan(1e-9);
      }
    }
  });
});
