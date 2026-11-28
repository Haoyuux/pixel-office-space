// Fake `claude` binary for runner tests. Usage: node fake-claude.mjs <mode> [arg] -- <real claude args...>
// (the runner appends the real CLI args after the CLAUDE_BIN_ARGS prefix).
import fs from 'node:fs';
import { spawn } from 'node:child_process';

const [mode, arg] = process.argv.slice(2);
const out = o => process.stdout.write(JSON.stringify(o) + '\n');
const result = (text, extra = {}) => out({
  type: 'result', subtype: 'success', is_error: false, result: text, num_turns: 1,
  total_cost_usd: 0.01, session_id: 'fake-session', duration_ms: 5, ...extra,
});

switch (mode) {
  case 'fixture': {
    process.stdout.write(fs.readFileSync(arg, 'utf8'));
    break;
  }
  case 'hang': {
    // A grandchild that writes a heartbeat until killed, then hang forever ourselves.
    const hb = `setInterval(() => require('fs').writeFileSync(${JSON.stringify(arg)}, String(Date.now())), 50)`;
    // On Windows libuv puts node's children in a kill-on-close job object, so a plain child would die with us anyway
    // and the test would prove nothing. Detached escapes the job (like children of a non-node CLI would) while
    // staying in our parent-pid tree for `taskkill /T`. On POSIX it must stay in our process group.
    const gc = spawn(process.execPath, ['-e', hb], { stdio: 'ignore', detached: process.platform === 'win32' });
    gc.unref();
    fs.writeFileSync(`${arg}.pid`, String(gc.pid)); // so tests can clean up a survivor
    out({ type: 'system', subtype: 'init', session_id: 'fake-session', model: 'fake-model', tools: [] });
    setInterval(() => {}, 1 << 30);
    break;
  }
  case 'orphan': {
    // Like an agent that started a preview server in the background: a grandchild inherits our stdout/stderr and
    // outlives us, so the pipes stay open after we print the result and exit.
    const gc = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 15000)'], {
      stdio: ['ignore', 'inherit', 'inherit'], detached: process.platform === 'win32',
    });
    gc.unref();
    fs.writeFileSync(`${arg}.pid`, String(gc.pid));
    out({ type: 'system', subtype: 'init', session_id: 'fake-session', model: 'fake-model', tools: [] });
    result('done');
    process.exit(0);
    break;
  }
  case 'garbage': {
    process.stdout.write('this is not json\n');
    result('ok');
    break;
  }
  case 'fail': {
    process.stderr.write('starting\n'.repeat(3));
    process.stderr.write('boom: something broke\n');
    process.exit(3);
    break;
  }
  case 'introspect': {
    const env = {};
    for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']) env[k] = k in process.env;
    env.PATH = Object.keys(process.env).some(k => k.toUpperCase() === 'PATH');
    const prompt = fs.readFileSync(0, 'utf8'); // like `claude -p` with no prompt arg: the prompt is stdin
    result(JSON.stringify({ args: process.argv.slice(3), env, cwd: process.cwd(), prompt }));
    break;
  }
  case 'auth-error': {
    // Shape of the CLI's failure when login/credentials are bad: an error result line, then a non-zero exit.
    result('Invalid API key · Please run /login', { is_error: true, num_turns: 0, total_cost_usd: 0 });
    process.exitCode = 1;
    break;
  }
  default:
    process.stderr.write(`unknown mode ${mode}\n`);
    process.exit(2);
}
