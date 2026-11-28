import express, { type NextFunction, type Request, type Response } from 'express';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
import { TICKET_MODES, type GateDecision, type GateKind, type Project, type RepoDetection, type ServerEvent, type Snapshot, type Ticket, type TicketMode } from '@office/shared';
import { ProjectStore, ValidationError, NotFoundError, normalizeFolder, applyGit } from './store';
import { scaffoldOrExplain } from './scaffold';
import { guardRequests } from './origin';
import { Hub } from './hub';
import { ConflictError, type Orchestrator } from './orchestrator/types';
import type { TicketLog } from './ticketLog';
import * as realGit from './claude/git';
import { ClaudeSystem, type ClaudeStatus } from './claude/system';
import { AttachmentStore } from './attachments';
import { ConversationStore } from './conversations';
import { ProjectFiles } from './files';
import { MemoryStore } from './memory';
import { buildSummary } from './summary';
import { DevServers, runTarget } from './devserver';

export interface Office {
  server: Server; store: ProjectStore; hub: Hub; close(): void;
  /** ▶ Run: the projects' dev servers (main.ts stops them on shutdown). */
  devServers: DevServers;
  /** Ticket-start git re-detection: store it and tell the clients when it changed. */
  setGit(projectId: string, d: RepoDetection): void;
}
export interface OfficeOptions {
  dataDir: string; orchestrator: Orchestrator; log: TicketLog; assetsDir?: string;
  /** `GET /api/system/claude` source (tests inject a fake; never the real CLI). */
  claudeSystem?: { status(): Promise<ClaudeStatus> };
  git?: Pick<typeof realGit, 'isRepo' | 'hasCommit' | 'gitInit'> & Partial<Pick<typeof realGit, 'detectRepos' | 'lsFiles' | 'pushBranch'>>;
  /** Team memory (shared with the claude orchestrator, which reads it into prompts and adds the PM's lessons). */
  memory?: MemoryStore;
  devServers?: DevServers;
}

const GATES: GateKind[] = ['plan', 'final', 'stuck'];

/** Direct subfolders (no dot-folders/node_modules) that have a .git of their own. */
function subfoldersWithGit(folder: string): string[] {
  try {
    return readdirSync(folder, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules' && existsSync(join(folder, e.name, '.git')))
      .map(e => e.name).sort();
  } catch { return []; }
}

export function createOffice(opts: OfficeOptions): Office {
  const { orchestrator: orch, log } = opts;
  const git = opts.git ?? realGit;
  const detect = git.detectRepos ?? realGit.detectRepos;
  const detectFolder = async (raw: unknown): Promise<RepoDetection> => {
    try { return await detect(normalizeFolder(raw)); } catch { return { kind: 'none' }; } // the store reports folder errors
  };
  let system = opts.claudeSystem;
  const store = new ProjectStore(join(opts.dataDir, 'projects.json'));
  const attachments = new AttachmentStore(opts.dataDir);
  const conversations = new ConversationStore(join(opts.dataDir, 'conversations.json'));
  const files = new ProjectFiles(git.lsFiles ?? realGit.lsFiles);
  const memory = opts.memory ?? new MemoryStore(opts.dataDir);
  const devServers = opts.devServers ?? new DevServers();
  const app = express();
  app.use(guardRequests);
  // uploads are JSON base64 (≤ 10 MB decoded): only this route accepts a large body
  app.use('/api/projects/:id/attachments', express.json({ limit: '15mb' }));
  app.use(express.json());
  const server = createServer(app);

  const snapshot = (): Snapshot => ({
    projects: store.list(),
    tickets: store.list().flatMap(p => [orch.current(p.id), ...orch.queue(p.id)].filter((t): t is Ticket => !!t)),
    conversations: conversations.all(),
    devServers: devServers.all(),
  });
  const hub = new Hub(server, snapshot);
  orch.onEvent(e => hub.broadcast(e));
  devServers.onEvent(e => hub.broadcast(e));
  const now = () => new Date().toISOString();
  memory.onChange(projectId => hub.broadcast({ type: 'memory.updated', projectId, ts: now() }));
  const projectEvent = (type: 'project.added' | 'project.updated', p: Project): ServerEvent => ({ type, project: p, projectId: p.id, ts: now() });

  const mustProject = (id: string) => { const p = store.get(id); if (!p) throw new NotFoundError('Project not found'); return p; };
  const mustTicket = (id: string) => { const t = orch.find(id); if (!t) throw new NotFoundError('Ticket not found'); return t; };
  /** Live or logged ticket (any project). */
  const anyTicket = (id: string) => orch.find(id) ?? log.find(id)?.ticket;
  /** The conversation's root: follow parentTicketId up (a missing parent ends the walk). */
  const rootOf = (t: Ticket, lookup: (id: string) => Ticket | undefined = anyTicket): Ticket => {
    const seen = new Set<string>();
    let cur = t;
    while (cur.parentTicketId && !seen.has(cur.id)) {
      seen.add(cur.id);
      const p = lookup(cur.parentTicketId);
      if (!p) break;
      cur = p;
    }
    return cur;
  };
  const conversationEvent = (rootId: string, meta: ReturnType<ConversationStore['patch']>) =>
    hub.broadcast({ type: 'conversation.updated', rootId, meta, projectId: meta.projectId, ts: now() });

  // auto title: the PM's first answer / plan summary names the conversation unless the owner named it
  const lastPm = new Map<string, string>();
  orch.onEvent(e => {
    try {
      if (e.type === 'agent.message' && e.role === 'pm' && !e.streaming) lastPm.set(e.ticketId, e.text);
      else if (e.type === 'ticket.answered' || e.type === 'ticket.plan') {
        const text = e.type === 'ticket.plan' ? e.plan.summary : lastPm.get(e.ticketId);
        const t = orch.find(e.ticketId);
        if (text && t) {
          const root = rootOf(t);
          const meta = conversations.autoTitle(root.id, root.projectId, text);
          if (meta) conversationEvent(root.id, meta);
        }
      }
      if (e.type === 'ticket.done' || e.type === 'ticket.failed' || e.type === 'ticket.cancelled') lastPm.delete(e.ticketId);
    } catch (err) { console.error(err); } // naming is best effort: never break the event flow
  });

  if (opts.assetsDir && existsSync(opts.assetsDir)) app.use('/assets', express.static(opts.assetsDir, { fallthrough: false }));

  app.get('/api/projects', (_req, res) => res.json(store.list()));

  /** Summary board: `?since=<ISO>` (missing = the last 24 hours). */
  app.get('/api/summary', (req, res) => {
    const raw = req.query.since;
    let since = Date.now() - 24 * 3600_000;
    if (raw !== undefined) {
      since = typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}/.test(raw) ? Date.parse(raw) : NaN;
      if (Number.isNaN(since)) throw new ValidationError('since must be an ISO date/time');
    }
    res.json(buildSummary(since, store.list(), id => log.entries(id), conversations.all()));
  });

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
    devServers.remove(p.id);
    const moved = store.remove(p.id);
    attachments.removeProject(p.id);
    memory.removeProject(p.id);
    hub.broadcast({ type: 'project.removed', projectId: p.id, ts: now() });
    // the rooms after it move up to close the gap
    for (const m of moved) hub.broadcast(projectEvent('project.updated', m));
    res.json({ ok: true });
  });

  app.post('/api/projects/:id/tickets', (req, res) => {
    const p = mustProject(req.params.id);
    const text = String(req.body.text ?? '').trim();
    if (!text) throw new ValidationError('Ticket text is required');
    const rawMode = req.body.mode ?? 'auto';
    if (!TICKET_MODES.includes(rawMode)) throw new ValidationError(`mode must be one of ${TICKET_MODES.join(', ')}`);
    const mode = rawMode as TicketMode;
    const atts = attachments.resolve(p.id, req.body.attachments);
    const extra = atts.length ? { attachments: atts } : {};
    const parentTicketId = req.body.parentTicketId;
    if (parentTicketId !== undefined && parentTicketId !== null) {
      if (typeof parentTicketId !== 'string') throw new ValidationError('parentTicketId must be a ticket id');
      const parent = orch.find(parentTicketId) ?? log.tickets(p.id).find(t => t.id === parentTicketId);
      if (!parent || parent.projectId !== p.id) throw new NotFoundError('Parent ticket not found');
      return res.status(201).json(orch.startTicket(p, text, { parentTicketId, mode, ...extra }));
    }
    res.status(201).json(orch.startTicket(p, text, { mode, ...extra }));
  });

  /** History: tickets of soft-deleted conversations are left out; `conversations` = this project's meta. */
  app.get('/api/projects/:id/tickets', (req, res) => {
    const p = mustProject(req.params.id);
    const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 20));
    const all = log.tickets(p.id);
    const meta = conversations.ofProject(p.id);
    const byId = new Map(all.map(t => [t.id, t]));
    const visible = all.filter(t => !meta[rootOf(t, id => byId.get(id)).id]?.deleted);
    const tickets = visible.slice(-limit);
    const events: Record<string, ServerEvent[]> = {};
    for (const t of tickets) events[t.id] = log.read(p.id, t.id);
    res.json({ tickets, events, conversations: meta });
  });

  app.post('/api/projects/:id/attachments', (req, res) => {
    const p = mustProject(req.params.id);
    res.status(201).json(attachments.save(p.id, req.body));
  });

  app.get('/api/projects/:id/files', async (req, res, next) => {
    try {
      const p = mustProject(req.params.id);
      const q = typeof req.query.q === 'string' ? req.query.q : '';
      res.json({ files: await files.search(p, q) });
    } catch (e) { next(e); }
  });

  app.get('/api/projects/:id/memory', (req, res) => {
    res.json({ entries: memory.list(mustProject(req.params.id).id) });
  });
  app.post('/api/projects/:id/memory', (req, res) => {
    res.status(201).json(memory.add(mustProject(req.params.id).id, req.body));
  });
  app.patch('/api/projects/:id/memory/:entryId', (req, res) => {
    res.json(memory.update(mustProject(req.params.id).id, req.params.entryId, req.body));
  });
  app.delete('/api/projects/:id/memory/:entryId', (req, res) => {
    memory.remove(mustProject(req.params.id).id, req.params.entryId);
    res.json({ ok: true });
  });

  /** ▶ Run: state, recent log and the runnable scripts of the project's dev server. */
  app.get('/api/projects/:id/devserver', (req, res) => {
    const p = mustProject(req.params.id);
    const t = runTarget(p);
    res.json({ state: devServers.state(p.id), log: devServers.log(p.id), scripts: t?.scripts ?? [], defaultScript: t?.script ?? null, cwd: t?.cwd ?? null });
  });
  app.post('/api/projects/:id/devserver/start', (req, res) => {
    res.json(devServers.start(mustProject(req.params.id), req.body?.script, req.body?.install === true));
  });
  app.post('/api/projects/:id/devserver/stop', (req, res) => {
    res.json(devServers.stop(mustProject(req.params.id).id));
  });

  /** ⬆ Push: the server pushes each of the project's repos (its checked-out branch) with the owner's git login. */
  const pushing = new Set<string>();
  app.post('/api/projects/:id/push', async (req, res, next) => {
    try {
      const p = mustProject(req.params.id);
      if (pushing.has(p.id)) throw new ConflictError('A push is already running for this project');
      pushing.add(p.id);
      try {
        const push = git.pushBranch ?? realGit.pushBranch;
        const targets = p.repos?.length ? p.repos.map(r => ({ name: r.name, path: r.path })) : [{ name: p.name, path: p.folder }];
        const results = [];
        for (const t of targets) results.push({ repo: t.name, ...(await push(t.path)) });
        res.json({ ok: results.every(r => r.ok), results });
      } finally { pushing.delete(p.id); }
    } catch (e) { next(e); }
  });

  const conversationRoot = (id: string) => {
    const t = anyTicket(id);
    if (!t || !store.get(t.projectId)) throw new NotFoundError('Conversation not found');
    return rootOf(t);
  };

  app.patch('/api/conversations/:rootId', (req, res) => {
    const root = conversationRoot(req.params.rootId);
    const meta = conversations.patch(root.id, root.projectId, req.body);
    conversationEvent(root.id, meta);
    res.json({ rootId: root.id, ...meta });
  });

  app.delete('/api/conversations/:rootId', (req, res) => {
    const root = conversationRoot(req.params.rootId);
    const meta = conversations.remove(root.id, root.projectId);
    conversationEvent(root.id, meta);
    res.json({ rootId: root.id, ...meta });
  });

  app.post('/api/tickets/:id/gates/:gate', (req, res) => {
    mustTicket(req.params.id);
    const gate = req.params.gate as GateKind;
    if (!GATES.includes(gate)) throw new ValidationError(`Unknown gate: ${gate}`);
    orch.decide(req.params.id, gate, req.body.decision as GateDecision, req.body.note);
    res.json({ ok: true });
  });

  app.post('/api/tickets/:id/messages', (req, res) => {
    const t = mustTicket(req.params.id);
    const text = String(req.body.text ?? '').trim();
    if (!text) throw new ValidationError('Message text is required');
    const atts = attachments.resolve(t.projectId, req.body.attachments);
    if (atts.length) orch.sendMessage(req.params.id, text, atts);
    else orch.sendMessage(req.params.id, text);
    res.json({ ok: true });
  });

  /** ■ Stop: 'stopped' = the running answer/plan ended (done, text so far kept); 'cancelled' = cancelled like Cancel. */
  app.post('/api/tickets/:id/stop', (req, res) => {
    mustTicket(req.params.id);
    let outcome: 'stopped' | 'cancelled' = 'cancelled';
    if (orch.stop) outcome = orch.stop(req.params.id);
    else orch.cancel(req.params.id);
    res.json({ ok: true, outcome });
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
        // sub-repos without a commit yet are still repos: commit in them instead of wrapping them in a new one
        const subRepos = subfoldersWithGit(p.folder);
        if (subRepos.length) {
          throw new ConflictError(`This folder holds git repos (${subRepos.join(', ')}) with no commits yet; make a first commit in each instead of initializing the parent folder`);
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

  const setGit = (id: string, d: RepoDetection) => {
    const p = store.setGit(id, d);
    if (p) hub.broadcast(projectEvent('project.updated', p));
  };

  return { server, store, hub, setGit, devServers, close() { hub.close(); server.close(); } };
}
