# Addendum: the office installs packages for the team (2026-11-28)

## Why
Agents may not run `npm install`: a ticket's worktree links `node_modules` to the owner's checkout, so an install
would rewrite the owner's real folder. When a build needs a package (e.g. `motion/react` declared but never
installed), the agents can only *say* so, nothing changes between rounds, and review bounces until the stuck gate
fires. The owner then has to install by hand. Goal: the team gets the packages it needs without leaving the office.

## Goals / non-goals / anti-goals
- Goal: a missing package no longer stalls a ticket; the round continues after the install by itself.
- Goal: every install is visible in the chat (command, output, result).
- Non-goal: non-npm package managers (pnpm/yarn/pip/dotnet restore) in this step.
- Anti-goal: agents running npm against the owner's folder directly; two installs racing in one folder;
  the owner's `package.json` changing before they accept the ticket.

## Approaches
1. Agents run `npm install` themselves — simplest, but writes through the junction into the owner's
   `node_modules`, can prune packages the worktree's `package.json` lacks, and races between tickets.
2. **The office installs on request (picked).** Agents ask in their report; the office runs the install in the
   owner's folder, one at a time, and continues the round.
3. Per-ticket `node_modules` (no junction) — agents install freely, but a full install per ticket is slow/heavy and
   ▶ Run (owner's folder) still lacks the package.

Owner picked 2, with: packages already declared in the owner's `package.json` install **automatically**;
**brand-new** packages need the owner's OK first.

## Design
- **Ask:** agent JSON reports gain an optional `install` field: a list of package specs (`motion@^12.23.0`),
  or `[]` meaning "just run npm install". `SHARED_MODULES_RULE` changes from "say so in your report" to
  "never run npm install yourself; put what you need in `install`".
- **Sort:** for each repo unit with shared modules, the office compares the asked packages with the owner's
  `package.json`. Declared (or empty list) → automatic. Not declared → new.
- **Automatic:** office runs `npm install` in the owner's repo folder. Output streams into the ticket feed as one
  collapsible "📦 npm install" block; failure text goes back to the agent in its next prompt.
- **New:** a card in the feed — "Frontend wants to add `motion@^12.23.0` — Install / Skip". Install runs
  `npm install --no-save <specs>` in the owner's folder (owner's `package.json` untouched; the worktree's
  `package.json` change ships with the ticket). Skip tells the agent the owner declined.
- **One at a time:** a per-folder lock shared with the Run tab's install, so ticket installs and ▶ Run installs
  never overlap.
- **Continue:** after a successful install the same round re-runs (build/test/review) without counting as a bounce.
- **On accept:** after merging, if `package.json` changed, run `npm install` in the owner's folder so
  `package-lock.json` catches up.

## Left to the builder
Exact report schema wiring, the feed event shape, how the card reuses the gate UI, install timeout, and tests.
