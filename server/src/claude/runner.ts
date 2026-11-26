import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import type { RoleId } from '@office/shared';

/** Env vars that would make the CLI bypass the owner's subscription login. */
const STRIPPED_ENV = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'];
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_GRACE_MS = 5000;
const STDERR_TAIL = 2000;

export type RunnerEvent =
  | { kind: 'init'; sessionId: string; model: string }
  | { kind: 'text'; text: string }
  | { kind: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { kind: 'tool_result'; id: string; isError: boolean; content: string }
  | { kind: 'raw'; line: string };

export interface RunOptions {
  cwd: string;
  role: RoleId;
  prompt: string;
  resume?: string;
  allowedTools: string[];
  maxTurns: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  onEvent(e: RunnerEvent): void;
}

export interface RunResult {
  sessionId: string; result: string; isError: boolean; subtype: string; numTurns: number; costUsd: number; durationMs: number;
}

/** `CLAUDE_BIN` env → `~/.local/bin/claude(.exe)` → `claude` on PATH. */
export function resolveClaudeBin(env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = existsSync): string {
  if (env.CLAUDE_BIN) return env.CLAUDE_BIN;
  const home = process.platform === 'win32' ? env.USERPROFILE : env.HOME;
  if (home) {
    const local = path.join(home, '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude');
    if (exists(local)) return local;
  }
  return 'claude';
}

/** Optional leading args for the binary (`CLAUDE_BIN_ARGS`, a JSON string array), e.g. `["fake-claude.mjs"]` with `CLAUDE_BIN=node`. */
export function resolveClaudeBinArgs(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.CLAUDE_BIN_ARGS;
  if (!raw) return [];
  let v: unknown;
  try { v = JSON.parse(raw); } catch { v = null; }
  if (!Array.isArray(v) || !v.every(x => typeof x === 'string')) throw new Error('CLAUDE_BIN_ARGS must be a JSON array of strings');
  return v;
}

/** Copy of env without the vars that would switch the CLI away from the subscription login (case-insensitive). */
export function childEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (!STRIPPED_ENV.includes(k.toUpperCase())) out[k] = v;
  return out;
}

export function buildArgs(o: Pick<RunOptions, 'prompt' | 'role' | 'maxTurns' | 'resume' | 'allowedTools'>): string[] {
  const args = ['-p', o.prompt, '--agent', o.role, '--output-format', 'stream-json', '--verbose',
    '--permission-mode', 'dontAsk', '--max-turns', String(o.maxTurns)];
  if (o.resume) args.push('--resume', o.resume);
  // --allowedTools is variadic, so it goes last. Omitted when empty (the CLI rejects a bare flag).
  if (o.allowedTools.length) args.push('--allowedTools', ...o.allowedTools);
  return args;
}

const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function contentText(c: unknown): string {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map(p => (p && typeof p === 'object' && typeof (p as any).text === 'string' ? (p as any).text : JSON.stringify(p))).join('\n');
  return c == null ? '' : JSON.stringify(c);
}

/** Parse one stdout line. Every line yields a `raw` event first; known JSON shapes add typed events. */
export function parseLine(line: string): { events: RunnerEvent[]; result?: RunResult } {
  const events: RunnerEvent[] = [{ kind: 'raw', line }];
  let o: any;
  try { o = JSON.parse(line); } catch { return { events }; }
  if (!o || typeof o !== 'object') return { events };
  if (o.type === 'system' && o.subtype === 'init') {
    events.push({ kind: 'init', sessionId: str(o.session_id), model: str(o.model) });
  } else if (o.type === 'assistant' && Array.isArray(o.message?.content)) {
    for (const c of o.message.content) {
      if (c?.type === 'text' && str(c.text).trim()) events.push({ kind: 'text', text: c.text });
      else if (c?.type === 'tool_use') events.push({ kind: 'tool_use', id: str(c.id), name: str(c.name), input: c.input && typeof c.input === 'object' ? c.input : {} });
    }
  } else if (o.type === 'user' && Array.isArray(o.message?.content)) {
    for (const c of o.message.content) {
      if (c?.type === 'tool_result') events.push({ kind: 'tool_result', id: str(c.tool_use_id), isError: c.is_error === true, content: contentText(c.content) });
    }
  } else if (o.type === 'result') {
    return {
      events,
      result: {
        sessionId: str(o.session_id), result: str(o.result), isError: o.is_error === true, subtype: str(o.subtype),
        numTurns: num(o.num_turns), costUsd: num(o.total_cost_usd), durationMs: num(o.duration_ms),
      },
    };
  }
  return { events };
}

function namedError(name: string, message: string): Error {
  const e = new Error(message); e.name = name; return e;
}

export interface RunnerConfig {
  bin?: string;
  binArgs?: string[];
  /** Time between the graceful stop attempt and the forced tree kill. */
  killGraceMs?: number;
}

export class ClaudeRunner {
  private readonly bin: string;
  private readonly binArgs: string[];
  private readonly graceMs: number;

  constructor(cfg: RunnerConfig = {}) {
    this.bin = cfg.bin ?? resolveClaudeBin();
    this.binArgs = cfg.binArgs ?? (cfg.bin ? [] : resolveClaudeBinArgs());
    this.graceMs = cfg.killGraceMs ?? DEFAULT_GRACE_MS;
  }

  run(o: RunOptions): Promise<RunResult> {
    if (o.signal?.aborted) return Promise.reject(namedError('AbortError', 'claude run aborted'));
    return new Promise<RunResult>((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = spawn(this.bin, [...this.binArgs, ...buildArgs(o)], {
          cwd: o.cwd, env: childEnv(process.env), shell: false, windowsHide: true,
          detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (e) {
        reject(new Error(`could not start claude (${this.bin}): ${(e as Error).message}`));
        return;
      }

      let result: RunResult | undefined;
      let sessionId = '';
      let stderr = '';
      let stopReason: Error | null = null;
      let settled = false;
      const timers: NodeJS.Timeout[] = [];

      const emit = (e: RunnerEvent) => { try { o.onEvent(e); } catch { /* listener errors must not break the run */ } };
      const finish = (err: Error | null, r?: RunResult) => {
        if (settled) return;
        settled = true;
        timers.forEach(clearTimeout);
        o.signal?.removeEventListener('abort', onAbort);
        if (err) reject(err); else resolve(r!);
      };
      const stop = (reason: Error) => {
        if (stopReason || settled) return;
        stopReason = reason;
        killTree(child, this.graceMs, () => {
          // Forced kill issued; if streams never close (an orphan holding a pipe), settle anyway.
          timers.push(setTimeout(() => finish(stopReason), 2000));
        });
      };
      const onAbort = () => stop(namedError('AbortError', 'claude run aborted'));
      o.signal?.addEventListener('abort', onAbort, { once: true });
      const timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      timers.push(setTimeout(() => stop(namedError('TimeoutError', `claude run timed out after ${timeoutMs} ms`)), timeoutMs));

      readline.createInterface({ input: child.stdout! }).on('line', line => {
        if (!line.trim()) return;
        const p = parseLine(line);
        for (const e of p.events) {
          if (e.kind === 'init' && e.sessionId) sessionId = e.sessionId;
          emit(e);
        }
        if (p.result) result = p.result;
      });
      readline.createInterface({ input: child.stderr! }).on('line', line => {
        stderr = (stderr + line + '\n').slice(-STDERR_TAIL);
        if (line.trim()) emit({ kind: 'raw', line: `[stderr] ${line}` });
      });

      child.on('error', err => {
        const code = (err as NodeJS.ErrnoException).code;
        finish(new Error(code === 'ENOENT'
          ? `claude CLI not found (${this.bin}); install Claude Code or set CLAUDE_BIN`
          : `claude process error: ${err.message}`));
      });
      child.on('close', code => {
        if (stopReason) return finish(stopReason);
        if (result) return finish(null, { ...result, sessionId: result.sessionId || sessionId });
        finish(new Error(`claude exited with code ${code} without a result${stderr.trim() ? `:\n${stderr.trim()}` : ''}`));
      });
    });
  }
}

/**
 * Stop a CLI process and everything it started.
 * Windows: a no-shell child has no real Ctrl+C, and `child.kill()` would kill only the top process (orphaning its
 * children), so the graceful attempt is a non-forced `taskkill /T`; after the grace period `taskkill /T /F`.
 * POSIX: the child leads its own process group (detached) → SIGINT to the group, then SIGKILL.
 */
function killTree(child: ChildProcess, graceMs: number, onForced: () => void): void {
  const pid = child.pid;
  if (pid == null) { onForced(); return; }
  const exited = () => child.exitCode !== null || child.signalCode !== null;
  if (process.platform === 'win32') {
    execFile('taskkill', ['/PID', String(pid), '/T'], { windowsHide: true }, () => {});
    setTimeout(() => {
      // Once the top process is gone its PID may be reused and its tree can't be walked, so only force-kill a live one.
      if (!exited()) execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => {});
      onForced();
    }, graceMs).unref();
  } else {
    const sig = (s: NodeJS.Signals) => { try { process.kill(-pid, s); } catch { try { child.kill(s); } catch { /* gone */ } } };
    sig('SIGINT');
    setTimeout(() => { sig('SIGKILL'); onForced(); }, exited() ? 0 : graceMs).unref();
  }
}
