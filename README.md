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

```
npm install
npm run dev
```

Open http://127.0.0.1:5173. The server listens on 127.0.0.1:5175 and keeps data in `server/data/`.

## Test

```
npm test                                   # unit tests, all packages
node tools/shot.mjs <url> <out.png> [js]   # headless screenshot once the page reports READY
```
