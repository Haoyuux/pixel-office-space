import { describe, expect, it } from 'vitest';
import { ART, composeSitFrame, legColumns, legGeometry, SIT_BOX, sitSheet, type Px } from '../src/engine/sitPose';
import { DIRS } from '../src/engine/iso';

const TORSO = [200, 100, 80, 255], PANTS = [40, 40, 60, 255], SHOE = [180, 30, 60, 255], MUG = [250, 250, 250, 255];

/** A synthetic standing frame: a torso block above the hip, a 5 px wide pair of legs, shoes at the bottom. */
function frame(): Px {
  const img: Px = { width: ART.w, height: ART.h, data: new Uint8ClampedArray(ART.w * ART.h * 4) };
  const fill = (x0: number, y0: number, x1: number, y1: number, c: number[]) => {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) img.data.set(c, (y * img.width + x) * 4);
  };
  fill(34, 50, 50, ART.hip, TORSO);
  fill(40, ART.hip, 45, 97, PANTS);
  fill(40, 97, 45, ART.feet + 1, SHOE);
  return img;
}
const at = (img: Px, x: number, y: number) => Array.from(img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4));
const opaque = (img: Px) => {
  const pts: [number, number][] = [];
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) if (img.data[(y * img.width + x) * 4 + 3]) pts.push([x, y]);
  return pts;
};
const compose = (src: Px, dir: (typeof DIRS)[number], scale = 1) => {
  const out: Px = { width: src.width, height: src.height, data: new Uint8ClampedArray(src.data.length) };
  composeSitFrame(out, 0, 0, src, 0, 0, src, 0, 0, dir, scale);
  return out;
};

describe('legGeometry', () => {
  it('points the thighs toward the facing on the 2:1 iso axes', () => {
    expect(legGeometry('SW').thigh).toEqual([-6, 3]);
    expect(legGeometry('SE').thigh).toEqual([6, 3]);
    for (const d of ['SW', 'SE', 'NW', 'NE'] as const) {
      const [x, y] = legGeometry(d).thigh;
      expect(Math.abs(x)).toBeGreaterThan(Math.abs(y));
    }
    expect(legGeometry('S').thigh[0]).toBe(0);
    expect(legGeometry('E').thigh[1]).toBe(0);
    expect(legGeometry('N').thigh[1]).toBeLessThan(0);
  });
  it('mirrors SW and SE', () => {
    const sw = legGeometry('SW'), se = legGeometry('SE');
    expect(se.thigh).toEqual([-sw.thigh[0], sw.thigh[1]]);
    expect(se.skip).toBe(sw.skip);
  });
});

describe('legColumns', () => {
  it('spans the shins, one art pixel wider each side', () => {
    expect(legColumns(frame(), 0, 0, 1)).toEqual([39, 46]);
  });
});

describe('composeSitFrame', () => {
  it('keeps the torso and bends the legs toward the facing (SW)', () => {
    const out = compose(frame(), 'SW');
    for (let y = 50; y < ART.hip; y++) expect(at(out, 34, y)).toEqual(TORSO);
    // the knee is 6 px left and 3 px down of the hip: thigh pixels reach x = 34
    const pts = opaque(out).filter(([, y]) => y >= ART.hip);
    expect(Math.min(...pts.map(p => p[0]))).toBe(34);
    expect(at(out, 34, ART.hip + 3)).toEqual(PANTS);
    // the seated legs are shorter than the standing ones and end in the shoes
    const bottom = Math.max(...pts.map(p => p[1]));
    expect(bottom).toBe(ART.feet - 2);
    expect(at(out, 36, bottom)).toEqual(SHOE);
    // nothing is left where the standing legs were, behind the knee
    expect(at(out, 44, ART.feet)).toEqual([0, 0, 0, 0]);
  });

  it('mirrors for SE', () => {
    const pts = opaque(compose(frame(), 'SE')).filter(([, y]) => y >= ART.hip);
    expect(Math.max(...pts.map(p => p[0]))).toBe(44 + 6);
  });

  it('keeps props below the hip beside or in front of the legs with the torso', () => {
    const src = frame(), legs = frame();
    src.data.set(MUG, ((ART.hip + 2) * src.width + 30) * 4); // beside the legs
    src.data.set(MUG, ((ART.hip + 1) * src.width + 41) * 4); // in front of the legs
    const out: Px = { width: src.width, height: src.height, data: new Uint8ClampedArray(src.data.length) };
    composeSitFrame(out, 0, 0, src, 0, 0, legs, 0, 0, 'SE', 1);
    expect(at(out, 30, ART.hip + 2)).toEqual(MUG);
    expect(at(out, 41, ART.hip + 1)).toEqual(MUG);
  });

  it('stays on the art pixel grid at 2x', () => {
    const one = frame();
    const two: Px = { width: ART.w * 2, height: ART.h * 2, data: new Uint8ClampedArray(ART.w * ART.h * 16) };
    for (let y = 0; y < two.height; y++) for (let x = 0; x < two.width; x++) two.data.set(at(one, x >> 1, y >> 1), (y * two.width + x) * 4);
    const a = compose(one, 'SW'), b = compose(two, 'SW', 2);
    for (let y = 0; y < b.height; y++) for (let x = 0; x < b.width; x++) expect(at(b, x, y)).toEqual(at(a, x >> 1, y >> 1));
  });
});

describe('sitSheet', () => {
  it('lays out SIT_BOX crops (rows = directions, columns = frames)', () => {
    const src = frame();
    const sheet: Px = { width: ART.w * 2, height: ART.h * DIRS.length, data: new Uint8ClampedArray(ART.w * 2 * ART.h * DIRS.length * 4) };
    for (let r = 0; r < DIRS.length; r++) for (let f = 0; f < 2; f++) for (let y = 0; y < ART.h; y++)
      sheet.data.set(src.data.subarray(y * ART.w * 4, (y + 1) * ART.w * 4), ((r * ART.h + y) * sheet.width + f * ART.w) * 4);
    const out = sitSheet(sheet, sheet, 2, DIRS, 1);
    expect([out.width, out.height]).toEqual([SIT_BOX.w * 2, SIT_BOX.h * DIRS.length]);
    expect(SIT_BOX.x * 2 + SIT_BOX.w).toBe(ART.w); // centred: the sprite anchor stays at x = 0.5
    const sw = compose(src, 'SW');
    let n = 0;
    for (let y = 0; y < ART.h; y++) for (let x = 0; x < ART.w; x++) {
      const inBox = x >= SIT_BOX.x && x < SIT_BOX.x + SIT_BOX.w && y >= SIT_BOX.y && y < SIT_BOX.y + SIT_BOX.h;
      if (!inBox) { expect(at(sw, x, y)[3]).toBe(0); continue; }
      expect(at(out, SIT_BOX.w + x - SIT_BOX.x, SIT_BOX.h + y - SIT_BOX.y)).toEqual(at(sw, x, y));
      n += at(sw, x, y)[3] ? 1 : 0;
    }
    expect(n).toBeGreaterThan(100);
  });
});
