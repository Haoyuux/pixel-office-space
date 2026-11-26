# Pixel Office — Milestone 2: Real Agents — Design

Date: 2026-11-26 · Status: approved by owner ("ok do it, make sure I'm still just using the normal [Claude login]";
owner asked not to be asked questions and to take the recommended calls). Builds on
`2026-11-26-pixel-office-design.md` (§9 event contract and §12 outline) and the lounge/cafeteria addendum.

## 1. Intent
Replace the simulated ticket pipeline with real Claude Code agents working in the owner's project folders, using the
owner's **normal Claude Code login** (their Claude subscription — no API key, no separate billing). Add **Resume**:
list a project's past conversations and continue any of them with full memory, like `/resume` in the terminal.
The office, the event contract, the drawer and the gates stay as they are.

### Goals
- A ticket is worked end to end by real agents: PM plans → owner approves → (designer) → devs build → tech lead
  reviews → QA tests → (writer) → owner approves the final diff → changes land in the project.
- Agents run as the project's roles defined in `<folder>/.claude/agents/<role>.md`, with per-role tool permissions.
- The owner's main working copy is never touched until the final approval.
- Every ticket's agent sessions are kept; any past ticket can be resumed with full context.
- Live streaming into the console: each agent's messages and tool calls appear as they happen.

### Non-goals
- No cloud hosting, no multi-user, no pushing to remotes, no PR creation.
- No Agent SDK and no Messages API (both require an API key — see §3).

### Anti-goals
- Using an API key or anything that bills outside the owner's subscription.
- Agents editing the owner's main working copy before the final approval, or touching files outside the project.
- A ticket that hangs forever, or a stuck agent process that survives a cancel or a server stop.

## 2. Verified facts (checked on the owner's machine, 2026-11-26)
- `claude.exe` 2.1.332 at `%USERPROFILE%\.local\bin\claude.exe`; logged in with a Claude Ultra account;
  `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` not set. Sign-in ends around 2026-12-20 (warn in the UI ahead of it).
- `claude -p "<prompt>" --agent <role> --output-format stream-json --verbose --max-turns N --permission-mode dontAsk`
  run in a folder containing `.claude/agents/<role>.md` uses that agent (its `tools` restrict the tool list) and the
  subscription login. Events: `system/init` (session_id, model, tools), `assistant` (message.content text/tool_use),
  `user` (tool_result), `rate_limit_event`, `system/hook_*`, `result` (subtype, is_error, result, num_turns,
  total_cost_usd, session_id).
- `claude -p "<follow-up>" --resume <session_id> --agent <role> ...` continues the same session with full memory.
- Auth precedence: in `-p` mode an `ANTHROPIC_API_KEY` in the environment is always used → the spawner must delete
  `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_USE_BEDROCK/VERTEX/FOUNDRY` from the child env.
  Never pass `--bare` (bare mode ignores the subscription login and `.claude/agents`).
- Flags not restored on resume (`--allowedTools`, `--disallowedTools`, `--add-dir`, ...) must be passed again.
- Two `-p` runs must not use the same session at once.
- The Agent SDK docs say third-party products may not offer claude.ai login; this tool runs the owner's own CLI on
  the owner's machine for personal use, which is the CLI's intended headless use. Not to be packaged for others.

## 3. Approaches
| Option | Login | Verdict |
|---|---|---|
| **A. Spawn the `claude` CLI headless per role (`-p`, stream-json, `--resume`)** | owner's subscription | **Chosen** — verified working; gives Claude Code's tools, agents, permissions and sessions for free. |
| B. Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) | API key required for third-party apps | Rejected — owner wants the normal login. |
| C. Messages API + our own tools | API key | Rejected — same reason, and we'd rebuild Claude Code. |

## 4. Architecture
- `server/src/claude/runner.ts` — `ClaudeRunner.run({ cwd, role, prompt, resume?, allowedTools, maxTurns, onEvent, signal })`
  spawns `claude.exe` (path resolved once: `CLAUDE_BIN` env → `%USERPROFILE%\.local\bin\claude.exe` → `claude` on
  PATH), args as an array, no shell, sanitized env, reads stdout line by line, parses JSON, emits typed runner events,
  resolves with `{ sessionId, result, isError, subtype, numTurns, costUsd }`. Cancel: send Ctrl+C/SIGINT, then after
  5 s kill the process tree (`taskkill /PID <pid> /T /F` on Windows). A per-run wall-clock timeout (default 30 min).
  Lines that aren't JSON go to `log.raw`.
- `server/src/claude/translate.ts` — runner events → `ServerEvent`s: assistant text → `agent.message`
  (streaming=false; one per text block), `tool_use` → `agent.tool` status running (summary like "Edit src/a.ts",
  "Bash npm test"), matching `tool_result` → `agent.tool` status ok/error (same toolId), everything → `log.raw`.
- `server/src/claude/git.ts` — per-ticket git worktree: `git worktree add <dataDir>/worktrees/<projectId>/<ticketId>
  -b office/<slug>-<id6> <baseRef>`; commit after each stage that changed files (`git add -A && git commit -m
  "office: <stage> (<role>)"`, author "Pixel Office <office@localhost>"); final diff `git diff <base>...<branch>`;
  on final approval merge into the base branch with `--no-ff` in the owner's repo **only if the owner's working tree is
  clean and the base branch is checked out**, otherwise leave the branch and tell the owner exactly what to run;
  remove the worktree after merge/cancel (keep the branch). Never push.
- `server/src/orchestrator/claude.ts` — `ClaudeOrchestrator implements Orchestrator` (same interface and events as the
  simulated one, so the office, drawer and director work unchanged). Uses runner + translate + git + prompts.
- `server/src/claude/prompts.ts` — the prompt for each stage (below), kept short; role behaviour lives in the agent
  files. Agent file content is upgraded (only files Pixel Office created — detect by a marker comment) to a full role
  prompt with `tools` frontmatter matching §6.
- Project setting `agents: 'claude' | 'simulated'` (default `claude` for new projects; existing projects migrate to
  `claude`; the simulated orchestrator stays for demos/tests). The server routes per project.

## 5. Ticket flow
1. **Preflight**: project folder must be a git repo with at least one commit. If not, the ticket fails fast with a
   clear message and the drawer shows **Initialize git** (runs `git init`, adds a `.gitignore` if none exists, and
   commits everything as "Initial commit (Pixel Office)" — only on the owner's click). If `claude` isn't found or
   isn't logged in (`claude auth status`), fail with the fix to run.
2. **Plan** — PM (`tools: Read, Glob, Grep`), cwd = the owner's project folder (read-only). Prompt: ticket text, team
   roles, the project map if `.claude/office/project-map.md` exists, and the required output: one fenced ```json
   block `{ summary, acceptance[], areas[], tasks: [{ role, text, files[] }], projectMap? }` (tasks only for roles on
   the team; `projectMap` markdown only when no map exists yet). Parse; if invalid, resume the PM session once asking
   for valid JSON; still invalid → ticket fails with the PM's text shown. The server writes `projectMap` to
   `.claude/office/project-map.md` in the worktree later (so it lands with the changes) — and to the project folder
   only after merge. Emit `ticket.plan`, gate `plan`.
3. Plan **changes** with a note → resume the PM session with the note, re-plan. **Approved** → create the worktree.
4. **Design** (uiux, if tasked): cwd = worktree; writes `docs/design/*.md`. Commit.
5. **Build**: frontend, backend, devops tasked roles run **in parallel** in the same worktree, each told its task and
   files and to stay within its area; each keeps its own session. Commit after all finish.
6. **Review** (techlead + security if tasked): read-only + `git diff`; output fenced json
   `{ approved: boolean, issues: [{ role, file, note }] }`. Issues → resume each owning dev's session with its issues
   (bounce), commit, review again. 3 bounces → `stuck` gate (retry / accept / cancel, as in M1).
7. **Test** (qa): may write test files and run the project's test command; output json `{ passed, failures: [{ role,
   note }] }`. Failures → resume the owning dev, commit, test again; 3 → `stuck`.
8. **Docs** (writer, if tasked). Commit.
9. **Final gate**: `ticket.diff` = the worktree diff vs base. **Approve** → merge per §4; **Request changes** with a
   note → resume the relevant devs (PM decides which by resuming its session with the note) and continue from Build.
10. **Done**: emit `ticket.done`; record per-ticket totals (turns, estimated cost, duration) in a `ticket.usage` event.

Agent states map as in M1 (`summoned`, `planning`, `designing`, `coding`, `reviewing`, `testing`, `documenting`,
`waiting`, `done`, `failed`, `idle`), so the office animates exactly as before.

**Owner messages mid-ticket** (`sendMessage`): a running `-p` process can't take new input, so the message is queued
and prepended to the **next** prompt sent to the active role (or the PM between stages), and acknowledged immediately
in the feed ("Got it — I'll pass this to Backend Dev on its next step"). If no further step is pending for that role,
the server resumes that role's session with the message as soon as its current run ends.

## 6. Roles, tools, permissions (all runs `--permission-mode dontAsk`; anything not allowed is denied, never prompts)
| Role | Allowed tools (`--allowedTools`; Bash and PowerShell forms both) | Notes |
|---|---|---|
| pm | Read, Glob, Grep | plans only |
| techlead / security | Read, Glob, Grep, Bash(git diff *), Bash(git log *), Bash(git status *) (+ PowerShell equivalents) | review only |
| frontend / backend / devops | Read, Glob, Grep, Edit, Write, MultiEdit, Bash(npm *), Bash(npx *), Bash(node *), Bash(pnpm *), Bash(yarn *), Bash(git status *), Bash(git diff *) (+ PowerShell equivalents) | git commits are done by the server only |
| qa | dev tools | prompt restricts writes to test files |
| uiux / writer | Read, Glob, Grep, Edit, Write | docs/design files |
`--max-turns`: pm 30, review 30, build/test 80, docs 30. Wall-clock per run 30 min. The cwd is the worktree, so writes
outside it are outside the project. Model: the CLI default (the owner's Claude Code default model).

## 7. Sessions and Resume
- Every run's `session_id` is stored per ticket per role (`ticket.sessions[role]`), emitted as `agent.session`
  events and kept in the ticket log.
- **Resume past conversation** (drawer → "Past conversations" list: title, date, status, roles, estimated cost):
  selecting one shows its full history (already supported); a **Continue** box sends a follow-up. Follow-up = a new
  ticket linked to the old one (`parentTicketId`) that **resumes the PM's previous session** with the follow-up text
  (so the PM remembers), and resumes each dev's previous session when that role is tasked again. If the parent's
  branch wasn't merged, the follow-up continues in the same branch/worktree (recreated if removed); if it was merged,
  a new branch from the current base.
- **Interrupted tickets** (server stopped mid-run): marked failed/interrupted as in M1, plus a **Resume** button that
  re-runs the interrupted stage by resuming the stored sessions with "Continue where you left off."
- Sessions live in Claude Code's own store (`~/.claude/projects/...`, 30-day default retention); Pixel Office stores
  only the IDs. If a session has expired, resume falls back to a fresh session given the ticket's plan and diff.

## 8. Event contract additions (§9 of the M1 design stays; these are additive)
- `agent.session` `{ role, sessionId }`; `ticket.usage` `{ turns, costUsd, durationMs }` (estimate — label as such);
  `ticket.created` ticket gains `parentTicketId?`, `agentsMode`.
- REST: `POST /api/projects/:id/git-init`; `POST /api/tickets/:id/resume` (interrupted); follow-up uses
  `POST /api/projects/:id/tickets { text, parentTicketId }`; `GET /api/system/claude` → `{ found, version, loggedIn,
  account, signInEndsAt }` (no email or secrets beyond the account type).
- Origin/JSON guards from M1 apply to all new routes.

## 9. UI changes
- Drawer header: an "Agents: Claude Code" badge (or "Simulated"), switchable in the Team dialog.
- Banner when `claude` is missing / logged out / sign-in ends within 10 days, with the exact command to run
  (`claude` then `/login`).
- "Initialize git" banner for non-git folders (button, explained in one line).
- "Past conversations" panel replacing the plain ticket dropdown: list + Continue box; "Resume" on interrupted tickets.
- Feed shows per-ticket usage at the end ("12 turns · ~$0.84 estimated · 6 min").

## 10. Testing
- Runner: parse recorded stream-json fixtures (record real ones in the build task with tiny prompts); env sanitizing
  (API key removed); kill-tree on cancel (spawn a dummy long-running node script as the "binary" via `CLAUDE_BIN`).
- Orchestrator: a **fake runner** (scripted results per role/stage) drives the full flow: plan JSON parsing + retry,
  gates, parallel build, review/QA bounces, stuck, cancel, follow-up resume, mid-ticket message delivery.
- Git: temp repos — worktree create, per-stage commits, diff, merge when clean, refuse merge when dirty, cleanup.
- One opt-in live smoke test (`OFFICE_LIVE=1`) that runs a real 1-turn PM plan on a temp repo with the owner's login.
- e2e stays on the simulated orchestrator (deterministic); a separate manual check runs one real tiny ticket.

## 11. Rulings (designer's calls; owner opted out of questions)
- CLI headless over Agent SDK/API (login requirement). Parallel builders share one worktree (fast; told to stay in
  their files). Server owns all git commits/merges; agents can't commit. Merge only when the owner's tree is clean and
  on the base branch; never push. Mid-ticket messages delivered at the next agent step. Default agents mode `claude`.
- Usage is the owner's subscription; cost shown is the CLI's own estimate, labelled "estimated".
