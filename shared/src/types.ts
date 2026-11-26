export type RoleId = 'pm' | 'techlead' | 'frontend' | 'backend' | 'qa' | 'uiux' | 'devops' | 'security' | 'writer';
export type Accent = 'cyan' | 'magenta' | 'amber' | 'lime' | 'violet';
export interface Look { character: string; palette: 'a' | 'b' | 'c' }
export interface Project {
  id: string; name: string; folder: string; accent: Accent; team: RoleId[]; slot: number;
  looks: Record<RoleId, Look>; createdAt: string;
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
}
