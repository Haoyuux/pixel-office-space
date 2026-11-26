import express, { type NextFunction, type Request, type Response } from 'express';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { GateDecision, GateKind, Project, ServerEvent, Snapshot, Ticket } from '@office/shared';
import { ProjectStore, ValidationError, NotFoundError } from './store';
import { scaffoldAgents } from './scaffold';
import { Hub } from './hub';
import { ConflictError, type Orchestrator } from './orchestrator/types';
import type { TicketLog } from './ticketLog';

export interface Office { server: Server; store: ProjectStore; hub: Hub; close(): void }
export interface OfficeOptions { dataDir: string; orchestrator: Orchestrator; log: TicketLog; assetsDir?: string }

const GATES: GateKind[] = ['plan', 'final', 'stuck'];

export function createOffice(opts: OfficeOptions): Office {
  const { orchestrator: orch, log } = opts;
  const store = new ProjectStore(join(opts.dataDir, 'projects.json'));
  const app = express();
  app.use(express.json());
  const server = createServer(app);

  const snapshot = (): Snapshot => ({
    projects: store.list(),
    tickets: store.list().flatMap(p => [orch.current(p.id), ...orch.queue(p.id)].filter((t): t is Ticket => !!t)),
  });
  const hub = new Hub(server, snapshot);
  orch.onEvent(e => hub.broadcast(e));
  const now = () => new Date().toISOString();
  const projectEvent = (type: 'project.added' | 'project.updated', p: Project): ServerEvent => ({ type, project: p, projectId: p.id, ts: now() });

  const mustProject = (id: string) => { const p = store.get(id); if (!p) throw new NotFoundError('Project not found'); return p; };
  const mustTicket = (id: string) => { const t = orch.find(id); if (!t) throw new NotFoundError('Ticket not found'); return t; };

  if (opts.assetsDir && existsSync(opts.assetsDir)) app.use('/assets', express.static(opts.assetsDir, { fallthrough: false }));

  app.get('/api/projects', (_req, res) => res.json(store.list()));

  app.post('/api/projects', (req, res) => {
    const p = store.add(req.body);
    scaffoldAgents(p.folder, p.team);
    hub.broadcast(projectEvent('project.added', p));
    res.status(201).json(p);
  });

  app.patch('/api/projects/:id', (req, res) => {
    const p = mustProject(req.params.id);
    if (Array.isArray(req.body.team)) {
      const removed = p.team.filter(r => !req.body.team.includes(r));
      const busy = orch.busyRoles(p.id).filter(r => removed.includes(r));
      if (busy.length) throw new ConflictError(`Busy on a running ticket: ${busy.join(', ')}`);
    }
    const u = store.update(p.id, req.body);
    scaffoldAgents(u.folder, u.team);
    hub.broadcast(projectEvent('project.updated', u));
    res.json(u);
  });

  app.delete('/api/projects/:id', (req, res) => {
    const p = mustProject(req.params.id);
    for (const t of [...orch.queue(p.id), orch.current(p.id)]) if (t) orch.cancel(t.id);
    store.remove(p.id);
    hub.broadcast({ type: 'project.removed', projectId: p.id, ts: now() });
    res.json({ ok: true });
  });

  app.post('/api/projects/:id/tickets', (req, res) => {
    const p = mustProject(req.params.id);
    const text = String(req.body.text ?? '').trim();
    if (!text) throw new ValidationError('Ticket text is required');
    res.status(201).json(orch.startTicket(p, text));
  });

  app.get('/api/projects/:id/tickets', (req, res) => {
    const p = mustProject(req.params.id);
    const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 20));
    const tickets = log.tickets(p.id).slice(-limit);
    const events: Record<string, ServerEvent[]> = {};
    for (const t of tickets) events[t.id] = log.read(p.id, t.id);
    res.json({ tickets, events });
  });

  app.post('/api/tickets/:id/gates/:gate', (req, res) => {
    mustTicket(req.params.id);
    const gate = req.params.gate as GateKind;
    if (!GATES.includes(gate)) throw new ValidationError(`Unknown gate: ${gate}`);
    orch.decide(req.params.id, gate, req.body.decision as GateDecision, req.body.note);
    res.json({ ok: true });
  });

  app.post('/api/tickets/:id/messages', (req, res) => {
    mustTicket(req.params.id);
    const text = String(req.body.text ?? '').trim();
    if (!text) throw new ValidationError('Message text is required');
    orch.sendMessage(req.params.id, text);
    res.json({ ok: true });
  });

  app.post('/api/tickets/:id/cancel', (req, res) => {
    mustTicket(req.params.id);
    orch.cancel(req.params.id);
    res.json({ ok: true });
  });

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    const status = err instanceof ValidationError ? 400 : err instanceof NotFoundError ? 404 : err instanceof ConflictError ? 409 : 500;
    if (status === 500) console.error(err);
    res.status(status).json({ error: err.message });
  });

  return { server, store, hub, close() { hub.close(); server.close(); } };
}
