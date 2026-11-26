# Task 6 report: UI for real agents

Status: DONE. Branch `m2-task6`, based on `m2-real-agents` (a4b1994).

## What was built
- **Claude status banners** (`web/src/ui/claudeStatus.tsx`). A small zustand store fetches `GET /api/system/claude` when first used and then every 5 min while something on screen shows it (the interval is shared through a reference count). The exact texts:
  - missing: "Claude Code isn't installed — install it, then run `claude` and `/login`"
  - logged out: "Run `claude` then `/login` in a terminal"
  - sign-in ends within 10 days: "Your Claude sign-in ends on <date> — run `claude` then `/login` to renew"

  The full banner sits at the top of the drawer for claude-mode projects, and a compact one sits in the toolbar. A reply that isn't valid, or a failed fetch, keeps the last known status.
- **Initialize git banner** (in Drawer.tsx). It shows when the newest ticket failed with `not-a-git-repo`. Its button sends `POST /api/projects/:id/git-init` and shows the server's message or error on the same line.
- **Past conversations** replace the ticket `<select>`. The ticket row shows the title, a status chip and a "Past conversations · N" toggle. The list shows the title, a relative date ("2d ago"), a status chip, the emojis of the roles involved, and "~$0.84 est." when usage is known. Picking a ticket shows its history.
- **Continue**: when you pick a finished ticket from the list (done / failed / cancelled), the composer placeholder becomes "Continue this conversation…" and the button becomes "Continue". It posts `{text, parentTicketId}`. A "New ticket instead" toggle is there to opt out. The newest ticket shown by default does NOT continue: only one you pick explicitly does.
- **Resume**: failed claude tickets (`agentsMode === 'claude'`, or a legacy ticket with no mode but with sessions) show a Resume button, except when the reason is `not-a-git-repo`. It sends `POST /api/tickets/:id/resume` and shows a 409 inline.
- **Usage line** at the end of a finished ticket's feed: "12 turns · ~$0.84 estimated · 6 min" (`usageLine` in format.ts).
- **Agents badge** ("Claude Code" / "Simulated") in the drawer header. The Team dialog has a two-option radio switch that sends `PATCH {agentsMode}` straight away; a 409 shows inline and the radio stays as it was.
- CSS for all of the above in theme.css, keeping the dark terminal style.

## Tests
`npm test -w web`: 130 passed (13 new in `M2: real agents UI`). `npx tsc -p web --noEmit`: clean.
Two older tests asserted `calls` had length 0. They now filter out GET requests, because the drawer now fetches the claude status.

## Visual check
I ran my own server (5375, simulated, temp data) and Vite (5373), and took screenshots with tools/shot.mjs using tickets injected into the store: the git banner, the past list, Resume, the usage line, Continue, and the Team switch. All render correctly. I didn't screenshot the toolbar banner with a missing or logged-out status, because the real CLI on this machine is logged in.

## Concerns / notes
- The tests were written before the code, but I didn't run them red on their own before implementing (deadline).
- Which tickets get a Resume button is decided in the client; the server still has the final say (409 shown inline).
- The `assets` junction in the worktree isn't committed.
