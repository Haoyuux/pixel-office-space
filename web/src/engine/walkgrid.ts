import type { BuildingLayout } from './layout/types';
import { footprint, type PieceMeta } from './pieces';

export interface Pt { mx: number; my: number }

/** Min-heap of (key, node) pairs; keys are snapshotted at push time. */
class Heap {
  private keys: number[] = [];
  private nodes: number[] = [];
  get size() { return this.nodes.length; }
  push(node: number, key: number) {
    const k = this.keys, a = this.nodes;
    let i = a.length;
    k.push(key); a.push(node);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= k[i]) break;
      [k[p], k[i]] = [k[i], k[p]]; [a[p], a[i]] = [a[i], a[p]]; i = p;
    }
  }
  pop(): number {
    const k = this.keys, a = this.nodes, top = a[0];
    const lk = k.pop()!, ln = a.pop()!;
    if (a.length) {
      k[0] = lk; a[0] = ln;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && k[l] < k[m]) m = l;
        if (r < a.length && k[r] < k[m]) m = r;
        if (m === i) break;
        [k[m], k[i]] = [k[i], k[m]]; [a[m], a[i]] = [a[i], a[m]]; i = m;
      }
    }
    return top;
  }
}

const DIRS: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

export class WalkGrid {
  private ox: number; private oy: number; private cols: number; private rows: number;
  private open: Uint8Array;
  /** wall on the edge between a cell and its east (wallE) / south (wallS) neighbour */
  private wallE: Uint8Array; private wallS: Uint8Array;

  constructor(layout: BuildingLayout, meta: Record<string, PieceMeta>, private cell = 0.5) {
    const b = layout.bounds, c = cell, eps = 1e-6;
    this.ox = Math.floor(b.x0 / c) * c; this.oy = Math.floor(b.y0 / c) * c;
    this.cols = Math.ceil((b.x1 - this.ox) / c); this.rows = Math.ceil((b.y1 - this.oy) / c);
    const n = this.cols * this.rows;
    this.open = new Uint8Array(n); this.wallE = new Uint8Array(n); this.wallS = new Uint8Array(n);

    // walkable = union of floor rects
    for (let r = 0; r < this.rows; r++) for (let q = 0; q < this.cols; q++) {
      const x = this.ox + (q + 0.5) * c, y = this.oy + (r + 0.5) * c;
      if (layout.rooms.some(m => x > m.x0 && x < m.x1 && y > m.y0 && y < m.y1)) this.open[r * this.cols + q] = 1;
    }
    // furniture footprints (floor/wall/glass modules and items sitting on furniture are not obstacles)
    for (const p of layout.pieces) {
      if (p.lift && p.lift > 0) continue;
      if (p.tag === 'floor' || p.tag === 'wall' || p.tag === 'glass') continue;
      const m = meta[p.piece];
      if (!m) continue;
      const f = footprint(m, p.view);
      const q0 = Math.floor((p.mx - f.w / 2 - this.ox) / c + eps), q1 = Math.ceil((p.mx + f.w / 2 - this.ox) / c - eps) - 1;
      const r0 = Math.floor((p.my - f.d / 2 - this.oy) / c + eps), r1 = Math.ceil((p.my + f.d / 2 - this.oy) / c - eps) - 1;
      for (let r = r0; r <= r1; r++) for (let q = q0; q <= q1; q++) {
        if (q < 0 || r < 0 || q >= this.cols || r >= this.rows) continue;
        const x = this.ox + (q + 0.5) * c, y = this.oy + (r + 0.5) * c;
        if (Math.abs(x - p.mx) < f.w / 2 && Math.abs(y - p.my) < f.d / 2) this.open[r * this.cols + q] = 0;
      }
    }
    // walls and glass as edge blockers; door openings are already gaps in the segment list
    for (const s of layout.walls) {
      if (s.x0 === s.x1) {
        const q = Math.round((s.x0 - this.ox) / c) - 1;
        const lo = Math.min(s.y0, s.y1), hi = Math.max(s.y0, s.y1);
        if (q < 0 || q >= this.cols - 1) continue;
        for (let r = 0; r < this.rows; r++) {
          const y = this.oy + (r + 0.5) * c;
          if (y > lo && y < hi) this.wallE[r * this.cols + q] = 1;
        }
      } else if (s.y0 === s.y1) {
        const r = Math.round((s.y0 - this.oy) / c) - 1;
        const lo = Math.min(s.x0, s.x1), hi = Math.max(s.x0, s.x1);
        if (r < 0 || r >= this.rows - 1) continue;
        for (let q = 0; q < this.cols; q++) {
          const x = this.ox + (q + 0.5) * c;
          if (x > lo && x < hi) this.wallS[r * this.cols + q] = 1;
        }
      }
    }
    // spots are always reachable (sit spots lie on chairs inside furniture)
    for (const s of layout.spots) {
      const i = this.idx(s.mx, s.my);
      if (i >= 0) this.open[i] = 1;
    }
  }

  private idx(mx: number, my: number): number {
    const q = Math.floor((mx - this.ox) / this.cell), r = Math.floor((my - this.oy) / this.cell);
    return q < 0 || r < 0 || q >= this.cols || r >= this.rows ? -1 : r * this.cols + q;
  }

  walkable(mx: number, my: number): boolean {
    const i = this.idx(mx, my);
    return i >= 0 && this.open[i] === 1;
  }

  /** Orthogonal step from (q,r) by one cell; checks target openness and the wall on the shared edge. */
  private ortho(q: number, r: number, dq: number, dr: number): boolean {
    const nq = q + dq, nr = r + dr, W = this.cols;
    if (nq < 0 || nr < 0 || nq >= W || nr >= this.rows || !this.open[nr * W + nq]) return false;
    if (dr === 0) return !(dq > 0 ? this.wallE[r * W + q] : this.wallE[r * W + nq]);
    return !(dr > 0 ? this.wallS[r * W + q] : this.wallS[nr * W + q]);
  }

  private canStep(q: number, r: number, dq: number, dr: number): boolean {
    if (dq === 0 || dr === 0) return this.ortho(q, r, dq, dr);
    // diagonal: never cut a blocked corner, so both L-shaped routes must be clear
    return this.ortho(q, r, dq, 0) && this.ortho(q + dq, r, 0, dr)
      && this.ortho(q, r, 0, dr) && this.ortho(q, r + dr, dq, 0);
  }

  path(from: Pt, to: Pt): Pt[] | null {
    const s = this.idx(from.mx, from.my), t = this.idx(to.mx, to.my);
    if (s < 0 || t < 0) return null;
    const W = this.cols, n = W * this.rows;
    const g = new Float64Array(n).fill(Infinity);
    const prev = new Int32Array(n).fill(-1), closed = new Uint8Array(n);
    const tq = t % W, tr = (t / W) | 0;
    const h = (q: number, r: number) => {
      const dx = Math.abs(q - tq), dy = Math.abs(r - tr);
      return Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy);
    };
    const heap = new Heap();
    g[s] = 0; heap.push(s, h(s % W, (s / W) | 0));
    while (heap.size) {
      const i = heap.pop();
      if (closed[i]) continue;
      if (i === t) break;
      closed[i] = 1;
      const q = i % W, r = (i / W) | 0;
      for (const [dq, dr] of DIRS) {
        if (!this.canStep(q, r, dq, dr)) continue;
        const j = (r + dr) * W + q + dq;
        if (closed[j]) continue;
        const ng = g[i] + (dq && dr ? Math.SQRT2 : 1);
        if (ng < g[j]) { g[j] = ng; prev[j] = i; heap.push(j, ng + h(q + dq, r + dr)); }
      }
    }
    if (s !== t && prev[t] < 0) return null;
    const cells: number[] = [];
    for (let i = t; i >= 0; i = prev[i]) { cells.push(i); if (i === s) break; }
    cells.reverse();
    const pts = cells.map(i => ({ mx: this.ox + ((i % W) + 0.5) * this.cell, my: this.oy + (((i / W) | 0) + 0.5) * this.cell }));
    // drop collinear points
    const out: Pt[] = [];
    for (let k = 0; k < pts.length; k++) {
      if (k > 0 && k < pts.length - 1) {
        const a = pts[k - 1], b = pts[k], c = pts[k + 1];
        if (Math.abs((b.mx - a.mx) * (c.my - b.my) - (b.my - a.my) * (c.mx - b.mx)) < 1e-9) continue;
      }
      out.push(pts[k]);
    }
    return out;
  }
}
