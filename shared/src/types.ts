export type RoleId = 'pm' | 'techlead' | 'frontend' | 'backend' | 'qa' | 'uiux' | 'devops' | 'security' | 'writer';
export type Accent = 'cyan' | 'magenta' | 'amber' | 'lime' | 'violet';
export interface Look { character: string; palette: 'a' | 'b' | 'c' }
export interface Project {
  id: string; name: string; folder: string; accent: Accent; team: RoleId[]; slot: number;
  looks: Record<RoleId, Look>; createdAt: string;
  /** Who works the tickets; missing = 'claude'. */
  agentsMode?: AgentsMode;
  /** Multi-repo project: the git repos in the folder's direct subfolders (absent = the folder is one repo). */
  repos?: RepoRef[];
  /** What git detection found at the last add/update: 'none' = not a git repo (Initialize git is offered). */
  gitKind?: RepoDetection['kind'];
  /** Claude model for this project's runs (`--model`); missing / 'default' = Claude Code's default. */
  model?: ModelChoice;
}
export type ModelChoice = 'default' | 'opus' | 'sonnet' | 'haiku' | 'fable';
export const MODEL_CHOICES: ModelChoice[] = ['default', 'opus', 'sonnet', 'haiku', 'fable'];
export interface RepoRef { name: string; path: string }
export type RepoDetection = { kind: 'single' } | { kind: 'multi'; repos: RepoRef[] } | { kind: 'none' };
export type AgentsMode = 'claude' | 'simulated';
/** auto = the PM decides (answer or plan); ask = answer only, never a plan; ticket = always a plan. */
export type TicketMode = 'auto' | 'ask' | 'ticket';
export const TICKET_MODES: TicketMode[] = ['auto', 'ask', 'ticket'];
/** Where a claude ticket works (persisted in the log so Resume / follow-ups can rebuild it). */
export interface Workspace {
  branch: string; worktree: string; base: { branch: string; head: string }; merged?: boolean;
  /**
   * Multi-repo ticket: `worktree` is the workspace folder and each repo has its own worktree at `<worktree>/<name>`
   * (branch/base above mirror the first repo). Absent = single repo (the worktree is the workspace).
   */
  repos?: WorkspaceRepo[];
}
export interface WorkspaceRepo {
  name: string; path: string; branch: string; base: { branch: string; head: string }; detached: boolean; merged?: boolean;
}
export type Stage = 'plan' | 'design' | 'build' | 'review' | 'test' | 'docs' | 'done';
export type TicketStatus = 'queued' | 'running' | 'waiting' | 'done' | 'failed' | 'cancelled';
export interface PlanTask { role: RoleId; text: string; files: string[] }
export interface Plan { summary: string; acceptance: string[]; areas: string[]; tasks: PlanTask[] }
export interface DiffFile { path: string; patch: string }
export type GateKind = 'plan' | 'final' | 'stuck';
export type GateDecision = 'approved' | 'changes' | 'retry' | 'accept' | 'cancel';
export type AgentState = 'idle' | 'summoned' | 'planning' | 'designing' | 'coding' | 'reviewing' | 'testing'
  | 'documenting' | 'waiting' | 'done' | 'failed';
export interface Ticket {
  id: string; projectId: string; title: string; text: string; status: TicketStatus; stage: Stage | null;
  reason?: string; plan?: Plan; openGate?: GateKind; agentStates: Partial<Record<RoleId, AgentState>>; createdAt: string;
  /** Claude session id per role (claude agents only). */
  sessions?: Partial<Record<RoleId, string>>;
  /** Totals across runs; costUsd is an estimate. */
  usage?: { turns: number; costUsd: number; durationMs: number };
  /** Follow-up of this earlier ticket. */
  parentTicketId?: string;
  agentsMode?: AgentsMode;
  workspace?: Workspace;
  /** How the PM treats the request (missing = ticket: tickets from before modes existed). */
  mode?: TicketMode;
  /** The PM answered instead of planning (no gate, no changes). */
  answered?: boolean;
  /** The owner stopped the run (Stop); the ticket ended done with whatever text had streamed. */
  stopped?: boolean;
  /** Files attached to the request (uploaded via POST /api/projects/:id/attachments). */
  attachments?: Attachment[];
}
/** An uploaded file; `path` is absolute (under the server's data folder, outside every repo). */
export interface Attachment { id: string; name: string; path: string }
/** Per-conversation (root ticket) metadata: `<dataDir>/conversations.json`. deleted = soft-deleted (hidden; logs kept). */
export interface ConversationMeta { projectId: string; title?: string; pinned?: boolean; deleted?: boolean }

/** Team memory (`<dataDir>/memory/<projectId>.json`, never in the owner's repos): durable project facts and rules. */
export interface MemoryEntry { id: string; text: string; source: 'owner' | 'pm'; ticketId?: string; at: string }
export const MEMORY_MAX_ENTRIES = 60;
export const MEMORY_TEXT_MAX = 300;
/** PM lessons per plan/answer reply, and their length. */
export const MEMORY_LESSONS_MAX = 3;
export const MEMORY_LESSON_MAX = 200;

/** `GET /api/summary?since=<ISO>`: what happened since a moment, per project (computed from the ticket logs). */
export interface SummaryUsage { turns: number; costUsd: number; durationMs: number }
/** A currently open gate (listed regardless of `since`). */
export interface SummaryWaiting { ticketId: string; rootId: string; title: string; gate: GateKind }
/** A ticket with activity since `since`; chat = the PM answered; at = its latest event. Newest first. */
export interface SummaryItem { ticketId: string; rootId: string; title: string; kind: 'chat' | 'ticket'; status: TicketStatus; at: string }
export interface ProjectSummary {
  projectId: string; name: string; finished: number; failed: number; answered: number;
  waiting: SummaryWaiting[]; items: SummaryItem[]; usage: SummaryUsage;
}
export interface SummaryTotals { finished: number; failed: number; answered: number; waiting: number; usage: SummaryUsage }
export interface Summary { since: string; projects: ProjectSummary[]; totals: SummaryTotals }

/**
 * The project's dev server (▶ Run): an npm script the office server starts and owns in the project folder, so it
 * keeps running after any agent run ends. starting = spawned, no URL seen yet; running = a URL was printed;
 * stopped = the owner stopped it; exited = it ended by itself (exitCode); failed = it could not start.
 */
export type DevServerStatus = 'idle' | 'starting' | 'running' | 'stopped' | 'exited' | 'failed';
export interface DevServerState {
  projectId: string; status: DevServerStatus;
  /** The npm script (`npm run <script>`) and the folder it runs in. */
  script?: string; cwd?: string;
  /** First local URL the server printed (0.0.0.0 shown as localhost). */
  url?: string;
  startedAt?: string; endedAt?: string; exitCode?: number | null; error?: string;
}
/** Dev server log lines kept per project (oldest dropped). */
export const DEV_LOG_MAX = 500;
