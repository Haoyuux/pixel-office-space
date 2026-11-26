import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Project, RoleId } from '@office/shared';
import { buildLayout } from '../src/engine/layout/building';
import { parsePieces, footprint } from '../src/engine/pieces';
import { WalkGrid } from '../src/engine/walkgrid';

const META = parsePieces(readFileSync(resolve(__dirname, '../../assets/office/Isometric_Pixel_Props/pieces.csv'), 'utf8'));
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
    expect(ys.every(y => y >= 2 && y <= 4)).toBe(true);
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

  it('farthest seat of 8 projects reaches the breakroom in < 20 ms', () => {
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
});
