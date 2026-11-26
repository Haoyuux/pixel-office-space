import { execFile } from 'node:child_process';
import { childEnv, resolveClaudeBin, resolveClaudeBinArgs } from './runner';

export interface ClaudeStatus {
  found: boolean; version: string | null; loggedIn: boolean; accountType: string | null; signInEndsAt: string | null;
}
export type Exec = (args: string[]) => Promise<{ code: number; stdout: string }>;

/** Runs the real `claude` binary (CLAUDE_BIN honoured); a spawn failure = code -1 (not found). */
export function realExec(bin = resolveClaudeBin(), binArgs = resolveClaudeBinArgs()): Exec {
  return args => new Promise(resolve => {
    execFile(bin, [...binArgs, ...args], { env: childEnv(process.env), timeout: 15_000, windowsHide: true }, (err, stdout) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : -1) : 0;
      resolve({ code, stdout: String(stdout ?? '') });
    });
  });
}

/**
 * Parse `claude auth status --text`. Only the login state, account type and sign-in end are kept —
 * email / organization lines are deliberately never read into the result.
 */
export function parseAuthStatus(text: string): Pick<ClaudeStatus, 'loggedIn' | 'accountType' | 'signInEndsAt'> {
  // Real output (claude 2.1.x):
  //   Login method: Claude Ultra account
  //   Organization: …            <- never read
  //   Email: …                   <- never read
  //   Sign-in ends: between 2026-12-17 and 2026-12-20 (2026-12-20T08:54:14.645Z)
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  let accountType: string | null = null;
  let signInEndsAt: string | null = null;
  let loggedIn = false;
  for (const l of lines) {
    const m = /^login method\s*:\s*(.+)$/i.exec(l);
    if (m) {
      loggedIn = true;
      if (!accountType && !/@/.test(m[1])) accountType = m[1].trim();
      continue;
    }
    const e = /^sign-?in ends\s*:\s*(.+)$/i.exec(l);
    if (e && !signInEndsAt) {
      // prefer the exact ISO timestamp in parentheses; else the last date on the line
      const iso = /\((\d{4}-\d{2}-\d{2}T[^)\s]+)\)/.exec(e[1])?.[1] ?? e[1].match(/\d{4}-\d{2}-\d{2}(?:T[^\s)]+)?/g)?.at(-1);
      const t = iso ? new Date(iso) : null;
      if (t && !isNaN(t.getTime())) signInEndsAt = t.toISOString();
    }
  }
  if (lines.some(l => /not\s+(logged|signed)\s+in|logged\s+out/i.test(l))) loggedIn = false;
  return { loggedIn, accountType: loggedIn ? accountType : null, signInEndsAt: loggedIn ? signInEndsAt : null };
}

/** `GET /api/system/claude` source: cached for `ttlMs` (60 s). */
export class ClaudeSystem {
  private cache?: { at: number; value: Promise<ClaudeStatus> };
  constructor(private exec: Exec = realExec(), private ttlMs = 60_000, private now: () => number = Date.now) {}

  status(): Promise<ClaudeStatus> {
    const t = this.now();
    if (this.cache && t - this.cache.at < this.ttlMs) return this.cache.value;
    const value = this.probe();
    this.cache = { at: t, value };
    return value;
  }

  private async probe(): Promise<ClaudeStatus> {
    const none: ClaudeStatus = { found: false, version: null, loggedIn: false, accountType: null, signInEndsAt: null };
    const v = await this.exec(['--version']).catch(() => ({ code: -1, stdout: '' }));
    if (v.code !== 0) return none;
    const version = /\d+\.\d+\.\d+[^\s]*/.exec(v.stdout)?.[0] ?? (v.stdout.trim() || null);
    const a = await this.exec(['auth', 'status', '--text']).catch(() => ({ code: -1, stdout: '' }));
    const auth = a.code === 0 || a.stdout ? parseAuthStatus(a.stdout) : { loggedIn: false, accountType: null, signInEndsAt: null };
    if (a.code !== 0 && a.code !== -1) auth.loggedIn = false;
    return { found: true, version, ...auth, ...(auth.loggedIn ? {} : { accountType: null, signInEndsAt: null }) };
  }
}
