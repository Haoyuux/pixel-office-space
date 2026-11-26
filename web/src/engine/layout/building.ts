import type { Project } from '@office/shared';
import type { PieceMeta } from '../pieces';
import type { BuildingLayout, Placed, RoomRect, Segment, Spot } from './types';
import { buildRoom, DOOR, ROOM_D, ROOM_W } from './roomTemplate';
import { buildBreakroom, BREAK } from './breakroom';

export const HALL = { x0: 14, x1: 16 };
const BACK_LEFT = ['Wall_Window_2m', 'Wall_2m', 'Blinds_Window_2m', 'Wall_2m', 'Wall_Window_2m', 'Wall_2m', 'Wall_Window_2m'];
const BACK_BREAK = ['Wall_Window_2m', 'Wall_2m', 'Wall_Window_2m', 'Wall_2m', 'Wall_Window_2m'];
const SIDE_LEFT = ['Wall_2m', 'Wall_Window_2m', 'Wall_2m', 'Wall_2m'];

export function slotPlace(slot: number): { side: 'left' | 'right'; row: number } {
  return slot % 2 === 0 ? { side: 'left', row: slot / 2 } : { side: 'right', row: (slot + 1) / 2 };
}

/** Builds the whole office from the project list. `_meta` is accepted so callers pass the parsed pieces.csv once. */
export function buildLayout(projects: Project[], _meta?: Record<string, PieceMeta>): BuildingLayout {
  const rooms: RoomRect[] = [], pieces: Placed[] = [], spots: Spot[] = [], walls: Segment[] = [];
  const L: BuildingLayout = { rooms, pieces, spots, walls, lights: [], seats: {}, nameplates: [], bounds: { x0: -1, y0: -4, x1: BREAK.x1, y1: 8 }, hallEnd: { mx: 15, my: 7.5 } };
  const sorted = [...projects].sort((a, b) => a.slot - b.slot);
  const maxRow = sorted.reduce((m, p) => Math.max(m, slotPlace(p.slot).row), 0);
  const hallY1 = (maxRow + 1) * ROOM_D;
  let hasLeftRow0 = false;

  const glassAlongY = (x: number, y0: number, y1: number, skip?: [number, number]) => {
    for (let y = y0; y < y1; y += 2) {
      if (skip && y >= skip[0] && y < skip[1]) continue;
      pieces.push({ piece: 'Glass_Partition_2m', mx: x, my: y + 1, view: 2, tag: 'glass' });
    }
    if (skip) { walls.push({ x0: x, y0, x1: x, y1: skip[0], kind: 'glass' }, { x0: x, y0: skip[1], x1: x, y1, kind: 'glass' }); }
    else walls.push({ x0: x, y0, x1: x, y1, kind: 'glass' });
  };

  for (const p of sorted) {
    const { side, row } = slotPlace(p.slot);
    const x0 = side === 'left' ? 0 : HALL.x1, y0 = row * ROOM_D;
    const doorX = side === 'left' ? HALL.x0 : HALL.x1;
    rooms.push({ id: p.id, kind: 'project', side, x0, y0, x1: x0 + ROOM_W, y1: y0 + ROOM_D, door: { x: doorX, y0: y0 + DOOR.y0, y1: y0 + DOOR.y1 } });
    const r = buildRoom(p, x0, y0);
    pieces.push(...r.pieces); spots.push(...r.spots); L.lights.push(...r.lights); Object.assign(L.seats, r.seats);
    L.nameplates.push({ projectId: p.id, mx: doorX, my: y0 + (DOOR.y0 + DOOR.y1) / 2, lift: 2.45 });
    glassAlongY(doorX, y0, y0 + ROOM_D, [y0 + DOOR.y0, y0 + DOOR.y1]);
    if (row > 0) {
      for (let x = x0; x < x0 + ROOM_W; x += 2) pieces.push({ piece: 'Glass_Partition_2m', mx: x + 1, my: y0, view: 0, tag: 'glass' });
      walls.push({ x0, y0, x1: x0 + ROOM_W, y1: y0, kind: 'glass' });
    }
    if (side === 'left') {
      SIDE_LEFT.forEach((w, i) => pieces.push({ piece: w, mx: -0.08, my: y0 + i * 2 + 1, view: 2, zi: -5e4, tag: 'wall' }));
      walls.push({ x0: 0, y0, x1: 0, y1: y0 + ROOM_D, kind: 'solid' });
      if (row === 0) hasLeftRow0 = true;
    } else L.bounds.x1 = Math.max(L.bounds.x1, x0 + ROOM_W);
  }

  // back wall along y = 0
  if (hasLeftRow0) BACK_LEFT.forEach((w, i) => pieces.push({ piece: w, mx: i * 2 + 1, my: -0.08, view: 0, zi: -5e4, tag: 'wall' }));
  pieces.push({ piece: 'Wall_2m', mx: HALL.x0 + 1, my: -0.08, view: 0, zi: -5e4, tag: 'wall' });
  BACK_BREAK.forEach((w, i) => pieces.push({ piece: w, mx: BREAK.x0 + i * 2 + 1, my: -0.08, view: 0, zi: -5e4, tag: 'wall' }));
  walls.push({ x0: hasLeftRow0 ? 0 : HALL.x0, y0: 0, x1: BREAK.x1, y1: 0, kind: 'solid' });

  // breakroom + hallway
  const br = buildBreakroom();
  pieces.push(...br.pieces); spots.push(...br.spots); L.lights.push(...br.lights);
  rooms.push({ id: 'breakroom', kind: 'breakroom', ...BREAK });
  rooms.push({ id: 'hall', kind: 'hall', x0: HALL.x0, x1: HALL.x1, y0: 0, y1: hallY1 });
  for (let y = 1; y < hallY1; y += 2.5) spots.push({ id: `hall-${y}`, mx: 15, my: y, pose: 'stand', facing: 'SW', capacity: 1, tags: ['wander', 'hall'], room: 'hall' });
  for (let y = 0.8; y < hallY1; y += 1.6) L.lights.push({ mx: 15, my: y, lift: 0, r: 220, color: 0xffc080, a: 0.2, pool: true, halo: false });

  L.hallEnd = { mx: 15, my: hallY1 - 0.4 };
  L.bounds.y1 = hallY1;
  return L;
}
