import { randomUUID } from 'node:crypto';
import type { RoleId, ServerEvent } from '@office/shared';
import type { RunnerEvent } from './runner';

const SUMMARY_MAX = 100;
const DETAIL_MAX = 4000;
const RAW_MAX = 4000;

const cap = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const norm = (p: string) => p.replace(/\\/g, '/');

/** Path relative to cwd when inside it (case-insensitive on Windows), always with forward slashes. */
function rel(p: string, cwd?: string): string {
  const fp = norm(p);
  if (!cwd) return fp;
  const base = norm(cwd).replace(/\/+$/, '') + '/';
  const win = process.platform === 'win32' || /^[a-z]:\//i.test(base);
  const hit = win ? fp.toLowerCase().startsWith(base.toLowerCase()) : fp.startsWith(base);
  return hit ? fp.slice(base.length) : fp;
}

/** Short one-line summary for the feed: "Edit src/a.ts", "Bash npm test", "Read README.md". */
export function toolSummary(name: string, input: Record<string, unknown>, cwd?: string): string {
  const s = (k: string) => (typeof input?.[k] === 'string' ? (input[k] as string) : '');
  let arg = '';
  const file = s('file_path') || s('notebook_path') || s('path');
  if (['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(name) && file) arg = rel(file, cwd);
  else if (s('command')) arg = s('command').split(/\r?\n/)[0].trim();
  else if (s('pattern')) arg = s('pattern');
  else if (s('url')) arg = s('url');
  else if (s('query')) arg = s('query');
  else if (s('description')) arg = s('description');
  return cap(arg ? `${name} ${arg}` : name, SUMMARY_MAX);
}

/** A streaming text block: its feed id, all text so far, and what has not been sent yet (coalescing). */
interface LiveBlock { role: RoleId; messageId: string; text: string; pending: string; last: number }

export interface TranslateContext {
  cwd?: string;
  /** tool_use id → what was shown, so the matching tool_result can repeat it (the web feed replaces by toolId). */
  tools: Map<string, { tool: string; summary: string; detail?: string }>;
  /** API message id → the feed ids of its text blocks, in order (the k-th finished text maps to the k-th block). */
  textBlocks: Map<string, { ids: string[]; done: number }>;
  /** `${apiMessageId}:${index}` → streaming text block not finished yet. */
  live: Map<string, LiveBlock>;
  /** Deltas are sent at most this often per block (the rest is coalesced into the next one). */
  minIntervalMs: number;
  now: () => number;
}

export interface TranslateOptions { minIntervalMs?: number; now?: () => number }
export const DELTA_INTERVAL_MS = 60;

export const newTranslateContext = (cwd?: string, o: TranslateOptions = {}): TranslateContext => ({
  cwd, tools: new Map(), textBlocks: new Map(), live: new Map(),
  minIntervalMs: o.minIntervalMs ?? DELTA_INTERVAL_MS, now: o.now ?? Date.now,
});

/** Text blocks still streaming (no final text yet), with everything received so far — e.g. to keep it on Stop. */
export function openStreams(ctx: TranslateContext): { role: RoleId; messageId: string; text: string }[] {
  return [...ctx.live.values()].map(b => ({ role: b.role, messageId: b.messageId, text: b.text }));
}

/** Finished text: the feed id of its streamed block (same id as the deltas), or a fresh one if it never streamed. */
function finalId(ctx: TranslateContext, apiId?: string): string {
  const blocks = apiId ? ctx.textBlocks.get(apiId) : undefined;
  const id = blocks?.ids[blocks.done];
  if (!blocks || !id) return randomUUID();
  blocks.done++;
  for (const [k, b] of ctx.live) if (b.messageId === id) ctx.live.delete(k);
  return id;
}

function toolDetail(input: Record<string, unknown>): string | undefined {
  if (typeof input?.command === 'string') return cap(input.command, DETAIL_MAX);
  const keys = Object.keys(input ?? {});
  if (!keys.length) return undefined;
  return cap(JSON.stringify(input), DETAIL_MAX);
}

/**
 * Runner event → partial ServerEvents (no projectId/ticketId/seq/ts; the orchestrator adds those).
 * `ctx` is required: create one per run with newTranslateContext(cwd) so tool results repeat their tool_use summary.
 */
export function translate(role: RoleId, e: RunnerEvent, ctx: TranslateContext): Partial<ServerEvent>[] {
  switch (e.kind) {
    case 'text':
      return [{ type: 'agent.message', role, text: e.text, streaming: false, messageId: finalId(ctx, e.messageId) }];
    case 'block_start': {
      if (e.blockType !== 'text') return [];
      const key = `${e.messageId}:${e.index}`;
      if (ctx.live.has(key)) return [];
      const blocks = ctx.textBlocks.get(e.messageId) ?? { ids: [], done: 0 };
      ctx.textBlocks.set(e.messageId, blocks);
      const messageId = randomUUID();
      blocks.ids.push(messageId);
      ctx.live.set(key, { role, messageId, text: '', pending: '', last: -Infinity });
      return [];
    }
    case 'text_delta': {
      const b = ctx.live.get(`${e.messageId}:${e.index}`);
      if (!b) return [];
      b.text += e.text;
      b.pending += e.text;
      const t = ctx.now();
      // nothing visible yet, or sent very recently: keep it for the next delta (the final text replaces it anyway)
      if (!b.text.trim() || t - b.last < ctx.minIntervalMs) return [];
      const text = b.pending;
      b.pending = '';
      b.last = t;
      return [{ type: 'agent.message', role, text, streaming: true, messageId: b.messageId }];
    }
    case 'tool_use': {
      const info = { tool: e.name, summary: toolSummary(e.name, e.input, ctx.cwd), detail: toolDetail(e.input) };
      ctx.tools.set(e.id, info);
      return [{ type: 'agent.tool', role, ...info, status: 'running', toolId: e.id }];
    }
    case 'tool_result': {
      const info = ctx.tools.get(e.id) ?? { tool: 'tool', summary: 'tool' };
      ctx.tools.delete(e.id);
      const detail = e.isError ? cap(e.content, DETAIL_MAX) : info.detail;
      return [{ type: 'agent.tool', role, tool: info.tool, summary: info.summary, ...(detail ? { detail } : {}), status: e.isError ? 'error' : 'ok', toolId: e.id }];
    }
    case 'raw':
      return [{ type: 'log.raw', role, line: cap(e.line, RAW_MAX) }];
    case 'init':
      return [];
  }
}
