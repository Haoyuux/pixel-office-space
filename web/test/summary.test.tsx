// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import type { Project, Summary } from '@office/shared';
import { useOffice, resetOffice } from '../src/state/store';
import { SummaryPanel, autoOpenSince, checkDailySummary, hasNews, recordVisit, resetVisit, LAST_VISIT_KEY } from '../src/ui/Summary';
import { Toolbar } from '../src/ui/Toolbar';

const P: Project = { id: 'p', name: 'Shop', folder: '.', accent: 'magenta', team: ['pm'], slot: 0, looks: {} as Project['looks'], createdAt: '' };
const usage = { turns: 12, costUsd: 0.84, durationMs: 6 * 60000 };
const SUM: Summary = {
  since: '2026-11-26T18:00:00.000Z',
  projects: [
    { projectId: 'q', name: 'Blog', finished: 0, failed: 0, answered: 0, waiting: [], items: [], usage: { turns: 0, costUsd: 0, durationMs: 0 } },
    {
      projectId: 'p', name: 'Shop', finished: 2, failed: 1, answered: 1,
      waiting: [{ ticketId: 't9', rootId: 'r9', title: 'Add checkout', gate: 'plan' }],
      items: [
        { ticketId: 't1', rootId: 'r1', title: 'Fix login', kind: 'ticket', status: 'done', at: '2026-11-27T08:00:00.000Z' },
        { ticketId: 't2', rootId: 'r2', title: 'Why is it slow?', kind: 'chat', status: 'done', at: '2026-11-27T08:30:00.000Z' },
      ],
      usage,
    },
  ],
  totals: { finished: 2, failed: 1, answered: 1, waiting: 1, usage },
};
const EMPTY: Summary = { since: SUM.since, projects: [SUM.projects[0]], totals: { finished: 0, failed: 0, answered: 0, waiting: 0, usage: { turns: 0, costUsd: 0, durationMs: 0 } } };

let calls: string[];
let body: Summary;
const mem = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, m }; };

beforeEach(() => {
  resetOffice(); resetVisit();
  useOffice.setState({ projects: { p: P }, synced: true });
  calls = []; body = SUM;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    calls.push(url);
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('daily auto-open', () => {
  const now = new Date(2026, 10, 27, 9, 0);
  it('recordVisit returns the previous visit and stores now (once per page load)', () => {
    const s = mem();
    expect(recordVisit(now, s)).toBeNull();
    expect(s.m.get(LAST_VISIT_KEY)).toBe(now.toISOString());
    resetVisit();
    s.setItem(LAST_VISIT_KEY, '2026-11-26T10:00:00.000Z');
    expect(recordVisit(now, s)).toBe('2026-11-26T10:00:00.000Z');
    expect(recordVisit(now, s)).toBe('2026-11-26T10:00:00.000Z');
  });
  it('autoOpenSince: only on the first visit of a calendar day', () => {
    expect(autoOpenSince(null, now)).toBeNull();
    expect(autoOpenSince(new Date(2026, 10, 27, 7, 0).toISOString(), now)).toBeNull();
    const yesterday = new Date(2026, 10, 26, 22, 0).toISOString();
    expect(autoOpenSince(yesterday, now)).toBe(yesterday);
  });
  it('hasNews: anything finished, failed, answered, waiting or recent', () => {
    expect(hasNews(SUM)).toBe(true);
    expect(hasNews(EMPTY)).toBe(false);
    expect(hasNews(null)).toBe(false);
  });
  it('checkDailySummary fetches since the last visit and opens only when there is news', async () => {
    const yesterday = new Date(2026, 10, 26, 22, 0).toISOString();
    localStorage.setItem(LAST_VISIT_KEY, yesterday);
    const open = vi.fn();
    await checkDailySummary(open, now);
    expect(calls).toEqual([`/api/summary?since=${encodeURIComponent(yesterday)}`]);
    expect(open).toHaveBeenCalledWith(yesterday);
    resetVisit(); body = EMPTY; open.mockClear();
    localStorage.setItem(LAST_VISIT_KEY, yesterday);
    await checkDailySummary(open, now);
    expect(open).not.toHaveBeenCalled();
  });
  it('same day or first visit ever: no fetch', async () => {
    const open = vi.fn();
    localStorage.removeItem(LAST_VISIT_KEY);
    await checkDailySummary(open, now);
    resetVisit();
    await checkDailySummary(open, new Date(now.getTime() + 3600000));
    expect(calls).toEqual([]);
    expect(open).not.toHaveBeenCalled();
  });
});

describe('SummaryPanel', () => {
  it('per-project cards: counts, waiting first, recent items, usage; empty projects hidden', async () => {
    render(<SummaryPanel since={SUM.since} onClose={() => {}} />);
    const card = await screen.findByRole('region', { name: /shop summary/i });
    expect(calls[0]).toBe(`/api/summary?since=${encodeURIComponent(SUM.since)}`);
    expect(card.textContent).toContain('✓ 2 finished');
    expect(card.textContent).toContain('💬 1 answered');
    expect(card.textContent).toContain('✕ 1 failed');
    expect(card.textContent).toContain('⏸ 1 waiting');
    const lists = within(card).getAllByRole('list');
    expect(lists[0].getAttribute('aria-label')).toBe('Waiting for you');
    expect(lists[0].textContent).toContain('Add checkout');
    expect(lists[0].textContent).toContain('approve the plan');
    expect(lists[1].textContent).toContain('Fix login');
    expect(lists[1].textContent).toContain('answered');
    expect(card.textContent).toMatch(/uses your Claude plan \(≈\$0\.84 at API rates, not charged\)/);
    expect(screen.queryByRole('region', { name: /blog summary/i })).toBeNull();
  });

  it('clicking a waiting item opens that conversation and closes the panel', async () => {
    const onClose = vi.fn();
    render(<SummaryPanel since={SUM.since} onClose={onClose} />);
    fireEvent.click(await screen.findByRole('button', { name: /add checkout/i }));
    expect(onClose).toHaveBeenCalled();
    expect(useOffice.getState().selectedProjectId).toBe('p');
    expect(useOffice.getState().openRequest).toMatchObject({ projectId: 'p', rootId: 'r9' });
  });

  it('nothing in range: says so; the range buttons refetch', async () => {
    body = EMPTY;
    render(<SummaryPanel onClose={() => {}} />);
    expect(await screen.findByText(/nothing happened/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '7 days' }));
    await waitFor(() => expect(calls).toHaveLength(2));
    const since = new URL(calls[1], 'http://x').searchParams.get('since')!;
    expect(Date.now() - Date.parse(since)).toBeGreaterThan(6.9 * 86400000);
  });
});

describe('📋 Summary toolbar button', () => {
  it('opens the summary', () => {
    const onSummary = vi.fn();
    render(<Toolbar onFit={() => {}} onSummary={onSummary} />);
    fireEvent.click(screen.getByRole('button', { name: /summary/i }));
    expect(onSummary).toHaveBeenCalled();
  });
});
