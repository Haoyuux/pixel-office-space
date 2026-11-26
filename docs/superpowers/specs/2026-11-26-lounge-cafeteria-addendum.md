# Addendum: separate Lounge and Cafeteria (replaces the Breakroom)

Date: 2026-11-26 · Status: approved by owner ("make a lounge room and cafeteria, separate them; lounge has many couches,
cafeteria many tables and chairs; be creative") · Amends spec §5.2 (Breakroom), §7.1 (spots), §11 (lights).

## Geometry
- Row 0 (y 0–8) is the shared entrance row: **Lounge** on the left (x 0–14), hallway (x 14–16), **Cafeteria** on the
  right (x 16–30). Both are open to the hallway (no glass on the hallway edge), like the old breakroom.
- Project rooms start at row 1: slot k → side `k % 2 === 0 ? left : right`, row `floor(k / 2) + 1`.
  (Slot numbers in projects.json don't change; every existing room moves down one row once.)
- Solid back wall along y = 0 for x 0–30 (mix of Wall_2m / Wall_Window_2m / Blinds_Window_2m). Solid x = 0 wall for the
  lounge and for every left row. Glass along y = 8r between stacked rooms on the same side (row ≥ 1), as before.
- Hallway always runs from y 0 to the end of the deepest row (minimum 8 m).
- Keep `RoomRect.kind`: add `'lounge' | 'cafeteria'` (drop `'breakroom'`), ids `'lounge'` / `'cafeteria'`.

## Lounge (14 × 8, x 0–14) — "many couches", cozy
Floor: Floor_Carpet_2x2 (warm, differs from project rooms by tint or use Floor_Vinyl if carpet reads too office-like —
builder's visual call). Must read as a living room, not an office.
- At least 4 Sofa_Modular, in 2–3 conversation clusters, each sofa facing the camera (view 0, or view 6 against the
  x = 0 wall) with a Coffee_Table in front so seated bots read as sitting (sofa behind, table in front hides the cut).
- 3–4 Lounge_Chair armchairs facing the camera (view 0 / 6), joined to the clusters.
- Coffee tables dressed: Lava_Lamp, Fairy_Jar, Mug, Plate_Fruit, Notebook.
- Reading corner: Open_Shelf + Cubby_Shelf on the x = 0 wall, Globe and Trophy on top, an armchair + Arc_Floor_Lamp.
- Aquarium on a Pedestal_Drawer, Paper_Lantern_Floor ×2, String_Lights on the back wall, Wall_Clock, plants in corners
  (Monstera, Fiddle_Leaf, Snake_Plant, Cactus, Succulents on tables).
- No TV. Nothing faces a wall.
- Spots: every camera-facing sofa seat (3 per sofa) and armchair is a `sit` spot tagged `lounge`; adjacent seats form
  `chat` pairs (`pair`). A few `stand` spots tagged `wander` (shelf, aquarium).

## Cafeteria (14 × 8, x 16–30) — "many tables and chairs"
Floor: Floor_Vinyl_2x2.
- Kitchen run on the back wall: Kitchen_Sink (+ Espresso_Machine, Capsule_Coffee on the counter), Microwave, Mini_Fridge ×2,
  Vending_Machine ×2, Water_Cooler, Cork_Board (tag `corkboard`), Wall_Clock.
- 4 dining tables (Meeting_Table) in two rows, 3 Meeting_Chairs per long side; far-side chairs (view 0) are `sit` spots
  tagged `table` (bots face the camera); near-side chairs are decoration (view 4).
- Tables dressed with food: Plate_Burger, Plate_Fish_Fries, Plate_Shrimp, Plate_Fruit, Fries_Basket, Ice_Cream_Sundae,
  Milkshake, Drinks_Tray, Cola_Can, Juice_Glass, Coconut_Straw, Napkin_Holder, Salt_Pepper, Sauce_Bottles, Table_Menu,
  plus a Fairy_Jar per table.
- Smoothie bar: High_Table_Stools ×2–3 near the open right side with Blender_Smoothie / Milkshake on them;
  `drink` spots tagged `bar`.
- Coffee spots (`drink`, tag `coffee`) at espresso, capsule, vending ×2, cooler; a chat pair near the cooler.
- Plants in corners.

## Office life mapping (unchanged activities, new places)
coffee / table / bar → cafeteria spots; lounge / chat → lounge spots (cooler chat pair stays in the cafeteria);
wander → hallway, cork board, lounge shelf / aquarium.

## Night lights
Lounge: warm pools under each cluster, halos at lava lamps, fairy jars, arc lamp, lanterns, string lights, aquarium.
Cafeteria: warm pendant-style pools over each table (pool only), halo at fairy jars, cool pools at vending, kitchen pool.

## Must still hold
All existing invariants and tests: nothing faces a wall/glass; no stand/drink spot inside furniture; no two spots share
a cell; every seat reaches the cafeteria coffee spot; Fit Building frames everything; e2e passes.
