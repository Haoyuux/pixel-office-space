// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within, act } from '@testing-library/react';
import type { Project, Ticket } from '@office/shared';
import { useOffice, resetOffice } from '../src/state/store';
import { Drawer } from '../src/ui/Drawer';
import { Feed } from '../src/ui/Feed';

const P: Project = { id: 'p', name: 'Shop', folder: '.', accent: 'cyan', team: ['pm', 'frontend'], slot: 0, looks: {} as Project['looks'], createdAt: '' };
const tk = (id: string, o: Partial<Ticket> = {}): Ticket =>
  ({ id, projectId: 'p', title: id, text: id, status: 'done', stage: 'done', agentStates: {}, createdAt: '2026-11-26T10:00:00Z', ...o });
const A = tk('a', { text: 'What does login do?\nbe brief', answered: true, mode: 'ask' });
const B = tk('b', { text: 'And logout?', parentTicketId: 'a', answered: true, mode: 'ask', createdAt: '2026-11-26T10:05:00Z' });
const X = tk('x', { text: 'Dark mode', title: 'Dark mode', createdAt: '2026-11-26T09:00:00Z' });

type Call = { url: string; method: string; body: unknown };
let calls: Call[];
let reply: (url: string, method: string) => { status: number; body: unknown };
const SYS = { found: true, version: '2', loggedIn: true, accountType: 'pro', signInEndsAt: null };

beforeEach(() => {
  resetOffice();
  calls = [];
  reply = url => (url === '/api/system/claude' ? { status: 200, body: SYS } : { status: 200, body: { ok: true } });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const r = reply(url, init?.method ?? 'GET');
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'Content-Type': 'application/json' } });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const posts = () => calls.filter(c => c.method !== 'GET');
const open = (tickets: Ticket[]) => {
  useOffice.setState({ projects: { p: P }, tickets: Object.fromEntries(tickets.map(t => [t.id, t])), selectedProjectId: 'p', synced: true });
  return render(<Drawer projectId="p" />);
};
const box = () => screen.getByRole('textbox', { name: /message/i }) as HTMLTextAreaElement;
const send = (text: string) => { fireEvent.change(box(), { target: { value: text } }); fireEvent.keyDown(box(), { key: 'Enter' }); };
const pastList = () => {
  if (!screen.queryByRole('list', { name: /past conversations/i })) fireEvent.click(screen.getByRole('button', { name: /past conversations/i }));
  return screen.getByRole('list', { name: /past conversations/i });
};
const pick = (name: RegExp) => fireEvent.click(within(pastList()).getByRole('button', { name }));
const bubbles = () => [...document.querySelectorAll('.po-you-text')].map(e => e.textContent);

describe('threaded conversations', () => {
  it('past conversations: one row per thread, root title, latest status/kind, message count', () => {
    open([A, B, X]);
    expect(screen.getByRole('button', { name: /past conversations/i }).textContent).toContain('2');
    const rows = within(pastList()).getAllByRole('button');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('What does login do?');
    expect(rows[0].textContent).not.toContain('And logout?');
    expect(rows[0].textContent).toContain('💬');
    expect(rows[0].textContent).toContain('answered');
    expect(rows[0].textContent).toMatch(/2 messages/);
    expect(rows[1].textContent).toContain('Dark mode');
    expect(rows[1].textContent).toContain('🎫');
    expect(rows[1].textContent).toMatch(/1 message\b/);
  });

  it('opening a project shows the fresh composer (welcome) when nothing runs', () => {
    open([A, B]);
    expect(screen.getByText(/Shop is ready/)).toBeTruthy();
    expect(box().placeholder).not.toBe('Continue this conversation…');
  });

  it('the feed shows the whole thread: every ticket\'s You bubble, oldest first, with separators', () => {
    useOffice.setState({ feed: {
      a: [{ kind: 'message', role: 'pm', text: 'It signs you in.', id: 'm1', ts: A.createdAt, answer: true }],
      b: [{ kind: 'message', role: 'pm', text: 'It signs you out.', id: 'm2', ts: B.createdAt, answer: true }],
    } });
    open([A, B]);
    pick(/What does login do/);
    expect(bubbles()).toEqual(['What does login do?\nbe brief', 'And logout?']);
    expect(screen.getByText('It signs you in.')).toBeTruthy();
    expect(screen.getByText('It signs you out.')).toBeTruthy();
    expect(document.querySelectorAll('.po-feed [role="separator"]')).toHaveLength(1);
  });

  it('Feed renders several tickets in order', () => {
    useOffice.setState({ tickets: { a: A, b: B } });
    render(<Feed ticketIds={['a', 'b']} />);
    expect(bubbles()).toEqual(['What does login do?\nbe brief', 'And logout?']);
  });

  it('sending in a finished thread posts a follow-up of the latest ticket and keeps the thread open', async () => {
    reply = (url, method) => (url === '/api/system/claude' ? { status: 200, body: SYS }
      : method === 'POST' ? { status: 201, body: tk('c', { text: 'And signup?', parentTicketId: 'b', status: 'running', stage: 'plan', mode: 'auto', createdAt: '2026-11-26T10:09:00Z' }) }
      : { status: 200, body: { ok: true } });
    open([A, B, X]);
    pick(/What does login do/);
    expect(box().placeholder).toBe('Continue this conversation…');
    send('And signup?');
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]).toMatchObject({ url: '/api/projects/p/tickets', body: { text: 'And signup?', parentTicketId: 'b', mode: 'auto' } });
    // the new ticket arrives over the socket: still the same conversation, now three messages
    act(() => { useOffice.setState(s => ({ tickets: { ...s.tickets, c: tk('c', { text: 'And signup?', parentTicketId: 'b', status: 'running', stage: 'plan', mode: 'auto', createdAt: '2026-11-26T10:09:00Z' }) } })); });
    await waitFor(() => expect(bubbles()).toEqual(['What does login do?\nbe brief', 'And logout?', 'And signup?']));
    expect(screen.queryByText(/Shop is ready/)).toBeNull();
    // the latest is running: the next message goes to it
    await waitFor(() => expect(box().value).toBe(''));
    send('Use email links');
    await waitFor(() => expect(posts()).toHaveLength(2));
    expect(posts()[1]).toMatchObject({ url: '/api/tickets/c/messages', body: { text: 'Use email links' } });
  });

  it('a running thread is shown on open and messages go to its latest ticket', async () => {
    const C = tk('c', { text: 'And signup?', parentTicketId: 'b', status: 'running', stage: 'plan', createdAt: '2026-11-26T10:09:00Z' });
    open([A, B, C]);
    expect(bubbles()).toEqual(['What does login do?\nbe brief', 'And logout?', 'And signup?']);
    send('Hurry');
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0].url).toBe('/api/tickets/c/messages');
  });

  it('/new and the New conversation button start fresh (no parent)', async () => {
    open([A, B]);
    pick(/What does login do/);
    send('/new');
    expect(screen.getByText(/Shop is ready/)).toBeTruthy();
    send('Brand new');
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0].body).toEqual({ text: 'Brand new', mode: 'auto' });
    cleanup();
    open([A, B]);
    pick(/What does login do/);
    fireEvent.click(screen.getByRole('button', { name: /new conversation/i }));
    expect(screen.getByText(/Shop is ready/)).toBeTruthy();
    send('Another');
    await waitFor(() => expect(posts()).toHaveLength(2));
    expect(posts()[1].body).toEqual({ text: 'Another', mode: 'auto' });
  });

  it('Changes and Plan show the latest ticket of the thread that has them', () => {
    const plan = { summary: 'Add the login form', acceptance: [], areas: [], tasks: [] };
    const T1 = tk('a', { text: 'Add login', title: 'Add login', plan, mode: 'ticket' });
    const T2 = tk('b', { text: 'Why?', parentTicketId: 'a', answered: true, mode: 'ask', createdAt: '2026-11-26T10:05:00Z' });
    useOffice.setState({ diffs: { a: [{ path: 'src/login.ts', patch: '+x\n' }] } });
    open([T1, T2]);
    pick(/Add login/);
    fireEvent.click(screen.getByRole('tab', { name: /changes/i }));
    expect(screen.getAllByText('src/login.ts').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('tab', { name: /plan/i }));
    expect(screen.getByText(/Add the login form/)).toBeTruthy();
  });
});
