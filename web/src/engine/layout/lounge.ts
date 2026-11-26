import type { Light, Placed, Spot } from './types';

/** Lounge: row 0, left of the hallway (addendum: "many couches", a cozy living room). World metres. */
export const LOUNGE = { x0: 0, y0: 0, x1: 14, y1: 8 };

/** Sofas sit behind the bots on every seat (side seats are up to 0.62 m off the anchor): draw them well back. */
const SOFA_Z = -40;
const COFFEE_H = 0.518;

export function buildLounge(): { pieces: Placed[]; spots: Spot[]; lights: Light[] } {
  const pieces: Placed[] = [], spots: Spot[] = [], lights: Light[] = [];
  const put = (piece: string, mx: number, my: number, view: number, o: Partial<Placed> = {}) =>
    pieces.push({ piece, mx, my, view, room: 'lounge', ...o });
  const spot = (id: string, mx: number, my: number, pose: Spot['pose'], facing: Spot['facing'], tags: string[], pair?: string) =>
    spots.push({ id, mx, my, pose, facing, capacity: 1, tags, room: 'lounge', ...(pair ? { pair } : {}) });
  const light = (mx: number, my: number, lift: number, r: number, color: number, a: number, pool = true, halo = true) =>
    lights.push({ mx, my, lift, r, color, a, pool, halo });

  for (let x = 0; x < 14; x += 2) for (let y = 0; y < 8; y += 2) put('Floor_Vinyl_2x2', x + 1, y + 1, 0, { zi: -1e5, tag: 'floor' });

  /**
   * A camera-facing sofa: view 0 (seats face +y, bots SW) or view 6 (seats face +x, bots SE).
   * Its three seats are lounge sit spots; `pairs` lists seat index pairs that are chat pairs.
   */
  const sofa = (id: string, mx: number, my: number, view: 0 | 6, pairs: [number, number][] = []) => {
    put('Sofa_Modular', mx, my, view, { z: SOFA_Z });
    const along = view === 0;
    const ids = [0, 1, 2].map(i => `${id}-${i + 1}`);
    const partner = (i: number) => { for (const [a, b] of pairs) { if (a === i) return ids[b]; if (b === i) return ids[a]; } };
    [-0.62, 0, 0.62].forEach((d, i) => {
      const p = partner(i);
      spot(ids[i], along ? mx + d : mx + 0.1, along ? my + 0.1 : my + d, 'sit', along ? 'SW' : 'SE', p ? ['lounge', 'chat'] : ['lounge'], p);
    });
    return ids;
  };
  const armchair = (id: string, mx: number, my: number, view: 0 | 6, pair?: string) => {
    put('Lounge_Chair', mx, my, view, { z: -2 });
    spot(id, view === 0 ? mx : mx + 0.05, view === 0 ? my + 0.05 : my, 'sit', view === 0 ? 'SW' : 'SE', pair ? ['lounge', 'chat'] : ['lounge'], pair);
  };
  /** A coffee table with its dressing; lamps on it get a small night halo. */
  const table = (mx: number, my: number, items: [string, number, number][]) => {
    put('Coffee_Table', mx, my, 0);
    for (const [piece, dx, dy] of items) {
      const lamp = piece === 'Lava_Lamp' || piece === 'Fairy_Jar';
      put(piece, mx + dx, my + dy, 0, { lift: COFFEE_H, z: 3, ...(lamp ? { tag: 'lamp' } : {}), ...(piece === 'Lava_Lamp' ? { anim: true } : {}) });
      if (piece === 'Lava_Lamp') light(mx + dx, my + dy, 0.75, 180, 0xff7fd0, 0.28);
      if (piece === 'Fairy_Jar') light(mx + dx, my + dy, 0.62, 120, 0xffd27a, 0.35, false, true);
    }
    light(mx, my - 0.5, 0, 520, 0xffb870, 0.3, true, false);
  };
  /** Two seats that chat with each other. */
  const link = (a: string, b: string) => {
    for (const [x, y] of [[a, b], [b, a]]) { const q = spots.find(s => s.id === x)!; q.pair = y; if (!q.tags.includes('chat')) q.tags.push('chat'); }
  };

  // --- cluster 1: corner L in the back-left corner (a sofa on each wall), lantern in the corner
  put('Paper_Lantern_Floor', 0.5, 0.5, 0, { tag: 'lamp' });
  light(0.5, 0.5, 1.0, 300, 0xffd9a0, 0.32);
  const a = sofa('sofa-a', 2.7, 0.6, 0, [[1, 2]]);
  const b = sofa('sofa-b', 0.6, 2.4, 6, [[1, 2]]);
  link(a[0], b[0]);
  table(2.7, 1.75, [['Lava_Lamp', 0.12, -0.12], ['Mug', -0.15, 0.05], ['Plate_Fruit', 0.08, 0.14]]);
  table(1.75, 2.4, [['Fairy_Jar', -0.1, -0.12], ['Notebook', 0.06, 0.08], ['Mug', 0.14, -0.14]]);
  put('String_Lights', 2.7, 0.12, 0, { lift: 1.2, zi: -4e4, tag: 'lamp' });
  light(2.7, 0.2, 1.7, 300, 0xffd27a, 0.25, false, true);

  // --- cluster 2: sofa on the back wall, an armchair on its left turned toward the table
  put('Wall_Clock', 5.0, 0.08, 0, { lift: 1.95, anim: true });
  put('Snake_Plant', 4.6, 0.35, 0);
  const c = sofa('sofa-c', 7.4, 0.6, 0, [[1, 2]]);
  armchair('armchair-c', 5.85, 1.9, 6);
  link('armchair-c', c[0]);
  table(7.4, 1.75, [['Fairy_Jar', 0.12, -0.12], ['Plate_Fruit', -0.12, 0.0], ['Mug', 0.12, 0.14], ['Succulents', -0.1, -0.18]]);
  put('String_Lights', 7.4, 0.12, 0, { lift: 1.2, zi: -4e4, tag: 'lamp' });
  light(7.4, 0.2, 1.7, 300, 0xffd27a, 0.25, false, true);

  // --- aquarium on a pedestal and plants, back-right
  put('Pedestal_Drawer', 10.2, 0.4, 0);
  put('Aquarium', 10.2, 0.4, 0, { lift: 0.6, z: 3, anim: true, tag: 'lamp' });
  light(10.2, 0.4, 0.75, 220, 0x4fa8ff, 0.32);
  spot('aquarium', 10.2, 1.2, 'stand', 'NE', ['wander']);
  put('Fiddle_Leaf', 9.3, 0.5, 0);
  put('Monstera', 13.2, 0.75, 0);

  // --- cluster 3: free-standing L on the right (sofa facing the camera + sofa facing +x)
  const d = sofa('sofa-d', 11.7, 2.9, 0, [[1, 2]]);
  const e = sofa('sofa-e', 9.7, 4.5, 6, [[1, 2]]);
  link(d[0], e[0]);
  table(11.7, 4.05, [['Lava_Lamp', -0.12, -0.1], ['Mug', 0.12, 0.02], ['Plate_Fruit', -0.05, 0.16]]);
  table(10.85, 4.75, [['Fairy_Jar', 0.1, -0.12], ['Notebook', -0.06, 0.06]]);

  // --- two armchairs around a side table, mid-room
  armchair('duo-1', 6.3, 3.5, 0);
  armchair('duo-2', 7.4, 3.5, 0);
  link('duo-1', 'duo-2');
  table(6.85, 4.6, [['Lava_Lamp', 0.1, -0.1], ['Mug', -0.12, 0.04]]);

  // --- reading nook on the x = 0 wall: cubby, armchair under the arc lamp, open shelf
  put('Cubby_Shelf', 0.3, 4.15, 6);
  put('Globe', 0.3, 3.9, 6, { lift: 1.12, z: 3 });
  put('Succulents', 0.3, 4.45, 6, { lift: 1.12, z: 3 });
  put('Arc_Floor_Lamp', 0.95, 5.35, 0, { tag: 'lamp' });
  armchair('armchair-read', 1.35, 5.3, 6);
  light(1.6, 5.3, 1.8, 460, 0xffc070, 0.36);
  put('Open_Shelf', 0.3, 6.4, 6);
  put('Trophy', 0.3, 6.4, 6, { lift: 1.8, z: 3 });
  spot('shelf', 1.0, 6.4, 'stand', 'NW', ['wander']);
  put('Cactus', 3.0, 7.5, 4);

  // --- front-right corner
  put('Paper_Lantern_Floor', 13.3, 7.3, 0, { tag: 'lamp' });
  light(13.3, 7.3, 1.0, 280, 0xffd9a0, 0.3);
  return { pieces, spots, lights };
}
