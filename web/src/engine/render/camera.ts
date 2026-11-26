import type { Application, Container } from 'pixi.js';
import { fitTransform, screenBox, zoomAround, type Box } from './geom';

/** Drag to pan, wheel to zoom around the cursor (0.2×–2×), fit a metre box into view. */
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

  /** Frame a metre box (walls included) with a margin. */
  fit(bounds: Box): void {
    this.set(fitTransform(screenBox(bounds), this.app.screen.width, this.app.screen.height, 48));
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
      this.zoomAt(p.x, p.y, e.deltaY < 0 ? 1.15 : 1 / 1.15);
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
