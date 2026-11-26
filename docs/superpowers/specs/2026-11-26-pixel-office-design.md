# Pixel Office — Design

Date: 2026-11-26 · Status: approved by owner

## 1. Intent

A personal, local-only command center for one developer (the owner) to organise several software projects.
The whole thing is a cozy pixel-art **isometric office building**. Every project the owner registers becomes a
**room** in that building, staffed by a small **team of AI bots** (Project Manager, Tech Lead, Frontend Dev, …).
The owner clicks a room to open a terminal-style drawer, sends a **ticket**, and watches the team route and work it.
When there is no work, bots live a normal office life: coffee runs, chats at the water cooler, sofa time, wandering.

Why: the owner juggles multiple projects and wants one glanceable, pleasant place to see and drive all of them.

Delivered in two milestones:

- **M1 — The Office (this design, built now):** the full building, rooms per project, office life, the drawer,
  and a **simulated** ticket pipeline that emits exactly the same events real agents will.
- **M2 — Real agents (outlined in §12, designed separately later):** the simulated pipeline is swapped for Claude Code
  agents running inside each project's folder. The office and drawer do not change.

### Goals
- One continuous building that grows a new room per project, joined by a checkered hallway, with a shared breakroom.
- Bots that feel alive when idle and visibly go to work when a ticket starts.
- A drawer per project that reads like a Claude Code conversation (feed, raw log, changes, plan) with approvals.
- Day/night toggle; pan/zoom camera with "Fit Building"; stays easy to navigate with 6+ projects.

### Non-goals (M1)
- No real Claude calls, no edits to the owner's code (M2).
- No multi-user, no auth, no cloud hosting. Runs on `localhost` only.
- No mobile layout. Desktop browser only.

### Anti-goals (would make it a failure even if it "works")
- Messy or nonsensical rooms (furniture facing walls, overlapping props, clutter) — the owner reviewed this closely.
- Bots standing awkwardly at desks instead of reading as seated.
- Night mode that looks broken: black frames, glowing blobs in the sky, washed-out furniture, or a gloomy interior.
- Raw-log firehose as the only view of agent work.

## 2. Constraints

- **Platform:** Windows 11 dev machine, Node 22, Chrome. Local only.
- **Assets** (already in `assets/`, unzipped):
  - `assets/office/Isometric_Pixel_Props/` — main prop/wall/floor pack. 128 px per metre, 2:1 iso, **8 views per piece**,
    `pieces.csv` gives sprite size, real size (m), ground point and anim frame count. Animated pieces have a 16-frame strip.
  - `assets/characters/OfficeCharacters_Basic_v1.0/` — 12 characters × 3 palettes (a/b/c), 8 directions,
    clips `idle`, `walk`, `drinking`, `waving`, `still`. **Use the `2x/` sheets** (168×248 frames) — they are 128 ppm,
    the same scale as the props.
  - `assets/office/neon-office-free/` — accent pieces only (e.g. arcade cabinet, neon signs). Different scale (48 ppm);
    any use must scale it to match. Optional.
- **Licences:** all packs are free for personal and commercial use, but **forbid redistributing the files**.
  `assets/` must never be committed to a public repo (git-ignore it; document where to put the packs).
- **No sitting animation exists** in the character pack (see §6.4 for the approved fake-sit).

## 3. Approaches considered

| Decision | Options considered | Chosen | Why |
|---|---|---|---|
| Rendering stack | (a) React + PixiJS + Node server, (b) Phaser, (c) plain canvas | **(a)** | Pixi is fast for thousands of sprites/zoom/blend modes; React suits the drawer/forms; Phaser wants to own the page; plain canvas means rebuilding sprite/zoom/glow by hand. |
| Art | code-drawn building + sprites; all code-drawn; one asset pack | **Isometric Pixel Props pack for walls, floors and props**, code-drawn only for the checkered hallway and thresholds | The pack has 2 m wall modules, 2×2 m floors and 8 views per prop, which solved facing and seams. Verified in the spike. |
| Idle behaviour | (1) activity spots + weighted picker, (2) behaviour trees, (3) fixed schedules | **(1)** | Simple, tunable, data-driven; new rooms bring their own spots; tickets can interrupt cleanly. Trees are heavy to author; schedules are dull and brittle. |
| Agent delivery | real agents first; simulated first; office then real | **Office first (simulated), then real agents** | Owner sees the office sooner; the event contract is fixed from day one so the swap is clean. |

## 4. Architecture

```
space-project/
  assets/            (git-ignored; art packs, see §2)
  server/            Node 22 + TypeScript: Express (REST) + ws (WebSocket)
    data/projects.json         project registry
    data/projects/<id>/tickets/<ticketId>.jsonl   event history per ticket
  web/               Vite + React + TypeScript + PixiJS v8
  docs/
```

- The server serves REST + WebSocket on one port; Vite dev server proxies to it. Assets are served read-only from
  `assets/` by the server (or Vite `publicDir`) — builder's choice.
- **One WebSocket** per browser. Server broadcasts all events; the client routes them by `projectId`.
- **Orchestrator interface** (server): `startTicket(project, text)`, `approve(ticketId, gate, decision, note?)`,
  `sendMessage(ticketId, text)`, `cancel(ticketId)`. M1 implementation = `SimulatedOrchestrator`; M2 = `ClaudeOrchestrator`. Both emit the
  events in §9 and nothing else reaches the client.

## 5. The building

### 5.1 Grid & projection (measured in the spike — use these numbers)
- World unit = metre. Screen projection for 128 ppm art: `x = (mx - my) * 91`, `y = (mx + my) * 45.5`, height `z * 111`.
- Every sprite anchors at its `ground_x/ground_y` from `pieces.csv`.
- **View index → facing** (direction the front of the piece points): `0 = +y (screen down-left)`, `2 = −x (up-left)`,
  `4 = −y (up-right)`, `6 = +x (down-right)`; odd views are the 45° in-betweens (`3` faces straight up-screen,
  `7` straight down-screen). Wall modules: view 0 runs along x, view 2 runs along y.
- Depth sort: `zIndex = screen y of ground point + small per-object bias`; floors at a fixed very low z; back walls low z.
  Items on top of furniture use `lift` (metres up) and a positive bias.
- Rendering uses nearest-neighbour scaling, integer-friendly zoom steps preferred.

### 5.2 Layout (generated from `projects.json`)
```
            (back wall, solid, windows)
  x →   [ Project 1 (left) ][ HALL ][ Breakroom (right)   ]   y 0–8
        [ Project 3 (left) ][ HALL ][ Project 2 (right)   ]   y 8–16
        [ Project 5 (left) ][ HALL ][ Project 4 (right)   ]   y 16–24
                         ↓ hallway grows toward the camera
```
- **Hallway**: 2 m wide, runs along y, black/white 0.5 m checker (code-drawn). Its length = the deepest wing.
- **Breakroom**: first right-hand wing at the entrance (top of the hallway), 10 × 8 m. Layout as approved in the
  spike (`spike/v2.html`): kitchen run on the back wall (sink + espresso + capsule coffee, mini fridge, vending,
  water cooler, cork board), family table centre (Meeting_Table, 6 Meeting_Chairs, food, fairy jar), cafe bar
  (High_Table_Stools) under the string-lights window, lounge corner (Sofa_Modular facing two Lounge_Chairs across a
  Coffee_Table with lava lamp, aquarium on a Pedestal_Drawer, arc lamp, paper lantern), plants in corners. **No TV.**
- **Project rooms** alternate sides: 1st left, 2nd right (below the breakroom), 3rd left, … Each room is 8 m deep;
  **every room is the same size, 14 × 8 m, built for the full 9-role catalogue** (owner's choice: rooms never resize).
Layout: the **PM desk** stands on its own at the front by the whiteboard; **8 team desks** in 2 rows × 4 columns
(columns 3.2 m apart). Desks whose role isn't on the team are rendered as **empty desks with a chair** (no monitor glow). Left rooms extend left from the hallway,
  right rooms extend right. Floor = `Floor_Carpet_2x2`; the room's accent neon colour tints its nameplate/glow.
- **Walls**: solid wall modules (mix of `Wall_2m`, `Wall_Window_2m`, `Blinds_Window_2m`) only on the outer **back**
  edges (y = 0 for the first row; x = min for left rooms). Camera-facing edges are cut away (not drawn).
  **Interior walls** (room↔hallway, room↔room) are `Glass_Partition_2m` so nothing behind them is hidden.
- **One room template for both sides (designer's call, replaces mirroring):** all room furniture is positioned in
  local coordinates measured from the room's x-min edge and y-min edge, and every wall-adjacent piece stands on one
  of those two edges facing **into the room and toward the camera** (view 6 on the x-min edge, view 0 on the y-min
  edge). For a left room the x-min edge is the solid outer wall; for a right room it is the hallway glass (pieces
  there are free-standing 0.4 m in front of it and avoid the doorway span). Desks use the same local positions on
  both sides. "Nothing may face a wall" applies to glass too.
- **Nameplate:** a code-drawn neon text sign hung **above the room's doorway on the hallway glass**, readable from the
  hallway, for every room (left or right, any row). No solid wall segment is needed.
- **Doorway**: each room gets a 2 m opening in its hallway partition (centred on the room's depth) with a wooden
  threshold strip.
- Removing a project removes its room; later rooms do **not** shift (keep a stable slot index per project in
  `projects.json`, so the office doesn't rearrange itself). Empty slots render as empty floor-less gaps; the
  hallway still spans them. *(Builder may instead compact on removal if simpler — owner preference is stability.)*

### 5.3 Room interior (per project)
- Desks in two rows facing the camera (approved "sitting" layout): `Desk_Straight` view 4; single `Monitor` view 4
  centred on the desk facing the bot; `Keyboard_Mouse` view 4 on the bot's side; `Ergo_Chair` view 0 **behind** the
  bot. Columns 3.2 m apart, rows at y≈2.0 and y≈5.2 inside the room, bot seat 0.75 m behind the desk.
- Role desk items: PM — Planner + Sticky_Notes; Tech Lead — Headphones + Trophy slot; Frontend — **Dual_Monitor_Arm** (instead of the single
  Monitor) + VoIP_Phone + Headset_Stand + Mug; Backend — **Dual_Monitor_Arm** + VoIP_Phone + Headset_Stand + Mini_PC; QA — Document_Tray + Sticky_Notes; UI/UX — Tablet_Stand + Photo_Frame;
  DevOps — Wifi_Router (+ Server_Rack in the room corner); Security — Notebook + Phone; Writer — Notebook + Pen_Cup.
- Fixed furniture: `Open_Shelf` and `Cubby_Shelf` against the room's outer side facing into the room (view 6 on a left room's x-min wall; free-standing in front of glass where there's no solid wall — see §5.2),
  `Whiteboard_Mobile` (shows the current ticket title as a small text overlay), `Recycle_Bins` in the front-left
  corner, 2–3 plants (`Monstera`, `Fiddle_Leaf`, `Snake_Plant`) in corners, and a **project nameplate** (see §5.2; the pack's `Neon_Sign` says "BAR", so it can't be the nameplate).
- **Nothing may face a wall.** Every wall-adjacent piece must use the view that faces into the room.

### 5.4 Interaction
- Hover a room: its floor border highlights faintly in its accent colour. Click anywhere in its bounds: open its drawer.
- **Selected room** (the one whose console is open): a steady glowing floor outline plus a soft floor tint in its accent
  colour, its nameplate brightened, and a small bobbing "viewing" marker (👁) above the nameplate. Other rooms are not
  dimmed. The drawer header uses the same accent colour, so the link between room and console is obvious.
- **Each project has its own console**: separate feed, raw log, changes, plan, ticket queue and history. Clicking another
  room swaps the console to that project; tickets in other rooms keep running, and their rooms keep showing status
  badges (`… working`, `⏸ 1 waiting`, `✓ done`). Closing the drawer clears the selection.
- Click a bot: open its project's drawer filtered to that role.
- Hover a bot: name + role label.

## 6. Characters

### 6.1 Roles & teams
- Role catalogue: **Project Manager (always on)**, **Tech Lead, Frontend Dev, Backend Dev, QA Engineer (default on)**,
  UI/UX Designer, DevOps, Security Reviewer, Tech Writer (optional).
- Team is chosen per project at creation and editable later from the drawer ("Team" button).
- **Every room has a desk for every role in the catalogue**, fixed positions per role, so rooms never resize and
  neighbouring rooms never move. Roles not on the team leave their desk empty (desk + chair, monitor off).
- **Adding a member:** the new bot enters from the hallway door, walks to its (already present) desk, sits, waves.
  Its monitor and desk items appear.
- **Removing a member:** the bot stands, walks out down the hallway and disappears; its desk goes back to empty.
  Removing is blocked while that role is busy on a running ticket.
- Team members not needed by the current ticket keep their desk and keep living normal office life (§7).

### 6.2 Character assignment
- Each role in each project gets a `(character, palette)` pair, unique across the building until all 36 are used,
  then reused. Stored in `projects.json` so a bot keeps its look.

### 6.3 Animation
- Clips from `2x/` sheets: rows = `S, SW, W, NW, N, NE, E, SE`. Walk speed ≈ 1.2 m/s; facing from movement vector.
- Status bubble above head: `…` working, `!` needs you, `✗` failed, `✓` done (fades after a few seconds), `💬` chatting.

### 6.4 Sitting (approved fake-sit)
- Crop each frame at the hip line (y = 172 of 248), anchor at the crop bottom, lift by 0.42 m. Bot faces the camera
  (`SW`), the desk/table in front hides the cut, the chair is drawn behind (z bias −2). Same trick at the family table
  (far-side chairs) and lounge seats that face the camera. Seats facing away from the camera are not used for sitting.

## 7. Office life (idle behaviour)

### 7.1 Activity spots
Every interactive place declares a spot: `{ id, cell, pose: sit|stand|drink, facing, capacity, tags, room }`.
Spots come from the breakroom template and from each project room (own desk seat, whiteboard, shelf).

| Activity | Spot(s) | Pose / clip | Duration | Weight (day / night) |
|---|---|---|---|---|
| Desk time (browse/"play" on screen) | own desk seat | sit / idle, monitor shows a little game | 30–90 s | 4 / 2 |
| Coffee run | espresso / capsule / cooler | stand → drinking | 15–30 s, then to table or desk | 3 / 2 |
| Snack at family table | far-side table chair | sit / drinking or idle | 30–60 s | 2 / 2 |
| Cafe bar | stools area | stand / drinking | 30–60 s | 1 / 3 |
| Lounge | sofa / armchairs (camera-facing seats only) | sit / idle | 40–90 s | 2 / 4 |
| Water-cooler or lounge **chat** (social) | two adjacent spots | stand or sit, face each other, 💬 | 20–40 s | 2 / 3 |
| Wander | hallway, cork board, wave at a passing bot | walk / waving | 10–20 s | 2 / 1 |

- Picker: weighted random over currently free spots, with a per-bot cooldown on the last 2 activities.
- Social: initiator reserves two spots and invites a free bot (any project, preferring same project 60%).
- At most ~60% of idle bots outside their own room at once, so rooms never look abandoned.
- Spots are **reserved** while walking to them; never two bots on one spot.

### 7.2 Pathfinding
- Walk grid: 0.5 m cells over all floor. Blocked = furniture footprints (`size_x × size_y` from `pieces.csv`, rotated
  by view), wall lines, glass partitions; doorways open. Spot cells stay walkable.
- A* with 8-directional moves, no corner cutting. Recompute when the building changes.
- Bots don't collide with each other (soft: allowed to pass through), but two bots never target the same spot.

### 7.3 Work interruption (designer's call)
- Ticket start: **only the PM** is summoned (walks to the whiteboard, then its desk). Everyone else keeps living.
- While the plan gate waits: the PM stays seated with `!`; the rest keep living.
- Plan approved: **every role with a task** is summoned at once, walks to its desk and **stays seated until the ticket
  ends** (done / failed / cancelled), showing `waiting` between its own stages. The Tech Lead leaves its desk only to
  stand beside a dev's desk during review, then returns.
- Roles with no task in the plan are never summoned for that ticket.
- On ticket end, all summoned bots return to idle life (after the "done" wave).

## 8. Tickets (M1 simulated pipeline)

Stages and who works them (skipping roles that aren't on the team or not needed by the plan):

1. **Plan** — PM ("planning"; walks to the whiteboard, then sits). Produces a plan: summary, acceptance criteria,
   affected areas, tasks per role.
2. **Gate: approve plan** — owner. Badge "⏸ 1 waiting" on the room and a card in the feed.
3. **Design** — UI/UX if on team and the plan has UI tasks ("designing").
4. **Build** — Frontend and Backend in parallel ("coding"); DevOps if on team and tasked.
5. **Review** — Tech Lead walks to each dev's desk, stands beside it ("reviewing"); may bounce back to a dev
   (max 3 bounces, then a **stuck gate**). Security reviewer joins here if on team.
   Stuck gate (designer's call) offers three decisions: `retry` (one more round with the owner's note, bounce counter
   resets), `accept` (ignore the open review comments and continue to Test), `cancel` (end the ticket as cancelled).
   The same gate opens if QA bounces 3 times.
6. **Test** — QA ("testing"); may bounce back to the owning dev.
7. **Docs** — Tech Writer if on team.
8. **Gate: approve final changes** — owner reviews the Changes tab.
9. **Done** — team does a short wave, a trophy appears on the room shelf (max 5 shown), the cork board updates.

M1's simulated orchestrator fakes plausible content: plan text derived from the ticket text, tool-call lines
("Read src/…", "Edit … (+12 −3)"), a fake diff, random but bounded bounce chances, realistic timings (stage 10–40 s).
One ticket runs per project at a time; new tickets queue.

## 9. Event contract (server → client, WebSocket)

All messages: `{ type, projectId, ticketId?, ts, ... }`.

- `project.added | project.updated | project.removed` — full project object.
- `ticket.created` — `{ title, text }` · `ticket.stage` — `{ stage, roles[] }` · `ticket.done | ticket.failed | ticket.cancelled`.
- `agent.state` — `{ role, state: idle|summoned|planning|designing|coding|reviewing|testing|documenting|waiting|done|failed }`.
- `agent.message` — `{ role, text, streaming: bool, messageId }` (streamed in chunks; client concatenates).
- `agent.tool` — `{ role, tool: Read|Edit|Write|Bash|Grep|…, summary, detail?, status: running|ok|error, toolId }`.
- `gate.open` — `{ gate: plan|final|stuck, payload }` · `gate.closed` — `{ gate, decision, note? }` where decision is
  `approved|changes` for plan/final and `retry|accept|cancel` for stuck.
- `snapshot` — sent to a socket **on connect**: all projects, each project's current ticket (stage, agent states,
  open gate, plan) and queue. The client rebuilds office state from it (designer's call).
- `ticket.plan` — structured plan · `ticket.diff` — `{ files: [{ path, patch }] }`.
- `log.raw` — `{ role, line }` (everything, for the Raw log tab).
- `user.message` — `{ text }` (the owner's mid-ticket message, echoed into the feed).

Client → server is REST: `GET/POST/PATCH/DELETE /api/projects`, `POST /api/projects/:id/tickets`,
`POST /api/tickets/:id/gates/:gate` `{ decision, note }`, `POST /api/tickets/:id/messages` `{ text }`,
`POST /api/tickets/:id/cancel`,
`GET /api/projects/:id/tickets?limit=` (history replay on drawer open).

Server persistence: event JSONL per ticket plus an in-memory current state rebuilt from the JSONL on start. On server
restart, in-flight tickets are marked `failed` with reason `interrupted` (M1); queued tickets stay queued.

Idle office life is **client-side only** (purely cosmetic) and never goes over the wire.

## 10. UI

### 10.1 Canvas chrome
- Top-left: `+ Add Project`, `Fit Building`, `☀/🌙` toggle. Day/night defaults to the local clock (night 19:00–06:00),
  manual toggle overrides for the session. *(Builder's call on exact times.)*
- Camera: drag to pan, wheel to zoom around the cursor (0.2×–2×), Fit Building frames the whole building with margin.

### 10.2 Add Project dialog
- Name, folder path (server validates it exists and is a directory), accent colour (cyan / magenta / amber / …),
  team checkboxes with the defaults ticked and PM locked.
- On create the server: writes the project to `projects.json`; creates `<folder>/.claude/agents/<role>.md` for each
  team role **only if the file doesn't already exist** (never overwrite the owner's files); broadcasts `project.added`.
  Agent file content in M1 = role description + intended tool permissions (§12 table), so M2 can use them as-is.

### 10.3 Project drawer (slide-over from the right, ~560 px, dark terminal style, monospace)
```
┌──────────────────────────────────────── SHOP ─────────────────────── ✕ ┐
│ 🎫 Forgot-password link        PM ✓ ─ Design ✓ ─ Dev ● ─ Review ─ QA     │
│ [ Feed ] [ Raw log ] [ Changes ] [ Plan ]           filter: All roles ▾  │
├─────────────────────────────────────────────────────────────────────────┤
│ 🧑‍💼 PM 11:02  Read 14 files · wrote plan (4 tasks)              ▸        │
│ ┌─ ⏸ WAITING FOR YOU ───────────────────────────────────────────────┐   │
│ │ Plan: …                         [ Approve ] [ Request changes ]    │   │
│ └────────────────────────────────────────────────────────────────────┘   │
│ 💻 Frontend 11:05  ● Edit Login.tsx (+12 −1)                    ▸        │
├─────────────────────────────────────────────────────────────────────────┤
│ > new ticket or reply…                                          [Send]   │
└─────────────────────────────────────────────────────────────────────────┘
```
- **Feed**: per-role messages streaming in; tool calls collapsed to one line, expandable; gate cards inline.
- **Raw log**: every `log.raw` line, auto-scroll with pause-on-scroll-up.
- **Changes**: file list + unified diff per file.
- **Plan**: rendered plan + acceptance criteria.
- Pipeline bar shows stage status; ticket queue/history selector in the header.
- **Input box (owner decision, designer's pick):** with no ticket running, it creates a ticket. While a ticket runs, it
  sends a message to the team (`sendMessage`): the bot currently working acknowledges it in the feed and takes it into
  account (M1 simulated: an acknowledgement line from the active role, or the PM between stages). A small
  "New ticket instead" toggle next to Send queues it as a new ticket.
- "Request changes" sends a note back (PM re-plans, or the relevant dev reworks at the final gate).

## 11. Look & lighting (approved in spike)
- Day: untinted sprites, light blue-grey background.
- Night: every world sprite tinted `#a39ac4` (gentle evening dim — interior stays readable); dark navy sky with
  stars and a crescent moon; **floor light pools** (additive radial gradients) drawn just above the floor and under
  furniture, masked to the floor polygon; small **halos** only at real lamps (fairy jar, string lights, arc lamp, lava
  lamp, aquarium, paper lantern, room nameplates) masked to the building silhouette. Desk monitors cast a small blue
  floor pool **only while that bot is working**; ceiling-light pools are warm amber.
- Animated props (`Monitor`, `Wall_Clock`, `Aquarium`, `Lava_Lamp`, `Water_Cooler`, `Vending_Machine`) play their
  16-frame strips. Monitors show their animated strip only while working or during "desk time"; otherwise static.

## 12. M2 outline (real agents — separate design later)
- `ClaudeOrchestrator` runs each role as a Claude Code agent (Claude Agent SDK) **inside the project folder**, using the
  `.claude/agents/<role>.md` definitions, on a **git branch per ticket**.
- PM onboarding scan on project add writes `.claude/office/project-map.md` (module → owner role); every plan starts from it.
- PM returns a structured plan (JSON) that the server uses to route tasks.
- Tool permissions: PM read-only; UI/UX read + design notes; Tech Lead read + read-only git; Devs read/edit/run;
  QA read + test files + run tests; DevOps read/edit infra + run; Security read-only; Writer read + docs.
- Two owner gates per ticket (plan, final changes); bounce limit 3.
- Everything an agent reads is sent to Claude for processing; work stays inside the chosen folder.

## 13. Decided by the owner
- Local-only personal tool; React + PixiJS + Node; office first, real agents second.
- Isometric Pixel Props pack as main art; characters at 2x; camera-facing seated bots with chair behind; single monitor.
- Breakroom layout and the 8 m building depth; no TV; cork board at the end of the kitchen run.
- Night: interior lit, night read from the sky, windows and lamp glow.
- Activity spots + weighted picker for office life; the activity list in §7.1.
- Roles: PM always; Tech Lead/Frontend/Backend/QA default; UI/UX/DevOps/Security/Writer optional.
- Routing via PM plan; two approvals; drawer with Feed / Raw log / Changes / Plan tabs.

## 14. Calls made by the designer (owner to confirm while reading)
- Hallway along y with rooms alternating left/right; breakroom is the first right-hand wing.
- Room width by team size (8/10/12/14 m); stable slots on project removal.
- Interior walls are glass partitions; solid walls only on outer back edges.
- Nameplate is a code-drawn neon text sign (pack's neon sign reads "BAR").
- Activity weights/durations and the 60% "out of room" cap; social pairing prefers same project 60%.
- Day/night follows the local clock by default.
- One ticket per project at a time, others queue.
- One room template for both sides (no mirroring); wall-adjacent pieces on the x-min / y-min edges face the camera; nameplate above the doorway.
- Summoning: PM first, tasked roles after plan approval, seated until the ticket ends.
- Reconnect `snapshot` message; interrupted tickets marked failed on server restart.
- Stuck gate decisions: retry / accept / cancel.
- (Owner decision) Rooms are fixed 14 × 8 m with a desk per catalogue role; empty desks for roles not on the team.
- Deferred to later: rooftop/patio bar, meeting room, reception desk with "You" avatar, normal-map lighting,
  neon-pack accents.

## 15. Left to the builder
- Exact file/module structure inside `server/` and `web/`, state management choice in React, test framework.
- Asset serving mechanism; texture atlas/batching strategy.
- Exact walk speed, animation speeds, bubble art, colours of UI chrome (keep the dark terminal feel).
- Fine placement offsets of props within the templates, as long as §5.3 rules and the anti-goals hold.

## 16. Verification
- Unit tests: layout generator (room rects, doorways, slots), walk-grid + A*, activity picker (reservations,
  cooldowns, caps), simulated orchestrator state machine (stages, gates, bounces, queue), event schema.
- Visual checks with the headless screenshot script used in the spike (waits for `document.title === 'READY'`):
  1, 3 and 7 projects, day and night, and a ticket mid-flight. Check every anti-goal in §1.
