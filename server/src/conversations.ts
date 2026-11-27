import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ConversationMeta } from '@office/shared';
import { ValidationError } from './errors';

export const TITLE_MAX = 120;
export const AUTO_TITLE_MAX = 60;

/** First meaningful line of an answer / plan summary, markdown stripped, ≤ 60 chars (… when cut). */
export function autoTitle(text: string): string {
  const line = text.split(/\r?\n/).filter(l => !/^\s*(```|~~~)/.test(l)).map(l => l
    .replace(/^\s*(#{1,6}\s+|[-*+]\s+|>\s*|\d+[.)]\s+)/, '')
    .replace(/[*_`~]+/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .trim()).find(l => l) ?? '';
  return line.length > AUTO_TITLE_MAX ? line.slice(0, AUTO_TITLE_MAX - 1).trimEnd() + '…' : line;
}

/** `<dataDir>/conversations.json`: meta per root ticket id. */
export class ConversationStore {
  private items: Record<string, ConversationMeta> = {};
  constructor(private file: string) {
    if (existsSync(file)) {
      try { this.items = JSON.parse(readFileSync(file, 'utf8')).conversations ?? {}; } catch { this.items = {}; }
    }
  }

  all(): Record<string, ConversationMeta> { return Object.fromEntries(Object.entries(this.items).map(([k, v]) => [k, { ...v }])); }
  ofProject(projectId: string): Record<string, ConversationMeta> {
    return Object.fromEntries(Object.entries(this.items).filter(([, v]) => v.projectId === projectId).map(([k, v]) => [k, { ...v }]));
  }
  get(rootId: string): ConversationMeta | undefined { const m = this.items[rootId]; return m ? { ...m } : undefined; }

  /** `{ title?, pinned? }`: title '' (or null) clears it; anything else in the body is ignored. */
  patch(rootId: string, projectId: string, body: unknown): ConversationMeta {
    const b = (body ?? {}) as { title?: unknown; pinned?: unknown };
    const next: ConversationMeta = { ...(this.items[rootId] ?? {}), projectId };
    if (b.title !== undefined) {
      if (b.title !== null && typeof b.title !== 'string') throw new ValidationError('title must be a string');
      const t = (b.title ?? '').replace(/\s+/g, ' ').trim();
      if (t.length > TITLE_MAX) throw new ValidationError(`title is limited to ${TITLE_MAX} characters`);
      if (t) next.title = t; else delete next.title;
    }
    if (b.pinned !== undefined) {
      if (typeof b.pinned !== 'boolean') throw new ValidationError('pinned must be true or false');
      if (b.pinned) next.pinned = true; else delete next.pinned;
    }
    return this.put(rootId, next);
  }

  /** Soft delete: hidden from lists, logs kept. */
  remove(rootId: string, projectId: string): ConversationMeta {
    return this.put(rootId, { ...(this.items[rootId] ?? {}), projectId, deleted: true });
  }

  /** Auto title (the PM's first answer / plan summary) unless one is set; returns the meta when it changed. */
  autoTitle(rootId: string, projectId: string, text: string): ConversationMeta | undefined {
    if (this.items[rootId]?.title) return undefined;
    const title = autoTitle(text);
    if (!title) return undefined;
    return this.put(rootId, { ...(this.items[rootId] ?? {}), projectId, title });
  }

  private put(rootId: string, m: ConversationMeta): ConversationMeta {
    this.items[rootId] = m;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file + '.tmp', JSON.stringify({ conversations: this.items }, null, 2));
    renameSync(this.file + '.tmp', this.file);
    return { ...m };
  }
}
