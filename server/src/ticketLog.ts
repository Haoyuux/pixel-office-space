import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyTicketEvent, isTerminal, type ServerEvent, type Ticket } from '@office/shared';

/** Append-only JSONL event log, one file per ticket: <dir>/<projectId>/<ticketId>.jsonl */
export class TicketLog {
  constructor(readonly dir: string) { mkdirSync(dir, { recursive: true }); }

  append(e: ServerEvent): void {
    const tid = (e as { ticketId?: string }).ticketId;
    if (!tid || !e.projectId) return;
    const d = join(this.dir, e.projectId);
    mkdirSync(d, { recursive: true });
    appendFileSync(join(d, `${tid}.jsonl`), JSON.stringify(e) + '\n');
  }

  read(projectId: string, ticketId: string): ServerEvent[] {
    const f = join(this.dir, projectId, `${ticketId}.jsonl`);
    if (!existsSync(f)) return [];
    // a crash mid-append can leave a torn line: skip anything unparseable rather than fail recovery
    const out: ServerEvent[] = [];
    for (const l of readFileSync(f, 'utf8').split('\n')) {
      if (!l.trim()) continue;
      try { out.push(JSON.parse(l)); } catch { /* torn line */ }
    }
    return out;
  }

  /** All tickets of a project, oldest first. */
  tickets(projectId: string): Ticket[] {
    const d = join(this.dir, projectId);
    if (!existsSync(d)) return [];
    return readdirSync(d).filter(f => f.endsWith('.jsonl'))
      .map(f => this.rebuild(this.read(projectId, f.slice(0, -6))))
      .filter((t): t is Ticket => !!t)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /** One ticket rebuilt from its log (any project), with its events. */
  find(ticketId: string): { ticket: Ticket; events: ServerEvent[] } | undefined {
    if (!existsSync(this.dir) || !/^[\w-]+$/.test(ticketId)) return undefined;
    for (const pid of readdirSync(this.dir)) {
      if (!existsSync(join(this.dir, pid, `${ticketId}.jsonl`))) continue;
      const events = this.read(pid, ticketId);
      const ticket = this.rebuild(events);
      if (ticket) return { ticket, events };
    }
    return undefined;
  }

  /** Rebuild every ticket; tickets that had started but never ended are marked failed/interrupted. */
  recover(): Ticket[] {
    if (!existsSync(this.dir)) return [];
    const out: Ticket[] = [];
    for (const pid of readdirSync(this.dir)) {
      for (const t of this.tickets(pid)) {
        if (!isTerminal(t) && t.status !== 'queued') {
          const events = this.read(pid, t.id);
          const seq = ((events.at(-1) as { seq?: number })?.seq ?? 0) + 1;
          const e: ServerEvent = { type: 'ticket.failed', reason: 'interrupted', projectId: pid, ticketId: t.id, seq, ts: new Date().toISOString() };
          this.append(e);
          out.push(applyTicketEvent(t, e)!);
        } else out.push(t);
      }
    }
    return out;
  }

  private rebuild(events: ServerEvent[]): Ticket | undefined {
    return events.reduce<Ticket | undefined>((t, e) => applyTicketEvent(t, e), undefined);
  }
}
