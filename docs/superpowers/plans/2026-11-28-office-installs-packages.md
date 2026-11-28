# Office Installs Packages — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agents ask for packages in their reply; the office runs `npm install` in the owner's folder (declared → automatic, brand-new → owner OK via an `install` gate) and the round continues.

**Architecture:** A new `server/src/installer.ts` parses `INSTALL` lines from agent replies, classifies specs against the owner's `package.json`, and runs npm serialized per folder. `ClaudeOrchestrator.execNow` hands every non-PM reply to it; new packages queue on the run and open an `install` gate at the end of the stage. The web `GateCard` renders the new gate.

**Tech Stack:** TypeScript, Node child_process, vitest, React.

**Spec:** `docs/superpowers/specs/2026-11-28-office-installs-packages-addendum.md`

## Global Constraints

- Request syntax (one line each, anywhere in the reply): `INSTALL: all` · `INSTALL: <spec> <spec>…` · multi-repo: `INSTALL <repo>: …`. `all` = plain `npm install`.
- A spec must match `^(@[\w.-]+\/)?[\w.-]+(@[\w.^~<>=*|+-]+)?$`; anything else is rejected (never reaches a shell).
- Declared = the name is in the owner repo's `dependencies`, `devDependencies`, `optionalDependencies` or `peerDependencies`.
- Automatic install = `npm install` (no specs) in the owner repo folder. Approved new install = `npm install --no-save <specs>`.
- One npm process per folder at a time, including the Run tab's install.
- An install-triggered re-run of review/test does not increment `run.bounces` and happens at most once per stage between bounces.
- Only repo units with `sharedModules` are handled; for others the agent is told to install in its own worktree.

## Review Focus

- Agent writes `INSTALL:` with a malicious-looking spec (`x; rm -rf /`, `` `cmd` ``) → rejected with a note to the agent, nothing spawned. (Task 1 test)
- Agent quotes the syntax back in prose, e.g. "I will not write INSTALL: anything" mid-sentence → ignored; only lines that *start* with `INSTALL`. (Task 1 test)
- Two tickets of the same project request installs at once → second waits for the first, never parallel. (Task 1 test)
- npm fails (registry down) → tool block shows error, agent's next prompt carries the failure, ticket does not fail. (Task 3 test)
- Review keeps failing after an install → second failure bounces normally (no infinite re-run loop). (Task 3 test)

---

### Task 1: Installer module

**Files:**
- Create: `server/src/installer.ts`
- Test: `server/test/installer.test.ts`

**Interfaces:**
- Produces:
  - `interface InstallRequest { repo: string; specs: string[]; bad: string[] }` (`repo` '' when no repo named; `specs` [] = all)
  - `parseInstallRequests(text: string): InstallRequest[]`
  - `packageName(spec: string): string`
  - `undeclared(repoDir: string, specs: string[]): string[]`
  - `interface InstallResult { ok: boolean; command: string; output: string }` (output = last 4000 chars)
  - `class Installer { constructor(opts?: { exec?: (cwd: string, args: string[]) => Promise<{ code: number; output: string }>; timeoutMs?: number }); install(cwd: string, specs: string[], opts?: { noSave?: boolean }): Promise<InstallResult>; busy(cwd: string): boolean; waitFor(fn: (cwd: string) => boolean): void }`

- [ ] **Step 1: Write failing tests** in `server/test/installer.test.ts`:
  - `parseInstallRequests('done\nINSTALL: all')` → `[{ repo: '', specs: [], bad: [] }]`
  - `parseInstallRequests('INSTALL angular: motion@^12.23.0, @scope/x@1')` → `[{ repo: 'angular', specs: ['motion@^12.23.0', '@scope/x@1'], bad: [] }]`
  - `parseInstallRequests('INSTALL: x;rm -rf / ok')` → specs `['ok']`, bad `['x;rm', '-rf', '/']`
  - `parseInstallRequests('I will not write INSTALL: all here')` → `[]`
  - `packageName('@scope/x@1')` → `'@scope/x'`; `packageName('motion@^12')` → `'motion'`
  - `undeclared(dir, ['motion@^12', 'left'])` with package.json `{ dependencies: { motion: '^12' }, devDependencies: {} }` → `['left']`; missing package.json → all specs
  - Installer with fake exec: args `['install']` for `[]`, `['install', '--no-save', 'a@1']` for noSave; two concurrent `install(sameDir)` calls → second exec starts after first resolves; `busy(dir)` true during; different dirs run in parallel; `waitFor(() => true)` then flipping to false lets it start.
- [ ] **Step 2:** `npm test -w server -- installer` → FAIL (module missing).
- [ ] **Step 3:** Implement. Default exec: `spawn('npm', args, { cwd, shell: process.platform === 'win32', windowsHide: true })`, merged stdout+stderr, kill with `killTree` from `./claude/runner` on timeout (default 10 min, output gets `\n(timed out)`). Lock key: `path.resolve(cwd)`, lower-cased on win32; chain promises in a Map. `waitFor` predicate is polled every 500 ms before starting.
- [ ] **Step 4:** `npm test -w server -- installer` → PASS.
- [ ] **Step 5:** Commit `feat(server): installer for agent package requests`.

### Task 2: Gate types, rule text, Run-tab lock

**Files:**
- Modify: `shared/src/types.ts` (`GateKind` + `'install'`, `GateDecision` + `'skip'`)
- Modify: `server/src/app.ts:38` (`GATES` + `'install'`; `createOffice` opts gain `installer?: Installer`, passed to `new DevServers({ installer })`)
- Modify: `server/src/devserver.ts` (opts `installer?: Pick<Installer, 'busy'>`; `start(..., install=true)` throws `ConflictError('An install for a ticket is running in this folder — try again in a moment')` when busy; add `installing(cwd: string): boolean`)
- Modify: `server/src/claude/prompts.ts:212` (`SHARED_MODULES_RULE`)
- Test: `server/test/devserver.test.ts`

- [ ] **Step 1:** Test: DevServers with `installer: { busy: () => true }` → `start(p, undefined, true)` throws /install for a ticket/.
- [ ] **Step 2:** Run → FAIL. **Step 3:** implement. New rule text:
  `"node_modules is shared with the owner's checkout — never run npm install/ci/uninstall/update yourself. If packages are missing, put a line in your reply: `INSTALL: all` (install what package.json lists) or `INSTALL: name@version …` (new packages — also add them to package.json). In a multi-repo project name the repo: `INSTALL <repo>: …`. The office installs them in the owner's folder (new packages after the owner's OK) and tells you the result."`
- [ ] **Step 4:** `npm test -w server` → PASS (update the existing `/never run npm install/` assertion only if wording broke it — it should not).
- [ ] **Step 5:** Commit `feat: install gate kind and shared-modules rule`.

### Task 3: Orchestrator integration

**Files:**
- Modify: `server/src/orchestrator/claude.ts`, `server/src/boot.ts`
- Test: `server/test/claude-orchestrator.test.ts` (new `describe('package installs')`, single-repo repo with `node_modules/` dir + `.gitignore` + `package.json` `{ "dependencies": { "motion": "^12" } }` so `sharedModules` is set)

**Interfaces:**
- Consumes: Task 1 exports.
- Options: `ClaudeOrchestratorOptions.installer?: Pick<Installer, 'install'>` (default `new Installer()`). `make()` in tests gets `installer` in `extra`.
- Run gains: `pendingInstalls: { role: RoleId; repo: string; specs: string[] }[]`, `installed: boolean`, `installRerun: Partial<Record<BounceFrom, boolean>>`, `installFrom?: WorkStage`.
- `GATE_DECISIONS.install = ['approved', 'skip']`.

- [ ] **Step 1: Failing tests** (fake installer records `{cwd, specs, noSave}` and returns `{ ok, command, output }`):
  1. `auto install: declared package → npm install in owner repo, tool event, no gate` — frontend stage reply `'done\nINSTALL: motion@^12'` → installer called once with `cwd = repo, specs = []`; an `agent.tool` event with `tool: 'npm'` status `ok`; gates `['plan','final']`.
  2. `new package → install gate; approve installs --no-save and continues` — reply `INSTALL: left-pad@1` → gate `install` with payload `{ from: 'build', requests: [{ role: 'frontend', repo: '', specs: ['left-pad@1'] }] }`; `decide(t, 'install', 'approved')` → installer called with `noSave: true, specs: ['left-pad@1']`; then gate `final`.
  3. `skip → agent told on its next prompt, ticket continues` — decide `skip` → next frontend prompt (review bounce or later) contains `declined`; reaches `final`.
  4. `review failure after an install re-runs review once without a bounce` — techlead review #1 replies not-approved with `INSTALL: all`; #2 approves → `runner.of('techlead','review')` length 2, `runner.of('frontend','bounce')` length 0.
  5. `re-run only once` — review always not-approved + `INSTALL: all` → after the re-run it bounces normally; ends at `stuck` after MAX_BOUNCES with installer calls ≤ 4.
  6. `npm failure → error tool event and failure text in the agent's next prompt; ticket not failed`.
  7. `bad spec → no install, agent told` — reply `INSTALL: x;rm` → installer not called; next prompt contains `not a valid package spec`.
  8. `accept: package.json changed → npm install in owner repo after merge` — frontend writes `package.json`; final approved → installer called with `cwd = repo, specs = []` after merge.
- [ ] **Step 2:** `npm test -w server -- claude-orchestrator` → new tests FAIL.
- [ ] **Step 3: Implement**
  - `execNow`: after the success check, `if (role !== 'pm' && run.ws) await this.takeInstalls(run, role, res.result)`.
  - `takeInstalls(run, role, text)`: per request — resolve unit (`repo === ''` → single unit, else by name; unknown → note listing repo names); `bad.length` → note ``"`${bad}` is not a valid package spec; nothing was installed"``; `!unit.sharedModules` → note "this repo has its own node_modules: install in your worktree"; `undeclared(unit.repo, specs)` empty or `specs` empty → `runInstall(run, role, unit, [], false)`; else push to `pendingInstalls`.
  - `runInstall(run, role, unit, specs, noSave)`: emit `agent.tool` `{ tool: 'npm', summary: command + (multi ? ` (${unit.name})` : ''), status: 'running', toolId: 'install-<seq>' }`, await installer, emit same toolId with `status: ok|error, detail: output`; ok → `run.installed = true`, PM message `📦 Installed packages${where} for ${role}.`; fail → note to role `Office: npm install failed${where}:\n${output}`. Notes go through `run.notes[role]`.
  - `openInstallGate(run, stage)`: `run.installFrom = stage`, states `waiting`, PM message `New packages need your OK.`, `gate.open` `install` with payload `{ from: stage, requests: run.pendingInstalls }`.
  - `runStage`: review/test — set `run.installed = false` before the roles; after `Promise.all` → `if (run.pendingInstalls.length) return this.openInstallGate(run, stage)`; when not approved and `run.installed && !run.installRerun[stage]` → set flag, PM message `Packages were installed during the ${stage}; running it again.`, `return this.runStage(run, stage)`. Clear `installRerun[stage]` on pass and inside `bounce()`. Design/build/docs — after the commit, same pending check before `next`.
  - `decide('install')`: approved → for each pending `runInstall(..., specs, true)`; skip → note per role ``The owner declined installing ${specs}. Do without them.``; clear pending; continue: review/test → `runStage(run, from)`, otherwise `next(run, from)`.
  - `approveFinal`: record which units' diffs include `package.json` before merging; after merging, for merged single unit / `u.merged` units with `sharedModules` and a `package.json` change → `runInstall(run, 'pm', u, [], false)`.
  - `boot.ts`: one `Installer`; pass to `ClaudeOrchestrator` and `createOffice`; after `office` exists, `installer.waitFor(cwd => office.devServers.installing(cwd))`.
- [ ] **Step 4:** `npm test -w server` → all PASS.
- [ ] **Step 5:** Commit `feat(server): office installs packages agents ask for`.

### Task 4: Install gate card

**Files:**
- Modify: `web/src/ui/GateCard.tsx`
- Test: `web/test/ui.test.tsx` (`describe('GateCard')`)

- [ ] **Step 1: Failing test:** `item = { ...gate(), text: 'install', detail: JSON.stringify({ from: 'build', requests: [{ role: 'frontend', repo: '', specs: ['left-pad@1'] }] }) }` → shows `Install new packages?`, `frontend`, `left-pad@1`, buttons `Install` and `Skip`; clicking Install posts `{ decision: 'approved' }`.
- [ ] **Step 2:** `npm test -w web -- ui` → FAIL.
- [ ] **Step 3:** `CHOICES.install = [{ approved, 'Install', primary }, { skip, 'Skip', ghost }]`; `RESOLVED.skip = '⊘ skipped'`; one `gateLabel(gate)` helper replacing the three inline label ternaries (`install` → `'packages'`); body lists `role → specs (in repo)`; text `Installed with --no-save: your package.json changes only when you accept the ticket.`
- [ ] **Step 4:** `npm test` (all workspaces) and `npx tsc -p web --noEmit`, `npx tsc -p server --noEmit` → PASS / no output.
- [ ] **Step 5:** Commit `feat(web): install gate card`.
