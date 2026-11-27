import { useState } from 'react';
import type { AgentsMode, Project, RoleId } from '@office/shared';
import { api, paths } from './api';
import { accentCss } from './format';
import { Modal, RolePicker } from './Modal';
import { ReposFound } from './GitBanner';

/** Drawer `Team` button: the same 9 checkboxes, PATCH on save. A busy role can't be removed (409, shown inline). */
export function TeamDialog({ project, onClose }: { project: Project; onClose: () => void }) {
  const [team, setTeam] = useState<RoleId[]>(project.team);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<AgentsMode>(project.agentsMode ?? 'claude');
  const [modeBusy, setModeBusy] = useState(false);
  const [modeError, setModeError] = useState<string | null>(null);
  const switchMode = async (m: AgentsMode) => {
    if (m === mode || modeBusy) return;
    setModeBusy(true); setModeError(null);
    const r = await api<Project>('PATCH', paths.project(project.id), { agentsMode: m });
    setModeBusy(false);
    if (r.ok) setMode(m); else setModeError(r.error);
  };
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
        <ReposFound repos={project.repos} />
        <p className="po-dim po-hint">New members walk in from the hallway; removed ones head out. Every room keeps a desk for every role.</p>
        <fieldset className="po-mode" disabled={modeBusy}>
          <legend className="po-dim">Agents</legend>
          {(['claude', 'simulated'] as const).map(m => (
            <label key={m} className={`po-mode-opt${mode === m ? ' on' : ''}`}>
              <input type="radio" name="agentsMode" value={m} checked={mode === m} onChange={() => void switchMode(m)} />
              <span>{m === 'claude' ? 'Claude Code' : 'Simulated'}</span>
            </label>
          ))}
        </fieldset>
        {modeError && <div className="po-error" role="alert">{modeError}</div>}
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
