/** Longest frame step we simulate; a stalled tab should not teleport bots through furniture. */
export const MAX_DT = 250;

/**
 * Simulation time in ms that only advances by clamped frame steps. Office life reads it instead of wall time, so
 * a long gap (hidden tab, breakpoint) moves every timer by at most MAX_DT and the bots stay staggered.
 */
export class SimClock {
  private t = 0;
  /** Advance by one frame; returns the clamped step actually taken. */
  step(dtMs: number): number {
    const d = Math.max(0, Math.min(MAX_DT, dtMs));
    this.t += d;
    return d;
  }
  readonly now = (): number => this.t;
}
