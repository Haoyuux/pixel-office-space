// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act, within } from '@testing-library/react';
import type { Project, Ticket } from '@office/shared';
import { useOffice, resetOffice } from '../src/state/store';
import { Drawer } from '../src/ui/Drawer';
import { Feed, toolSummary } from '../src/ui/Feed';
import { Markdown } from '../src/ui/Markdown';
import { highlight } from '../src/ui/highlight';
import { resetComposerHistory } from '../src/ui/Composer';

const P: Project = { id: 'p', name: 'Shop', folder: '.', accent: 'cyan', team: ['pm', 'frontend'], slot: 0, looks: {} as Project['looks'], createdAt: '' };
const tk = (id: string, o: Partial<Ticket> = {}): Ticket =>
  ({ id, projectId: 'p', title: id, text: id, status: 'done', stage: 'done', agentStates: {}, createdAt: '2026-11-26T10:00:00Z', ...o });

type Call = { url: string; method: string; body: unknown };
let calls: Call[];
let reply: (url: string, method: string, body: unknown) => { status: number; body: unknown } | undefined;
const SYS = { found: true, version: '2', loggedIn: true, accountType: 'pro', signInEndsAt: null };

beforeEach(() => {
  resetOffice();
  resetComposerHistory();
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

describe('copy, highlight, tables, links', () => {
  const clip = () => {
    const writeText = vi.fn(async (_: string) => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    return writeText;
  };

  it('highlight(): keywords, strings, comments, numbers per language; unknown stays plain', () => {
    const kinds = (code: string, lang: string) => highlight(code, lang).filter(t => t.cls).map(t => `${t.cls}:${t.text}`);
    expect(kinds('const x = "a"; // hi', 'ts')).toEqual(['kw:const', 'str:"a"', 'com:// hi']);
    expect(kinds('public List<int> N = Make(42);', 'csharp')).toEqual(['kw:public', 'type:List', 'kw:int', 'fn:Make', 'num:42']);
    expect(kinds('SELECT id FROM users -- all', 'sql')).toEqual(['kw:SELECT', 'kw:FROM', 'com:-- all']);
    expect(kinds('{"a": 1, "b": true}', 'json')).toEqual(['key:"a"', 'num:1', 'key:"b"', 'lit:true']);
    expect(kinds('<div class="x">hi</div>', 'html')).toEqual(['tag:<div', 'attr:class', 'str:"x"', 'tag:>', 'tag:</div', 'tag:>']);
    expect(kinds('.a { color: #fff; }', 'css')).toEqual(['prop:color', 'num:#fff']);
    expect(kinds('echo $HOME # x', 'bash')).toEqual(['kw:echo', 'var:$HOME', 'com:# x']);
    expect(kinds('Get-ChildItem -Path $dir', 'powershell')).toEqual(['fn:Get-ChildItem', 'attr:-Path', 'var:$dir']);
    expect(highlight('if x', 'cobol')).toEqual([{ text: 'if x' }]);
    // the tokens always add back up to the code
    const code = 'function f(a) { return `t${a}` + 0x1F; } /* end';
    expect(highlight(code, 'js').map(t => t.text).join('')).toBe(code);
  });

  it('code blocks: highlighted spans (text only) and a copy button that copies the code', async () => {
    const writeText = clip();
    const { container } = render(<Markdown text={'```ts\nconst a = "<b>";\n```'} />);
    expect(container.querySelector('pre')!.textContent).toBe('const a = "<b>";');
    expect(container.querySelector('pre .po-tok-kw')!.textContent).toBe('const');
    expect(container.querySelector('b')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /copy code/i }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('const a = "<b>";'));
    await waitFor(() => expect(screen.getByRole('button', { name: /copy code/i }).textContent).toMatch(/copied/i));
  });

  it('every message has a copy button (agent and You)', async () => {
    const writeText = clip();
    useOffice.setState({ tickets: { t: tk('t', { text: 'What does Save do?' }) }, feed: { t: [{ kind: 'message', role: 'pm', text: 'It **saves**.', id: 'm', ts: '' }] } });
    render(<Feed ticketId="t" />);
    const btns = screen.getAllByRole('button', { name: /copy message/i });
    expect(btns).toHaveLength(2);
    fireEvent.click(btns[1]);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('It **saves**.'));
    fireEvent.click(btns[0]);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('What does Save do?'));
  });

  it('markdown tables', () => {
    const { container } = render(<Markdown text={'| Name | Size |\n|---|--:|\n| a.ts | **2** |\n| b.ts | 3 |'} />);
    const ths = [...container.querySelectorAll('thead th')].map(e => e.textContent);
    expect(ths).toEqual(['Name', 'Size']);
    const rows = [...container.querySelectorAll('tbody tr')].map(tr => [...tr.querySelectorAll('td')].map(e => e.textContent));
    expect(rows).toEqual([['a.ts', '2'], ['b.ts', '3']]);
    expect(container.querySelector('tbody strong')!.textContent).toBe('2');
    expect((container.querySelector('tbody td:last-child') as HTMLElement).style.textAlign).toBe('right');
  });

  it('links open in a new tab with rel=noopener; only http(s)/mailto become links', () => {
    const { container } = render(<Markdown text={'See [the docs](https://example.com/a) or https://x.dev/b. Not [this](javascript:alert(1)).'} />);
    const links = [...container.querySelectorAll('a')];
    expect(links.map(a => a.getAttribute('href'))).toEqual(['https://example.com/a', 'https://x.dev/b']);
    expect(links[0].textContent).toBe('the docs');
    for (const a of links) { expect(a.target).toBe('_blank'); expect(a.rel).toContain('noopener'); }
    expect(container.textContent).toContain('[this](javascript:alert(1))');
  });
});

describe('composer: attachments, @files, recall, edit-and-resend', () => {
  const file = (name: string, body = 'hello', type = 'text/plain') => new File([body], name, { type });
  const uploads = () => calls.filter(c => c.url === '/api/projects/p/attachments');

  it('pasting a file uploads it (JSON base64) and shows a chip; send carries the attachment ids', async () => {
    reply = (url, method, body) => (url === '/api/projects/p/attachments'
      ? { status: 201, body: { id: 'att1', name: (body as { name: string }).name, path: 'C:/data/attachments/p/att1-notes.txt' } }
      : method === 'POST' && url === '/api/projects/p/tickets' ? { status: 201, body: tk('n', { status: 'queued' }) } : undefined);
    open([]);
    fireEvent.paste(box(), { clipboardData: { files: [file('notes.txt')] } });
    await waitFor(() => expect(uploads()).toHaveLength(1));
    expect(uploads()[0].body).toEqual({ name: 'notes.txt', dataBase64: btoa('hello') });
    const chips = screen.getByRole('list', { name: /attachments/i });
    await waitFor(() => expect(chips.textContent).not.toMatch(/uploading/));
    expect(chips.textContent).toContain('notes.txt');
    fireEvent.change(box(), { target: { value: 'Read this' } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    await waitFor(() => expect(calls.some(c => c.url === '/api/projects/p/tickets')).toBe(true));
    expect(calls.find(c => c.url === '/api/projects/p/tickets')!.body).toEqual({ text: 'Read this', mode: 'auto', attachments: ['att1'] });
    await waitFor(() => expect(screen.queryByRole('list', { name: /attachments/i })).toBeNull());
  });

  it('dropping files adds chips; × removes one; a too-large file is refused on the client', async () => {
    reply = url => (url === '/api/projects/p/attachments' ? { status: 201, body: { id: 'a', name: 'x.png', path: '/x' } } : undefined);
    open([]);
    const big = file('huge.pdf');
    Object.defineProperty(big, 'size', { value: 11 * 1024 * 1024 });
    fireEvent.drop(document.querySelector('.po-composer')!, { dataTransfer: { files: [file('x.png', 'p', 'image/png'), big], types: ['Files'] } });
    await waitFor(() => expect(uploads()).toHaveLength(1));
    const chips = screen.getByRole('list', { name: /attachments/i });
    expect(chips.textContent).toMatch(/huge\.pdf.*too large/);
    fireEvent.click(screen.getByRole('button', { name: /remove huge\.pdf/i }));
    expect(chips.textContent).not.toContain('huge.pdf');
  });

  it('an upload error shows on the chip', async () => {
    reply = url => (url === '/api/projects/p/attachments' ? { status: 415, body: { error: 'unsupported file type' } } : undefined);
    open([]);
    fireEvent.paste(box(), { clipboardData: { files: [file('a.exe')] } });
    await waitFor(() => expect(screen.getByRole('list', { name: /attachments/i }).textContent).toContain('unsupported file type'));
  });

  it('messages to a running ticket carry attachments too', async () => {
    reply = url => (url === '/api/projects/p/attachments' ? { status: 201, body: { id: 'z', name: 'a.txt', path: '/a' } } : undefined);
    open([tk('r', { status: 'running', stage: 'build', mode: 'ticket' })]);
    fireEvent.paste(box(), { clipboardData: { files: [file('a.txt')] } });
    await waitFor(() => expect(screen.getByRole('list', { name: /attachments/i }).textContent).not.toMatch(/uploading/));
    fireEvent.change(box(), { target: { value: 'see file' } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    await waitFor(() => expect(posts().some(c => c.url === '/api/tickets/r/messages')).toBe(true));
    expect(posts().find(c => c.url === '/api/tickets/r/messages')!.body).toEqual({ text: 'see file', attachments: ['z'] });
  });

  it('@ opens a file search popup (GET files?q=); Enter puts @path in the text', async () => {
    reply = url => (url.startsWith('/api/projects/p/files') ? { status: 200, body: { files: ['src/Login.tsx', 'src/login.css'] } } : undefined);
    open([]);
    fireEvent.change(box(), { target: { value: 'Look at @log' } });
    const list = await screen.findByRole('listbox', { name: /files/i });
    expect(calls.some(c => c.url === '/api/projects/p/files?q=log')).toBe(true);
    expect(list.textContent).toContain('src/Login.tsx');
    fireEvent.keyDown(box(), { key: 'ArrowDown' });
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(box().value).toBe('Look at @src/login.css ');
    expect(screen.queryByRole('listbox', { name: /files/i })).toBeNull();
    expect(posts()).toHaveLength(0);
  });

  it('Esc closes the @ popup without stopping anything', async () => {
    reply = url => (url.startsWith('/api/projects/p/files') ? { status: 200, body: { files: ['a.ts'] } } : undefined);
    open([]);
    fireEvent.change(box(), { target: { value: '@a' } });
    await screen.findByRole('listbox', { name: /files/i });
    fireEvent.keyDown(box(), { key: 'Escape' });
    expect(screen.queryByRole('listbox', { name: /files/i })).toBeNull();
  });

  it('↑ on an empty composer recalls the previous message, ↑ again the one before, ↓ back', () => {
    const A = tk('a', { text: 'First question', mode: 'ask', answered: true });
    const B = tk('b', { text: 'Second one', parentTicketId: 'a', mode: 'ask', answered: true, createdAt: '2026-11-26T10:05:00Z' });
    open([A, B], { feed: { b: [{ kind: 'user', text: 'Second one', id: 'user:1', ts: '' }] } });
    fireEvent.click(screen.getByRole('button', { name: /past conversations/i }));
    fireEvent.click(screen.getByRole('button', { name: /First question/ }));
    fireEvent.keyDown(box(), { key: 'ArrowUp' });
    expect(box().value).toBe('Second one');
    fireEvent.keyDown(box(), { key: 'ArrowUp' });
    expect(box().value).toBe('First question');
    fireEvent.keyDown(box(), { key: 'ArrowDown' });
    expect(box().value).toBe('Second one');
    fireEvent.change(box(), { target: { value: 'typed' } });
    fireEvent.keyDown(box(), { key: 'ArrowUp' });
    expect(box().value).toBe('typed');
  });

  it('✎ on your last message puts it back in the composer; sending continues the thread', async () => {
    const A = tk('a', { text: 'First question', mode: 'ask', answered: true });
    const B = tk('b', { text: 'Second one', parentTicketId: 'a', mode: 'ask', answered: true, createdAt: '2026-11-26T10:05:00Z' });
    open([A, B]);
    fireEvent.click(screen.getByRole('button', { name: /past conversations/i }));
    fireEvent.click(screen.getByRole('button', { name: /First question/ }));
    const edits = screen.getAllByRole('button', { name: /edit and resend/i });
    expect(edits).toHaveLength(1);
    fireEvent.click(edits[0]);
    expect(box().value).toBe('Second one');
    fireEvent.change(box(), { target: { value: 'Second one, shorter' } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]).toMatchObject({ url: '/api/projects/p/tickets', body: { text: 'Second one, shorter', parentTicketId: 'b' } });
  });

  it('attachments on your messages are listed in the bubble; a stopped answer says so', () => {
    useOffice.setState({
      tickets: { t: tk('t', { text: 'Q', attachments: [{ id: 'a1', name: 'shot.png', path: '/x/shot.png' }] }) },
      feed: { t: [{ kind: 'stage', text: 'done', detail: 'stopped', id: 'end:9', ts: '' }] },
    });
    render(<Feed ticketId="t" />);
    expect(screen.getByRole('list', { name: /attached files/i }).textContent).toContain('shot.png');
    expect(screen.getByText(/Stopped by you/)).toBeTruthy();
  });
});

describe('past conversations: rename, pin, delete, search, titles', () => {
  const A = tk('a', { text: 'What does login do?', mode: 'ask', answered: true, createdAt: '2026-11-26T10:00:00Z' });
  const B = tk('b', { text: 'And logout?', parentTicketId: 'a', mode: 'ask', answered: true, createdAt: '2026-11-26T10:05:00Z' });
  const X = tk('x', { text: 'Dark mode', title: 'Dark mode', createdAt: '2026-11-26T11:00:00Z' });
  const pastList = () => {
    if (!screen.queryByRole('list', { name: /past conversations/i })) fireEvent.click(screen.getByRole('button', { name: /past conversations/i }));
    return screen.getByRole('list', { name: /past conversations/i });
  };
  const titles = () => [...pastList().querySelectorAll('.po-past-item .po-past-title')].map(e => e.textContent);
  const rowOf = (re: RegExp) => [...pastList().querySelectorAll<HTMLElement>('li')].find(li => re.test(li.textContent ?? ''))!;

  it('shows the meta title (rename / auto title) instead of the question', () => {
    open([A, B, X], { conversations: { a: { projectId: 'p', title: 'Login flow' } } });
    expect(titles()).toEqual(['🎫 Dark mode', '💬 Login flow']);
    fireEvent.click(within(pastList()).getByRole('button', { name: /Login flow/ }));
    expect(document.querySelector('.po-ticket-title')!.textContent).toBe('Login flow');
  });

  it('snapshot and conversation.updated fill the meta', () => {
    useOffice.getState().apply({ type: 'snapshot', snapshot: { projects: [P], tickets: [A], conversations: { a: { projectId: 'p', title: 'T1' } } } });
    expect(useOffice.getState().conversations.a.title).toBe('T1');
    useOffice.getState().apply({ type: 'conversation.updated', projectId: 'p', ts: '', rootId: 'a', meta: { projectId: 'p', title: 'T2', pinned: true } });
    expect(useOffice.getState().conversations.a).toEqual({ projectId: 'p', title: 'T2', pinned: true });
  });

  it('rename inline: ✎ → input → Enter PATCHes {title}', async () => {
    reply = (url, method) => (url === '/api/conversations/a' && method === 'PATCH' ? { status: 200, body: { rootId: 'a', projectId: 'p', title: 'Login Q' } } : undefined);
    open([A, B, X]);
    fireEvent.click(within(rowOf(/login do/)).getByRole('button', { name: /rename/i }));
    const input = screen.getByRole('textbox', { name: /conversation title/i }) as HTMLInputElement;
    expect(input.value).toBe('What does login do?');
    fireEvent.change(input, { target: { value: 'Login Q' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]).toMatchObject({ url: '/api/conversations/a', method: 'PATCH', body: { title: 'Login Q' } });
    await waitFor(() => expect(titles()).toContain('💬 Login Q'));
  });

  it('Esc cancels a rename without a request', () => {
    open([A, X]);
    fireEvent.click(within(rowOf(/login do/)).getByRole('button', { name: /rename/i }));
    fireEvent.keyDown(screen.getByRole('textbox', { name: /conversation title/i }), { key: 'Escape' });
    expect(screen.queryByRole('textbox', { name: /conversation title/i })).toBeNull();
    expect(posts()).toHaveLength(0);
  });

  it('📌 pin PATCHes {pinned: true}; pinned rows come first', async () => {
    reply = (url, method) => (url === '/api/conversations/a' && method === 'PATCH' ? { status: 200, body: { rootId: 'a', projectId: 'p', pinned: true } } : undefined);
    open([A, B, X]);
    expect(titles()[0]).toContain('Dark mode');
    fireEvent.click(within(rowOf(/login do/)).getByRole('button', { name: /^pin conversation/i }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0].body).toEqual({ pinned: true });
    await waitFor(() => expect(titles()[0]).toContain('What does login do?'));
    expect(within(rowOf(/login do/)).getByRole('button', { name: /unpin/i })).toBeTruthy();
  });

  it('🗑 delete asks inline, then DELETEs (JSON); the row is hidden and the count drops', async () => {
    reply = (url, method) => (url === '/api/conversations/a' && method === 'DELETE' ? { status: 200, body: { rootId: 'a', projectId: 'p', deleted: true } } : undefined);
    open([A, B, X]);
    fireEvent.click(within(rowOf(/login do/)).getByRole('button', { name: /delete conversation/i }));
    expect(posts()).toHaveLength(0);
    fireEvent.click(within(screen.getByRole('group', { name: /confirm delete/i })).getByRole('button', { name: /^delete$/i }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]).toMatchObject({ url: '/api/conversations/a', method: 'DELETE' });
    const init = (fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls.find(c => c[1]?.method === 'DELETE')![1];
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    await waitFor(() => expect(titles()).toEqual(['🎫 Dark mode']));
    expect(screen.getByRole('button', { name: /past conversations/i }).textContent).toContain('1');
  });

  it('a server error shows inline on the row', async () => {
    reply = url => (url === '/api/conversations/a' ? { status: 404, body: { error: 'no such conversation' } } : undefined);
    open([A, X]);
    fireEvent.click(within(rowOf(/login do/)).getByRole('button', { name: /^pin conversation/i }));
    await waitFor(() => expect(screen.getByText('no such conversation')).toBeTruthy());
  });

  it('search matches titles and message text', () => {
    open([A, B, X], { feed: { b: [{ kind: 'message', role: 'pm', text: 'It clears the session cookie.', id: 'm', ts: '' }] } });
    pastList();
    fireEvent.change(screen.getByRole('textbox', { name: /filter conversations/i }), { target: { value: 'cookie' } });
    expect(titles()).toEqual(['💬 What does login do?']);
    fireEvent.change(screen.getByRole('textbox', { name: /filter conversations/i }), { target: { value: 'dark' } });
    expect(titles()).toEqual(['🎫 Dark mode']);
  });
});

describe('tool activity grouping', () => {
  const tool = (id: string, tool: string, text: string, status = 'ok') => ({ kind: 'tool' as const, role: 'pm' as const, tool, text, status, id, ts: '' });

  it('toolSummary counts by kind, in order of first use', () => {
    expect(toolSummary([
      { tool: 'Read', text: 'Read a' }, { tool: 'Grep', text: 'Grep x' }, { tool: 'Read', text: 'Read b' }, { tool: 'Bash', text: 'npm test' },
      { tool: 'Glob', text: '**/*.ts' }, { tool: 'Bash', text: 'git status' }, { tool: 'Read', text: 'Read c' }, { tool: 'TodoWrite', text: 'todos' },
    ])).toBe('Read 3 files · Searched 2 times · Ran 2 commands · TodoWrite ×1');
    expect(toolSummary([{ text: 'Read src/a.ts' }, { text: 'Edit src/a.ts (+1 −1)' }])).toBe('Read 1 file · Edited 1 file');
  });

  it('consecutive tool lines collapse into one expandable summary; a single tool line stays as is', () => {
    useOffice.setState({ feed: { t: [
      tool('r1', 'Read', 'Read src/a.ts'), tool('r2', 'Read', 'Read src/b.ts'), tool('g1', 'Grep', 'Grep "login"'),
      { kind: 'message', role: 'pm', text: 'Found it.', id: 'm', ts: '' },
      tool('b1', 'Bash', 'npm test'),
    ] } });
    render(<Feed ticketId="t" />);
    const group = screen.getByRole('button', { name: /Read 2 files · Searched 1 time/ });
    expect(screen.queryByText('Read src/a.ts')).toBeNull();
    expect(screen.getByText('npm test')).toBeTruthy();
    fireEvent.click(group);
    expect(group.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('Read src/a.ts')).toBeTruthy();
    expect(screen.getByText('Grep "login"')).toBeTruthy();
    fireEvent.click(group);
    expect(screen.queryByText('Read src/a.ts')).toBeNull();
  });

  it('the group shows running while any tool runs, error if one failed', () => {
    useOffice.setState({ feed: { t: [tool('a', 'Read', 'Read a'), tool('b', 'Bash', 'npm test', 'running')] } });
    const { container, unmount } = render(<Feed ticketId="t" />);
    expect(container.querySelector('.po-toolgroup .po-tool-dot')!.className).toContain('running');
    unmount();
    useOffice.setState({ feed: { t: [tool('a', 'Read', 'Read a'), tool('b', 'Bash', 'npm test', 'error')] } });
    const r = render(<Feed ticketId="t" />);
    expect(r.container.querySelector('.po-toolgroup .po-tool-dot')!.className).toContain('error');
  });

  it('agent.tool events keep the tool name on the feed item', () => {
    useOffice.getState().apply({ type: 'ticket.created', ticket: tk('t'), projectId: 'p', ticketId: 't', ts: '', seq: 1 });
    useOffice.getState().apply({ type: 'agent.tool', role: 'pm', tool: 'Grep', summary: 'Grep x', status: 'ok', toolId: 'g', projectId: 'p', ticketId: 't', ts: '', seq: 2 });
    expect(useOffice.getState().feed.t.find(f => f.kind === 'tool')!.tool).toBe('Grep');
  });
});

describe('shortcuts', () => {
  const A = tk('a', { text: 'What does login do?', mode: 'ask', answered: true });

  it('Ctrl+K starts a new conversation (even while typing)', async () => {
    open([A]);
    fireEvent.click(screen.getByRole('button', { name: /past conversations/i }));
    fireEvent.click(screen.getByRole('button', { name: /What does login do/ }));
    expect(screen.queryByText(/Shop is ready/)).toBeNull();
    fireEvent.keyDown(box(), { key: 'k', ctrlKey: true });
    expect(screen.getByText(/Shop is ready/)).toBeTruthy();
    fireEvent.change(box(), { target: { value: 'Brand new' } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0].body).toEqual({ text: 'Brand new', mode: 'auto' });
  });

  it('Ctrl+/ opens the slash menu in the composer', async () => {
    open([A]);
    fireEvent.keyDown(window, { key: '/', ctrlKey: true });
    expect(box().value).toBe('/');
    expect(screen.getByRole('listbox', { name: /commands/i })).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(box()));
  });

  it('Esc closes popups first: the slash menu, then the past list, then the drawer', () => {
    open([A]);
    fireEvent.keyDown(window, { key: '/', ctrlKey: true });
    fireEvent.keyDown(box(), { key: 'Escape' });
    expect(screen.queryByRole('listbox', { name: /commands/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /past conversations/i }));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('list', { name: /past conversations/i })).toBeNull();
    expect(useOffice.getState().selectedProjectId).toBe('p');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(useOffice.getState().selectedProjectId).toBeNull();
  });
});

describe('full-screen chat', () => {
  it('⛶ expands the drawer; ⛶ again or Esc restores (Esc then closes the drawer)', () => {
    open([tk('a', { mode: 'ask', answered: true })]);
    const drawer = () => document.querySelector('.po-drawer') as HTMLElement;
    expect(drawer().style.width).toBe('560px');
    fireEvent.click(screen.getByRole('button', { name: 'Full screen' }));
    expect(drawer().className).toContain('full');
    expect(drawer().style.width).toContain('100vw');
    fireEvent.click(screen.getByRole('button', { name: 'Exit full screen' }));
    expect(drawer().className).not.toContain('full');
    fireEvent.click(screen.getByRole('button', { name: 'Full screen' }));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(drawer().className).not.toContain('full');
    expect(useOffice.getState().selectedProjectId).toBe('p');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(useOffice.getState().selectedProjectId).toBeNull();
  });
});
