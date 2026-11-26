import type { DiffFile, Plan, PlanTask, Project, RoleId, Stage } from '@office/shared';

const UI_WORDS = /\b(page|screen|ui|button|form|layout|modal|style|css|design)\b/i;

export function titleOf(text: string): string {
  const t = text.trim().replace(/\s+/g, ' ');
  return t.length > 60 ? t.slice(0, 57) + '…' : t;
}

const slug = (text: string) => (text.toLowerCase().match(/[a-z]+/g) ?? ['feature']).slice(0, 2).join('-');
const pascal = (s: string) => s.split('-').map(w => w[0].toUpperCase() + w.slice(1)).join('');

export function makePlan(project: Project, text: string): Plan {
  const s = slug(text), P = pascal(s);
  const has = (r: RoleId) => project.team.includes(r);
  const tasks: PlanTask[] = [];
  if (has('uiux') && UI_WORDS.test(text)) tasks.push({ role: 'uiux', text: `Sketch the ${s} screen and states`, files: [`docs/design/${s}.md`] });
  if (has('frontend')) tasks.push({ role: 'frontend', text: `Build the ${s} UI and wire it to the API`, files: [`web/src/pages/${P}.tsx`, 'web/src/api.ts'] });
  if (has('backend')) tasks.push({ role: 'backend', text: `Add the ${s} endpoint and service logic`, files: [`server/routes/${s}.ts`, `server/services/${s}.ts`] });
  if (has('devops')) tasks.push({ role: 'devops', text: 'Update build config and env vars', files: ['.env.example', 'Dockerfile'] });
  if (has('techlead')) tasks.push({ role: 'techlead', text: 'Review the changes for correctness and style', files: [] });
  if (has('security')) tasks.push({ role: 'security', text: 'Check the new endpoint for injection and auth issues', files: [] });
  if (has('qa')) tasks.push({ role: 'qa', text: `Write and run tests for ${s}`, files: [`tests/${s}.test.ts`] });
  if (has('writer')) tasks.push({ role: 'writer', text: 'Update the README and changelog', files: ['README.md', 'CHANGELOG.md'] });
  return {
    summary: `Implement: ${titleOf(text)}`,
    acceptance: [`${titleOf(text)} works end to end`, 'Existing tests still pass', 'New behaviour is covered by tests'],
    areas: [...new Set(tasks.flatMap(t => t.files))],
    tasks,
  };
}

export function makeDiff(plan: Plan): DiffFile[] {
  return plan.areas.filter(f => !f.endsWith('.md')).slice(0, 2).map(path => ({
    path,
    patch: `--- a/${path}\n+++ b/${path}\n@@ -1,3 +1,6 @@\n import { api } from './api';\n+\n+// added for this ticket\n+export function handle() {\n+  return api.call();\n+}\n`,
  }));
}

export interface WorkItem { kind: 'tool' | 'message'; tool?: string; summary: string; detail?: string }

const TOOL_BY_STAGE: Record<Exclude<Stage, 'done'>, string[]> = {
  plan: ['Read', 'Grep', 'Read', 'Glob'],
  design: ['Read', 'Write'],
  build: ['Read', 'Edit', 'Write', 'Bash'],
  review: ['Read', 'Bash', 'Read'],
  test: ['Write', 'Bash', 'Bash'],
  docs: ['Read', 'Edit'],
};

export function makeWork(role: RoleId, stage: Exclude<Stage, 'done'>, i: number, files: string[], random: () => number): WorkItem {
  const tools = TOOL_BY_STAGE[stage];
  if (i % 3 === 2) return { kind: 'message', summary: MESSAGES[stage][i % MESSAGES[stage].length] };
  const tool = tools[i % tools.length];
  const file = files.length ? files[i % files.length] : 'README.md';
  const plus = 3 + Math.floor(random() * 60), minus = Math.floor(random() * 8);
  switch (tool) {
    case 'Read': return { kind: 'tool', tool, summary: `Read ${file}`, detail: `// ${file}\n…${20 + Math.floor(random() * 200)} lines` };
    case 'Grep': return { kind: 'tool', tool, summary: `Grep "${role === 'pm' ? 'export' : 'TODO'}" in src/`, detail: `${1 + Math.floor(random() * 9)} matches` };
    case 'Glob': return { kind: 'tool', tool, summary: 'Glob **/*.ts', detail: `${10 + Math.floor(random() * 90)} files` };
    case 'Edit': return { kind: 'tool', tool, summary: `Edit ${file} (+${plus} −${minus})`, detail: `@@ ${file}\n+ …${plus} lines added` };
    case 'Write': return { kind: 'tool', tool, summary: `Write ${file} (+${plus})`, detail: `new file ${file}` };
    case 'Bash': return { kind: 'tool', tool, summary: stage === 'review' ? 'Bash git diff --stat' : 'Bash npm test', detail: stage === 'review' ? `${files.length} files changed` : `✓ ${5 + Math.floor(random() * 40)} tests passed` };
    default: return { kind: 'tool', tool, summary: `${tool} ${file}` };
  }
}

const MESSAGES: Record<Exclude<Stage, 'done'>, string[]> = {
  plan: ['Looked through the project structure and recent changes.', 'Drafting tasks and acceptance criteria now.'],
  design: ['Sketched the main state and the empty/error states.'],
  build: ['Implementation in progress, following the existing patterns.', 'Hooked it up and it compiles.'],
  review: ['Reviewing the diff for edge cases.', 'Looks consistent with the codebase.'],
  test: ['Writing tests for the new behaviour.', 'Running the full suite.'],
  docs: ['Updating the README section.'],
};
