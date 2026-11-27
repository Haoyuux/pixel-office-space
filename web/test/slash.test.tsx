// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import type { Project, Ticket } from '@office/shared';
import { useOffice, resetOffice } from '../src/state/store';
import { Drawer } from '../src/ui/Drawer';
import { suggest, parseCommand } from '../src/ui/slash';

const P: Project = { id: 'p', name: 'Shop', folder: '.', accent: 'cyan', team: ['pm', 'techlead', 'frontend', 'backend', 'qa'], slot: 0, looks: {} as Project['looks'], createdAt: '' };
const ticket = (o: Partial<Ticket> = {}): Ticket => ({ id: 't', projectId: 'p', title: 'Add login', text: 'Add login', status: 'running', stage: 'build', agentStates: {}, createdAt: '2026-11-26T10:00:00Z', ...o });

type Call = { url: string; method: string; body: unknown };
let calls: Call[];
let reply: (url: string, method: string) => { status: number; body: unknown };
const SYS = { found: true, version: '2.1.0', loggedIn: true, accountType: 'max', signInEndsAt: null };

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

const mutations = () => calls.filter(c => c.method !== 'GET');
const openDrawer = (tickets: Ticket[] = [], project: Partial<Project> = {}) => {
  useOffice.setState({ projects: { p: { ...P, ...project } }, tickets: Object.fromEntries(tickets.map(t => [t.id, t])), selectedProjectId: 'p', synced: true });
  return render(<Drawer projectId="p" />);
};
const box = () => screen.getByRole('textbox', { name: /message/i }) as HTMLTextAreaElement;
const type = (text: string) => fireEvent.change(box(), { target: { value: text } });
const key = (k: string) => fireEvent.keyDown(box(), { key: k });
const popup = () => screen.queryByRole('listbox', { name: /commands/i });
const options = () => within(popup()!).getAllByRole('option');
const run = (text: string) => { type(text); key('Enter'); };

describe('slash helpers', () => {
  it('suggest filters commands by prefix; /model lists the models', () => {
    expect(suggest('/').map(s => s.label)).toContain('/resume');
    expect(suggest('/re').map(s => s.label)).toEqual(['/resume']);
    expect(suggest('/model ').map(s => s.value)).toEqual(['default', 'opus', 'sonnet', 'haiku', 'fable']);
    expect(suggest('/model so').map(s => s.value)).toEqual(['sonnet']);
    expect(suggest('hello')).toEqual([]);
    expect(suggest('/resume foo')).toEqual([]);
  });
  it('parseCommand splits name and argument; unknown names are flagged', () => {
    expect(parseCommand('/resume  login page ')).toEqual({ name: 'resume', arg: 'login page', known: true });
    expect(parseCommand('/xyz')).toMatchObject({ name: 'xyz', known: false });
    expect(parseCommand('not a command')).toBeNull();
  });
});

describe('slash popup', () => {
  it('opens on "/", filters as you type, closes on Esc', () => {
    openDrawer();
    type('/');
    expect(popup()).toBeTruthy();
    expect(options().length).toBeGreaterThanOrEqual(11);
    expect(options()[0].textContent).toMatch(/\/resume/);
    expect(options()[0].textContent).toMatch(/past conversations/i);
    type('/mo');
    expect(options().map(o => o.textContent)).toEqual([expect.stringMatching(/^\/model/)]);
    key('Escape');
    expect(popup()).toBeNull();
  });

  it('↑/↓ moves the highlight; Tab completes; Enter runs (never posted)', () => {
    openDrawer();
    type('/c');
    const names = () => options().map(o => o.textContent!.split(/\s/)[0]);
    expect(names()).toEqual(['/clear', '/chat', '/change', '/cancel']);
    expect(options()[0].getAttribute('aria-selected')).toBe('true');
    key('ArrowDown');
    expect(options()[1].getAttribute('aria-selected')).toBe('true');
    key('ArrowUp'); key('ArrowUp');
    expect(options()[3].getAttribute('aria-selected')).toBe('true');
    key('ArrowDown'); key('ArrowDown');
    key('Tab');
    expect(box().value).toBe('/chat');
    key('Enter');
    expect(box().value).toBe('');
    expect((screen.getByRole('radio', { name: 'Chat' }) as HTMLInputElement).checked).toBe(true);
    expect(mutations()).toHaveLength(0);
  });

  it('a mouse click on a row runs it', () => {
    openDrawer();
    type('/he');
    fireEvent.mouseDown(options()[0]);
    expect(screen.getByRole('region', { name: /commands/i })).toBeTruthy();
    expect(box().value).toBe('');
  });

  it('unknown command → inline hint, nothing sent', () => {
    openDrawer();
    run('/xyz');
    expect(screen.getByText('Unknown command — type /help')).toBeTruthy();
    expect(mutations()).toHaveLength(0);
  });
});

describe('slash commands', () => {
  it('/chat /change /auto set the composer mode', () => {
    openDrawer();
    run('/change');
    expect((screen.getByRole('radio', { name: 'Change' }) as HTMLInputElement).checked).toBe(true);
    run('/chat');
    expect((screen.getByRole('radio', { name: 'Chat' }) as HTMLInputElement).checked).toBe(true);
    run('/auto');
    expect((screen.getByRole('radio', { name: 'Auto' }) as HTMLInputElement).checked).toBe(true);
  });

  it('/model sonnet PATCHes the project and the header shows it', async () => {
    reply = (url, method) => (method === 'PATCH' ? { status: 200, body: { ...P, model: 'sonnet' } } : { status: 200, body: SYS });
    openDrawer();
    expect(screen.queryByTitle(/claude model/i)).toBeNull();
    run('/model sonnet');
    await waitFor(() => expect(mutations()).toHaveLength(1));
    expect(mutations()[0]).toMatchObject({ method: 'PATCH', url: '/api/projects/p', body: { model: 'sonnet' } });
    expect((await screen.findByTitle(/claude model/i)).textContent).toBe('sonnet');
  });

  it('/model without a name shows the picker; Enter picks', async () => {
    openDrawer();
    run('/model');
    expect(box().value).toBe('/model ');
    expect(options().map(o => o.textContent!.split(/\s/)[0])).toEqual(['default', 'opus', 'sonnet', 'haiku', 'fable']);
    key('ArrowDown');
    key('Enter');
    await waitFor(() => expect(mutations()[0]).toMatchObject({ body: { model: 'opus' } }));
  });

  it('/model with a bad name → hint, no request; default hides the header badge', async () => {
    openDrawer([], { model: 'default' });
    expect(screen.queryByTitle(/claude model/i)).toBeNull();
    run('/model gpt');
    expect(await screen.findByText(/Unknown model/)).toBeTruthy();
    expect(mutations()).toHaveLength(0);
  });

  it('/new clears the picked conversation: next message starts fresh', async () => {
    openDrawer([ticket({ id: 'a', title: 'Add login', status: 'done', stage: 'done' })]);
    fireEvent.click(screen.getByRole('button', { name: /past conversations/i }));
    fireEvent.click(within(screen.getByRole('list', { name: /past conversations/i })).getByRole('button', { name: /Add login/ }));
    expect(box().placeholder).toBe('Continue this conversation…');
    run('/new');
    expect(box().placeholder).not.toBe('Continue this conversation…');
    expect(screen.getByText(/Shop is ready/)).toBeTruthy();
    run('Brand new question');
    await waitFor(() => expect(mutations()).toHaveLength(1));
    expect(mutations()[0].body).toEqual({ text: 'Brand new question', mode: 'auto' });
  });

  it('/clear while a ticket runs → the next message is a new ticket, not a message to the team', async () => {
    openDrawer([ticket()]);
    run('/clear');
    run('Another thing');
    await waitFor(() => expect(mutations()).toHaveLength(1));
    expect(mutations()[0].url).toBe('/api/projects/p/tickets');
  });

  it('/resume opens the past list (focused); /resume <text> filters by title', () => {
    openDrawer([ticket({ id: 'a', title: 'Add login', status: 'done' }), ticket({ id: 'b', title: 'Dark mode', status: 'done', createdAt: '2026-11-26T11:00:00Z' })]);
    run('/resume');
    const list = screen.getByRole('list', { name: /past conversations/i });
    expect(within(list).getAllByRole('button')).toHaveLength(2);
    expect(list.parentElement!.contains(document.activeElement)).toBe(true);
    run('/resume dark');
    const l2 = screen.getByRole('list', { name: /past conversations/i });
    expect(within(l2).getAllByRole('button').map(b => b.textContent)).toEqual([expect.stringContaining('Dark mode')]);
  });

  it('/cancel asks for the inline confirm; nothing running → hint', async () => {
    openDrawer([ticket()]);
    run('/cancel');
    expect(screen.getByRole('button', { name: 'Cancel ticket' })).toBeTruthy();
    cleanup();
    openDrawer([ticket({ status: 'done' })]);
    run('/cancel');
    expect(await screen.findByText('Nothing is running')).toBeTruthy();
  });

  it('/team opens the Team dialog', () => {
    openDrawer();
    run('/team');
    expect(screen.getByText(/team · Shop/)).toBeTruthy();
  });

  it('/status shows a local card with claude + project details', async () => {
    openDrawer([], { agentsMode: 'claude', model: 'haiku', repos: [{ name: 'api', path: 'C:/x/api' }], gitKind: 'multi' });
    run('/status');
    const card = screen.getByRole('region', { name: /status/i });
    await waitFor(() => expect(card.textContent).toContain('2.1.0'));
    expect(card.textContent).toMatch(/Logged in\s*yes/);
    expect(card.textContent).toContain('max');
    expect(card.textContent).toContain('haiku');
    expect(card.textContent).toContain('Claude Code');
    expect(card.textContent).toContain('api');
    fireEvent.click(within(card).getByRole('button', { name: /close/i }));
    expect(screen.queryByRole('region', { name: /status/i })).toBeNull();
  });

  it('/help lists every command', () => {
    openDrawer();
    run('/help');
    const card = screen.getByRole('region', { name: /commands/i });
    for (const c of ['/resume', '/model', '/new', '/clear', '/chat', '/change', '/auto', '/cancel', '/status', '/team', '/help']) expect(card.textContent).toContain(c);
  });
});
