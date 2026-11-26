import type { Application, Container } from 'pixi.js';
import { fitTransform, screenBox, wheelFactor, zoomAround, ZOOM_MAX, ZOOM_MIN, type Box } from './geom';

/** Drag to pan, wheel to zoom around the cursor (ZOOM_MIN–ZOOM_MAX, by the wheel delta), fit a metre box into view. */
export class Camera {
  /** True when the last pointer press moved far enough to count as a drag (callers ignore the click then). */
  dragged = false;
  private drag: { x: number; y: number; sx: number; sy: number } | null = null;
  private detach: (() => void) | null = null;

  constructor(private app: Application, private world: Container) {}

  get scale() { return this.world.scale.x; }

  private set(t: { scale: number; x: number; y: number }) {
    this.world.scale.set(t.scale);
    this.world.position.set(Math.round(t.x), Math.round(t.y));
  }

  /** Frame a metre box (walls included) with a margin; `insetRight` px on the right are covered (the drawer). */
  fit(bounds: Box, insetRight = 0): void {
    this.set(fitTransform(screenBox(bounds), Math.max(200, this.app.screen.width - insetRight), this.app.screen.height, 48));
  }

  /** Pans (no zoom change) the least needed so a metre box is on screen, left of `insetRight` px covered on the right. */
  reveal(bounds: Box, insetRight = 0, margin = 24): void {
    const sb = screenBox(bounds);
    const vw = Math.max(200, this.app.screen.width - insetRight), vh = this.app.screen.height;
    // too big at this zoom: zoom out until it fits (never zoom in)
    const fit = fitTransform(sb, vw, vh, margin);
    if (fit.scale < this.scale) { this.set(fit); return; }
    const k = this.scale;
    const x0 = sb.x0 * k + this.world.x, x1 = sb.x1 * k + this.world.x, y0 = sb.y0 * k + this.world.y, y1 = sb.y1 * k + this.world.y;
    const shift = (a: number, b: number, size: number) => b - a > size - 2 * margin ? (size - a - b) / 2 : a < margin ? margin - a : b > size - margin ? size - margin - b : 0;
    const dx = shift(x0, x1, vw), dy = shift(y0, y1, vh);
    if (dx || dy) this.set({ scale: k, x: this.world.x + dx, y: this.world.y + dy });
  }

  /** Zoom by `factor` keeping the canvas point (cx, cy) fixed. */
  zoomAt(cx: number, cy: number, factor: number): void {
    this.set(zoomAround({ scale: this.scale, x: this.world.x, y: this.world.y }, cx, cy, factor));
  }

  attach(canvas: HTMLCanvasElement): void {
    this.detach?.();
    const local = (e: { clientX: number; clientY: number }) => {
      const r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const down = (e: PointerEvent) => {
      if (e.button !== 0) return;
      this.dragged = false;
      this.drag = { x: e.clientX - this.world.x, y: e.clientY - this.world.y, sx: e.clientX, sy: e.clientY };
    };
    const move = (e: PointerEvent) => {
      if (!this.drag) return;
      if (Math.hypot(e.clientX - this.drag.sx, e.clientY - this.drag.sy) > 4) this.dragged = true;
      if (this.dragged) this.world.position.set(e.clientX - this.drag.x, e.clientY - this.drag.y);
    };
    const up = () => { this.drag = null; };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const p = local(e);
      this.zoomAt(p.x, p.y, wheelFactor(e.deltaY, e.deltaMode));
    };
    canvas.addEventListener('pointerdown', down);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    canvas.addEventListener('wheel', wheel, { passive: false });
    this.detach = () => {
      canvas.removeEventListener('pointerdown', down);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      canvas.removeEventListener('wheel', wheel);
    };
  }

  destroy(): void { this.detach?.(); this.detach = null; }
}
