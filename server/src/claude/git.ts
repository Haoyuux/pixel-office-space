import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { DiffFile, RepoDetection, RepoRef } from '@office/shared';

const AUTHOR = [
  '-c', 'user.name=Pixel Office', '-c', 'user.email=office@localhost',
  '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false',
];

interface GitResult { code: number; stdout: string; stderr: string }

function run(cwd: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve) => {
    const child = execFile('git', [...AUTHOR, ...args], {
      cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0;
      resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') || (err && code ? '' : err?.message ?? '') });
    });
    child.stdin?.end();
  });
}

async function must(cwd: string, args: string[]): Promise<string> {
  const r = await run(cwd, args);
  if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout.trim();
}

export function slug(text: string): string {
  const s = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/g, '');
  return s || 'ticket';
}

export async function isRepo(dir: string): Promise<boolean> {
  if (!fs.existsSync(dir)) return false;
  const r = await run(dir, ['rev-parse', '--is-inside-work-tree']);
  return r.code === 0 && r.stdout.trim() === 'true';
}

export async function hasCommit(dir: string): Promise<boolean> {
  if (!fs.existsSync(dir)) return false;
  return (await run(dir, ['rev-parse', '--verify', '-q', 'HEAD'])).code === 0;
}

const SKIP_DIRS = new Set(['node_modules']);

/**
 * Single repo: the folder is inside a git work tree. Otherwise its direct subfolders (no dot-folders/node_modules)
 * that are repos with at least one commit make a multi-repo project (sorted by name). Neither: none.
 */
export async function detectRepos(folder: string): Promise<RepoDetection> {
  if (!fs.existsSync(folder)) return { kind: 'none' };
  if (await isRepo(folder)) return { kind: 'single' };
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(folder, { withFileTypes: true }); } catch { return { kind: 'none' }; }
  const repos: RepoRef[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
    const p = path.join(folder, e.name);
    if (await isRepo(p) && await hasCommit(p)) repos.push({ name: e.name, path: p });
  }
  repos.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return repos.length ? { kind: 'multi', repos } : { kind: 'none' };
}

export async function gitInit(dir: string): Promise<void> {
  const dotGit = path.join(dir, '.git');
  const hadGit = fs.existsSync(dotGit);
  const ignore = path.join(dir, '.gitignore');
  const hadIgnore = fs.existsSync(ignore);
  const wasRepo = await isRepo(dir);
  if (hadGit && !wasRepo) {
    throw new Error(
      `${dir} has a .git that git can't read (e.g. safe.directory/ownership or a corrupt .git) — fix it first: ` +
      `run "git status" in that folder to see the error, or add it with "git config --global --add safe.directory ${dir}".`,
    );
  }
  try {
    if (!wasRepo) await must(dir, ['init']);
    if (!hadIgnore) fs.writeFileSync(ignore, 'node_modules/\ndist/\n.env\n');
    await must(dir, ['add', '-A']);
    await must(dir, ['commit', '--no-verify', '--allow-empty', '-m', 'Initial commit (Pixel Office)']);
  } catch (e) {
    // do not leave a half-initialised repo behind
    if (!hadGit) fs.rmSync(dotGit, { recursive: true, force: true, maxRetries: 3 });
    if (!hadIgnore) fs.rmSync(ignore, { force: true });
    throw new Error(`Could not initialize git in ${dir}: ${(e as Error).message}`);
  }
}

export async function baseInfo(dir: string): Promise<{ branch: string; head: string; clean: boolean }> {
  const branch = await must(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const head = await must(dir, ['rev-parse', 'HEAD']);
  const status = await must(dir, ['status', '--porcelain', '-z', '--untracked-files=all']);
  return { branch, head, clean: status.split('\0').filter(Boolean).every(isOfficeUntracked) };
}

/** Pixel Office's own files in the owner's folder (agent definitions, project map): untracked ones aren't "dirty". */
export const OFFICE_PATHS = ['.claude/agents/', '.claude/office/'];
function isOfficeUntracked(entry: string): boolean {
  return entry.startsWith('?? ') && OFFICE_PATHS.some(p => entry.slice(3).startsWith(p));
}

function suffix(): string {
  return Math.random().toString(36).slice(2, 6).padEnd(4, '0');
}

export async function createWorktree(
  repo: string, wtPath: string, branch: string, baseRef: string,
): Promise<{ branch: string; path: string }> {
  await run(repo, ['worktree', 'prune']);
  let lastErr = '';
  for (let attempt = 0; attempt < 4; attempt++) {
    const sfx = attempt === 0 ? '' : `-${suffix()}`;
    let b = branch;
    let p = wtPath;
    const branchExists = (await run(repo, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])).code === 0;
    const pathBusy = fs.existsSync(wtPath) && fs.readdirSync(wtPath).length > 0;
    if (attempt > 0 || branchExists) b = `${branch}${sfx || `-${suffix()}`}`;
    if (attempt > 0 || pathBusy) p = `${wtPath}${sfx || `-${suffix()}`}`;
    if (fs.existsSync(p) && fs.readdirSync(p).length > 0) continue;
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const r = await run(repo, ['worktree', 'add', p, '-b', b, baseRef]);
    if (r.code === 0) return { branch: b, path: p };
    lastErr = (r.stderr || r.stdout).trim();
  }
  throw new Error(`Could not create a git worktree for ${branch}: ${lastErr}`);
}

/** Add a pattern to the repo's info/exclude (as seen from `wt`) so `commitAll` never picks it up. Idempotent. */
export async function excludePath(wt: string, pattern: string): Promise<void> {
  const rel = await must(wt, ['rev-parse', '--git-path', 'info/exclude']);
  const file = path.resolve(wt, rel);
  const cur = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (cur.split(/\r?\n/).some(l => l.trim() === pattern)) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${cur && !cur.endsWith('\n') ? '\n' : ''}${pattern}\n`);
}

export async function commitAll(wt: string, message: string): Promise<boolean> {
  await must(wt, ['add', '-A']);
  const st = await must(wt, ['status', '--porcelain']);
  if (st === '') return false;
  await must(wt, ['commit', '--no-verify', '-m', message]);
  return true;
}

export async function diff(repo: string, base: string, branch: string): Promise<DiffFile[]> {
  const range = `${base}...${branch}`;
  const names = await must(repo, ['diff', '--name-only', '-z', range]);
  const files = names.split('\0').filter(Boolean);
  const out: DiffFile[] = [];
  for (const f of files) {
    const r = await run(repo, ['diff', range, '--', f]);
    if (r.code !== 0) throw new Error(`git diff failed: ${r.stderr.trim()}`);
    out.push({ path: f, patch: r.stdout });
  }
  return out;
}

export type MergeResult = { merged: true } | { merged: false; reason: string; instructions: string };

export async function mergeIntoBase(repo: string, branch: string, base: string): Promise<MergeResult> {
  const manual = `cd "${repo}"\ngit checkout ${base}\ngit merge --no-ff ${branch}`;
  const info = await baseInfo(repo);
  if (base === 'HEAD' || info.branch === 'HEAD') {
    const target = base === 'HEAD' ? '<your-branch>' : base;
    return {
      merged: false,
      reason: base === 'HEAD'
        ? 'The work started from a detached HEAD (not on a branch), so there is no branch to merge into.'
        : 'Your project folder is not on a branch (detached HEAD), so Pixel Office did not merge.',
      instructions: `cd "${repo}"\ngit checkout ${target}\ngit merge --no-ff ${branch}`,
    };
  }
  if (info.branch !== base) {
    return {
      merged: false,
      reason: `The base branch "${base}" is not checked out (currently on "${info.branch}").`,
      instructions: manual,
    };
  }
  if (!info.clean) {
    return {
      merged: false,
      reason: 'Your project folder has uncommitted changes, so Pixel Office did not merge.',
      instructions: `cd "${repo}"\n# commit or stash your changes, then:\ngit checkout ${base}\ngit merge --no-ff ${branch}`,
    };
  }
  const r = await run(repo, ['merge', '--no-ff', '--no-verify', '-m', `Merge ${branch} (Pixel Office)`, branch]);
  if (r.code === 0) return { merged: true };
  const detail = (r.stderr || r.stdout).trim();
  const inMerge = (await run(repo, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])).code === 0;
  const unmerged = (await run(repo, ['diff', '--name-only', '--diff-filter=U'])).stdout.trim() !== '';
  const conflict = inMerge || unmerged;
  if (inMerge || unmerged) await run(repo, ['merge', '--abort']);
  const after = await run(repo, ['rev-parse', 'HEAD']);
  const stillMerging = (await run(repo, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])).code === 0;
  if (stillMerging || after.stdout.trim() !== info.head) {
    return {
      merged: false,
      reason: `The merge failed and your repository needs attention: ${detail}`,
      instructions: `cd "${repo}"\ngit merge --abort\ngit reset --hard ${info.head}\n# then retry:\ngit merge --no-ff ${branch}`,
    };
  }
  return {
    merged: false,
    reason: conflict
      ? `Merge conflict: ${detail.split('\n')[0] || 'conflict'}. The merge was aborted and nothing changed.`
      : `The merge failed: ${detail}`,
    instructions: conflict ? `${manual}\n# resolve the conflicts, then git commit` : manual,
  };
}

/** Re-attach an existing branch at wtPath (follow-ups / Resume after the worktree was removed). */
export async function attachWorktree(repo: string, wtPath: string, branch: string): Promise<{ branch: string; path: string }> {
  await run(repo, ['worktree', 'prune']);
  if (fs.existsSync(path.join(wtPath, '.git'))) return { branch, path: wtPath };
  if (fs.existsSync(wtPath)) fs.rmSync(wtPath, { recursive: true, force: true, maxRetries: 5 });
  fs.mkdirSync(path.dirname(wtPath), { recursive: true });
  await must(repo, ['worktree', 'add', wtPath, branch]);
  return { branch, path: wtPath };
}

export async function branchExists(repo: string, branch: string): Promise<boolean> {
  return (await run(repo, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])).code === 0;
}

export async function removeWorktree(repo: string, wtPath: string): Promise<void> {
  await run(repo, ['worktree', 'remove', '--force', wtPath]);
  if (fs.existsSync(wtPath)) fs.rmSync(wtPath, { recursive: true, force: true, maxRetries: 5 });
  await run(repo, ['worktree', 'prune']);
}
