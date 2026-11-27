import { ACCENT_HEX, roleDef, type Accent, type RoleId, type Stage, type Ticket, type TicketStatus } from '@office/shared';

export const cssHex = (n: number) => `#${n.toString(16).padStart(6, '0')}`;
export const accentCss = (a: Accent | undefined) => cssHex(ACCENT_HEX[a ?? 'cyan']);

const SHORT: Record<RoleId, string> = {
  pm: 'PM', techlead: 'Tech Lead', frontend: 'Frontend', backend: 'Backend', qa: 'QA',
  uiux: 'UI/UX', devops: 'DevOps', security: 'Security', writer: 'Writer',
};
/** Per-role name colour in the feed (terminal palette). */
const COLOR: Record<RoleId, string> = {
  pm: '#f5c26b', techlead: '#8fb8ff', frontend: '#6fe3c1', backend: '#c89bff', qa: '#ff9d7a',
  uiux: '#ff8fd0', devops: '#7fd4ff', security: '#ff6b6b', writer: '#d8e08a',
};
export const roleShort = (r: RoleId) => SHORT[r];
export const roleColor = (r: RoleId) => COLOR[r];
export const roleEmoji = (r: RoleId) => roleDef(r).emoji;

export const clock = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

export const STATUS_ICON: Record<TicketStatus, string> = {
  queued: '◌', running: '●', waiting: '⏸', done: '✓', failed: '✕', cancelled: '⊘',
};

export const isActive = (t: Ticket) => t.status === 'running' || t.status === 'waiting';

/** Pipeline stages relevant to a team (spec §8): design if UI/UX, review if Tech Lead or Security, test if QA, docs if Writer. */
export function teamStages(team: RoleId[]): Exclude<Stage, 'done'>[] {
  const has = (r: RoleId) => team.includes(r);
  return [
    'plan',
    ...(has('uiux') ? ['design' as const] : []),
    'build',
    ...(has('techlead') || has('security') ? ['review' as const] : []),
    ...(has('qa') ? ['test' as const] : []),
    ...(has('writer') ? ['docs' as const] : []),
  ];
}

export const STAGE_LABEL: Record<Stage, string> = { plan: 'Plan', design: 'Design', build: 'Build', review: 'Review', test: 'Test', docs: 'Docs', done: 'Done' };

/** "just now", "5m ago", "3h ago", "2d ago", then a short date. */
export function relativeDate(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, (now - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 30 * 86400) return `${Math.floor(s / 86400)}d ago`;
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** "~$0.84" — always an estimate, never a bill. */
export const estUsd = (usd: number) => `~$${usd.toFixed(2)}`;

/** "12 turns · 6 min · uses your Claude plan (≈$0.84 at API rates, not charged)". The $ is the CLI's API-rate estimate; on a subscription nothing is billed. */
export function usageLine(u: { turns: number; costUsd: number; durationMs: number }): string {
  const min = u.durationMs / 60000;
  const dur = min < 1 ? `${Math.max(1, Math.round(u.durationMs / 1000))} s` : `${Math.round(min)} min`;
  return `${u.turns} turn${u.turns === 1 ? '' : 's'} · ${dur} · uses your Claude plan (≈$${u.costUsd.toFixed(2)} at API rates, not charged)`;
}

export const isFinished = (t: Ticket) => t.status === 'done' || t.status === 'failed' || t.status === 'cancelled';
/** A failed claude ticket the server may pick up again (POST resume; the server has the last word). */
export const canResume = (t: Ticket) => t.status === 'failed' && t.reason !== 'not-a-git-repo' && (t.agentsMode === 'claude' || (!t.agentsMode && !!t.sessions));

/** chat = answered / Ask; ticket = a change request (plan, gate or Change mode, or from before modes); conversation = Auto still deciding. */
export type Kind = 'chat' | 'ticket' | 'conversation';
export function ticketKind(t: Ticket | undefined): Kind {
  if (!t) return 'conversation';
  if (t.answered || t.mode === 'ask') return 'chat';
  if (t.plan || t.openGate || t.mode !== 'auto') return 'ticket';
  return t.status === 'done' ? 'ticket' : 'conversation';
}
export const kindIcon = (t: Ticket | undefined) => (ticketKind(t) === 'ticket' ? '🎫' : '💬');
/** Chats are titled by the first line of the question. */
export const kindTitle = (t: Ticket) => (ticketKind(t) === 'chat' ? (t.text.trim().split(String.fromCharCode(10))[0].trim() || t.title) : t.title);
/** Status chip text: a finished chat is "answered". */
export const kindStatus = (t: Ticket) => (ticketKind(t) === 'chat' && t.status === 'done' ? 'answered' : t.status);
