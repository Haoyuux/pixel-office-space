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
    { decision: 'accept', label: 'Accept & test', tone: 'ghost' },
    { decision: 'cancel', label: 'Cancel ticket', tone: 'danger' },
  ],
};

const RESOLVED: Record<GateDecision, string> = {
  approved: '✓ approved', changes: '↺ changes requested', retry: '↺ one more round', accept: '→ accepted, on to test', cancel: '⊘ ticket cancelled',
};

const parse = (s?: string): Record<string, unknown> => { try { return s ? JSON.parse(s) : {}; } catch { return {}; } };

/** Inline "waiting for you" card for an open gate; buttons lock after a click until `gate.closed` (or an error). */
export function GateCard({ ticketId, item, onShow }: { ticketId: string; item: FeedItem; onShow?: (tab: 'plan' | 'changes') => void }) {
  const gate = item.text as GateKind;
  const ticket = useOffice(s => s.tickets[ticketId]);
  const files = useOffice(s => s.diffs[ticketId]?.length ?? 0);
  const [note, setNote] = useState('');
  const [sent, setSent] = useState<GateDecision | null>(null);
  const [error, setError] = useState<string | null>(null);
  const open = item.status === 'open';

  const decide = async (decision: GateDecision) => {
    if (!open || sent) return;
    setSent(decision); setError(null);
    const r = await api('POST', paths.gate(ticketId, gate), note.trim() ? { decision, note: note.trim() } : { decision });
    if (!r.ok) { setSent(null); setError(r.error); }
  };

  if (!open) {
    const decision = item.status as GateDecision;
    return (
      <div className="po-gate closed">
        <span className="po-gate-kind">{gate === 'plan' ? 'plan' : gate === 'final' ? 'final changes' : 'stuck'}</span>
        <span>{RESOLVED[decision] ?? decision}</span>
        {item.detail && !item.detail.startsWith('{') && <span className="po-dim"> — “{item.detail}”</span>}
      </div>
    );
  }

  const p = parse(item.detail);
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
      : <>
          <div className="po-gate-title">The team is stuck</div>
          <div className="po-gate-text">{STAGE_LABEL[(p.from as keyof typeof STAGE_LABEL) ?? 'review'] ?? 'Review'} bounced the work back {String(p.bounces ?? 3)}× without converging.</div>
        </>;

  return (
    <div className={`po-gate open ${gate}`} role="group" aria-label={`${gate} gate`}>
      <div className="po-gate-head">⏸ WAITING FOR YOU</div>
      {body}
      <textarea className="po-gate-note" aria-label="Note" rows={1} value={note} disabled={!!sent}
        placeholder={gate === 'stuck' ? 'note for the next round (optional)' : 'note (optional)'} onChange={e => setNote(e.target.value)} />
      {error && <div className="po-error" role="alert">{error}</div>}
      <div className="po-gate-actions">
        {CHOICES[gate]?.map(c => (
          <button key={c.decision} type="button" className={`po-btn ${c.tone}${sent === c.decision ? ' sent' : ''}`} disabled={!!sent} onClick={() => decide(c.decision)}>
            {c.label}
          </button>
        ))}
        {sent && <span className="po-dim po-spin">sent · waiting for the team…</span>}
      </div>
    </div>
  );
}
