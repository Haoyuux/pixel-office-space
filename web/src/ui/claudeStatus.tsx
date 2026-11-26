import { useEffect } from 'react';
import { create } from 'zustand';
import { api } from './api';

/** `GET /api/system/claude`. */
export interface ClaudeStatus { found: boolean; version: string | null; loggedIn: boolean; accountType: string | null; signInEndsAt: string | null }

const useClaude = create<{ status: ClaudeStatus | null }>(() => ({ status: null }));

export const POLL_MS = 5 * 60_000;
const SOON_MS = 10 * 864e5;

/** Fetches the claude status once (bad / failed replies keep the last known status). */
export async function refreshClaude(): Promise<void> {
  const r = await api<ClaudeStatus>('GET', '/api/system/claude');
  if (r.ok && r.data && typeof r.data.found === 'boolean') useClaude.setState({ status: r.data });
}

let users = 0;
let timer: ReturnType<typeof setInterval> | undefined;

/** The claude status, fetched on first use and every 5 min while anything shows it. */
export function useClaudeStatus(): ClaudeStatus | null {
  useEffect(() => {
    if (users++ === 0) { void refreshClaude(); timer = setInterval(() => void refreshClaude(), POLL_MS); }
    return () => { if (--users === 0) { clearInterval(timer); timer = undefined; } };
  }, []);
  return useClaude(s => s.status);
}

/** The one-line warning for this status, or null when all is well. */
export function claudeWarning(s: ClaudeStatus | null, now = Date.now()): { level: 'error' | 'warn'; text: string } | null {
  if (!s) return null;
  if (!s.found) return { level: 'error', text: "Claude Code isn't installed — install it, then run `claude` and `/login`" };
  if (!s.loggedIn) return { level: 'error', text: 'Run `claude` then `/login` in a terminal' };
  const ends = s.signInEndsAt ? Date.parse(s.signInEndsAt) : NaN;
  if (Number.isFinite(ends) && ends - now <= SOON_MS) {
    const date = new Date(ends).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    return { level: 'warn', text: `Your Claude sign-in ends on ${date} — run \`claude\` then \`/login\` to renew` };
  }
  return null;
}

/** Banner for the claude status (nothing when all is well). */
export function ClaudeBanner({ compact = false }: { compact?: boolean }) {
  const w = claudeWarning(useClaudeStatus());
  if (!w) return null;
  return <div className={`po-banner ${w.level}${compact ? ' compact' : ''}`} role="status">{w.text}</div>;
}
