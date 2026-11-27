import { useState } from 'react';
import { api, paths } from './api';

/** One-line "not a git repo" banner with a button that runs git-init; the server's reply shows inline. */
export function GitBanner({ projectId, text = "This folder isn't a git repository — Claude agents work on a git branch." }: { projectId: string; text?: string }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const init = async () => {
    setBusy(true);
    const r = await api<{ message?: string }>('POST', paths.gitInit(projectId));
    setBusy(false);
    setResult(r.ok ? { ok: true, text: r.data?.message ?? 'Git initialized.' } : { ok: false, text: r.error });
  };
  return (
    <div className="po-banner warn po-banner-row" role="status">
      <span className="po-grow">{text}</span>
      {!result?.ok && <button type="button" className="po-btn" disabled={busy} onClick={() => void init()}>{busy ? 'Initializing…' : 'Initialize git'}</button>}
      {result && <span className={result.ok ? 'po-ok' : 'po-error-text'}>{result.text}</span>}
    </div>
  );
}

/** "Repos found: angular, aspnet-core" for a multi-repo project (nothing for a single repo). */
export function ReposFound({ repos }: { repos?: { name: string }[] }) {
  if (!repos?.length) return null;
  return <p className="po-hint po-repos-found">Repos found: {repos.map(r => r.name).join(', ')}</p>;
}
