import type { Light, Placed, Spot } from './types';

/** Breakroom origin in world metres (the approved spike used x0 = 10; everything here is spike + 6). */
export const BREAK = { x0: 16, y0: 0, x1: 26, y1: 8 };
const DX = 6;

export function buildBreakroom(): { pieces: Placed[]; spots: Spot[]; lights: Light[] } {
  const pieces: Placed[] = [];
  const put = (piece: string, sx: number, my: number, view: number, o: Partial<Placed> = {}) =>
    pieces.push({ piece, mx: sx + DX, my, view, room: 'breakroom', ...o });

  for (let x = 0; x < 10; x += 2) for (let y = 0; y < 8; y += 2) pieces.push({ piece: 'Floor_Vinyl_2x2', mx: BREAK.x0 + x + 1, my: y + 1, view: 0, zi: -1e5, tag: 'floor', room: 'breakroom' });

  // kitchen run on the back wall
  put('Kitchen_Sink', 11.0, 0.42, 0);
  put('Espresso_Machine', 10.75, 0.38, 0, { lift: 0.9, z: 2 });
  put('Capsule_Coffee', 11.3, 0.38, 0, { lift: 0.9, z: 2 });
  put('Mini_Fridge', 12.1, 0.4, 0);
  put('Vending_Machine', 13.5, 0.5, 0, { anim: true });
  put('Water_Cooler', 14.8, 0.35, 0, { anim: true });
  put('Cork_Board', 16.0, 0.55, 0, { tag: 'corkboard' });
  put('Wall_Clock', 12.0, 0.08, 0, { lift: 1.95, anim: true });
  put('String_Lights', 19, 0.12, 0, { lift: 1.2, zi: -4e4, tag: 'lamp' });
  // family table
  const TX = 13.0, TY = 3.4;
  put('Meeting_Table', TX, TY, 0);
  for (const dx of [-0.8, 0, 0.8]) {
    put('Meeting_Chair', TX + dx, TY - 0.95, 0, { z: -2 });
    put('Meeting_Chair', TX + dx, TY + 0.85, 4);
  }
  put('Plate_Burger', TX - 0.8, TY - 0.25, 0, { lift: 0.844, z: 4 });
  put('Plate_Fruit', TX + 0.8, TY - 0.25, 0, { lift: 0.844, z: 4 });
  put('Drinks_Tray', TX + 0.05, TY + 0.1, 0, { lift: 0.844, z: 4 });
  put('Fairy_Jar', TX - 0.35, TY + 0.15, 0, { lift: 0.844, z: 4, tag: 'lamp' });
  put('Mug', TX - 0.6, TY + 0.25, 0, { lift: 0.844, z: 4 });
  put('Cola_Can', TX + 0.55, TY + 0.25, 0, { lift: 0.844, z: 4 });
  // cafe bar
  put('High_Table_Stools', 18.6, 1.3, 0);
  put('Beer_Mug', 18.4, 1.25, 0, { lift: 1.12, z: 3 });
  put('Juice_Glass', 18.9, 1.3, 0, { lift: 1.12, z: 3 });
  // lounge
  put('Sofa_Modular', 19.35, 5.9, 2);
  put('Coffee_Table', 18.2, 5.9, 0);
  put('Mug', 18.05, 5.8, 0, { lift: 0.52, z: 3 });
  put('Plate_Fruit', 18.3, 6.0, 0, { lift: 0.52, z: 3 });
  put('Lava_Lamp', 18.45, 5.75, 0, { lift: 0.52, z: 3, anim: true, tag: 'lamp' });
  put('Lounge_Chair', 17.0, 5.9, 6, { z: -2 });
  put('Lounge_Chair', 18.2, 7.1, 4);
  put('Pedestal_Drawer', 19.55, 4.55, 0);
  put('Aquarium', 19.55, 4.55, 0, { lift: 0.6, z: 3, anim: true, tag: 'lamp' });
  put('Arc_Floor_Lamp', 19.6, 7.2, 6, { tag: 'lamp' });
  put('Paper_Lantern_Floor', 16.6, 7.3, 0, { tag: 'lamp' });
  put('Fiddle_Leaf', 17.2, 0.6, 0);
  put('Monstera', 10.7, 7.3, 0);
  put('Snake_Plant', 13.0, 7.3, 0);
  put('Fiddle_Leaf', 19.55, 3.5, 0);

  const s = (id: string, sx: number, my: number, pose: Spot['pose'], facing: Spot['facing'], tags: string[], pair?: string): Spot =>
    ({ id, mx: sx + DX, my, pose, facing, capacity: 1, tags, room: 'breakroom', pair });
  const spots: Spot[] = [
    s('espresso', 10.75, 1.15, 'drink', 'NE', ['coffee']),
    s('capsule', 11.35, 1.15, 'drink', 'NE', ['coffee']),
    s('vending', 13.5, 1.45, 'stand', 'NE', ['coffee']),
    s('cooler', 14.8, 0.95, 'drink', 'NE', ['coffee']),
    s('table-1', TX - 0.8, TY - 0.85, 'sit', 'SW', ['table']),
    s('table-2', TX, TY - 0.85, 'sit', 'SW', ['table']),
    s('table-3', TX + 0.8, TY - 0.85, 'sit', 'SW', ['table']),
    s('bar-1', 18.05, 2.05, 'drink', 'NE', ['bar']),
    s('bar-2', 19.2, 2.05, 'drink', 'NW', ['bar']),
    s('armchair', 17.0, 5.9, 'sit', 'SE', ['lounge', 'chat'], 'sofa-side'),
    s('sofa-side', 18.0, 5.05, 'stand', 'W', ['lounge', 'chat'], 'armchair'),
    s('cooler-chat-a', 14.3, 1.65, 'drink', 'E', ['chat'], 'cooler-chat-b'),
    s('cooler-chat-b', 15.2, 1.65, 'drink', 'W', ['chat'], 'cooler-chat-a'),
    s('corkboard', 16.0, 1.3, 'stand', 'NE', ['wander', 'corkboard']),
    s('window', 11.0, 5.2, 'stand', 'NE', ['wander']),
  ];
  const L = (sx: number, my: number, lift: number, r: number, color: number, a: number, pool = true, halo = true): Light => ({ mx: sx + DX, my, lift, r, color, a, pool, halo });
  const lights: Light[] = [
    L(13.0, 3.4, 0.95, 480, 0xffc070, 0.45),
    L(11.0, 0.9, 0, 300, 0xffe0b0, 0.25, true, false),
    L(13.5, 1.0, 0, 300, 0x9fe8ff, 0.3, true, false),
    L(18.6, 1.3, 1.4, 440, 0xffc070, 0.38),
    L(18.9, 6.4, 1.6, 460, 0xffb35c, 0.3),
    L(18.45, 5.75, 0.7, 180, 0xff7fd0, 0.25),
    L(19.55, 4.55, 0.7, 200, 0x4fa8ff, 0.3),
    L(16.6, 7.3, 1.0, 280, 0xffd9a0, 0.3),
  ];
  return { pieces, spots, lights };
}
