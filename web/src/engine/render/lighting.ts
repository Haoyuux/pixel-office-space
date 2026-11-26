import { Container, Graphics, Sprite, Texture, type Application } from 'pixi.js';
import { iso, PZ } from '../iso';
import type { BuildingLayout, Light } from '../layout/types';
import { rectPoly, screenBox, wallPoly, buildingBox } from './geom';

/** Approved spike values (spike/v2.html, final night lighting). */
export const NIGHT_TINT = 0xa39ac4;
export const DAY_BG = 0x9fb4cc, NIGHT_BG = 0x0b0e1c;
const MOON = 0xfff4d6;

let glowTex: Texture | null = null;
function glowTexture(): Texture {
  if (!glowTex) {
    const c = document.createElement('canvas'); c.width = c.height = 256;
    const g = c.getContext('2d')!, grad = g.createRadialGradient(128, 128, 0, 128, 128, 128);
    grad.addColorStop(0, 'rgba(255,255,255,1)'); grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad; g.fillRect(0, 0, 256, 256);
    glowTex = Texture.from(c);
    glowTex.source.scaleMode = 'linear';
  }
  return glowTex;
}

/**
 * Night = every world child is tinted (no overlay shape, so no dark frame or bright wall edges),
 * plus additive floor pools clipped to the floor polygon, small halos at real lamps clipped to the
 * floor + wall silhouette, and a starry sky behind the building.
 */
export class Lighting {
  night: boolean;
  /** World children that must keep their own colours (light layers, masks, emissive overlays). */
  readonly untinted = new Set<Container>();
  /** Emissive layers (neon glows) shown only at night; register them after build(). */
  readonly nightOnly = new Set<Container>();
  private pools!: Container;
  private halos!: Container;
  private sky!: Graphics;
  private byTag = new Map<string, Sprite[]>();

  constructor(private app: Application, private world: Container, night = false) {
    this.night = night;
  }

  /** (Re)build every light for a layout. Call after the world's sprites are in place. */
  build(L: BuildingLayout): void {
    // The scene clears (and destroys) every world child before a rebuild; just drop old references.
    this.untinted.clear(); this.nightOnly.clear(); this.byTag.clear();

    // Floor mask: every room rect (gaps of empty slots stay unlit). Silhouette = floors + walls/glass extruded.
    const floorMask = new Graphics();
    for (const r of L.rooms) floorMask.poly(rectPoly(r.x0, r.y0, r.x1, r.y1)).fill(0xffffff);
    const silMask = new Graphics();
    for (const r of L.rooms) silMask.poly(rectPoly(r.x0, r.y0, r.x1, r.y1)).fill(0xffffff);
    for (const s of L.walls) silMask.poly(wallPoly(s)).fill(0xffffff);

    // Pools sit just above the floor tiles (-1e5) and under walls (-5e4) / furniture, so they light the floor only.
    this.pools = new Container({ zIndex: -9e4 }); this.pools.mask = floorMask;
    this.halos = new Container({ zIndex: 1e6 }); this.halos.mask = silMask;
    this.sky = new Graphics({ zIndex: -2e5 });
    for (const o of [floorMask, silMask, this.pools, this.halos, this.sky]) { this.world.addChild(o); this.untinted.add(o); }

    for (const l of L.lights) this.add(l);
    // Windows glow faintly with moonlight on the floor in front of them.
    for (const p of L.pieces) {
      if (p.tag !== 'wall' || !/Window/.test(p.piece)) continue;
      const along = p.view === 0;
      this.add({ mx: along ? p.mx : 0.9, my: along ? 0.9 : p.my, lift: 0, r: 200, color: 0x8fa8ff, a: 0.14, pool: true, halo: false });
    }
    this.drawSky(screenBox(buildingBox(L.rooms)));
    this.apply();
  }

  get glowTexture(): Texture { return glowTexture(); }

  /** A soft floor pool under the source and/or a small halo at the source itself (spike `light()`). */
  add(l: Light): void {
    const p = iso(l.mx, l.my), made: Sprite[] = [];
    if (l.pool) made.push(this.glow(this.pools, p.x, p.y, l.r * 2, l.r, l.color, l.a * 0.8));
    if (l.halo) made.push(this.glow(this.halos, p.x, p.y - l.lift * PZ, l.r * 0.45, l.r * 0.45, l.color, l.a * 0.7));
    if (l.when === 'working' && l.tag) {
      for (const s of made) s.visible = false;
      this.byTag.set(l.tag, [...(this.byTag.get(l.tag) ?? []), ...made]);
    }
  }

  private glow(layer: Container, x: number, y: number, w: number, h: number, color: number, a: number): Sprite {
    const s = new Sprite(glowTexture());
    s.anchor.set(0.5); s.position.set(x, y); s.width = w; s.height = h;
    s.tint = color; s.alpha = a; s.blendMode = 'add';
    layer.addChild(s);
    return s;
  }

  /** Lights that only shine while a bot works (desk monitors). */
  setWorking(tag: string, on: boolean): void {
    for (const s of this.byTag.get(tag) ?? []) s.visible = on;
  }

  private drawSky(b: { x0: number; y0: number; x1: number; y1: number }): void {
    const pad = 2600, x0 = b.x0 - pad, y0 = b.y0 - pad, w = b.x1 - b.x0 + 2 * pad, h = b.y1 - b.y0 + 2 * pad;
    let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const n = Math.round((w * h) * 260 / (6400 * 3200));
    for (let i = 0; i < n; i++) this.sky.circle(x0 + rnd() * w, y0 + rnd() * h, rnd() < 0.15 ? 2.5 : 1.3).fill({ color: 0xffffff, alpha: 0.35 + rnd() * 0.6 });
    const mx = b.x1 - 300, my = b.y0 - 500;
    this.sky.circle(mx, my, 70).fill(MOON);
    this.sky.circle(mx + 30, my - 25, 64).fill(NIGHT_BG);
  }

  setNight(on: boolean): void { this.night = on; this.apply(); }

  /** Re-tint every world child (call again after adding children). */
  apply(): void {
    const t = this.night ? NIGHT_TINT : 0xffffff;
    for (const ch of this.world.children) if (!this.untinted.has(ch)) ch.tint = t;
    if (this.pools) this.pools.visible = this.halos.visible = this.sky.visible = this.night;
    for (const c of this.nightOnly) c.visible = this.night;
    this.app.renderer.background.color = this.night ? NIGHT_BG : DAY_BG;
  }

  /** Tint one new child to the current time of day. */
  tint(ch: Container): void { if (!this.untinted.has(ch)) ch.tint = this.night ? NIGHT_TINT : 0xffffff; }
}
