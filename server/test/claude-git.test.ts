import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  isRepo, hasCommit, gitInit, baseInfo, createWorktree, commitAll, diff, mergeIntoBase, removeWorktree, slug,
} from '../src/claude/git';

const dirs: string[] = [];
const repos: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'po-git-'));
  dirs.push(d);
  return d;
}
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim();

async function mkRepo(): Promise<string> {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'a.txt'), 'a\n');
  await gitInit(d);
  repos.push(d);
  return d;
}

afterEach(() => {
  for (const r of repos.splice(0)) {
    try {
      const out = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: r, encoding: 'utf8' });
      for (const l of out.split('\n')) {
        const m = /^worktree (.+)$/.exec(l.trim());
        if (m && path.resolve(m[1]) !== path.resolve(r)) {
          try { execFileSync('git', ['worktree', 'remove', '--force', m[1]], { cwd: r }); } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }
  }
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5 });
});

describe('git helper', () => {
  it('slug', () => {
    expect(slug('Add a Login Form!! (v2)')).toBe('add-a-login-form-v2');
    expect(slug('x'.repeat(100)).length).toBeLessThanOrEqual(40);
    expect(slug('###')).toBe('ticket');
  });

  it('isRepo / hasCommit / gitInit', async () => {
    const d = tmp();
    expect(await isRepo(d)).toBe(false);
    expect(await hasCommit(d)).toBe(false);
    fs.writeFileSync(path.join(d, 'a.txt'), 'a');
    await gitInit(d);
    repos.push(d);
    expect(await isRepo(d)).toBe(true);
    expect(await hasCommit(d)).toBe(true);
    expect(fs.readFileSync(path.join(d, '.gitignore'), 'utf8')).toMatch(/node_modules/);
    expect(git(d, 'log', '-1', '--format=%s|%an <%ae>')).toBe('Initial commit (Pixel Office)|Pixel Office <office@localhost>');
    expect(git(d, 'status', '--porcelain')).toBe('');
  });

  it('gitInit keeps an existing .gitignore', async () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, '.gitignore'), 'custom\n');
    await gitInit(d);
    repos.push(d);
    expect(fs.readFileSync(path.join(d, '.gitignore'), 'utf8')).toBe('custom\n');
  });

  it('baseInfo reports branch, head, clean (untracked is dirty)', async () => {
    const r = await mkRepo();
    const b = await baseInfo(r);
    expect(b.branch).toBe(git(r, 'rev-parse', '--abbrev-ref', 'HEAD'));
    expect(b.head).toBe(git(r, 'rev-parse', 'HEAD'));
    expect(b.clean).toBe(true);
    fs.writeFileSync(path.join(r, 'new.txt'), 'x');
    expect((await baseInfo(r)).clean).toBe(false);
  });

  it('worktree: create, commitAll, diff, merge, remove', async () => {
    const r = await mkRepo();
    const base = (await baseInfo(r)).branch;
    const wt = path.join(tmp(), 'wt', 't1');
    await createWorktree(r, wt, 'office/feat-abc123', base);
    expect(fs.existsSync(path.join(wt, 'a.txt'))).toBe(true);
    expect(await commitAll(wt, 'office: build (backend)')).toBe(false);
    fs.writeFileSync(path.join(wt, 'b.txt'), 'b\n');
    fs.writeFileSync(path.join(wt, 'a.txt'), 'a2\n');
    expect(await commitAll(wt, 'office: build (backend)')).toBe(true);
    expect(git(wt, 'log', '-1', '--format=%s|%an <%ae>')).toBe('office: build (backend)|Pixel Office <office@localhost>');
    const files = await diff(r, base, 'office/feat-abc123');
    expect(files.map((f) => f.path).sort()).toEqual(['a.txt', 'b.txt']);
    expect(files.find((f) => f.path === 'b.txt')!.patch).toContain('+b');
    const res = await mergeIntoBase(r, 'office/feat-abc123', base);
    expect(res).toEqual({ merged: true });
    expect(fs.readFileSync(path.join(r, 'b.txt'), 'utf8').trim()).toBe('b');
    expect(git(r, 'log', '-1', '--format=%p')).toMatch(/ /); // merge commit (--no-ff)
    await removeWorktree(r, wt);
    expect(fs.existsSync(wt)).toBe(false);
    expect(git(r, 'branch', '--list', 'office/feat-abc123')).toContain('office/feat-abc123');
  });

  it('merge refused when owner tree is dirty', async () => {
    const r = await mkRepo();
    const base = (await baseInfo(r)).branch;
    const wt = path.join(tmp(), 'wt');
    await createWorktree(r, wt, 'office/x-111111', base);
    fs.writeFileSync(path.join(wt, 'b.txt'), 'b');
    await commitAll(wt, 'm');
    fs.writeFileSync(path.join(r, 'dirty.txt'), 'd');
    const res = await mergeIntoBase(r, 'office/x-111111', base);
    expect(res.merged).toBe(false);
    if (!res.merged) {
      expect(res.reason).toMatch(/uncommitted|clean/i);
      expect(res.instructions).toContain('git merge --no-ff office/x-111111');
      expect(res.instructions).toContain(base);
    }
    expect(fs.existsSync(path.join(r, 'b.txt'))).toBe(false);
  });

  it('merge refused when base is not checked out', async () => {
    const r = await mkRepo();
    const base = (await baseInfo(r)).branch;
    const wt = path.join(tmp(), 'wt');
    await createWorktree(r, wt, 'office/y-222222', base);
    fs.writeFileSync(path.join(wt, 'b.txt'), 'b');
    await commitAll(wt, 'm');
    git(r, 'checkout', '-q', '-b', 'other');
    const res = await mergeIntoBase(r, 'office/y-222222', base);
    expect(res.merged).toBe(false);
    if (!res.merged) {
      expect(res.reason).toMatch(/checked out/i);
      expect(res.instructions).toContain(`git checkout ${base}`);
    }
    expect(git(r, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('other');
  });

  it('merge conflict is aborted and reported', async () => {
    const r = await mkRepo();
    const base = (await baseInfo(r)).branch;
    const wt = path.join(tmp(), 'wt');
    await createWorktree(r, wt, 'office/z-333333', base);
    fs.writeFileSync(path.join(wt, 'a.txt'), 'branch\n');
    await commitAll(wt, 'm');
    fs.writeFileSync(path.join(r, 'a.txt'), 'owner\n');
    git(r, 'add', '-A');
    git(r, 'commit', '-q', '-m', 'owner');
    const res = await mergeIntoBase(r, 'office/z-333333', base);
    expect(res.merged).toBe(false);
    expect((await baseInfo(r)).clean).toBe(true);
  });
});
