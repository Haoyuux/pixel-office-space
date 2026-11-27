import { useEffect, useState } from 'react';
import type { Summary, SummaryProject } from '@office/shared';
import { useOffice } from '../state/store';
import { api, paths } from './api';
import { Modal } from './Modal';
import { accentCss, relativeDate, STATUS_ICON, usageLine } from './format';

/**
 * Summary board (M3 §2): what happened across the projects since a moment (the last visit by default), from
 * GET /api/summary?since=. Waiting items first (they need the owner), then the recent items and the usage.
 */

export const LAST_VISIT_KEY = 'pixel-office.lastVisit';
type VisitStorage = Pick<Storage, 'getItem' | 'setItem'>;
const storage = (): VisitStorage | undefined => (typeof localStorage === 'undefined' ? undefined : localStorage);

/** The previous visit (ISO) read once per page load; the stored value then becomes "now". */
let previous: string | null | undefined;

/** Records this visit (once per page load): returns the previous one (null on the first visit ever) and stores `now`. */
export function recordVisit(now = new Date(), s: VisitStorage | undefined = storage()): string | null {
  if (previous !== undefined) return previous;
  let prev: string | null = null;
  try { prev = s?.getItem(LAST_VISIT_KEY) ?? null; } catch { /* storage unavailable */ }
  try { s?.setItem(LAST_VISIT_KEY, now.toISOString()); } catch { /* storage unavailable */ }
  if (prev && !Number.isFinite(Date.parse(prev))) prev = null;
  previous = prev;
  return prev;
}

/** The previous visit seen by this page load (undefined before recordVisit ran). */
export const previousVisit = () => previous ?? null;
/** Tests. */
export const resetVisit = () => { previous = undefined; };

const dayOf = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

/** First visit of a calendar day (local time): the summary covers everything since the previous visit. */
export function autoOpenSince(prev: string | null, now = new Date()): string | null {
  if (!prev) return null;
  const t = new Date(prev);
  if (Number.isNaN(t.getTime()) || dayOf(t) === dayOf(now)) return null;
  return prev;
}

/** Anything worth showing: a finished / failed / answered item, something waiting, any recent item. */
export const hasNews = (s: Summary | null | undefined): boolean =>
  !!s?.projects?.some(p => p.finished || p.failed || p.answered || p.waiting?.length || p.items?.length);

/** Page load: if this is the day's first visit and anything happened since the last one, calls `open(since)`. */
export async function checkDailySummary(open: (since: string) => void, now = new Date()): Promise<void> {
  const since = autoOpenSince(recordVisit(now), now);
  if (!since) return;
  const r = await api<Summary>('GET', paths.summary(since));
  if (r.ok && hasNews(r.data)) open(since);
}

const DAY = 86400000;
type Range = 'visit' | 'day' | 'week';
const sinceOf = (range: Range, visit: string | null, now: number) =>
  range === 'visit' && visit ? visit : new Date(now - (range === 'week' ? 7 * DAY : DAY)).toISOString();

/** The panel. `since` = start of the range (defaults to the previous visit, else the last 24 h). */
export function SummaryPanel({ since: initial, onClose }: { since?: string; onClose: () => void }) {
  const visit = previousVisit();
  const [range, setRange] = useState<Range>(initial || visit ? 'visit' : 'day');
  const [now] = useState(() => Date.now());
  const since = range === 'visit' && initial ? initial : sinceOf(range, visit, now);
  const [data, setData] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setData(null); setError(null);
    void api<Summary>('GET', paths.summary(since)).then(r => {
      if (!live) return;
      if (r.ok) setData(r.data); else setError(r.error);
    });
    return () => { live = false; };
  }, [since]);
  const open = (projectId: string, rootId: string) => { useOffice.getState().openConversation(projectId, rootId); onClose(); };
  const projects = (data?.projects ?? []).slice().sort((a, b) => (b.waiting?.length ?? 0) - (a.waiting?.length ?? 0));
  return (
    <Modal title="📋 Summary" onClose={onClose}>
      <div className="po-sum">
        <div className="po-sum-range" role="group" aria-label="Summary range">
          <span className="po-dim">since</span>
          {(initial || visit) && <button type="button" className={`po-hbtn${range === 'visit' ? ' on' : ''}`} aria-pressed={range === 'visit'} onClick={() => setRange('visit')}>
            last visit · {relativeDate(initial ?? visit!, now)}</button>}
          <button type="button" className={`po-hbtn${range === 'day' ? ' on' : ''}`} aria-pressed={range === 'day'} onClick={() => setRange('day')}>24 h</button>
          <button type="button" className={`po-hbtn${range === 'week' ? ' on' : ''}`} aria-pressed={range === 'week'} onClick={() => setRange('week')}>7 days</button>
        </div>
        {error && <div className="po-error" role="alert">{error}</div>}
        {!data && !error && <div className="po-dim" role="status">Loading…</div>}
        {data && !hasNews(data) && <div className="po-dim po-sum-empty">Nothing happened in this range.</div>}
        {data && projects.filter(p => p.finished || p.failed || p.answered || p.waiting?.length || p.items?.length)
          .map(p => <ProjectCard key={p.projectId} p={p} now={now} onOpen={open} />)}
      </div>
    </Modal>
  );
}

function ProjectCard({ p, now, onOpen }: { p: SummaryProject; now: number; onOpen: (projectId: string, rootId: string) => void }) {
  const accent = useOffice(s => s.projects[p.projectId]?.accent);
  const waiting = p.waiting ?? [], items = p.items ?? [];
  const counts = [p.finished && `✓ ${p.finished} finished`, p.answered && `💬 ${p.answered} answered`, p.failed && `✕ ${p.failed} failed`,
    waiting.length && `⏸ ${waiting.length} waiting`].filter(Boolean).join(' · ');
  return (
    <section className="po-sum-card" aria-label={`${p.name} summary`} style={{ ['--accent' as string]: accentCss(accent) }}>
      <header className="po-sum-head"><b className="po-sum-name">{p.name}</b><span className="po-dim">{counts || 'no news'}</span></header>
      {waiting.length > 0 && <ul className="po-sum-list waiting" aria-label="Waiting for you">
        {waiting.map(w => (
          <li key={w.ticketId}><button type="button" className="po-sum-row" onClick={() => onOpen(p.projectId, w.rootId)}>
            <span className="po-sum-ico waiting" aria-hidden>⏸</span>
            <span className="po-sum-title">{w.title}</span>
            <span className="po-sum-meta">{w.gate === 'plan' ? 'approve the plan' : w.gate === 'final' ? 'review the changes' : 'needs your call'}</span>
          </button></li>
        ))}
      </ul>}
      {items.length > 0 && <ul className="po-sum-list" aria-label="Recent">
        {items.map(i => (
          <li key={i.ticketId}><button type="button" className="po-sum-row" onClick={() => onOpen(p.projectId, i.rootId)}>
            <span className={`po-sum-ico ${i.status}`} aria-hidden>{i.kind === 'chat' && i.status === 'done' ? '💬' : STATUS_ICON[i.status] ?? '·'}</span>
            <span className="po-sum-title">{i.title}</span>
            <span className="po-sum-meta po-dim">{i.kind === 'chat' && i.status === 'done' ? 'answered' : i.status} · {relativeDate(i.at, now)}</span>
          </button></li>
        ))}
      </ul>}
      {p.usage && p.usage.turns > 0 && <div className="po-sum-usage po-dim">{usageLine(p.usage)}</div>}
    </section>
  );
}
