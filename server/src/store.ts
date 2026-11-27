import { existsSync, readFileSync, renameSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ROLE_IDS, CHARACTERS, ACCENTS, type Accent, type AgentsMode, type Look, type Project, type RoleId } from '@office/shared';
import { ValidationError, NotFoundError } from './errors';

export { ValidationError, NotFoundError };

const PALETTES = ['a', 'b', 'c'] as const;
const ALL_LOOKS: Look[] = PALETTES.flatMap(palette => CHARACTERS.map(character => ({ character, palette })));

export interface ProjectInput { name: string; folder: string; accent: Accent; team: RoleId[]; agentsMode?: AgentsMode }
export interface ProjectPatch { name?: string; accent?: Accent; team?: RoleId[]; agentsMode?: AgentsMode }
export const AGENTS_MODES: AgentsMode[] = ['claude', 'simulated'];
const checkMode = (m: unknown): AgentsMode => {
  if (!AGENTS_MODES.includes(m as AgentsMode)) throw new ValidationError(`Unknown agents mode: ${String(m)}`);
  return m as AgentsMode;
};
/** Runs after validation and before anything is persisted; throwing aborts the change. */
export type BeforeSave = (p: Project) => void;

/** Owner-typed folder: trims, strips surrounding quotes (Windows "Copy as path"), must be absolute; returned resolved. */
export function normalizeFolder(raw: unknown): string {
  if (typeof raw !== 'string') throw new ValidationError('Folder is required');
  let f = raw.trim();
  const m = /^(["'])(.*)\1$/.exec(f);
  if (m) f = m[2].trim();
  if (!f) throw new ValidationError('Folder is required');
  if (!isAbsolute(f)) throw new ValidationError(`Folder must be an absolute path: ${f}`);
  return resolve(f);
}

const checkName = (n: unknown): string => {
  if (typeof n !== 'string' || !n.trim()) throw new ValidationError('Name is required');
  return n.trim();
};

export class ProjectStore {
  private projects: Project[] = [];
  constructor(private file: string) {
    if (existsSync(file)) this.projects = JSON.parse(readFileSync(file, 'utf8')).projects ?? [];
    // M1 projects predate agentsMode: they run real agents (the M2 default)
    for (const p of this.projects) p.agentsMode ??= 'claude';
  }

  list(): Project[] { return [...this.projects].sort((a, b) => a.slot - b.slot); }
  get(id: string): Project | undefined { return this.projects.find(p => p.id === id); }

  add(input: ProjectInput, beforeSave?: BeforeSave): Project {
    const name = checkName(input.name);
    const folder = normalizeFolder(input.folder);
    if (!existsSync(folder)) throw new ValidationError(`Folder not found: ${folder}`);
    if (!statSync(folder).isDirectory()) throw new ValidationError(`Not a folder: ${folder}`);
    const accent = this.checkAccent(input.accent);
    const team = this.checkTeam(input.team);
    const agentsMode = input.agentsMode === undefined ? 'claude' : checkMode(input.agentsMode);
    const used = new Set(this.projects.map(p => p.slot));
    let slot = 0; while (used.has(slot)) slot++;
    const looks = {} as Record<RoleId, Look>;
    const taken: Look[] = [];
    for (const r of ROLE_IDS) { looks[r] = this.nextLook(taken); taken.push(looks[r]); }
    const p: Project = { id: randomUUID(), name, folder, accent, team, slot, looks, createdAt: new Date().toISOString(), agentsMode };
    beforeSave?.(p);
    this.projects.push(p);
    this.save();
    return p;
  }

  /** Mutates the stored project in place (running tickets hold the same object and see the new team). */
  update(id: string, patch: ProjectPatch, beforeSave?: BeforeSave): Project {
    const p = this.get(id); if (!p) throw new NotFoundError(id);
    const next: Project = { ...p };
    if (patch.name !== undefined) next.name = checkName(patch.name);
    if (patch.accent !== undefined) next.accent = this.checkAccent(patch.accent);
    if (patch.team !== undefined) next.team = this.checkTeam(patch.team);
    if (patch.agentsMode !== undefined) next.agentsMode = checkMode(patch.agentsMode);
    beforeSave?.(next);
    Object.assign(p, next);
    for (const k of Object.keys(p) as (keyof Project)[]) if (!(k in next)) delete p[k];
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
    if (!Array.isArray(team)) throw new ValidationError('Team must be a list of roles');
    for (const r of team) if (!ROLE_IDS.includes(r)) throw new ValidationError(`Unknown role: ${r}`);
    return ROLE_IDS.filter(r => r === 'pm' || team.includes(r));
  }
  /** Least-used look across all projects plus `extra` (the looks already picked for the project being added). */
  private nextLook(extra: Look[] = []): Look {
    const counts = new Map<string, number>();
    const all = [...this.projects.flatMap(p => Object.values(p.looks)), ...extra];
    for (const l of all) { const k = `${l.character}/${l.palette}`; counts.set(k, (counts.get(k) ?? 0) + 1); }
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
