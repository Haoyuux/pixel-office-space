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

export interface TranslateContext {
  cwd?: string;
  /** tool_use id → what was shown, so the matching tool_result can repeat it (the web feed replaces by toolId). */
  tools: Map<string, { tool: string; summary: string; detail?: string }>;
}

export const newTranslateContext = (cwd?: string): TranslateContext => ({ cwd, tools: new Map() });

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
      return [{ type: 'agent.message', role, text: e.text, streaming: false, messageId: randomUUID() }];
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
