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
