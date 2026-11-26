import { describe, it, expect } from 'vitest';
import { buildLayout } from '../src/engine/layout/building';
import type { Project } from '@office/shared';
import { buildingBox, fitTransform, isNightAt, rectPoly, roomAtPoint, screenBox, zoomAround, ZOOM_MAX, ZOOM_MIN } from '../src/engine/render/geom';
import { iso, PZ } from '../src/engine/iso';

const proj = (id: string, slot: number): Project =>
  ({ id, name: id, folder: '.', accent: 'cyan', team: ['pm'], slot, looks: {} as Project['looks'], createdAt: '' });

describe('render geometry', () => {
  it('night is 19:00–06:00 local time', () => {
    const at = (h: number) => isNightAt(new Date(2026, 10, 26, h, 30));
    expect([at(5), at(6), at(12), at(18), at(19), at(23), at(0)]).toEqual([true, false, false, false, true, true, true]);
  });

  it('rectPoly projects the four floor corners (and lifts them)', () => {
    const a = iso(2, 3);
    expect(rectPoly(2, 3, 4, 5).slice(0, 2)).toEqual([a.x, a.y]);
    expect(rectPoly(2, 3, 4, 5, 1)[1]).toBeCloseTo(a.y - PZ);
  });

  it('roomAtPoint prefers project rooms and returns null outside', () => {
    const L = buildLayout([proj('a', 0), proj('b', 1)]);
    expect(roomAtPoint(L.rooms, 3, 3)).toBe('a');
    expect(roomAtPoint(L.rooms, 15, 3)).toBe('hall');
    expect(roomAtPoint(L.rooms, 20, 3)).toBe('breakroom');
    expect(roomAtPoint(L.rooms, 20, 10)).toBe('b');
    expect(roomAtPoint(L.rooms, -1, 3)).toBeNull();
  });

  it('fit frames the whole 7-project building inside the view, centred', () => {
    const L = buildLayout([0, 1, 2, 3, 4, 5, 6].map(i => proj(`p${i}`, i)));
    const b = buildingBox(L.rooms);
    expect(b).toEqual({ x0: 0, y0: 0, x1: 30, y1: 32 });
    const sb = screenBox(b), t = fitTransform(sb, 1600, 900, 48);
    expect(t.scale).toBeGreaterThanOrEqual(ZOOM_MIN);
    const left = sb.x0 * t.scale + t.x, right = sb.x1 * t.scale + t.x, top = sb.y0 * t.scale + t.y, bottom = sb.y1 * t.scale + t.y;
    expect(left).toBeGreaterThanOrEqual(47); expect(right).toBeLessThanOrEqual(1553);
    expect(top).toBeGreaterThanOrEqual(47); expect(bottom).toBeLessThanOrEqual(853);
    expect((left + right) / 2).toBeCloseTo(800); expect((top + bottom) / 2).toBeCloseTo(450);
  });

  it('wheel zoom keeps the world point under the cursor fixed and clamps to 0.2–2', () => {
    const t0 = { scale: 0.5, x: 100, y: 50 };
    const t1 = zoomAround(t0, 400, 300, 1.15);
    const world = { x: (400 - t0.x) / t0.scale, y: (300 - t0.y) / t0.scale };
    expect(world.x * t1.scale + t1.x).toBeCloseTo(400);
    expect(world.y * t1.scale + t1.y).toBeCloseTo(300);
    expect(zoomAround({ scale: 1.9, x: 0, y: 0 }, 0, 0, 2).scale).toBe(ZOOM_MAX);
    expect(zoomAround({ scale: 0.21, x: 0, y: 0 }, 0, 0, 0.5).scale).toBe(ZOOM_MIN);
  });
});
