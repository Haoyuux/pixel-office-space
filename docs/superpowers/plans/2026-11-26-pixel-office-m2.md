# Pixel Office — Milestone 2 (Real Agents) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Real Claude Code agents (the owner's normal subscription login via the `claude` CLI in headless mode) work each ticket in a per-ticket git worktree, with live streaming, gates, and Resume of past conversations.

**Architecture:** New `server/src/claude/` (runner, translate, git, prompts) and `server/src/orchestrator/claude.ts` implementing the existing `Orchestrator` interface, routed per project by `agentsMode`. Web adds banners, a Past conversations panel with Continue/Resume, and a usage line. Event contract is additive.

**Tech Stack:** Node 22 child_process (no shell), git CLI, existing Express/ws/React/zustand/vitest.

**Spec:** `docs/superpowers/specs/2026-11-26-pixel-office-m2-real-agents-design.md` (authority; read §2 verified facts before Task 1).

## Global Constraints
- Spawn `claude.exe` with args as an array, `shell: false`; child env = copy of `process.env` minus `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_USE_FOUNDRY`. Never pass `--bare`.
- Every run: `-p <prompt> --agent <role> --output-format stream-json --verbose --permission-mode dontAsk --max-turns <n> --allowedTools <list>`; resumed runs add `--resume <sessionId>` and repeat `--allowedTools`.
- Agents never commit, merge or push; the server does commits/merges; never push.
- The owner's main working copy is untouched until final approval; merge only when the owner's tree is clean and the base branch is checked out.
- Binary resolution: `CLAUDE_BIN` env → `%USERPROFILE%\.local\bin\claude.exe` → `claude` on PATH.
- Tests never call the real `claude` except the opt-in `OFFICE_LIVE=1` smoke test.
- Event contract additions only: `agent.session`, `ticket.usage`, ticket `parentTicketId?`, `agentsMode`.

## Review Focus
- A `claude` process that hangs or ignores Ctrl+C on cancel/server stop: it must be killed (process tree) and the ticket must end.
- The PM returns prose or malformed JSON: one retry via resume, then a clear failure showing the PM's text.
- Owner's repo dirty or on another branch at final approval: no merge, branch kept, exact instructions shown.
- Two runs of the same session at once (follow-up while a ticket runs): must be prevented (queue).
- `ANTHROPIC_API_KEY` present in the server's env: must not reach the child.

---

### Task 1: Claude runner and event translation
**Files:** Create `server/src/claude/runner.ts`, `server/src/claude/translate.ts`, `server/test/claude-runner.test.ts`, `server/test/fixtures/claude/*.jsonl` (recorded), `server/test/fixtures/fake-claude.mjs`.
**Interfaces — Produces:** `resolveClaudeBin(): string`; `childEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv`; `interface RunOptions { cwd; role: RoleId; prompt; resume?: string; allowedTools: string[]; maxTurns: number; timeoutMs?: number; signal?: AbortSignal; onEvent(e: RunnerEvent): void }`; `type RunnerEvent = { kind: 'init'; sessionId; model } | { kind: 'text'; text } | { kind: 'tool_use'; id; name; input } | { kind: 'tool_result'; id; isError; content } | { kind: 'raw'; line }`; `interface RunResult { sessionId; result: string; isError: boolean; subtype: string; numTurns: number; costUsd: number; durationMs: number }`; `class ClaudeRunner { run(o: RunOptions): Promise<RunResult> }`; `translate(role, e: RunnerEvent): Partial<ServerEvent>[]` producing `agent.message`, `agent.tool` (running → ok/error, same toolId), `log.raw`; `toolSummary(name, input): string` ("Edit src/a.ts", "Bash npm test", "Read README.md").
- [ ] Record 2–3 real fixtures with tiny prompts in a temp git repo (a PM text-only reply; a dev that Reads and Edits a file; a resumed run) — needs `dangerouslyDisableSandbox`.
- [ ] Failing tests: fixture parsing → expected RunnerEvents and RunResult; `childEnv` strips the five vars and keeps PATH; args built exactly per Global Constraints (with and without resume); `fake-claude.mjs` (via `CLAUDE_BIN=node fake-claude.mjs` style: allow `CLAUDE_BIN` to be `node` + script via a `CLAUDE_BIN_ARGS` prefix) that sleeps forever → abort kills it within 6 s and run rejects with an `AbortError`; timeout kills; non-JSON stdout line → raw event; non-zero exit with no result event → rejects with stderr tail.
- [ ] Implement (readline on stdout; Windows kill tree via `taskkill /PID <pid> /T /F` after Ctrl+C attempt; POSIX `kill(-pid)` with detached group).
- [ ] Tests green; commit `feat(server): claude CLI runner and event translation`.

### Task 2: Git worktree helper
**Files:** Create `server/src/claude/git.ts`, `server/test/claude-git.test.ts`.
**Produces:** `isRepo(dir)`, `hasCommit(dir)`, `gitInit(dir)` (git init, default `.gitignore` with node_modules/dist/.env if none, initial commit), `baseInfo(dir): { branch, head, clean }`, `createWorktree(repo, wtPath, branch, baseRef)`, `commitAll(wt, message): boolean` (false if nothing to commit), `diff(repo, base, branch): DiffFile[]`, `mergeIntoBase(repo, branch, base): { merged: true } | { merged: false; reason; instructions }`, `removeWorktree(repo, wtPath)`, `slug(text)`. All via `execFile('git', args)`, author `Pixel Office <office@localhost>`.
- [ ] Failing tests on temp repos for each function incl. merge refused when dirty / on another branch, and diff after commits.
- [ ] Implement; green; commit `feat(server): git worktree helper`.

### Task 3: Prompts, agent files, structured outputs
**Files:** Create `server/src/claude/prompts.ts`, `server/src/claude/parse.ts`, `server/src/claude/roles.ts`; modify `server/src/scaffold.ts`; tests `server/test/claude-prompts.test.ts`.
**Produces:** `ROLE_TOOLS: Record<RoleId, string[]>` and `MAX_TURNS` per spec §6 (Bash + PowerShell forms); `agentFileFor(role)` with frontmatter `name, description, tools` and a marker `<!-- pixel-office:managed -->`; `scaffoldAgents` upgrades only marker-bearing (or M1-generated, detectable by the old template text) files and never touches others; prompt builders `planPrompt(ticket, project, map?)`, `stagePrompt(stage, role, task, plan, notes[])`, `reviewPrompt(...)`, `testPrompt(...)`, `bouncePrompt(issues)`, `fixJsonPrompt()`; `extractJson<T>(text, validate): T | null` (last fenced ```json block, else whole text) with validators for Plan (+projectMap?), ReviewVerdict, TestVerdict.
- [ ] Failing tests (JSON extraction from prose with fences, invalid → null; plan tasks limited to team roles; agent file upgrade keeps user files untouched); implement; commit `feat(server): role prompts, tools and structured outputs`.

### Task 4: ClaudeOrchestrator — core flow
**Files:** Create `server/src/orchestrator/claude.ts`, `server/test/claude-orchestrator.test.ts` (fake runner + temp git repos).
**Consumes:** Tasks 1–3, `Orchestrator` interface, `TicketLog`, shared types/reducer. **Produces:** `class ClaudeOrchestrator implements Orchestrator { constructor({ log, runner, git, dataDir, now? }) }` emitting the same events as the simulated orchestrator plus `agent.session`, `ticket.usage`.
- [ ] Failing tests: preflight non-git → ticket.failed with reason `not-a-git-repo`; plan JSON ok → gate plan with plan; bad JSON → one fixJson resume → ok; still bad → failed with PM text; plan `changes` → PM resumed with note; approve → worktree created, build roles run in parallel (both start before either ends), commit after build; review bounce → owning dev resumed with issues, 3 → stuck (retry/accept/cancel semantics as M1); QA failures bounce; final diff from git; approve → merged when clean (base advanced), refused when dirty (ticket done with `merge-pending` message and instructions); cancel → runner aborted, worktree removed, branch kept; agent states sequence matches M1 so the office animates; `busyRoles` correct; queue per project.
- [ ] Implement; green; commit `feat(server): claude orchestrator core flow`.

### Task 5: Sessions, follow-ups, resume, messages, routing, REST
**Files:** Modify `server/src/orchestrator/claude.ts`, `server/src/app.ts`, `server/src/boot.ts`, `server/src/store.ts` (`agentsMode`, default 'claude', migration), `shared/src/types.ts` + `events.ts` (additions), tests.
- [ ] Failing tests: follow-up with `parentTicketId` resumes the parent's PM session id and dev sessions when re-tasked; unmerged parent → same branch; merged → new branch; interrupted ticket `POST /api/tickets/:id/resume` resumes the interrupted stage's sessions with "Continue where you left off"; mid-ticket `sendMessage` → immediate ack + text prepended to the role's next prompt; no two concurrent runs on one session (follow-up while parent running → queued); routing by `project.agentsMode` (simulated still works); `GET /api/system/claude` shape without email; `POST /api/projects/:id/git-init` runs gitInit only on request; origin/JSON guards apply.
- [ ] Implement; green; commit `feat(server): resume, follow-ups, messages, agents mode`.

### Task 6: UI
**Files:** web `ui/*` (Drawer, new PastConversations, banners, TeamDialog agents-mode switch), `state/store.ts` (agent.session, ticket.usage, parentTicketId), tests.
- [ ] Failing UI tests: Claude-missing / logged-out / sign-in-soon banners from `/api/system/claude`; Initialize git banner + button posts git-init; Past conversations list (title, date, status, est. cost) → selecting shows history, Continue box posts `{ text, parentTicketId }`; Resume button on interrupted tickets; usage line rendered from `ticket.usage`; agents-mode badge + switch in Team dialog (PATCH `agentsMode`).
- [ ] Implement; visual check with `tools/shot.mjs` on alternate ports (owner's dev servers may be running on 5173/5175 — never kill them); commit `feat(web): past conversations, resume, claude status banners`.

### Task 7: Live check and docs
- [ ] `server/test/claude-live.test.ts` (skipped unless `OFFICE_LIVE=1`): temp repo with a tiny `package.json` + `sum.js`; ticket "Add a function that multiplies two numbers with a test" through the real CLI end to end with gates auto-approved by the test; asserts merged commit on base with the new function. Run it once (needs `dangerouslyDisableSandbox`), record duration/cost in the report.
- [ ] README: how real agents work, the login requirement (`claude` then `/login`), what runs where, how to switch a project to Simulated, how Resume works, usage note (counts against the Claude subscription; costs shown are estimates).
- [ ] Full `npm test`, both tsc, `node tools/e2e.mjs` (simulated) green; commit `docs: real agents`.
