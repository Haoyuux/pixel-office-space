import type { Project } from '@office/shared';

export const FILES_LIMIT = 30;
const CACHE_MS = 10_000;

/** Case-insensitive subsequence: every character of q appears in s in order. */
export function subsequence(q: string, s: string): boolean {
  let i = 0;
  for (let j = 0; j < s.length && i < q.length; j++) if (s[j] === q[i]) i++;
  return i === q.length;
}

/**
 * Up to `limit` paths matching q (case-insensitive subsequence). Ranked: file name contains q, then path contains q,
 * then the rest; shorter paths first within a rank. Empty q → the first paths (shortest first).
 */
export function searchFiles(paths: string[], q: string, limit = FILES_LIMIT): string[] {
  const needle = q.trim().toLowerCase().replace(/\\/g, '/');
  const rank = (p: string) => {
    if (!needle) return 0;
    const l = p.toLowerCase();
    const name = l.slice(l.lastIndexOf('/') + 1);
    return name.includes(needle) ? 0 : l.includes(needle) ? 1 : 2;
  };
  return paths
    .filter(p => !needle || subsequence(needle, p.toLowerCase()))
    .map(p => ({ p, r: rank(p) }))
    .sort((a, b) => a.r - b.r || a.p.length - b.p.length || a.p.localeCompare(b.p))
    .slice(0, limit)
    .map(x => x.p);
}

export type LsFiles = (cwd: string) => Promise<string[]>;

/** git ls-files across the project's repos (multi-repo: prefixed with the repo name), cached briefly per project. */
export class ProjectFiles {
  private cache = new Map<string, { at: number; files: string[] }>();
  constructor(private ls: LsFiles, private now: () => number = Date.now) {}

  async list(p: Project): Promise<string[]> {
    const hit = this.cache.get(p.id);
    if (hit && this.now() - hit.at < CACHE_MS) return hit.files;
    let files: string[] = [];
    if (p.repos?.length) {
      for (const r of p.repos) files.push(...(await this.ls(r.path).catch(() => [] as string[])).map(f => `${r.name}/${f}`));
    } else if (p.gitKind !== 'none') {
      files = await this.ls(p.folder).catch(() => []);
    }
    this.cache.set(p.id, { at: this.now(), files });
    return files;
  }

  async search(p: Project, q: string): Promise<string[]> { return searchFiles(await this.list(p), q); }
}
