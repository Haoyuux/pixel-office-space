// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';
import type { Project, Ticket } from '@office/shared';
import { useOffice, resetOffice, type FeedItem } from '../src/state/store';
import { AddProjectDialog } from '../src/ui/AddProjectDialog';
import { Drawer } from '../src/ui/Drawer';
import { GateCard } from '../src/ui/GateCard';
import { Feed } from '../src/ui/Feed';

const P: Project = { id: 'p', name: 'Shop', folder: '.', accent: 'cyan', team: ['pm', 'techlead', 'frontend', 'backend', 'qa'], slot: 0, looks: {} as Project['looks'], createdAt: '' };
const ticket = (o: Partial<Ticket> = {}): Ticket => ({ id: 't', projectId: 'p', title: 'Add login', text: 'Add login', status: 'running', stage: 'build', agentStates: {}, createdAt: '2026-11-26T10:00:00Z', ...o });

type Call = { url: string; method: string; body: unknown };
let calls: Call[];
let reply: (url: string) => { status: number; body: unknown };

beforeEach(() => {
  resetOffice();
  calls = [];
  reply = () => ({ status: 200, body: { ok: true } });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const r = reply(url);
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'Content-Type': 'application/json' } });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const posts = () => calls.filter(c => c.method === 'POST');

describe('AddProjectDialog', () => {
  it('shows the 9 roles with pm locked on and the default team ticked', () => {
    render(<AddProjectDialog onClose={() => {}} />);
    const boxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
    expect(boxes).toHaveLength(9);
    const byRole = Object.fromEntries(boxes.map(b => [b.value, b]));
    expect(byRole.pm.checked).toBe(true);
    expect(byRole.pm.disabled).toBe(true);
    for (const r of ['techlead', 'frontend', 'backend', 'qa']) expect(byRole[r].checked).toBe(true);
    for (const r of ['uiux', 'devops', 'security', 'writer']) expect(byRole[r].checked).toBe(false);
  });

  it('posts {name, folder, accent, team} and closes on success', async () => {
    const onClose = vi.fn();
    reply = () => ({ status: 201, body: { ...P, id: 'new' } });
    render(<AddProjectDialog onClose={onClose} />);
    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: 'Shop' } });
    fireEvent.change(screen.getByLabelText(/folder/i), { target: { value: 'C:/code/shop' } });
    fireEvent.click(screen.getByRole('radio', { name: /magenta/i }));
    fireEvent.click(screen.getByRole('checkbox', { name: /UI\/UX/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /QA/ }));
    fireEvent.click(screen.getByRole('button', { name: /create/i }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(posts()).toHaveLength(1);
    expect(posts()[0].url).toBe('/api/projects');
    expect(posts()[0].body).toEqual({ name: 'Shop', folder: 'C:/code/shop', accent: 'magenta', team: ['pm', 'techlead', 'frontend', 'backend', 'uiux'] });
  });

  it('shows the server error text inline on 400', async () => {
    const onClose = vi.fn();
    reply = () => ({ status: 400, body: { error: 'Folder does not exist: C:/nope' } });
    render(<AddProjectDialog onClose={onClose} />);
    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: 'Shop' } });
    fireEvent.change(screen.getByLabelText(/folder/i), { target: { value: 'C:/nope' } });
    fireEvent.click(screen.getByRole('button', { name: /create/i }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Folder does not exist: C:/nope');
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('Drawer input', () => {
  const setup = (tickets: Ticket[]) => {
    useOffice.setState({ projects: { p: P }, tickets: Object.fromEntries(tickets.map(t => [t.id, t])), selectedProjectId: 'p', synced: true });
    render(<Drawer projectId="p" />);
    return screen.getByRole('textbox', { name: /message/i }) as HTMLTextAreaElement;
  };
  const send = (box: HTMLTextAreaElement, text: string) => {
    fireEvent.change(box, { target: { value: text } });
    fireEvent.keyDown(box, { key: 'Enter' });
  };

  it('creates a ticket when none is running', async () => {
    const box = setup([ticket({ status: 'done', stage: 'done' })]);
    send(box, 'Add a footer');
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]).toMatchObject({ url: '/api/projects/p/tickets', body: { text: 'Add a footer' } });
  });

  it('messages the running ticket, or queues a new ticket with the toggle on', async () => {
    const box = setup([ticket()]);
    send(box, 'Use the blue button');
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]).toMatchObject({ url: '/api/tickets/t/messages', body: { text: 'Use the blue button' } });
    await waitFor(() => expect(box.value).toBe(''));
    fireEvent.click(screen.getByRole('checkbox', { name: /new ticket instead/i }));
    send(box, 'Dark mode');
    await waitFor(() => expect(posts()).toHaveLength(2));
    expect(posts()[1]).toMatchObject({ url: '/api/projects/p/tickets', body: { text: 'Dark mode' } });
  });

  it('Shift+Enter does not send', () => {
    const box = setup([]);
    fireEvent.change(box, { target: { value: 'line one' } });
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });
    expect(posts()).toHaveLength(0);
  });
});

describe('GateCard', () => {
  const gate = (status = 'open'): FeedItem => ({ kind: 'gate', text: 'stuck', status, id: 'gate:9', ts: '2026-11-26T10:00:00Z', detail: '{"from":"review","bounces":3}' });

  it.each([['One more round', 'retry'], ['Accept & test', 'accept'], ['Cancel ticket', 'cancel']])('stuck: "%s" posts %s and disables every button', async (label, decision) => {
    render(<GateCard ticketId="t" item={gate()} />);
    const buttons = screen.getAllByRole('button').filter(b => ['One more round', 'Accept & test', 'Cancel ticket'].includes(b.textContent ?? ''));
    expect(buttons).toHaveLength(3);
    fireEvent.click(screen.getByRole('button', { name: label }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0].url).toBe('/api/tickets/t/gates/stuck');
    expect((posts()[0].body as { decision: string }).decision).toBe(decision);
    for (const b of buttons) expect((b as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(buttons[0]);
    expect(posts()).toHaveLength(1);
  });

  it('shows the server error inline and re-enables on 409', async () => {
    reply = () => ({ status: 409, body: { error: 'Gate already decided' } });
    render(<GateCard ticketId="t" item={{ ...gate(), text: 'plan' }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Gate already decided');
    expect((screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('plan gate sends Request changes with the note', async () => {
    render(<GateCard ticketId="t" item={{ ...gate(), text: 'plan' }} />);
    fireEvent.change(screen.getByRole('textbox', { name: /note/i }), { target: { value: 'Smaller scope' } });
    fireEvent.click(screen.getByRole('button', { name: 'Request changes' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]).toMatchObject({ url: '/api/tickets/t/gates/plan', body: { decision: 'changes', note: 'Smaller scope' } });
  });
});

describe('Feed', () => {
  it('collapses a tool item to one line and expands it on click', () => {
    useOffice.setState({
      feed: { t: [
        { kind: 'message', role: 'pm', text: 'Planning the work.', id: 'm1', ts: '2026-11-26T10:00:00Z' },
        { kind: 'tool', role: 'frontend', text: 'Edit src/Login.tsx (+12 −1)', detail: '@@ -1 +1 @@\n-old\n+new', status: 'ok', id: 'x1', ts: '2026-11-26T10:00:05Z' },
      ] },
    });
    render(<Feed ticketId="t" />);
    expect(screen.getByText('Edit src/Login.tsx (+12 −1)')).toBeTruthy();
    expect(screen.queryByText(/\+new/)).toBeNull();
    act(() => { fireEvent.click(screen.getByText('Edit src/Login.tsx (+12 −1)')); });
    expect(screen.getByText(/\+new/)).toBeTruthy();
    act(() => { fireEvent.click(screen.getByText('Edit src/Login.tsx (+12 −1)')); });
    expect(screen.queryByText(/\+new/)).toBeNull();
  });

  it('filters by the role filter', () => {
    useOffice.setState({
      roleFilter: 'frontend',
      feed: { t: [
        { kind: 'message', role: 'pm', text: 'Planning the work.', id: 'm1', ts: '2026-11-26T10:00:00Z' },
        { kind: 'message', role: 'frontend', text: 'Coding now.', id: 'm2', ts: '2026-11-26T10:00:05Z' },
      ] },
    });
    render(<Feed ticketId="t" />);
    expect(screen.queryByText('Planning the work.')).toBeNull();
    expect(screen.getByText('Coding now.')).toBeTruthy();
  });
});

describe('room badges and pipeline', () => {
  it('badge: waiting beats working; done shows for 5 s', async () => {
    const { roomBadge } = await import('../src/state/badges');
    expect(roomBadge([ticket({ status: 'waiting' })], 'p', undefined, 0)).toBe('⏸ 1 waiting');
    expect(roomBadge([ticket()], 'p', undefined, 0)).toBe('… working');
    expect(roomBadge([ticket({ status: 'done' })], 'p', 1000, 5999)).toBe('✓ done');
    expect(roomBadge([ticket({ status: 'done' })], 'p', 1000, 6000)).toBeNull();
    expect(roomBadge([ticket({ projectId: 'q' })], 'p', undefined, 0)).toBeNull();
  });

  it('pipeline shows only the stages of the team, with ✓/●/○ marks', async () => {
    const { stageMarks } = await import('../src/ui/PipelineBar');
    const marks = stageMarks(['pm', 'frontend', 'qa', 'writer'], ticket({ stage: 'build' }));
    expect(marks.map(m => `${m.stage}:${m.mark}`)).toEqual(['plan:done', 'build:current', 'test:pending', 'docs:pending']);
    expect(stageMarks(['pm', 'uiux', 'security'], ticket({ status: 'done', stage: 'done' })).map(m => m.stage)).toEqual(['plan', 'design', 'build', 'review']);
  });
});
