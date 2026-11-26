import { useEffect, type ReactNode } from 'react';
import { ROLES, type RoleId } from '@office/shared';

/** Centered terminal-style dialog over a dimmed backdrop. Escape or a backdrop click closes it. */
export function Modal({ title, accent, onClose, children }: { title: string; accent?: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);
  return (
    <div className="po-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="po-modal" role="dialog" aria-label={title} style={accent ? { ['--accent' as string]: accent } : undefined}>
        <div className="po-modal-head">
          <span className="po-modal-title">{title}</span>
          <button type="button" className="po-icon" aria-label="Close" onClick={onClose}>✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** The 9 role checkboxes (catalogue order). Required roles (PM) are checked and locked. */
export function RolePicker({ team, onChange }: { team: RoleId[]; onChange: (team: RoleId[]) => void }) {
  const toggle = (id: RoleId, on: boolean) => onChange(ROLES.map(r => r.id).filter(r => (r === id ? on : team.includes(r))));
  return (
    <div className="po-roles">
      {ROLES.map(r => (
        <label key={r.id} className={`po-role${team.includes(r.id) ? ' on' : ''}${r.required ? ' locked' : ''}`} title={r.tools}>
          <input type="checkbox" value={r.id} checked={r.required || team.includes(r.id)} disabled={r.required}
            onChange={e => toggle(r.id, e.target.checked)} />
          <span className="po-role-emoji" aria-hidden>{r.emoji}</span>
          <span>{r.label}</span>
          {r.required && <span className="po-dim po-role-tag">always</span>}
        </label>
      ))}
    </div>
  );
}
