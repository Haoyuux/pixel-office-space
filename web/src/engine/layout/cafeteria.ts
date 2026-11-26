import type { Light, Placed, Spot } from './types';

/** Cafeteria: row 0, right of the hallway (addendum: "many tables and chairs", a lively food court). World metres. */
export const CAFE = { x0: 16, y0: 0, x1: 30, y1: 8 };

const TABLE_H = 0.844, HIGH_H = 1.12;
/** Dining tables: two rows of two (Meeting_Table, 3 chairs per long side). */
export const CAFE_TABLES: [number, number][] = [[19.6, 3.05], [23.8, 3.05], [19.6, 5.65], [23.8, 5.65]];
/** Smoothie bar: high tables along the open right side. */
const BAR_TABLES: [number, number][] = [[28.6, 1.6], [28.6, 3.5], [28.6, 5.4]];

type Item = [piece: string, dx: number, dy: number, o?: Partial<Placed>];
const jar: Partial<Placed> = { tag: 'lamp' };
/** What is on each dining table: far-side plates in front of the seated bots, condiments in the middle. */
const MENUS: Item[][] = [
  [['Plate_Burger', -0.8, -0.2], ['Cola_Can', -0.5, -0.3], ['Plate_Fish_Fries', 0, -0.2], ['Plate_Fruit', 0.8, -0.2], ['Juice_Glass', 1.05, -0.3],
    ['Fairy_Jar', -0.25, 0.08, jar], ['Napkin_Holder', 0.25, 0.06], ['Fries_Basket', 0.55, 0.28], ['Plate_Empty', -0.75, 0.28]],
  [['Plate_Shrimp', -0.8, -0.2], ['Coconut_Straw', -0.5, -0.32], ['Plate_Burger', 0, -0.2], ['Milkshake', 0.28, -0.3], ['Ice_Cream_Sundae', 0.8, -0.22],
    ['Fairy_Jar', 0.25, 0.08, jar], ['Salt_Pepper', -0.25, 0.06], ['Sauce_Bottles', -0.05, 0.08], ['Plate_Fruit', 0.75, 0.28]],
  [['Plate_Fruit', -0.8, -0.2], ['Plate_Fish_Fries', 0, -0.2], ['Cola_Can', 0.28, -0.3], ['Plate_Burger', 0.8, -0.2],
    ['Fairy_Jar', -0.25, 0.08, jar], ['Table_Menu', 0.25, 0.06], ['Drinks_Tray', -0.7, 0.26], ['Fries_Basket', 0.7, 0.28]],
  [['Ice_Cream_Sundae', -0.8, -0.22], ['Milkshake', -0.55, -0.3], ['Plate_Shrimp', 0, -0.2], ['Plate_Burger', 0.8, -0.2], ['Juice_Glass', 1.05, -0.3],
    ['Fairy_Jar', 0.25, 0.08, jar], ['Napkin_Holder', -0.25, 0.06], ['Salt_Pepper', 0.0, 0.08], ['Plate_Empty', 0.75, 0.28]],
];

export function buildCafeteria(): { pieces: Placed[]; spots: Spot[]; lights: Light[] } {
  const pieces: Placed[] = [], spots: Spot[] = [], lights: Light[] = [];
  const put = (piece: string, mx: number, my: number, view: number, o: Partial<Placed> = {}) =>
    pieces.push({ piece, mx, my, view, room: 'cafeteria', ...o });
  const spot = (id: string, mx: number, my: number, pose: Spot['pose'], facing: Spot['facing'], tags: string[], pair?: string) =>
    spots.push({ id, mx, my, pose, facing, capacity: 1, tags, room: 'cafeteria', ...(pair ? { pair } : {}) });
  const light = (mx: number, my: number, lift: number, r: number, color: number, a: number, pool = true, halo = true) =>
    lights.push({ mx, my, lift, r, color, a, pool, halo });

  for (let x = 0; x < 14; x += 2) for (let y = 0; y < 8; y += 2) put('Floor_Vinyl_2x2', CAFE.x0 + x + 1, y + 1, 0, { zi: -1e5, tag: 'floor' });

  // --- kitchen run on the back wall (left to right: vending, cooler, sink + coffee, fridges + microwave, cork board)
  put('Vending_Machine', 17.0, 0.5, 0, { anim: true });
  put('Vending_Machine', 18.0, 0.5, 0, { anim: true });
  put('Water_Cooler', 18.95, 0.35, 0, { anim: true });
  put('Kitchen_Sink', 20.0, 0.42, 0);
  put('Espresso_Machine', 19.75, 0.38, 0, { lift: 0.9, z: 2 });
  put('Capsule_Coffee', 20.3, 0.38, 0, { lift: 0.9, z: 2 });
  put('Mini_Fridge', 20.85, 0.4, 0);
  put('Microwave', 20.85, 0.4, 0, { lift: 0.84, z: 2 });
  put('Mini_Fridge', 21.4, 0.4, 0);
  put('Wall_Clock', 22.2, 0.08, 0, { lift: 1.95, anim: true });
  put('Cork_Board', 23.2, 0.55, 0, { tag: 'corkboard' });
  put('Fiddle_Leaf', 24.4, 0.6, 0);
  put('Monstera', 26.3, 0.8, 0);

  spot('vending-1', 17.0, 1.35, 'stand', 'NE', ['coffee']);
  spot('vending-2', 18.0, 1.35, 'stand', 'NE', ['coffee']);
  spot('cooler', 18.95, 1.0, 'drink', 'NE', ['coffee']);
  spot('espresso', 19.75, 1.15, 'drink', 'NE', ['coffee']);
  spot('capsule', 20.35, 1.15, 'drink', 'NE', ['coffee']);
  spot('cooler-chat-a', 18.5, 1.55, 'drink', 'E', ['chat'], 'cooler-chat-b');
  spot('cooler-chat-b', 19.45, 1.55, 'drink', 'W', ['chat'], 'cooler-chat-a');
  spot('corkboard', 23.2, 1.3, 'stand', 'NE', ['wander', 'corkboard']);
  spot('window', 25.4, 1.1, 'stand', 'NE', ['wander']);

  // --- dining tables: far-side chairs face the camera (seats), near-side chairs have their backs to it
  CAFE_TABLES.forEach(([tx, ty], k) => {
    put('Meeting_Table', tx, ty, 0);
    for (const [i, dx] of [-0.8, 0, 0.8].entries()) {
      put('Meeting_Chair', tx + dx, ty - 0.95, 0, { z: -2 });
      put('Meeting_Chair', tx + dx, ty + 0.85, 4);
      spot(`table-${k + 1}-${i + 1}`, tx + dx, ty - 0.85, 'sit', 'SW', ['table']);
    }
    for (const [piece, dx, dy, o] of MENUS[k]) put(piece, tx + dx, ty + dy, 0, { lift: TABLE_H, z: 4, ...o });
    light(tx, ty, 0, 540, 0xffc070, 0.36, true, false);
    const fj = MENUS[k].find(m => m[0] === 'Fairy_Jar')!;
    light(tx + fj[1], ty + fj[2], 0.95, 120, 0xffd27a, 0.35, false, true);
  });

  // --- smoothie bar along the open right side
  const BAR_ITEMS: Item[][] = [
    [['Blender_Smoothie', -0.2, -0.05], ['Milkshake', 0.25, 0.02]],
    [['Coconut_Straw', -0.2, -0.02], ['Juice_Glass', 0.22, 0.02]],
    [['Milkshake', -0.18, -0.02], ['Blender_Smoothie', 0.22, -0.04]],
  ];
  BAR_TABLES.forEach(([x, y], k) => {
    put('High_Table_Stools', x, y, 0);
    for (const [piece, dx, dy] of BAR_ITEMS[k]) put(piece, x + dx, y + dy, 0, { lift: HIGH_H, z: 3 });
    spot(`bar-${k + 1}a`, x - 0.55, y + 0.75, 'drink', 'NE', ['bar']);
    spot(`bar-${k + 1}b`, x + 0.6, y + 0.75, 'drink', 'NW', ['bar']);
    light(x, y, 1.4, 400, 0xffc070, 0.34);
  });
  put('Snake_Plant', 29.6, 0.4, 0);
  put('Fiddle_Leaf', 29.55, 7.45, 4);
  put('Monstera', 16.75, 7.3, 4);

  // night: kitchen pool, cool pools at the vending machines
  light(20.4, 0.95, 0, 340, 0xffe0b0, 0.28, true, false);
  light(17.0, 1.0, 0, 280, 0x9fe8ff, 0.3, true, false);
  light(18.0, 1.0, 0, 280, 0x9fe8ff, 0.3, true, false);
  return { pieces, spots, lights };
}
