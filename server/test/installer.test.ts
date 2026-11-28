import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Installer, packageName, parseInstallRequests, undeclared } from '../src/installer';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'po-inst-'));

describe('parseInstallRequests', () => {
  it('INSTALL: all → one request for everything package.json lists', () => {
    expect(parseInstallRequests('done\nINSTALL: all')).toEqual([{ repo: '', specs: [], bad: [] }]);
  });
  it('names a repo and splits specs on spaces and commas', () => {
    expect(parseInstallRequests('INSTALL angular: motion@^12.23.0, @scope/x@1'))
      .toEqual([{ repo: 'angular', specs: ['motion@^12.23.0', '@scope/x@1'], bad: [] }]);
  });
  it('rejects anything that is not a package spec', () => {
    expect(parseInstallRequests('INSTALL: x;rm -rf / ok')).toEqual([{ repo: '', specs: ['ok'], bad: ['x;rm', '-rf', '/'] }]);
  });
  it('ignores INSTALL mentioned mid-sentence', () => {
    expect(parseInstallRequests('I will not write INSTALL: all here')).toEqual([]);
  });
});

describe('packageName / undeclared', () => {
  it('strips the version, keeping a scope', () => {
    expect(packageName('@scope/x@1')).toBe('@scope/x');
    expect(packageName('motion@^12')).toBe('motion');
    expect(packageName('left-pad')).toBe('left-pad');
  });
  it('lists specs whose package is not in package.json', () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ dependencies: { motion: '^12' }, devDependencies: {} }));
    expect(undeclared(d, ['motion@^12', 'left'])).toEqual(['left']);
    expect(undeclared(tmp(), ['motion@^12'])).toEqual(['motion@^12']);
  });
});

describe('Installer', () => {
  const fake = () => {
    const calls: { cwd: string; args: string[] }[] = [];
    const gates: (() => void)[] = [];
    const exec = (cwd: string, args: string[]) => {
      calls.push({ cwd, args });
      return new Promise<{ code: number; output: string }>(r => gates.push(() => r({ code: 0, output: 'added 1 package' })));
    };
    return { calls, gates, exec };
  };
  const flush = () => new Promise(r => setTimeout(r, 5));

  it('npm install for all, --no-save for approved new packages', async () => {
    const f = fake();
    const i = new Installer({ exec: f.exec });
    const a = i.install('/r', []);
    await flush(); f.gates.shift()!();
    expect(await a).toMatchObject({ ok: true, command: 'npm install', output: 'added 1 package' });
    const b = i.install('/r', ['a@1'], { noSave: true });
    await flush(); f.gates.shift()!();
    await b;
    expect(f.calls.map(c => c.args)).toEqual([['install'], ['install', '--no-save', 'a@1']]);
  });

  it('one install per folder at a time; other folders run in parallel', async () => {
    const f = fake();
    const i = new Installer({ exec: f.exec });
    const a = i.install('/r', []);
    const b = i.install('/r', []);
    const c = i.install('/other', []);
    await flush();
    expect(f.calls.map(x => x.cwd)).toEqual(['/r', '/other']);
    expect(i.busy('/r')).toBe(true);
    f.gates.shift()!();
    await a; await flush();
    expect(f.calls.map(x => x.cwd)).toEqual(['/r', '/other', '/r']);
    f.gates.forEach(g => g());
    await Promise.all([b, c]);
    expect(i.busy('/r')).toBe(false);
  });

  it('waits while another installer (the Run tab) is busy in that folder', async () => {
    const f = fake();
    const i = new Installer({ exec: f.exec, pollMs: 5 });
    let other = true;
    i.waitFor(() => other);
    const a = i.install('/r', []);
    await flush(); await flush();
    expect(f.calls).toHaveLength(0);
    other = false;
    await new Promise(r => setTimeout(r, 30));
    expect(f.calls).toHaveLength(1);
    f.gates.shift()!();
    await a;
  });

  it('a failing npm reports ok: false with its output', async () => {
    const i = new Installer({ exec: async () => ({ code: 1, output: 'E404 not found' }) });
    expect(await i.install('/r', [])).toEqual({ ok: false, command: 'npm install', output: 'E404 not found' });
  });
});
