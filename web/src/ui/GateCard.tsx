import { useState } from 'react';
import type { GateDecision, GateKind } from '@office/shared';
import { useOffice, type FeedItem } from '../state/store';
import { api, paths } from './api';
import { STAGE_LABEL } from './format';

const CHOICES: Record<GateKind, { decision: GateDecision; label: string; tone: string }[]> = {
  plan: [{ decision: 'approved', label: 'Approve', tone: 'primary' }, { decision: 'changes', label: 'Request changes', tone: 'ghost' }],
  final: [{ decision: 'approved', label: 'Approve', tone: 'primary' }, { decision: 'changes', label: 'Request changes', tone: 'ghost' }],
  stuck: [
    { decision: 'retry', label: 'One more round', tone: 'primary' },
    { decision: 'accept', label: 'Accept & test', tone: 'ghost' }, // 'Accept & continue' when stuck in test (QA)
    { decision: 'cancel', label: 'Cancel ticket', tone: 'danger' },
  ],
  install: [{ decision: 'approved', label: 'Install', tone: 'primary' }, { decision: 'skip', label: 'Skip', tone: 'ghost' }],
};

const RESOLVED: Record<GateDecision, string> = {
  approved: '✓ approved', changes: '↺ changes requested', retry: '↺ one more round', accept: '→ accepted as is, moving on', cancel: '⊘ ticket cancelled', skip: '⊘ skipped',
};

const gateLabel = (g: GateKind) => g === 'plan' ? 'plan' : g === 'final' ? 'final changes' : g === 'install' ? 'packages' : 'stuck';

const parse = (s?: string): Record<string, unknown> => { try { return s ? JSON.parse(s) : {}; } catch { return {}; } };

/** Inline "waiting for you" card for an open gate; buttons lock after a click until `gate.closed` (or an error). */
export function GateCard({ ticketId, item, onShow }: { ticketId: string; item: FeedItem; onShow?: (tab: 'plan' | 'changes') => void }) {
  const gate = item.text as GateKind;
  const ticket = useOffice(s => s.tickets[ticketId]);
  const files = useOffice(s => s.diffs[ticketId]?.length ?? 0);
  const [note, setNote] = useState('');
  const [sent, setSent] = useState<GateDecision | null>(null);
  const [error, setError] = useState<string | null>(null);
  // a ticket that ended (failed/cancelled/done) can't take a decision any more
  const ended = !!ticket && (ticket.status === 'failed' || ticket.status === 'cancelled' || ticket.status === 'done');
  const open = item.status === 'open' && !ended;

  const decide = async (decision: GateDecision) => {
    if (!open || sent) return;
    setSent(decision); setError(null);
    const r = await api('POST', paths.gate(ticketId, gate), note.trim() ? { decision, note: note.trim() } : { decision });
    if (!r.ok) { setSent(null); setError(r.error); }
  };

  if (!open && item.status === 'open') {
    return (
      <div className="po-gate closed">
        <span className="po-gate-kind">{gateLabel(gate)}</span>
        <span>the ticket ended before a decision</span>
      </div>
    );
  }

  if (!open) {
    const decision = item.status as GateDecision;
    return (
      <div className="po-gate closed">
        <span className="po-gate-kind">{gateLabel(gate)}</span>
        <span>{RESOLVED[decision] ?? decision}</span>
        {item.detail && !item.detail.startsWith('{') && <span className="po-dim"> — “{item.detail}”</span>}
      </div>
    );
  }

  const p = parse(item.detail);
  const issues = gate === 'stuck' && Array.isArray(p.issues)
    ? (p.issues as { role?: unknown; file?: unknown; note?: unknown }[]).filter(i => typeof i?.note === 'string')
      .map(i => ({ role: String(i.role ?? ''), file: typeof i.file === 'string' ? i.file : '', note: String(i.note) }))
    : [];
  /** A plain retry would repeat a round that changed nothing: the note is required (the server refuses otherwise). */
  const unchanged = gate === 'stuck' && p.unchanged === true;
  const needsNote = (d: GateDecision) => unchanged && d === 'retry' && !note.trim();
  const asks = gate === 'install' && Array.isArray(p.requests)
    ? (p.requests as { role?: unknown; repo?: unknown; specs?: unknown }[]).filter(a => Array.isArray(a?.specs))
      .map(a => ({ role: String(a.role ?? ''), repo: typeof a.repo === 'string' ? a.repo : '', specs: (a.specs as unknown[]).map(String) }))
    : [];
  const body = gate === 'plan'
    ? <>
        <div className="po-gate-title">Approve the plan?</div>
        <div className="po-gate-text">{ticket?.plan?.summary ?? 'The PM wrote a plan for this ticket.'}</div>
        {ticket?.plan && <div className="po-dim">{ticket.plan.tasks.length} tasks · {ticket.plan.acceptance.length} acceptance criteria · <button type="button" className="po-link" onClick={() => onShow?.('plan')}>open Plan</button></div>}
      </>
    : gate === 'final'
      ? <>
          <div className="po-gate-title">Approve the final changes?</div>
          <div className="po-gate-text">The team is done. Review the diff before it lands.</div>
          <div className="po-dim">{files} file{files === 1 ? '' : 's'} changed · <button type="button" className="po-link" onClick={() => onShow?.('changes')}>open Changes</button></div>
        </>
      : gate === 'install'
      ? <>
          <div className="po-gate-title">Install new packages?</div>
          <ul className="po-gate-asks">{asks.map((a, n) => <li key={n}><b>{a.role}</b> wants <code>{a.specs.join(' ')}</code>{a.repo ? <span className="po-dim"> in {a.repo}</span> : null}</li>)}</ul>
          <div className="po-dim">Installed with --no-save: your package.json changes only when you accept the ticket.</div>
        </>
      : <>
          <div className="po-gate-title">The team is stuck</div>
          <div className="po-gate-text">{STAGE_LABEL[(p.from as keyof typeof STAGE_LABEL) ?? 'review'] ?? 'Review'} bounced the work back {String(p.bounces ?? 3)}× without converging.</div>
          {issues.length > 0 && (
            <div className="po-gate-asks">
              <div className="po-dim">Still open:</div>
              <ul>{issues.map((i, n) => <li key={n}><b>{i.role}</b>{i.file ? <span className="po-dim"> · {i.file}</span> : null} — {i.note}</li>)}</ul>
            </div>
          )}
          {unchanged && <div className="po-gate-warn" role="note">The last round changed no files, so another round as is would fail the same way. Tell the team what to do in the note — or Accept / Cancel.</div>}
        </>;

  return (
    <div className={`po-gate open ${gate}`} role="group" aria-label={`${gate} gate`}>
      <div className="po-gate-head">⏸ WAITING FOR YOU</div>
      {body}
      <textarea className="po-gate-note" aria-label="Note" rows={1} value={note} disabled={!!sent}
        placeholder={gate === 'stuck' ? (unchanged ? 'what should the team do? (required for One more round)' : 'note for the next round (optional)') : 'note (optional)'} onChange={e => setNote(e.target.value)} />
      {error && <div className="po-error" role="alert">{error}</div>}
      <div className="po-gate-actions">
        {CHOICES[gate]?.map(c => (
          <button key={c.decision} type="button" className={`po-btn ${c.tone}${sent === c.decision ? ' sent' : ''}`} disabled={!!sent || needsNote(c.decision)}
            title={needsNote(c.decision) ? 'Add a note first: the last round changed nothing' : undefined} onClick={() => decide(c.decision)}>
            {c.decision === 'accept' && p.from === 'test' ? 'Accept & continue' : c.label}
          </button>
        ))}
        {sent && <span className="po-dim po-spin">sent · waiting for the team…</span>}
      </div>
    </div>
  );
}
