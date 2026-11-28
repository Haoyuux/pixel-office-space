# Autopilot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Per-project Autopilot that auto-decides plan/install/final gates and retries stuck once.
**Architecture:** `ClaudeOrchestrator.openGate(run, gate, payload)` replaces the four `gate.open` emits; after
emitting it calls `decide()` with the autopilot decision. Project flag stored via `ProjectStore.update`.
**Spec:** `docs/superpowers/specs/2026-11-28-autopilot-addendum.md`

## Global Constraints
- Flag name `autopilot` (boolean). Gate note for auto decisions: `autopilot`.
- Stuck retry note: `Autopilot: one more round — the last fixes did not converge, try a different approach.`

## Review Focus
- Autopilot turned on while a gate is already open → nothing auto-decides it (owner clicks); next gate is auto.
- Second stuck on the same ticket → waits for the owner (no loop).

### Task 1: Server
**Files:** `shared/src/types.ts`, `server/src/store.ts`, `server/src/orchestrator/claude.ts`; tests in
`server/test/store.test.ts`, `server/test/claude-orchestrator.test.ts`.
- [ ] Tests: store accepts `{autopilot:true}`, rejects non-boolean; orchestrator with `getProject` returning
  autopilot project: ticket reaches `done` with no owner decide, `gate.closed` decisions `[approved, approved]`
  with note `autopilot`; stuck: first stuck → auto retry (note reaches dev prompt), second stuck stays open.
- [ ] Implement, run `npm test -w server`, commit.

### Task 2: Web
**Files:** `web/src/ui/Drawer.tsx`, `web/src/ui/slash.ts`; test `web/test/ui.test.tsx` or slash test.
- [ ] Tests: `/autopilot` in COMMANDS; menu item toggles via PATCH `{autopilot: true}`.
- [ ] Implement badge, menu item, slash handling; `npm test`; tsc web; commit.
