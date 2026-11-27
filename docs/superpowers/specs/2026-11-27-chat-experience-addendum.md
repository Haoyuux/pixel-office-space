# Addendum: AI-chat experience and speed

Date: 2026-11-27 · Status: approved by owner ("copy the features of other AI agents, and the speed") ·
Builds on threaded conversations (branch `threads`) and the Ask/Ticket addendum.

## Speed
- **Token streaming:** runner adds `--include-partial-messages` (requires `-p` + stream-json; verified flag in the M2
  design §2). Partial text deltas become `agent.message` events with `streaming: true` and a stable `messageId` per
  assistant message; the final full text arrives with `streaming: false` (same id). Client concatenates deltas and
  replaces with the final text.
- **Effort by mode:** PM answers in chat (ask, or auto when it turns out to be an answer) run with `--effort medium`
  (planning a change stays default/high). Runner option `effort?: 'low'|'medium'|'high'|'xhigh'|'max'`.
- **Stop:** `POST /api/tickets/:id/stop` stops the currently running agent run(s) of that conversation (graceful
  abort; the ticket for a chat answer ends `done` with "Stopped by you" + whatever text streamed so far; for a change
  ticket in a work stage, stop = cancel with the existing confirm).
- Show elapsed time while an agent works ("Thinking… 12s").

## Attachments and @files
- `POST /api/projects/:id/attachments` (multipart or JSON base64 `{ name, dataBase64 }`, ≤ 10 MB each, images/text/pdf)
  → saved under `<dataDir>/attachments/<projectId>/<id>-<safe name>`; returns `{ id, name, path }`. Messages/tickets
  accept `attachments: string[]` (ids); the prompt lists their absolute paths ("Attached files — read them with the
  Read tool: …"). Agents get read access via `--add-dir <attachments dir>` (read-only use; the dir is outside every
  repo and outside the owner's folders).
- `GET /api/projects/:id/files?q=<text>` → up to 30 matching repo-relative paths (git ls-files across the project's
  repos, multi-repo prefixed with the repo name; case-insensitive subsequence match). `@path` mentions are kept in the
  message text as-is (agents read them from the PM's cwd = owner folder; in the workspace, paths match too).

## Conversation management
- Conversation meta store `<dataDir>/conversations.json`: per root ticket `{ title?, pinned?, deleted? }`.
  `PATCH /api/conversations/:rootId { title?, pinned? }`, `DELETE /api/conversations/:rootId` (soft delete: hidden
  from lists; logs kept). Included in the snapshot/history response.
- Auto title: the PM's first answer/plan summary first line (≤ 60 chars) if no title set.

## Web (chat UX)
- Live typing (streaming), "Thinking… Ns" indicator, ■ Stop button + Esc.
- Copy button on every message and code block; syntax highlighting for common languages (C#, TS/JS, HTML, CSS, SQL,
  JSON, bash/PowerShell) — small safe tokenizer, no new heavy dependency (a tiny well-known lib is OK if < 30 KB).
- Markdown: tables and links (links open in a new tab, `rel=noopener`).
- Composer: paste/drag images & files → attachment chips (upload on add, remove ×); `@` → file search popup (like `/`);
  ↑ on empty composer recalls the previous message; edit-and-resend the last message (pencil on your last bubble →
  puts it back in the composer; sending it continues the thread as a new message).
- Past conversations: rename (inline), pin (📌, pinned first), delete (with inline confirm), search box (title + text).
- Full-screen chat toggle (⛶): the drawer expands to most of the window; office still visible behind; Esc/⛶ restores.
- Tool activity grouping: consecutive tool lines collapse into one summary line ("Read 6 files · Searched 3 times · Ran
  2 commands"), expandable.
- Shortcuts: Ctrl+K new conversation, Esc stop (when running) / close popups, Ctrl+/ open the slash menu.

## Must still hold
No API key; never push; owner files untouched before final approval; tests never call the real CLI; all new routes
behind the origin/JSON guards (multipart upload must still require a same-origin request).
