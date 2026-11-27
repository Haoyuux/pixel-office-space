import { describe, it, expect } from 'vitest';
import type { Ticket } from '@office/shared';
import { rootOf, threadOf, threadsOf } from '../src/ui/threads';

const t = (id: string, createdAt: string, o: Partial<Ticket> = {}): Ticket =>
  ({ id, projectId: 'p', title: id, text: id, status: 'done', stage: 'done', agentStates: {}, createdAt, ...o });
const map = (...ts: Ticket[]) => Object.fromEntries(ts.map(x => [x.id, x]));

describe('threads', () => {
  const a = t('a', '2026-11-26T10:00:00Z', { text: 'What is login?\nbe brief' });
  const b = t('b', '2026-11-26T10:05:00Z', { parentTicketId: 'a' });
  const c = t('c', '2026-11-26T10:09:00Z', { parentTicketId: 'b', status: 'running' });
  const x = t('x', '2026-11-26T10:07:00Z');
  const all = map(c, x, a, b);

  it('rootOf follows parentTicketId to the root; unknown or missing parents stop there', () => {
    expect(rootOf('c', all)).toBe('a');
    expect(rootOf('b', all)).toBe('a');
    expect(rootOf('a', all)).toBe('a');
    expect(rootOf('x', all)).toBe('x');
    expect(rootOf('o', map(t('o', '2026-11-26T09:00:00Z', { parentTicketId: 'gone' })))).toBe('o');
  });

  it('rootOf survives a cycle', () => {
    const loop = map(t('m', '1', { parentTicketId: 'n' }), t('n', '2', { parentTicketId: 'm' }));
    expect(['m', 'n']).toContain(rootOf('m', loop));
  });

  it('threadOf lists the thread oldest → newest', () => {
    expect(threadOf('a', all).map(z => z.id)).toEqual(['a', 'b', 'c']);
    expect(threadOf('x', all).map(z => z.id)).toEqual(['x']);
    expect(threadOf('nope', all)).toEqual([]);
  });

  it('threadsOf: one entry per root, latest activity first',() => {
    const th = threadsOf('p', { ...all, q: t('q', '2026-11-26T11:00:00Z', { projectId: 'other' }) });
    expect(th.map(z => z.root.id)).toEqual(['a', 'x']);
    expect(th[0].latest.id).toBe('c');
    expect(th[0].tickets).toHaveLength(3);
  });
});
