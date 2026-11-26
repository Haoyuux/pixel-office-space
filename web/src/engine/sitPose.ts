/**
 * Seated pose synthesis. The character pack has no sitting animation, so a seated frame is built from a standing one:
 * the torso and head (rows above the hip line) are kept as they are and the legs are redrawn bent at the hip and knee,
 * from the character's own leg pixels so colours match every character and palette:
 *
 *  - thighs: the top rows of the legs, extruded from the hip toward the facing direction (iso-foreshortened);
 *  - shins + shoes: the lower rows of the legs, hanging straight down from the knee (shortened a little);
 *  - hands and props hanging below the hip line beside the legs (the drinking mug) stay with the torso.
 *
 * Pure pixel work on RGBA buffers (no DOM), so it is unit-testable; assets.ts runs it on canvas ImageData.
 * All geometry is in art pixels (the 1x sheets) and multiplied by `scale` (2 for the 2x sheets), so every synthesized
 * pixel stays on the art's pixel grid.
 */
import type { Dir } from './iso';

export interface Px { width: number; height: number; data: Uint8ClampedArray }

/** Art (1x) frame geometry of the pack: 84 × 124 frames, hip line at row 86, shoe soles at ≈ row 101. */
export const ART = { w: 84, h: 124, hip: 86, feet: 101 } as const;

export interface LegGeometry {
  /** Hip → knee, art px on screen (+x right, +y down). */
  thigh: [number, number];
  /** Rows of the standing legs (from the hip line) extruded as the thigh. */
  band: number;
  /** Rows dropped from the top of the shins (the seated shin is shorter than the standing leg). */
  skip: number;
}

/**
 * Leg geometry per facing. A thigh of ≈0.1 m (chibi) projects to the 2:1 iso screen axes: diagonal facings move
 * 2 px across per 1 px down, S/N are vertical and foreshortened, E/W are horizontal and long.
 */
export function legGeometry(dir: Dir): LegGeometry {
  const T: Record<Dir, [number, number]> = {
    S: [0, 3], SW: [-6, 3], W: [-7, 0], NW: [-5, -2], N: [0, -2], NE: [5, -2], E: [7, 0], SE: [6, 3],
  };
  const thigh = T[dir];
  // side views show the whole shin; elsewhere the seated leg is a bit shorter than the standing one
  const skip = thigh[1] === 0 ? 0 : thigh[1] > 0 ? thigh[1] + 2 : 3;
  return { thigh, band: 4, skip };
}

const px = (img: Px, x: number, y: number) => (y * img.width + x) * 4;

/**
 * Composes one seated frame into `out` at (ox, oy): torso from `torso` (rows above the hip) over legs synthesized
 * from `legs` (the same character's standing frame, usually idle frame 0 so legs stay still while the torso animates).
 * `torso`/`legs` are sheets with their frame origin given by (tx, ty) / (lx, ly). Frame size is ART × scale.
 */
export function composeSitFrame(
  out: Px, ox: number, oy: number,
  torso: Px, tx: number, ty: number,
  legs: Px, lx: number, ly: number,
  dir: Dir, scale: number,
): void {
  const s = scale, W = ART.w * s, H = ART.h * s, hip = ART.hip * s;
  const g = legGeometry(dir);
  // clear the frame
  for (let y = 0; y < H; y++) out.data.fill(0, px(out, ox, oy + y), px(out, ox + W, oy + y));
  // the legs' columns; anything else below the hip line (a hanging hand, the mug) belongs to the torso
  const [c0, c1] = legColumns(legs, lx, ly, scale);

  const copy = (src: Px, i: number, o: number) => {
    out.data[o] = src.data[i]; out.data[o + 1] = src.data[i + 1]; out.data[o + 2] = src.data[i + 2]; out.data[o + 3] = src.data[i + 3];
  };
  /** Copy the legs' rows [r0, r1) (frame coords, leg columns only) to the frame at offset (dx, dy). */
  const blit = (r0: number, r1: number, dx: number, dy: number) => {
    for (let y = r0; y < r1; y++) {
      const yy = y + dy;
      if (yy < 0 || yy >= H) continue;
      for (let x = c0; x < c1; x++) {
        const xx = x + dx;
        if (xx < 0 || xx >= W) continue;
        const i = px(legs, lx + x, ly + y);
        if (legs.data[i + 3] !== 0) copy(legs, i, px(out, ox + xx, oy + yy));
      }
    }
  };

  const [kx, ky] = g.thigh, steps = Math.max(Math.abs(kx), Math.abs(ky), 1);
  const band = hip + g.band * s;
  // thighs: the hip band swept from the hip to the knee, back to front so the knee end is on top
  for (let t = 0; t <= steps; t++) blit(hip, band, Math.round((t * kx) / steps) * s, Math.round((t * ky) / steps) * s);
  // shins and shoes hang from the knee (the top `skip` rows dropped: a seated shin is shorter than a standing leg)
  const skip = g.skip * s;
  blit(band + skip, H, kx * s, ky * s - skip);

  // torso and head on top, with whatever hangs below the hip line beside the legs (hands, the mug)
  const extra = hip + EXTRA_ROWS * s;
  for (let y = 0; y < extra; y++) for (let x = 0; x < W; x++) {
    const i = px(torso, tx + x, ty + y);
    if (torso.data[i + 3] === 0) continue;
    // within the legs' columns only what differs from the legs (a hand or the mug passing in front)
    if (y >= hip && x >= c0 && x < c1 && same(torso, i, legs, px(legs, lx + x, ly + y))) continue;
    copy(torso, i, px(out, ox + x, oy + y));
  }
}

const same = (a: Px, i: number, b: Px, j: number) =>
  a.data[i] === b.data[j] && a.data[i + 1] === b.data[j + 1] && a.data[i + 2] === b.data[j + 2] && a.data[i + 3] === b.data[j + 3];

/** Rows below the hip line where the torso's hands and props may hang. */
const EXTRA_ROWS = 7;

/**
 * The legs' column span [c0, c1) in a standing frame: the opaque columns of the shins (a few rows below the hip,
 * above the shoes, which point toward the facing), widened by one art pixel each side for the hips.
 */
export function legColumns(img: Px, fx: number, fy: number, scale: number): [number, number] {
  const s = scale, W = ART.w * s;
  let c0 = W, c1 = 0;
  for (let y = (ART.hip + 6) * s; y < (ART.hip + 9) * s; y++) for (let x = 0; x < W; x++) {
    if (img.data[px(img, fx + x, fy + y) + 3] === 0) continue;
    c0 = Math.min(c0, x); c1 = Math.max(c1, x + 1);
  }
  if (c1 <= c0) return [0, 0];
  return [Math.max(0, c0 - s), Math.min(W, c1 + s)];
}

/**
 * The seated frames' box inside the pack's frame, art px: every seated pixel of every character, clip and direction
 * fits (measured: x 19–64, y 34–102), centred on the frame's x centre so the sprite anchor stays at x = 0.5.
 * Less than half the pack's frame, so the extra seated sheets cost little texture memory.
 */
export const SIT_BOX = { x: 14, y: 28, w: 56, h: 80 } as const;

/**
 * A whole seated sheet: rows = `dirs`, `frames` columns of SIT_BOX-sized frames (× scale), torso from `clip`, legs
 * from frame 0 of `idle` in the same direction. The hip is at row (ART.hip − SIT_BOX.y) × scale of each frame.
 */
export function sitSheet(clip: Px, idle: Px, frames: number, dirs: readonly Dir[], scale: number): Px {
  const W = ART.w * scale, H = ART.h * scale, bw = SIT_BOX.w * scale, bh = SIT_BOX.h * scale;
  const tmp: Px = { width: W, height: H, data: new Uint8ClampedArray(W * H * 4) };
  const out: Px = { width: frames * bw, height: dirs.length * bh, data: new Uint8ClampedArray(frames * bw * dirs.length * bh * 4) };
  dirs.forEach((d, r) => {
    for (let f = 0; f < frames; f++) {
      composeSitFrame(tmp, 0, 0, clip, f * W, r * H, idle, 0, r * H, d, scale);
      for (let y = 0; y < bh; y++) {
        const from = ((SIT_BOX.y * scale + y) * W + SIT_BOX.x * scale) * 4;
        out.data.set(tmp.data.subarray(from, from + bw * 4), ((r * bh + y) * out.width + f * bw) * 4);
      }
    }
  });
  return out;
}
