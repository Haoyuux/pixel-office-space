import { describe, it, expect } from 'vitest';
import { killStrays, straysIn } from '../src/strays';

const win = (...parts: string[]) => parts.join('\\');
const WT = win('D:', 'Project', 'Github', 'space-project', 'server', 'data', 'wt', '98cfff84', 'cf9cb11f');

describe('straysIn', () => {
  const procs = [
    { pid: 37824, cmd: `"node" "${win(WT, 'node_modules', '.bin', '', '..', 'vite', 'bin', 'vite.js')}" --port 5791 --strictPort` },
    { pid: 2, cmd: 'node D:/project/github/space-project/server/data/wt/98cfff84/cf9cb11f/x.js' },
    { pid: 3, cmd: `node ${win(WT + '0', 'other.js')}` },
    { pid: 4, cmd: `node ${win('D:', 'Project', 'bpm_portfolio', 'vite.js')}` },
    { pid: 5, cmd: `node ${win(WT, 'self.js')}` },
  ];
  it('finds processes whose command line points inside the folder (any case and slash), never itself', () => {
    expect(straysIn(WT, procs, 5, 'win32')).toEqual([37824, 2]);
  });
  it('is case-sensitive off Windows', () => {
    expect(straysIn(WT, procs, 5, 'linux')).toEqual([37824]);
  });
});

describe('killStrays', () => {
  it('kills only the processes inside the folder and returns their pids', async () => {
    const killed: number[] = [];
    const pids = await killStrays(WT, {
      list: async () => [{ pid: 11, cmd: `node ${win(WT, 'a.js')}` }, { pid: 12, cmd: 'node elsewhere.js' }],
      kill: async pid => { killed.push(pid); },
    });
    expect(pids).toEqual([11]);
    expect(killed).toEqual([11]);
  });
  it('never throws when listing fails', async () => {
    expect(await killStrays(WT, { list: async () => { throw new Error('no ps'); }, kill: async () => undefined })).toEqual([]);
  });
});
