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

/** File list with +/− counts and the unified diff of the picked file. */
export function Changes({ ticketId }: { ticketId: string }) {
  const files = useOffice(s => s.diffs[ticketId] ?? EMPTY);
  const [pick, setPick] = useState<string | null>(null);
  if (!files.length) return <div className="po-scroll"><div className="po-empty">No changes yet. The diff appears once the developers have edited files.</div></div>;
  const cur = files.find(f => f.path === pick) ?? files[0];
  return (
    <div className="po-scroll po-changes">
      <ul className="po-files">
        {files.map(f => {
          const s = stat(f.patch);
          return (
            <li key={f.path}>
              <button type="button" className={f === cur ? 'on' : ''} onClick={() => setPick(f.path)}>
                <span className="po-file-path">{f.path}</span>
                <span className="po-add">+{s.add}</span> <span className="po-del">−{s.del}</span>
              </button>
            </li>
          );
        })}
      </ul>
      <div className="po-file-head">{cur.path}</div>
      <DiffText text={cur.patch} />
    </div>
  );
}
