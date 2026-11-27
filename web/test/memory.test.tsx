// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';
import type { MemoryEntry, Project } from '@office/shared';
import { useOffice, resetOffice } from '../src/state/store';
import { dispatch } from '../src/state/socket';
import { Drawer } from '../src/ui/Drawer';
import { suggest } from '../src/ui/slash';

const P: Project = { id: 'p', name: 'Shop', folder: '.', accent: 'cyan', team: ['pm', 'techlead', 'frontend', 'backend', 'qa'], slot: 0, looks: {} as Project['looks'], createdAt: '' };
type Call = { url: string; method: string; body: unknown };
let calls: Call[];
let entries: MemoryEntry[];
let fail: string | null;

beforeEach(() => {
  resetOffice();
  calls = []; fail = null;
  entries = [
    { id: 'm1', text: 'Tests: npm test -w web', source: 'owner', at: '2026-11-27T08:00:00Z' },
    { id: 'm2', text: 'Never edit dist/', source: 'pm', ticketId: 't1', at: '2026-11-27T09:00:00Z' },
  ];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });
    if (!url.startsWith('/api/projects/p/memory')) return json({});
    if (fail && method !== 'GET') return json({ error: fail }, 400);
    if (method === 'POST') entries = [...entries, { id: `m${entries.length + 1}`, text: body.text, source: 'owner', at: '2026-11-27T10:00:00Z' }];
    if (method === 'PATCH') entries = entries.map(e => (url.endsWith(`/${e.id}`) ? { ...e, text: body.text } : e));
    if (method === 'DELETE') entries = entries.filter(e => !url.endsWith(`/${e.id}`));
    return json({ entries });
  }));
  useOffice.setState({ projects: { p: P }, tickets: {}, selectedProjectId: 'p', synced: true });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const memCalls = () => calls.filter(c => c.url.startsWith('/api/projects/p/memory'));
const openTab = async () => {
  render(<Drawer projectId="p" />);
  fireEvent.click(screen.getByRole('tab', { name: 'Memory' }));
  await screen.findByText('Tests: npm test -w web');
};

describe('Memory tab', () => {
  it('lists the entries with their source', async () => {
    await openTab();
    expect(memCalls()[0]).toMatchObject({ url: '/api/projects/p/memory', method: 'GET' });
    expect(screen.getByText('Never edit dist/')).toBeTruthy();
    expect(screen.getByText('learned by the PM')).toBeTruthy();
    expect(screen.getByText(/2\/60 entries/)).toBeTruthy();
  });

  it('adds an entry (POST {text}) and clears the box', async () => {
    await openTab();
    const box = screen.getByRole('textbox', { name: /new memory entry/i }) as HTMLTextAreaElement;
    expect(box.maxLength).toBe(300);
    fireEvent.change(box, { target: { value: '  Use pnpm, not npm  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Remember' }));
    await screen.findByText('Use pnpm, not npm');
    expect(memCalls().find(c => c.method === 'POST')).toMatchObject({ url: '/api/projects/p/memory', body: { text: 'Use pnpm, not npm' } });
    expect(box.value).toBe('');
  });

  it('edits (PATCH) and deletes (DELETE) an entry', async () => {
    await openTab();
    fireEvent.click(screen.getByRole('button', { name: 'Edit: Never edit dist/' }));
    fireEvent.change(screen.getByRole('textbox', { name: /edit memory entry/i }), { target: { value: 'Never edit build/' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Never edit build/');
    expect(memCalls().find(c => c.method === 'PATCH')).toMatchObject({ url: '/api/projects/p/memory/m2', body: { text: 'Never edit build/' } });
    fireEvent.click(screen.getByRole('button', { name: 'Delete: Tests: npm test -w web' }));
    await waitFor(() => expect(screen.queryByText('Tests: npm test -w web')).toBeNull());
    expect(memCalls().find(c => c.method === 'DELETE')?.url).toBe('/api/projects/p/memory/m1');
  });

  it('shows the server error inline', async () => {
    await openTab();
    fail = 'Memory is full (60 entries)';
    fireEvent.change(screen.getByRole('textbox', { name: /new memory entry/i }), { target: { value: 'One more' } });
    fireEvent.click(screen.getByRole('button', { name: 'Remember' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Memory is full (60 entries)');
  });

  it('refetches on memory.updated for this project', async () => {
    await openTab();
    const before = memCalls().filter(c => c.method === 'GET').length;
    entries = [...entries, { id: 'm9', text: 'Learned: the API is on port 5175', source: 'pm', at: '2026-11-27T11:00:00Z' }];
    act(() => dispatch({ type: 'memory.updated', projectId: 'p', ts: '' }));
    await screen.findByText('Learned: the API is on port 5175');
    expect(memCalls().filter(c => c.method === 'GET').length).toBe(before + 1);
  });

  it('/memory opens the tab; it is listed in the slash menu', async () => {
    expect(suggest('/me').map(s => s.label)).toEqual(['/memory']);
    render(<Drawer projectId="p" />);
    const box = screen.getByRole('textbox', { name: /message/i });
    fireEvent.change(box, { target: { value: '/memory' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await screen.findByText('Tests: npm test -w web');
    expect(screen.getByRole('tab', { name: 'Memory' }).getAttribute('aria-selected')).toBe('true');
  });
});
