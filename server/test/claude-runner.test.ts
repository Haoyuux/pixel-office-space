import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ClaudeRunner, buildArgs, childEnv, parseLine, resolveClaudeBin, resolveClaudeBinArgs,
  type RunnerEvent, type RunOptions, type ResultLine,
} from '../src/claude/runner';
import { translate, toolSummary, newTranslateContext } from '../src/claude/translate';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(here, 'fixtures', 'claude');
const FAKE = path.join(here, 'fixtures', 'fake-claude.mjs');

function parseFixture(name: string) {
  const events: RunnerEvent[] = [];
  let result: ResultLine | undefined;
  for (const line of fs.readFileSync(path.join(FIX, name), 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const r = parseLine(line);
    events.push(...r.events);
    if (r.result) result = r.result;
  }
  return { events, typed: events.filter(e => e.kind !== 'raw'), result };
}

const fake = (mode: string, arg?: string, graceMs?: number) =>
  new ClaudeRunner({ bin: process.execPath, binArgs: arg ? [FAKE, mode, arg] : [FAKE, mode], killGraceMs: graceMs });
const opts = (o: Partial<RunOptions> = {}): RunOptions => ({
  cwd: os.tmpdir(), role: 'pm', prompt: 'hi', allowedTools: ['Read'], maxTurns: 2, onEvent: () => {}, ...o,
});
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
/** Kill a grandchild that survived (only matters when the test is already failing). */
const reap = (hb: string) => { try { process.kill(Number(fs.readFileSync(hb + '.pid', 'utf8'))); } catch { /* already dead */ } };

describe('fixture parsing', () => {
  it('PM text-only reply', () => {
    const { events, typed, result } = parseFixture('pm-text.jsonl');
    expect(typed).toEqual([
      { kind: 'init', sessionId: 'c6a6a415-a857-487e-89fb-5b86d79a8fb2', model: 'claude-opus-5-5' },
      { kind: 'text', text: 'Plan ready.' },
    ]);
    // every line also surfaces as raw
    expect(events.filter(e => e.kind === 'raw')).toHaveLength(6);
    expect(result).toEqual({
      sessionId: 'c6a6a415-a857-487e-89fb-5b86d79a8fb2', result: 'Plan ready.', isError: false,
      subtype: 'success', numTurns: 1, costUsd: 0.0182568, durationMs: 4230,
    });
  });

  it('dev Read + Edit', () => {
    const { typed, result } = parseFixture('dev-read-edit.jsonl');
    expect(typed.map(e => e.kind)).toEqual(['init', 'tool_use', 'tool_result', 'tool_use', 'tool_result', 'text']);
    expect(typed[1]).toEqual({ kind: 'tool_use', id: 'toolu_01AVGDUmbLWC3hu5C4TArGHM', name: 'Read', input: { file_path: 'C:\\work\\repo\\note.txt' } });
    expect(typed[2]).toEqual({ kind: 'tool_result', id: 'toolu_01AVGDUmbLWC3hu5C4TArGHM', isError: false, content: '1\thello\n2\t' });
    expect(typed[3]).toMatchObject({ kind: 'tool_use', name: 'Edit', input: { old_string: 'hello', new_string: 'hi' } });
    expect(typed[5]).toEqual({ kind: 'text', text: 'done' });
    expect(result).toMatchObject({ sessionId: '8b0a1d87-dee6-4493-90d2-5aba2ca6e6be', result: 'done', numTurns: 3, costUsd: 0.062638, durationMs: 13343 });
  });

  it('resumed run keeps the session id', () => {
    const { typed, result } = parseFixture('pm-resume.jsonl');
    expect(typed[0]).toMatchObject({ kind: 'init', sessionId: 'c6a6a415-a857-487e-89fb-5b86d79a8fb2' });
    expect(result).toMatchObject({ sessionId: 'c6a6a415-a857-487e-89fb-5b86d79a8fb2', result: 'I replied: Plan ready.' });
  });

  it('non-JSON line → raw only; tool_result with array content and is_error', () => {
    expect(parseLine('not json').events).toEqual([{ kind: 'raw', line: 'not json' }]);
    const line = JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }] } });
    expect(parseLine(line).events.filter(e => e.kind !== 'raw')).toEqual([{ kind: 'tool_result', id: 't1', isError: true, content: 'a\nb' }]);
  });
});

describe('env, args, binary', () => {
  it('childEnv strips the five auth/provider vars and keeps PATH', () => {
    const env = childEnv({
      PATH: '/bin', HOME: '/h', ANTHROPIC_API_KEY: 'k', ANTHROPIC_AUTH_TOKEN: 't', CLAUDE_CODE_USE_BEDROCK: '1',
      CLAUDE_CODE_USE_VERTEX: '1', claude_code_use_foundry: '1',
    });
    expect(env).toEqual({ PATH: '/bin', HOME: '/h', MSBUILDDISABLENODEREUSE: '1', UseSharedCompilation: 'false' });
  });

  it('childEnv disables lingering MSBuild/compiler servers (they lock worktree files on Windows)', () => {
    expect(childEnv({ MSBUILDDISABLENODEREUSE: '0', UseSharedCompilation: 'true' })).toEqual({ MSBUILDDISABLENODEREUSE: '1', UseSharedCompilation: 'false' });
  });

  it('builds args exactly, without and with resume', () => {
    const base = { cwd: '.', role: 'backend' as const, prompt: 'do it', allowedTools: ['Read', 'Bash(npm *)'], maxTurns: 80, onEvent: () => {} };
    expect(buildArgs(base)).toEqual([
      '-p', '--agent', 'backend', '--output-format', 'stream-json', '--verbose',
      '--permission-mode', 'dontAsk', '--max-turns', '80', '--allowedTools', 'Read', 'Bash(npm *)',
    ]);
    expect(buildArgs({ ...base, resume: 'sess-1' })).toEqual([
      '-p', '--agent', 'backend', '--output-format', 'stream-json', '--verbose',
      '--permission-mode', 'dontAsk', '--max-turns', '80', '--resume', 'sess-1', '--allowedTools', 'Read', 'Bash(npm *)',
    ]);
    expect(buildArgs({ ...base, allowedTools: ['Read', 'Edit'] })).toContain('acceptEdits');
    expect(buildArgs(base)).not.toContain('--bare');
    expect(buildArgs(base)).not.toContain('do it'); // the prompt goes via stdin
  });

  it('resolves the binary: CLAUDE_BIN → ~/.local/bin/claude(.exe) → claude', () => {
    expect(resolveClaudeBin({ CLAUDE_BIN: 'X:/c.exe', USERPROFILE: 'U', HOME: 'U' }, () => true)).toBe('X:/c.exe');
    const local = path.join('U', '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude');
    expect(resolveClaudeBin({ USERPROFILE: 'U', HOME: 'U' }, p => p === local)).toBe(local);
    expect(resolveClaudeBin({ USERPROFILE: 'U', HOME: 'U' }, () => false)).toBe('claude');
    expect(resolveClaudeBinArgs({ CLAUDE_BIN_ARGS: '["a.mjs","x"]' })).toEqual(['a.mjs', 'x']);
    expect(resolveClaudeBinArgs({})).toEqual([]);
    expect(() => resolveClaudeBinArgs({ CLAUDE_BIN_ARGS: '{"a":1}' })).toThrow(/CLAUDE_BIN_ARGS/);
  });
});

describe('ClaudeRunner with a fake binary', () => {
  const afterReap: string[] = [];
  afterEach(() => { afterReap.splice(0).forEach(reap); });

  it('runs a recorded fixture end to end', async () => {
    const got: RunnerEvent[] = [];
    const r = await fake('fixture', path.join(FIX, 'dev-read-edit.jsonl')).run(opts({ onEvent: e => got.push(e) }));
    expect(r).toMatchObject({ sessionId: '8b0a1d87-dee6-4493-90d2-5aba2ca6e6be', result: 'done', isError: false, exitCode: 0 });
    expect(got.filter(e => e.kind === 'tool_use')).toHaveLength(2);
  });

  it('uses CLAUDE_BIN / CLAUDE_BIN_ARGS from the env, passes args, strips the API key', async () => {
    const saved = { ...process.env };
    try {
      process.env.CLAUDE_BIN = process.execPath;
      process.env.CLAUDE_BIN_ARGS = JSON.stringify([FAKE, 'introspect']);
      process.env.ANTHROPIC_API_KEY = 'sk-should-not-leak';
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-'));
      const r = await new ClaudeRunner().run(opts({ cwd, resume: 's9', allowedTools: ['Read', 'Glob'] }));
      const info = JSON.parse(r.result);
      expect(info.args).toEqual(buildArgs(opts({ resume: 's9', allowedTools: ['Read', 'Glob'] })));
      expect(info.prompt).toBe('hi');
      expect(info.env.ANTHROPIC_API_KEY).toBe(false);
      expect(info.env.PATH).toBe(true);
      expect(fs.realpathSync(info.cwd)).toBe(fs.realpathSync(cwd));
    } finally {
      for (const k of ['CLAUDE_BIN', 'CLAUDE_BIN_ARGS', 'ANTHROPIC_API_KEY']) delete process.env[k];
      Object.assign(process.env, saved);
    }
  });

  it('sends the prompt via stdin: huge, multi-line, quotes, leading dash', async () => {
    const prompt = '-starts with a dash\nline "two" with quotes & %PATH% \\ back — ünïcode\n' + 'x'.repeat(100_000);
    const r = await fake('introspect').run(opts({ prompt }));
    const info = JSON.parse(r.result);
    expect(info.prompt).toBe(prompt);
    expect(info.args).not.toContain(prompt);
  });

  it('an error result (e.g. auth) resolves with isError and the exit code; callers must check', async () => {
    const r = await fake('auth-error').run(opts());
    expect(r).toMatchObject({ isError: true, subtype: 'success', result: 'Invalid API key · Please run /login', exitCode: 1 });
  });

  it('non-JSON stdout line → raw event, run still resolves', async () => {
    const got: RunnerEvent[] = [];
    const r = await fake('garbage').run(opts({ onEvent: e => got.push(e) }));
    expect(got).toContainEqual({ kind: 'raw', line: 'this is not json' });
    expect(r.result).toBe('ok');
  });

  it('non-zero exit without a result → rejects with the stderr tail', async () => {
    await expect(fake('fail').run(opts())).rejects.toThrow(/code 3[\s\S]*boom: something broke/);
  });

  it('abort kills the process tree within 6 s and rejects with AbortError', async () => {
    const hb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hb-')), 'beat');
    afterReap.push(hb);
    const ac = new AbortController();
    let init = false;
    const p = fake('hang', hb).run(opts({ signal: ac.signal, onEvent: e => { if (e.kind === 'init') init = true; } }));
    p.catch(() => {});
    for (let i = 0; i < 100 && !(init && fs.existsSync(hb)); i++) await sleep(50);
    expect(init && fs.existsSync(hb)).toBe(true);
    const t0 = Date.now();
    ac.abort();
    const err = await p.then(() => null, e => e);
    expect(Date.now() - t0).toBeLessThan(6000);
    expect(err?.name).toBe('AbortError');
    await sleep(300);
    const b1 = fs.readFileSync(hb, 'utf8');
    await sleep(500);
    expect(fs.readFileSync(hb, 'utf8')).toBe(b1); // grandchild is dead
  }, 15000);

  it('already-aborted signal rejects without spawning', async () => {
    const ac = new AbortController(); ac.abort();
    await expect(fake('hang', 'nowhere').run(opts({ signal: ac.signal }))).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('timeout kills the run and rejects', async () => {
    const hb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hb-')), 'beat');
    afterReap.push(hb);
    const t0 = Date.now();
    const err = await fake('hang', hb, 200).run(opts({ timeoutMs: 1500 })).then(() => null, e => e);
    expect(err?.name).toBe('TimeoutError');
    expect(Date.now() - t0).toBeLessThan(5000);
    await sleep(300);
    const b1 = fs.existsSync(hb) ? fs.readFileSync(hb, 'utf8') : '';
    await sleep(500);
    expect(fs.existsSync(hb) ? fs.readFileSync(hb, 'utf8') : '').toBe(b1);
  }, 15000);

  it('missing binary rejects clearly', async () => {
    const r = new ClaudeRunner({ bin: path.join(os.tmpdir(), 'no-such-claude-bin.exe'), binArgs: [] });
    await expect(r.run(opts())).rejects.toThrow(/claude/i);
  });
});

describe('translate', () => {
  it('toolSummary', () => {
    expect(toolSummary('Edit', { file_path: 'C:\\work\\repo\\src\\a.ts' }, 'C:\\work\\repo')).toBe('Edit src/a.ts');
    expect(toolSummary('Edit', { file_path: 'src/a.ts' })).toBe('Edit src/a.ts');
    expect(toolSummary('Read', { file_path: '/w/r/README.md' }, '/w/r/')).toBe('Read README.md');
    expect(toolSummary('Bash', { command: 'npm test' })).toBe('Bash npm test');
    expect(toolSummary('PowerShell', { command: 'npm test\nmore' })).toBe('PowerShell npm test');
    expect(toolSummary('Grep', { pattern: 'foo' })).toBe('Grep foo');
    expect(toolSummary('Glob', { pattern: '**/*.ts' })).toBe('Glob **/*.ts');
    expect(toolSummary('Mystery', {})).toBe('Mystery');
    expect(toolSummary('Bash', { command: 'x'.repeat(300) }).length).toBeLessThanOrEqual(100);
  });

  it('text → agent.message, everything raw → log.raw', () => {
    const [m] = translate('pm', { kind: 'text', text: 'hello' }, newTranslateContext());
    expect(m).toMatchObject({ type: 'agent.message', role: 'pm', text: 'hello', streaming: false });
    expect(typeof (m as any).messageId).toBe('string');
    expect(translate('pm', { kind: 'raw', line: '{"a":1}' }, newTranslateContext())).toEqual([{ type: 'log.raw', role: 'pm', line: '{"a":1}' }]);
    expect(translate('pm', { kind: 'init', sessionId: 's', model: 'm' }, newTranslateContext())).toEqual([]);
    for (const e of [...translate('pm', { kind: 'text', text: 'x' }, newTranslateContext()), ...translate('pm', { kind: 'raw', line: 'x' }, newTranslateContext())]) {
      expect(e).not.toHaveProperty('projectId'); expect(e).not.toHaveProperty('seq'); expect(e).not.toHaveProperty('ts');
    }
  });

  it('tool_use → running, tool_result → ok/error with the same toolId and summary', () => {
    const ctx = newTranslateContext('C:\\work\\repo');
    const [run] = translate('backend', { kind: 'tool_use', id: 't1', name: 'Edit', input: { file_path: 'C:\\work\\repo\\src\\a.ts' } }, ctx);
    expect(run).toMatchObject({ type: 'agent.tool', role: 'backend', tool: 'Edit', summary: 'Edit src/a.ts', status: 'running', toolId: 't1' });
    const [ok] = translate('backend', { kind: 'tool_result', id: 't1', isError: false, content: 'fine' }, ctx);
    expect(ok).toMatchObject({ type: 'agent.tool', tool: 'Edit', summary: 'Edit src/a.ts', status: 'ok', toolId: 't1' });
    translate('backend', { kind: 'tool_use', id: 't2', name: 'Bash', input: { command: 'npm test' } }, ctx);
    const [bad] = translate('backend', { kind: 'tool_result', id: 't2', isError: true, content: 'exit 1' }, ctx);
    expect(bad).toMatchObject({ tool: 'Bash', summary: 'Bash npm test', status: 'error', toolId: 't2', detail: 'exit 1' });
  });

  it('translates the dev fixture into the expected feed', () => {
    const ctx = newTranslateContext('C:\\work\\repo');
    const out = parseFixture('dev-read-edit.jsonl').typed.flatMap(e => translate('backend', e, ctx));
    expect(out.map((e: any) => [e.type, e.summary ?? e.text, e.status])).toEqual([
      ['agent.tool', 'Read note.txt', 'running'],
      ['agent.tool', 'Read note.txt', 'ok'],
      ['agent.tool', 'Edit note.txt', 'running'],
      ['agent.tool', 'Edit note.txt', 'ok'],
      ['agent.message', 'done', undefined],
    ]);
  });
});
