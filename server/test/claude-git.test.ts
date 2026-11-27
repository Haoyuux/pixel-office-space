import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  isRepo, hasCommit, gitInit, baseInfo, createWorktree, commitAll, diff, mergeIntoBase, removeWorktree, slug, detectRepos,
} from '../src/claude/git';

const dirs: string[] = [];
{
  const cfg = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'po-gitcfg-')), 'gitconfig');
  fs.writeFileSync(cfg, '');
  process.env.GIT_CONFIG_GLOBAL = cfg;
  process.env.GIT_CONFIG_NOSYSTEM = '1';
}
const repos: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'po-git-'));
  dirs.push(d);
  return d;
}
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim();

async function mkRepo(sub = ''): Promise<string> {
  let d = tmp();
  if (sub) { d = path.join(d, sub); fs.mkdirSync(d); }
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

  it('untracked Pixel Office files (.claude/agents, .claude/office) do not block a merge', async () => {
    const r = await mkRepo();
    const base = (await baseInfo(r)).branch;
    fs.mkdirSync(path.join(r, '.claude', 'agents'), { recursive: true });
    fs.writeFileSync(path.join(r, '.claude', 'agents', 'pm.md'), 'pm');
    fs.mkdirSync(path.join(r, '.claude', 'office'), { recursive: true });
    fs.writeFileSync(path.join(r, '.claude', 'office', 'project-map.md'), 'map');
    expect((await baseInfo(r)).clean).toBe(true);
    const wt = path.join(tmp(), 'wt');
    await createWorktree(r, wt, 'office/ag-121212', base);
    fs.writeFileSync(path.join(wt, 'b.txt'), 'b');
    await commitAll(wt, 'm');
    expect(await mergeIntoBase(r, 'office/ag-121212', base)).toEqual({ merged: true });
    expect(fs.existsSync(path.join(r, 'b.txt'))).toBe(true);
    // other untracked files under .claude still count as dirty
    fs.writeFileSync(path.join(r, '.claude', 'settings.json'), '{}');
    expect((await baseInfo(r)).clean).toBe(false);
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

  it('merge refused when the base or the owner is on a detached HEAD', async () => {
    const r = await mkRepo();
    const base = (await baseInfo(r)).branch;
    const wt = path.join(tmp(), 'wt');
    await createWorktree(r, wt, 'office/d-444444', base);
    fs.writeFileSync(path.join(wt, 'b.txt'), 'b');
    await commitAll(wt, 'm');
    const head = git(r, 'rev-parse', 'HEAD');
    git(r, 'checkout', '-q', '--detach');
    for (const b of ['HEAD', base]) {
      const res = await mergeIntoBase(r, 'office/d-444444', b);
      expect(res.merged).toBe(false);
      if (!res.merged) {
        expect(res.reason).toMatch(/not on a branch/i);
        expect(res.instructions).toContain('git merge --no-ff office/d-444444');
        expect(res.instructions).toMatch(/git checkout/);
      }
    }
    expect(git(r, 'rev-parse', 'HEAD')).toBe(head);
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

  it('conflict leaves HEAD unchanged and no MERGE_HEAD', async () => {
    const r = await mkRepo();
    const base = (await baseInfo(r)).branch;
    const wt = path.join(tmp(), 'wt');
    await createWorktree(r, wt, 'office/c-444444', base);
    fs.writeFileSync(path.join(wt, 'a.txt'), 'branch\n');
    await commitAll(wt, 'm');
    fs.writeFileSync(path.join(r, 'a.txt'), 'owner\n');
    git(r, 'add', '-A');
    git(r, 'commit', '-q', '-m', 'owner');
    const before = git(r, 'rev-parse', 'HEAD');
    const res = await mergeIntoBase(r, 'office/c-444444', base);
    expect(res.merged).toBe(false);
    if (!res.merged) expect(res.reason).toMatch(/conflict/i);
    expect(git(r, 'rev-parse', 'HEAD')).toBe(before);
    expect(fs.existsSync(path.join(r, '.git', 'MERGE_HEAD'))).toBe(false);
  });

  it('non-conflict merge failure is not called a conflict', async () => {
    const r = await mkRepo();
    const base = (await baseInfo(r)).branch;
    const res = await mergeIntoBase(r, 'office/does-not-exist', base);
    expect(res.merged).toBe(false);
    if (!res.merged) expect(res.reason).not.toMatch(/conflict/i);
  });

  it('works in a repo path with spaces', async () => {
    const r = await mkRepo('my repo');
    const base = (await baseInfo(r)).branch;
    const wt = path.join(tmp(), 'my wt');
    await createWorktree(r, wt, 'office/s-555555', base);
    fs.writeFileSync(path.join(wt, 'b.txt'), 'b');
    expect(await commitAll(wt, 'm')).toBe(true);
    expect(await mergeIntoBase(r, 'office/s-555555', base)).toEqual({ merged: true });
    await removeWorktree(r, wt);
    expect(fs.existsSync(wt)).toBe(false);
  });

  it('removeWorktree works on a dirty worktree', async () => {
    const r = await mkRepo();
    const base = (await baseInfo(r)).branch;
    const wt = path.join(tmp(), 'wt');
    await createWorktree(r, wt, 'office/d-666666', base);
    fs.writeFileSync(path.join(wt, 'junk.txt'), 'x');
    fs.writeFileSync(path.join(wt, 'a.txt'), 'changed');
    await removeWorktree(r, wt);
    expect(fs.existsSync(wt)).toBe(false);
  });

  it('createWorktree avoids branch and path collisions', async () => {
    const r = await mkRepo();
    const base = (await baseInfo(r)).branch;
    const wt = path.join(tmp(), 'wt');
    const a = await createWorktree(r, wt, 'office/k-777777', base);
    expect(a).toEqual({ branch: 'office/k-777777', path: wt });
    const b = await createWorktree(r, path.join(tmp(), 'wt2'), 'office/k-777777', base);
    expect(b.branch).not.toBe('office/k-777777');
    expect(b.branch.startsWith('office/k-777777')).toBe(true);
    const occupied = tmp();
    fs.writeFileSync(path.join(occupied, 'f'), 'x');
    const c = await createWorktree(r, occupied, 'office/k-888888', base);
    expect(c.path).not.toBe(occupied);
    expect(fs.existsSync(path.join(c.path, 'a.txt'))).toBe(true);
    dirs.push(c.path);
    // stale registration: dir deleted manually, then reuse same path
    fs.rmSync(wt, { recursive: true, force: true });
    const d = await createWorktree(r, wt, 'office/k-999999', base);
    expect(d.path).toBe(wt);
  });

  it('gitInit refuses an unreadable pre-existing .git and leaves it untouched', async () => {
    const d = tmp();
    fs.mkdirSync(path.join(d, '.git'));
    fs.writeFileSync(path.join(d, '.git', 'junk'), 'garbage\u0000bytes');
    fs.writeFileSync(path.join(d, 'a.txt'), 'a');
    await expect(gitInit(d)).rejects.toThrow(/\.git/);
    expect(fs.readdirSync(path.join(d, '.git'))).toEqual(['junk']);
    expect(fs.readFileSync(path.join(d, '.git', 'junk'), 'utf8')).toBe('garbage\u0000bytes');
    expect(fs.existsSync(path.join(d, '.gitignore'))).toBe(false);
  });

  it('gitInit failure cleanup removes only what it created', async () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, 'a.txt'), 'a');
    process.env.GIT_INDEX_FILE = path.join(d, 'no-such-dir', 'index');
    try {
      await expect(gitInit(d)).rejects.toThrow(/Could not initialize/);
    } finally {
      delete process.env.GIT_INDEX_FILE;
    }
    expect(fs.existsSync(path.join(d, '.git'))).toBe(false);
    expect(fs.existsSync(path.join(d, '.gitignore'))).toBe(false);
    expect(fs.readFileSync(path.join(d, 'a.txt'), 'utf8')).toBe('a');
  });

  it('gitInit failure keeps a pre-existing .gitignore and real repo', async () => {
    const r = await mkRepo();
    fs.writeFileSync(path.join(r, '.gitignore'), 'mine\n');
    git(r, 'add', '-A');
    git(r, 'commit', '-q', '-m', 'x');
    process.env.GIT_INDEX_FILE = path.join(r, 'no-such-dir', 'index');
    try {
      await expect(gitInit(r)).rejects.toThrow();
    } finally {
      delete process.env.GIT_INDEX_FILE;
    }
    expect(fs.existsSync(path.join(r, '.git'))).toBe(true);
    expect(fs.readFileSync(path.join(r, '.gitignore'), 'utf8')).toBe('mine\n');
  });

  it('ignores local gpgsign and failing hooks', async () => {
    const r = await mkRepo();
    git(r, 'config', 'commit.gpgsign', 'true');
    git(r, 'config', 'tag.gpgsign', 'true');
    git(r, 'config', 'gpg.program', path.join(os.tmpdir(), 'no-such-gpg-binary'));
    fs.writeFileSync(path.join(r, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const base = (await baseInfo(r)).branch;
    const wt = path.join(tmp(), 'wt');
    await createWorktree(r, wt, 'office/g-101010', base);
    fs.writeFileSync(path.join(wt, 'b.txt'), 'b');
    expect(await commitAll(wt, 'm')).toBe(true);
    expect(await mergeIntoBase(r, 'office/g-101010', base)).toEqual({ merged: true });
    const d = tmp();
    fs.writeFileSync(path.join(d, 'x.txt'), 'x');
    await gitInit(d);
    repos.push(d);
    expect(await hasCommit(d)).toBe(true);
  });
});

describe('detectRepos', () => {
  it('single when the folder is a repo (even a subfolder of one)', async () => {
    const r = await mkRepo();
    expect(await detectRepos(r)).toEqual({ kind: 'single' });
    fs.mkdirSync(path.join(r, 'sub'));
    expect(await detectRepos(path.join(r, 'sub'))).toEqual({ kind: 'single' });
  });

  it('multi: direct subfolders that are repos with a commit, sorted; skips dot/node_modules/empty repos', async () => {
    const parent = tmp();
    for (const name of ['zeta', 'angular', 'aspnet-core', 'node_modules', '.hidden']) {
      const d = path.join(parent, name);
      fs.mkdirSync(d);
      fs.writeFileSync(path.join(d, 'a.txt'), 'a');
      await gitInit(d);
      repos.push(d);
    }
    fs.mkdirSync(path.join(parent, 'empty'));
    git(path.join(parent, 'empty'), 'init', '-q');
    fs.mkdirSync(path.join(parent, 'plain'));
    fs.writeFileSync(path.join(parent, 'file.txt'), 'x');
    const r = await detectRepos(parent);
    expect(r).toEqual({ kind: 'multi', repos: ['angular', 'aspnet-core', 'zeta'].map(n => ({ name: n, path: path.join(parent, n) })) });
  });

  it('none when neither (and for a missing folder)', async () => {
    const d = tmp();
    fs.mkdirSync(path.join(d, 'plain'));
    expect(await detectRepos(d)).toEqual({ kind: 'none' });
    expect(await detectRepos(path.join(d, 'nope'))).toEqual({ kind: 'none' });
  });
});
