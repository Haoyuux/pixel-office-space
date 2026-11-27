// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';
import type { Project, Ticket } from '@office/shared';
import { useOffice, resetOffice } from '../src/state/store';
import { Drawer } from '../src/ui/Drawer';

const P: Project = { id: 'p', name: 'Shop', folder: '.', accent: 'cyan', team: ['pm', 'frontend'], slot: 0, looks: {} as Project['looks'], createdAt: '' };
const tk = (id: string, o: Partial<Ticket> = {}): Ticket =>
  ({ id, projectId: 'p', title: id, text: id, status: 'done', stage: 'done', agentStates: {}, createdAt: '2026-11-26T10:00:00Z', ...o });

type Call = { url: string; method: string; body: unknown };
let calls: Call[];
let reply: (url: string, method: string, body: unknown) => { status: number; body: unknown } | undefined;
const SYS = { found: true, version: '2', loggedIn: true, accountType: 'pro', signInEndsAt: null };

beforeEach(() => {
  resetOffice();
  calls = [];
  reply = () => undefined;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method: init?.method ?? 'GET', body });
    const r = reply(url, init?.method ?? 'GET', body)
      ?? (url === '/api/system/claude' ? { status: 200, body: SYS } : { status: 200, body: { ok: true } });
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'Content-Type': 'application/json' } });
  }));
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

const posts = () => calls.filter(c => c.method !== 'GET');
const open = (tickets: Ticket[], extra: Partial<ReturnType<typeof useOffice.getState>> = {}) => {
  useOffice.setState({ projects: { p: P }, tickets: Object.fromEntries(tickets.map(t => [t.id, t])), selectedProjectId: 'p', synced: true, ...extra });
  return render(<Drawer projectId="p" />);
};
const box = () => screen.getByRole('textbox', { name: /message/i }) as HTMLTextAreaElement;

describe('streaming, thinking, stop', () => {
  const RUN = tk('c', { text: 'What does Save do?', status: 'running', stage: 'plan', mode: 'ask', createdAt: '2026-11-26T10:00:00Z' });

  it('shows "Thinking… Ns" while the open conversation runs, counting up', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(new Date('2026-11-26T10:00:12Z'));
    open([RUN]);
    expect(screen.getByRole('status', { name: /working/i }).textContent).toMatch(/Thinking… 12s/);
    act(() => { vi.advanceTimersByTime(3000); });
    expect(screen.getByRole('status', { name: /working/i }).textContent).toMatch(/Thinking… 15s/);
  });

  it('no thinking indicator or Stop when nothing runs', () => {
    open([tk('a', { mode: 'ask', answered: true })]);
    expect(screen.queryByRole('status', { name: /working/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /stop/i })).toBeNull();
  });

  it('streaming text shows the typing cursor', () => {
    open([RUN], { feed: { c: [{ kind: 'message', role: 'pm', text: 'It sav', id: 'm', ts: RUN.createdAt, status: 'streaming' }] } });
    expect(screen.getByText('It sav')).toBeTruthy();
    expect(document.querySelector('.po-cursor')).toBeTruthy();
  });

  it('■ Stop posts /api/tickets/:id/stop for a chat answer', async () => {
    open([RUN]);
    fireEvent.click(screen.getByRole('button', { name: /stop/i }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]).toMatchObject({ url: '/api/tickets/c/stop', method: 'POST' });
  });

  it('Esc stops the running conversation (from the composer too)', async () => {
    open([RUN]);
    fireEvent.keyDown(box(), { key: 'Escape' });
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0].url).toBe('/api/tickets/c/stop');
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(posts()).toHaveLength(2));
    expect(posts()[1].url).toBe('/api/tickets/c/stop');
    expect(useOffice.getState().selectedProjectId).toBe('p'); // Esc did not close the drawer while running
  });

  it('Stop on a change ticket in a work stage asks the cancel confirm first', async () => {
    open([tk('w', { text: 'Add login', status: 'running', stage: 'build', mode: 'ticket' })]);
    fireEvent.click(screen.getByRole('button', { name: /stop/i }));
    expect(posts()).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: /cancel ticket/i }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0].url).toBe('/api/tickets/w/cancel');
  });

  it('a stop error shows inline', async () => {
    reply = url => (url.endsWith('/stop') ? { status: 409, body: { error: 'nothing to stop' } } : undefined);
    open([RUN]);
    fireEvent.click(screen.getByRole('button', { name: /stop/i }));
    await waitFor(() => expect(screen.getByText('nothing to stop')).toBeTruthy());
  });
});
