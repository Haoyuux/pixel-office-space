import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const tmp = (prefix = 'office-') => mkdtempSync(join(tmpdir(), prefix));
export const projectDir = (name = 'proj') => { const d = join(tmp(), name); mkdirSync(d, { recursive: true }); return d; };
