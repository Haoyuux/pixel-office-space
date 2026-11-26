import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { roleDef, type RoleId } from '@office/shared';
import { ValidationError } from './errors';
import { toolNames } from './claude/roles';

export const MANAGED_MARKER = '<!-- pixel-office:managed -->';

// Files carrying MANAGED_MARKER are considered managed by Pixel Office and WILL be overwritten on upgrade.
// Remove the marker to keep your own edits.
export function agentFileFor(role: RoleId): string {
  const r = roleDef(role);
  return `---
name: ${role}
description: ${r.label} on this project's Pixel Office team.
tools: ${toolNames(role).join(', ')}
---
${MANAGED_MARKER}

You are the **${r.label}** for this project.

## Permissions
${r.tools}

## Working agreement
- Work only inside this project folder; never run git commit, git push, or change git config/branches.
- Report what you did in short, plain messages; the owner watches your work in the Pixel Office console.
- Finish with the exact output format the task asks for.
`;
}

/** The M1 template, kept only to recognise (and upgrade) files M1 generated. */
export function legacyAgentFile(role: RoleId): string {
  const r = roleDef(role);
  return `---
name: ${role}
description: ${r.label} on this project's Pixel Office team.
---

You are the **${r.label}** for this project.

## Permissions
${r.tools}

## Working agreement
- Work only inside this project folder.
- Report what you did in short, plain messages; the owner watches your work in the Pixel Office console.
`;
}

export function scaffoldAgents(folder: string, team: RoleId[]): { written: string[]; skipped: string[] } {
  const dir = join(folder, '.claude', 'agents');
  mkdirSync(dir, { recursive: true });
  const written: string[] = [], skipped: string[] = [];
  for (const role of team) {
    const f = join(dir, `${role}.md`);
    if (existsSync(f)) {
      const cur = readFileSync(f, 'utf8');
      if (!cur.includes(MANAGED_MARKER) && cur !== legacyAgentFile(role)) { skipped.push(f); continue; }
      if (cur !== agentFileFor(role)) { writeFileSync(f, agentFileFor(role)); written.push(f); }
      continue;
    }
    writeFileSync(f, agentFileFor(role), { flag: 'wx' });
    written.push(f);
  }
  return { written, skipped };
}

const FS_REASONS: Record<string, string> = {
  EPERM: 'permission denied', EACCES: 'permission denied', EROFS: 'the folder is read-only',
  ENOTDIR: 'a file is in the way (.claude or .claude/agents is not a folder)', EEXIST: 'a file is in the way (.claude or .claude/agents is not a folder)',
  ENOSPC: 'the disk is full',
};

/** scaffoldAgents, with file-system failures turned into a readable ValidationError (400). */
export function scaffoldOrExplain(folder: string, team: RoleId[]): void {
  try { scaffoldAgents(folder, team); } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? '';
    throw new ValidationError(`Can't write .claude/agents in ${folder}: ${FS_REASONS[code] ?? (e as Error).message}`);
  }
}
