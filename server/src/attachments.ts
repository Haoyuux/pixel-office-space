import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Attachment } from '@office/shared';
import { NotFoundError, ValidationError } from './errors';

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const IMAGE = /\.(png|jpe?g|gif|webp|bmp|ico|svg)$/i;
const PDF = /\.pdf$/i;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NAME_MAX = 80;

/** Where a project's uploads live: outside every repo and the owner's folders (agents get it via --add-dir). */
export const attachmentsDir = (dataDir: string, projectId: string) => path.join(dataDir, 'attachments', projectId);

/** File name safe on every OS: base name only, no path/reserved characters, no leading dots, ≤ 80 chars. */
export function safeName(raw: string): string {
  const base = raw.replace(/\\/g, '/').split('/').pop() ?? '';
  let s = base.replace(/[\u0000-\u001f<>:"/\\|?*]+/g, '_').replace(/\s+/g, ' ').trim().replace(/^\.+/, '').replace(/[. ]+$/, '');
  if (s.length > NAME_MAX) {
    const ext = path.extname(s).slice(0, 12);
    s = s.slice(0, NAME_MAX - ext.length) + ext;
  }
  return s || 'file';
}

/** Images and PDFs by extension; anything else must look like text (valid UTF-8, no NUL bytes). */
function allowed(name: string, data: Buffer): boolean {
  if (IMAGE.test(name)) return true;
  if (PDF.test(name)) return data.subarray(0, 5).toString('latin1') === '%PDF-';
  if (data.includes(0)) return false;
  try { new TextDecoder('utf-8', { fatal: true }).decode(data); return true; } catch { return false; }
}

const B64 = /^[A-Za-z0-9+/]*={0,2}$/;

export class AttachmentStore {
  constructor(private dataDir: string) {}

  dir(projectId: string) { return attachmentsDir(this.dataDir, projectId); }

  /** JSON upload `{ name, dataBase64 }` (≤ 10 MB decoded; images, text, PDF) → saved as `<id>-<safe name>`. */
  save(projectId: string, body: unknown): Attachment {
    const b = (body ?? {}) as { name?: unknown; dataBase64?: unknown };
    if (typeof b.name !== 'string' || !b.name.trim()) throw new ValidationError('name is required');
    if (typeof b.dataBase64 !== 'string') throw new ValidationError('dataBase64 is required');
    // tolerate a data: URL prefix and line breaks (FileReader.readAsDataURL / wrapped base64)
    const b64 = b.dataBase64.replace(/^data:[^,]*;base64,/, '').replace(/\s+/g, '');
    if (!B64.test(b64) || b64.length % 4 === 1) throw new ValidationError('dataBase64 is not valid base64');
    if (Math.floor(b64.length * 3 / 4) > MAX_ATTACHMENT_BYTES + 3) throw new ValidationError('Attachments are limited to 10 MB');
    const data = Buffer.from(b64, 'base64');
    if (data.length > MAX_ATTACHMENT_BYTES) throw new ValidationError('Attachments are limited to 10 MB');
    if (!data.length) throw new ValidationError('The file is empty');
    const name = safeName(b.name);
    if (!allowed(name, data)) throw new ValidationError('Only images, text files and PDFs can be attached');
    const id = randomUUID();
    const dir = this.dir(projectId);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${id}-${name}`);
    fs.writeFileSync(file, data);
    return { id, name, path: file };
  }

  /** Attachment ids from a request body (missing = none) → the saved files of this project; unknown → 404. */
  resolve(projectId: string, raw: unknown): Attachment[] {
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw) || !raw.every(x => typeof x === 'string')) throw new ValidationError('attachments must be a list of attachment ids');
    if (raw.length > 20) throw new ValidationError('At most 20 attachments per message');
    const dir = this.dir(projectId);
    let files: string[] = [];
    try { files = fs.readdirSync(dir); } catch { /* none uploaded yet */ }
    return [...new Set(raw as string[])].map(id => {
      const f = ID.test(id) ? files.find(n => n.startsWith(`${id}-`)) : undefined;
      if (!f) throw new NotFoundError(`Attachment not found: ${id}`);
      return { id, name: f.slice(id.length + 1), path: path.join(dir, f) };
    });
  }

  /** Project removed: its uploads go too (best effort). */
  removeProject(projectId: string): void {
    try { fs.rmSync(this.dir(projectId), { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

/** The prompt lines that point an agent at attached files. */
export function attachmentsNote(list: Attachment[] | undefined): string {
  if (!list?.length) return '';
  return `Attached files — read them with the Read tool:\n${list.map(a => `- ${a.path}`).join('\n')}`;
}
