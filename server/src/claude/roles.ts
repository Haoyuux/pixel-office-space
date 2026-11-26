import type { RoleId } from '@office/shared';

const both = (patterns: string[]): string[] => patterns.flatMap(p => [`Bash(${p})`, `PowerShell(${p})`]);
const READ = ['Read', 'Glob', 'Grep'];
const REVIEW = [...READ, ...both(['git diff *', 'git log *', 'git status *'])];
const DEV = [...READ, 'Edit', 'Write', 'MultiEdit',
  ...both(['npm *', 'npx *', 'node *', 'pnpm *', 'yarn *', 'git status *', 'git diff *'])];
const DOCS = [...READ, 'Edit', 'Write'];

/** Passed to the CLI as --allowedTools (Bash and PowerShell forms both). */
export const ROLE_TOOLS: Record<RoleId, string[]> = {
  pm: READ, techlead: REVIEW, security: REVIEW,
  frontend: DEV, backend: DEV, devops: DEV, qa: DEV,
  uiux: DOCS, writer: DOCS,
};

/** Plain tool names for agent-file frontmatter. */
export const toolNames = (role: RoleId): string[] => [...new Set(ROLE_TOOLS[role].map(t => t.replace(/\(.*$/, '')))];

export const MAX_TURNS = { plan: 30, review: 30, build: 80, test: 80, docs: 30, design: 30 } as const;
