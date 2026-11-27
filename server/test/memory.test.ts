import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { MEMORY_MAX_ENTRIES } from '@office/shared';
import { MemoryStore } from '../src/memory';
import { NotFoundError, ValidationError } from '../src/errors';
import { tmp } from './helpers';

const fresh = () => { const dataDir = tmp(); return { dataDir, m: new MemoryStore(dataDir) }; };

describe('MemoryStore', () => {
  it('starts empty; owner entries persist to <dataDir>/memory/<projectId>.json', () => {
    const { dataDir, m } = fresh();
    expect(m.list('p1')).toEqual([]);
    const e = m.add('p1', { text: '  Use   pnpm,\nnot npm  ' });
    expect(e).toMatchObject({ text: 'Use pnpm, not npm', source: 'owner' });
    expect(e.id).toBeTruthy();
    expect(Date.parse(e.at)).not.toBeNaN();
    const file = join(dataDir, 'memory', 'p1.json');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ entries: [e] });
    expect(new MemoryStore(dataDir).list('p1')).toEqual([e]);
    expect(m.list('p2')).toEqual([]);
  });

  it('validates text: required, a string, at most 300 chars; full store refused', () => {
    const { m } = fresh();
    expect(() => m.add('p1', {})).toThrow(ValidationError);
    expect(() => m.add('p1', { text: '   ' })).toThrow(ValidationError);
    expect(() => m.add('p1', { text: 5 })).toThrow(ValidationError);
    expect(() => m.add('p1', { text: 'x'.repeat(301) })).toThrow(ValidationError);
    expect(m.add('p1', { text: 'x'.repeat(300) }).text).toHaveLength(300);
    for (let i = 1; i < MEMORY_MAX_ENTRIES; i++) m.add('p1', { text: `fact ${i}` });
    expect(m.list('p1')).toHaveLength(MEMORY_MAX_ENTRIES);
    expect(() => m.add('p1', { text: 'one more' })).toThrow(ValidationError);
  });

  it('update and remove by entry id; unknown ids → NotFoundError', () => {
    const { m } = fresh();
    const a = m.add('p1', { text: 'A' }), b = m.add('p1', { text: 'B' });
    expect(m.update('p1', a.id, { text: 'A2' })).toMatchObject({ id: a.id, text: 'A2', source: 'owner' });
    expect(() => m.update('p1', 'nope', { text: 'x' })).toThrow(NotFoundError);
    expect(() => m.update('p1', a.id, { text: '' })).toThrow(ValidationError);
    m.remove('p1', b.id);
    expect(m.list('p1').map(e => e.text)).toEqual(['A2']);
    expect(() => m.remove('p1', b.id)).toThrow(NotFoundError);
  });

  it('learn: PM lessons appended (source pm, ticketId), de-duplicated case-insensitively', () => {
    const { m } = fresh();
    m.add('p1', { text: 'Tests run with vitest' });
    const added = m.learn('p1', ['tests run with VITEST', ' The API lives in server/ ', 'the api lives in server/', ''], 't1');
    expect(added.map(e => e.text)).toEqual(['The API lives in server/']);
    expect(added[0]).toMatchObject({ source: 'pm', ticketId: 't1' });
    expect(m.list('p1')).toHaveLength(2);
    expect(m.learn('p1', ['THE API LIVES IN SERVER/'], 't2')).toEqual([]);
  });

  it('learn when full: the oldest PM entries make room; owner entries are never evicted', () => {
    const { m } = fresh();
    m.learn('p1', ['old lesson'], 't0');
    for (let i = 1; i < MEMORY_MAX_ENTRIES; i++) m.add('p1', { text: `owner ${i}` });
    expect(m.learn('p1', ['new lesson'], 't1').map(e => e.text)).toEqual(['new lesson']);
    const texts = m.list('p1').map(e => e.text);
    expect(texts).toHaveLength(MEMORY_MAX_ENTRIES);
    expect(texts).not.toContain('old lesson');
    expect(texts.at(-1)).toBe('new lesson');
    // only owner entries are left besides the new one: once that is gone nothing more is learned
    m.remove('p1', m.list('p1').at(-1)!.id);
    m.add('p1', { text: 'owner 60' });
    expect(m.learn('p1', ['another'], 't2')).toEqual([]);
    expect(m.list('p1')).toHaveLength(MEMORY_MAX_ENTRIES);
  });

  it('onChange fires with the project id on every change (not on a no-op learn)', () => {
    const { m } = fresh();
    const seen: string[] = [];
    m.onChange(id => seen.push(id));
    const a = m.add('p1', { text: 'A' });
    m.update('p1', a.id, { text: 'B' });
    m.learn('p1', ['b'], 't1');
    m.learn('p2', ['lesson'], 't1');
    m.remove('p1', a.id);
    expect(seen).toEqual(['p1', 'p1', 'p2', 'p1']);
  });

  it('a corrupt or malformed file reads as empty; removeProject deletes the file; bad ids are refused', () => {
    const { dataDir, m } = fresh();
    mkdirSync(join(dataDir, 'memory'), { recursive: true });
    writeFileSync(join(dataDir, 'memory', 'p1.json'), '{oops');
    expect(m.list('p1')).toEqual([]);
    writeFileSync(join(dataDir, 'memory', 'p1.json'), JSON.stringify({ entries: [{ id: 'x', text: 'ok', source: 'owner', at: 'a' }, { nope: 1 }] }));
    expect(m.list('p1').map(e => e.text)).toEqual(['ok']);
    m.removeProject('p1');
    expect(existsSync(join(dataDir, 'memory', 'p1.json'))).toBe(false);
    expect(() => m.list('../x')).toThrow(NotFoundError);
  });
});
