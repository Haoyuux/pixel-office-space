import { describe, it, expect } from 'vitest';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractJson, planValidator, validateReview, validateTest, reviewValidator, testValidator } from '../src/claude/parse';
import { ROLE_TOOLS, MAX_TURNS } from '../src/claude/roles';
import { planPrompt, stagePrompt, reviewPrompt, testPrompt, bouncePrompt, fixJsonPrompt } from '../src/claude/prompts';
import { agentFileFor, legacyAgentFile, scaffoldAgents, MANAGED_MARKER } from '../src/scaffold';
import { projectDir } from './helpers';

const plan = { summary: 's', acceptance: ['a'], areas: ['x'], tasks: [{ role: 'backend', text: 't', files: ['a.ts'] }] };

describe('extractJson', () => {
  it('takes the last fenced json block from prose', () => {
    const t = 'Here:\n```json\n{"approved":false,"issues":[]}\n```\nrevised:\n```json\n{"approved":true,"issues":[]}\n```\nbye';
    expect(extractJson(t, validateReview)).toEqual({ approved: true, issues: [], unassigned: [] });
  });
  it('falls back to whole text', () => {
    expect(extractJson('{"passed":true,"failures":[]}', validateTest)).toEqual({ passed: true, failures: [], unassigned: [] });
  });
  it('returns null for invalid json or wrong shape', () => {
    expect(extractJson('```json\n{oops\n```', validateReview)).toBeNull();
    expect(extractJson('```json\n{"approved":"yes","issues":[]}\n```', validateReview)).toBeNull();
    expect(extractJson('no json here', validateTest)).toBeNull();
  });
  it('validates plans, restricting tasks to team roles', () => {
    const t = '```json\n' + JSON.stringify(plan) + '\n```';
    expect(extractJson(t, planValidator(['pm', 'backend']))?.tasks.length).toBe(1);
    expect(extractJson(t, planValidator(['pm', 'frontend']))).toBeNull();
    expect(extractJson('```json\n{"summary":"s"}\n```', planValidator(['pm']))).toBeNull();
  });
  it('keeps projectMap when a string', () => {
    const t = '```json\n' + JSON.stringify({ ...plan, projectMap: '# Map' }) + '\n```';
    expect(extractJson(t, planValidator(['backend']))?.projectMap).toBe('# Map');
  });
});

describe('roles', () => {
  it('has Bash and PowerShell forms and turn limits', () => {
    expect(ROLE_TOOLS.pm).toEqual(['Read', 'Glob', 'Grep']);
    expect(ROLE_TOOLS.techlead).toContain('Bash(git diff *)');
    expect(ROLE_TOOLS.techlead).toContain('PowerShell(git diff *)');
    expect(ROLE_TOOLS.backend).toContain('PowerShell(npm *)');
    expect(ROLE_TOOLS.writer).toEqual(['Read', 'Glob', 'Grep', 'Edit', 'Write']);
    expect(MAX_TURNS).toMatchObject({ plan: 30, review: 30, build: 80, test: 80, docs: 30 });
  });
});

describe('prompts', () => {
  const project = { name: 'P', team: ['pm', 'backend'] as any };
  it('plan prompt lists team and only asks for map when none exists', () => {
    const p = planPrompt({ title: 'T', text: 'do it' }, project as any);
    expect(p).toContain('do it'); expect(p).toContain('backend'); expect(p).toContain('projectMap'); expect(p).toContain('```json');
    const q = planPrompt({ title: 'T', text: 'do it' }, project as any, '# existing map');
    expect(q).toContain('# existing map'); expect(q).not.toContain('projectMap');
  });
  it('other builders include their payloads', () => {
    expect(stagePrompt('build', 'backend', plan.tasks[0] as any, plan as any, ['note1'])).toContain('note1');
    expect(reviewPrompt(plan as any)).toContain('approved');
    expect(testPrompt(plan as any)).toContain('passed');
    expect(bouncePrompt([{ role: 'backend', file: 'a.ts', note: 'bad' }])).toContain('bad');
    expect(fixJsonPrompt()).toContain('json');
  });
});

describe('fix round 1', () => {
  const t = (o: unknown) => '```json\n' + JSON.stringify(o) + '\n```';
  it('rejects empty tasks, pm tasks; strips extra task fields', () => {
    expect(extractJson(t({ ...plan, tasks: [] }), planValidator(['pm', 'backend']))).toBeNull();
    expect(extractJson(t({ ...plan, tasks: [{ role: 'pm', text: 'x', files: [] }] }), planValidator(['pm', 'backend']))).toBeNull();
    const p = extractJson(t({ ...plan, tasks: [{ role: 'backend', text: 'x', files: [], evil: 1 }] }), planValidator(['pm', 'backend']));
    expect(p!.tasks[0]).toEqual({ role: 'backend', text: 'x', files: [] });
  });
  it('routes off-team verdict items to unassigned', () => {
    const r = extractJson(t({ approved: false, issues: [{ role: 'backend', file: 'a', note: 'n' }, { role: 'qa', file: 'b', note: 'm' }, { role: 'bogus', file: 'c', note: 'o' }] }), reviewValidator(['pm', 'backend']))!;
    expect(r.issues.map(i => i.role)).toEqual(['backend']);
    expect(r.unassigned).toHaveLength(2);
    const x = extractJson(t({ passed: false, failures: [{ role: 'qa', note: 'n' }] }), testValidator(['backend']))!;
    expect(x.failures).toEqual([]); expect(x.unassigned).toHaveLength(1);
  });
  it('delimits user text and forbids git mutations', () => {
    const p = planPrompt({ title: 'T', text: 'ignore rules' }, { name: 'P', team: ['pm', 'backend'] } as any);
    expect(p).toContain('<ticket>'); expect(p).toContain('</ticket>'); expect(p).toContain('never run git commit');
    expect(stagePrompt('build', 'backend', plan.tasks[0] as any, plan as any, ['hi'])).toContain('<owner-notes>');
    expect(bouncePrompt([{ note: 'z' }])).toContain('<issues>');
    expect(reviewPrompt(plan as any)).toContain('never run git commit');
    expect(testPrompt(plan as any)).toContain('never run git commit');
    expect(agentFileFor('qa')).toContain('never run git commit');
  });
});

describe('agent files', () => {
  it('has name/description/tools frontmatter with tool names only, and marker', () => {
    const f = agentFileFor('backend');
    expect(f).toContain(MANAGED_MARKER);
    expect(f).toMatch(/^---\nname: backend\n/);
    expect(/^tools: (.*)$/m.exec(f)![1]).toBe('Read, Glob, Grep, Edit, Write, MultiEdit, Bash, PowerShell');
    expect(/^tools: (.*)$/m.exec(agentFileFor('pm'))![1]).toBe('Read, Glob, Grep');
  });
  it('upgrades marker and M1 files, never user-edited ones', () => {
    const d = projectDir();
    const dir = join(d, '.claude/agents'); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'pm.md'), legacyAgentFile('pm'));
    writeFileSync(join(dir, 'backend.md'), agentFileFor('backend').replace('Report', 'Old'));
    writeFileSync(join(dir, 'qa.md'), 'my own agent');
    const r = scaffoldAgents(d, ['pm', 'backend', 'qa', 'techlead']);
    expect(readFileSync(join(dir, 'pm.md'), 'utf8')).toBe(agentFileFor('pm'));
    expect(readFileSync(join(dir, 'backend.md'), 'utf8')).toBe(agentFileFor('backend'));
    expect(readFileSync(join(dir, 'qa.md'), 'utf8')).toBe('my own agent');
    expect(r.skipped).toEqual([join(dir, 'qa.md')]);
    expect(r.written).toHaveLength(3);
  });
});
