import { describe, it, expect } from 'vitest';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scaffoldAgents } from '../src/scaffold';
import { projectDir } from './helpers';

describe('scaffoldAgents', () => {
  it('writes one agent file per role with label and tools', () => {
    const d = projectDir();
    const r = scaffoldAgents(d, ['pm', 'qa']);
    expect(r.written.length).toBe(2);
    const pm = readFileSync(join(d, '.claude/agents/pm.md'), 'utf8');
    expect(pm).toContain('Project Manager');
    expect(pm).toContain('Read-only');
  });
  it('never overwrites an existing file', () => {
    const d = projectDir();
    mkdirSync(join(d, '.claude/agents'), { recursive: true });
    writeFileSync(join(d, '.claude/agents/qa.md'), 'X');
    const r = scaffoldAgents(d, ['pm', 'qa']);
    expect(readFileSync(join(d, '.claude/agents/qa.md'), 'utf8')).toBe('X');
    expect(r.skipped).toEqual([join(d, '.claude/agents/qa.md')]);
  });
});
