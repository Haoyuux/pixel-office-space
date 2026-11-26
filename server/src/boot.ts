import { join } from 'node:path';
import { createOffice, type Office } from './app';
import { TicketLog } from './ticketLog';
import { SimulatedOrchestrator } from './orchestrator/simulated';
import { realScheduler, type Scheduler } from './orchestrator/types';

export interface BootOptions {
  dataDir: string;
  assetsDir?: string;
  scheduler?: Scheduler;
  stageMs?: [number, number];
  random?: () => number;
}

/**
 * The server wiring (main.ts listens on the result): recover the ticket log — tickets that were running when the
 * server stopped become failed/interrupted — then re-queue the never-started ones so they run again.
 */
export function boot(opts: BootOptions): { office: Office; orchestrator: SimulatedOrchestrator; log: TicketLog } {
  const log = new TicketLog(join(opts.dataDir, 'projects'));
  const recovered = log.recover();
  const orchestrator = new SimulatedOrchestrator({ log, scheduler: opts.scheduler ?? realScheduler, stageMs: opts.stageMs, random: opts.random });
  const office = createOffice({ dataDir: opts.dataDir, orchestrator, log, assetsDir: opts.assetsDir });
  for (const t of recovered.filter(t => t.status === 'queued')) {
    const p = office.store.get(t.projectId);
    if (p) orchestrator.adopt(p, t);
  }
  return { office, orchestrator, log };
}
