import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boot } from './boot';
import { killLiveSync } from './claude/runner';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const dataDir = process.env.OFFICE_DATA ?? join(root, 'server', 'data');
const port = Number(process.env.OFFICE_PORT ?? 5175);
const stageMs = process.env.OFFICE_STAGE_MS ? (process.env.OFFICE_STAGE_MS.split(',').map(Number) as [number, number]) : undefined;

const forceMode = process.env.OFFICE_AGENTS === 'simulated' ? 'simulated' as const : undefined;
const { office, orchestrator } = boot({ dataDir, stageMs, assetsDir: join(root, 'assets'), forceMode });

office.server.listen(port, '127.0.0.1', () => console.log(`Pixel Office server on http://127.0.0.1:${port}`));

// Never leave claude processes behind: graceful stop aborts the runs (each process tree is killed), and on exit any
// survivor is force-killed synchronously.
let stopping = false;
const stop = (signal: NodeJS.Signals) => {
  if (stopping) return;
  stopping = true;
  console.log(`${signal}: stopping agents...`);
  Promise.all([orchestrator.shutdown(), office.devServers.shutdown()]).catch(() => undefined).finally(() => process.exit(0));
};
for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(s, () => stop(s));
process.on('exit', () => { killLiveSync(); office.devServers.killAllSync(); });
