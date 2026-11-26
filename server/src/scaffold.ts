import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { roleDef, type RoleId } from '@office/shared';
import { ValidationError } from './errors';

export function agentFile(role: RoleId): string {
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
    if (existsSync(f)) { skipped.push(f); continue; }
    writeFileSync(f, agentFile(role), { flag: 'wx' });
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
