import { useState, type FormEvent } from 'react';
import { ACCENTS, DEFAULT_TEAM, type Accent, type Project, type RoleId } from '@office/shared';
import { useOffice } from '../state/store';
import { api, paths } from './api';
import { accentCss } from './format';
import { Modal, RolePicker } from './Modal';

/** `+ Add Project`: name, folder (validated by the server), accent, team. Opens the new project's drawer on success. */
export function AddProjectDialog({ onClose }: { onClose: () => void }) {
  const projects = useOffice(s => s.projects);
  const used = Object.values(projects).map(p => p.accent);
  const [name, setName] = useState('');
  const [folder, setFolder] = useState('');
  const [accent, setAccent] = useState<Accent>(() => ACCENTS.find(a => !used.includes(a)) ?? ACCENTS[0]);
  const [team, setTeam] = useState<RoleId[]>(DEFAULT_TEAM);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setError(null);
    const r = await api<Project>('POST', paths.projects(), { name: name.trim(), folder: folder.trim(), accent, team });
    setBusy(false);
    if (!r.ok) { setError(r.error); return; }
    onClose();
    if (r.data?.id) useOffice.getState().select(r.data.id);
  };

  return (
    <Modal title="add project" accent={accentCss(accent)} onClose={onClose}>
      <form className="po-form" onSubmit={submit}>
        <label className="po-field">
          <span>Name</span>
          <input autoFocus value={name} onChange={e => setName(e.target.value)} placeholder="Shop" spellCheck={false} />
        </label>
        <label className="po-field">
          <span>Folder path</span>
          <input value={folder} onChange={e => setFolder(e.target.value)} placeholder="C:\code\shop" spellCheck={false} />
        </label>
        <fieldset className="po-field">
          <legend>Accent</legend>
          <div className="po-swatches">
            {ACCENTS.map(a => (
              <label key={a} className={`po-swatch${a === accent ? ' on' : ''}`} style={{ ['--sw' as string]: accentCss(a) }}>
                <input type="radio" name="accent" value={a} aria-label={a} checked={a === accent} onChange={() => setAccent(a)} />
                <span className="po-swatch-dot" aria-hidden />
                <span>{a}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset className="po-field">
          <legend>Team</legend>
          <RolePicker team={team} onChange={setTeam} />
        </fieldset>
        {error && <div className="po-error" role="alert">{error}</div>}
        <div className="po-actions">
          <button type="button" className="po-btn ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="po-btn primary" disabled={busy || !name.trim() || !folder.trim()}>{busy ? 'Creating…' : 'Create project'}</button>
        </div>
      </form>
    </Modal>
  );
}
