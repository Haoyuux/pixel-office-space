import { iso, PZ } from '../iso';
import type { RoomRect, Segment } from '../layout/types';

/** Height of the wall / glass modules (Wall_2m size_z). */
export const WALL_H = 2.8;
export const ZOOM_MIN = 0.2, ZOOM_MAX = 2;

export interface Box { x0: number; y0: number; x1: number; y1: number }

/** Iso floor polygon (flat [x, y, ...]) of a metre rect, optionally lifted. */
export function rectPoly(x0: number, y0: number, x1: number, y1: number, lift = 0): number[] {
  const dz = lift * PZ;
  return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].flatMap(([x, y]) => { const p = iso(x, y); return [p.x, p.y - dz]; });
}

/** Screen-space quad of a wall segment extruded from the floor to `h` metres. */
export function wallPoly(s: Segment, h = WALL_H): number[] {
  const a = iso(s.x0, s.y0), b = iso(s.x1, s.y1), dz = h * PZ;
  return [a.x, a.y, b.x, b.y, b.x, b.y - dz, a.x, a.y - dz];
}

/** Screen bounding box (world px) of a metre box including walls rising `h` metres along its back edges. */
export function screenBox(b: Box, h = WALL_H): Box {
  const pts = [iso(b.x0, b.y0), iso(b.x1, b.y0), iso(b.x1, b.y1), iso(b.x0, b.y1)];
  const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
  return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys) - h * PZ, y1: Math.max(...ys) };
}

/** Metre box covering every room (floor-less gaps of empty slots included). */
export function buildingBox(rooms: RoomRect[]): Box {
  return {
    x0: Math.min(...rooms.map(r => r.x0)), y0: Math.min(...rooms.map(r => r.y0)),
    x1: Math.max(...rooms.map(r => r.x1)), y1: Math.max(...rooms.map(r => r.y1)),
  };
}

export const clampZoom = (s: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, s));

/** World transform that centres screen box `sb` in a vw × vh view with `margin` px on every side. */
export function fitTransform(sb: Box, vw: number, vh: number, margin = 40): { scale: number; x: number; y: number } {
  const w = Math.max(1, sb.x1 - sb.x0), h = Math.max(1, sb.y1 - sb.y0);
  const scale = clampZoom(Math.min((vw - 2 * margin) / w, (vh - 2 * margin) / h));
  return { scale, x: vw / 2 - ((sb.x0 + sb.x1) / 2) * scale, y: vh / 2 - ((sb.y0 + sb.y1) / 2) * scale };
}

/** New world transform after zooming by `factor` while keeping the world point under (cx, cy) fixed. */
export function zoomAround(t: { scale: number; x: number; y: number }, cx: number, cy: number, factor: number) {
  const scale = clampZoom(t.scale * factor), k = scale / t.scale;
  return { scale, x: cx - (cx - t.x) * k, y: cy - (cy - t.y) * k };
}

/** Night between 19:00 and 06:00 local time. */
export const isNightAt = (d: Date) => d.getHours() >= 19 || d.getHours() < 6;

/** The room under a floor point; project rooms win over the hallway / breakroom. */
export function roomAtPoint(rooms: RoomRect[], mx: number, my: number): string | null {
  const hit = rooms.filter(r => mx >= r.x0 && mx < r.x1 && my >= r.y0 && my < r.y1);
  return (hit.find(r => r.kind === 'project') ?? hit[0])?.id ?? null;
}
