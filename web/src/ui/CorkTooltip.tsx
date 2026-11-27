import { useMemo } from 'react';
import { useOffice } from '../state/store';
import { accentCss, STATUS_ICON } from './format';

/** Breakroom cork board hover: the last 5 conversations across all projects. */
export function CorkTooltip({ x, y }: { x: number; y: number }) {
  const tickets = useOffice(s => s.tickets);
  const projects = useOffice(s => s.projects);
  const last = useMemo(() => Object.values(tickets).filter(t => projects[t.projectId])
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 5), [tickets, projects]);
  const left = Math.min(x + 16, window.innerWidth - 336), top = Math.min(y + 16, window.innerHeight - 40 - last.length * 44);
  return (
    <div className="po-cork" style={{ left, top }} role="tooltip">
      <div className="po-cork-head">📌 Cork board · latest conversations</div>
      {last.length === 0 && <div className="po-dim">Nothing pinned yet.</div>}
      {last.map(t => (
        <div key={t.id} className="po-cork-row">
          <span className={`po-cork-status ${t.status}`}>{STATUS_ICON[t.status]}</span>
          <span className="po-cork-title">{t.title}</span>
          <span className="po-cork-proj" style={{ color: accentCss(projects[t.projectId].accent) }}>{projects[t.projectId].name}</span>
          <span className="po-dim po-cork-st">{t.status}</span>
        </div>
      ))}
    </div>
  );
}
