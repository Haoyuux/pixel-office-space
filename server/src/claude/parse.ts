import { ROLE_IDS, type Plan, type RoleId } from '@office/shared';

export interface ReviewVerdict { approved: boolean; issues: { role: RoleId; file: string; note: string }[] }
export interface TestVerdict { passed: boolean; failures: { role: RoleId; note: string }[] }
export type PlanWithMap = Plan & { projectMap?: string };

const isObj = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v);
const strs = (v: unknown): v is string[] => Array.isArray(v) && v.every(x => typeof x === 'string');
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
  for (const t of v.tasks) {
    if (!isObj(t) || !isRole(t.role) || !team.includes(t.role) || typeof t.text !== 'string' || !strs(t.files)) return null;
  }
  const plan: PlanWithMap = { summary: v.summary, acceptance: v.acceptance, areas: v.areas, tasks: v.tasks };
  if (v.projectMap !== undefined) plan.projectMap = v.projectMap;
  return plan;
};

export const validateReview = (v: unknown): ReviewVerdict | null => {
  if (!isObj(v) || typeof v.approved !== 'boolean' || !Array.isArray(v.issues)) return null;
  for (const i of v.issues) if (!isObj(i) || !isRole(i.role) || typeof i.file !== 'string' || typeof i.note !== 'string') return null;
  return { approved: v.approved, issues: v.issues };
};

export const validateTest = (v: unknown): TestVerdict | null => {
  if (!isObj(v) || typeof v.passed !== 'boolean' || !Array.isArray(v.failures)) return null;
  for (const f of v.failures) if (!isObj(f) || !isRole(f.role) || typeof f.note !== 'string') return null;
  return { passed: v.passed, failures: v.failures };
};
