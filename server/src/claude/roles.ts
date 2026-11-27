import type { RoleId } from '@office/shared';

const both = (patterns: string[]): string[] => patterns.flatMap(p => [`Bash(${p})`, `PowerShell(${p})`]);
const READ = ['Read', 'Glob', 'Grep'];
const REVIEW = [...READ, ...both(['git diff *', 'git log *', 'git status *', 'git -C * diff *', 'git -C * log *', 'git -C * status *'])];
const DEV = [...READ, 'Edit', 'Write', 'MultiEdit',
  ...both(['npm *', 'npx *', 'node *', 'pnpm *', 'yarn *', 'dotnet *', 'git status *', 'git diff *', 'git -C * status *', 'git -C * diff *', 'cd *'])];
const DOCS = [...READ, 'Edit', 'Write'];
/** PM: read the code and inspect git state for answers and plans; never change anything. */
const PM = [...READ, ...both(['git status *', 'git log *', 'git diff *', 'git branch *',
  'git -C * status *', 'git -C * log *', 'git -C * diff *', 'git -C * branch *'])];

/** Passed to the CLI as --allowedTools (Bash and PowerShell forms both). */
export const ROLE_TOOLS: Record<RoleId, string[]> = {
  pm: PM, techlead: REVIEW, security: REVIEW,
  frontend: DEV, backend: DEV, devops: DEV, qa: DEV,
  uiux: DOCS, writer: DOCS,
};

/** Plain tool names for agent-file frontmatter. */
export const toolNames = (role: RoleId): string[] => [...new Set(ROLE_TOOLS[role].map(t => t.replace(/\(.*$/, '')))];

export const MAX_TURNS = { plan: 30, review: 30, build: 80, test: 80, docs: 30, design: 30 } as const;
