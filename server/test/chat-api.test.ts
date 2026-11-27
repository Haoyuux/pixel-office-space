import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import type { ConversationMeta, Project, ServerEvent, Ticket } from '@office/shared';
import type { Office } from '../src/app';
import { boot } from '../src/boot';
import type { RunOptions, RunResult } from '../src/claude/runner';
import { safeName } from '../src/attachments';
import { autoTitle } from '../src/conversations';
import { searchFiles } from '../src/files';
import { tmp, projectDir, ManualScheduler } from './helpers';

{
  const cfg = join(tmp(), 'gitconfig');
  writeFileSync(cfg, '');
  process.env.GIT_CONFIG_GLOBAL = cfg;
  process.env.GIT_CONFIG_NOSYSTEM = '1';
}

const TEAM = ['pm', 'techlead', 'frontend', 'backend', 'qa'];
let office: Office | undefined;
let stopAll: (() => Promise<void>) | undefined;
afterEach(async () => { await stopAll?.(); office?.close(); office = undefined; stopAll = undefined; });

/** Fake runner (never the real CLI): replies per call via `reply`, or hangs until aborted. */
function fakeRunner() {
  const r = {
    calls: [] as RunOptions[],
    reply: undefined as undefined | ((o: RunOptions) => string | undefined),
    run(o: RunOptions): Promise<RunResult> {
      r.calls.push(o);
      return new Promise((resolve, reject) => {
        o.signal?.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); });
        o.onEvent({ kind: 'init', sessionId: `s${r.calls.length}`, model: 'm' });
        o.onEvent({ kind: 'block_start', messageId: 'msg_1', index: 0, blockType: 'text' });
        o.onEvent({ kind: 'text_delta', messageId: 'msg_1', index: 0, text: 'Thinking out loud' });
        const text = r.reply?.(o);
        if (text === undefined) return; // hang
        setTimeout(() => {
          o.onEvent({ kind: 'text', text, messageId: 'msg_1' });
          resolve({ sessionId: `s${r.calls.length}`, result: text, isError: false, subtype: 'success', numTurns: 1, costUsd: 0, durationMs: 1, exitCode: 0 });
        }, 5);
      });
    },
  };
  return r;
}

function bootFake() {
  const dataDir = tmp();
  const runner = fakeRunner();
  const b = boot({ dataDir, scheduler: new ManualScheduler(), stageMs: [100, 200], random: () => 0.99, runner });
  office = b.office;
  stopAll = () => b.claude.shutdown(10);
  // everything the clients get: ticket events and conversation.updated
  const events: ServerEvent[] = [];
  const send = b.office.hub.broadcast.bind(b.office.hub);
  b.office.hub.broadcast = e => { events.push(e); send(e); };
  return { ...b, dataDir, runner, events };
}
const add = (o: Office, body: Record<string, unknown> = {}) =>
  request(o.server).post('/api/projects').send({ name: 'Shop', folder: projectDir(), accent: 'cyan', team: TEAM, ...body });
const until = async (ok: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!ok() && Date.now() < end) await new Promise(r => setTimeout(r, 10));
  expect(ok()).toBe(true);
};
const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64');
const upload = (o: Office, pid: string, name: string, data: string | Buffer) =>
  request(o.server).post(`/api/projects/${pid}/attachments`).send({ name, dataBase64: b64(data) });

describe('attachments', () => {
  it('JSON base64 upload → saved under <dataDir>/attachments/<project>/<id>-<safe name>', async () => {
    const { office: o, dataDir } = bootFake();
    const p = (await add(o)).body as Project;
    const r = await upload(o, p.id, 'notes.md', '# hi\n');
    expect(r.status).toBe(201);
    expect(Object.keys(r.body).sort()).toEqual(['id', 'name', 'path']);
    expect(r.body.name).toBe('notes.md');
    expect(r.body.path).toBe(join(dataDir, 'attachments', p.id, `${r.body.id}-notes.md`));
    expect(readFileSync(r.body.path, 'utf8')).toBe('# hi\n');
    const png = await upload(o, p.id, 'shot.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]));
    expect(png.status).toBe(201);
    const pdf = await upload(o, p.id, 'spec.pdf', '%PDF-1.7\n...');
    expect(pdf.status).toBe(201);
    // a data: URL (FileReader) is accepted too
    const du = await request(o.server).post(`/api/projects/${p.id}/attachments`).send({ name: 'a.txt', dataBase64: `data:text/plain;base64,${b64('x')}` });
    expect(du.status).toBe(201);
  });

  it('path tricks in the name stay inside the folder', async () => {
    const { office: o, dataDir } = bootFake();
    const p = (await add(o)).body as Project;
    const r = await upload(o, p.id, '..\\..\\evil.txt', 'x');
    expect(r.status).toBe(201);
    expect(r.body.name).toBe('evil.txt');
    expect(r.body.path.startsWith(join(dataDir, 'attachments', p.id))).toBe(true);
    expect(safeName('../../a:b*?.txt')).toBe('a_b_.txt');
    expect(safeName('...')).toBe('file');
    expect(safeName('x'.repeat(200) + '.txt')).toHaveLength(80);
  });

  it('refuses binaries, fake PDFs, empty/bad base64, > 10 MB, unknown project', async () => {
    const { office: o } = bootFake();
    const p = (await add(o)).body as Project;
    expect((await upload(o, p.id, 'tool.exe', Buffer.from([0x4d, 0x5a, 0, 0, 1]))).status).toBe(400);
    expect((await upload(o, p.id, 'x.pdf', 'not a pdf')).status).toBe(400);
    expect((await upload(o, p.id, 'e.txt', '')).status).toBe(400);
    expect((await request(o.server).post(`/api/projects/${p.id}/attachments`).send({ name: 'a.txt', dataBase64: '!!!' })).status).toBe(400);
    expect((await request(o.server).post(`/api/projects/${p.id}/attachments`).send({ dataBase64: b64('x') })).status).toBe(400);
    const big = await upload(o, p.id, 'big.txt', Buffer.alloc(10 * 1024 * 1024 + 1, 97));
    expect(big.status).toBe(400);
    expect(big.body.error).toMatch(/10 MB/);
    expect((await upload(o, p.id, 'ok.txt', Buffer.alloc(10 * 1024 * 1024, 97))).status).toBe(201);
    expect((await upload(o, 'nope', 'a.txt', 'x')).status).toBe(404);
  });

  it('same-origin + JSON guards: foreign Origin 403, multipart 415; other routes keep the small body limit', async () => {
    const { office: o } = bootFake();
    const p = (await add(o)).body as Project;
    const url = `/api/projects/${p.id}/attachments`;
    expect((await request(o.server).post(url).set('Origin', 'http://evil.example').send({ name: 'a.txt', dataBase64: b64('x') })).status).toBe(403);
    expect((await request(o.server).post(url).attach('file', Buffer.from('x'), 'a.txt')).status).toBe(415);
    expect((await request(o.server).post(url).set('Origin', 'http://localhost:5173').send({ name: 'a.txt', dataBase64: b64('x') })).status).toBe(201);
    const huge = await request(o.server).post(`/api/projects/${p.id}/tickets`).send({ text: 'x'.repeat(200 * 1024) });
    expect(huge.status).toBe(413);
  });

  it('tickets and messages take attachment ids: the prompt lists the paths, runs get --add-dir', async () => {
    const { office: o, runner, events, dataDir } = bootFake();
    const p = (await add(o)).body as Project;
    const a = (await upload(o, p.id, 'shot.png', 'png')).body;
    expect((await request(o.server).post(`/api/projects/${p.id}/tickets`).send({ text: 'x', mode: 'ask', attachments: ['00000000-0000-0000-0000-000000000000'] })).status).toBe(404);
    expect((await request(o.server).post(`/api/projects/${p.id}/tickets`).send({ text: 'x', mode: 'ask', attachments: 'nope' })).status).toBe(400);
    const r = await request(o.server).post(`/api/projects/${p.id}/tickets`).send({ text: 'What is wrong?', mode: 'ask', attachments: [a.id] });
    expect(r.status).toBe(201);
    expect((r.body as Ticket).attachments).toEqual([a]);
    await until(() => runner.calls.length === 1);
    expect(runner.calls[0].prompt).toContain(a.path);
    expect(runner.calls[0].addDirs).toEqual([join(dataDir, 'attachments', p.id)]);
    const b = (await upload(o, p.id, 'log.txt', 'boom')).body;
    expect((await request(o.server).post(`/api/tickets/${r.body.id}/messages`).send({ text: 'and this', attachments: [b.id] })).status).toBe(200);
    expect(events.filter(e => e.type === 'user.message').at(-1)).toMatchObject({ text: 'and this', attachments: [b] });
    // another project's attachment is not found
    const p2 = (await add(o)).body as Project;
    expect((await request(o.server).post(`/api/projects/${p2.id}/tickets`).send({ text: 'x', mode: 'ask', attachments: [a.id] })).status).toBe(404);
  });

  it('deleting the project removes its uploads', async () => {
    const { office: o, dataDir } = bootFake();
    const p = (await add(o)).body as Project;
    await upload(o, p.id, 'a.txt', 'x');
    expect(existsSync(join(dataDir, 'attachments', p.id))).toBe(true);
    await request(o.server).delete(`/api/projects/${p.id}`).send({});
    expect(existsSync(join(dataDir, 'attachments', p.id))).toBe(false);
  });
});

describe('stop', () => {
  it('POST /api/tickets/:id/stop: a running answer ends done (stopped) with the streamed text', async () => {
    const { office: o, runner, events } = bootFake();
    const p = (await add(o)).body as Project;
    const t = (await request(o.server).post(`/api/projects/${p.id}/tickets`).send({ text: 'Explain', mode: 'ask' })).body as Ticket;
    await until(() => runner.calls.length === 1);
    const r = await request(o.server).post(`/api/tickets/${t.id}/stop`).send({});
    expect(r.body).toEqual({ ok: true, outcome: 'stopped' });
    await until(() => events.some(e => e.type === 'ticket.done'));
    expect(events.find(e => e.type === 'ticket.done')).toMatchObject({ stopped: true });
    const texts = events.filter(e => e.type === 'agent.message' && !e.streaming).map(e => (e as { text: string }).text);
    expect(texts).toEqual(expect.arrayContaining(['Thinking out loud', 'Stopped by you.']));
    expect(runner.calls[0].signal!.aborted).toBe(true);
    expect((await request(o.server).post(`/api/tickets/${t.id}/stop`).send({})).status).toBe(409);
    expect((await request(o.server).post('/api/tickets/nope/stop').send({})).status).toBe(404);
    expect((await request(o.server).post(`/api/tickets/${t.id}/stop`).set('Content-Type', 'text/plain').send('x')).status).toBe(415);
  });

  it('a simulated ticket is cancelled', async () => {
    const { office: o } = bootFake();
    const p = (await add(o, { agentsMode: 'simulated' })).body as Project;
    const t = (await request(o.server).post(`/api/projects/${p.id}/tickets`).send({ text: 'x' })).body as Ticket;
    expect((await request(o.server).post(`/api/tickets/${t.id}/stop`).send({})).body).toEqual({ ok: true, outcome: 'cancelled' });
  });
});

describe('file search (@files)', () => {
  const g = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], { cwd });
  const mkRepo = (d: string, files: string[]) => {
    mkdirSync(d, { recursive: true });
    for (const f of files) { mkdirSync(join(d, f, '..'), { recursive: true }); writeFileSync(join(d, f), 'x'); }
    writeFileSync(join(d, '.gitignore'), 'dist/\n');
    g(d, 'init', '-q'); g(d, 'add', '-A'); g(d, 'commit', '-q', '-m', 'init');
  };

  it('searchFiles: case-insensitive subsequence, file-name hits first, ≤ 30', () => {
    const paths = ['src/app/leave/leave.component.ts', 'README.md', 'src/lib/rdme.ts', 'docs/read-me-first.md'];
    expect(searchFiles(paths, 'readme')).toEqual(['README.md', 'docs/read-me-first.md']);
    expect(searchFiles(paths, 'LVcmp')).toEqual(['src/app/leave/leave.component.ts']);
    expect(searchFiles(paths, 'rdme')).toEqual(['src/lib/rdme.ts', 'README.md', 'docs/read-me-first.md']);
    expect(searchFiles(Array.from({ length: 50 }, (_, i) => `f${i}.ts`), '')).toHaveLength(30);
  });

  it('GET /api/projects/:id/files?q= → repo-relative paths (tracked + untracked, not ignored)', async () => {
    const { office: o } = bootFake();
    const folder = projectDir();
    mkRepo(folder, ['src/Leave.cs', 'src/Other.cs', 'README.md']);
    writeFileSync(join(folder, 'src', 'NewLeave.cs'), 'x');
    mkdirSync(join(folder, 'dist')); writeFileSync(join(folder, 'dist', 'leave.js'), 'x');
    const p = (await add(o, { folder })).body as Project;
    const r = await request(o.server).get(`/api/projects/${p.id}/files`).query({ q: 'leave' });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ files: ['src/Leave.cs', 'src/NewLeave.cs'] });
    expect((await request(o.server).get('/api/projects/nope/files')).status).toBe(404);
    expect((await request(o.server).get(`/api/projects/${p.id}/files`).set('Origin', 'http://evil.example')).status).toBe(403);
  });

  it('multi-repo: paths are prefixed with the repo name; a non-git folder has none', async () => {
    const { office: o } = bootFake();
    const folder = projectDir();
    mkRepo(join(folder, 'angular'), ['src/leave.ts']);
    mkRepo(join(folder, 'aspnet-core'), ['src/Leave.cs']);
    const p = (await add(o, { folder })).body as Project;
    expect(p.gitKind).toBe('multi');
    expect((await request(o.server).get(`/api/projects/${p.id}/files?q=leave`)).body.files).toEqual(['angular/src/leave.ts', 'aspnet-core/src/Leave.cs']);
    const plain = (await add(o)).body as Project;
    expect((await request(o.server).get(`/api/projects/${plain.id}/files?q=a`)).body.files).toEqual([]);
  });
});

describe('conversation meta', () => {
  const answer = (runner: ReturnType<typeof fakeRunner>, text: string) => { runner.reply = () => text; };

  it('auto title from the PM answer; PATCH title/pin (validated); a set title is kept', async () => {
    const { office: o, runner, events, dataDir } = bootFake();
    const p = (await add(o)).body as Project;
    answer(runner, '## Leave has **three** buttons\n- Save\n- Cancel');
    const t = (await request(o.server).post(`/api/projects/${p.id}/tickets`).send({ text: 'Buttons?', mode: 'ask' })).body as Ticket;
    await until(() => events.some(e => e.type === 'conversation.updated'));
    expect(events.find(e => e.type === 'conversation.updated')).toMatchObject({ rootId: t.id, projectId: p.id, meta: { projectId: p.id, title: 'Leave has three buttons' } });
    expect((await request(o.server).patch(`/api/conversations/${t.id}`).send({ title: 5 })).status).toBe(400);
    expect((await request(o.server).patch(`/api/conversations/${t.id}`).send({ pinned: 'yes' })).status).toBe(400);
    const r = await request(o.server).patch(`/api/conversations/${t.id}`).send({ title: '  Buttons  ', pinned: true });
    expect(r.body).toEqual({ rootId: t.id, projectId: p.id, title: 'Buttons', pinned: true });
    // a follow-up answer does not rename it
    answer(runner, 'Something else entirely');
    await until(() => events.some(e => e.type === 'ticket.done' && e.ticketId === t.id));
    const f = (await request(o.server).post(`/api/projects/${p.id}/tickets`).send({ text: 'More?', mode: 'ask', parentTicketId: t.id })).body as Ticket;
    await until(() => events.some(e => e.type === 'ticket.done' && e.ticketId === f.id));
    // PATCH by a follow-up id resolves to the root
    expect((await request(o.server).patch(`/api/conversations/${f.id}`).send({ pinned: false })).body).toEqual({ rootId: t.id, projectId: p.id, title: 'Buttons' });
    const saved = JSON.parse(readFileSync(join(dataDir, 'conversations.json'), 'utf8')).conversations;
    expect(saved[t.id]).toEqual({ projectId: p.id, title: 'Buttons' });
    const h = await request(o.server).get(`/api/projects/${p.id}/tickets`);
    expect(h.body.conversations).toEqual({ [t.id]: { projectId: p.id, title: 'Buttons' } });
    expect((await request(o.server).patch('/api/conversations/nope').send({ title: 'x' })).status).toBe(404);
  });

  it('DELETE soft-deletes: hidden from history (follow-ups too), logs kept; snapshot carries the meta', async () => {
    const { office: o, runner, events, log } = bootFake();
    const p = (await add(o)).body as Project;
    answer(runner, 'Answer one');
    const t = (await request(o.server).post(`/api/projects/${p.id}/tickets`).send({ text: 'One?', mode: 'ask' })).body as Ticket;
    await until(() => events.some(e => e.type === 'ticket.done' && e.ticketId === t.id));
    const f = (await request(o.server).post(`/api/projects/${p.id}/tickets`).send({ text: 'Two?', mode: 'ask', parentTicketId: t.id })).body as Ticket;
    await until(() => events.some(e => e.type === 'ticket.done' && e.ticketId === f.id));
    const other = (await request(o.server).post(`/api/projects/${p.id}/tickets`).send({ text: 'Other?', mode: 'ask' })).body as Ticket;
    await until(() => events.some(e => e.type === 'ticket.done' && e.ticketId === other.id));
    expect((await request(o.server).delete(`/api/conversations/${t.id}`).set('Content-Type', 'text/plain').send('x')).status).toBe(415);
    const d = await request(o.server).delete(`/api/conversations/${t.id}`).send({});
    expect(d.body).toMatchObject({ rootId: t.id, deleted: true });
    const h = await request(o.server).get(`/api/projects/${p.id}/tickets`);
    expect(h.body.tickets.map((x: Ticket) => x.id)).toEqual([other.id]);
    expect((h.body.conversations as Record<string, ConversationMeta>)[t.id].deleted).toBe(true);
    expect(log.read(p.id, t.id).length).toBeGreaterThan(0);
    expect(log.read(p.id, f.id).length).toBeGreaterThan(0);
    expect(events.filter(e => e.type === 'conversation.updated').at(-1)).toMatchObject({ rootId: t.id, meta: { deleted: true } });
    // the WebSocket snapshot carries the meta too
    await new Promise<void>(r => o.server.listen(0, '127.0.0.1', () => r()));
    const port = (o.server.address() as AddressInfo).port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const first = await new Promise<ServerEvent>(r => ws.once('message', d => r(JSON.parse(String(d)))));
    ws.close();
    expect(first.type).toBe('snapshot');
    expect((first as Extract<ServerEvent, { type: 'snapshot' }>).snapshot.conversations![t.id]).toMatchObject({ projectId: p.id, deleted: true });
  });

  it('autoTitle: first meaningful line, markdown stripped, ≤ 60 chars', () => {
    expect(autoTitle('\n```json\n## *Hello* `world`\nmore')).toBe('Hello world');
    expect(autoTitle('- [Link](http://x) item')).toBe('Link item');
    const long = autoTitle('a'.repeat(100));
    expect(long).toHaveLength(60);
    expect(long.endsWith('…')).toBe(true);
    expect(autoTitle('   ')).toBe('');
  });
});
