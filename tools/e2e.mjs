// One-command walkthrough: node tools/e2e.mjs
// Starts the server (temp data dir, fast stages) and Vite, drives headless Chrome over CDP, prints "e2e ok" or fails non-zero.
import { spawn, execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const shots = join(root, 'shots');
mkdirSync(shots, { recursive: true });
const API = 'http://127.0.0.1:5175', WEB = 'http://127.0.0.1:5173';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const children = [];
const killTree = (c) => { try { if (process.platform === 'win32') execSync(`taskkill /pid ${c.pid} /T /F`, { stdio: 'ignore' }); else c.kill('SIGKILL'); } catch {} };
const cleanup = () => { for (const c of children) killTree(c); };
process.on('exit', cleanup);
const fail = (msg) => { console.error(`e2e FAILED: ${msg}`); cleanup(); process.exit(1); };
const assert = (cond, msg) => { if (!cond) fail(msg); };
const step = (m) => console.log('  -', m);

async function waitFor(fn, what, ms = 60000, every = 150) {
  const end = Date.now() + ms;
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch {}
    if (Date.now() > end) fail(`timed out waiting for ${what}`);
    await sleep(every);
  }
}
const api = async (method, path, body) => {
  const r = await fetch(API + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${await r.text()}`);
  return r.json();
};

const tmp = mkdtempSync(join(tmpdir(), 'office-e2e-'));
const dataDir = join(tmp, 'data');
const folders = ['alpha', 'beta with space', 'gamma'].map(n => { const d = join(tmp, n); mkdirSync(d, { recursive: true }); return d; });

const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const start = (args, env, cwd = root) => {
  const c = spawn(npx, args, { cwd, env: { ...process.env, ...env }, stdio: 'ignore', shell: process.platform === 'win32' });
  children.push(c);
  return c;
};
start(['tsx', 'server/src/main.ts'], { OFFICE_DATA: dataDir, OFFICE_PORT: '5175', OFFICE_STAGE_MS: '800,1500' });
start(['vite', '--host', '127.0.0.1', '--port', '5173', '--strictPort'], {}, join(root, 'web'));
await waitFor(async () => (await fetch(API + '/api/projects')).ok, 'server');
await waitFor(async () => (await fetch(WEB + '/')).ok, 'vite');

// ---- Chrome over CDP
const port = 9333 + Math.floor(Math.random() * 500);
const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', [
  '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'e2eprof-'))}`,
  '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--window-size=1600,900', 'about:blank'], { stdio: 'ignore' });
children.push(chrome);
const target = await waitFor(async () => (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(t => t.type === 'page'), 'chrome');
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise(r => { ws.onopen = r; });
let id = 0; const pending = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const evalJs = async (expr) => {
  const r = (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result;
  if (r?.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text));
  return r?.result?.value;
};
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
let focusId = null; // frame this room for every shot (fit runs again right before the capture: the page's own first fit lands late)
const shot = async (name, settle = 500) => {
  if (focusId) await evalJs(`(() => { const o = window.__office; o.camera.fit(o.roomBounds(${JSON.stringify(focusId)}), 560); })()`);
  await sleep(settle);
  const s = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(shots, name), Buffer.from(s.result.data, 'base64'));
  step(`shot ${name}`);
};
const load = async () => {
  await send('Page.navigate', { url: WEB + '/' });
  await waitFor(async () => (await evalJs('document.title')) === 'READY', 'page READY', 120000, 400);
  await sleep(1500); // let the page's own first camera fit land before we frame the room
};

// ---- data via REST
const names = ['Alpha', 'Beta', 'Gamma'], accents = ['cyan', 'magenta', 'amber'];
const team = ['pm', 'techlead', 'frontend', 'backend', 'qa'];
const projects = [];
for (let i = 0; i < 3; i++) projects.push(await api('POST', '/api/projects', { name: names[i], folder: folders[i], accent: accents[i], team }));
assert((await api('GET', '/api/projects')).length === 3, 'expected 3 projects');
const p2 = projects[1];
step(`projects created (p2 folder has a space: ${p2.folder})`);

await load();
await evalJs(`window.__store.getState().select(${JSON.stringify(p2.id)})`);
await waitFor(async () => evalJs(`!!document.querySelector('.po-drawer')`), 'drawer open');
focusId = p2.id;
step('project 2 selected, drawer open');

const ticketsOf = async () => api('GET', `/api/projects/${p2.id}/tickets?limit=20`);
const ticket0 = await api('POST', `/api/projects/${p2.id}/tickets`, { text: 'Add a dark-mode toggle to the settings page' });
const tid = ticket0.id ?? ticket0.ticket?.id;
assert(tid, 'ticket id missing from POST response');
const cur = async () => (await ticketsOf()).tickets.find(t => t.id === tid);
await shot('01-pm-at-board.png', 200);

// plan gate
let t = await waitFor(async () => { const x = await cur(); return x.openGate === 'plan' && x; }, 'plan gate');
assert(t.status === 'waiting' && t.plan, 'plan gate: ticket should be waiting with a plan');
await waitFor(async () => evalJs(`window.__store.getState().tickets[${JSON.stringify(tid)}]?.openGate === 'plan'`), 'UI sees plan gate');
await shot('02-plan-gate.png');
await api('POST', `/api/tickets/${tid}/gates/plan`, { decision: 'approved' });

// build
await waitFor(async () => { const x = await cur(); return x.stage === 'build' && x.status === 'running'; }, 'build stage');
step('building');
await shot('03-building.png', 300);

// reload mid-build; the feed must match (prefix, no duplicates)
const feedIds = () => evalJs(`(() => (window.__store.getState().feed[${JSON.stringify(tid)}] ?? []).map(f => f.kind + ':' + f.id))()`);
const domRows = () => evalJs(`document.querySelectorAll('.po-feed > *').length`);
await waitFor(async () => (await feedIds()).length > 2, 'feed content');
const before = await feedIds();
const beforeDom = await domRows();
assert(new Set(before).size === before.length, 'feed has duplicate ids before reload');
await load();
await evalJs(`window.__store.getState().select(${JSON.stringify(p2.id)})`);
await waitFor(async () => (await feedIds()).length >= before.length, 'feed rebuilt after reload');
await sleep(800);
const after = await feedIds();
assert(new Set(after).size === after.length, `feed has duplicate ids after reload: ${JSON.stringify(after)}`);
assert(before.every((k, i) => after[i] === k), `feed after reload does not start with the pre-reload feed\nbefore=${JSON.stringify(before)}\nafter=${JSON.stringify(after)}`);
const snap = await evalJs(`(() => ({ n: (window.__store.getState().feed[${JSON.stringify(tid)}] ?? []).length, dom: document.querySelectorAll('.po-feed > *').length }))()`);
const afterDom = snap.dom;
assert(afterDom >= beforeDom, `DOM rows shrank across reload (${beforeDom} -> ${afterDom})`);
assert(afterDom === snap.n, `DOM rows (${afterDom}) != feed items (${snap.n}) after reload`);
step(`feed ok across reload (${before.length} items before, ${after.length} after, no duplicates)`);
await shot('04-after-reload.png', 300);

// walk to the final gate; tolerate review bounces and a 'stuck' gate
let shotReview = false, stuckHandled = 0;
for (;;) {
  const x = await waitFor(async () => {
    const c = await cur();
    return (['done', 'failed', 'cancelled'].includes(c.status) || c.openGate || c.stage === 'review') && c;
  }, 'final gate / stuck', 90000, 100);
  if (x.status === 'failed' || x.status === 'cancelled') fail(`ticket ended ${x.status}: ${x.reason ?? ''}`);
  if (x.openGate === 'stuck') { stuckHandled++; step('stuck gate -> accept'); await api('POST', `/api/tickets/${tid}/gates/stuck`, { decision: 'accept' }); await sleep(300); continue; }
  if (x.openGate === 'final') break;
  if (x.openGate === 'plan') { await api('POST', `/api/tickets/${tid}/gates/plan`, { decision: 'approved' }); continue; }
  if (x.status === 'done') fail('ticket finished without a final gate');
  if (x.stage === 'review' && !shotReview) { shotReview = true; await shot('05a-review.png', 100); }
  await sleep(150);
}
step('final gate open' + (stuckHandled ? ` (after ${stuckHandled} stuck gate(s))` : ''));
await waitFor(async () => evalJs(`window.__store.getState().tickets[${JSON.stringify(tid)}]?.openGate === 'final'`), 'UI sees final gate');
await shot('05-final-gate.png');
await api('POST', `/api/tickets/${tid}/gates/final`, { decision: 'approved' });
await waitFor(async () => (await cur()).status === 'done', 'ticket done');
assert((await cur()).stage === 'done', 'done ticket should have stage done');
await waitFor(async () => evalJs(`window.__store.getState().tickets[${JSON.stringify(tid)}]?.status === 'done'`), 'UI sees done');
await shot('06-done-wave.png', 600);
await shot('07-back-to-life.png', 9000);

// final consistency: server log has unique seqs, and the page has no error
const { events } = await ticketsOf();
const seqs = events[tid].filter(e => typeof e.seq === 'number').map(e => e.seq);
assert(new Set(seqs).size === seqs.length, 'duplicate seq in server log');
const err = await evalJs(`document.getElementById('err')?.textContent || ''`);
assert(!err, `page error: ${err}`);

cleanup();
console.log('e2e ok');
process.exit(0);
