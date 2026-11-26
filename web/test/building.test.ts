import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Project, RoleId } from '@office/shared';
import { buildLayout } from '../src/engine/layout/building';
import { parsePieces, footprint } from '../src/engine/pieces';

const META = parsePieces(readFileSync(resolve(__dirname, '../../assets/office/Isometric_Pixel_Props/pieces.csv'), 'utf8'));
const proj = (id: string, slot: number, team: RoleId[] = ['pm', 'techlead', 'frontend', 'backend', 'qa']): Project =>
  ({ id, name: id, folder: '.', accent: 'cyan', team, slot, looks: {} as Project['looks'], createdAt: '' });

const COUNTS = [0, 1, 3, 7];
const many = (n: number) => Array.from({ length: n }, (_, i) => proj('p' + i, i));

describe('buildLayout', () => {
  it('has a lounge, a cafeteria and an 8 m hallway with no projects', () => {
    const L = buildLayout([], META);
    expect(L.rooms.map(r => r.kind).sort()).toEqual(['cafeteria', 'hall', 'lounge']);
    const hall = L.rooms.find(r => r.kind === 'hall')!;
    expect([hall.x0, hall.x1, hall.y0, hall.y1]).toEqual([14, 16, 0, 8]);
  });

  it('places projects by slot, alternating sides, and grows the hallway', () => {
    const L = buildLayout([proj('a', 0), proj('b', 1), proj('c', 2)], META);
    const r = (id: string) => { const x = L.rooms.find(q => q.id === id)!; return [x.side, x.x0, x.x1, x.y0, x.y1]; };
    expect(r('a')).toEqual(['left', 0, 14, 8, 16]);
    expect(r('b')).toEqual(['right', 16, 30, 8, 16]);
    expect(r('c')).toEqual(['left', 0, 14, 16, 24]);
    expect(L.rooms.find(q => q.id === 'a')!.door).toEqual({ x: 14, y0: 10, y1: 12 });
    const hall = L.rooms.find(q => q.kind === 'hall')!;
    expect(hall.y1).toBe(24);
  });

  it('leaves a gap for an empty slot but keeps the hallway long', () => {
    const L = buildLayout([proj('a', 0), proj('c', 2)], META);
    expect(L.rooms.filter(q => q.kind === 'project').map(q => q.id)).toEqual(['a', 'c']);
    expect(L.rooms.find(q => q.kind === 'hall')!.y1).toBe(24);
  });

  it('gives every project 9 desk seats with fixed positions', () => {
    const L = buildLayout([proj('a', 0)], META);
    const seats = Object.keys(L.seats).filter(k => k.startsWith('a:'));
    expect(seats.length).toBe(9);
    expect(L.seats['a:frontend'].seat).toMatchObject({ mx: 5.8, my: 8 + 2.0 - 0.75, pose: 'sit', facing: 'SW' });
  });

  it('puts monitors only on desks of team members', () => {
    const L = buildLayout([proj('a', 0, ['pm', 'frontend'])], META);
    const monitors = L.pieces.filter(p => p.tag?.startsWith('monitor:a:')).map(p => p.tag);
    expect(monitors.sort()).toEqual(['monitor:a:frontend', 'monitor:a:pm']);
    expect(L.pieces.find(p => p.tag === 'monitor:a:frontend')!.piece).toBe('Dual_Monitor_Arm');
  });

  it('a right room uses the same local desk positions', () => {
    const L = buildLayout([proj('a', 0), proj('b', 1)], META);
    expect(L.seats['b:frontend'].seat).toMatchObject({ mx: 16 + 5.8, my: 8 + 2.0 - 0.75 });
  });

  it.each(COUNTS)('nothing faces a wall or glass (%i projects)', n => {
    const L = buildLayout(many(n), META);
    const facing: Record<number, [number, number]> = { 0: [0, 1], 2: [-1, 0], 4: [0, -1], 6: [1, 0] };
    for (const p of L.pieces) {
      if (p.lift || p.tag === 'wall' || p.tag === 'glass' || p.tag === 'floor' || !(p.view in facing)) continue;
      for (const s of L.walls) {
        const horizontal = s.y0 === s.y1;
        const near = horizontal
          ? Math.abs(p.my - s.y0) < 0.6 && p.mx > Math.min(s.x0, s.x1) && p.mx < Math.max(s.x0, s.x1)
          : Math.abs(p.mx - s.x0) < 0.6 && p.my > Math.min(s.y0, s.y1) && p.my < Math.max(s.y0, s.y1);
        if (!near) continue;
        const normal = horizontal ? [0, Math.sign(p.my - s.y0) || 1] : [Math.sign(p.mx - s.x0) || 1, 0];
        const [fx, fy] = facing[p.view];
        expect(fx * normal[0] + fy * normal[1], `${p.piece} at ${p.mx},${p.my} faces the wall`).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it.each(COUNTS)('spots never share a cell and standing spots are never inside furniture (%i projects)', n => {
    const L = buildLayout(many(n), META);
    const cells = L.spots.map(s => `${Math.floor(s.mx * 2)},${Math.floor(s.my * 2)}`);
    expect(new Set(cells).size).toBe(cells.length);
    const solids = L.pieces.filter(p => !p.lift && p.tag !== 'floor' && p.tag !== 'wall');
    for (const s of L.spots.filter(q => q.pose !== 'sit')) {
      for (const p of solids) {
        const f = footprint(META[p.piece], p.view);
        const inside = Math.abs(s.mx - p.mx) < f.w / 2 && Math.abs(s.my - p.my) < f.d / 2;
        expect(inside, `${s.id} inside ${p.piece}`).toBe(false);
      }
    }
  });

  it('has the lounge and the cafeteria side by side in row 0, open to the hallway', () => {
    const L = buildLayout(many(3), META);
    const r = (id: string) => { const x = L.rooms.find(q => q.id === id)!; return [x.kind, x.x0, x.x1, x.y0, x.y1]; };
    expect(r('lounge')).toEqual(['lounge', 0, 14, 0, 8]);
    expect(r('cafeteria')).toEqual(['cafeteria', 16, 30, 0, 8]);
    // no glass between row 0 and the hallway
    expect(L.walls.some(w => (w.x0 === 14 || w.x0 === 16) && w.x0 === w.x1 && Math.min(w.y0, w.y1) < 8)).toBe(false);
    // solid back wall over the whole width and a solid x = 0 wall for the lounge
    expect(L.walls).toContainEqual({ x0: 0, y0: 0, x1: 30, y1: 0, kind: 'solid' });
    expect(L.walls).toContainEqual({ x0: 0, y0: 0, x1: 0, y1: 8, kind: 'solid' });
  });

  it('the lounge has many couches and the cafeteria many tables', () => {
    const L = buildLayout([], META);
    const count = (room: string, piece: string) => L.pieces.filter(p => p.room === room && p.piece === piece).length;
    expect(count('lounge', 'Sofa_Modular')).toBeGreaterThanOrEqual(4);
    expect(count('lounge', 'Lounge_Chair')).toBeGreaterThanOrEqual(3);
    expect(count('cafeteria', 'Meeting_Table')).toBeGreaterThanOrEqual(4);
    expect(count('cafeteria', 'Meeting_Chair')).toBeGreaterThanOrEqual(24);
    expect(L.pieces.some(p => p.room === 'lounge' && /TV/.test(p.piece))).toBe(false);
  });

  it('every lounge seat faces the camera (SW / SE), on a camera-facing sofa or armchair', () => {
    const L = buildLayout([], META);
    const sits = L.spots.filter(s => s.room === 'lounge' && s.pose === 'sit');
    expect(sits.length).toBeGreaterThanOrEqual(15);
    for (const s of sits) {
      expect(['SW', 'SE'], s.id).toContain(s.facing);
      expect(s.tags).toContain('lounge');
    }
    for (const p of L.pieces.filter(q => q.piece === 'Sofa_Modular' || q.piece === 'Lounge_Chair')) expect([0, 6]).toContain(p.view);
    // chat pairs are mutual
    for (const s of L.spots.filter(q => q.pair)) expect(L.spots.find(q => q.id === s.pair)!.pair, s.id).toBe(s.id);
  });

  it('cafeteria: table seats face the camera; coffee, bar and cork board spots exist', () => {
    const L = buildLayout([], META);
    const caf = L.spots.filter(s => s.room === 'cafeteria');
    const table = caf.filter(s => s.tags.includes('table'));
    expect(table.length).toBe(12);
    for (const s of table) expect([s.pose, s.facing]).toEqual(['sit', 'SW']);
    expect(caf.filter(s => s.tags.includes('coffee')).map(s => s.id).sort()).toEqual(['capsule', 'cooler', 'espresso', 'vending-1', 'vending-2']);
    expect(caf.filter(s => s.tags.includes('bar')).length).toBeGreaterThanOrEqual(4);
    expect(caf.some(s => s.tags.includes('corkboard'))).toBe(true);
    expect(L.pieces.filter(p => p.tag === 'corkboard').length).toBe(1);
  });
});
