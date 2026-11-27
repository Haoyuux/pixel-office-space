import express, { type NextFunction, type Request, type Response } from 'express';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { GateDecision, GateKind, Project, RepoDetection, ServerEvent, Snapshot, Ticket } from '@office/shared';
import { ProjectStore, ValidationError, NotFoundError, normalizeFolder } from './store';
import { scaffoldOrExplain } from './scaffold';
import { guardRequests } from './origin';
import { Hub } from './hub';
import { ConflictError, type Orchestrator } from './orchestrator/types';
import type { TicketLog } from './ticketLog';
import * as realGit from './claude/git';
import { ClaudeSystem, type ClaudeStatus } from './claude/system';

export interface Office { server: Server; store: ProjectStore; hub: Hub; close(): void }
export interface OfficeOptions {
  dataDir: string; orchestrator: Orchestrator; log: TicketLog; assetsDir?: string;
  /** `GET /api/system/claude` source (tests inject a fake; never the real CLI). */
  claudeSystem?: { status(): Promise<ClaudeStatus> };
  git?: Pick<typeof realGit, 'isRepo' | 'hasCommit' | 'gitInit'> & Partial<Pick<typeof realGit, 'detectRepos'>>;
}

const GATES: GateKind[] = ['plan', 'final', 'stuck'];

export function createOffice(opts: OfficeOptions): Office {
  const { orchestrator: orch, log } = opts;
  const git = opts.git ?? realGit;
  const detect = git.detectRepos ?? realGit.detectRepos;
  /** Records what git detection found on the project (repos only for a multi-repo folder). */
  const applyGit = (p: Project, d: RepoDetection) => {
    p.gitKind = d.kind;
    if (d.kind === 'multi') p.repos = d.repos.map(r => ({ ...r }));
    else delete p.repos;
  };
  const detectFolder = async (raw: unknown): Promise<RepoDetection> => {
    try { return await detect(normalizeFolder(raw)); } catch { return { kind: 'none' }; } // the store reports folder errors
  };
  let system = opts.claudeSystem;
  const store = new ProjectStore(join(opts.dataDir, 'projects.json'));
  const app = express();
  app.use(guardRequests);
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

  app.post('/api/projects', async (req, res, next) => {
    try {
      const d = await detectFolder(req.body?.folder);
      // agent files first: a folder we can't write to must not leave a saved project behind
      const p = store.add(req.body, n => { scaffoldOrExplain(n.folder, n.team); applyGit(n, d); });
      hub.broadcast(projectEvent('project.added', p));
      res.status(201).json(p);
    } catch (e) { next(e); }
  });

  app.patch('/api/projects/:id', async (req, res, next) => {
    try { await patchProject(req, res); } catch (e) { next(e); }
  });
  const patchProject = async (req: Request, res: Response) => {
    const p = mustProject(req.params.id);
    const d = await detectFolder(p.folder);
    const body = req.body ?? {};
    if (Array.isArray(body.team)) {
      const removed = p.team.filter(r => !body.team.includes(r));
      const busy = orch.busyRoles(p.id).filter(r => removed.includes(r));
      if (busy.length) throw new ConflictError(`Busy on a running ticket: ${busy.join(', ')}`);
    }
    if (body.agentsMode !== undefined && body.agentsMode !== (p.agentsMode ?? 'claude')
      && (orch.current(p.id) || orch.queue(p.id).length)) {
      throw new ConflictError('Agents mode can only change when no ticket is running for this project');
    }
    const u = store.update(p.id, body, n => { scaffoldOrExplain(n.folder, n.team); applyGit(n, d); });
    hub.broadcast(projectEvent('project.updated', u));
    res.json(u);
  };

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
    const parentTicketId = req.body.parentTicketId;
    if (parentTicketId !== undefined && parentTicketId !== null) {
      if (typeof parentTicketId !== 'string') throw new ValidationError('parentTicketId must be a ticket id');
      const parent = orch.find(parentTicketId) ?? log.tickets(p.id).find(t => t.id === parentTicketId);
      if (!parent || parent.projectId !== p.id) throw new NotFoundError('Parent ticket not found');
      return res.status(201).json(orch.startTicket(p, text, { parentTicketId }));
    }
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

  app.post('/api/tickets/:id/resume', (req, res) => {
    const known = orch.find(req.params.id) ?? store.list().flatMap(p => log.tickets(p.id)).find(t => t.id === req.params.id);
    if (!known) throw new NotFoundError('Ticket not found');
    res.json(orch.resume(req.params.id));
  });

  app.post('/api/projects/:id/git-init', async (req, res, next) => {
    try {
      const p = mustProject(req.params.id);
      // a repo with no commits still needs the initial commit (gitInit handles an existing repo)
      const single = await git.isRepo(p.folder);
      if (single && await git.hasCommit(p.folder)) throw new ConflictError('This folder is already a git repository');
      if (!single) {
        // never make a parent of repos into a repo of its own
        const d = await detect(p.folder);
        if (d.kind === 'multi') {
          throw new ConflictError(`This folder holds git repos (${d.repos.map(r => r.name).join(', ')}); it is used as a multi-repo project and is not initialized itself`);
        }
      }
      await git.gitInit(p.folder);
      res.json({ ok: true, message: `Initialized git in ${p.folder} with an initial commit.` });
    } catch (e) { next(e); }
  });

  app.get('/api/system/claude', async (_req, res, next) => {
    try {
      system ??= new ClaudeSystem();
      const s = await system.status();
      // explicit allow-list: never leak anything else (email, organization) the source might carry
      res.json({ found: s.found, version: s.version, loggedIn: s.loggedIn, accountType: s.accountType, signInEndsAt: s.signInEndsAt });
    } catch (e) { next(e); }
  });

  app.post('/api/tickets/:id/cancel', (req, res) => {
    mustTicket(req.params.id);
    orch.cancel(req.params.id);
    res.json({ ok: true });
  });

  app.use((err: Error & { status?: unknown; statusCode?: unknown }, _req: Request, res: Response, _next: NextFunction) => {
    // body-parser / serve-static errors carry their own status (malformed JSON 400, missing asset 404)
    const own = Number(err.status ?? err.statusCode);
    const status = err instanceof ValidationError ? 400 : err instanceof NotFoundError ? 404 : err instanceof ConflictError ? 409
      : own >= 400 && own < 600 ? own : 500;
    if (status === 500) console.error(err);
    res.status(status).json({ error: status === 404 && own === 404 ? 'Not found' : err.message });
  });

  return { server, store, hub, close() { hub.close(); server.close(); } };
}
