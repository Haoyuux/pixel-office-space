import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { killTree } from './claude/runner';

/**
 * Agents never run npm in a worktree whose node_modules is a link to the owner's checkout; they ask instead with a
 * line `INSTALL: all` / `INSTALL: <spec> …` / `INSTALL <repo>: …`, and the office runs npm in the owner's folder.
 */
export interface InstallRequest { /** '' = no repo named */ repo: string; /** [] = everything package.json lists */ specs: string[]; bad: string[] }

const LINE = /^[ \t]*INSTALL(?:[ \t]+([\w.-]+))?[ \t]*:[ \t]*(.+)$/gm;
/** Only names and version ranges: a spec never carries shell syntax. */
const SPEC = /^(@\w[\w.-]*\/)?\w[\w.-]*(@[\w.^~<>=*|+-]+)?$/;
const OUTPUT_MAX = 4000;
const NOTHING = new Set(['none', 'nothing', 'no', 'n/a', '-']);

export function parseInstallRequests(text: string): InstallRequest[] {
  const out: InstallRequest[] = [];
  for (const m of text.matchAll(LINE)) {
    const words = m[2].trim().replace(/[`'"]/g, '').split(/[\s,]+/).filter(Boolean);
    if (NOTHING.has(words[0]?.toLowerCase())) continue;
    if (words.length === 1 && words[0].toLowerCase() === 'all') { out.push({ repo: m[1] ?? '', specs: [], bad: [] }); continue; }
    // one word that is not a spec means the line is prose ("motion (needed for animations)"): nothing from it installs
    const bad = words.filter(w => !SPEC.test(w));
    out.push({ repo: m[1] ?? '', specs: bad.length ? [] : words, bad });
  }
  return out;
}

export function packageName(spec: string): string {
  const at = spec.indexOf('@', spec.startsWith('@') ? 1 : 0);
  return at > 0 ? spec.slice(0, at) : spec;
}

const DEP_KEYS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];

/**
 * Specs the owner has to OK: the package is not in the repo's package.json (all of them when it has none), or the
 * spec asks for a different version range than the one declared.
 */
export function needsApproval(repoDir: string, specs: string[]): string[] {
  let pkg: Record<string, Record<string, string> | undefined>;
  try { pkg = JSON.parse(fs.readFileSync(path.join(repoDir, 'package.json'), 'utf8')); } catch { return [...specs]; }
  const declared = new Map(DEP_KEYS.flatMap(k => Object.entries(pkg[k] ?? {})));
  return specs.filter(s => {
    const name = packageName(s);
    const range = s.slice(name.length + 1);
    return !declared.has(name) || (!!range && range !== declared.get(name));
  });
}

/** cmd.exe (shell: true on Windows) would read | < > ^ & in a version range as syntax: quote every argument there. */
export function shellArgs(args: string[], platform: NodeJS.Platform = process.platform): string[] {
  return platform === 'win32' ? args.map(a => (/^[\w-]+$/.test(a) ? a : `"${a}"`)) : args;
}

export interface InstallResult { ok: boolean; command: string; output: string }
type Exec = (cwd: string, args: string[]) => Promise<{ code: number; output: string }>;

export class Installer {
  private chains = new Map<string, Promise<unknown>>();
  private running = new Set<string>();
  private others: ((cwd: string) => boolean)[] = [];
  private exec: Exec;
  private pollMs: number;
  /** Packages installed with --no-save per folder: npm prunes what package.json lacks, so every later install repeats them. */
  private extras = new Map<string, Map<string, string>>();

  constructor(opts: { exec?: Exec; timeoutMs?: number; pollMs?: number } = {}) {
    this.exec = opts.exec ?? npmExec(opts.timeoutMs ?? 10 * 60_000);
    this.pollMs = opts.pollMs ?? 500;
  }

  /** Another installer (the Run tab's npm install) that must not overlap ours in the same folder. */
  waitFor(fn: (cwd: string) => boolean) { this.others.push(fn); }

  busy(cwd: string): boolean { return this.running.has(key(cwd)); }

  /** npm install in `cwd`, after any earlier install there has finished. Never throws. */
  install(cwd: string, specs: string[], opts: { noSave?: boolean } = {}): Promise<InstallResult> {
    const k = key(cwd);
    const p = (this.chains.get(k) ?? Promise.resolve()).catch(() => undefined).then(async (): Promise<InstallResult> => {
      while (this.others.some(f => f(cwd))) await new Promise(r => setTimeout(r, this.pollMs));
      const kept = new Map(this.extras.get(k) ?? []);
      if (opts.noSave) for (const s of specs) kept.set(packageName(s), s);
      const args = kept.size ? ['install', '--no-save', ...kept.values(), ...(opts.noSave ? [] : specs)]
        : ['install', ...specs];
      const command = `npm ${args.join(' ')}`;
      this.running.add(k);
      try {
        const r = await this.exec(cwd, args);
        if (r.code === 0 && opts.noSave) this.extras.set(k, kept);
        return { ok: r.code === 0, command, output: r.output.slice(-OUTPUT_MAX) };
      } catch (err) {
        return { ok: false, command: 'npm install', output: err instanceof Error ? err.message : String(err) };
      } finally {
        this.running.delete(k);
      }
    });
    this.chains.set(k, p);
    void p.finally(() => { if (this.chains.get(k) === p) this.chains.delete(k); });
    return p;
  }
}

const key = (cwd: string) => {
  const r = path.resolve(cwd);
  return process.platform === 'win32' ? r.toLowerCase() : r;
};

function npmExec(timeoutMs: number): Exec {
  return (cwd, args) => new Promise(resolve => {
    let output = '';
    const child = spawn('npm', shellArgs(args), { cwd, shell: process.platform === 'win32', windowsHide: true, env: process.env });
    const add = (b: Buffer) => { output = (output + b.toString()).slice(-OUTPUT_MAX * 2); };
    child.stdout?.on('data', add);
    child.stderr?.on('data', add);
    const timer = setTimeout(() => { output += '\n(timed out)'; killTree(child, 3000, () => undefined); }, timeoutMs);
    child.on('error', err => { clearTimeout(timer); resolve({ code: -1, output: `${output}\n${err.message}` }); });
    child.on('close', code => { clearTimeout(timer); resolve({ code: code ?? -1, output }); });
  });
}
