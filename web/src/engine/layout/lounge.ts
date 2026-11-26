import type { Light, Placed, Rug, Spot } from './types';

/** Lounge: row 0, left of the hallway (addendum: "many couches", a cozy living room). World metres. */
export const LOUNGE = { x0: 0, y0: 0, x1: 14, y1: 8 };

/** Sofas sit behind the bots on every seat (side seats are up to 0.62 m off the anchor): draw them well back. */
const SOFA_Z = -40;
const COFFEE_H = 0.518, PEDESTAL_H = 0.6, NEON_SIDE_H = 0.5;
/** Coffee table distance in front of (camera side of) its sofa. */
export const TABLE_GAP = 1.15;

const WARM = 0xffc070, CANDLE = 0xffd27a;

/**
 * The lounge is three conversation groups on their own rugs (terracotta and sage on the back wall, dusty blue at the
 * front right), an arcade corner in the middle of the back wall whose rug and poufs run to the centre of the room, and
 * a reading nook on the x = 0 wall. A corridor (y ≈ 2.2–3.3) runs from the hallway past every group.
 */
export function buildLounge(): { pieces: Placed[]; spots: Spot[]; lights: Light[]; rugs: Rug[] } {
  const pieces: Placed[] = [], spots: Spot[] = [], lights: Light[] = [], rugs: Rug[] = [];
  const put = (piece: string, mx: number, my: number, view: number, o: Partial<Placed> = {}) =>
    pieces.push({ piece, mx, my, view, room: 'lounge', ...o });
  const neon = (prop: string, variant: string, mx: number, my: number, view: 0 | 6 = 0, o: Partial<Placed> = {}) =>
    put(prop, mx, my, view, { pack: 'neon', variant, ...o });
  const spot = (id: string, mx: number, my: number, pose: Spot['pose'], facing: Spot['facing'], tags: string[], pair?: string) =>
    spots.push({ id, mx, my, pose, facing, capacity: 1, tags, room: 'lounge', ...(pair ? { pair } : {}) });
  const light = (mx: number, my: number, lift: number, r: number, color: number, a: number, pool = true, halo = true) =>
    lights.push({ mx, my, lift, r, color, a, pool, halo });
  const rug = (id: string, x0: number, y0: number, x1: number, y1: number, color: number, border: number, accent: number, pattern: Rug['pattern']) =>
    rugs.push({ id, room: 'lounge', x0, y0, x1, y1, color, border, accent, pattern });
  /** Two seats that chat with each other. */
  const link = (a: string, b: string) => {
    for (const [x, y] of [[a, b], [b, a]]) { const q = spots.find(s => s.id === x)!; q.pair = y; if (!q.tags.includes('chat')) q.tags.push('chat'); }
  };
  /** Small things on a table top; lamps get a halo (lava lamps also a coloured pool). */
  const dress = (mx: number, my: number, h: number, items: [string, number, number][]) => {
    for (const [piece, dx, dy] of items) {
      const lamp = piece === 'Lava_Lamp' || piece === 'Fairy_Jar' || piece === 'Candle' || /Lantern|Lamp/.test(piece);
      const anim = piece === 'Lava_Lamp' || piece === 'Candle';
      put(piece, mx + dx, my + dy, 0, { lift: h, z: 3, ...(lamp ? { tag: 'lamp' } : {}), ...(anim ? { anim: true } : {}) });
      if (piece === 'Lava_Lamp') light(mx + dx, my + dy, h + 0.25, 180, 0xff7fd0, 0.28);
      if (piece === 'Fairy_Jar' || piece === 'Candle') light(mx + dx, my + dy, h + 0.12, 120, CANDLE, 0.35, false, true);
      if (piece === 'Kerosene_Lantern' || piece === 'Desk_Lamp') light(mx + dx, my + dy, h + 0.25, 260, WARM, 0.34);
    }
  };

  for (let x = 0; x < 14; x += 2) for (let y = 0; y < 8; y += 2) put('Floor_Vinyl_2x2', x + 1, y + 1, 0, { zi: -1e5, tag: 'floor' });

  interface Group {
    id: string; cx: number; sy: number;
    rug: [number, number, number, Rug['pattern']];
    /** Floor lamp: an arc lamp whose base stands past one sofa end (its shade hangs over the sofa), or a paper lantern. */
    lamp: { kind: 'arc' | 'lantern'; end: 'L' | 'R' };
    /** Side table at the other sofa end, with what stands on it. */
    side: { kind: 'pedestal' | 'neon'; items: [string, number, number][] };
    table: [string, number, number][];
  }
  /**
   * A conversation group: a camera-facing sofa (3 sit spots), a coffee table right in front of it, an armchair on its
   * left turned toward the table (+x, a camera-facing seat) and one on its right turned inward (−x/+y, decorative),
   * a side table at one sofa end, a floor lamp at the other and a rug under the lot.
   */
  const group = (g: Group) => {
    const { id, cx, sy } = g, ty = sy + TABLE_GAP;
    const ids = [0, 1, 2].map(i => `${id}-${i + 1}`);
    put('Sofa_Modular', cx, sy, 0, { z: SOFA_Z });
    [-0.62, 0, 0.62].forEach((d, i) => spot(ids[i], cx + d, sy + 0.1, 'sit', 'SW', ['lounge']));
    link(ids[1], ids[2]);
    put('Coffee_Table', cx, ty, 0);
    dress(cx, ty, COFFEE_H, g.table);
    light(cx, ty - 0.4, 0, 520, 0xffb870, 0.22, true, false);
    // armchairs at the table's sides
    put('Lounge_Chair', cx - 1.45, ty - 0.05, 6, { z: -2 });
    spot(`${id}-arm`, cx - 1.4, ty - 0.05, 'sit', 'SE', ['lounge']);
    link(`${id}-arm`, ids[0]);
    put('Lounge_Chair', cx + 1.45, ty - 0.2, 1, { z: -2 });
    // side table + lamp
    const sideX = g.lamp.end === 'L' ? cx + 1.33 : cx - 1.33;
    if (g.side.kind === 'pedestal') { put('Pedestal_Drawer', sideX, sy - 0.12, 0); dress(sideX, sy - 0.12, PEDESTAL_H, g.side.items); }
    else { neon('side_table', 'white_amber', sideX, sy - 0.05); dress(sideX, sy - 0.05, NEON_SIDE_H, g.side.items); }
    if (g.lamp.kind === 'arc') {
      // view 0: base at −x, shade at +x (view 2 mirrors it); the base stands 0.4 m past the sofa end
      const left = g.lamp.end === 'L', ax = left ? cx - 0.72 : cx + 0.72;
      put('Arc_Floor_Lamp', ax, sy - 0.25, left ? 0 : 2, { tag: 'lamp', z: -45 });
      light(left ? ax + 0.7 : ax - 0.7, sy - 0.1, 1.65, 420, WARM, 0.34);
    } else {
      const lx = g.lamp.end === 'L' ? cx - 1.4 : cx + 1.4;
      put('Paper_Lantern_Floor', lx, sy - 0.1, 0, { tag: 'lamp' });
      light(lx, sy - 0.1, 1.0, 300, 0xffd9a0, 0.34);
    }
    const [color, border, accent, pattern] = g.rug;
    rug(id, cx - 2.0, sy - 0.32, cx + 2.0, ty + 0.85, color, border, accent, pattern);
  };

  // --- group A (terracotta), back-left
  put('Snake_Plant', 0.4, 0.4, 0);
  group({
    id: 'sofa-a', cx: 2.6, sy: 0.62, rug: [0xb8644a, 0x7d3b2b, 0xe8b07a, 'diamonds'],
    lamp: { kind: 'arc', end: 'R' }, side: { kind: 'pedestal', items: [['Kerosene_Lantern', 0, 0.05]] },
    table: [['Lava_Lamp', 0.13, -0.12], ['Mug', -0.15, 0.06], ['Plate_Fruit', 0.08, 0.15], ['Notebook', -0.1, -0.15]],
  });
  put('String_Lights', 2.6, 0.12, 0, { lift: 1.2, zi: -4e4, tag: 'lamp' });
  light(2.6, 0.2, 1.7, 300, CANDLE, 0.25, false, true);

  // --- aquarium on its pedestal under the clock, between group A and the arcades
  put('Pedestal_Drawer', 4.95, 0.42, 0);
  put('Aquarium', 4.95, 0.42, 0, { lift: 0.6, z: 3, anim: true, tag: 'lamp' });
  light(4.95, 0.42, 0.75, 220, 0x4fa8ff, 0.32);
  spot('aquarium', 4.95, 1.3, 'stand', 'NE', ['wander']);
  put('Wall_Clock', 4.95, 0.08, 0, { lift: 1.95, anim: true });

  // --- game corner: three arcade cabinets on the back wall, a neon rug running to the middle of the room, poufs
  rug('arcade', 5.45, 0.2, 8.75, 4.75, 0x2a2440, 0x1a1628, 0x46d9e8, 'checks');
  const cabinets: [number, string, number][] = [[6.1, 'graphite_magenta', 0xff4fd8], [7.2, 'graphite_cyan', 0x46d9e8], [8.3, 'graphite_amber', 0xffb347]];
  cabinets.forEach(([x, variant, color], i) => {
    neon('arcade_cabinet', variant, x, 0.5, 0, { tag: 'lamp' });
    light(x, 1.1, 0, 300, color, 0.32, true, false);
    // players stand in front of the screen, facing the cabinet (−y)
    spot(`arcade-${i + 1}`, x, 1.35, 'stand', 'NE', ['lounge', 'wander']);
  });
  put('Fiddle_Leaf', 9.0, 0.45, 0);
  // poufs: two spectators behind the players, two round a snack table; their seats face the camera
  const poufs: [number, number, string, Spot['facing']][] = [[6.0, 2.55, 'white_magenta', 'SE'], [7.55, 2.45, 'white_cyan', 'SW'], [5.95, 3.95, 'white_amber', 'SE'], [8.2, 3.75, 'white_magenta', 'SW']];
  poufs.forEach(([x, y, variant, facing], i) => { neon('pouf', variant, x, y); spot(`pouf-${i + 1}`, x, y - 0.02, 'sit', facing, ['lounge']); });
  link('pouf-1', 'pouf-2');
  link('pouf-3', 'pouf-4');
  neon('side_table', 'graphite_cyan', 7.05, 3.85);
  dress(7.05, 3.85, NEON_SIDE_H, [['Fries_Basket', -0.06, -0.04], ['Cola_Can', 0.1, 0.08]]);

  // --- group B (sage), back-right
  group({
    id: 'sofa-b', cx: 11.2, sy: 0.62, rug: [0x8fa67f, 0x5d7350, 0xe3dcb8, 'stripes'],
    lamp: { kind: 'lantern', end: 'L' }, side: { kind: 'pedestal', items: [['Desk_Lamp', 0.02, 0.05]] },
    table: [['Fairy_Jar', 0.13, -0.13], ['Candle', -0.14, -0.08], ['Mug', 0.12, 0.13], ['Notebook', -0.08, 0.12]],
  });
  put('String_Lights', 11.2, 0.12, 0, { lift: 1.2, zi: -4e4, tag: 'lamp' });
  light(11.2, 0.2, 1.7, 300, CANDLE, 0.25, false, true);
  put('Monstera', 13.35, 0.65, 0);

  // --- group C (dusty blue), front-right, free-standing on the open floor
  group({
    id: 'sofa-c', cx: 11.2, sy: 4.3, rug: [0x7f93ad, 0x55657c, 0xd8dfe8, 'diamonds'],
    lamp: { kind: 'arc', end: 'R' }, side: { kind: 'neon', items: [['Succulents', 0, 0]] },
    table: [['Fairy_Jar', -0.13, -0.12], ['Lava_Lamp', 0.12, -0.1], ['Plate_Fruit', -0.06, 0.14], ['Mug', 0.15, 0.1]],
  });

  // --- reading nook on the x = 0 wall: cubby + open shelf, an armchair with a footstool under the arc lamp
  rug('nook', 0.45, 3.5, 2.75, 6.25, 0xc9a24a, 0x8a6b2a, 0xf3e2b0, 'stripes');
  put('Cubby_Shelf', 0.25, 3.95, 6);
  put('Globe', 0.25, 3.7, 6, { lift: 1.12, z: 3 });
  put('Succulents', 0.25, 4.25, 6, { lift: 1.12, z: 3 });
  put('Open_Shelf', 0.25, 5.45, 6);
  put('Trophy', 0.25, 5.45, 6, { lift: 1.8, z: 3 });
  spot('shelf', 1.05, 6.0, 'stand', 'NW', ['wander']);
  put('Lounge_Chair', 1.35, 4.65, 6, { z: -2 });
  spot('armchair-read', 1.4, 4.65, 'sit', 'SE', ['lounge']);
  neon('pouf', 'white_amber', 2.25, 4.75);
  neon('side_table', 'white_amber', 1.3, 3.75);
  dress(1.3, 3.75, NEON_SIDE_H, [['Candle', 0, 0]]);
  // view 6: base at +y, shade at −y over the armchair
  put('Arc_Floor_Lamp', 0.95, 4.95, 6, { tag: 'lamp', z: 10 });
  light(1.25, 4.3, 1.7, 460, WARM, 0.36);

  // --- plants along the walls and the front
  put('Snake_Plant', 0.35, 2.85, 6);
  put('Fiddle_Leaf', 0.5, 7.3, 6);
  put('Monstera', 2.9, 7.2, 4);
  // a green line of planters along the front glass
  for (const x of [4.6, 6.3, 8.0, 9.7]) neon('planter_box', 'white_cyan', x, 7.35);
  put('Fiddle_Leaf', 11.1, 7.3, 4);
  put('Snake_Plant', 12.2, 7.5, 4);
  put('Paper_Lantern_Floor', 13.3, 7.3, 0, { tag: 'lamp' });
  light(13.3, 7.3, 1.0, 280, 0xffd9a0, 0.3);
  return { pieces, spots, lights, rugs };
}
