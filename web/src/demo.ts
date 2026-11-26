import { ACCENTS, CHARACTERS, ROLE_IDS, type Look, type Project, type RoleId } from '@office/shared';

const NAMES = ['Shop', 'Atlas', 'Pulse', 'Nova', 'Ledger', 'Orbit', 'Quill', 'Harbor', 'Kite', 'Mosaic'];
const TEAMS: RoleId[][] = [
  ['pm', 'techlead', 'frontend', 'backend', 'qa'],
  ['pm', 'techlead', 'frontend', 'backend', 'qa', 'uiux', 'devops', 'security', 'writer'],
  ['pm', 'frontend', 'backend'],
  ['pm', 'techlead', 'backend', 'qa', 'devops'],
  ['pm', 'techlead', 'frontend', 'qa', 'uiux', 'writer'],
  ['pm', 'backend', 'security'],
  ['pm', 'techlead', 'frontend', 'backend', 'qa', 'devops'],
];

/** `?demo=N`: N fake projects in slots 0..N-1 with varied teams, accents and looks. */
export function demoProjects(n: number): Project[] {
  return Array.from({ length: n }, (_, i) => {
    const looks = {} as Record<RoleId, Look>;
    ROLE_IDS.forEach((r, j) => { looks[r] = { character: CHARACTERS[(i * 5 + j) % CHARACTERS.length], palette: (['a', 'b', 'c'] as const)[(i + j) % 3] }; });
    return {
      id: `demo-${i}`, name: NAMES[i % NAMES.length], folder: '.', accent: ACCENTS[i % ACCENTS.length],
      team: TEAMS[i % TEAMS.length], slot: i, looks, createdAt: new Date(0).toISOString(),
    };
  });
}

export function demoCount(search = location.search): number | null {
  const v = new URLSearchParams(search).get('demo');
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(20, Math.floor(n))) : null;
}
