import { useEffect, useState } from 'react';
import { api, paths } from './api';

export interface PushRepoResult {
  repo: string; ok: boolean; branch?: string; remote?: string; upToDate?: boolean; error?: string;
}

/** One line per repo: what was pushed where, already up to date, or git's error. */
export function pushSummary(results: PushRepoResult[], multi: boolean): string {
  return results.map(r => {
    const who = multi ? `${r.repo}: ` : '';
    if (!r.ok) return `${who}push failed — ${r.error ?? 'unknown error'}`;
    const where = `${r.remote}/${r.branch}`;
    return `${who}${r.upToDate ? `already up to date on ${where}` : `pushed ${r.branch} to ${where}`}`;
  }).join('\n');
}

/** Asks the office server to push the project's checked-out branch(es); resolves to a summary text. */
export async function pushProject(projectId: string): Promise<{ ok: boolean; text: string }> {
  const r = await api<{ ok: boolean; results: PushRepoResult[] }>('POST', paths.push(projectId));
  if (!r.ok) return { ok: false, text: r.error };
  const results = r.data?.results ?? [];
  return { ok: !!r.data?.ok, text: pushSummary(results, results.length > 1) || 'Nothing to push' };
}

const PUSH_VERB = /^(?:push|publish|upload|sync)$/;
const PUSH_FILLER = new Set(['it', 'this', 'that', 'my', 'the', 'our', 'changes', 'change', 'code', 'work', 'commits', 'commit',
  'branch', 'project', 'repo', 'repository', 'to', 'on', 'into', 'github', 'git', 'remote', 'origin', 'now', 'please', 'pls', 'up', 'all',
  'everything', 'online', 'it\'s']);
const POLITE = /^(?:(?:hey|ok|okay|please|pls|plz|can|could|would|will|you|u|just|go|ahead|and|now)\s+)+/;

/**
 * A short chat line that only asks to push ("push it", "push to github", "git push", "commit and push to github").
 * Longer requests ("push the button color darker") stay a request for the team.
 */
export function pushIntent(text: string, branchWords: string[] = []): boolean {
  const t = text.toLowerCase().replace(/[?!.。,]+/g, ' ').replace(/\s+/g, ' ').trim().replace(POLITE, '');
  if (!t) return false;
  let words = t.split(' ');
  if (words[0] === 'git' && words[1] === 'push') words = words.slice(1);
  if (words[0] === 'commit' && words[1] === 'and' && words[2] === 'push') words = words.slice(2);
  if (words.length > 6 || !PUSH_VERB.test(words[0])) return false;
  const rest = words.slice(1);
  if (words[0] !== 'push' && !rest.includes('github') && !rest.includes('remote')) return false; // "sync it" alone is vague
  const own = new Set(branchWords.map(w => w.toLowerCase()));
  return rest.every(w => PUSH_FILLER.has(w) || own.has(w));
}

/** Header control: ⬆ Push, with the result in a small note under it. */
export function PushButton({ projectId }: { projectId: string }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    if (!note?.ok) return;
    const t = setTimeout(() => setNote(null), 8000);
    return () => clearTimeout(t);
  }, [note]);
  const act = async () => {
    setBusy(true); setNote(null);
    setNote(await pushProject(projectId));
    setBusy(false);
  };
  return <span className="po-push-wrap">
    <button type="button" className="po-hbtn po-push" disabled={busy} aria-label="Push to GitHub"
      title="Push the checked-out branch to GitHub with your git login (/push)" onClick={() => void act()}>
      {busy ? '⬆ Pushing…' : note && !note.ok ? '⚠ Push' : '⬆ Push'}
    </button>
    {note && (
      <span className={`po-push-msg${note.ok ? ' ok' : ' err'}`} role="status" title="Click to dismiss" onClick={() => setNote(null)}>{note.text}</span>
    )}
  </span>;
}
