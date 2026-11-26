import type { RoleId, Accent } from './types';

export interface RoleDef {
  id: RoleId;
  label: string;
  emoji: string;
  required: boolean;
  defaultOn: boolean;
  deskRow: 0 | 1 | 'pm';
  deskCol: 0 | 1 | 2 | 3;
  tools: string;
}

export const ROLES: readonly RoleDef[] = [
  { id: 'pm', label: 'Project Manager', emoji: '🧑‍💼', required: true, defaultOn: true, deskRow: 'pm', deskCol: 0,
    tools: 'Read-only: may read any file in the project and write only the ticket plan. Never edits code or runs commands.' },
  { id: 'techlead', label: 'Tech Lead', emoji: '🧭', required: false, defaultOn: true, deskRow: 0, deskCol: 0,
    tools: 'Reads files and runs read-only git commands (git diff, git log) to review changes. Never edits code.' },
  { id: 'frontend', label: 'Frontend Dev', emoji: '💻', required: false, defaultOn: true, deskRow: 0, deskCol: 1,
    tools: 'Reads and edits frontend files and runs install/build commands.' },
  { id: 'backend', label: 'Backend Dev', emoji: '⚙️', required: false, defaultOn: true, deskRow: 0, deskCol: 2,
    tools: 'Reads and edits backend files and runs install/build commands.' },
  { id: 'qa', label: 'QA Engineer', emoji: '🧪', required: false, defaultOn: true, deskRow: 0, deskCol: 3,
    tools: 'Reads files, writes test files only, and runs the test suite.' },
  { id: 'uiux', label: 'UI/UX Designer', emoji: '🎨', required: false, defaultOn: false, deskRow: 1, deskCol: 0,
    tools: 'Reads files and writes design notes only.' },
  { id: 'devops', label: 'DevOps', emoji: '🚀', required: false, defaultOn: false, deskRow: 1, deskCol: 1,
    tools: 'Reads files, edits infrastructure/config files, and runs build/deploy commands.' },
  { id: 'security', label: 'Security Reviewer', emoji: '🛡️', required: false, defaultOn: false, deskRow: 1, deskCol: 2,
    tools: 'Read-only: reviews code for vulnerabilities. Never edits code or runs commands.' },
  { id: 'writer', label: 'Tech Writer', emoji: '📝', required: false, defaultOn: false, deskRow: 1, deskCol: 3,
    tools: 'Reads files and edits documentation files only.' },
];

export const ROLE_IDS: RoleId[] = ROLES.map(r => r.id);
export const DEFAULT_TEAM: RoleId[] = ROLES.filter(r => r.defaultOn).map(r => r.id);
export const roleDef = (id: RoleId): RoleDef => ROLES.find(r => r.id === id)!;

export const ACCENT_HEX: Record<Accent, number> = {
  cyan: 0x3df0ff, magenta: 0xff4fb8, amber: 0xffb35c, lime: 0x9dff5c, violet: 0xb48cff,
};
export const ACCENTS = Object.keys(ACCENT_HEX) as Accent[];

export const CHARACTERS = ['Clara', 'Hugo', 'Jade', 'Leo', 'Lia', 'Maya', 'Nina', 'Otto', 'Rosa', 'Sam', 'Theo', 'Victor'] as const;
