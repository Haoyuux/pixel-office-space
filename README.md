# Pixel Office

A local, personal command center: your projects as rooms in a cozy isometric pixel-art office, staffed by AI bot teams.
Milestone 1 runs a **simulated** ticket pipeline; milestone 2 will plug in real Claude Code agents.

## Art packs (not in git — licences forbid redistribution)

Put the unzipped packs here:

```
assets/
  characters/OfficeCharacters_Basic_v1.0/        (Office Characters by Meru Stack)
  office/Isometric_Pixel_Props/                  (Isometric Pixel Props by romegd)
  office/neon-office-free/                       (optional accents, NEON OFFICE by Elaia Studio)
```

## Run

1. `npm install`
2. Put the art packs in `assets/` (layout above).
3. `npm run dev` (starts the server and Vite together)
4. Open http://127.0.0.1:5173

The server listens on 127.0.0.1:5175 (Vite proxies `/api`, `/ws`, `/assets`) and keeps data in `server/data/`.
Environment overrides: `OFFICE_DATA` (data dir), `OFFICE_PORT`, `OFFICE_STAGE_MS="min,max"` (simulated stage length in ms).

## Test

```
npm test                                   # unit tests, all packages
npx tsc -p web --noEmit                    # type-check the web app
node tools/e2e.mjs                         # full walkthrough: starts server + Vite + headless Chrome, prints "e2e ok", screenshots to shots/
node tools/shot.mjs <url> <out.png> [js]   # one headless screenshot once the page reports READY
```

The e2e needs Chrome at `C:/Program Files/Google/Chrome/Application/chrome.exe` and free ports 5173 and 5175.
`spike/v2.html` is the original visual reference for the look of the office.

## Real agents (milestone 2)

Each ticket now runs through real Claude Code agents (one `claude -p` process per role):

1. The PM reads the project and proposes a plan. You approve it (or ask for changes).
2. Devs (frontend, backend, ...) work in a separate **git worktree on their own branch** (`office/<ticket>`), never in your working copy.
3. Review (tech lead / security) and test (QA) run on that branch. Problems bounce back to the devs; after 3 bounces you decide (retry / accept / cancel).
4. You see the diff and approve the final gate. Only then is the branch merged into your base branch. **Pixel Office never pushes.**

**Requirements**
- Claude Code installed and logged in with your normal subscription: run `claude`, then `/login`. Do not set `ANTHROPIC_API_KEY`.
- The project folder must be a git repo. For a plain folder use the **Initialize git** button.

**Usage note.** Real tickets count against your Claude subscription. The costs shown in the UI are the CLI's estimates, not a bill.

**Simulated mode.** The Team dialog has a per-project **Simulated** switch for the old fake pipeline. `OFFICE_AGENTS=simulated` makes every project simulated (used for demos and `tools/e2e.mjs`).

**Resume / Continue.** A failed or interrupted ticket can be resumed, and you can continue a finished conversation; agents pick up their previous Claude sessions.

**Where things live.** Worktrees and branches: `server/data/worktrees/<project>/<ticket>` (branch `office/...`). Ticket logs: `server/data/tickets`.

**Undo.** The merge is a normal `--no-ff` merge commit, so `git revert -m 1 <merge-sha>` undoes it.

**Live check (opt-in, costs subscription usage).** `cd server && OFFICE_LIVE=1 npx vitest run test/claude-live.test.ts` runs a real ticket in a temp repo.
