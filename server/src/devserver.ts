import { spawn, execFile, execFileSync, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import readline from 'node:readline';
import { DEV_LOG_MAX, type DevServerState, type Project, type ServerEvent } from '@office/shared';
import { ConflictError, ValidationError } from './errors';
import { killTree } from './claude/runner';
import type { Installer } from './installer';
import { realDeps as realProcs, type StrayDeps } from './strays';

/** Scripts tried in this order when the owner does not name one. */
export const DEFAULT_SCRIPTS = ['dev', 'start', 'serve', 'preview'];
/** A script name we pass to the shell: package.json keys only, and nothing a shell would read as syntax. */
const SAFE_SCRIPT = /^[\w:.@/-]+$/;
const LINE_MAX = 2000;
const FLUSH_MS = 100;
const GRACE_MS = 3000;

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
export const stripAnsi = (s: string) => s.replace(ANSI, '');
const URL_RE = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]|[a-z0-9.-]+)(?::\d{1,5})?(?:\/[^\s'"<>)\]]*)?/gi;
const LOCAL_HOST = /^https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::|\/|$)/i;

/** URLs a dev server printed on one line: [local ones first]; 0.0.0.0 / [::] become localhost (they are bind addresses). */
export function urlsIn(line: string): { url: string; local: boolean }[] {
  return [...stripAnsi(line).matchAll(URL_RE)].map(m => {
    const url = m[0].replace(/[.,;:]+$/, '').replace(/^(https?:\/\/)(?:0\.0\.0\.0|\[::\])/i, '$1localhost');
    return { url, local: LOCAL_HOST.test(url) };
  });
}

const sameDir = (d: string) => { const r = resolve(d); return process.platform === 'win32' ? r.toLowerCase() : r; };

/** A started dev server as recorded on disk: `pid` is the shell the office spawned (npm runs under it). */
interface DevRecord { projectId: string; cwd: string; pid: number; startedAt: string }

export interface RunTarget { cwd: string; scripts: string[]; script?: string }

/** package.json scripts of a folder (null when it has no readable package.json). */
function scriptsOf(dir: string): string[] | null {
  const f = join(dir, 'package.json');
  if (!existsSync(f)) return null;
  try {
    const pkg = JSON.parse(readFileSync(f, 'utf8')) as { scripts?: unknown };
    return pkg.scripts && typeof pkg.scripts === 'object' ? Object.keys(pkg.scripts as object) : [];
  } catch { return null; }
}

/** Where ▶ Run runs: the project folder, else the first repo of a multi-repo project that has a package.json. */
export function runTarget(project: Pick<Project, 'folder' | 'repos'>): RunTarget | null {
  for (const dir of [project.folder, ...(project.repos ?? []).map(r => r.path)]) {
    const scripts = scriptsOf(dir);
    if (scripts) return { cwd: dir, scripts, script: DEFAULT_SCRIPTS.find(s => scripts.includes(s)) };
  }
  return null;
}

interface Proc {
  state: DevServerState; log: string[]; child?: ChildProcess; stopping: boolean;
  pending: string[]; flush?: NodeJS.Timeout; fallbackUrl: boolean;
}

/**
 * Dev servers the office owns (one per project). Unlike agent runs they have no time limit and keep running until the
 * owner stops them, the project is removed or the office server stops (process trees are killed, never orphaned).
 */
export class DevServers {
  private procs = new Map<string, Proc>();
  /** Processes told to stop that have not closed yet. */
  private dying = new Set<ChildProcess>();
  private listeners: ((e: ServerEvent) => void)[] = [];
  constructor(private opts: {
    now?: () => string; graceMs?: number; installer?: Pick<Installer, 'busy'>;
    /** Where started servers are recorded, so the next office start can stop what a killed office left behind. */
    stateFile?: string;
    reap?: StrayDeps;
  } = {}) {}

  private records(): DevRecord[] {
    if (!this.opts.stateFile) return [];
    try { const r = JSON.parse(readFileSync(this.opts.stateFile, 'utf8')); return Array.isArray(r) ? r : []; } catch { return []; }
  }
  private saveRecords(r: DevRecord[]) {
    if (!this.opts.stateFile) return;
    try { writeFileSync(this.opts.stateFile, JSON.stringify(r)); } catch { /* best effort */ }
  }

  /**
   * Office start: an office killed outright (a `tsx watch` restart on Windows, a crash) never stopped its dev servers,
   * and their npm process lives on under the shell that is gone. Stop each recorded server's npm tree — only npm
   * processes whose parent is a recorded shell pid (or that shell itself), never anything else — then clear the record.
   */
  async reapOrphans(): Promise<number[]> {
    const recs = this.records();
    if (!recs.length) return [];
    const deps = this.opts.reap ?? realProcs;
    const shells = new Set(recs.map(r => r.pid));
    let pids: number[] = [];
    try {
      pids = (await deps.list())
        .filter(p => (shells.has(p.pid) || (p.ppid !== undefined && shells.has(p.ppid))) && /npm/i.test(p.cmd))
        .map(p => p.pid);
    } catch { /* cannot list: nothing to do */ }
    for (const pid of pids) { try { await deps.kill(pid); } catch { /* already gone */ } }
    this.saveRecords([]);
    return pids;
  }

  onEvent(cb: (e: ServerEvent) => void) { this.listeners.push(cb); }
  private now() { return this.opts.now?.() ?? new Date().toISOString(); }
  private emit(e: ServerEvent) { for (const l of this.listeners) { try { l(e); } catch (err) { console.error(err); } } }

  state(projectId: string): DevServerState { return this.procs.get(projectId)?.state ?? { projectId, status: 'idle' }; }
  log(projectId: string): string[] { return this.procs.get(projectId)?.log ?? []; }
  /** Every started server (snapshot). */
  all(): DevServerState[] { return [...this.procs.values()].map(p => p.state); }
  isLive(projectId: string) { const s = this.state(projectId).status; return s === 'starting' || s === 'running'; }
  /** A Run-tab `npm install` is running in this folder (ticket installs wait for it). */
  installing(cwd: string): boolean {
    const k = sameDir(cwd);
    return [...this.procs.values()].some(p => p.state.script === 'install' && (p.state.status === 'starting' || p.state.status === 'running') && !!p.state.cwd && sameDir(p.state.cwd) === k);
  }

  /** `install: true` runs `npm install` instead of a script (missing packages); it ends by itself. */
  start(project: Pick<Project, 'id' | 'folder' | 'repos'>, requested?: unknown, install = false): DevServerState {
    if (this.isLive(project.id)) throw new ConflictError('The dev server is already running — stop it first');
    if (requested !== undefined && requested !== null && requested !== '' && typeof requested !== 'string') throw new ValidationError('script must be a string');
    const target = runTarget(project);
    if (!target) throw new ValidationError(`No package.json found in ${project.folder}: ▶ Run starts npm scripts (dev / start)`);
    if (install) {
      if (this.opts.installer?.busy(target.cwd)) throw new ConflictError('An install for a ticket is running in this folder — try again in a moment');
      return this.spawn(project.id, target.cwd, 'install', 'npm install');
    }
    const script = (requested as string | undefined) || target.script;
    if (!script) {
      throw new ValidationError(`package.json has no ${DEFAULT_SCRIPTS.join(' / ')} script${target.scripts.length ? ` (it has: ${target.scripts.join(', ')})` : ''}`);
    }
    if (!target.scripts.includes(script)) throw new ValidationError(`package.json has no "${script}" script (it has: ${target.scripts.join(', ') || 'none'})`);
    if (!SAFE_SCRIPT.test(script)) throw new ValidationError(`Script name "${script}" can't be run from here`);
    return this.spawn(project.id, target.cwd, script, `npm run ${script}`);
  }

  private spawn(projectId: string, cwd: string, script: string, command: string): DevServerState {
    const old = this.procs.get(projectId);
    if (old?.flush) clearTimeout(old.flush);
    const p: Proc = {
      state: { projectId, status: 'starting', script, cwd, startedAt: this.now() },
      log: [], stopping: false, pending: [], fallbackUrl: false,
    };
    this.procs.set(projectId, p);
    this.emit({ type: 'devserver.log', projectId, lines: [], reset: true, ts: this.now() });
    this.line(p, `$ ${command}   (in ${cwd})`);

    let child: ChildProcess;
    try {
      // npm is a .cmd on Windows: it needs a shell (the script name was checked against package.json and SAFE_SCRIPT)
      child = spawn(command, {
        cwd, shell: true, windowsHide: true, detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, FORCE_COLOR: '0' },
      });
    } catch (e) {
      return this.end(p, { status: 'failed', error: `Could not start npm: ${(e as Error).message}` });
    }
    p.child = child;
    const pid = child.pid;
    if (pid != null) {
      this.saveRecords([...this.records().filter(r => r.projectId !== projectId), { projectId, cwd, pid, startedAt: p.state.startedAt! }]);
    }
    const forget = () => { if (pid != null) this.saveRecords(this.records().filter(r => r.pid !== pid)); };
    child.once('close', forget);
    child.once('error', forget);
    for (const s of [child.stdout!, child.stderr!]) readline.createInterface({ input: s }).on('line', l => this.line(p, l));
    child.on('error', err => this.end(p, { status: 'failed', error: `Could not start npm: ${err.message}` }));
    child.on('close', code => {
      if (p.stopping) this.end(p, { status: 'stopped', exitCode: code });
      else this.end(p, { status: 'exited', exitCode: code, ...(code ? { error: `${command} exited with code ${code}` } : {}) });
    });
    this.emitState(p);
    return p.state;
  }

  stop(projectId: string): DevServerState {
    const p = this.procs.get(projectId);
    if (!p || !this.isLive(projectId)) return this.state(projectId);
    if (p.stopping) return p.state;
    p.stopping = true;
    this.line(p, '■ Stopping…');
    if (p.child) this.kill(p.child);
    else this.end(p, { status: 'stopped' });
    return p.state;
  }

  /**
   * Windows: straight to `taskkill /T /F` (a hidden console tree ignores a polite taskkill, and if the shell died first
   * its node child could no longer be found). POSIX: the shared runner kill (SIGINT to the group, then SIGKILL).
   */
  private kill(child: ChildProcess) {
    this.dying.add(child);
    child.once('close', () => this.dying.delete(child));
    if (process.platform === 'win32' && child.pid != null) {
      execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
    } else killTree(child, this.opts.graceMs ?? GRACE_MS, () => {});
  }

  /** Project removed: stop it and forget it (a dying process is still reaped by shutdown / exit). */
  remove(projectId: string) { this.stop(projectId); this.procs.delete(projectId); }

  /** Server stop: stop every live server and wait (briefly) for them, and any still dying, to end. */
  async shutdown(timeoutMs = 5000): Promise<void> {
    const live = [...this.procs.values()].filter(p => this.isLive(p.state.projectId) && p.child);
    for (const p of live) this.stop(p.state.projectId);
    const all = [...live.map(p => p.child!), ...this.dying].filter(c => c.exitCode === null && c.signalCode === null);
    await Promise.race([
      Promise.all([...new Set(all)].map(c => new Promise<void>(r => c.once('close', () => r())))),
      new Promise(r => setTimeout(r, timeoutMs).unref()),
    ]);
  }

  /** process 'exit': synchronous forced kill of every live tree. */
  killAllSync() {
    for (const child of [...[...this.procs.values()].map(p => p.child), ...this.dying]) {
      const pid = child?.pid;
      if (pid == null || child!.exitCode !== null || child!.signalCode !== null) continue;
      try {
        if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        else { try { process.kill(-pid, 'SIGKILL'); } catch { process.kill(pid, 'SIGKILL'); } }
      } catch { /* already gone */ }
    }
  }

  private line(p: Proc, raw: string) {
    // progress output redraws with \r: keep what the line ends as
    const text = stripAnsi(raw.slice(raw.lastIndexOf('\r') + 1)).slice(0, LINE_MAX);
    if (!p.state.url || p.fallbackUrl) {
      const found = urlsIn(text);
      const local = found.find(u => u.local);
      const pick = local ?? (!p.state.url ? found[0] : undefined);
      if (pick && (this.procs.get(p.state.projectId) === p)) {
        p.fallbackUrl = !local;
        p.state = { ...p.state, url: pick.url, ...(p.state.status === 'starting' ? { status: 'running' } : {}) };
        this.emitState(p);
      }
    }
    p.log.push(text);
    if (p.log.length > DEV_LOG_MAX) p.log.splice(0, p.log.length - DEV_LOG_MAX);
    p.pending.push(text);
    p.flush ??= setTimeout(() => this.flush(p), FLUSH_MS);
  }

  private flush(p: Proc) {
    if (p.flush) clearTimeout(p.flush);
    p.flush = undefined;
    if (!p.pending.length || this.procs.get(p.state.projectId) !== p) { p.pending = []; return; }
    const lines = p.pending.splice(0);
    this.emit({ type: 'devserver.log', projectId: p.state.projectId, lines, ts: this.now() });
  }

  private end(p: Proc, s: Partial<DevServerState>): DevServerState {
    if (p.state.status !== 'starting' && p.state.status !== 'running') return p.state; // already ended (error + close)
    if (s.error) this.line(p, `✖ ${s.error}`);
    else if (s.status === 'stopped') this.line(p, '■ Stopped');
    else this.line(p, `● Exited${s.exitCode != null ? ` (code ${s.exitCode})` : ''}`);
    this.flush(p);
    p.state = { ...p.state, ...s, endedAt: this.now() };
    this.emitState(p);
    return p.state;
  }

  private emitState(p: Proc) {
    if (this.procs.get(p.state.projectId) !== p) return;
    this.emit({ type: 'devserver.updated', projectId: p.state.projectId, state: p.state, ts: this.now() });
  }
}
