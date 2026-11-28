import { execFile } from 'node:child_process';

/**
 * Agents may leave a process running in a ticket's worktree (a dev server started to check the page). On Windows a
 * folder that is some process's working folder can't be removed, so the next Resume / cleanup fails with EBUSY.
 * Before the office rebuilds or removes a ticket folder (and when a ticket ends) it stops those processes.
 * Matching is by command line: the process runs a file inside the folder.
 */
export interface Proc { pid: number; cmd: string }
export interface StrayDeps { list(): Promise<Proc[]>; kill(pid: number): Promise<void> }

const norm = (s: string, platform: NodeJS.Platform) => {
  const t = s.replace(/\\+/g, '/');
  return platform === 'win32' ? t.toLowerCase() : t;
};

/** Pids whose command line names a path inside `dir` (never `self`). */
export function straysIn(dir: string, procs: Proc[], self = process.pid, platform: NodeJS.Platform = process.platform): number[] {
  const d = norm(dir, platform).replace(/\/$/, '') + '/';
  return procs.filter(p => p.pid !== self && norm(p.cmd, platform).includes(d)).map(p => p.pid);
}

/** Stop every process running from inside `dir`; returns their pids. Never throws. */
export async function killStrays(dir: string, deps: StrayDeps = realDeps): Promise<number[]> {
  let pids: number[];
  try { pids = straysIn(dir, await deps.list()); } catch { return []; }
  for (const pid of pids) { try { await deps.kill(pid); } catch { /* already gone */ } }
  return pids;
}

const exec = (file: string, args: string[]) => new Promise<string>((resolve, reject) =>
  execFile(file, args, { windowsHide: true, maxBuffer: 32 * 1024 * 1024 }, (err, out) => (err ? reject(err) : resolve(out))));

export const realDeps: StrayDeps = {
  async list() {
    if (process.platform === 'win32') {
      const out = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        'Get-CimInstance Win32_Process | Where-Object { $_.CommandLine } | Select-Object ProcessId, CommandLine | ConvertTo-Json -Compress']);
      const rows = JSON.parse(out || '[]') as { ProcessId: number; CommandLine: string }[] | { ProcessId: number; CommandLine: string };
      return (Array.isArray(rows) ? rows : [rows]).map(r => ({ pid: r.ProcessId, cmd: r.CommandLine }));
    }
    const out = await exec('ps', ['-eo', 'pid=,args=']);
    return out.split('\n').map(l => l.trim().match(/^(\d+)\s+(.*)$/)).filter(Boolean).map(m => ({ pid: Number(m![1]), cmd: m![2] }));
  },
  async kill(pid) {
    if (process.platform === 'win32') await exec('taskkill', ['/PID', String(pid), '/T', '/F']);
    else process.kill(pid, 'SIGKILL');
  },
};
