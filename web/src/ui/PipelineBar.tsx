import type { RoleId, Ticket } from '@office/shared';
import { STAGE_LABEL, teamStages } from './format';

type Mark = 'done' | 'current' | 'pending' | 'failed';
const GLYPH: Record<Mark, string> = { done: '✓', current: '●', pending: '○', failed: '✕' };

/** Stage marks for a ticket: ✓ done, ● current (✕ where it failed or was cancelled), ○ pending. */
export function stageMarks(team: RoleId[], t: Ticket | undefined): { stage: string; label: string; mark: Mark }[] {
  const stages = teamStages(team);
  const at = t?.stage ? stages.indexOf(t.stage as (typeof stages)[number]) : -1;
  const ended = t?.status === 'failed' || t?.status === 'cancelled';
  return stages.map((s, i) => {
    const mark: Mark = t?.status === 'done' ? 'done'
      : at < 0 ? 'pending'
        : i < at ? 'done' : i === at ? (ended ? 'failed' : 'current') : 'pending';
    return { stage: s, label: STAGE_LABEL[s], mark };
  });
}

export function PipelineBar({ team, ticket }: { team: RoleId[]; ticket: Ticket | undefined }) {
  // an answered Ask never went through the pipeline: one step only
  if (ticket?.answered) {
    return (
      <ol className="po-pipe" aria-label="Pipeline">
        <li className="po-pipe-step done answer"><span>Answer</span> <span className="po-pipe-glyph" aria-hidden>✓</span></li>
      </ol>
    );
  }
  const marks = stageMarks(team, ticket);
  const waiting = ticket?.status === 'waiting';
  return (
    <ol className="po-pipe" aria-label="Pipeline">
      {marks.map((m, i) => (
        <li key={m.stage} className={`po-pipe-step ${m.mark}${waiting && m.mark === 'current' ? ' waiting' : ''}`}>
          {i > 0 && <span className="po-pipe-link" aria-hidden />}
          <span className="po-pipe-glyph" aria-hidden>{waiting && m.mark === 'current' ? '⏸' : GLYPH[m.mark]}</span>
          <span>{m.label}</span>
        </li>
      ))}
    </ol>
  );
}
