# dev/ — developer harnesses for the `demo-wild-fire` package

Everything in this directory is a **developer instrument**, never a player
surface: no game UI links to it, no engine code imports it, and it is not part
of any bundle. The pages are plain standalone HTML served by the Vite dev
server under `/games/demo-wild-fire/dev/...` (the same static middleware that
serves `/games/*`). In production the games tree is rsynced wholesale, so these
pages are reachable by URL but deliberately unlinked; the ECS rsync may exclude
`dev/` entirely without breaking anything.

Start the dev server from `client/`:

```bash
cd client && npm run dev        # http://localhost:5173
```

## The one rule: packages message the engine; only the engine touches the browser

Package code (anything under `assets/`) NEVER calls browser APIs directly —
no DOM, no `window`/`document`, no canvas, no WebGL/three.js, no Cesium, no
`fetch`, no storage. A package is pure state plus pure functions: it computes
and emits **textual messages** (plain JSON command objects), and the static
game engine is the one component that translates those messages into browser
API calls (Google Maps overlays, Cesium entities, canvas rAF loops, audio).

```
package (sim / controllers / agent worker)
   │   { "type": "fire.delta", "burning": [...], ... }   <- JSON only
   ▼
static engine (effect catalog, overlays, views)
   │   the ONLY holder of browser APIs
   ▼
DOM / WebGL / Google Maps / Cesium
```

- Message vocabulary: `{ type, ...payload }`, JSON-serializable, versioned per
  effect (e.g. `FIRE_EFFECT_PROTOCOL` in the engine's `fireEffect.js`). The
  engine ignores unknown types instead of failing — fail-safe against a newer
  package running on an older engine.
- A package does not even load its own files: the engine resolves URLs through
  `scene.json` → the asset manifest and imports the module. Packages never fetch.
- Structural enforcement: at play time package code runs in a per-session Web
  Worker (engine-owned `client/src/workers/fireAgent.worker.js`), where
  `window`/`document` do not exist — a violation is not a review finding, it
  is a crash on arrival.
- Audit grep before shipping any package (comments are the only acceptable hit):
  `grep -n "window\.\|document\.\|fetch(\|THREE\|canvas\|navigator\." assets/*/*.js`
- The ONE exception is this `dev/` directory: a harness *stands in for the
  engine* (it is the thing calling three.js and the DOM on the package's
  behalf), which is exactly why harnesses are developer-only and never ship.

## Package layout this directory serves

```
games/demo-wild-fire/
├── card.json            # Plaza storefront ONLY (title, copy, trailer, action)
├── scene.json           # runtime index: asset list + future worker entry
├── media/               # trailer / poster
├── assets/<id>/         # ONE directory per asset
│   ├── <id>.json        #   asset manifest: mesh rig facts + component URLs
│   ├── controller_<id>.js
│   ├── <mesh>.glb
│   └── (fire: fire_sim.js + controller_fire.js scenario)
└── dev/                 # this directory: viewers + this README
```

## How to define an asset

1. **Create `assets/<id>/`** — the directory name IS the asset id.
2. **Write the controller** `controller_<id>.js` in the package contract family
   (see `controller_tank.js` for the ground-vehicle reference):
   - dependency-free ESM — runs in the browser AND in plain Node;
   - exports `const <ID>_CONTROLLER_API = 1` and a factory
     `create<Id>Controller(initialPose, options)`;
   - rate commands (`forward()`, `turnLeft()`, …) with exponential easing and
     an exact-rest snap, plus `update(dt)`, `getState()`, `describe()`;
   - `getState()` returns pose + any rig data a host needs (e.g. tank track
     speeds); the controller integrates pose itself, hosts only render it.
3. **Write the manifest `<id>.json`** — rig conventions live here as DATA so
   hosts never re-derive them:

   ```json
   { "apiVersion": 1, "id": "tank", "kind": "vehicle",
     "mesh": { "url": "tank_usa_type10.glb", "units": "m",
               "noseAxis": "+Z", "yawTrimDeg": 180, "groundLiftM": 1.098 },
     "controller": { "url": "controller_tank.js", "api": 1,
                     "factory": "createTankController" } }
   ```

   Field meanings: `units` native mesh unit (`mm` for the drone — its manifest
   also carries `hostScale`/`bakedScale`, do not add another 0.001);
   `noseAxis` the glTF axis the mesh faces at heading 0; `yawTrimDeg` extra
   `rotation.y` a host applies so heading 0 = north; `groundLiftM` wrapper lift
   that puts the asset on the surface.
4. **Register it in `scene.json`** under `assets` as
   `{ "id": "<id>", "manifest": "assets/<id>/<id>.json" }`. The engine resolves
   every component through `scene.json` → manifest → relative URL; never
   hardcode a package-internal path in engine code.
5. **Fire-style hazards** differ only in kind: the manifest points at a sim
   factory (`createFireSim`) and a generated scenario (`createFireScenario` in
   `controller_fire.js`: perimeter, `noFuelPolygons`, scheduled `ignitions`,
   wind `keyframes`, `loss.occupyFrac`). Renderers are ENGINE-owned effects
   referenced by name (`engine:fireOverlay2d`); a package never ships
   rendering code.

Rules that keep the boundary clean: a package imports nothing from the engine;
`card.json` stays storefront-only; the disaster perimeter is hidden game state
(sim + loss check only) and must never reach a player-facing renderer.

## How to test an asset headlessly (do this first)

Package modules are dependency-free ESM, so Node runs them directly:

```bash
node --input-type=module -e "
import('$(pwd)/assets/tank/controller_tank.js').then((m) => {
  const c = m.createTankController({ lon: -118.5, lat: 34.04, alt: 0, headingDeg: 0 });
  c.forward(); for (let i = 0; i < 300; i++) c.update(1 / 60);
  console.log(c.getState().pose, c.getState().tracks);
});"
```

For the fire sim, assert determinism (`getState().gridHash` equal across two
instances given the same seed and command sequence) and the invariants you
care about (spread anisotropy under wind, water knockdown leaving an ash hole,
water masks impassable, loss latch). Write the assertions to a scratch `.mjs`
file and run `node file.mjs` — long `node -e` one-liners fight shell quoting.

The fire agent WORKER is headless-testable too: stub `globalThis.self`
(capture `postMessage`) and `globalThis.fetch` (read from disk), import
`client/src/workers/fireAgent.worker.js`, drive `self.onmessage({data:
{type:'start', packageBase:'<repo>/games/demo-wild-fire/', speed:3600}})` and
assert the message lifecycle `fire.setGrid → fire.delta* → fire.state* →
game.over{outcome:'lost'|'held'}`.

## How to test an asset visually (the harnesses here)

| Page | Asset | What to verify |
|---|---|---|
| `dev/controller_viewer.html` | drone | mesh loads at sane scale (mm asset!); green nose arrow = mesh −Z; forward translates along the arrow; rotors spin with throttle; chase cam follows |
| `dev/controller_tank_viewer.html` | tank | nose = asset +Z with the 180° trim applied; forward/backward translate along the green arrow; turn pulses pivot in place when stopped and curve when driving; track L/R HUD antisymmetric in turns; stop halts exactly |
| `dev/fire_sim_viewer.html` | fire sim | top-down CA: ignition grows radially with calm wind, anisotropically downwind with a Santa Ana preset; water mode knocks a hole that settles to black ash; wet unburned dries back; HUD counts/ha/containment move sensibly |

Open them directly, e.g.
`http://localhost:5173/games/demo-wild-fire/dev/controller_tank_viewer.html`.
Each page imports its artifact by relative URL
(`../assets/<id>/controller_<id>.js`), so a harness keeps working after any
package-internal move.

Two related instruments live elsewhere:

- `http://localhost:5173/tools/geo-editor.html` — repo-root, cross-package:
  the full fire-scenario authoring tool. Boundary / water-mask / ignition draw
  modes, wind-keyframe timeline, an in-tool preview that runs the package's
  `fire_sim.js` on exactly the drawn data, and an exporter that emits
  `controller_fire.js` verbatim. Dev-only by deployment (production serves no
  `/tools/*`).
- `http://localhost:5173/play?fireDemo=1` — the in-engine check: the fire
  agent WORKER boots the shipped scenario (`controller_fire.js` via
  `scene.json` → `fire.json`), ticks it at 4× and streams `fire.setGrid` /
  `fire.delta` to BOTH overlays — 2D scar + flames on the Plan map
  (`fireOverlay2d.js`) and the 3D billboard stack on the Steer globe
  (`fireOverlay3d.js`: clamped flame + smoke billboards, LOD-capped, scar
  rectangle draped on the tiles). Game over arrives as
  `game.over {outcome:'lost'|'held'}` → window event `fire:gameover`.
  The hidden perimeter is NOT rendered; add `&fireZone=1` for the dev-only
  red debug outline. Console handle `__fireDemo`: `drop(lon,lat[,r])` (the
  player capability), `ignite(...)`, `state()` (last snapshot), `speed(x)`,
  `stop()`.

## Adding a new harness

Name it `dev/<subject>_viewer.html`, standalone HTML with an inline
`<script type="module">`, importing package components by `../assets/...`
relative URLs (three.js comes from the import map the existing viewers use).
Syntax-check the inline module by extracting it and running `node --check`,
then curl the page for HTTP 200 before handing it over. Keep harnesses
stateless: reset = `location.reload()`.

## Scenario authoring flow (fire)

1. Open `tools/geo-editor.html`. **Presets → fire perimeter / bay mask** loads
   the engine's existing geometry; **presets → current scenario** loads the
   shipped `controller_fire.js` for editing (full round-trip).
2. **Boundary mode**: draw/edit the perimeter (click add, drag move,
   right-click delete). **Water mode**: rings that never burn (ocean bays,
   firebreaks) — multiple rings supported. **Ignition mode**: click spots;
   radius + activation time (`atSimS`) editable in the ignitions table.
3. **Wind keyframes** table: `(t s, toward°, m/s)` timeline — the fire bends
   when the wind shifts. **Scenario** row: cell size, seed, loss threshold
   (`occupyFrac` 1.0 = players saved nothing).
4. **Preview** drawer: runs the package sim on exactly this data; watch it
   burn, shift with the keyframed wind, and latch GAME OVER at full
   occupation before you ship anything.
5. **Export → box mode `controller_fire.js`** → download (or copy) and save
   over `assets/fire/controller_fire.js`. The generated file is byte-shaped
   like the hand-written contract (`FIRE_SCENARIO_API`,
   `createFireScenario()`, `describe()`, default export).
6. Confirm in-engine at `/play?fireDemo=1`; watch `occupyFrac`/`lost` via
   `__fireDemo.state()`.

Game over fires when the latch sets: fire occupied the whole polygon,
residual islands counted, water-saved fuel not.
