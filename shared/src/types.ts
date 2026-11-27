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
