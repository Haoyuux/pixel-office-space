import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boot } from './boot';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const dataDir = process.env.OFFICE_DATA ?? join(root, 'server', 'data');
const port = Number(process.env.OFFICE_PORT ?? 5175);
const stageMs = process.env.OFFICE_STAGE_MS ? (process.env.OFFICE_STAGE_MS.split(',').map(Number) as [number, number]) : undefined;

const { office } = boot({ dataDir, stageMs, assetsDir: join(root, 'assets') });

office.server.listen(port, '127.0.0.1', () => console.log(`Pixel Office server on http://127.0.0.1:${port}`));
