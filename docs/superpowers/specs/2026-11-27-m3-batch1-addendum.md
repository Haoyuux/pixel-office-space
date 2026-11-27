# Milestone 3, batch 1: notifications, summary board, team memory, moods

Date: 2026-11-27 · Status: approved by owner ("go 1-4").

## 1. Notifications (web only)
- Browser Notification API + a short soft chime (WebAudio, no asset file). Trigger on: gate.open (any gate) →
  "<Project>: needs your approval"; ticket.answered → "<Project>: answer ready"; ticket.done (change ticket) →
  "<Project>: done"; ticket.failed → "<Project>: failed — <reason>". Skip when the document is visible AND that
  conversation is the one open. Clicking a notification focuses the tab and opens that conversation.
- Permission: a 🔔 toolbar button requests permission on first click; then toggles sound on/off (persist in
  localStorage, wrapped in try/catch). Tab title shows "(N) Pixel Office" for unseen items; cleared when viewed.

## 2. Summary board
- Server: `GET /api/summary?since=<ISO>` → `{ since, projects: [{ projectId, name, finished, failed, answered,
  waiting: [{ ticketId, rootId, title, gate }], items: [{ ticketId, rootId, title, kind:'chat'|'ticket', status,
  at }], usage: { turns, costUsd, durationMs } }], totals }` computed from ticket logs (events with ts ≥ since; usage
  from ticket.usage; waiting = currently open gates regardless of since). Behind the existing guards.
- Web: "📋 Summary" toolbar button + panel (modal-ish, dark terminal style): per project cards with counts, the
  waiting list first (click → opens that conversation), recent items, usage line ("uses your Claude plan ≈$x at API
  rates, not charged"). Auto-opens on the first visit of a calendar day if anything happened since the last visit
  (lastVisit in localStorage). Clicking the cafeteria cork board opens it (cork tooltip stays on hover).

## 3. Team memory
- Store: `<dataDir>/memory/<projectId>.json` = `{ entries: [{ id, text, source: 'owner'|'pm', ticketId?, at }] }`
  (max 60 entries, each ≤ 300 chars). NOT in the owner's repos.
- API: `GET /api/projects/:id/memory`, `POST /api/projects/:id/memory {text}`, `PATCH .../memory/:entryId {text}`,
  `DELETE .../memory/:entryId`; event `memory.updated { projectId }`.
- Prompts: every agent prompt (plan, stages, review, test, answers) includes a `<team-memory>` block with the entries
  (data, not rules beyond what they say).
- Learning: the PM's plan JSON and answer JSON may include `"memory": ["short lesson", ...]` (≤ 3, each ≤ 200 chars;
  only durable project facts/rules learned, never ticket-specific details). The server appends them (source 'pm',
  de-duplicated case-insensitively) after the ticket/answer completes.
- Web: a "Memory" tab in the drawer (list with edit/delete, add box) and `/memory` slash command opening it.

## 4. Moods and personalities (web only)
- Fixed personality per character name (12): e.g. coffee lover (prefers coffee), gamer (arcade spots), bookworm
  (reading-nook spots), social (chat), foodie (cafeteria tables/bar), chill (lounge sofas), early bird, night owl
  (night weights) — implemented as per-bot multipliers on the officeLife activity weights (still respecting caps,
  cooldowns and feasibility). Shown in the hover label: "Clara · QA Engineer · coffee lover · 😊".
- Mood state per bot derived from director events: happy after its ticket is done/answered (😄 emote bubble a few
  times over the next minutes), grumpy after a review/QA bounce on its work (😤 once), tired after > 10 min of
  continuous work (😮‍💨; its next idle activity is coffee or lounge with high priority). Mood decays back to neutral
  after ~5 min. Emotes use the existing bubble system and never override work bubbles (…, !, ✓, ✗).

## Must still hold
Existing invariants; tests never call the real CLI; memory never written into the owner's repos.
