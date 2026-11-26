import type { Ticket } from '@office/shared';
import { roleColor, roleEmoji, roleShort } from './format';

/** The PM's plan: summary, acceptance criteria, affected areas, tasks per role. */
export function PlanView({ ticket }: { ticket: Ticket | undefined }) {
  const plan = ticket?.plan;
  if (!plan) return <div className="po-scroll"><div className="po-empty">{ticket ? 'The PM has not written a plan yet.' : 'No ticket.'}</div></div>;
  return (
    <div className="po-scroll po-plan">
      <h3># {ticket!.title}</h3>
      <p>{plan.summary}</p>
      <h4>## Acceptance criteria</h4>
      <ul className="po-check">{plan.acceptance.map((a, i) => <li key={i}><span aria-hidden>[ ]</span> {a}</li>)}</ul>
      {plan.areas.length > 0 && <>
        <h4>## Affected areas</h4>
        <div className="po-areas">{plan.areas.map(a => <code key={a}>{a}</code>)}</div>
      </>}
      <h4>## Tasks</h4>
      <ul className="po-tasks">
        {plan.tasks.map((t, i) => (
          <li key={i}>
            <span className="po-who" style={{ color: roleColor(t.role) }}><span aria-hidden>{roleEmoji(t.role)}</span> {roleShort(t.role)}</span>
            <span>{t.text}</span>
            {t.files.length > 0 && <span className="po-dim po-task-files">{t.files.join(' · ')}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}
