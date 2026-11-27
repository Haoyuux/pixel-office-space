import { describe, it, expect } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ProjectStore, ValidationError } from '../src/store';
import { tmp, projectDir } from './helpers';

const newStore = () => new ProjectStore(join(tmp(), 'projects.json'));
const input = (over: Record<string, unknown> = {}) => ({ name: 'Shop', folder: projectDir(), accent: 'cyan' as const, team: ['pm', 'qa'] as any, ...over });

describe('ProjectStore', () => {
  it('assigns slots in order; a removal closes the gap (later rooms move up), new projects go last', () => {
    const s = newStore();
    const a = s.add(input()), b = s.add(input()), c = s.add(input()), d = s.add(input());
    expect([a.slot, b.slot, c.slot, d.slot]).toEqual([0, 1, 2, 3]);
    const moved = s.remove(b.id);
    expect(moved.map(p => p.id)).toEqual([c.id, d.id]);
    expect([s.get(a.id)!.slot, s.get(c.id)!.slot, s.get(d.id)!.slot]).toEqual([0, 1, 2]);
    expect(s.remove(d.id)).toEqual([]);
    expect(s.add(input()).slot).toBe(2);
  });

  it('closes slot gaps of an office saved before compaction', () => {
    const file = join(tmp(), 'projects.json');
    const s = new ProjectStore(file);
    const a = s.add(input()), b = s.add(input()), c = s.add(input());
    writeFileSync(file, JSON.stringify({ projects: [{ ...a }, { ...c }] })); // b's slot 1 left empty
    const again = new ProjectStore(file);
    expect(again.list().map(p => [p.id, p.slot])).toEqual([[a.id, 0], [c.id, 1]]);
    expect(new ProjectStore(file).get(c.id)!.slot).toBe(1); // saved
    void b;
  });

  it('rejects a missing folder or a file', () => {
    const s = newStore();
    expect(() => s.add(input({ folder: join(tmp(), 'nope') }))).toThrow(ValidationError);
    const f = join(tmp(), 'file.txt'); writeFileSync(f, 'x');
    expect(() => s.add(input({ folder: f }))).toThrow(ValidationError);
  });

  it('accepts a folder path with spaces', () => {
    expect(newStore().add(input({ folder: projectDir('my project') })).name).toBe('Shop');
  });

  it('always includes pm and rejects unknown roles', () => {
    const s = newStore();
    expect(s.add(input({ team: ['qa'] })).team).toContain('pm');
    expect(() => s.add(input({ team: ['wizard'] }))).toThrow(ValidationError);
  });

  it('gives unique looks until all 36 are used', () => {
    const s = newStore();
    const all = ['pm', 'techlead', 'frontend', 'backend', 'qa', 'uiux', 'devops', 'security', 'writer'];
    const looks: string[] = [];
    for (let i = 0; i < 4; i++) { const p = s.add(input({ team: all })); for (const r of all) looks.push(`${p.looks[r as 'pm'].character}/${p.looks[r as 'pm'].palette}`); }
    expect(new Set(looks).size).toBe(36);
  });

  it('persists across instances', () => {
    const file = join(tmp(), 'projects.json');
    const a = new ProjectStore(file).add(input());
    expect(new ProjectStore(file).get(a.id)!.name).toBe('Shop');
  });

  it('update changes team and keeps pm', () => {
    const s = newStore(); const p = s.add(input());
    expect(s.update(p.id, { team: ['frontend'] }).team.sort()).toEqual(['frontend', 'pm']);
  });
});
