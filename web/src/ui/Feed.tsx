import { useState } from 'react';
import { useOffice, type FeedItem } from '../state/store';
import { clock, isFinished, roleColor, roleEmoji, roleShort, STAGE_LABEL, usageLine } from './format';
import { GateCard } from './GateCard';
import { useFollow } from './useFollow';
import type { Stage } from '@office/shared';

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

function Who({ item }: { item: FeedItem }) {
  if (!item.role) return null;
  return (
    <span className="po-who" style={{ color: roleColor(item.role) }}>
      <span aria-hidden>{roleEmoji(item.role)}</span> {roleShort(item.role)}
    </span>
  );
}

function Row({ item, ticketId, onShow }: { item: FeedItem; ticketId: string; onShow?: (tab: 'plan' | 'changes') => void }) {
  switch (item.kind) {
    case 'stage': {
      const end = item.text === 'done' || item.text === 'failed' || item.text === 'cancelled';
      const label = item.text === 'done' ? '✓ done' : item.text === 'failed' ? `✕ failed${item.detail ? ` · ${item.detail}` : ''}`
        : item.text === 'cancelled' ? '⊘ cancelled' : `${STAGE_LABEL[item.text as Stage] ?? item.text}${item.detail ? ` · ${item.detail}` : ''}`;
      return <div className={`po-stage${end ? ` end ${item.text}` : ''}`}><span>{label}</span><span className="po-dim po-time">{clock(item.ts)}</span></div>;
    }
    case 'message':
      return (
        <div className="po-msg">
          <div className="po-msg-head"><Who item={item} /><span className="po-dim po-time">{clock(item.ts)}</span></div>
          <div className="po-msg-text">{item.text}{item.status === 'streaming' && <span className="po-cursor" aria-hidden>▍</span>}</div>
        </div>
      );
    case 'tool':
      return <ToolLine item={item} />;
    case 'user':
      return <div className="po-user"><span className="po-prompt" aria-hidden>›</span><span>{item.text}</span><span className="po-dim po-time">{clock(item.ts)}</span></div>;
    case 'gate':
      return <GateCard ticketId={ticketId} item={item} onShow={onShow} />;
  }
}

/** Per-role messages, collapsed tool calls (click to expand), stage dividers, owner messages and gate cards. */
export function Feed({ ticketId, onShow }: { ticketId: string; onShow?: (tab: 'plan' | 'changes') => void }) {
  const all = useOffice(s => s.feed[ticketId] ?? EMPTY);
  const filter = useOffice(s => s.roleFilter);
  const ticket = useOffice(s => s.tickets[ticketId]);
  const usage = ticket && isFinished(ticket) ? ticket.usage : undefined;
  const items = filter === 'all' ? all : all.filter(i => !i.role || i.role === filter);
  const last = all[all.length - 1];
  const { ref, paused, onScroll, follow } = useFollow<HTMLDivElement>(`${all.length}:${last?.text.length ?? 0}:${last?.status ?? ''}`);
  return (
    <div className="po-scroll-wrap">
      <div className="po-scroll po-feed" ref={ref} onScroll={onScroll}>
        {items.length === 0 && <div className="po-empty">No activity yet.</div>}
        {items.map(i => <Row key={`${i.kind}:${i.id}`} item={i} ticketId={ticketId} onShow={onShow} />)}
        {usage && <div className="po-usage">{usageLine(usage)}</div>}
      </div>
      {paused && <button type="button" className="po-follow" onClick={follow}>↓ follow</button>}
    </div>
  );
}
