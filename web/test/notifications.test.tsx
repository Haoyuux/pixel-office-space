// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';
import type { Project, ServerEvent, Ticket } from '@office/shared';
import { useOffice, resetOffice } from '../src/state/store';
import { dispatch } from '../src/state/socket';
import { alertFor, startNotifications, tabTitle, type NotifyEnv, type Permission } from '../src/ui/notifications';
import { NotifyButton } from '../src/ui/Toolbar';
import { Drawer } from '../src/ui/Drawer';

const P: Project = { id: 'p', name: 'Shop', folder: '.', accent: 'cyan', team: ['pm', 'techlead', 'frontend', 'backend', 'qa'], slot: 0, looks: {} as Project['looks'], createdAt: '' };
const ticket = (o: Partial<Ticket> = {}): Ticket => ({ id: 't', projectId: 'p', title: 'Add login', text: 'Add login', status: 'running', stage: 'build', agentStates: {}, createdAt: '2026-11-26T10:00:00Z', mode: 'ticket', ...o });
let seq = 0;
const ev = (e: Record<string, unknown>, ticketId = 't'): ServerEvent => ({ projectId: 'p', ticketId, ts: '2026-11-27T10:00:00Z', seq: ++seq, ...e } as ServerEvent);

beforeEach(() => {
  resetOffice();
  seq = 100;
  useOffice.setState({ projects: { p: P }, tickets: { t: ticket(), c: ticket({ id: 'c', title: 'Why?', mode: 'ask', stage: 'plan' }) }, synced: true });
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); try { localStorage.clear(); } catch { /* none */ } });

describe('alertFor', () => {
  const s = () => useOffice.getState();
  it('gate.open → needs your approval', () => {
    expect(alertFor(ev({ type: 'gate.open', gate: 'plan', payload: null }), s())).toMatchObject({ title: 'Shop: needs your approval', body: 'Add login', projectId: 'p', rootId: 't' });
  });
  it('ticket.answered → answer ready', () => {
    expect(alertFor(ev({ type: 'ticket.answered' }, 'c'), s())?.title).toBe('Shop: answer ready');
  });
  it('ticket.done of a change ticket → done; of a chat or a stopped run → nothing', () => {
    expect(alertFor(ev({ type: 'ticket.done' }), s())?.title).toBe('Shop: done');
    expect(alertFor(ev({ type: 'ticket.done' }, 'c'), s())).toBeNull();
    expect(alertFor(ev({ type: 'ticket.done', stopped: true }), s())).toBeNull();
  });
  it('ticket.failed → failed — reason', () => {
    expect(alertFor(ev({ type: 'ticket.failed', reason: 'tests broke' }), s())?.title).toBe('Shop: failed — tests broke');
  });
  it('other events and unknown projects raise nothing', () => {
    expect(alertFor(ev({ type: 'agent.state', role: 'pm', state: 'planning' }), s())).toBeNull();
    expect(alertFor({ ...ev({ type: 'gate.open', gate: 'plan', payload: null }), projectId: 'gone' } as ServerEvent, s())).toBeNull();
  });
  it('a follow-up points at its conversation root', () => {
    useOffice.setState(st => ({ tickets: { ...st.tickets, f: ticket({ id: 'f', parentTicketId: 't', title: 'More' }) } }));
    expect(alertFor(ev({ type: 'gate.open', gate: 'final', payload: null }, 'f'), s())?.rootId).toBe('t');
  });
  it('tabTitle counts unseen items', () => {
    expect(tabTitle(0)).toBe('Pixel Office');
    expect(tabTitle(3)).toBe('(3) Pixel Office');
  });
});

function fakeEnv(o: { visible?: boolean; permission?: Permission } = {}) {
  const shown: { title: string; body: string; click: () => void }[] = [];
  let visible = o.visible ?? false;
  let vis: (() => void) | null = null;
  const env: NotifyEnv & { chimes: number; titles: string[]; focused: number } = {
    chimes: 0, titles: [], focused: 0,
    visible: () => visible,
    permission: () => o.permission ?? 'granted',
    show: (title, body, click) => { shown.push({ title, body, click }); },
    chime: () => { env.chimes++; },
    setTitle: t => { env.titles.push(t); },
    focus: () => { env.focused++; },
    onVisibility: fn => { vis = fn; return () => { vis = null; }; },
  };
  return { env, shown, setVisible: (v: boolean) => { visible = v; vis?.(); } };
}

describe('startNotifications', () => {
  it('a hidden tab: notification + chime + "(1) Pixel Office"', () => {
    const { env, shown } = fakeEnv();
    const stop = startNotifications(env);
    dispatch(ev({ type: 'gate.open', gate: 'plan', payload: null }));
    expect(shown.map(n => n.title)).toEqual(['Shop: needs your approval']);
    expect(env.chimes).toBe(1);
    expect(useOffice.getState().unseen).toHaveLength(1);
    expect(env.titles.at(-1)).toBe('(1) Pixel Office');
    stop();
  });

  it('skipped while the tab is visible and that conversation is open', () => {
    const { env, shown } = fakeEnv({ visible: true });
    useOffice.getState().setOpenConv({ projectId: 'p', rootId: 't' });
    const stop = startNotifications(env);
    dispatch(ev({ type: 'ticket.failed', reason: 'x' }));
    expect(shown).toHaveLength(0);
    expect(env.chimes).toBe(0);
    expect(useOffice.getState().unseen).toHaveLength(0);
    // another conversation still notifies
    dispatch(ev({ type: 'ticket.answered' }, 'c'));
    expect(shown.map(n => n.title)).toEqual(['Shop: answer ready']);
    stop();
  });

  it('no permission: no notification, still the chime and the count; sound off: no chime', () => {
    const { env, shown } = fakeEnv({ permission: 'denied' });
    const stop = startNotifications(env);
    dispatch(ev({ type: 'gate.open', gate: 'plan', payload: null }));
    expect(shown).toHaveLength(0);
    expect(env.chimes).toBe(1);
    useOffice.getState().setSound(false);
    dispatch(ev({ type: 'ticket.answered' }, 'c'));
    expect(env.chimes).toBe(1);
    expect(useOffice.getState().unseen).toHaveLength(2);
    stop();
  });

  it('clicking a notification focuses the tab and opens that conversation', () => {
    const { env, shown } = fakeEnv();
    const stop = startNotifications(env);
    dispatch(ev({ type: 'ticket.answered' }, 'c'));
    shown[0].click();
    expect(env.focused).toBe(1);
    expect(useOffice.getState().selectedProjectId).toBe('p');
    expect(useOffice.getState().openRequest).toMatchObject({ projectId: 'p', rootId: 'c' });
    stop();
  });

  it('viewing the conversation (tab visible) clears its unseen items and the title', () => {
    const { env, setVisible } = fakeEnv();
    const stop = startNotifications(env);
    dispatch(ev({ type: 'gate.open', gate: 'plan', payload: null }));
    dispatch(ev({ type: 'ticket.answered' }, 'c'));
    expect(env.titles.at(-1)).toBe('(2) Pixel Office');
    useOffice.getState().setOpenConv({ projectId: 'p', rootId: 't' }); // open, but the tab is hidden
    expect(useOffice.getState().unseen).toHaveLength(2);
    setVisible(true);
    expect(useOffice.getState().unseen.map(u => u.rootId)).toEqual(['c']);
    expect(env.titles.at(-1)).toBe('(1) Pixel Office');
    useOffice.getState().setOpenConv({ projectId: 'p', rootId: 'c' });
    expect(env.titles.at(-1)).toBe('Pixel Office');
    stop();
  });
});

describe('opening a conversation from outside the drawer', () => {
  it('the drawer opens the requested conversation and reports it as open', async () => {
    useOffice.setState({ tickets: {
      a: ticket({ id: 'a', title: 'Older thing', status: 'done', stage: 'done', createdAt: '2026-11-26T09:00:00Z' }),
      b: ticket({ id: 'b', title: 'Newer thing', status: 'running', createdAt: '2026-11-26T11:00:00Z' }),
    } });
    act(() => useOffice.getState().openConversation('p', 'a'));
    render(<Drawer projectId="p" />);
    expect(document.querySelector('.po-ticket-title')?.textContent).toBe('Older thing');
    await waitFor(() => expect(useOffice.getState().openConv).toEqual({ projectId: 'p', rootId: 'a' }));
    act(() => useOffice.getState().openConversation('p', 'b'));
    await waitFor(() => expect(document.querySelector('.po-ticket-title')?.textContent).toBe('Newer thing'));
    expect(useOffice.getState().openConv).toEqual({ projectId: 'p', rootId: 'b' });
    cleanup();
    expect(useOffice.getState().openConv).toBeNull();
  });
});

describe('🔔 button', () => {
  it('first click asks for permission, later clicks toggle the sound (remembered)', async () => {
    const N = { permission: 'default' as Permission, requestPermission: vi.fn(async () => { N.permission = 'granted'; return 'granted'; }) };
    vi.stubGlobal('Notification', N);
    render(<NotifyButton />);
    fireEvent.click(screen.getByRole('button', { name: /enable notifications/i }));
    await waitFor(() => expect(N.requestPermission).toHaveBeenCalled());
    const btn = await screen.findByRole('button', { name: /sound on/i });
    expect(useOffice.getState().soundOn).toBe(true);
    fireEvent.click(btn);
    expect(useOffice.getState().soundOn).toBe(false);
    expect(localStorage.getItem('pixel-office.sound')).toBe('0');
    expect(screen.getByRole('button', { name: /sound off/i }).textContent).toBe('🔕');
  });
});
