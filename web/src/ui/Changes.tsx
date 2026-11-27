import { useState } from 'react';
import type { DiffFile } from '@office/shared';
import { useOffice } from '../state/store';
import { DiffText } from './Feed';

const EMPTY: DiffFile[] = [];

const stat = (patch: string) => {
  let add = 0, del = 0;
  for (const l of patch.split('\n')) {
    if (l.startsWith('+') && !l.startsWith('+++')) add++;
    else if (l.startsWith('-') && !l.startsWith('---')) del++;
  }
  return { add, del };
};

/** Multi-repo diffs: files grouped under their repo (the first path segment), in repo order. */
function groupByRepo(files: DiffFile[], repos: string[]): { repo: string; files: DiffFile[] }[] {
  const groups = new Map<string, DiffFile[]>();
  for (const f of files) {
    const repo = f.path.split('/')[0];
    groups.set(repo, [...(groups.get(repo) ?? []), f]);
  }
  const order = (r: string) => { const i = repos.indexOf(r); return i < 0 ? repos.length : i; };
  return [...groups.entries()].sort((a, b) => order(a[0]) - order(b[0])).map(([repo, fs]) => ({ repo, files: fs }));
}

/** File list with +/− counts and the unified diff of the picked file (grouped by repo for multi-repo projects). */
export function Changes({ ticketId, repos }: { ticketId: string; repos?: string[] }) {
  const files = useOffice(s => s.diffs[ticketId] ?? EMPTY);
  const [pick, setPick] = useState<string | null>(null);
  if (!files.length) return <div className="po-scroll"><div className="po-empty">No changes yet. The diff appears once the developers have edited files.</div></div>;
  const cur = files.find(f => f.path === pick) ?? files[0];
  const list = (fs: DiffFile[], prefix: string) => (
    <ul className="po-files">
      {fs.map(f => {
        const s = stat(f.patch);
        return (
          <li key={f.path}>
            <button type="button" className={f === cur ? 'on' : ''} onClick={() => setPick(f.path)} title={f.path}>
              <span className="po-file-path">{prefix && f.path.startsWith(prefix) ? f.path.slice(prefix.length) : f.path}</span>
              <span className="po-add">+{s.add}</span> <span className="po-del">−{s.del}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
  return (
    <div className="po-scroll po-changes">
      {repos?.length
        ? groupByRepo(files, repos).map(g => (
          <section key={g.repo} role="group" aria-label={g.repo} className="po-repo-group">
            <h4 className="po-repo-head">{g.repo}</h4>
            {list(g.files, `${g.repo}/`)}
          </section>
        ))
        : list(files, '')}
      <div className="po-file-head">{cur.path}</div>
      <DiffText text={cur.patch} />
    </div>
  );
}
