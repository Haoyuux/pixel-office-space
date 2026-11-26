import { existsSync, readFileSync, renameSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ROLE_IDS, CHARACTERS, ACCENTS, type Accent, type Look, type Project, type RoleId } from '@office/shared';

export class ValidationError extends Error {}
export class NotFoundError extends Error {}

const PALETTES = ['a', 'b', 'c'] as const;
const ALL_LOOKS: Look[] = PALETTES.flatMap(palette => CHARACTERS.map(character => ({ character, palette })));

export interface ProjectInput { name: string; folder: string; accent: Accent; team: RoleId[] }

export class ProjectStore {
  private projects: Project[] = [];
  constructor(private file: string) {
    if (existsSync(file)) this.projects = JSON.parse(readFileSync(file, 'utf8')).projects ?? [];
  }

  list(): Project[] { return [...this.projects].sort((a, b) => a.slot - b.slot); }
  get(id: string): Project | undefined { return this.projects.find(p => p.id === id); }

  add(input: ProjectInput): Project {
    const name = (input.name ?? '').trim();
    if (!name) throw new ValidationError('Name is required');
    if (!input.folder || !existsSync(input.folder)) throw new ValidationError(`Folder not found: ${input.folder}`);
    if (!statSync(input.folder).isDirectory()) throw new ValidationError(`Not a folder: ${input.folder}`);
    const accent = this.checkAccent(input.accent);
    const team = this.checkTeam(input.team);
    const used = new Set(this.projects.map(p => p.slot));
    let slot = 0; while (used.has(slot)) slot++;
    const p: Project = { id: randomUUID(), name, folder: input.folder, accent, team, slot, looks: {} as Record<RoleId, Look>, createdAt: new Date().toISOString() };
    this.projects.push(p);
    for (const r of ROLE_IDS) p.looks[r] = this.nextLook();
    this.save();
    return p;
  }

  update(id: string, patch: { name?: string; accent?: Accent; team?: RoleId[] }): Project {
    const p = this.get(id); if (!p) throw new NotFoundError(id);
    if (patch.name !== undefined) { if (!patch.name.trim()) throw new ValidationError('Name is required'); p.name = patch.name.trim(); }
    if (patch.accent !== undefined) p.accent = this.checkAccent(patch.accent);
    if (patch.team !== undefined) p.team = this.checkTeam(patch.team);
    this.save();
    return p;
  }

  remove(id: string): void {
    if (!this.get(id)) throw new NotFoundError(id);
    this.projects = this.projects.filter(p => p.id !== id);
    this.save();
  }

  private checkAccent(a: Accent): Accent {
    if (!ACCENTS.includes(a)) throw new ValidationError(`Unknown accent: ${a}`);
    return a;
  }
  private checkTeam(team: RoleId[] = []): RoleId[] {
    for (const r of team) if (!ROLE_IDS.includes(r)) throw new ValidationError(`Unknown role: ${r}`);
    return ROLE_IDS.filter(r => r === 'pm' || team.includes(r));
  }
  private nextLook(): Look {
    const counts = new Map<string, number>();
    for (const p of this.projects) for (const l of Object.values(p.looks)) { const k = `${l.character}/${l.palette}`; counts.set(k, (counts.get(k) ?? 0) + 1); }
    let best = ALL_LOOKS[0], bestN = Infinity;
    for (const l of ALL_LOOKS) { const n = counts.get(`${l.character}/${l.palette}`) ?? 0; if (n < bestN) { best = l; bestN = n; } }
    return { ...best };
  }
  private save() {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file + '.tmp', JSON.stringify({ projects: this.projects }, null, 2));
    renameSync(this.file + '.tmp', this.file);
  }
}
