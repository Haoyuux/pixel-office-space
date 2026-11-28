import { describe, it, expect } from 'vitest';
import { autoResume, AUTO_RESUME_MAX } from '../src/autoResume';

const failed = (n: number) => Array.from({ length: n }, () => ({ type: 'ticket.failed', reason: 'interrupted' }));

describe('autoResume', () => {
  it('resumes tickets a restart interrupted, up to AUTO_RESUME_MAX interruptions each', () => {
    const resumed: string[] = [];
    const events: Record<string, unknown[]> = {
      a: failed(1),
      b: [...failed(AUTO_RESUME_MAX), { type: 'ticket.failed', reason: 'boom' }],
      c: failed(AUTO_RESUME_MAX + 1),
    };
    const out = autoResume(['a', 'b', 'c', 'gone'], {
      find: id => (events[id] ? { events: events[id] as any } : undefined),
    }, { resume: id => { resumed.push(id); return {} as any; } });
    expect(resumed).toEqual(['a', 'b']);
    expect(out).toEqual(['a', 'b']);
  });

  it('a ticket that cannot be resumed is skipped, the rest still resume', () => {
    const resumed: string[] = [];
    const out = autoResume(['x', 'y'], { find: () => ({ events: failed(1) as any }) }, {
      resume: id => { if (id === 'x') throw new Error('Simulated tickets cannot be resumed'); resumed.push(id); return {} as any; },
    });
    expect(out).toEqual(['y']);
  });
});
