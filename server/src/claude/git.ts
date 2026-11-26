import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { DiffFile } from '@office/shared';

const AUTHOR = ['-c', 'user.name=Pixel Office', '-c', 'user.email=office@localhost'];

interface GitResult { code: number; stdout: string; stderr: string }

function run(cwd: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile('git', [...AUTHOR, ...args], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0;
        resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
      });
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

export async function gitInit(dir: string): Promise<void> {
  if (!(await isRepo(dir))) await must(dir, ['init']);
  const ignore = path.join(dir, '.gitignore');
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, 'node_modules/\ndist/\n.env\n');
  await must(dir, ['add', '-A']);
  await must(dir, ['commit', '--allow-empty', '-m', 'Initial commit (Pixel Office)']);
}

export async function baseInfo(dir: string): Promise<{ branch: string; head: string; clean: boolean }> {
  const branch = await must(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const head = await must(dir, ['rev-parse', 'HEAD']);
  const status = await must(dir, ['status', '--porcelain', '--untracked-files=all']);
  return { branch, head, clean: status === '' };
}

export async function createWorktree(repo: string, wtPath: string, branch: string, baseRef: string): Promise<void> {
  fs.mkdirSync(path.dirname(wtPath), { recursive: true });
  await must(repo, ['worktree', 'add', wtPath, '-b', branch, baseRef]);
}

export async function commitAll(wt: string, message: string): Promise<boolean> {
  await must(wt, ['add', '-A']);
  const st = await must(wt, ['status', '--porcelain']);
  if (st === '') return false;
  await must(wt, ['commit', '-m', message]);
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
  const r = await run(repo, ['merge', '--no-ff', '-m', `Merge ${branch} (Pixel Office)`, branch]);
  if (r.code !== 0) {
    await run(repo, ['merge', '--abort']);
    return {
      merged: false,
      reason: `Merge conflict: ${(r.stdout + r.stderr).trim().split('\n')[0] ?? 'conflict'}. The merge was aborted.`,
      instructions: `${manual}\n# resolve the conflicts, then git commit`,
    };
  }
  return { merged: true };
}

export async function removeWorktree(repo: string, wtPath: string): Promise<void> {
  await run(repo, ['worktree', 'remove', '--force', wtPath]);
  if (fs.existsSync(wtPath)) fs.rmSync(wtPath, { recursive: true, force: true, maxRetries: 5 });
  await run(repo, ['worktree', 'prune']);
}
