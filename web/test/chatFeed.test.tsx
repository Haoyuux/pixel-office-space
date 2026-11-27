// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { Ticket } from '@office/shared';
import { useOffice, resetOffice } from '../src/state/store';
import { Feed } from '../src/ui/Feed';
import { Markdown } from '../src/ui/Markdown';
import { readFileSync } from 'node:fs';

const ticket = (o: Partial<Ticket> = {}): Ticket => ({ id: 't', projectId: 'p', title: 'Q', text: 'What does Save do?', status: 'running', stage: 'build', agentStates: {}, createdAt: '2026-11-26T10:00:00Z', ...o });
beforeEach(() => { cleanup(); resetOffice(); });

describe('owner message first', () => {
  it('shows a You bubble before agent output', () => {
    useOffice.setState({ tickets: { t: ticket() }, feed: { t: [{ kind: 'message', role: 'pm', text: 'It saves.', id: 'm', ts: '2026-11-26T10:00:01Z' }] } });
    const { container } = render(<Feed ticketId="t" />);
    const first = container.querySelector('.po-feed')!.firstElementChild as HTMLElement;
    expect(first.className).toContain('po-you');
    expect(first.textContent).toContain('You');
    expect(first.textContent).toContain('What does Save do?');
  });
  it('does not duplicate when the feed already starts with that text', () => {
    useOffice.setState({ tickets: { t: ticket() }, feed: { t: [{ kind: 'user', text: 'What does Save do?', id: 'u', ts: '2026-11-26T10:00:00Z' }] } });
    render(<Feed ticketId="t" />);
    expect(screen.getAllByText('What does Save do?')).toHaveLength(1);
  });
  it('mid-ticket user items use the same bubble', () => {
    useOffice.setState({ tickets: { t: ticket() }, feed: { t: [{ kind: 'user', text: 'also add X', id: 'u', ts: '2026-11-26T10:00:00Z' }] } });
    const { container } = render(<Feed ticketId="t" />);
    expect(container.querySelectorAll('.po-you')).toHaveLength(2);
  });
});

describe('Markdown', () => {
  it('renders bold, italic, code, headings, lists and fences without raw markers', () => {
    const { container } = render(<Markdown text={'# Title\nSome **bold** and *it* and `code`.\n\n- a\n- b\n\n1. x\n2. y\n\n```\nlet a = **1**;\n```'} />);
    expect(container.querySelector('h4')!.textContent).toBe('Title');
    expect(container.querySelector('strong')!.textContent).toBe('bold');
    expect(container.querySelector('em')!.textContent).toBe('it');
    expect(container.querySelector('p code')!.textContent).toBe('code');
    expect(container.querySelectorAll('ul li')).toHaveLength(2);
    expect(container.querySelectorAll('ol li')).toHaveLength(2);
    expect(container.querySelector('pre')!.textContent).toBe('let a = **1**;');
    expect(container.textContent).not.toContain('# Title');
  });
  it('is safe: html stays text; unknown syntax plain', () => {
    const { container } = render(<Markdown text={'<img src=x onerror=1> [l](u) **open'} />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror=1> [l](u) **open');
  });
  it('agent messages use markdown, tool lines do not', () => {
    useOffice.setState({ feed: { t: [
      { kind: 'message', role: 'pm', text: 'It is **bold**', id: 'm', ts: '' },
      { kind: 'tool', role: 'pm', text: 'Read **x**', id: 'x', ts: '' },
    ] } });
    const { container } = render(<Feed ticketId="t" />);
    expect(container.querySelectorAll('strong')).toHaveLength(1);
  });
});

describe('composer layout css', () => {
  it('composer never shrinks and dialog mode rules are scoped', () => {
    const css = readFileSync('src/ui/theme.css', 'utf8');
    expect(css).toMatch(/\.po-composer \{[^}]*flex: none/);
    expect(css).not.toMatch(/^\.po-mode \{ display: flex/m);
  });
});
