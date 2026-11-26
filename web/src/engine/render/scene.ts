import { AnimatedSprite, Container, Graphics, Point, Sprite, Text, Texture, type Application, type Ticker } from 'pixi.js';
import { ACCENT_HEX, type Project, type RoleId } from '@office/shared';
import { iso, PZ, screenToWorld } from '../iso';
import { loadNeon, loadPiece, loadPieceMeta, pieceMeta } from '../assets';
import { NEON_SCALE } from '../neon';
import type { BuildingLayout, Placed, RoomRect, Rug } from '../layout/types';
import { buildingBox, rectPoly, roomAtPoint, type Box } from './geom';
import { Lighting } from './lighting';
import type { Camera } from './camera';

const HALL_DARK = 0x1d1f26, HALL_LIGHT = 0xe9e6dc, THRESHOLD = 0x9a6a3c;
/** Low-res text scaled up with nearest-neighbour sampling reads as a pixel font. */
const PIXEL_FONT = ['"Lucida Console"', '"Courier New"', 'monospace'];
const TEXT_SCALE = 3;
/** Skew that lays a container on a vertical plane running along world y (x = const) or along world x. */
const SKEW_ALONG_Y = Math.atan2(-45.5, 91), SKEW_ALONG_X = Math.atan2(45.5, 91);
const MAX_TROPHIES = 4;

interface Monitor { still: Sprite; anim?: AnimatedSprite }
interface Plate { root: Container; glow: Sprite; plate: Graphics; text: Text; accent: number; x: number; y: number }

const lerpColor = (a: number, b: number, t: number) => {
  const ch = (s: number) => Math.round(((a >> s) & 255) * (1 - t) + ((b >> s) & 255) * t) << s;
  return ch(16) | ch(8) | ch(0);
};

/** Places the layout's pieces exactly like the approved spike's `put()` and owns overlays and lighting. */
export class OfficeScene {
  readonly world = new Container({ sortableChildren: true });
  readonly lighting: Lighting;
  /** Set by OfficeCanvas so screenshot scripts can reach it through `window.__office.camera`. */
  camera: Camera | null = null;
  layout: BuildingLayout | null = null;

  private gen = 0;
  private drawnOnce = false;
  /** World children that survive setLayout (bots), and whether they stay untinted. */
  private persistent = new Map<Container, { untinted: boolean }>();
  private projects = new Map<string, Project>();
  private monitors = new Map<string, Monitor>();
  private working = new Set<string>();
  private plates = new Map<string, Plate>();
  private boards = new Map<string, Placed>();
  private shelves = new Map<string, Placed>();
  private boardTitles = new Map<string, string | null>();
  private boardText = new Map<string, Container>();
  private trophyCount = new Map<string, number>();
  private trophies = new Map<string, Sprite[]>();
  private trophyTex: Texture | null = null;
  private badgeText = new Map<string, string>();
  private badgeViews = new Map<string, Container>();
  private cork: Sprite | null = null;
  private overlay = new Graphics();
  private eye = new Text({ text: '👁', style: { fontSize: 64 }, anchor: 0.5 });
  private selected: string | null = null;
  private hover: string | null = null;
  private time = 0;
  private tick = (t: Ticker) => this.update(t);

  constructor(private app: Application) {
    app.stage.addChild(this.world);
    this.lighting = new Lighting(app, this.world);
    app.ticker.add(this.tick);
  }

  destroy(): void {
    this.app.ticker.remove(this.tick);
    this.gen++;
  }

  /** Rebuilds the whole office. `projects` supplies the names and accents for nameplates and highlights. */
  async setLayout(layout: BuildingLayout, projects: Project[] = []): Promise<void> {
    const gen = ++this.gen;
    await loadPieceMeta();
    const monitorTag = (p: Placed) => p.tag?.startsWith('monitor:');
    const textures = await Promise.all(layout.pieces.map(async p => {
      if (p.pack === 'neon') {
        const [still, glow] = await Promise.all([loadNeon(p.piece, p.variant!), loadNeon(p.piece, p.variant!, true)]);
        return { still, frames: null, glow };
      }
      const animated = !!p.anim && pieceMeta(p.piece).anim > 0;
      const still = (animated && !monitorTag(p)) ? null : await loadPiece(p.piece, p.view) as Texture;
      const frames = animated ? await loadPiece(p.piece, p.view, true) as Texture[] : null;
      return { still, frames, glow: null as Texture | null };
    }));
    this.trophyTex = await loadPiece('Trophy', 0) as Texture;
    if (gen !== this.gen) return;

    for (const ch of this.world.removeChildren()) if (!this.persistent.has(ch)) ch.destroy({ children: true });
    this.layout = layout;
    this.projects = new Map(projects.map(p => [p.id, p]));
    this.monitors.clear(); this.plates.clear(); this.boards.clear(); this.shelves.clear();
    this.boardText.clear(); this.trophies.clear(); this.badgeViews.clear();
    this.cork = null;

    const glows: Sprite[] = [];
    layout.pieces.forEach((p, i) => {
      const { still, frames, glow } = textures[i];
      if (glow) {
        // the pack's neon glow, additive over the prop, untinted and only at night (registered after lighting.build)
        const g = this.put(p, new Sprite(glow));
        g.blendMode = 'add'; g.zIndex += 0.01;
        glows.push(g);
      }
      if (monitorTag(p)) {
        const m: Monitor = { still: this.put(p, new Sprite(still!)) };
        if (frames) { m.anim = this.put(p, new AnimatedSprite(frames)); m.anim.animationSpeed = 0.2; m.anim.visible = false; }
        this.monitors.set(p.tag!, m);
        return;
      }
      if (frames) { const a = this.put(p, new AnimatedSprite(frames)); a.animationSpeed = 0.2; a.play(); }
      else { const spr = this.put(p, new Sprite(still!)); if (p.tag === 'corkboard') this.cork = spr; }
      if (p.tag?.startsWith('whiteboard:')) this.boards.set(p.tag.slice(11), p);
      if (p.tag?.startsWith('shelf:')) this.shelves.set(p.tag.slice(6), p);
    });

    this.world.addChild(this.drawHall(layout.rooms));
    this.world.addChild(this.drawRugs(layout.rugs ?? []));
    this.lighting.build(layout);
    for (const g of glows) { this.lighting.untinted.add(g); this.lighting.nightOnly.add(g); }
    for (const [c, o] of this.persistent) { this.world.addChild(c); if (o.untinted) this.lighting.untinted.add(c); }
    for (const n of layout.nameplates) this.addNameplate(n.projectId, n.mx, n.my, n.lift);

    this.overlay = new Graphics({ zIndex: -8.9e4 });
    this.eye = new Text({ text: '👁', style: { fontSize: 64 }, anchor: 0.5, zIndex: 1e6 + 1 });
    for (const o of [this.overlay, this.eye]) { this.world.addChild(o); this.lighting.untinted.add(o); }

    for (const id of this.boardTitles.keys()) this.drawBoard(id);
    for (const id of this.trophyCount.keys()) this.drawTrophies(id);
    for (const id of this.badgeText.keys()) this.drawBadge(id);
    for (const tag of this.monitors.keys()) this.applyWorking(tag);
    if (this.selected && !this.projects.has(this.selected) && !this.plates.has(this.selected)) this.selected = null;
    this.drawOverlay();
    this.lighting.apply();

    if (!this.drawnOnce) { this.drawnOnce = true; document.title = 'READY'; }
  }

  /** Spike `put()`: anchor at the ground point, position = iso − lift, zIndex = iso y + bias (or explicit zi). */
  private put<T extends Sprite>(p: Placed, spr: T): T {
    const m = pieceMeta(p.piece);
    spr.anchor.set(m.gx / m.w, m.gy / m.h);
    const s = iso(p.mx, p.my);
    spr.position.set(s.x, s.y - (p.lift ?? 0) * PZ);
    spr.zIndex = p.zi ?? s.y + (p.z ?? 0);
    // neon props are drawn at 48 ppm; view 6 (facing +x) is the native +y view mirrored about the pivot
    if (p.pack === 'neon') spr.scale.set(p.view === 6 ? -NEON_SCALE : NEON_SCALE, NEON_SCALE);
    this.world.addChild(spr);
    return spr;
  }

  /** Hallway: 0.5 m black/white checker; doorways: a wooden threshold strip across the glass line. */
  private drawHall(rooms: RoomRect[]): Graphics {
    const g = new Graphics({ zIndex: -1e5 + 1 });
    for (const h of rooms.filter(r => r.kind === 'hall')) {
      for (let x = h.x0; x < h.x1; x += 0.5) for (let y = h.y0; y < h.y1; y += 0.5) {
        g.poly(rectPoly(x, y, x + 0.5, y + 0.5)).fill(Math.round((x + y) * 2) % 2 === 0 ? HALL_DARK : HALL_LIGHT);
      }
    }
    for (const r of rooms) if (r.door) g.poly(rectPoly(r.door.x - 0.12, r.door.y0, r.door.x + 0.12, r.door.y1)).fill(THRESHOLD);
    return g;
  }

  /**
   * Code-drawn rugs just above the floor (under night pools, walls and furniture): a darker edge for thickness, a
   * border band, a thin inner line, then a pattern (stripes across the short side, a diamond lattice or soft checks).
   */
  private drawRugs(rugs: Rug[]): Graphics {
    const g = new Graphics({ zIndex: -9.5e4 });
    const quad = (x0: number, y0: number, x1: number, y1: number, color: number, alpha = 1, lift = 0.012) =>
      g.poly(rectPoly(x0, y0, x1, y1, lift)).fill({ color, alpha });
    for (const r of rugs) {
      const w = r.x1 - r.x0, d = r.y1 - r.y0, b = Math.min(0.22, Math.min(w, d) * 0.08);
      g.poly(rectPoly(r.x0, r.y0, r.x1, r.y1)).fill(lerpColor(r.border, 0x000000, 0.35)); // thickness on the front edges
      quad(r.x0, r.y0, r.x1, r.y1, r.border);
      const ix0 = r.x0 + b, iy0 = r.y0 + b, ix1 = r.x1 - b, iy1 = r.y1 - b;
      quad(ix0, iy0, ix1, iy1, r.color);
      const iw = ix1 - ix0, id = iy1 - iy0;
      if (r.pattern === 'stripes') {
        // bands across the long side, near both ends
        const alongX = iw >= id, n = 3, t = 0.07;
        for (const end of [0, 1]) for (let k = 0; k < n; k++) {
          const o = 0.25 + k * 0.16, len = alongX ? iw : id, a = end ? len - o - t : o;
          if (alongX) quad(ix0 + a, iy0, ix0 + a + t, iy1, k === 1 ? r.accent : r.border, 0.85);
          else quad(ix0, iy0 + a, ix1, iy0 + a + t, k === 1 ? r.accent : r.border, 0.85);
        }
      } else if (r.pattern === 'diamonds') {
        // a lattice of small diamonds (iso squares turned 45°) in the field
        const step = 0.55, s2 = 0.13;
        for (let x = ix0 + step * 0.75; x < ix1 - step * 0.4; x += step) for (let y = iy0 + step * 0.75; y < iy1 - step * 0.4; y += step) {
          const pts = [[x, y - s2], [x + s2, y], [x, y + s2], [x - s2, y]].flatMap(([px, py]) => { const p = iso(px, py); return [p.x, p.y - 0.012 * PZ]; });
          g.poly(pts).fill({ color: r.accent, alpha: 0.55 });
        }
      } else if (r.pattern === 'checks') {
        const c = 0.5;
        for (let x = ix0; x < ix1 - 1e-6; x += c) for (let y = iy0; y < iy1 - 1e-6; y += c) {
          if (Math.round((x - ix0 + y - iy0) / c) % 2) quad(x, y, Math.min(ix1, x + c), Math.min(iy1, y + c), lerpColor(r.color, 0xffffff, 0.06));
        }
      }
      // thin inner line just inside the border
      const e = 0.05;
      g.poly(rectPoly(ix0 + e, iy0 + e, ix1 - e, iy1 - e, 0.012), true).stroke({ width: 1.5, color: r.accent, alpha: 0.7 });
      // tassels on the two short ends
      const shortX = w < d;
      const n = Math.floor((shortX ? w : d) / 0.12);
      for (let k = 1; k < n; k++) {
        const t = k / n;
        const ends: [number, number, number, number][] = shortX
          ? [[r.x0 + t * w, r.y0, 0, -0.07], [r.x0 + t * w, r.y1, 0, 0.07]]
          : [[r.x0, r.y0 + t * d, -0.07, 0], [r.x1, r.y0 + t * d, 0.07, 0]];
        for (const [x, y, dx, dy] of ends) {
          const p = iso(x, y), q = iso(x + dx, y + dy);
          g.moveTo(p.x, p.y).lineTo(q.x, q.y).stroke({ width: 2, color: lerpColor(r.accent, r.border, 0.3), alpha: 0.9 });
        }
      }
    }
    return g;
  }

  private accent(id: string): number { return ACCENT_HEX[this.projects.get(id)?.accent ?? 'cyan']; }

  /** Code-drawn neon sign on the hallway glass, above the doorway, laid on the glass plane. */
  private addNameplate(id: string, mx: number, my: number, lift: number): void {
    const accent = this.accent(id), name = (this.projects.get(id)?.name ?? id).toUpperCase();
    const p = iso(mx, my), x = p.x, y = p.y - lift * PZ;
    const root = new Container({ zIndex: p.y + 100 });
    root.position.set(x, y);
    const glow = new Sprite(this.lighting.glowTexture);
    glow.anchor.set(0.5); glow.tint = accent; glow.blendMode = 'add';
    const sign = new Container({ skew: { x: 0, y: SKEW_ALONG_Y } });
    const text = new Text({
      text: name, resolution: 1, anchor: 0.5,
      style: { fontFamily: PIXEL_FONT, fontSize: 11, fontWeight: 'bold', fill: lerpColor(accent, 0xffffff, 0.55), stroke: { color: accent, width: 2 }, letterSpacing: 1 },
    });
    text.scale.set(TEXT_SCALE);
    const maxW = 3 * 101.7; // ≤ 3 m along the glass
    if (text.width > maxW) text.scale.set(TEXT_SCALE * maxW / text.width);
    const w = text.width + 28, h = text.height + 16;
    const plate = new Graphics();
    plate.roundRect(-w / 2, -h / 2, w, h, 6).fill({ color: 0x141826, alpha: 0.85 }).stroke({ color: accent, width: 3 });
    sign.addChild(plate, text);
    glow.width = w * 1.6; glow.height = h * 3.2;
    root.addChild(glow, sign);
    this.world.addChild(root);
    this.lighting.untinted.add(root);
    // At night the sign is also a real lamp: a halo clipped to the building silhouette.
    this.lighting.add({ mx, my, lift, r: 320, color: accent, a: 0.45, pool: false, halo: true });
    this.plates.set(id, { root, glow, plate, text, accent, x, y });
  }

  /** Adds a world child that is kept (not destroyed) across setLayout, e.g. a bot. */
  keep(c: Container, opts: { untinted?: boolean } = {}): void {
    this.persistent.set(c, { untinted: !!opts.untinted });
    this.world.addChild(c);
    if (opts.untinted) this.lighting.untinted.add(c); else this.lighting.tint(c);
  }

  /** Removes a kept child from the world (the caller destroys it). */
  unkeep(c: Container): void {
    this.persistent.delete(c);
    this.lighting.untinted.delete(c);
    c.removeFromParent();
  }

  setNight(on: boolean): void { this.lighting.setNight(on); this.drawOverlay(); }
  get night(): boolean { return this.lighting.night; }

  setSelected(projectId: string | null): void { this.selected = projectId; this.drawOverlay(); }
  setHover(projectId: string | null): void { if (projectId !== this.hover) { this.hover = projectId; this.drawOverlay(); } }

  private drawOverlay(): void {
    const g = this.overlay;
    if (g.destroyed) return;
    g.clear();
    const rect = (id: string | null) => this.layout?.rooms.find(r => r.id === id && r.kind === 'project');
    const h = rect(this.hover);
    if (h && h.id !== this.selected) g.poly(rectPoly(h.x0, h.y0, h.x1, h.y1), true).stroke({ width: 4, color: this.accent(h.id), alpha: 0.4 });
    const s = rect(this.selected);
    if (s) {
      const pts = rectPoly(s.x0, s.y0, s.x1, s.y1), c = this.accent(s.id);
      g.poly(pts).fill({ color: c, alpha: 0.12 });
      g.poly(pts, true).stroke({ width: 16, color: c, alpha: 0.18 });
      g.poly(pts, true).stroke({ width: 5, color: c, alpha: 1 });
    }
    for (const [id, p] of this.plates) {
      const on = id === this.selected;
      p.glow.alpha = on ? 0.75 : 0.3;
      p.text.alpha = on ? 1 : 0.88;
      p.plate.alpha = on ? 1 : 0.9;
      p.root.scale.set(on ? 1.08 : 1);
    }
    this.eye.visible = !!s && this.plates.has(s.id);
  }

  setWorking(projectId: string, role: RoleId, on: boolean): void {
    const tag = `monitor:${projectId}:${role}`;
    if (on) this.working.add(tag); else this.working.delete(tag);
    this.applyWorking(tag);
  }

  private applyWorking(tag: string): void {
    const on = this.working.has(tag), m = this.monitors.get(tag);
    if (m?.anim) { m.anim.visible = on; m.still.visible = !on; if (on) m.anim.play(); else m.anim.stop(); }
    this.lighting.setWorking(tag, on);
  }

  /** Current ticket title as a small card on the room's whiteboard (null clears it). */
  setWhiteboard(projectId: string, title: string | null): void {
    this.boardTitles.set(projectId, title);
    this.drawBoard(projectId);
  }

  private drawBoard(id: string): void {
    this.boardText.get(id)?.destroy({ children: true });
    this.boardText.delete(id);
    const title = this.boardTitles.get(id), b = this.boards.get(id);
    if (!title || !b) return;
    const p = iso(b.mx, b.my);
    const root = new Container({ zIndex: p.y + (b.z ?? 0) + 1, skew: { x: 0, y: SKEW_ALONG_X } });
    root.position.set(p.x - 2, p.y - 1.5 * PZ);
    const short = title.length > 40 ? title.slice(0, 39) + '…' : title;
    const text = new Text({
      text: short, resolution: 2, anchor: 0.5,
      style: { fontFamily: PIXEL_FONT, fontSize: 10, fontWeight: 'bold', fill: 0x1d2b4f, wordWrap: true, wordWrapWidth: 92, align: 'center', lineHeight: 11 },
    });
    if (text.height > 34) text.scale.set(34 / text.height);
    const card = new Graphics().rect(-50, -text.height / 2 - 4, 100, text.height + 8).fill(0xfff7c2).stroke({ color: 0xd9c86a, width: 1 });
    root.addChild(card, text);
    this.world.addChild(root);
    this.lighting.tint(root);
    this.boardText.set(id, root);
  }

  /** Trophies on top of the room's open shelf (up to four are shown). */
  setTrophies(projectId: string, n: number): void {
    this.trophyCount.set(projectId, Math.max(0, Math.floor(n)));
    this.drawTrophies(projectId);
  }

  private drawTrophies(id: string): void {
    for (const s of this.trophies.get(id) ?? []) s.destroy();
    this.trophies.delete(id);
    const shelf = this.shelves.get(id), n = Math.min(MAX_TROPHIES, this.trophyCount.get(id) ?? 0);
    if (!shelf || !this.trophyTex || n === 0) return;
    const top = pieceMeta(shelf.piece).sz, made: Sprite[] = [];
    for (let i = 0; i < n; i++) {
      const s = this.put({ piece: 'Trophy', mx: shelf.mx, my: shelf.my - 0.3 + i * 0.2, view: 0, lift: top, z: 4 }, new Sprite(this.trophyTex));
      this.lighting.tint(s);
      made.push(s);
    }
    this.trophies.set(id, made);
  }

  /**
   * Room status badge above the nameplate (`… working`, `⏸ 1 waiting`, `✓ done`; null clears it). Drawn screen-aligned
   * and untinted so it stays readable at night, like the nameplates and the bot HUD.
   */
  setBadge(projectId: string, text: string | null): void {
    if (text) this.badgeText.set(projectId, text); else this.badgeText.delete(projectId);
    this.drawBadge(projectId);
  }

  /** Current badge text of a room (null when none), for screenshot checks. */
  badge(projectId: string): string | null { return this.badgeText.get(projectId) ?? null; }

  private drawBadge(id: string): void {
    this.badgeViews.get(id)?.destroy({ children: true });
    this.badgeViews.delete(id);
    const text = this.badgeText.get(id), plate = this.plates.get(id);
    if (!text || !plate) return;
    const color = text.startsWith('⏸') ? 0xffb35c : text.startsWith('✓') ? 0x9dff5c : plate.accent;
    const root = new Container({ zIndex: 1e6 });
    const t = new Text({
      // the low-res pixel font draws '…' as an underscore-like smudge; three dots read better
      text: text.replace('…', '...'), resolution: 1, anchor: 0.5,
      style: { fontFamily: PIXEL_FONT, fontSize: 11, fontWeight: 'bold', fill: lerpColor(color, 0xffffff, 0.35), letterSpacing: 1 },
    });
    t.scale.set(3);
    const w = t.width + 28, h = t.height + 12;
    const bg = new Graphics().roundRect(-w / 2, -h / 2, w, h, h / 2).fill({ color: 0x0f1320, alpha: 0.92 }).stroke({ color, width: 3 });
    root.addChild(bg, t);
    // the sign is skewed along the glass (slope 1/2): its top edge under the badge's right end is w/4 higher
    const plateTop = (plate.plate.height / 2) * 1.08 + (w / 4) * 1.08;
    root.position.set(plate.x, plate.y - plateTop - h / 2 - 6);
    this.world.addChild(root);
    this.lighting.untinted.add(root);
    this.badgeViews.set(id, root);
  }

  /** True when a canvas point is over the cafeteria cork board (tooltip with the latest tickets). */
  corkboardAt(sx: number, sy: number): boolean {
    return !!this.cork && !this.cork.destroyed && this.cork.getBounds().containsPoint(sx, sy);
  }

  /** Metre box of a room, or null. */
  roomBounds(id: string): Box | null {
    const r = this.layout?.rooms.find(x => x.id === id);
    return r ? { x0: r.x0, y0: r.y0, x1: r.x1, y1: r.y1 } : null;
  }

  /** Room id under a canvas point (project rooms, 'lounge', 'cafeteria' or 'hall'), or null outside the building. */
  roomAt(sx: number, sy: number): string | null {
    if (!this.layout) return null;
    const l = this.world.toLocal(new Point(sx, sy));
    const w = screenToWorld(l.x, l.y);
    return roomAtPoint(this.layout.rooms, w.mx, w.my);
  }

  /** Metre box of the whole building, for Camera.fit (Fit Building). */
  buildingBounds(): Box { return this.layout ? buildingBox(this.layout.rooms) : { x0: 0, y0: 0, x1: 26, y1: 8 }; }

  private update(t: Ticker): void {
    this.time += t.deltaMS / 1000;
    const s = this.selected ? this.plates.get(this.selected) : null;
    const b = this.selected ? this.badgeViews.get(this.selected) : undefined;
    const top = b && !b.destroyed ? Math.min(s ? s.y - 70 : 0, b.y - b.height / 2 - 40) : null;
    if (s && !this.eye.destroyed) this.eye.position.set(s.x, (top ?? s.y - 70) - Math.sin(this.time * 3) * 8);
  }
}
