import { ROLE_IDS, type Plan, type PlanTask, type RoleId, type TicketMode } from '@office/shared';

export interface ReviewIssue { role: RoleId; file: string; note: string }
export interface TestFailure { role: RoleId; note: string }
export interface ReviewVerdict { approved: boolean; issues: ReviewIssue[]; unassigned: ReviewIssue[]; notes: string[] }
export interface TestVerdict { passed: boolean; failures: TestFailure[]; unassigned: TestFailure[]; notes: string[] }
export type PlanWithMap = Plan & { projectMap?: string };

const isObj = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v);
const strs = (v: unknown): v is string[] => Array.isArray(v) && v.every(x => typeof x === 'string');
/** Optional non-blocking remarks: anything malformed is dropped, never a parse failure. */
const notesOf = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x.trim()) : [];
const isRole = (v: unknown): v is RoleId => typeof v === 'string' && (ROLE_IDS as string[]).includes(v);

/** Last fenced ```json block, else the whole text. Returns null when nothing parses/validates. */
export function extractJson<T>(text: string, validate: (v: unknown) => T | null): T | null {
  const blocks = [...text.matchAll(/```json\s*\n([\s\S]*?)```/gi)].map(m => m[1]);
  const candidate = blocks.length ? blocks[blocks.length - 1] : text;
  try { return validate(JSON.parse(candidate.trim())); } catch { return null; }
}

export const planValidator = (team: RoleId[]) => (v: unknown): PlanWithMap | null => {
  if (!isObj(v) || typeof v.summary !== 'string' || !strs(v.acceptance) || !strs(v.areas) || !Array.isArray(v.tasks)) return null;
  if (v.projectMap !== undefined && typeof v.projectMap !== 'string') return null;
  if (v.tasks.length === 0) return null;
  const tasks: PlanTask[] = [];
  for (const t of v.tasks) {
    // PM plans, it doesn't implement: tasks the PM assigns to itself (e.g. "check against acceptance", seen live) are dropped.
    if (isObj(t) && t.role === 'pm') continue;
    if (!isObj(t) || !isRole(t.role) || !team.includes(t.role) || typeof t.text !== 'string' || !strs(t.files)) return null;
    tasks.push({ role: t.role, text: t.text, files: t.files });
  }
  if (tasks.length === 0) return null;
  const plan: PlanWithMap = { summary: v.summary, acceptance: v.acceptance, areas: v.areas, tasks };
  if (v.projectMap !== undefined) plan.projectMap = v.projectMap;
  return plan;
};

/** Items whose role is not on the team (or unknown) go to `unassigned` for the orchestrator to route to the PM. */
export const reviewValidator = (team: RoleId[]) => (v: unknown): ReviewVerdict | null => {
  if (!isObj(v) || typeof v.approved !== 'boolean' || !Array.isArray(v.issues)) return null;
  const issues: ReviewIssue[] = [], unassigned: ReviewIssue[] = [];
  for (const i of v.issues) {
    if (!isObj(i) || typeof i.role !== 'string' || typeof i.file !== 'string' || typeof i.note !== 'string') return null;
    (isRole(i.role) && team.includes(i.role) ? issues : unassigned).push({ role: i.role as RoleId, file: i.file, note: i.note });
  }
  return { approved: v.approved, issues, unassigned, notes: notesOf(v.notes) };
};

export const testValidator = (team: RoleId[]) => (v: unknown): TestVerdict | null => {
  if (!isObj(v) || typeof v.passed !== 'boolean' || !Array.isArray(v.failures)) return null;
  const failures: TestFailure[] = [], unassigned: TestFailure[] = [];
  for (const f of v.failures) {
    if (!isObj(f) || typeof f.role !== 'string' || typeof f.note !== 'string') return null;
    (isRole(f.role) && team.includes(f.role) ? failures : unassigned).push({ role: f.role as RoleId, note: f.note });
  }
  return { passed: v.passed, failures, unassigned, notes: notesOf(v.notes) };
};

/** The PM's first reply: a plan (today's shape, `"kind": "plan"` optional) or, outside ticket mode, an answer. */
export type PmReply = { kind: 'plan'; plan: PlanWithMap } | { kind: 'answer'; answer: string };

export const pmValidator = (team: RoleId[], mode: TicketMode) => (v: unknown): PmReply | null => {
  if (mode !== 'ticket' && isObj(v) && v.kind === 'answer') {
    return typeof v.answer === 'string' && v.answer.trim() ? { kind: 'answer', answer: v.answer.trim() } : null;
  }
  if (mode === 'ask') return null;
  if (isObj(v) && v.kind !== undefined && v.kind !== 'plan') return null;
  const plan = planValidator(team)(v);
  return plan ? { kind: 'plan', plan } : null;
};

/**
 * Clearly prose: some text, no fenced json block, not a bare JSON value, and no plan keys either ("summary"/"tasks"
 * in prose is a broken plan: it gets the fixJson retry instead of being shown as an answer).
 */
export const isProse = (text: string): boolean => {
  const t = text.trim();
  return !!t && !/```json/i.test(t) && !/^[[{]/.test(t) && !/"(summary|tasks)"/.test(t);
};

export const validateReview = reviewValidator(ROLE_IDS);
export const validateTest = testValidator(ROLE_IDS);
