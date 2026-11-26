import { describe, it, expect } from 'vitest';
import { iso, screenToWorld } from '../src/engine/iso';
import { parsePieces, footprint } from '../src/engine/pieces';

const CSV = `category,piece,sprite_w,sprite_h,size_x_m,size_y_m,size_z_m,ground_x,ground_y,anim_frames
01_Furniture,Desk_Straight,224,216,1.4,0.7,0.834,112,154,0
02_Tech,Monitor,96,112,0.54,0.19,0.441,48,80,16`;

describe('iso', () => {
  it('projects metres to screen pixels', () => {
    expect(iso(1, 0)).toEqual({ x: 91, y: 45.5 });
    expect(iso(0, 1)).toEqual({ x: -91, y: 45.5 });
  });
  it('inverts at floor level', () => {
    const w = screenToWorld(iso(3.5, 2).x, iso(3.5, 2).y);
    expect(w.mx).toBeCloseTo(3.5); expect(w.my).toBeCloseTo(2);
  });
});

describe('pieces', () => {
  const P = parsePieces(CSV);
  it('parses ground point and animation frames', () => {
    expect(P.Desk_Straight.gx).toBe(112);
    expect(P.Monitor.anim).toBe(16);
    expect(P.Desk_Straight.cat).toBe('01_Furniture');
  });
  it('rotates the footprint with the view', () => {
    expect(footprint(P.Desk_Straight, 0)).toEqual({ w: 1.4, d: 0.7 });
    expect(footprint(P.Desk_Straight, 2)).toEqual({ w: 0.7, d: 1.4 });
    expect(footprint(P.Desk_Straight, 1)).toEqual({ w: 1.4, d: 1.4 });
  });
});
