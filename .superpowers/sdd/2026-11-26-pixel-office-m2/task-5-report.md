# Task 5 report: sessions, follow-ups, resume, messages, agents mode, REST

Branch `m2-task5` (from `m2-real-agents` @ 3eed205). Status: DONE.

## What changed
- **shared**: `Project.agentsMode?` (`'claude' | 'simulated'`), `Ticket.parentTicketId? / agentsMode? / workspace?`
  (`Workspace { branch, worktree, base {branch, head}, merged? }`). New events `ticket.workspace` and `ticket.resumed`,
  handled in the reducer (`resumed` makes the ticket running again and clears `reason`).
- **store**: `agentsMode` on add (default `claude`, validated) and on PATCH. Projects saved without it load as `claude`.
- **routing** (`server/src/orchestrator/routing.ts`): `RoutingOrchestrator` picks the orchestrator from the project's
  mode. Ticket-level calls go to whichever orchestrator owns the ticket. `boot` now wires claude + simulated (a real
  `ClaudeRunner` by default, injectable), and has a `forceMode` option. `main.ts` reads `OFFICE_AGENTS=simulated`, and
  `tools/e2e.mjs` sets it so e2e stays deterministic. The hardening restart test uses `forceMode: 'simulated'`.
- **Orchestrator interface**: `startTicket(project, text, { parentTicketId? })` and `resume(ticketId)` (the simulated
  orchestrator throws a 409 Conflict).
- **ClaudeOrchestrator**:
  - **Follow-ups.** The parent is loaded when the follow-up *starts*. A per-project queue means a follow-up waits while
    its parent runs, so a session never has two runs at once. The parent's sessions are inherited and re-emitted as
    `agent.session` in the child's log. The PM resumes its old session with `followUpPrompt`. Re-tasked roles resume
    their old sessions.
  - **Branch choice.** If the parent was not merged and its branch exists, the follow-up re-attaches that branch
    (`git.attachWorktree` recreates the worktree if it was removed). If the parent was merged, it gets a new branch from
    the current base.
  - **Expired sessions.** If resuming an inherited session fails (StageFailed), the role gets one fresh session. The
    prompt starts with `<previous-work>`: the parent's plan summary, its tasks and the files it changed.
  - **Resume.** `resume(id)` works only for failed claude tickets. It rebuilds the run from the log (sessions, plan,
    workspace, stage, usage, seq), emits `ticket.resumed` and joins the project queue. It then re-runs the interrupted
    stage. Every role with a stored session gets "Continue where you left off." before its next prompt and resumes that
    session. If the ticket stopped at plan with a plan already made, the plan gate is re-opened. With no plan yet, the
    PM resumes and is asked for the plan JSON, with a fresh full prompt as fallback.
  - **Messages.** The ack is still immediate. Notes now go *before* the prompt in an `<owner-notes>` block
    (`withOwnerNotes`), including the PM's plan and re-plan prompts. Some notes have no later step to ride on. Those are
    delivered by resuming the role's session with `deliverNotesPrompt`, using the per-role lock so they queue behind
    its current run:
    - design, build and docs roles: at the end of their stage, before the commit;
    - review and test roles: when their stage passes;
    - the PM: right away if it isn't planning, otherwise after the plan gate opens.

    A delivery failure is logged and does not fail the ticket.
  - `ticket.workspace` is emitted when the worktree is created or attached, and again with `merged: true` after a merge.
- **REST** (all behind the existing global origin/JSON guard):
  - `POST /api/projects/:id/tickets` accepts `parentTicketId`; an unknown parent gives 404.
  - `POST /api/tickets/:id/resume`
  - `POST /api/projects/:id/git-init` returns 409 if the folder is already a repo, otherwise `{ ok, message }`.
  - `GET /api/system/claude` returns `{ found, version, loggedIn, accountType, signInEndsAt }` from an allow-list.
    `ClaudeSystem` (`server/src/claude/system.ts`) takes an injectable exec and caches for 60 s.
  - PATCH `agentsMode` returns 409 while a ticket is running *or queued* for the project.

## Tests
- `npm test -w server`: 10 files, 135 tests, all pass.
- New tests: 9 in `claude-orchestrator.test.ts` (follow-ups, resume, messages) and 11 in `m2-api.test.ts` (routing,
  agents mode, follow-up/resume REST, git-init, guards, system/claude).
- `npx tsc -p server --noEmit` and `npx tsc -p web --noEmit` are clean.
- `npm test -w web`: 4 files fail in this worktree only, because the untracked `assets/office/...pieces.csv` isn't
  here. My changes don't cause this.

## Concerns
- **Output format guessed.** I had no real sample of `claude auth status --text`, so the parser is lenient. It reads
  `Login method/Account/Subscription: …` as the account type and an ISO date on an `Expires/ends …` line as
  `signInEndsAt`. It ignores any value containing `@`, and never reads email or organization lines. Check it against
  real output on the owner's machine.
- **Tests written after the code.** Because of the deadline, the code came first and the tests right after, not strict
  TDD.
- **Field name.** The design §8 calls the field `account`; I used `accountType`, following the brief and the
  designer's decision.
- **PM notes trigger a PM run.** A message sent at the plan gate (no role working) resumes the PM session right away.
  That costs a PM turn, but nothing re-plans.
- **Rough edge in Resume.** Resuming a ticket that failed during a final-gate merge re-runs its last work stage, then
  re-opens the final gate.

## Follow-up: merged Task 4 fixes (a9de46f)
- Merged m2-real-agents (Task 4 review fixes). Conflicts in claude.ts resolved keeping route()/tasked() bounce routing plus note delivery; PM notes at the plan gate are now held for a re-plan (Task 4 behaviour) and delivered to the PM session on approval; past the plan they are delivered immediately.
- Auth status parser matches the real output: `Login method:` gives accountType and loggedIn; the ISO timestamp in parentheses on `Sign-in ends:` gives signInEndsAt; Organization/Email are never read. Redacted fixture: server/test/fixtures/auth-status.txt.
- server: 147/147 tests pass; tsc (server, web) clean. The Task 4 cancel test failed once under full-suite load (it waits a fixed 300 ms), then passed on 2 reruns; it may be timing-flaky.

## Fix round 1
- Resume falls back like follow-ups do: if a resumed session fails, the role starts a fresh session with the ticket plan and changed files (refreshed from the branch diff).
- Tickets without agentsMode (created before M2) are adopted by the simulated orchestrator. Claude Resume requires agentsMode claude plus stored sessions or a workspace.
- git-init returns 409 only when the folder is a repo with at least one commit.
- ticket.resumed carries queued: true when another ticket is ahead, so the reducer shows queued.
- The cancel test now polls instead of waiting a fixed 300 ms.
- Result: 151/151 server tests pass; tsc for server and web is clean.
