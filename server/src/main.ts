import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOffice } from './app';
import { TicketLog } from './ticketLog';
import { SimulatedOrchestrator } from './orchestrator/simulated';
import { realScheduler } from './orchestrator/types';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const dataDir = process.env.OFFICE_DATA ?? join(root, 'server', 'data');
const port = Number(process.env.OFFICE_PORT ?? 5175);
const stageMs = process.env.OFFICE_STAGE_MS ? (process.env.OFFICE_STAGE_MS.split(',').map(Number) as [number, number]) : undefined;

const log = new TicketLog(join(dataDir, 'projects'));
const recovered = log.recover();
const orchestrator = new SimulatedOrchestrator({ log, scheduler: realScheduler, stageMs });
const office = createOffice({ dataDir, orchestrator, log, assetsDir: join(root, 'assets') });

for (const t of recovered.filter(t => t.status === 'queued')) {
  const p = office.store.get(t.projectId);
  if (p) orchestrator.adopt(p, t);
}

office.server.listen(port, '127.0.0.1', () => console.log(`Pixel Office server on http://127.0.0.1:${port}`));
