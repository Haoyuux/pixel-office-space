import { Assets, Rectangle, Texture, TextureSource } from 'pixi.js';
import type { Look } from '@office/shared';
import { DIRS } from './iso';
import { parsePieces, type PieceMeta } from './pieces';
import { NEON_META, neonUrl } from './neon';
import { ART, SIT_BOX, sitSheet, type Px } from './sitPose';

TextureSource.defaultOptions.scaleMode = 'nearest';

const PROPS = '/assets/office/Isometric_Pixel_Props';
const CHARS = '/assets/characters/OfficeCharacters_Basic_v1.0/characters';

let pieces: Record<string, PieceMeta> | null = null;
export async function loadPieceMeta(): Promise<Record<string, PieceMeta>> {
  // NEON OFFICE props share the table (frame, pivot, footprint), so the walk grid and the renderer treat them alike.
  if (!pieces) pieces = { ...parsePieces(await (await fetch(`${PROPS}/pieces.csv`)).text()), ...NEON_META };
  return pieces;
}
export const pieceMeta = (name: string): PieceMeta => {
  if (!pieces) throw new Error('loadPieceMeta() first');
  const m = pieces[name];
  if (!m) throw new Error(`Unknown piece ${name}`);
  return m;
};

// One promise per URL: concurrent Assets.load of the same URL hung in the spike.
const cache = new Map<string, Promise<Texture>>();
const load = (url: string) => { if (!cache.has(url)) cache.set(url, Assets.load<Texture>(url)); return cache.get(url)!; };

/** A still texture, or 16 animation frames when the piece is animated and `animated` is true. */
export async function loadPiece(name: string, view: number, animated = false): Promise<Texture | Texture[]> {
  const m = pieceMeta(name);
  const dir = `${PROPS}/${m.cat}/${name}`;
  if (animated && m.anim) {
    const strip = await load(`${dir}/anim/${name}_${view}_16frames.png`);
    return Array.from({ length: m.anim }, (_, i) => new Texture({ source: strip.source, frame: new Rectangle(i * m.w, 0, m.w, m.h) }));
  }
  return load(`${dir}/sprites/${name}_${view}.png`);
}

/** A NEON OFFICE prop's lit sprite, or its additive glow layer. */
export const loadNeon = (prop: string, variant: string, glow = false): Promise<Texture> => load(neonUrl(prop, variant, glow));

export type Clip = 'idle' | 'walk' | 'drinking' | 'waving';
export const CLIP_FRAMES: Record<Clip, number> = { idle: 4, walk: 8, drinking: 8, waving: 6 };
export const FRAME_W = 168, FRAME_H = 248, FEET_Y = 202, HIP_Y = 172;
const K = FRAME_W / ART.w;
/** Seated frames (sitPose.ts): a crop of the pack's frame, centred on x; the hip line at SIT_HIP_Y. */
export const SIT_W = SIT_BOX.w * K, SIT_H = SIT_BOX.h * K, SIT_HIP_Y = HIP_Y - SIT_BOX.y * K;

export interface CharacterSheets {
  clips: Record<Clip, Texture[][]>;      // [dirIndex][frame]
  /** Seated pose synthesized from the standing sheets (sitPose.ts): SIT_W × SIT_H frames, the hip at SIT_HIP_Y. */
  sit: Record<'idle' | 'drinking', Texture[][]>;
}

/** The sheet's pixels (the loaded image drawn to a canvas). */
function pixels(tex: Texture): Px {
  const src = tex.source, w = src.pixelWidth, h = src.pixelHeight;
  const ctx = canvas(w, h).getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(src.resource as CanvasImageSource, 0, 0);
  return ctx.getImageData(0, 0, w, h);
}
function canvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

const sheetCache = new Map<string, Promise<CharacterSheets>>();
export function loadCharacter(look: Look): Promise<CharacterSheets> {
  const key = `${look.character}/${look.palette}`;
  if (!sheetCache.has(key)) sheetCache.set(key, (async () => {
    const slice = (tex: Texture, n: number, w = FRAME_W, h = FRAME_H) =>
      DIRS.map((_, r) => Array.from({ length: n }, (_, i) => new Texture({ source: tex.source, frame: new Rectangle(i * w, r * h, w, h) })));
    const clips = {} as Record<Clip, Texture[][]>;
    const raw = {} as Record<Clip, Texture>;
    for (const clip of Object.keys(CLIP_FRAMES) as Clip[]) {
      raw[clip] = await load(`${CHARS}/${look.character}/${look.palette}/2x/${clip}.png`);
      clips[clip] = slice(raw[clip], CLIP_FRAMES[clip]);
    }
    // seated frames: torso of each idle/drinking frame over legs bent from idle frame 0 (legs stay still)
    const idle = pixels(raw.idle);
    const sit = {} as Record<'idle' | 'drinking', Texture[][]>;
    for (const clip of ['idle', 'drinking'] as const) {
      const img = sitSheet(clip === 'idle' ? idle : pixels(raw[clip]), idle, CLIP_FRAMES[clip], DIRS, K);
      const c = canvas(img.width, img.height);
      const ctx = c.getContext('2d')!, data = ctx.createImageData(img.width, img.height);
      data.data.set(img.data);
      ctx.putImageData(data, 0, 0);
      sit[clip] = slice(Texture.from(c), CLIP_FRAMES[clip], SIT_W, SIT_H);
    }
    return { clips, sit };
  })());
  return sheetCache.get(key)!;
}
