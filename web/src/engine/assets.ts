import { Assets, Rectangle, Texture, TextureSource } from 'pixi.js';
import type { Look } from '@office/shared';
import { DIRS } from './iso';
import { parsePieces, type PieceMeta } from './pieces';
import { NEON_META, neonUrl } from './neon';

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

export interface CharacterSheets {
  clips: Record<Clip, Texture[][]>;      // [dirIndex][frame]
  sit: Record<'idle' | 'drinking', Texture[][]>; // cropped at the hip line
}

const sheetCache = new Map<string, Promise<CharacterSheets>>();
export function loadCharacter(look: Look): Promise<CharacterSheets> {
  const key = `${look.character}/${look.palette}`;
  if (!sheetCache.has(key)) sheetCache.set(key, (async () => {
    const slice = (tex: Texture, n: number, h: number) =>
      DIRS.map((_, r) => Array.from({ length: n }, (_, i) => new Texture({ source: tex.source, frame: new Rectangle(i * FRAME_W, r * FRAME_H, FRAME_W, h) })));
    const clips = {} as Record<Clip, Texture[][]>;
    const sit = {} as Record<'idle' | 'drinking', Texture[][]>;
    for (const clip of Object.keys(CLIP_FRAMES) as Clip[]) {
      const tex = await load(`${CHARS}/${look.character}/${look.palette}/2x/${clip}.png`);
      clips[clip] = slice(tex, CLIP_FRAMES[clip], FRAME_H);
      if (clip === 'idle' || clip === 'drinking') sit[clip] = slice(tex, CLIP_FRAMES[clip], HIP_Y);
    }
    return { clips, sit };
  })());
  return sheetCache.get(key)!;
}
