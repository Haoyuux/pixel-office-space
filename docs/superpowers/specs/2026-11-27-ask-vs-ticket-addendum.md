# Addendum: Ask vs Ticket, fair review, parent docs

Date: 2026-11-27 · Status: approved by owner ("can it tell if it's a ticket or just an ask" → yes, auto) ·
Amends the M2 design §5 (flow), §6 (prompts) and the multi-repo addendum.

## Why (observed on the HRMS ticket 11b264)
"List all the buttons in Leave" is a question, but it ran the full pipeline (plan gate → worktrees → 2 devs →
3 review bounces → stuck). Asking Claude directly in the folder takes ~1 min. The Tech Lead also bounced for things the
devs could not fix: a ticket-register file that lives in the parent folder `HrmsSP2/docs` (outside both repos, so not
in the workspace) and "QA hasn't checked it" (QA runs after review).

## 1. Auto-detect Ask vs Ticket (one PM run, no extra cost)
- Ticket creation takes `mode: 'auto' | 'ask' | 'ticket'` (default 'auto'); stored on the ticket.
- The PM's first run (read-only, cwd = owner's folder) gets a prompt that, in `auto`, lets it choose:
  - **Answer** — when the request only asks for information and needs no file changes: output fenced json
    `{ "kind": "answer", "answer": "<markdown>" }`.
  - **Plan** — when files must change (including writing a document into the repo): today's plan JSON with
    `"kind": "plan"`.
  In `ask` mode the prompt requires an answer (never a plan); in `ticket` mode it requires a plan (today's behaviour).
- On an answer: emit the answer as a PM `agent.message`, then `ticket.done` (no gate, no worktree, no other roles),
  with usage. Event `ticket.answered` (additive, for the UI chip) before done. The office animates: PM thinks at the
  whiteboard/desk, then done wave.
- Follow-ups on an answered ticket resume the PM session as today (so "ok, now write that to docs/buttons.md" becomes a
  ticket that remembers the answer).
- If the PM returns invalid JSON, keep today's one fixJson retry; in `auto`, a reply that is clearly prose without
  JSON is treated as an answer (show the prose) rather than failing.

## 2. Fair review and QA
- Review prompt: judge only the changes in the diff against the plan and acceptance criteria. Do NOT block on: QA or
  testing not done yet (QA runs after review), process rules about files outside the repos, or anything the
  developers cannot change in the workspace. Put such notes under `notes`, not `issues`.
- Same rule for QA: only report failures the builders can fix in the workspace.
- Server-side guard: drop review/test issues whose file path is outside every repo of the workspace (log them as a
  PM note instead) so they never cause a bounce.

## 3. Parent docs for multi-repo projects (read-only)
- When the project is multi-repo, non-PM agents run in the workspace but also get read access to the parent folder:
  pass `--add-dir <owner parent folder>` on every run (re-passed on resume), and tell them in the prompt: "Project
  rules and docs live in <parent>/CLAUDE.md and <parent>/docs — read them; you cannot change files there."
- Agents must not write there: the parent is outside the workspace; editing tools stay limited by the prompt and
  `--permission-mode acceptEdits` only covers the cwd. (Verify: if `--add-dir` grants write access under acceptEdits,
  instead copy `<parent>/CLAUDE.md` and `<parent>/docs/**/*.md` (≤ 2 MB total) read-only into
  `<workspace>/_project/` and point agents there.)

## 4. UI
- Composer: a three-way switch **Auto · Ask · Ticket** (default Auto), sent as `mode`.
- An answered ticket shows a "✓ answered" chip in Past conversations and the pipeline bar shows only "Answer ✓".
- Answer rendered as markdown-ish text (headings, lists, code) in the feed, wrapped.

## Must still hold
Owner files untouched before final approval; no merges for answers; never push; tests never call the real CLI.
