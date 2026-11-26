import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { roleDef, type RoleId } from '@office/shared';

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
