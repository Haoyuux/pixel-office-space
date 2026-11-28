# Addendum: Autopilot — tickets run without waiting for the owner (2026-11-28)

## Why
The owner wants a project's tickets to go from request to merged without stopping for approvals.

## Approaches
1. **Auto-decide each gate as it opens (picked).** The gate card still appears and closes at once with the
   note "autopilot", so the feed shows what was decided. Reuses `decide()`; no new pipeline paths.
2. Skip gates entirely (no gate events) — less noise, but the feed loses the record of what was approved.
3. A separate "batch" mode that queues finished work for later review — not what was asked ("don't ask me").

## Design
- `Project.autopilot?: boolean` (missing = off). PATCH `{ autopilot: true|false }`; read fresh on every gate, so
  a change applies to running tickets at their next gate.
- Gate → automatic decision: plan → approved; install → approved; final → approved (merges into the checked-out
  branch; the existing merge refuses on uncommitted changes); stuck → one `retry` per ticket with the note
  "Autopilot: one more round — the last fixes did not converge, try a different approach.", after that the stuck
  card waits for the owner.
- UI: ⋯ menu item "Autopilot: on/off"; `/autopilot [on|off]` (no arg toggles); header badge "autopilot" when on.

## Anti-goals
Accepting or cancelling stuck work automatically; auto-merging over uncommitted owner changes.
