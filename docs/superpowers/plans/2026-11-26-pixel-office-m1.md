# Pixel Office — Milestone 1 (The Office) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A local web app that renders the owner's projects as rooms in one isometric pixel-art office building, with living bots, a per-project terminal-style console, and a simulated ticket pipeline that emits the same events real agents will in M2.

**Architecture:** npm workspaces monorepo. `shared/` holds the role catalogue and the event/REST types. `server/` (Node + Express + ws) owns `projects.json`, scaffolds `.claude/agents/`, runs the `SimulatedOrchestrator` and broadcasts events (with a `snapshot` on connect). `web/` (Vite + React + PixiJS v8) builds the building layout from the project list, renders it, runs office life client-side, and shows the console drawer.

**Tech Stack:** TypeScript 5, Node 22, Express 4, ws 8, Vite 5, React 18, PixiJS 8.6.6, zustand 4, vitest 2, supertest.

**Spec:** `docs/superpowers/specs/2026-11-26-pixel-office-design.md` (read it before any task; section numbers below refer to it). The approved visual prototype is `spike/v2.html`, which holds exact, owner-approved prop placements and lighting values.

## Global Constraints

- Local only: the server binds `127.0.0.1`. No auth. Desktop Chrome.
- `assets/` is never committed (the licences forbid redistribution). Add it to `.gitignore` and document in `README.md` where each pack goes.
- Projection: `x = (mx - my) * 91`, `y = (mx + my) * 45.5`, height `z * 111` (metres to screen px at 128 ppm). Nearest-neighbour scaling.
- View index to facing: `0 = +y`, `2 = −x`, `4 = −y`, `6 = +x`; odd views are the 45° in-betweens.
- Characters use the `2x/` sheets (168×248 frames, rows `S, SW, W, NW, N, NE, E, SE`). Fake-sit: crop at y = 172, anchor at the crop bottom, lift 0.42 m, face `SW`, chair z bias −2.
- Night: world tint `#a39ac4`. Floor light pools are drawn under the furniture and masked to the floor. Halos appear only at real lamps. Sky has stars and a moon.
- Role ids: `pm, techlead, frontend, backend, qa, uiux, devops, security, writer`. PM is always on; `techlead, frontend, backend, qa` are on by default.
- Never overwrite an existing file in the owner's project folder.
- PixiJS is pinned to `8.6.6`. Do not use the CDN in the app; import from npm.

## Review Focus

- A folder path that doesn't exist, is a file, or contains spaces/backslashes (Windows): `POST /api/projects` returns 400 for the first two and works for the third.
- A browser reload or second tab mid-ticket: the office and console show the same state (snapshot), with no duplicated feed lines.
- Rapid clicks: Approve clicked twice, Send pressed twice, or removing a member who is busy. The server rejects the second gate decision with 409 and the busy removal with 409.
- 7+ projects: Fit Building frames everything, pathfinding still reaches the breakroom from the farthest room, and no two bots ever share a seat.
- A server restart with a running ticket: that ticket becomes `failed` with reason `interrupted`, and queued tickets start after it.

---

## File Structure

```
package.json                 workspaces: shared, server, web; scripts dev/test
.gitignore                   node_modules, dist, assets/, server/data/
README.md                    setup + where to put the art packs
tools/shot.mjs               headless screenshot (move from the session scratchpad; waits for document.title === 'READY')
shared/src/roles.ts          ROLES catalogue, defaults
shared/src/types.ts          Project, Ticket, Plan, Diff, Gate types
shared/src/events.ts         ServerEvent union, Snapshot
shared/src/index.ts
server/src/store.ts          projects.json persistence + slot/look allocation
server/src/scaffold.ts       .claude/agents/<role>.md writer (no overwrite)
server/src/ticketLog.ts      JSONL append/read per ticket
server/src/orchestrator/types.ts      Orchestrator interface
server/src/orchestrator/simulated.ts  SimulatedOrchestrator (state machine)
server/src/orchestrator/fakeContent.ts plan/tool/diff text generators
server/src/hub.ts            WebSocket broadcast + snapshot
server/src/app.ts            Express routes
server/src/main.ts           wiring, port 5175
web/src/engine/iso.ts        projection, view helpers
web/src/engine/assets.ts     pieces.csv parser, texture + character sheet loaders
web/src/engine/layout/building.ts     projects -> BuildingLayout
web/src/engine/layout/roomTemplate.ts per-room pieces + spots
web/src/engine/layout/breakroom.ts    breakroom pieces + spots (from spike, +6 m in x)
web/src/engine/walkgrid.ts   grid + A*
web/src/engine/render/scene.ts        Pixi scene from layout
web/src/engine/render/lighting.ts     day/night, pools, halos, sky
web/src/engine/render/camera.ts       pan/zoom/fit
web/src/engine/bots/bot.ts            sprite, sitting, bubbles, movement
web/src/engine/bots/officeLife.ts     activity picker, reservations, social
web/src/engine/bots/director.ts       ticket events -> bot intents
web/src/state/store.ts       zustand store: projects, tickets, feed, selection
web/src/state/socket.ts      WS client, snapshot handling
web/src/ui/*.tsx             Toolbar, AddProjectDialog, TeamDialog, Drawer (+ Feed, RawLog, Changes, PlanView, PipelineBar, GateCard)
web/src/App.tsx, main.tsx
```

## Shared names (used across tasks)

```ts
type RoleId = 'pm'|'techlead'|'frontend'|'backend'|'qa'|'uiux'|'devops'|'security'|'writer';
type Accent = 'cyan'|'magenta'|'amber'|'lime'|'violet';
interface Look { character: string; palette: 'a'|'b'|'c' }
interface Project { id: string; name: string; folder: string; accent: Accent; team: RoleId[]; slot: number; looks: Record<RoleId, Look>; createdAt: string }
type Stage = 'plan'|'design'|'build'|'review'|'test'|'docs'|'done';
type TicketStatus = 'queued'|'running'|'waiting'|'done'|'failed'|'cancelled';
interface PlanTask { role: RoleId; text: string; files: string[] }
interface Plan { summary: string; acceptance: string[]; areas: string[]; tasks: PlanTask[] }
interface Ticket { id: string; projectId: string; title: string; text: string; status: TicketStatus; stage: Stage|null; reason?: string; plan?: Plan; openGate?: GateKind; agentStates: Partial<Record<RoleId, AgentState>>; createdAt: string }
type GateKind = 'plan'|'final'|'stuck';
type GateDecision = 'approved'|'changes'|'retry'|'accept'|'cancel';
type AgentState = 'idle'|'summoned'|'planning'|'designing'|'coding'|'reviewing'|'testing'|'documenting'|'waiting'|'done'|'failed';
interface Snapshot { projects: Project[]; tickets: Ticket[] /* current + queued per project */ }
```
`ServerEvent` is the union from spec §9 plus `{ type: 'snapshot', snapshot: Snapshot }` and `user.message`. Every event has `type, projectId, ticketId?, ts`, and every ticket event also has a monotonically increasing `seq` per ticket (used to de-duplicate on replay).

---

### Task 1: Monorepo scaffold, shared catalogue and types

**Files:**
- Create: `package.json`, `.gitignore`, `README.md`, `tools/shot.mjs`, `shared/package.json`, `shared/tsconfig.json`, `shared/src/{roles,types,events,index}.ts`, `shared/test/roles.test.ts`
- Create: empty workspace packages `server/` and `web/` (package.json + tsconfig only; Vite React TS template for web)

**Interfaces:**
- Produces: `ROLES: readonly RoleDef[]` with `RoleDef = { id: RoleId; label: string; emoji: string; required: boolean; defaultOn: boolean; deskRow: 0|1|'pm'; deskCol: 0|1|2|3; tools: string }`, `DEFAULT_TEAM: RoleId[]`, `ACCENT_HEX: Record<Accent, number>`, and all types above.

- [ ] **Step 1:** `git init`, write `.gitignore` (`node_modules/`, `dist/`, `assets/`, `server/data/`, `spike/vendor/`), root `package.json` with `"workspaces": ["shared","server","web"]` and scripts `test` (`npm test -ws`) and `dev` (runs server and web together via `concurrently`).
- [ ] **Step 2: Write the failing test** `shared/test/roles.test.ts`:
```ts
expect(DEFAULT_TEAM).toEqual(['pm','techlead','frontend','backend','qa']);
expect(ROLES.filter(r => r.required).map(r => r.id)).toEqual(['pm']);
expect(new Set(ROLES.map(r => `${r.deskRow}:${r.deskCol}`)).size).toBe(9); // every role has its own desk
expect(ROLES.find(r => r.id==='frontend')).toMatchObject({ deskRow: 0, deskCol: 1 });
```
- [ ] **Step 3:** Run `npm test -w shared` and expect a FAIL (module missing).
- [ ] **Step 4:** Implement `roles.ts`. Desk map: row 0 → `techlead c0, frontend c1, backend c2, qa c3`; row 1 → `uiux c0, devops c1, security c2, writer c3`; `pm` → `deskRow 'pm', deskCol 0`. Accents: cyan `0x3df0ff`, magenta `0xff4fb8`, amber `0xffb35c`, lime `0x9dff5c`, violet `0xb48cff`. `tools` holds the spec §12 permission sentence per role. Write `types.ts` and `events.ts` from "Shared names".
- [ ] **Step 5:** Run `npm test -w shared` and expect a PASS. Copy `shot.mjs` into `tools/`, taking `<url> <out.png> [js]` arguments. Write the README with the asset folder layout from spec §2.
- [ ] **Step 6:** Commit `chore: monorepo scaffold and shared role catalogue`.

### Task 2: Project store, slots, looks and agent scaffolding

**Files:**
- Create: `server/src/store.ts`, `server/src/scaffold.ts`, `server/test/store.test.ts`, `server/test/scaffold.test.ts`

**Interfaces:**
- Consumes: `ROLES`, `DEFAULT_TEAM`, `Project`, `RoleId` from `@office/shared`.
- Produces: `class ProjectStore { constructor(file: string); list(): Project[]; get(id): Project|undefined; add(input: { name: string; folder: string; accent: Accent; team: RoleId[] }): Project; update(id, patch: { name?: string; accent?: Accent; team?: RoleId[] }): Project; remove(id): void }` and `scaffoldAgents(folder: string, team: RoleId[]): { written: string[]; skipped: string[] }`.

- [ ] **Step 1: Write failing tests**
  - `add` gives slots `0,1,2` to three projects. After removing slot 1, the next `add` gets slot 1 (lowest free slot; other projects keep theirs).
  - `add` throws `ValidationError` when `folder` doesn't exist or is a file; works with a folder whose path contains spaces.
  - `team` always contains `pm` even if omitted; unknown role ids throw `ValidationError`.
  - `looks` are unique `(character, palette)` pairs across all projects until 36 are used (assert 36 distinct after 8 projects × all 9 roles … stop at 36), then reuse is allowed.
  - Data survives a new `ProjectStore(file)` on the same file.
  - `scaffoldAgents(tmp, ['pm','qa'])` writes `.claude/agents/pm.md` and `qa.md`, each containing the role label and its `tools` sentence. A pre-existing `qa.md` with content `X` is left as `X` and reported in `skipped`.
- [ ] **Step 2:** Run `npm test -w server` and expect a FAIL.
- [ ] **Step 3:** Implement. Ids come from `crypto.randomUUID()`. Write the JSON atomically (write `*.tmp`, then rename). Characters are the 12 folder names from spec §2. Iterate looks palette-major (`a` for all 12, then `b`, then `c`).
- [ ] **Step 4:** Run the tests and expect a PASS.
- [ ] **Step 5:** Commit `feat(server): project store, slots, looks, agent scaffolding`.

### Task 3: Simulated orchestrator

**Files:**
- Create: `server/src/orchestrator/types.ts`, `server/src/orchestrator/simulated.ts`, `server/src/orchestrator/fakeContent.ts`, `server/src/ticketLog.ts`, `server/test/simulated.test.ts`

**Interfaces:**
- Consumes: `Project`, `Ticket`, `ServerEvent`, `GateKind`, `GateDecision`.
- Produces:
```ts
interface Orchestrator {
  startTicket(project: Project, text: string): Ticket;           // queued if one is running
  decide(ticketId: string, gate: GateKind, decision: GateDecision, note?: string): void; // throws ConflictError if gate not open
  sendMessage(ticketId: string, text: string): void;
  cancel(ticketId: string): void;
  current(projectId: string): Ticket | undefined;
  queue(projectId: string): Ticket[];
  onEvent(cb: (e: ServerEvent) => void): void;
  busyRoles(projectId: string): RoleId[];
}
class SimulatedOrchestrator implements Orchestrator { constructor(opts: { log: TicketLog; scheduler: Scheduler; random: () => number; stageMs: [number, number] }) }
interface Scheduler { after(ms: number, fn: () => void): () => void } // returns cancel
class TicketLog { constructor(dir: string); append(e: ServerEvent): void; read(projectId: string, ticketId: string): ServerEvent[]; recover(): Ticket[] }
```

- [ ] **Step 1: Write failing tests** using a manual `Scheduler` (a queue you flush) and a seeded `random`:
  - Happy path with team `pm, techlead, frontend, backend, qa`. The event order contains `ticket.created`, `ticket.stage plan`, `agent.state pm planning`, `ticket.plan`, `gate.open plan`, and the ticket status becomes `waiting`. After `decide(...,'plan','approved')`: `agent.state summoned` for exactly the roles with tasks, then `build` (frontend+backend `coding`), `review` (techlead `reviewing`), `test` (qa `testing`), `gate.open final`. After `decide(final, approved)`: `ticket.done`, and every summoned role gets `agent.state done` then `idle`.
  - No `design` stage when `uiux` is absent; `docs` stage only when `writer` is on the team.
  - With `random` forcing review bounces every time, `gate.open stuck` appears after exactly 3 bounces. `retry` resets the count, `accept` goes to `test`, `cancel` gives `ticket.cancelled`.
  - `decide` on a gate that isn't open throws `ConflictError`; deciding the same gate twice throws on the second call.
  - A second `startTicket` while one is running returns a `queued` ticket that starts automatically after the first ends.
  - `sendMessage` emits `user.message`, followed by an `agent.message` acknowledgement from the role whose state is active (PM when none is).
  - `busyRoles` lists roles in `summoned|planning|…|waiting` for the current ticket.
  - Every event is appended to the `TicketLog`; `seq` increases by 1 per ticket.
  - `TicketLog.recover()` on a log whose last ticket has no terminal event returns that ticket with `status 'failed', reason 'interrupted'` and appends `ticket.failed`.
- [ ] **Step 2:** Run the tests and expect a FAIL.
- [ ] **Step 3:** Implement as an explicit per-ticket state machine (`stage` + `openGate` + `bounces`). Each stage lasts `stageMs` (default `[10000, 40000]`) and emits 3–8 `agent.tool`/`agent.message`/`log.raw` events spread across it. `fakeContent.ts` derives the plan from the ticket text: the title is the first 60 chars, there's a frontend/backend/qa task each, a uiux task if on the team and the text mentions page/screen/ui/button/form, plus fake file paths and a 2-file unified diff for `ticket.diff`. The review bounce chance is 0.25 and the QA bounce chance is 0.15 (both from `random`). "Request changes" at the plan gate re-runs `plan`; at the final gate it re-runs `build`.
- [ ] **Step 4:** Run the tests and expect a PASS.
- [ ] **Step 5:** Commit `feat(server): simulated orchestrator with gates, bounces, queue, log`.

### Task 4: REST API, WebSocket hub, snapshot, main

**Files:**
- Create: `server/src/hub.ts`, `server/src/app.ts`, `server/src/main.ts`, `server/test/api.test.ts`

**Interfaces:**
- Consumes: `ProjectStore`, `scaffoldAgents`, `Orchestrator`, `TicketLog`.
- Produces: HTTP on `127.0.0.1:5175`: `GET/POST /api/projects`, `PATCH/DELETE /api/projects/:id`, `POST /api/projects/:id/tickets {text}`, `GET /api/projects/:id/tickets?limit=20` → `{ tickets: Ticket[], events: Record<ticketId, ServerEvent[]> }`, `POST /api/tickets/:id/gates/:gate {decision, note?}`, `POST /api/tickets/:id/messages {text}`, `POST /api/tickets/:id/cancel`. WS at `/ws`: first message is `snapshot`, then every `ServerEvent`. Assets are served statically at `/assets` from the repo's `assets/`.

- [ ] **Step 1: Write failing tests** (supertest + a `ws` client against `createApp({ dataDir: tmp, orchestrator: simulated with manual scheduler })`):
  - `POST /api/projects` with a missing folder returns 400 `{error}`; a valid one returns 201 with `slot 0`, writes the agent files, and broadcasts `project.added`.
  - `PATCH` that removes a role in `busyRoles` returns 409. Removing a free role returns 200 and broadcasts `project.updated`.
  - `DELETE` a project with a running ticket cancels it first, then broadcasts `project.removed`.
  - A WS client connecting mid-ticket receives a `snapshot` whose ticket shows `openGate: 'plan'`.
  - Posting the same gate decision twice returns 200 then 409.
  - `messages` on a ticket that isn't running returns 409.
- [ ] **Step 2:** Run the tests and expect a FAIL.
- [ ] **Step 3:** Implement. `main.ts` builds the store from `server/data/projects.json`, the log in `server/data/projects/`, runs `TicketLog.recover()` on start (and re-queues queued tickets), and uses a real `setTimeout` scheduler.
- [ ] **Step 4:** Run the tests and expect a PASS. Then run `npm run dev -w server`, `curl http://127.0.0.1:5175/api/projects`, and expect `[]`.
- [ ] **Step 5:** Commit `feat(server): REST, websocket hub with snapshot`.

### Task 5: Engine core: iso math and assets

**Files:**
- Create: `web/src/engine/iso.ts`, `web/src/engine/assets.ts`, `web/test/iso.test.ts`, `web/test/assets.test.ts`

**Interfaces:**
- Produces: `PX=91, PY=45.5, PZ=111`; `iso(mx: number, my: number): {x,y}`; `screenToWorld(sx, sy): {mx,my}` (the inverse at floor level); `footprint(piece: PieceMeta, view: number): { w: number; d: number }` (size_x along x for views 0/4, swapped for 2/6, the bounding square for odd views); `parsePieces(csv: string): Record<string, PieceMeta>` with `PieceMeta = { cat, w, h, sx, sy, sz, gx, gy, anim }`; `loadPiece(name, view): Promise<Texture | Texture[]>` (cached, de-duplicated promises: the spike showed concurrent `Assets.load` of the same URL can hang); `loadCharacter(look: Look): Promise<CharacterSheets>` where `CharacterSheets = Record<'idle'|'walk'|'drinking'|'waving', Texture[][]>` plus `sit: Record<'idle'|'drinking', Texture[][]>` (cropped at y = 172).

- [ ] **Step 1: Write failing tests:** `iso(1,0)` → `{x:91,y:45.5}`; `screenToWorld(iso(3.5,2))` → `{mx:3.5,my:2}`; `parsePieces` on two real CSV lines gives `Desk_Straight.gx === 112` and `Monitor.anim === 16`; `footprint(Desk_Straight, 2)` → `{w:0.7,d:1.4}`.
- [ ] **Step 2:** Run `npm test -w web` and expect a FAIL.
- [ ] **Step 3:** Implement. Asset URLs are `/assets/office/Isometric_Pixel_Props/<cat>/<piece>/sprites/<piece>_<view>.png` and `/anim/<piece>_<view>_16frames.png`; characters are `/assets/characters/OfficeCharacters_Basic_v1.0/characters/<name>/<palette>/2x/<clip>.png`.
- [ ] **Step 4:** Run the tests and expect a PASS.
- [ ] **Step 5:** Commit `feat(web): iso math and asset loading`.

### Task 6: Building layout generator

**Files:**
- Create: `web/src/engine/layout/building.ts`, `roomTemplate.ts`, `breakroom.ts`, `web/test/building.test.ts`

**Interfaces:**
- Consumes: `Project`, `ROLES`, `footprint`.
- Produces:
```ts
interface Placed { piece: string; mx: number; my: number; view: number; lift?: number; z?: number; zi?: number; anim?: boolean; tag?: string /* 'monitor:<projectId>:<role>' | 'lamp:<kind>' | 'whiteboard:<projectId>' | 'shelf:<projectId>' | 'corkboard' */ }
interface Spot { id: string; mx: number; my: number; pose: 'sit'|'stand'|'drink'; facing: Dir; capacity: 1; tags: string[]; room: string /* projectId | 'breakroom' | 'hall' */ }
interface RoomRect { id: string; kind: 'project'|'breakroom'|'hall'; x0: number; y0: number; x1: number; y1: number; side?: 'left'|'right'; door?: { y0: number; y1: number; x: number } }
interface Light { mx: number; my: number; lift: number; r: number; color: number; a: number; pool: boolean; halo: boolean; when?: 'always'|'working'; tag?: string }
interface BuildingLayout { rooms: RoomRect[]; pieces: Placed[]; spots: Spot[]; walls: Segment[] /* blocking lines */; lights: Light[]; seats: Record<string /* projectId:role */, { seat: Spot; deskPieces: number[] }>; bounds: { x0,y0,x1,y1 } }
function buildLayout(projects: Project[]): BuildingLayout
```
- Geometry (metres). Left rooms span `x 0–14`, the hallway `x 14–16`, right rooms `x 16–30`, the breakroom `x 16–26, y 0–8`. Slot `k` sits on the left at row `k/2` when `k` is even, and on the right at row `(k+1)/2` when `k` is odd. Each row is `y 8r–8r+8`. The hallway runs from `y 0` to the deepest row's end. Doors are at local `y 3–5` on the hallway side. The breakroom↔hallway edge is open.
- Room template (local coordinates measured from the room's x-min and y-min edges). Desk columns at `lx 2.6, 5.8, 9.0, 12.2`, rows at `ly 2.0` and `ly 5.2`, and the PM desk at `lx 2.6, ly 7.3`. Seat = desk position `(lx, ly − 0.75)`. Each desk set is `Desk_Straight v4`, a monitor (or `Dual_Monitor_Arm` for frontend/backend) `v4 lift 0.834`, `Keyboard_Mouse v4`, `Ergo_Chair v0 z −2` at the seat, plus the role items from spec §5.3. A role not on the team gets only desk + chair. Edge furniture: `Open_Shelf (0.4, 1.2) v6`, `Cubby_Shelf (0.4, 6.6) v6`, `Whiteboard_Mobile (4.4, 0.45) v0`, `Recycle_Bins (0.8, 7.6) v0`, plants in the free corners. For a left room, x-min is the outer wall; for a right room it is the hallway glass. The nameplate is a `tag:'nameplate:<id>'` placeholder at the door's top. Copy the breakroom from `spike/v2.html` with `x + 6`, keeping its lights.
- Walls: solid modules along `y = 0` for `x 0–26` and along `x = 0` for every left row. `Glass_Partition_2m` along the room↔hallway edges (skipping the door span) and along `y = 8r` between stacked rooms on the same side.

- [ ] **Step 1: Write failing tests:**
  - With 0 projects: rooms are the breakroom plus a hallway of length 8. With 3 projects in slots 0,1,2: room rects are `{left row0 x0-14 y0-8}`, `{right row1 x16-30 y8-16}`, `{left row1 x0-14 y8-16}`, and the hallway spans `y 0–16`.
  - Slots `0` and `2` with no `1`: row 1 right has no room and no floor, and the hallway still reaches `y 16`.
  - Every project has 9 seats. `seats['p:frontend'].seat` is at the room's `(5.8, 2.0-0.75)` in world coordinates, and a role not on the team has no monitor piece.
  - Every `Placed` with view 0 or 6 that sits within 0.6 m of a wall or glass edge faces away from that edge (the "nothing faces a wall" invariant, checked over all pieces).
  - No two spots share a cell (0.5 m), and no spot lies inside a furniture footprint.
- [ ] **Step 2:** Run the tests and expect a FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests and expect a PASS.
- [ ] **Step 5:** Commit `feat(web): building layout generator`.

### Task 7: Walk grid and A*

**Files:**
- Create: `web/src/engine/walkgrid.ts`, `web/test/walkgrid.test.ts`

**Interfaces:**
- Consumes: `BuildingLayout`, `footprint`.
- Produces: `class WalkGrid { constructor(layout: BuildingLayout, cell = 0.5); walkable(mx, my): boolean; path(from: {mx,my}, to: {mx,my}): {mx,my}[] | null }`. The path is a list of cell centres, the first is the start cell and the last is the target, smoothed by dropping collinear points.

- [ ] **Step 1: Write failing tests:** a path from a seat in slot 0 to the breakroom espresso spot exists and passes through the slot-0 door cells (`x≈14, y 3–5`). There's no path through glass (a straight line from slot 0 to slot 2 must go via the hallway). No path cell is inside a desk footprint. Diagonal moves never cut a blocked corner. With 8 projects, the farthest seat reaches the breakroom in under 20 ms (time it).
- [ ] **Step 2:** Run the tests and expect a FAIL.
- [ ] **Step 3:** Implement 8-directional A* with an octile heuristic and a binary heap. Rasterise footprints and wall segments into blocked cells, then re-open spot cells and door spans.
- [ ] **Step 4:** Run the tests and expect a PASS.
- [ ] **Step 5:** Commit `feat(web): walk grid and A* pathfinding`.

### Task 8: Renderer, camera, day/night

**Files:**
- Create: `web/src/engine/render/scene.ts`, `lighting.ts`, `camera.ts`, `web/src/engine/OfficeCanvas.tsx` (a React wrapper mounting a Pixi `Application`)

**Interfaces:**
- Consumes: `buildLayout`, `loadPiece`, `iso`.
- Produces: `class OfficeScene { constructor(app: Application); setLayout(layout: BuildingLayout): Promise<void>; setNight(on: boolean): void; setSelected(projectId: string|null): void; setHover(projectId: string|null): void; setWorking(projectId: string, role: RoleId, on: boolean): void; setWhiteboard(projectId: string, title: string|null): void; setTrophies(projectId: string, n: number): void; roomAt(sx, sy): string|null; world: Container }`. `class Camera { constructor(app, world); fit(bounds): void; attach(canvas): void }` with zoom range 0.2–2 and wheel zoom around the cursor. Sets `document.title = 'READY'` after the first `setLayout`.
- Rendering rules: hallway checker and door thresholds are code-drawn `Graphics`. Nameplates are Pixi `Text` in a pixel font with the accent colour and an additive glow. The selected room gets a steady accent outline, a soft floor tint (alpha 0.12), a brighter nameplate and a bobbing 👁 above it. Hover gets a faint outline. Monitors with tag `monitor:*` play their animation only while `setWorking(..., true)` or during desk time (Task 9 calls `setWorking`). Lighting implements the spike's final approach exactly: per-sprite tint, `poolLayer` (z −9e4) masked to the floor rects, a halo layer masked to the floor+wall silhouette, and a sky with stars and a moon. Day/night defaults to the clock (night 19:00–06:00).

- [ ] **Step 1:** Implement, and render a dev page `web/?demo=3` that injects 3 fake projects.
- [ ] **Step 2: Visual check.** Run `node tools/shot.mjs "http://127.0.0.1:5173/?demo=3" shots/day3.png "window.__office.setNight(false)"`, then the same at night, and with `?demo=7`. Expect `ready: true err: ""`. Open each PNG and check every anti-goal in spec §1: no furniture facing a wall or glass, seated layout intact, no black frame, no glow outside the building, interior readable at night, and 7 projects framed by Fit Building.
- [ ] **Step 3:** Commit `feat(web): office renderer, camera, day/night lighting`.

### Task 9: Bots and office life

**Files:**
- Create: `web/src/engine/bots/bot.ts`, `web/src/engine/bots/officeLife.ts`, `web/test/officeLife.test.ts`

**Interfaces:**
- Consumes: `BuildingLayout.spots/seats`, `WalkGrid`, `loadCharacter`, `OfficeScene`.
- Produces: `class Bot { id: string /* projectId:role */; goTo(spot: Spot | {mx,my}, then?: () => void): void; sit(spot: Spot): void; stand(): void; play(clip: 'idle'|'drinking'|'waving'): void; bubble(kind: '…'|'!'|'✗'|'✓'|'💬'|null): void; face(dir: Dir): void; update(dtMs: number): void }` (walk speed 1.2 m/s; facing from the movement vector; sitting uses the cropped sheets with lift 0.42; hovering a bot shows a `Name · Role` label). Also `class OfficeLife { constructor(opts: { spots: Spot[]; seats; random: () => number; now: () => number; isNight: () => boolean }); register(bot: Bot): void; release(botId: string): void /* bot stops idling (summoned) */; resume(botId: string): void; tick(): Intent[] }` where `Intent = { botId; activity: ActivityId; spots: Spot[]; durationMs; partnerId?: string }` and `ActivityId = 'desk'|'coffee'|'table'|'bar'|'lounge'|'chat'|'wander'`.

- [ ] **Step 1: Write failing tests** for `OfficeLife` (pure: no Pixi, seeded `random`, fake `now`):
  - Over 1000 ticks with 10 bots and night off, the activity frequencies follow spec §7.1 day weights within ±25%. With night on, `bar` and `lounge` rise accordingly.
  - Two bots never hold the same spot at the same time. A spot is reserved from intent creation until release.
  - A bot never repeats either of its last 2 activities.
  - At most 60% of registered idle bots are outside their own room at once.
  - `chat` reserves two adjacent spots and assigns a partner, from the same project with probability ≈0.6 (±0.15 over 500 chats).
  - `release(bot)` frees its spots immediately, and the bot gets no intents until `resume`.
- [ ] **Step 2:** Run the tests and expect a FAIL.
- [ ] **Step 3:** Implement `OfficeLife`, then `Bot`, then wire them in `OfficeCanvas`: one bot per team role per project, entering at its seat on first load. During desk time, call `scene.setWorking(projectId, role, true)` so the monitor shows its "game" animation.
- [ ] **Step 4:** Run the tests and expect a PASS. Visual check with `?demo=3` after 60 s (use the `js` argument to wait). Expect bots spread across the breakroom, the hallway and their desks, seated bots reading as seated, and nobody overlapping on a seat.
- [ ] **Step 5:** Commit `feat(web): bots and office life`.

### Task 10: Client state, socket and the ticket director

**Files:**
- Create: `web/src/state/store.ts`, `web/src/state/socket.ts`, `web/src/engine/bots/director.ts`, `web/test/store.test.ts`, `web/test/director.test.ts`

**Interfaces:**
- Consumes: `ServerEvent`, `Snapshot`, `Bot`, `OfficeLife`, `OfficeScene`.
- Produces: zustand `useOffice` with state `{ projects: Record<id, Project>; tickets: Record<id, Ticket>; feed: Record<ticketId, FeedItem[]>; raw: Record<ticketId, string[]>; lastSeq: Record<ticketId, number>; selectedProjectId: string|null; roleFilter: RoleId|'all'; night: boolean }`, and `apply(e: ServerEvent): void` (ignores events with `seq <= lastSeq`). `FeedItem = { kind: 'message'|'tool'|'gate'|'user'|'stage'; role?: RoleId; text: string; detail?: string; status?: string; id: string; ts: string }`, where streaming `agent.message` chunks with the same `messageId` are concatenated into one item. `class Director { constructor(scene, life, bots, grid); apply(e: ServerEvent): void }` maps events to bot behaviour per spec §7.3: `agent.state summoned` → `life.release` + walk to the seat + sit; PM `planning` → walk to the whiteboard first; techlead `reviewing` → stand beside each coder's desk in turn, then return; `waiting` → `!` bubble for the gate owner (PM at plan, all at final); `done` → wave, `✓`, then `life.resume`; `project.updated` with an added role → spawn at the room door, walk to the seat, wave; removed role → walk out to the hallway end and despawn; `ticket.created`/`ticket.stage` → `scene.setWhiteboard(projectId, title)` (cleared on ticket end); `ticket.done` → `scene.setTrophies(projectId, min(5, doneCount))`.

- [ ] **Step 1: Write failing tests:**
  - Store: applying a `snapshot` and then the same events again doesn't duplicate feed items. Three `agent.message` chunks with one `messageId` become one feed item with the concatenated text. `gate.open` adds a `gate` item and sets `ticket.openGate`. `gate.closed` clears it.
  - Director (with fake bots recording calls): `summoned` for frontend calls `life.release('p:frontend')` and `goTo(seat)`. `ticket.done` resumes all summoned bots. A removed role's bot gets `goTo(hall end)` and is then removed.
- [ ] **Step 2:** Run the tests and expect a FAIL.
- [ ] **Step 3:** Implement. `socket.ts` connects to `/ws` (Vite proxies `/api`, `/ws` and `/assets` to `127.0.0.1:5175`), reconnects with a 1–5 s backoff, and on reconnect relies on the fresh `snapshot`. Opening a project's drawer fetches `GET /api/projects/:id/tickets?limit=20` and applies the events.
- [ ] **Step 4:** Run the tests and expect a PASS.
- [ ] **Step 5:** Commit `feat(web): client store, socket, ticket director`.

### Task 11: UI: toolbar, dialogs, drawer

**Files:**
- Create: `web/src/ui/Toolbar.tsx`, `AddProjectDialog.tsx`, `TeamDialog.tsx`, `Drawer.tsx`, `Feed.tsx`, `RawLog.tsx`, `Changes.tsx`, `PlanView.tsx`, `PipelineBar.tsx`, `GateCard.tsx`, `web/src/ui/theme.css`, `web/test/ui.test.tsx` (vitest + @testing-library/react)
- Modify: `web/src/App.tsx`

**Interfaces:**
- Consumes: `useOffice`, REST endpoints from Task 4, `OfficeScene.setSelected/roomAt`.
- Produces: the UI in spec §10. Toolbar `+ Add Project`, `Fit Building`, `☀/🌙`. Clicking a room or bot selects it and opens the drawer (a bot click also sets `roleFilter`). The drawer (560 px, dark terminal theme, monospace) has a header in the accent colour with the project name, the ticket title + history selector, `PipelineBar` (stages for the team, ✓/●/○), and tabs Feed/Raw log/Changes/Plan, plus a `Team` button. The input with no running ticket creates a ticket. While one runs, it sends `POST /messages`, and a "New ticket instead" toggle switches it to queueing. Gate cards: plan/final show `Approve` / `Request changes` (with an optional note field); stuck shows `One more round` / `Accept & test` / `Cancel ticket`. Buttons disable after a click until `gate.closed`. Room status badges (`… working`, `⏸ 1 waiting`, `✓ done` for 5 s) render in the canvas above each nameplate. Hovering the breakroom cork board shows a tooltip with the last 5 tickets across all projects (title, project, status).

- [ ] **Step 1: Write failing tests:**
  - AddProjectDialog shows 9 role checkboxes, with `pm` checked and disabled and `techlead, frontend, backend, qa` checked. Submitting posts `{name, folder, accent, team}`. A 400 response shows the server's error text inline.
  - Drawer input with no running ticket posts to `/tickets`; with a running ticket it posts to `/messages`, or to `/tickets` when the toggle is on.
  - The stuck gate card renders three buttons, each posting its own `decision`. After one click all buttons are disabled.
  - The Feed collapses a tool item to one line and expands on click to show `detail`.
- [ ] **Step 2:** Run the tests and expect a FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests and expect a PASS.
- [ ] **Step 5:** Commit `feat(web): toolbar, project/team dialogs, console drawer`.

### Task 12: End-to-end verification and cleanup

**Files:**
- Modify: `README.md`
- Create: `tools/e2e.mjs` (drives the real server and web through `shot.mjs`-style CDP)

- [ ] **Step 1:** Write `tools/e2e.mjs`. It starts the server with a temp data dir and `stageMs [800,1500]`, creates 3 projects through REST (temp folders, one with a space in its path), starts a ticket in project 2, and captures screenshots at: plan gate waiting, approved and building, final gate, done. In between, it reloads the page once mid-build. Each step asserts through `/api/projects/:id/tickets`.
- [ ] **Step 2:** Run `node tools/e2e.mjs` and expect `e2e ok` with 6 screenshots in `shots/`. Open them and confirm: the selected room has the outline and 👁; PM at the whiteboard, then seated with `!` at the plan gate; coders seated with animated monitors while building; techlead beside a coder's desk in review; the drawer feed after the reload matches before (no duplicates); the ✓ wave at done, then bots back to office life.
- [ ] **Step 3:** Run the full suite with `npm test` and expect all packages to pass.
- [ ] **Step 4:** Update the README with how to run (`npm install`, put the packs in `assets/`, `npm run dev`, open `http://127.0.0.1:5173`). Delete `spike/vendor/`, but keep `spike/v2.html` as the visual reference.
- [ ] **Step 5:** Commit `test: e2e walkthrough; docs`.
