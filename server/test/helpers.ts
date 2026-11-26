import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const tmp = (prefix = 'office-') => mkdtempSync(join(tmpdir(), prefix));
export const projectDir = (name = 'proj') => { const d = join(tmp(), name); mkdirSync(d, { recursive: true }); return d; };

export class ManualScheduler {
  private q: { at: number; fn: () => void; dead: boolean }[] = [];
  now = 0;
  after(ms: number, fn: () => void) {
    const e = { at: this.now + ms, fn, dead: false };
    this.q.push(e);
    return () => { e.dead = true; };
  }
  flush() {
    let guard = 0;
    while (this.q.some(e => !e.dead) && guard++ < 100000) {
      this.q.sort((a, b) => a.at - b.at);
      const e = this.q.shift()!;
      if (e.dead) continue;
      this.now = e.at;
      e.fn();
    }
  }
}

