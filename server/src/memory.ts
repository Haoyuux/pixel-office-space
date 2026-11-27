import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MEMORY_MAX_ENTRIES, MEMORY_TEXT_MAX, type MemoryEntry } from '@office/shared';
import { NotFoundError, ValidationError } from './errors';

const clean = (s: string) => s.replace(/\s+/g, ' ').trim();
const key = (s: string) => clean(s).toLowerCase();
const isEntry = (v: unknown): v is MemoryEntry => {
  const e = v as MemoryEntry;
  return !!e && typeof e === 'object' && typeof e.id === 'string' && typeof e.text === 'string'
    && (e.source === 'owner' || e.source === 'pm') && typeof e.at === 'string';
};

/**
 * Team memory: `<dataDir>/memory/<projectId>.json` = `{ entries }` (≤ 60, each ≤ 300 chars). Lives in the server's
 * data folder, never in the owner's repos. Read from disk on every call (the API and the orchestrator share it).
 */
export class MemoryStore {
  private readonly dir: string;
  private listeners: ((projectId: string) => void)[] = [];
  constructor(dataDir: string) { this.dir = join(dataDir, 'memory'); }

  onChange(cb: (projectId: string) => void) { this.listeners.push(cb); }

  list(projectId: string): MemoryEntry[] {
    const f = this.file(projectId);
    if (!existsSync(f)) return [];
    try {
      const entries = JSON.parse(readFileSync(f, 'utf8'))?.entries;
      return Array.isArray(entries) ? entries.filter(isEntry).map(e => ({ ...e })) : [];
    } catch { return []; }
  }

  /** Owner entry: `{ text }`. */
  add(projectId: string, body: unknown): MemoryEntry {
    const text = this.textOf(body);
    const entries = this.list(projectId);
    if (entries.length >= MEMORY_MAX_ENTRIES) {
      throw new ValidationError(`Team memory is full (${MEMORY_MAX_ENTRIES} entries); delete one first`);
    }
    const e: MemoryEntry = { id: randomUUID(), text, source: 'owner', at: new Date().toISOString() };
    this.save(projectId, [...entries, e]);
    return { ...e };
  }

  update(projectId: string, entryId: string, body: unknown): MemoryEntry {
    const text = this.textOf(body);
    const entries = this.list(projectId);
    const e = entries.find(x => x.id === entryId);
    if (!e) throw new NotFoundError('Memory entry not found');
    e.text = text;
    this.save(projectId, entries);
    return { ...e };
  }

  remove(projectId: string, entryId: string): void {
    const entries = this.list(projectId);
    if (!entries.some(x => x.id === entryId)) throw new NotFoundError('Memory entry not found');
    this.save(projectId, entries.filter(x => x.id !== entryId));
  }

  /**
   * The PM's lessons after a ticket/answer completed: appended as source 'pm', skipping blanks and anything already
   * remembered (case-insensitive). When full, the oldest PM entries make room; owner entries are never evicted.
   * Returns the added entries (none → no write, no change event).
   */
  learn(projectId: string, lessons: string[], ticketId?: string): MemoryEntry[] {
    const entries = this.list(projectId);
    const known = new Set(entries.map(e => key(e.text)));
    const added: MemoryEntry[] = [];
    for (const raw of lessons) {
      const text = clean(String(raw)).slice(0, MEMORY_TEXT_MAX);
      if (!text || known.has(key(text))) continue;
      if (entries.length >= MEMORY_MAX_ENTRIES) {
        const oldest = entries.findIndex(e => e.source === 'pm');
        if (oldest < 0) break;
        entries.splice(oldest, 1);
      }
      const e: MemoryEntry = { id: randomUUID(), text, source: 'pm', ...(ticketId ? { ticketId } : {}), at: new Date().toISOString() };
      entries.push(e);
      known.add(key(text));
      added.push({ ...e });
    }
    if (added.length) this.save(projectId, entries);
    return added;
  }

  removeProject(projectId: string): void {
    rmSync(this.file(projectId), { force: true });
  }

  private textOf(body: unknown): string {
    const t = (body as { text?: unknown } | null)?.text;
    if (typeof t !== 'string') throw new ValidationError('text is required');
    const text = clean(t);
    if (!text) throw new ValidationError('text is required');
    if (text.length > MEMORY_TEXT_MAX) throw new ValidationError(`text is limited to ${MEMORY_TEXT_MAX} characters`);
    return text;
  }

  private file(projectId: string): string {
    if (!/^[\w-]+$/.test(projectId)) throw new NotFoundError('Project not found');
    return join(this.dir, `${projectId}.json`);
  }

  private save(projectId: string, entries: MemoryEntry[]) {
    const f = this.file(projectId);
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(f + '.tmp', JSON.stringify({ entries }, null, 2));
    renameSync(f + '.tmp', f);
    for (const l of this.listeners) {
      try { l(projectId); } catch (err) { console.error(err); }
    }
  }
}
