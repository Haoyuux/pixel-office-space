import { AnimatedSprite, Container, Graphics, Rectangle, Text, type Texture } from 'pixi.js';
import type { Look, RoleId } from '@office/shared';
import { DIRS, dirFrom, iso, PZ, type Dir } from '../iso';
import { FEET_Y, FRAME_H, HIP_Y, SIT_H, SIT_HIP_Y, type CharacterSheets, type Clip } from '../assets';
import type { Spot } from '../layout/types';
import type { Pt, WalkGrid } from '../walkgrid';
import type { OfficeScene } from '../render/scene';
import { personalityOf, type Personality } from './personality';
import { botLabel, isEmote, type Emote, type Mood } from './mood';

/** Metres per second (spec §6.3). */
export const WALK_SPEED = 1.2;
/** Default hip height on a seat (office and dining chairs), metres; a spot's `seatHeight` overrides it. */
export const SEAT_LIFT = 0.42;
/** Pixi AnimatedSprite speeds from the approved prototype (frames per tick at 60 fps). */
const SPEED: Record<Clip, number> = { walk: 0.17, idle: 0.1, drinking: 0.1, waving: 0.1 };
const PIXEL_FONT = ['"Lucida Console"', '"Courier New"', 'monospace'];
/** Head height above the ground point, px (the 2x sheets: feet at 202, top of the hair ≈ 48). */
const HEAD_PX = FEET_Y - 48;
const DONE_BUBBLE_MS = 3000, FADE_MS = 600;
/** A mood emote shows this long, then fades. */
export const EMOTE_MS = 2600;

export type BubbleKind = '…' | '!' | '✗' | '✓' | '💬' | Emote;
const BUBBLE_COLOR: Record<BubbleKind, number> = {
  '…': 0x2b3550, '!': 0xd9821e, '✗': 0xc23b3b, '✓': 0x2f8f4e, '💬': 0x2b3550, '😄': 0x2b3550, '😤': 0x2b3550, '😮‍💨': 0x2b3550,
};

export interface BotOptions {
  id: string; // projectId:role
  projectId: string;
  role: RoleId;
  look: Look;
  sheets: CharacterSheets;
  grid: WalkGrid;
  at: { mx: number; my: number };
}

/** One office character: walks the walk grid, sits (synthesized seated pose), plays clips, shows a bubble and a hover label. */
export class Bot {
  readonly id: string;
  readonly projectId: string;
  readonly role: RoleId;
  /** Fixed per character name (office-life weights, hover label). */
  readonly personality: Personality | undefined;
  /** World sprite container (night-tinted). Origin = the ground point under the bot. */
  readonly view = new Container();
  /** Bubble and hover label (UI: not tinted, drawn above the building). */
  readonly hud = new Container({ zIndex: 1e6 + 2 });
  mx: number; my: number;
  dir: Dir = 'SW';
  seated = false;
  /** Hip height above the floor while seated, metres. */
  private seatLift = SEAT_LIFT;

  private sheets: CharacterSheets;
  private grid: WalkGrid;
  private scene: OfficeScene | null = null;
  private sprite: AnimatedSprite;
  private clip: Clip = 'idle';
  private path: Pt[] = [];
  private then: (() => void) | undefined;
  private label: Container;
  private bubbleBox = new Container();
  private bubbleKind: BubbleKind | null = null;
  private bubbleAge = 0;
  private character: string;
  private mood: Mood = 'neutral';

  constructor(o: BotOptions) {
    this.id = o.id; this.projectId = o.projectId; this.role = o.role;
    this.sheets = o.sheets; this.grid = o.grid;
    this.mx = o.at.mx; this.my = o.at.my;
    this.sprite = new AnimatedSprite(this.frames());
    this.sprite.anchor.set(0.5, FEET_Y / FRAME_H);
    this.view.addChild(this.sprite);

    this.character = o.look.character;
    this.personality = personalityOf(o.look.character);
    this.label = this.makeLabel(botLabel(this.character, o.role, this.personality, this.mood));
    this.label.visible = false;
    this.bubbleBox.visible = false;
    this.hud.addChild(this.bubbleBox, this.label);

    this.view.eventMode = 'static';
    this.view.cursor = 'pointer';
    this.view.hitArea = new Rectangle(-26, -HEAD_PX - 8, 52, HEAD_PX + 8);
    this.view.on('pointerover', () => { this.label.visible = true; this.place(); });
    this.view.on('pointerout', () => { this.label.visible = false; this.place(); });
    this.refresh();
    this.place();
  }

  get walking(): boolean { return this.path.length > 0; }
  /** The bubble on show (null = none). */
  get bubbleShown(): BubbleKind | null { return this.bubbleKind; }

  /** Mood face on the hover label. */
  setMood(mood: Mood): void {
    if (mood === this.mood || this.hud.destroyed) return;
    this.mood = mood;
    const visible = this.label.visible;
    this.label.destroy({ children: true });
    this.label = this.makeLabel(botLabel(this.character, this.role, this.personality, mood));
    this.label.visible = visible;
    this.hud.addChild(this.label);
    this.place();
  }

  /** A mood emote in the bubble, only when no other bubble is up (work bubbles always win); it fades by itself. */
  emote(kind: Emote): void {
    if (this.bubbleKind !== null || this.hud.destroyed) return;
    this.bubble(kind);
  }

  /** Adds the bot to the scene's world (kept across layout rebuilds); the sprite gets the night tint like the building. */
  attach(scene: OfficeScene): void {
    this.scene = scene;
    scene.keep(this.view);
    scene.keep(this.hud, { untinted: true });
  }

  destroy(): void {
    this.scene?.unkeep(this.view); this.scene?.unkeep(this.hud);
    this.scene = null;
    if (!this.view.destroyed) this.view.destroy({ children: true });
    if (!this.hud.destroyed) this.hud.destroy({ children: true });
  }

  /** The building changed: later walks use the new grid (rooms never move, so a walk in progress stays valid). */
  setGrid(grid: WalkGrid): void { this.grid = grid; }

  /** Walk to a spot (or point) along the walk grid, then call `then`. Stands up first if seated. */
  goTo(target: Spot | Pt, then?: () => void): void {
    if (this.seated) this.stand();
    const to = { mx: target.mx, my: target.my };
    const route = this.grid.path({ mx: this.mx, my: this.my }, to);
    // walk via the start and end cell centres too, so no leg cuts the corner of a blocked cell
    const near = (a: Pt, b: Pt) => Math.hypot(a.mx - b.mx, a.my - b.my) < 0.02;
    const pts = (route ?? []).filter((p, i, a) => !(i === 0 && near(p, this)) && !(i === a.length - 1 && near(p, to)));
    if (route || Math.hypot(to.mx - this.mx, to.my - this.my) < 0.01) pts.push(to);
    else { this.mx = to.mx; this.my = to.my; } // unreachable: never walk through walls, just appear there
    this.path = pts;
    this.then = then;
    if (this.path.length) this.play('walk');
    else { this.place(); this.arrive(); }
  }

  /** Sit at a seat spot: the seated pose (sitPose.ts) with the hips on the seat, facing the spot's facing. */
  sit(spot: Spot): void {
    this.path = []; this.then = undefined;
    this.mx = spot.mx; this.my = spot.my;
    this.dir = spot.facing;
    this.seated = true;
    this.seatLift = spot.seatHeight ?? SEAT_LIFT;
    if (this.clip !== 'drinking') this.clip = 'idle';
    this.refresh(); this.place();
  }

  stand(): void {
    if (!this.seated) return;
    this.seated = false;
    this.refresh(); this.place();
  }

  /** Seated bots only have idle and drinking sheets; anything else shows idle while seated. */
  play(clip: Clip): void {
    if (clip === this.clip) return;
    this.clip = clip;
    this.refresh();
  }

  face(dir: Dir): void {
    if (dir === this.dir) return;
    this.dir = dir;
    this.refresh();
  }

  bubble(kind: BubbleKind | null): void {
    if (kind === this.bubbleKind) return;
    this.bubbleKind = kind; this.bubbleAge = 0;
    this.bubbleBox.removeChildren().forEach(c => c.destroy());
    this.bubbleBox.visible = !!kind;
    this.bubbleBox.alpha = 1;
    if (!kind) return;
    // the 💬 glyph is a white emoji, so its bubble is dark; the status symbols sit on white
    const chat = kind === '💬' || isEmote(kind), bg = chat ? 0x2b3550 : 0xffffff;
    const t = new Text({ text: kind, resolution: 2, anchor: 0.5, style: { fontFamily: PIXEL_FONT, fontSize: chat ? 22 : 24, fontWeight: 'bold', fill: BUBBLE_COLOR[kind] } });
    const w = Math.max(38, t.width + 16), h = 34;
    const g = new Graphics()
      .roundRect(-w / 2, -h / 2, w, h, 9).fill(bg).stroke({ color: chat ? 0xdfe6ff : BUBBLE_COLOR[kind], width: 3 })
      .poly([-6, h / 2 - 1, 6, h / 2 - 1, 0, h / 2 + 8]).fill(bg);
    this.bubbleBox.addChild(g, t);
  }

  update(dtMs: number): void {
    if (this.view.destroyed) return;
    if (this.path.length) {
      let left = WALK_SPEED * dtMs / 1000;
      while (left > 0 && this.path.length) {
        const p = this.path[0], dx = p.mx - this.mx, dy = p.my - this.my, d = Math.hypot(dx, dy);
        if (d > 1e-6) this.face(dirFrom(dx, dy));
        if (d <= left) { this.mx = p.mx; this.my = p.my; left -= d; this.path.shift(); }
        else { this.mx += dx / d * left; this.my += dy / d * left; left = 0; }
      }
      this.place();
      if (!this.path.length) this.arrive();
    }
    if (this.bubbleKind === '✓' || isEmote(this.bubbleKind)) {
      const hold = this.bubbleKind === '✓' ? DONE_BUBBLE_MS : EMOTE_MS;
      this.bubbleAge += dtMs;
      if (this.bubbleAge > hold) this.bubbleBox.alpha = Math.max(0, 1 - (this.bubbleAge - hold) / FADE_MS);
      if (this.bubbleAge > hold + FADE_MS) this.bubble(null);
    }
  }

  // ---------------------------------------------------------------------------------------------

  private arrive(): void {
    if (this.clip === 'walk') this.play('idle');
    const cb = this.then; this.then = undefined;
    cb?.();
  }

  private frames(): Texture[] {
    const d = DIRS.indexOf(this.dir);
    if (this.seated) return this.sheets.sit[this.clip === 'drinking' ? 'drinking' : 'idle'][d];
    return this.sheets.clips[this.clip][d];
  }

  /** Swap textures for the current clip/direction/pose, keeping the frame index when only the direction changed. */
  private refresh(): void {
    const s = this.sprite, frame = s.currentFrame, sameLen = s.textures.length;
    const tex = this.frames();
    s.textures = tex;
    s.animationSpeed = SPEED[this.seated && this.clip !== 'drinking' ? 'idle' : this.clip];
    s.anchor.set(0.5, this.seated ? SIT_HIP_Y / SIT_H : FEET_Y / FRAME_H);
    s.position.set(0, this.seated ? -Math.round(this.seatLift * PZ) : 0);
    s.loop = true;
    s.gotoAndPlay(tex.length === sameLen ? frame % tex.length : 0);
  }

  private place(): void {
    const p = iso(this.mx, this.my);
    this.view.position.set(p.x, p.y);
    this.view.zIndex = p.y + 1;
    // seated, the hips are at the seat height instead of the standing hip height
    const head = HEAD_PX + (this.seated ? Math.round(this.seatLift * PZ) - (FEET_Y - HIP_Y) : 0);
    this.hud.position.set(p.x, p.y - head);
    this.label.position.set(0, -20);
    this.bubbleBox.position.set(0, this.label.visible ? -62 : -28);
  }

  private makeLabel(text: string): Container {
    const c = new Container();
    const t = new Text({ text, resolution: 1, anchor: 0.5, style: { fontFamily: PIXEL_FONT, fontSize: 11, fontWeight: 'bold', fill: 0xf2f4ff, letterSpacing: 1 } });
    t.scale.set(2);
    const w = t.width + 16, h = t.height + 8;
    const g = new Graphics().roundRect(-w / 2, -h / 2, w, h, 5).fill({ color: 0x141826, alpha: 0.88 }).stroke({ color: 0x5fb8ff, width: 2 });
    c.addChild(g, t);
    return c;
  }
}
