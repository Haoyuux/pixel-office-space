import { join } from 'node:path';
import { createOffice, type Office, type OfficeOptions } from './app';
import { TicketLog } from './ticketLog';
import { SimulatedOrchestrator } from './orchestrator/simulated';
import { ClaudeOrchestrator, type Runner } from './orchestrator/claude';
import { RoutingOrchestrator, type Mode } from './orchestrator/routing';
import { realScheduler, type Scheduler } from './orchestrator/types';
import { ClaudeRunner } from './claude/runner';

export interface BootOptions {
  dataDir: string;
  assetsDir?: string;
  scheduler?: Scheduler;
  stageMs?: [number, number];
  random?: () => number;
  /** Claude runner (tests inject a fake; default spawns the real `claude` CLI). */
  runner?: Runner;
  /** Force every project onto one orchestrator (e2e: OFFICE_AGENTS=simulated). */
  forceMode?: Mode;
  claudeSystem?: OfficeOptions['claudeSystem'];
}

/**
 * The server wiring (main.ts listens on the result): recover the ticket log — tickets that were running when the
 * server stopped become failed/interrupted — then re-queue the never-started ones so they run again. Tickets are
 * routed per project by `project.agentsMode` (missing = claude).
 */
export function boot(opts: BootOptions): {
  office: Office; orchestrator: RoutingOrchestrator; simulated: SimulatedOrchestrator; claude: ClaudeOrchestrator; log: TicketLog;
} {
  const log = new TicketLog(join(opts.dataDir, 'projects'));
  const recovered = log.recover();
  const simulated = new SimulatedOrchestrator({ log, scheduler: opts.scheduler ?? realScheduler, stageMs: opts.stageMs, random: opts.random });
  let office: Office | undefined;
  const claude = new ClaudeOrchestrator({
    log, runner: opts.runner ?? new ClaudeRunner(), dataDir: opts.dataDir, getProject: id => office?.store.get(id),
  });
  const orchestrator = new RoutingOrchestrator(opts.forceMode
    ? { claude: opts.forceMode === 'simulated' ? simulated : claude, simulated: opts.forceMode === 'simulated' ? simulated : claude }
    : { claude, simulated });
  office = createOffice({ dataDir: opts.dataDir, orchestrator, log, assetsDir: opts.assetsDir, claudeSystem: opts.claudeSystem });
  for (const t of recovered.filter(t => t.status === 'queued')) {
    const p = office.store.get(t.projectId);
    if (p) orchestrator.adopt(p, t);
  }
  return { office, orchestrator, simulated, claude, log };
}
