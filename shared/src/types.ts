export type RoleId = 'pm' | 'techlead' | 'frontend' | 'backend' | 'qa' | 'uiux' | 'devops' | 'security' | 'writer';
export type Accent = 'cyan' | 'magenta' | 'amber' | 'lime' | 'violet';
export interface Look { character: string; palette: 'a' | 'b' | 'c' }
export interface Project {
  id: string; name: string; folder: string; accent: Accent; team: RoleId[]; slot: number;
  looks: Record<RoleId, Look>; createdAt: string;
  /** Who works the tickets; missing = 'claude'. */
  agentsMode?: AgentsMode;
}
export type AgentsMode = 'claude' | 'simulated';
/** Where a claude ticket works (persisted in the log so Resume / follow-ups can rebuild it). */
export interface Workspace { branch: string; worktree: string; base: { branch: string; head: string }; merged?: boolean }
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
}
