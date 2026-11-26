import { ROLES, type Project, type RoleId } from '@office/shared';
import type { Light, Placed, Seat, Spot } from './types';

export const ROOM_W = 14, ROOM_D = 8;
export const DESK_COLS = [2.6, 5.8, 9.0, 12.2];
export const DESK_ROWS = [2.0, 5.2];
export const PM_DESK = { lx: 2.6, ly: 7.3 };
/** Door span on the hallway side, local y (2 m so glass modules tile around it). */
export const DOOR = { y0: 2, y1: 4 };
const DESK_H = 0.834;

const DESK_ITEMS: Record<RoleId, [string, number][]> = {
  pm: [['Planner', 0], ['Sticky_Notes', 0]],
  techlead: [['Headphones', 0], ['Mug', 0]],
  frontend: [['Headset_Stand', 3], ['VoIP_Phone', 5], ['Mug', 0]],
  backend: [['Headset_Stand', 3], ['VoIP_Phone', 5], ['Mini_PC', 0]],
  qa: [['Document_Tray', 0], ['Sticky_Notes', 0]],
  uiux: [['Tablet_Stand', 4], ['Photo_Frame', 0]],
  devops: [['Wifi_Router', 0], ['Mug', 0]],
  security: [['Notebook', 0], ['Phone', 0]],
  writer: [['Notebook', 0], ['Pen_Cup', 0]],
};
const ITEM_OFFSETS: [number, number][] = [[-0.6, -0.1], [0.55, -0.1], [0.4, 0.22]];

export function deskLocal(role: RoleId): { lx: number; ly: number } {
  const r = ROLES.find(x => x.id === role)!;
  if (r.deskRow === 'pm') return PM_DESK;
  return { lx: DESK_COLS[r.deskCol], ly: DESK_ROWS[r.deskRow] };
}

export interface RoomOut { pieces: Placed[]; spots: Spot[]; seats: Record<string, Seat>; lights: Light[] }

/** All furniture of one project room. (x0, y0) = the room's x-min / y-min corner in world metres. */
export function buildRoom(p: Project, x0: number, y0: number): RoomOut {
  const W = (lx: number) => x0 + lx, H = (ly: number) => y0 + ly;
  const pieces: Placed[] = [], spots: Spot[] = [], lights: Light[] = [];
  const seats: Record<string, Seat> = {};
  const put = (piece: string, lx: number, ly: number, view: number, o: Partial<Placed> = {}) =>
    pieces.push({ piece, mx: W(lx), my: H(ly), view, room: p.id, ...o });

  for (let x = 0; x < ROOM_W; x += 2) for (let y = 0; y < ROOM_D; y += 2) put('Floor_Carpet_2x2', x + 1, y + 1, 0, { zi: -1e5, tag: 'floor' });

  for (const role of ROLES.map(r => r.id)) {
    const { lx, ly } = deskLocal(role);
    const on = p.team.includes(role);
    put('Desk_Straight', lx, ly, 4);
    put('Ergo_Chair', lx - 0.02, ly - 0.85, 0, { z: -2 });
    if (on) {
      const dual = role === 'frontend' || role === 'backend';
      put(dual ? 'Dual_Monitor_Arm' : 'Monitor', lx, ly + (dual ? 0.15 : 0.1), 4, { lift: DESK_H, z: 2, anim: !dual, tag: `monitor:${p.id}:${role}` });
      put('Keyboard_Mouse', lx, ly - 0.15, 4, { lift: DESK_H, z: 10 });
      DESK_ITEMS[role].forEach(([item, view], i) => put(item, lx + ITEM_OFFSETS[i][0], ly + ITEM_OFFSETS[i][1], view, { lift: DESK_H, z: 6 }));
      lights.push({ mx: W(lx), my: H(ly - 0.35), lift: 0, r: 180, color: 0x5fb8ff, a: 0.22, pool: true, halo: false, when: 'working', tag: `monitor:${p.id}:${role}` });
    }
    const seat: Spot = { id: `seat:${p.id}:${role}`, mx: W(lx), my: H(ly - 0.75), pose: 'sit', facing: 'SW', capacity: 1, tags: ['seat', role], room: p.id };
    const review: Spot = { id: `review:${p.id}:${role}`, mx: W(lx + 0.95), my: H(ly - 0.55), pose: 'stand', facing: 'W', capacity: 1, tags: ['review', role], room: p.id };
    seats[`${p.id}:${role}`] = { seat, desk: { mx: W(lx), my: H(ly) }, review };
    spots.push(seat, review);
  }

  // Edge furniture: x-min edge faces +x (view 6), y-min edge faces +y (view 0).
  put('Open_Shelf', 0.35, 1.0, 6, { tag: `shelf:${p.id}` });
  put('Cubby_Shelf', 0.35, 6.3, 6);
  put('Whiteboard_Mobile', 4.2, 0.45, 0, { tag: `whiteboard:${p.id}` });
  put('Recycle_Bins', 0.8, 7.3, 0);
  put('Monstera', 13.25, 0.75, 0);
  put('Fiddle_Leaf', 13.35, 7.2, 0);
  if (p.team.includes('devops')) put('Server_Rack', 7.4, 0.6, 0);
  else put('Snake_Plant', 7.4, 0.35, 0);

  spots.push(
    { id: `whiteboard:${p.id}`, mx: W(4.2), my: H(1.15), pose: 'stand', facing: 'N', capacity: 1, tags: ['whiteboard'], room: p.id },
    { id: `shelf:${p.id}`, mx: W(1.1), my: H(1.0), pose: 'stand', facing: 'NW', capacity: 1, tags: ['wander', 'shelf'], room: p.id },
  );

  for (const [lx, ly] of [[4.2, 3.6], [9.0, 3.6], [7.0, 6.8]]) lights.push({ mx: W(lx), my: H(ly), lift: 0, r: 440, color: 0xffb070, a: 0.2, pool: true, halo: false });
  return { pieces, spots, seats, lights };
}
