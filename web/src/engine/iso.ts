/** Screen pixels per metre for the 128 ppm art (measured in the spike). */
export const PX = 91, PY = 45.5, PZ = 111;

export const iso = (mx: number, my: number) => ({ x: (mx - my) * PX, y: (mx + my) * PY });

/** Inverse of iso() on the floor plane. */
export const screenToWorld = (sx: number, sy: number) => {
  const a = sx / PX, b = sy / PY; // a = mx - my, b = mx + my
  return { mx: (a + b) / 2, my: (b - a) / 2 };
};

export type Dir = 'S' | 'SW' | 'W' | 'NW' | 'N' | 'NE' | 'E' | 'SE';
export const DIRS: Dir[] = ['S', 'SW', 'W', 'NW', 'N', 'NE', 'E', 'SE'];

/** Facing of a character moving by (dx, dy) in world metres. */
export function dirFrom(dx: number, dy: number): Dir {
  const a = (Math.atan2((dx + dy) * PY, (dx - dy) * PX) * 180) / Math.PI;
  const table: [Dir, number][] = [['E', 0], ['SE', 45], ['S', 90], ['SW', 135], ['W', 180], ['W', -180], ['NW', -135], ['N', -90], ['NE', -45]];
  return table.reduce((b, x) => (Math.abs(a - x[1]) < Math.abs(a - b[1]) ? x : b))[0];
}
