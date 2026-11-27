import { useEffect, useState } from 'react';
import type { DevServerState } from '@office/shared';
import { useOffice } from '../state/store';
import { api, paths } from './api';
import { useFollow } from './useFollow';

const EMPTY: string[] = [];
const IDLE = (projectId: string): DevServerState => ({ projectId, status: 'idle' });
export const isLive = (s: DevServerState | undefined) => s?.status === 'starting' || s?.status === 'running';

export function useDevServer(projectId: string): DevServerState {
  return useOffice(s => s.devServers[projectId]) ?? IDLE(projectId);
}

/** Starts the project's dev server; resolves to an error text, or null when it started. */
export async function startDevServer(projectId: string, script?: string, install = false): Promise<string | null> {
  const r = await api<DevServerState>('POST', paths.devServerStart(projectId), install ? { install: true } : script ? { script } : {});
  if (!r.ok) return r.error;
  if (r.data?.projectId === projectId) {
    const s = useOffice.getState();
    useOffice.setState({ devServers: { ...s.devServers, [projectId]: r.data } });
  }
  return null;
}
export async function stopDevServer(projectId: string): Promise<string | null> {
  const r = await api<DevServerState>('POST', paths.devServerStop(projectId));
  return r.ok ? null : r.error;
}

const POLITE = /^(?:(?:hey|ok|okay|please|pls|plz|can|could|would|will|you|u|just|go|ahead|and|now)\s+)+/;
/** Words a short "run it" request may contain besides the verb (and the project's own name). */
const FILLER = new Set(['my', 'the', 'this', 'our', 'a', 'it', 'app', 'application', 'site', 'website', 'web', 'webapp', 'page',
  'portfolio', 'project', 'frontend', 'front-end', 'server', 'dev', 'devserver', 'dev-server', 'locally', 'local', 'for', 'me', 'us',
  'up', 'now', 'again', 'please', 'pls', 'on', 'localhost', 'in', 'browser', 'preview']);
const RUN_VERB = /^(?:run|start|launch|serve|boot|spin|fire|open|preview|restart)$/;
const STOP_VERB = /^(?:stop|kill|shutdown|shut|close|end)$/;

/**
 * A short chat line that only asks to run / stop the project ("run my portfolio", "start the dev server", "npm run dev",
 * "stop the server"). Anything else ("run the tests", "start a login page") stays a request for the team.
 */
export function runIntent(text: string, projectName = ''): 'run' | 'stop' | null {
  const t = text.toLowerCase().replace(/[?!.。,]+/g, ' ').replace(/\s+/g, ' ').trim().replace(POLITE, '');
  if (!t) return null;
  if (/^npm (?:run )?(?:dev|start)$/.test(t) || /^(?:pnpm|yarn) (?:run )?(?:dev|start)$/.test(t)) return 'run';
  const words = t.split(' ');
  if (words.length > 7) return null;
  const verb = RUN_VERB.test(words[0]) ? 'run' : STOP_VERB.test(words[0]) ? 'stop' : null;
  if (!verb) return null;
  const name = projectName.toLowerCase();
  const own = new Set([...name.split(/[^a-z0-9-]+/), ...name.split(/[^a-z0-9]+/)].filter(Boolean));
  const known = (w: string) => FILLER.has(w) || own.has(w)
    || (w.length >= 6 && [...FILLER, ...own].some(k => k.length >= 6 && near(w, k))); // "porfolio"
  const rest = words.slice(1).filter(w => !(w === 'down' && verb === 'stop')); // "shut down"
  if (!rest.length) return verb === 'run' && words[0] !== 'open' ? 'run' : null; // "run" alone; "stop" alone means the agent
  if (!rest.every(known)) return null;
  // "open the project" / "close it" without a server word are too vague
  if ((words[0] === 'open' || words[0] === 'close' || words[0] === 'end') && !rest.some(w => /server|localhost|browser|preview|portfolio|site|app/.test(w))) return null;
  return verb;
}

/** Edit distance ≤ 2 (typos). */
function near(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 2) return false;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length] <= 2;
}

/** Output that means the packages are not installed. */
const MISSING = /Cannot find (?:package|module)|ERR_MODULE_NOT_FOUND|is not recognized as an internal or external command|: not found$|command not found/i;

const STATUS_TEXT: Record<DevServerState['status'], string> = {
  idle: 'not running', starting: 'starting…', running: 'running', stopped: 'stopped', exited: 'exited', failed: 'failed',
};
const shortUrl = (u: string) => u.replace(/^https?:\/\//, '').replace(/\/$/, '');

/** Header control: ▶ Run, or the live URL + ■. */
export function RunButton({ projectId, onOpen }: { projectId: string; onOpen: () => void }) {
  const s = useDevServer(projectId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const live = isLive(s);
  const act = async () => {
    setBusy(true); setError(null);
    const err = live ? await stopDevServer(projectId) : await startDevServer(projectId);
    setBusy(false);
    if (err) setError(err);
    if (!live) onOpen();
  };
  return <>
    {live && s.url && (
      <a className="po-hbtn po-run-url" href={s.url} target="_blank" rel="noreferrer" title={`Open ${s.url}`}>● {shortUrl(s.url)} ↗</a>
    )}
    <button type="button" className={`po-hbtn po-run${live ? ' on' : ''}`} disabled={busy}
      title={error ?? (live ? 'Stop the dev server' : 'Run the dev server (npm run dev / start)')} aria-label={live ? 'Stop dev server' : 'Run dev server'}
      onClick={() => void act()}>
      {live ? (s.status === 'starting' ? '◌ ■' : '■ Stop') : error ? '⚠ Run' : '▶ Run'}
    </button>
  </>;
}

interface Info { scripts: string[]; defaultScript: string | null; cwd: string | null }

/** The Run tab: status, script picker, Start / Stop / Restart, and the server's output. */
export function DevServerPanel({ projectId }: { projectId: string }) {
  const s = useDevServer(projectId);
  const lines = useOffice(st => st.devLogs[projectId] ?? EMPTY);
  const [info, setInfo] = useState<Info | null>(null);
  const [script, setScript] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { ref, paused, onScroll, follow } = useFollow<HTMLPreElement>(lines.length);
  const live = isLive(s);

  useEffect(() => {
    let on = true;
    void (async () => {
      const r = await api<Info & { state: DevServerState; log: string[] }>('GET', paths.devServer(projectId));
      if (!on || !r.ok || !r.data) return;
      setInfo({ scripts: r.data.scripts ?? [], defaultScript: r.data.defaultScript, cwd: r.data.cwd });
      if (r.data.state) useOffice.getState().setDevServer(projectId, r.data.state, r.data.log ?? []);
    })();
    return () => { on = false; };
  }, [projectId]);

  const chosen = script || (s.script !== 'install' ? s.script : '') || info?.defaultScript || '';
  const installing = s.script === 'install';
  /** The last run failed on missing packages: npm install is the next step. */
  const missing = !live && s.status === 'exited' && !installing && lines.some(l => MISSING.test(l));
  const run = async (what: 'start' | 'stop' | 'restart' | 'install') => {
    setBusy(true); setError(null);
    let err: string | null = null;
    if (what === 'stop' || what === 'restart') err = await stopDevServer(projectId);
    if (!err && what === 'restart') err = await waitStopped(projectId);
    if (!err && what === 'install') err = await startDevServer(projectId, undefined, true);
    if (!err && (what === 'start' || what === 'restart')) err = await startDevServer(projectId, chosen || undefined);
    setBusy(false);
    setError(err);
  };

  const noPkg = info && !info.cwd;
  return (
    <div className="po-run-panel">
      <div className="po-run-bar">
        <span className={`po-run-dot ${s.status}`} aria-hidden>●</span>
        <b>{STATUS_TEXT[s.status]}</b>
        {s.status === 'exited' && s.exitCode != null && <span className="po-dim">code {s.exitCode}</span>}
        {s.url && live && <a href={s.url} target="_blank" rel="noreferrer">{s.url} ↗</a>}
        <span className="po-grow" />
        {info && info.scripts.length > 0 && (
          <label className="po-filter">
            <span className="po-dim">npm run</span>
            <select aria-label="Script" value={chosen} disabled={live} onChange={e => setScript(e.target.value)}>
              {!chosen && <option value="">pick a script</option>}
              {info.scripts.map(x => <option key={x} value={x}>{x}</option>)}
            </select>
          </label>
        )}
        {live ? <>
          {!installing && <button type="button" className="po-btn ghost" disabled={busy} onClick={() => void run('restart')}>↻ Restart</button>}
          <button type="button" className="po-btn danger" disabled={busy} onClick={() => void run('stop')}>■ Stop</button>
        </> : <>
          <button type="button" className={`po-btn ${missing ? 'primary' : 'ghost'}`} disabled={busy || !!noPkg} title="Install the project's packages (npm install)"
            onClick={() => void run('install')}>📦 npm install</button>
          <button type="button" className={`po-btn ${missing ? 'ghost' : 'primary'}`} disabled={busy || !!noPkg || !chosen} onClick={() => void run('start')}>▶ Run</button>
        </>}
      </div>
      {missing && <div className="po-run-note po-run-hint">Packages are missing — press 📦 npm install, then ▶ Run.</div>}
      {installing && s.status === 'exited' && s.exitCode === 0 && <div className="po-run-note po-run-hint">Packages installed — press ▶ Run.</div>}
      {(error || (s.status === 'failed' && s.error)) && <div className="po-error" role="alert">{error ?? s.error}</div>}
      {noPkg && <div className="po-dim po-run-note">No package.json in this project folder — ▶ Run starts npm scripts.</div>}
      {info?.cwd && <div className="po-dim po-run-note" title={info.cwd}>Runs in {info.cwd} · keeps running after the agents finish · stops when you press ■ or close the office server.</div>}
      <div className="po-scroll-wrap">
        <pre className="po-scroll po-raw" ref={ref} onScroll={onScroll} aria-label="Dev server output">
          {lines.length === 0 && <span className="po-dim">(no output yet — press ▶ Run)</span>}
          {lines.map((l, i) => <span key={i} className="po-raw-line">{l}{'\n'}</span>)}
        </pre>
        {paused && <button type="button" className="po-follow" onClick={follow}>⏸ paused · ↓ follow</button>}
      </div>
    </div>
  );
}

/** Restart: wait until the old process has ended (its port is free) before starting again. */
async function waitStopped(projectId: string, ms = 10000): Promise<string | null> {
  const end = Date.now() + ms;
  while (isLive(useOffice.getState().devServers[projectId])) {
    if (Date.now() > end) return 'The old dev server did not stop in time';
    await new Promise(r => setTimeout(r, 100));
  }
  return null;
}
