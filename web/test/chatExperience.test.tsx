// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';
import type { Project, Ticket } from '@office/shared';
import { useOffice, resetOffice } from '../src/state/store';
import { Drawer } from '../src/ui/Drawer';
import { Feed } from '../src/ui/Feed';
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
