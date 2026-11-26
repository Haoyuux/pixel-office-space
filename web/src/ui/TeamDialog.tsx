import { useState } from 'react';
import type { Project, RoleId } from '@office/shared';
import { api, paths } from './api';
import { accentCss } from './format';
import { Modal, RolePicker } from './Modal';

/** Drawer `Team` button: the same 9 checkboxes, PATCH on save. A busy role can't be removed (409, shown inline). */
export function TeamDialog({ project, onClose }: { project: Project; onClose: () => void }) {
  const [team, setTeam] = useState<RoleId[]>(project.team);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const changed = team.length !== project.team.length || team.some(r => !project.team.includes(r));

  const save = async () => {
    setBusy(true); setError(null);
    const r = await api<Project>('PATCH', paths.project(project.id), { team });
    setBusy(false);
    if (r.ok) onClose(); else setError(r.error);
  };

  return (
    <Modal title={`team · ${project.name}`} accent={accentCss(project.accent)} onClose={onClose}>
      <div className="po-form">
        <p className="po-dim po-hint">New members walk in from the hallway; removed ones head out. Every room keeps a desk for every role.</p>
        <RolePicker team={team} onChange={setTeam} />
        {error && <div className="po-error" role="alert">{error}</div>}
        <div className="po-actions">
          <button type="button" className="po-btn ghost" onClick={onClose}>Cancel</button>
          <button type="button" className="po-btn primary" disabled={busy || !changed} onClick={save}>{busy ? 'Saving…' : 'Save team'}</button>
        </div>
      </div>
    </Modal>
  );
}
