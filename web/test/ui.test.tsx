// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act, within } from '@testing-library/react';
import { roleDef, type Project, type Ticket } from '@office/shared';
import { useOffice, resetOffice, type FeedItem } from '../src/state/store';
import { AddProjectDialog } from '../src/ui/AddProjectDialog';
import { Drawer } from '../src/ui/Drawer';
import { GateCard } from '../src/ui/GateCard';
import { Feed } from '../src/ui/Feed';

const P: Project = { id: 'p', name: 'Shop', folder: '.', accent: 'cyan', team: ['pm', 'techlead', 'frontend', 'backend', 'qa'], slot: 0, looks: {} as Project['looks'], createdAt: '' };
const ticket = (o: Partial<Ticket> = {}): Ticket => ({ id: 't', projectId: 'p', title: 'Add login', text: 'Add login', status: 'running', stage: 'build', agentStates: {}, createdAt: '2026-11-26T10:00:00Z', ...o });

type Call = { url: string; method: string; body: unknown; contentType?: string };
let calls: Call[];
let reply: (url: string) => { status: number; body: unknown };

beforeEach(() => {
  resetOffice();
  calls = [];
  reply = () => ({ status: 200, body: { ok: true } });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined, contentType: (init?.headers as Record<string, string> | undefined)?.['Content-Type'] });
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

describe('Ask vs Ticket UI', () => {
  const openDrawer = (tickets: Ticket[] = []) => {
    useOffice.setState({ projects: { p: P }, tickets: Object.fromEntries(tickets.map(t => [t.id, t])), selectedProjectId: 'p', synced: true });
    return render(<Drawer projectId="p" />);
  };
  const box = () => screen.getByRole('textbox', { name: /message/i }) as HTMLTextAreaElement;
  const send = (text: string) => { fireEvent.change(box(), { target: { value: text } }); fireEvent.keyDown(box(), { key: 'Enter' }); };

  it('composer: Auto · Chat · Change switch (default Auto) is sent as mode', async () => {
    openDrawer();
    const group = screen.getByRole('radiogroup', { name: /mode/i });
    const radios = within(group).getAllByRole('radio') as HTMLInputElement[];
    expect(radios.map(r => r.labels![0].textContent)).toEqual(['Auto', 'Chat', 'Change']);
    expect(radios[0].checked).toBe(true);
    send('What does login do?');
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0].body).toEqual({ text: 'What does login do?', mode: 'auto' });
    fireEvent.click(within(group).getByRole('radio', { name: 'Chat' }));
    await waitFor(() => expect(box().value).toBe(''));
    send('List the buttons');
    await waitFor(() => expect(posts()).toHaveLength(2));
    expect(posts()[1].body).toEqual({ text: 'List the buttons', mode: 'ask' });
  });

  it('a follow-up carries the mode too; messages to a running ticket have no switch', async () => {
    openDrawer([ticket({ id: 'a', title: 'Buttons', text: 'Buttons', status: 'done', stage: 'done', answered: true, mode: 'ask' })]);
    fireEvent.click(screen.getByRole('button', { name: /past conversations/i }));
    fireEvent.click(within(screen.getByRole('list', { name: /past conversations/i })).getByRole('button', { name: /Buttons/ }));
    fireEvent.click(screen.getByRole('radio', { name: 'Change' }));
    send('Now write that to docs/buttons.md');
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0].body).toEqual({ text: 'Now write that to docs/buttons.md', parentTicketId: 'a', mode: 'ticket' });
    cleanup();
    openDrawer([ticket()]);
    expect(screen.queryByRole('radiogroup', { name: /mode/i })).toBeNull();
  });

  it('chats: 💬, "answered" chip, first line of the question, no pipeline; tickets: 🎫 + pipeline', () => {
    openDrawer([ticket({ id: 'a', title: 'Buttons', text: 'What buttons exist?\nbe brief', status: 'done', stage: 'done', answered: true }), ticket({ id: 'b', title: 'Other', status: 'done', stage: 'done', createdAt: '2026-11-25T10:00:00Z' })]);
    fireEvent.click(screen.getByRole('button', { name: /past conversations/i }));
    fireEvent.click(within(screen.getByRole('list', { name: /past conversations/i })).getByRole('button', { name: /What buttons exist/ }));
    expect(screen.queryByRole('list', { name: 'Pipeline' })).toBeNull();
    const head = document.querySelector('.po-ticket-row')!;
    expect(head.textContent).toContain('💬');
    expect(head.querySelector('.po-ticket-title')!.textContent).toBe('What buttons exist?');
    expect(head.querySelector('.po-chip')!.textContent).toBe('answered');
    fireEvent.click(screen.getByRole('button', { name: /past conversations/i }));
    const list = screen.getByRole('list', { name: /past conversations/i });
    expect(within(list).getByRole('button', { name: /What buttons exist/ }).textContent).toContain('💬');
    expect(within(list).getByRole('button', { name: /Other/ }).textContent).toContain('🎫');
    fireEvent.click(within(list).getByRole('button', { name: /Other/ }));
    expect(screen.getByRole('list', { name: 'Pipeline' })).toBeTruthy();
    expect(document.querySelector('.po-ticket-row')!.textContent).toContain('🎫');
  });

  it('Auto still deciding (no plan) is a conversation: 💬, no pipeline; a plan makes it a ticket', () => {
    openDrawer([ticket({ mode: 'auto', stage: 'plan' })]);
    expect(document.querySelector('.po-ticket-row')!.textContent).toContain('💬');
    expect(screen.queryByRole('list', { name: 'Pipeline' })).toBeNull();
    cleanup();
    openDrawer([ticket({ mode: 'auto', stage: 'plan', plan: { summary: 's', acceptance: [], areas: [], tasks: [] } })]);
    expect(document.querySelector('.po-ticket-row')!.textContent).toContain('🎫');
    expect(screen.getByRole('list', { name: 'Pipeline' })).toBeTruthy();
  });

  it('composer wording: placeholder, Send, hint', () => {
    openDrawer();
    expect(box().placeholder).toBe('Ask anything, or describe a change…');
    expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy();
    expect(screen.getByText('Auto decides: questions get an answer, changes become a ticket')).toBeTruthy();
    expect(document.body.textContent).not.toContain('Type a ticket');
  });

  it('an answer renders markdown-ish (headings, lists, code) and wraps', () => {
    useOffice.setState({ tickets: { t: ticket({ status: 'done', stage: 'done', answered: true }) }, feed: { t: [
      { kind: 'message', role: 'pm', text: '## Buttons\n- Save\n- `Cancel`\n\n```ts\nconst x = 1;\n```\nDone.', id: 'm', ts: '', answer: true },
    ] } });
    render(<Feed ticketId="t" />);
    const a = document.querySelector('.po-answer') as HTMLElement;
    expect(a).toBeTruthy();
    expect(within(a).getByRole('heading', { name: 'Buttons' })).toBeTruthy();
    expect(within(a).getAllByRole('listitem').map(li => li.textContent)).toEqual(['Save', 'Cancel']);
    expect(a.querySelector('li code')!.textContent).toBe('Cancel');
    expect(a.querySelector('pre')!.textContent).toBe('const x = 1;');
    expect(a.textContent).toContain('Done.');
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

  it('a gate of a ticket that already ended renders closed, without buttons', () => {
    useOffice.setState(s => ({ tickets: { ...s.tickets, t: { id: 't', projectId: 'p', title: 'x', text: 'x', status: 'failed', reason: 'interrupted', stage: 'plan', agentStates: {}, createdAt: '' } } }));
    render(<GateCard ticketId="t" item={{ ...gate(), text: 'plan' }} />);
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.getByText(/ended before a decision/)).toBeTruthy();
  });

  it('stuck from QA says "Accept & continue" (not "Accept & test")', () => {
    render(<GateCard ticketId="t" item={{ ...gate(), detail: '{"from":"test","bounces":3}' }} />);
    expect(screen.getByRole('button', { name: 'Accept & continue' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Accept & test' })).toBeNull();
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

describe('fix round 1', () => {
  const openDrawer = (tickets: Ticket[] = [], extra: Partial<ReturnType<typeof useOffice.getState>> = {}) => {
    useOffice.setState({ projects: { p: P }, tickets: Object.fromEntries(tickets.map(t => [t.id, t])), selectedProjectId: 'p', synced: true, ...extra });
    return render(<Drawer projectId="p" />);
  };
  const box = () => screen.getByRole('textbox', { name: /message/i }) as HTMLTextAreaElement;
  const enter = (b: HTMLTextAreaElement) => fireEvent.keyDown(b, { key: 'Enter' });

  it('TeamDialog PATCHes {team} and closes; shows a 409 inline', async () => {
    const { TeamDialog } = await import('../src/ui/TeamDialog');
    const onClose = vi.fn();
    render(<TeamDialog project={P} onClose={onClose} />);
    fireEvent.click(screen.getByRole('checkbox', { name: /Tech Writer/ }));
    fireEvent.click(screen.getByRole('button', { name: /save team/i }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(calls[0]).toMatchObject({ url: '/api/projects/p', method: 'PATCH', body: { team: ['pm', 'techlead', 'frontend', 'backend', 'qa', 'writer'] } });
    cleanup(); onClose.mockClear();
    reply = () => ({ status: 409, body: { error: 'Busy on a running ticket: frontend' } });
    render(<TeamDialog project={P} onClose={onClose} />);
    fireEvent.click(screen.getByRole('checkbox', { name: /Frontend/ }));
    fireEvent.click(screen.getByRole('button', { name: /save team/i }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Busy on a running ticket: frontend');
    expect(onClose).not.toHaveBeenCalled();
  });

  it.each([[409, 'Ticket is not active'], [400, 'Message text is required']])('Composer shows a %s error inline and keeps the text', async (status, error) => {
    reply = () => ({ status, body: { error } });
    openDrawer([ticket()]);
    fireEvent.change(box(), { target: { value: 'hello' } });
    enter(box());
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', error);
    expect(box().value).toBe('hello');
  });

  it('Composer: a double Enter sends once', async () => {
    openDrawer([]);
    fireEvent.change(box(), { target: { value: 'Add a footer' } });
    enter(box()); enter(box());
    await waitFor(() => expect(box().value).toBe(''));
    expect(posts()).toHaveLength(1);
  });

  it('api(): a rejected fetch shows "Server unreachable" inline', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    openDrawer([]);
    fireEvent.change(box(), { target: { value: 'x' } });
    enter(box());
    expect((await screen.findByRole('alert')).textContent).toMatch(/^Server unreachable/);
  });

  it('useFollow: pauses when scrolled up, follows again on click', async () => {
    const { RawLog } = await import('../src/ui/RawLog');
    useOffice.setState({ raw: { t: ['[pm] one', '[pm] two'] } });
    const { container } = render(<RawLog ticketId="t" />);
    const el = container.querySelector('.po-raw') as HTMLElement;
    Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => 1000 });
    Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => 200 });
    act(() => { useOffice.setState({ raw: { t: ['[pm] one', '[pm] two', '[pm] three'] } }); });
    expect(el.scrollTop).toBe(1000); // follows the tail
    el.scrollTop = 100;
    fireEvent.scroll(el);
    act(() => { useOffice.setState({ raw: { t: ['[pm] one', '[pm] two', '[pm] three', '[pm] four'] } }); });
    expect(el.scrollTop).toBe(100); // paused
    fireEvent.click(screen.getByRole('button', { name: /follow/i }));
    expect(el.scrollTop).toBe(1000);
    expect(screen.queryByRole('button', { name: /follow/i })).toBeNull();
  });

  it('delete sends DELETE only after the inline confirm, once', async () => {
    openDrawer([]);
    fireEvent.click(screen.getByRole('button', { name: /project menu/i }));
    fireEvent.click(screen.getByRole('menuitem', { name: /delete project/i }));
    expect(calls.filter(c => c.method !== 'GET')).toHaveLength(0); // only the claude status GET
    const yes = screen.getByRole('button', { name: /^delete project$/i });
    fireEvent.click(yes); fireEvent.click(yes);
    await waitFor(() => expect(useOffice.getState().selectedProjectId).toBeNull());
    expect(calls.filter(c => c.method === 'DELETE')).toEqual([expect.objectContaining({ url: '/api/projects/p', contentType: 'application/json' })]);
  });

  it('cancel ticket asks for an inline confirm and posts once', async () => {
    openDrawer([ticket()]);
    fireEvent.click(screen.getByRole('button', { name: /project menu/i }));
    fireEvent.click(screen.getByRole('menuitem', { name: /cancel running ticket/i }));
    expect(calls.filter(c => c.method !== 'GET')).toHaveLength(0);
    const yes = screen.getByRole('button', { name: /^cancel ticket$/i });
    fireEvent.click(yes); fireEvent.click(yes);
    await waitFor(() => expect(posts()).toHaveLength(1));
    await new Promise(r => setTimeout(r, 20));
    expect(posts()).toEqual([expect.objectContaining({ url: '/api/tickets/t/cancel' })]);
    expect(posts()[0].contentType).toBe('application/json');
  });

  it('a role filter outside the team is reset to all roles', () => {
    openDrawer([ticket()], { roleFilter: 'writer', feed: { t: [{ kind: 'message', role: 'pm', text: 'Planning the work.', id: 'm1', ts: '2026-11-26T10:00:00Z' }] } });
    expect(useOffice.getState().roleFilter).toBe('all');
    expect(screen.getByText('Planning the work.')).toBeTruthy();
  });

  it('reveal waits until the selected project reaches the store, then pans once', async () => {
    const { useRevealSelected } = await import('../src/ui/useRevealSelected');
    const reveal = vi.fn();
    const scene = { camera: { reveal }, roomBounds: (id: string) => (id === 'p' ? { x0: 0, y0: 0, x1: 1, y1: 1 } : null) };
    const { renderHook } = await import('@testing-library/react');
    const { rerender } = renderHook(({ present }) => useRevealSelected({ current: scene as never }, 'p', present, 560), { initialProps: { present: false } });
    expect(reveal).not.toHaveBeenCalled();
    rerender({ present: true });
    rerender({ present: true });
    expect(reveal).toHaveBeenCalledTimes(1);
    expect(reveal).toHaveBeenCalledWith({ x0: 0, y0: 0, x1: 1, y1: 1 }, 560);
  });
});

describe('M2: real agents UI', () => {
  const NOW = Date.now();
  const claude = (o: Record<string, unknown> = {}) => ({ found: true, version: '2.0.0', loggedIn: true, accountType: 'pro', signInEndsAt: null, ...o });
  let sys: Record<string, unknown>;
  beforeEach(() => {
    sys = claude();
    reply = url => (url === '/api/system/claude' ? { status: 200, body: sys } : { status: 200, body: { ok: true } });
  });
  const openDrawer = (tickets: Ticket[] = [], project: Partial<Project> = {}) => {
    useOffice.setState({ projects: { p: { ...P, ...project } }, tickets: Object.fromEntries(tickets.map(t => [t.id, t])), selectedProjectId: 'p', synced: true });
    return render(<Drawer projectId="p" />);
  };
  const box = () => screen.getByRole('textbox', { name: /message/i }) as HTMLTextAreaElement;
  /** Opens the newest conversation from the past list (nothing is open by default when nothing runs). */
  const openThread = () => {
    fireEvent.click(screen.getByRole('button', { name: /past conversations/i }));
    fireEvent.click(within(screen.getByRole('list', { name: /past conversations/i })).getAllByRole('button')[0]);
  };

  it('fetches /api/system/claude and shows the missing banner', async () => {
    sys = claude({ found: false, loggedIn: false });
    openDrawer();
    expect(await screen.findByText("Claude Code isn't installed — install it, then run `claude` and `/login`")).toBeTruthy();
    expect(calls.some(c => c.url === '/api/system/claude' && c.method === 'GET')).toBe(true);
  });

  it('shows the logged-out banner', async () => {
    sys = claude({ loggedIn: false });
    openDrawer();
    expect(await screen.findByText('Run `claude` then `/login` in a terminal')).toBeTruthy();
  });

  it('shows the sign-in-ends banner within 10 days only', async () => {
    sys = claude({ signInEndsAt: new Date(NOW + 3 * 864e5).toISOString() });
    openDrawer();
    expect(await screen.findByText(/^Your Claude sign-in ends on .+ — run `claude` then `\/login` to renew$/)).toBeTruthy();
    cleanup();
    sys = claude({ signInEndsAt: new Date(NOW + 30 * 864e5).toISOString() });
    const { refreshClaude } = await import('../src/ui/claudeStatus');
    await act(async () => { await refreshClaude(); });
    openDrawer();
    expect(screen.queryByText(/sign-in ends on/)).toBeNull();
  });

  it('Toolbar shows a small global banner when claude is missing', async () => {
    const { Toolbar } = await import('../src/ui/Toolbar');
    sys = claude({ found: false, loggedIn: false });
    render(<Toolbar onFit={() => {}} />);
    expect(await screen.findByText(/Claude Code isn't installed/)).toBeTruthy();
  });

  it('Initialize git banner posts git-init and shows the result inline', async () => {
    reply = url => (url === '/api/system/claude' ? { status: 200, body: sys } : { status: 200, body: { ok: true, message: 'Initialized git in . with an initial commit.' } });
    openDrawer([ticket({ status: 'failed', reason: 'not-a-git-repo', agentsMode: 'claude' })]);
    fireEvent.click(screen.getByRole('button', { name: /initialize git/i }));
    expect(await screen.findByText('Initialized git in . with an initial commit.')).toBeTruthy();
    expect(posts().find(c => c.url === '/api/projects/p/git-init')).toBeTruthy();
  });

  it('Past conversations list: title, date, status, roles, estimate; selecting shows that history', async () => {
    const a = ticket({ id: 'a', title: 'Add login', status: 'done', stage: 'done', createdAt: new Date(NOW - 2 * 864e5).toISOString(), agentStates: { pm: 'done', frontend: 'done' }, usage: { turns: 12, costUsd: 0.84, durationMs: 360000 } });
    const b = ticket({ id: 'b', title: 'Dark mode', status: 'failed', stage: 'build', reason: 'interrupted', createdAt: new Date(NOW - 3600e3).toISOString() });
    useOffice.setState({ feed: { a: [{ kind: 'message', role: 'pm', text: 'Login planned.', id: 'm1', ts: a.createdAt }] } });
    openDrawer([a, b]);
    fireEvent.click(screen.getByRole('button', { name: /past conversations/i }));
    const list = screen.getByRole('list', { name: /past conversations/i });
    const item = within(list).getByRole('button', { name: /Add login/ });
    expect(item.textContent).toMatch(/12 turns/);
    expect(item.textContent).not.toMatch(/\$/);
    expect(item.textContent).toMatch(/done/);
    expect(item.textContent).toMatch(/2d ago/);
    expect(item.textContent).toContain(roleDef('frontend').emoji);
    fireEvent.click(item);
    expect(await screen.findByText('Login planned.')).toBeTruthy();
  });

  it('a selected finished ticket turns the composer into Continue and posts {text, parentTicketId}', async () => {
    const a = ticket({ id: 'a', title: 'Add login', status: 'done', stage: 'done' });
    openDrawer([a, ticket({ id: 'b', title: 'Other', status: 'done', stage: 'done', createdAt: '2026-11-26T11:00:00Z' })]);
    fireEvent.click(screen.getByRole('button', { name: /past conversations/i }));
    fireEvent.click(within(screen.getByRole('list', { name: /past conversations/i })).getByRole('button', { name: /Add login/ }));
    expect(box().placeholder).toBe('Continue this conversation…');
    expect(screen.getByRole('button', { name: 'Continue' })).toBeTruthy();
    fireEvent.change(box(), { target: { value: 'Also add logout' } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]).toMatchObject({ url: '/api/projects/p/tickets', body: { text: 'Also add logout', parentTicketId: 'a' } });
  });

  it('Resume on an interrupted claude ticket posts resume and shows a 409 inline', async () => {
    reply = url => (url === '/api/system/claude' ? { status: 200, body: sys } : { status: 409, body: { error: 'Another ticket is running' } });
    openDrawer([ticket({ status: 'failed', reason: 'interrupted', agentsMode: 'claude', sessions: { pm: 's1' } })]);
    openThread();
    fireEvent.click(screen.getByRole('button', { name: /^resume/i }));
    expect(await screen.findByText('Another ticket is running')).toBeTruthy();
    expect(posts()[0].url).toBe('/api/tickets/t/resume');
  });

  it('no Resume on a not-a-git-repo failure (the git banner handles it)', () => {
    openDrawer([ticket({ status: 'failed', reason: 'not-a-git-repo', agentsMode: 'claude' })]);
    openThread();
    expect(screen.queryByRole('button', { name: /^resume/i })).toBeNull();
    expect(screen.getByRole('button', { name: /initialize git/i })).toBeTruthy();
  });

  it('no Resume button on simulated or done tickets', () => {
    openDrawer([ticket({ status: 'failed', reason: 'interrupted', agentsMode: 'simulated' })]);
    openThread();
    expect(screen.queryByRole('button', { name: /^resume/i })).toBeNull();
    cleanup();
    openDrawer([ticket({ status: 'done', stage: 'done', agentsMode: 'claude' })]);
    openThread();
    expect(screen.queryByRole('button', { name: /^resume/i })).toBeNull();
  });

  it('usage line at the end of a finished ticket feed', () => {
    openDrawer([ticket({ status: 'done', stage: 'done', usage: { turns: 12, costUsd: 0.84, durationMs: 360000 } })]);
    openThread();
    expect(screen.getByText('12 turns · 6 min · uses your Claude plan (≈$0.84 at API rates, not charged)')).toBeTruthy();
  });

  it('agents badge in the drawer header', () => {
    openDrawer();
    expect(screen.getByText('Claude Code')).toBeTruthy();
    cleanup();
    openDrawer([], { agentsMode: 'simulated' });
    expect(screen.getByText('Simulated')).toBeTruthy();
  });

  it('Team dialog agents switch PATCHes agentsMode and shows a 409 inline', async () => {
    const { TeamDialog } = await import('../src/ui/TeamDialog');
    reply = () => ({ status: 409, body: { error: 'Agents mode can only change when no ticket is running for this project' } });
    render(<TeamDialog project={P} onClose={() => {}} />);
    fireEvent.click(screen.getByRole('radio', { name: /simulated/i }));
    expect(await screen.findByText('Agents mode can only change when no ticket is running for this project')).toBeTruthy();
    expect(calls.find(c => c.method === 'PATCH')).toMatchObject({ url: '/api/projects/p', body: { agentsMode: 'simulated' } });
    expect((screen.getByRole('radio', { name: /claude code/i }) as HTMLInputElement).checked).toBe(true);
  });
});

describe('multi-repo projects UI', () => {
  const REPOS = [{ name: 'angular', path: 'C:/hrms/angular' }, { name: 'aspnet-core', path: 'C:/hrms/aspnet-core' }];
  const MULTI: Project = { ...P, gitKind: 'multi', repos: REPOS };
  beforeEach(() => {
    reply = url => (url === '/api/system/claude'
      ? { status: 200, body: { found: true, version: '2', loggedIn: true, accountType: 'pro', signInEndsAt: null } }
      : { status: 200, body: { ok: true } });
  });
  const openDrawer = (project: Project, tickets: Ticket[] = []) => {
    useOffice.setState({ projects: { p: project }, tickets: Object.fromEntries(tickets.map(t => [t.id, t])), selectedProjectId: 'p', synced: true });
    return render(<Drawer projectId="p" />);
  };
  const fill = () => {
    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: 'HRMS' } });
    fireEvent.change(screen.getByLabelText(/folder/i), { target: { value: 'C:/hrms' } });
    fireEvent.click(screen.getByRole('button', { name: /create/i }));
  };

  it('Add Project: shows "Repos found" from the response instead of closing right away', async () => {
    const onClose = vi.fn();
    reply = () => ({ status: 201, body: { ...MULTI, id: 'new' } });
    render(<AddProjectDialog onClose={onClose} />);
    fill();
    expect(await screen.findByText('Repos found: angular, aspnet-core')).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /initialize git/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /open project/i }));
    expect(onClose).toHaveBeenCalled();
  });

  it('Add Project: "Not a git repo — Initialize git" only when none', async () => {
    reply = url => url.endsWith('/git-init')
      ? { status: 200, body: { ok: true, message: 'Initialized git in C:/hrms with an initial commit.' } }
      : { status: 201, body: { ...P, id: 'new', gitKind: 'none' } };
    render(<AddProjectDialog onClose={() => {}} />);
    fill();
    expect(await screen.findByText(/Not a git repo/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /initialize git/i }));
    expect(await screen.findByText('Initialized git in C:/hrms with an initial commit.')).toBeTruthy();
    expect(posts().find(c => c.url === '/api/projects/new/git-init')).toBeTruthy();
  });

  it('Team dialog shows the repos found', async () => {
    const { TeamDialog } = await import('../src/ui/TeamDialog');
    render(<TeamDialog project={MULTI} onClose={() => {}} />);
    expect(screen.getByText('Repos found: angular, aspnet-core')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /initialize git/i })).toBeNull();
  });

  it('drawer header shows repo chips; no Initialize git banner for a multi-repo project', () => {
    openDrawer(MULTI, [ticket({ status: 'failed', reason: 'not-a-git-repo', agentsMode: 'claude' })]);
    expect(screen.getByText('angular · aspnet-core')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /initialize git/i })).toBeNull();
    cleanup();
    openDrawer(P);
    expect(screen.queryByText(/angular/)).toBeNull();
  });

  it('Changes tab groups files under repo headings', () => {
    useOffice.setState({ diffs: { t: [
      { path: 'angular/src/a.ts', patch: '+a\n' }, { path: 'aspnet-core/B.cs', patch: '+b\n-c\n' }, { path: 'angular/src/b.ts', patch: '+x\n' },
    ] } });
    openDrawer(MULTI, [ticket()]);
    fireEvent.click(screen.getByRole('tab', { name: /changes/i }));
    const groups = within(document.querySelector('.po-changes') as HTMLElement).getAllByRole('group');
    expect(groups.map(g => within(g).getByRole('heading').textContent)).toEqual(['angular', 'aspnet-core']);
    expect(within(groups[0]).getAllByRole('button').map(b => b.querySelector('.po-file-path')!.textContent)).toEqual(['src/a.ts', 'src/b.ts']);
    expect(within(groups[1]).getByText('B.cs')).toBeTruthy();
  });
});
