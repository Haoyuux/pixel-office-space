# Addendum: multi-repo projects

Date: 2026-11-27 · Status: approved by owner ("make it a single project, I don't want to separate both") · Amends the
M2 real-agents design (§4 git, §5 flow, §6 tools, §9 UI).

## Why
The owner's HRMS project is a parent folder (`D:\Project\HrmsSP2`) holding two independent git repos — `angular/`
(Bitbucket `hrms_frontend_sprint2`) and `aspnet-core/` (Bitbucket `hrms_backend_sprint2`), both on branch
`tlmtimesheet`, managed with Sourcetree. One ticket must be able to change both.

## Repo detection
- A project's folder is a **single-repo project** if it is itself inside a git work tree (existing behaviour).
- Otherwise, scan its direct subfolders (depth 1; skip `node_modules`, `.git`, dot-folders) for git repos with at
  least one commit → a **multi-repo project** with `repos: [{ name: '<subfolder>', path }]` sorted by name.
- Neither → the existing "not a git repo" failure, but the message and the **Initialize git** banner only appear in
  this case. Never offer Initialize git when sub-repos exist.
- Detection runs at project add/update and again at every ticket start (repos may be added later). `Project` gains
  optional `repos?: { name: string; path: string }[]` (absent = single repo). Exposed in the API and snapshot.

## Workspace per ticket
- `<dataDir>/worktrees/<projectId>/<ticketId>/` is a plain folder (the *workspace*); for each repo a worktree is
  created at `<workspace>/<repo.name>` on branch `office/<slug>-<id6>` (same name in every repo; if a repo needs a
  collision suffix, record the actual branch per repo) from that repo's current branch/HEAD (base per repo).
- Copy the owner's `<folder>/.claude/agents/*.md` into `<workspace>/.claude/agents/` (workspace root is not a repo,
  so nothing to exclude there). Single-repo projects keep today's layout (workspace = the one worktree).
- All non-PM stages run with cwd = the workspace, so plan paths like `angular/src/...` resolve the same as in the
  owner's folder. The PM keeps cwd = the owner's folder.
- Persist per-ticket `workspace: { path, repos: [{ name, path, branch, base, detached }] }` in the ticket log (extends
  the existing `ticket.workspace` event) so resume/follow-up/cleanup work after restart.

## Commits, diff, merge
- After each stage: `commitAll` in every repo worktree (skip ones with no changes).
- Diff: per repo `diff(repo, base, branch)`, file paths prefixed with `<repo.name>/`; the Changes tab groups by the
  first path segment.
- Final approval: **preflight all repos that changed** (clean — ignoring `.claude/agents|office` untracked files —
  base branch checked out, not detached). If any fails → merge none; ticket done with per-repo instructions. If all
  pass → merge each changed repo (`--no-ff`, as today). If a merge fails part-way (conflict), stop, report which
  repos were merged (with `git revert -m 1 <sha>` lines) and which weren't (with manual merge commands). Repos with
  no changes are never merged. Never push.
- Cancel/cleanup removes every repo worktree and the workspace folder; branches are kept.

## Agent tools (all roles that need them; Bash + PowerShell forms)
- Reviewers: add `git -C * diff *`, `git -C * log *`, `git -C * status *`.
- Developers/QA: add `dotnet *` (build/test the ASP.NET backend), `git -C * status *`, `git -C * diff *`, and
  `cd *` (so `cd angular && npm test` passes compound-command checks; every part must still be allowed).
- Review prompt additionally receives the combined diff summary (file list + per-file +/− counts) from the server.
- Prompts tell agents the repos and their subfolders when the project is multi-repo.

## UI
- Add Project / Team dialog: after a folder is chosen (on save), show "Repos found: angular, aspnet-core" (from the
  API response), or "Not a git repo — Initialize git" only when none.
- Drawer header: repo chips (`angular · aspnet-core`) next to the agents badge.
- Changes tab: files grouped under repo headings.

## Must still hold
Everything in the M2 design: owner's files untouched before final approval; never push; merge only when clean and on
a branch; no API key; tests never call the real CLI.
