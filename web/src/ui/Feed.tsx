import { Fragment, useState } from 'react';
import { Markdown } from './Markdown';
import { CopyButton } from './CopyButton';
import { useOffice, type FeedItem } from '../state/store';
import { clock, isFinished, roleColor, roleEmoji, roleShort, STAGE_LABEL, usageLine } from './format';
import { GateCard } from './GateCard';
import { useFollow } from './useFollow';
import type { Attachment, Stage, Ticket } from '@office/shared';

const EMPTY: FeedItem[] = [];

/** Unified-diff text with +/−/@@ lines coloured. */
export function DiffText({ text }: { text: string }) {
  return (
    <pre className="po-diff">
      {text.split('\n').map((l, i) => {
        const c = l.startsWith('+++') || l.startsWith('---') ? 'meta' : l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : l.startsWith('@@') ? 'hunk' : '';
        return <div key={i} className={c}>{l || ' '}</div>;
      })}
    </pre>
  );
}

const looksLikeDiff = (s: string) => /^(@@|[+-])/m.test(s);

function ToolLine({ item }: { item: FeedItem }) {
  const [open, setOpen] = useState(false);
  const status = item.status ?? 'ok';
  return (
    <div className={`po-tool ${status}${open ? ' open' : ''}`}>
      <button type="button" className="po-tool-line" aria-expanded={open} onClick={() => setOpen(o => !o)}>
        <span className="po-tool-tree" aria-hidden>⎿</span>
        <span className={`po-tool-dot ${status}`} aria-hidden>●</span>
        <span className="po-tool-sum">{item.text}</span>
        <span className="po-tool-caret" aria-hidden>{open ? '▾' : '▸'}</span>
      </button>
      {open && (item.detail
        ? (looksLikeDiff(item.detail) ? <DiffText text={item.detail} /> : <pre className="po-tool-detail">{item.detail}</pre>)
        : <pre className="po-tool-detail po-dim">(no output)</pre>)}
    </div>
  );
}

/** Tool name → the verb of the activity summary (by tool name, else the summary's first word). */
const TOOL_KIND: Record<string, 'read' | 'search' | 'run' | 'edit' | 'web' | 'agent'> = {
  read: 'read', notebookread: 'read',
  grep: 'search', glob: 'search', search: 'search', ls: 'search', find: 'search',
  bash: 'run', powershell: 'run', bashoutput: 'run', shell: 'run',
  edit: 'edit', write: 'edit', multiedit: 'edit', notebookedit: 'edit',
  webfetch: 'web', websearch: 'web', task: 'agent', agent: 'agent',
};
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const PHRASE: Record<string, (n: number) => string> = {
  read: n => `Read ${plural(n, 'file')}`, search: n => `Searched ${plural(n, 'time')}`, run: n => `Ran ${plural(n, 'command')}`,
  edit: n => `Edited ${plural(n, 'file')}`, web: n => `Fetched ${plural(n, 'page')}`, agent: n => `Ran ${plural(n, 'agent')}`,
};
/** "Read 6 files · Searched 3 times · Ran 2 commands" (in order of first use; other tools by name). */
export function toolSummary(items: Pick<FeedItem, 'tool' | 'text'>[]): string {
  const counts = new Map<string, number>();
  for (const i of items) {
    const name = (i.tool || i.text.split(/[\s(:]/)[0] || 'tool').trim();
    const k = TOOL_KIND[name.toLowerCase()] ?? name;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts].map(([k, n]) => PHRASE[k]?.(n) ?? `${k} ×${n}`).join(' · ');
}

/** Consecutive tool lines as one summary line (expand to see each). */
function ToolGroup({ items }: { items: FeedItem[] }) {
  const [open, setOpen] = useState(false);
  const status = items.some(i => i.status === 'running') ? 'running' : items.some(i => i.status === 'error') ? 'error' : 'ok';
  return (
    <div className={`po-toolgroup${open ? ' open' : ''}`}>
      <div className={`po-tool ${status}`}>
        <button type="button" className="po-tool-line" aria-expanded={open} onClick={() => setOpen(o => !o)}>
          <span className="po-tool-tree" aria-hidden>⎿</span>
          <span className={`po-tool-dot ${status}`} aria-hidden>●</span>
          <span className="po-tool-sum">{toolSummary(items)}</span>
          <span className="po-tool-caret" aria-hidden>{open ? '▾' : '▸'}</span>
        </button>
      </div>
      {open && <div className="po-toolgroup-items">{items.map(i => <ToolLine key={i.id} item={i} />)}</div>}
    </div>
  );
}

type Block = { item: FeedItem } | { tools: FeedItem[] };
/** Runs of 2+ consecutive tool items become one group. */
function blocks(items: FeedItem[]): Block[] {
  const out: Block[] = [];
  let run: FeedItem[] = [];
  const flush = () => { if (run.length === 1) out.push({ item: run[0] }); else if (run.length) out.push({ tools: run }); run = []; };
  for (const i of items) { if (i.kind === 'tool') run.push(i); else { flush(); out.push({ item: i }); } }
  flush();
  return out;
}

/** Markdown answer text. */
export function Answer({ text }: { text: string }) {
  return <Markdown text={text} className="po-msg-text po-answer" />;
}

function YouBubble({ text, ts, attachments, onEdit }: { text: string; ts: string; attachments?: Attachment[]; onEdit?: (text: string) => void }) {
  return (
    <div className="po-you">
      <div className="po-you-head">
        <span className="po-you-who">You</span><span className="po-dim po-time">{ts ? clock(ts) : ''}</span>
        <span className="po-msg-actions">
          {onEdit && <button type="button" className="po-msg-act" aria-label="Edit and resend" title="Edit and resend" onClick={() => onEdit(text)}>✎</button>}
          <CopyButton text={text} label="Copy message" />
        </span>
      </div>
      <div className="po-you-text">{text}</div>
      {!!attachments?.length && (
        <ul className="po-chips po-you-att" aria-label="Attached files">
          {attachments.map(a => <li key={a.id} className="po-att ready" title={a.path}><span aria-hidden>📎</span><span className="po-att-name">{a.name}</span></li>)}
        </ul>
      )}
    </div>
  );
}

/** Whether a ticket's own text gets a You bubble (not when its feed already starts with that message). */
const ownBubble = (ticket: Ticket | undefined, feed: FeedItem[]) =>
  !!ticket?.text.trim() && !(feed[0]?.kind === 'user' && feed[0].text.trim() === ticket.text.trim());

function Who({ item }: { item: FeedItem }) {
  if (!item.role) return null;
  return (
    <span className="po-who" style={{ color: roleColor(item.role) }}>
      <span aria-hidden>{roleEmoji(item.role)}</span> {roleShort(item.role)}
    </span>
  );
}

function Row({ item, ticketId, onShow, onEdit }: { item: FeedItem; ticketId: string; onShow?: (tab: 'plan' | 'changes') => void; onEdit?: (text: string) => void }) {
  switch (item.kind) {
    case 'stage': {
      const end = item.text === 'done' || item.text === 'failed' || item.text === 'cancelled';
      const label = item.text === 'done' ? (item.detail === 'stopped' ? '■ Stopped by you' : '✓ done') : item.text === 'failed' ? `✕ failed${item.detail ? ` · ${item.detail}` : ''}`
        : item.text === 'cancelled' ? '⊘ cancelled' : `${STAGE_LABEL[item.text as Stage] ?? item.text}${item.detail ? ` · ${item.detail}` : ''}`;
      return <div className={`po-stage${end ? ` end ${item.text}` : ''}`}><span>{label}</span><span className="po-dim po-time">{clock(item.ts)}</span></div>;
    }
    case 'message':
      return (
        <div className="po-msg">
          <div className="po-msg-head">
            <Who item={item} /><span className="po-dim po-time">{clock(item.ts)}</span>
            {item.status !== 'streaming' && <span className="po-msg-actions"><CopyButton text={item.text} label="Copy message" /></span>}
          </div>
          {item.answer ? <Answer text={item.text} />
            : <div className="po-msg-text po-answer"><Markdown text={item.text} />{item.status === 'streaming' && <span className="po-cursor" aria-hidden>▍</span>}</div>}
        </div>
      );
    case 'tool':
      return <ToolLine item={item} />;
    case 'user':
      return <YouBubble text={item.text} ts={item.ts} attachments={item.attachments} onEdit={onEdit} />;
    case 'gate':
      return <GateCard ticketId={ticketId} item={item} onShow={onShow} />;
  }
}


/** One ticket of a conversation: the owner's bubble, then its items and (once finished) the usage line. */
function TicketItems({ ticketId, onShow, lastYou, onEdit }: {
  ticketId: string; onShow?: (tab: 'plan' | 'changes') => void;
  /** Key of the conversation's last You bubble (gets the ✎ edit-and-resend). */
  lastYou?: string; onEdit?: (text: string) => void;
}) {
  const all = useOffice(s => s.feed[ticketId] ?? EMPTY);
  const filter = useOffice(s => s.roleFilter);
  const ticket = useOffice(s => s.tickets[ticketId]);
  const usage = ticket && isFinished(ticket) ? ticket.usage : undefined;
  const items = filter === 'all' ? all : all.filter(i => !i.role || i.role === filter);
  const own = ownBubble(ticket, all) ? ticket : undefined;
  const editFor = (k: string) => (onEdit && lastYou === k ? onEdit : undefined);
  return <>
    {own && <YouBubble text={own.text} ts={own.createdAt} attachments={own.attachments} onEdit={editFor(`${ticketId}:own`)} />}
    {blocks(items).map(b => ('tools' in b
      ? <ToolGroup key={`tools:${b.tools[0].id}`} items={b.tools} />
      : <Row key={`${b.item.kind}:${b.item.id}`} item={b.item} ticketId={ticketId} onShow={onShow} onEdit={b.item.kind === 'user' ? editFor(`${ticketId}:${b.item.id}`) : undefined} />))}
    {usage && <div className="po-usage">{usageLine(usage)}</div>}
  </>;
}

/**
 * Per-role messages, collapsed tool calls (click to expand), stage dividers, owner messages and gate cards — for one
 * ticket, or a whole conversation (`ticketIds`, oldest first, a thin separator between tickets).
 */
export function Feed({ ticketId, ticketIds, onShow, onEdit }: {
  ticketId?: string; ticketIds?: string[]; onShow?: (tab: 'plan' | 'changes') => void;
  /** ✎ on the owner's last message: puts it back in the composer. */
  onEdit?: (text: string) => void;
}) {
  const ids = ticketIds ?? (ticketId ? [ticketId] : []);
  const feeds = useOffice(s => s.feed);
  const tickets = useOffice(s => s.tickets);
  const lastId = ids[ids.length - 1];
  const tail = (lastId && feeds[lastId]) || EMPTY;
  const last = tail[tail.length - 1];
  const empty = ids.every(id => !feeds[id]?.length && !tickets[id]?.text.trim());
  let lastYou: string | undefined;
  for (const id of [...ids].reverse()) {
    const f = feeds[id] ?? EMPTY;
    const u = [...f].reverse().find(i => i.kind === 'user');
    if (u) { lastYou = `${id}:${u.id}`; break; }
    if (ownBubble(tickets[id], f)) { lastYou = `${id}:own`; break; }
  }
  const { ref, paused, onScroll, follow } = useFollow<HTMLDivElement>(`${ids.length}:${tail.length}:${last?.text.length ?? 0}:${last?.status ?? ''}`);
  return (
    <div className="po-scroll-wrap">
      <div className="po-scroll po-feed" ref={ref} onScroll={onScroll}>
        {empty && <div className="po-empty">No activity yet.</div>}
        {ids.map((id, i) => (
          <Fragment key={id}>
            {i > 0 && <div className="po-turn-sep" role="separator" />}
            <TicketItems ticketId={id} onShow={onShow} lastYou={lastYou} onEdit={onEdit} />
          </Fragment>
        ))}
      </div>
      {paused && <button type="button" className="po-follow" onClick={follow}>↓ follow</button>}
    </div>
  );
}
