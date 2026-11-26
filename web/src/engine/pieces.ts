export interface PieceMeta { cat: string; w: number; h: number; sx: number; sy: number; sz: number; gx: number; gy: number; anim: number }

export function parsePieces(csv: string): Record<string, PieceMeta> {
  const out: Record<string, PieceMeta> = {};
  for (const line of csv.trim().split(/\r?\n/).slice(1)) {
    const [cat, piece, w, h, sx, sy, sz, gx, gy, anim] = line.split(',');
    out[piece] = { cat, w: +w, h: +h, sx: +sx, sy: +sy, sz: +sz, gx: +gx, gy: +gy, anim: +anim };
  }
  return out;
}

/** Floor footprint in metres along world x (w) and y (d) for a given view. */
export function footprint(p: PieceMeta, view: number): { w: number; d: number } {
  if (view % 2 === 1) { const m = Math.max(p.sx, p.sy); return { w: m, d: m }; }
  return view % 4 === 0 ? { w: p.sx, d: p.sy } : { w: p.sy, d: p.sx };
}
