# dev/ — developer harnesses for the `demo-wildfire` package

Everything in this directory is a **developer instrument**, never a player
surface: no game UI links to it, no engine code imports it, and it is not part
of any bundle. The pages are plain standalone HTML served by the Vite dev
server under `/games/demo-wildfire/dev/...` (the same static middleware that
serves `/games/*`). In production the games tree is rsynced wholesale, so these
pages are reachable by URL but deliberately unlinked; the ECS rsync may exclude
`dev/` entirely without breaking anything.

Start the dev server from `client/`:

```bash
cd client && npm run dev        # http://localhost:5173
```

## The one rule: packages message the engine; only the engine touches the browser

Package code (anything under this package directory) NEVER calls browser APIs
directly — no DOM, no `window`/`document`, no canvas, no WebGL/three.js, no
Cesium, no `fetch`, no storage. A package is pure state plus pure functions: it
computes and emits **textual messages** (plain JSON envelopes), and the static
game engine is the one component that translates those messages into browser
API calls (Google Maps overlays, Cesium entities, canvas rAF loops, audio).

```
package (agents / capabilities / environment / render — pure data + functions)
   │   { "type": "agents.state" | "agents.world", ... }   <- JSON only
   ▼
static engine (agent runtime, overlays, views)
   │   the ONLY holder of browser APIs
   ▼
DOM / WebGL / Google Maps / Cesium
```

- Message vocabulary: `{ type, ...payload }`, JSON-serializable, versioned per
  family. The NORMATIVE definition of every wire type is the engine registry:
  `client/src/engine/protocol.js` (envelope kernel, validation policy) +
  `client/src/engine/families/agents.js` (the multi-agent family — `agents.state`
  / `agents.world` / `agents.event` / `agents.order` with required/optional field
  specs). Both edges validate in warn mode: invalid envelopes are reported loudly
  but still delivered (v1); the engine ignores unknown types instead of failing —
  fail-safe against a newer package running on an older engine.
- A package does not even load its own files: the engine resolves URLs through
  `package.json` → the declared module paths and imports them. Packages never fetch.
- Structural enforcement: at play time package code runs in a per-session Web
  Worker — the generic core `client/src/workers/gameCore.worker.js` (L1). It
  boots a Cordis context, fetches `package.json`, and mounts the generic
  `AgentRuntime`, whose loader (`client/src/engine/agents/loadPackage.js`)
  imports the package's archetype/capability/environment modules.
  `window`/`document` do not exist in the worker, so a violation is not a review
  finding, it is a crash on arrival.
- Audit grep before shipping any package (comments are the only acceptable hit):
  `grep -rn "window\.\|document\.\|fetch(\|THREE\|canvas\|navigator\." agents capabilities environment render`
- The ONE exception is this `dev/` directory: a harness *stands in for the
  engine* (it is the thing calling three.js and the DOM on the package's
  behalf), which is exactly why harnesses are developer-only and never ship.

## Package layout this directory serves

```
games/demo-wildfire/
├── card.json            # Plaza storefront ONLY (title, copy, trailer, action)
├── package.json         # the agent manifest the core worker boots from
├── media/               # trailer / poster
├── agents/              # WHO acts — one folder per character + index.js + roster.js
│   ├── drone/           #   index.js + reasoning.js + render.js + avatar.svg + controller_drone.js + drone.json
│   ├── commander/       #   index.js + render.js + avatar.svg
│   └── staff/           #   index.js + render.js + avatar.svg
├── environment/         # the ENABLER — environment.js + fire_sim.js + scenario.js + render.js
│   └── verbs/           #   dropWater.js, sprayDryIce.js, scanFire.js, index.js
├── render/              # bindings.js — aggregator: agents/*/render.js + environment/render.js
├── meshes/              # the .glb library (drone_dji_air3.glb)
└── dev/                 # this directory: viewers + this README
```

## Agent-aligned package reorg (E6, shipped)

The legacy layout was **asset-centric**: one `assets/<id>/` directory per
renderable thing, wired to the engine through `scene.json` → a manifest → an
engine-side *driver*. E6's core idea is **everything can be an agent** — an
agent is a container of named capabilities (sensors + actuators) + state + a
reasoning plugin — so the package is now organized around **who acts**, not
**what is drawn**. E6.8 rebuilt this flagship into the agent shape and E6.9
deleted the legacy `scene.json` + fire-driver path.

> **Shipped:** the package is now organized around **who acts** — one folder per
> character under `agents/` (spec + reasoning + render binding + avatar), with the
> world's verbs under `environment/verbs/` (the environment is the enabler) and the
> mesh library under `meshes/`. The flat `capabilities/` pool and the `assets/`
> content dir are gone: `createEnvironment()` returns the verbs as `capabilities`
> and the engine auto-registers them, so `package.json` no longer needs a
> `capabilities` entry. No separate `triggers/` module was needed yet.

### The split the reorg must respect

The engine provides **mechanism**; the package provides **content**. Every file a
package adds is pure content (data + dependency-free functions); the engine is
the only code that touches a browser or the Cordis runtime.

| Concern | Engine (mechanism, never edited per game) | Package (content, all of it here) |
|---|---|---|
| Agents | `AgentRuntime`, capability registry, `WorldModel` | `agents/` archetypes + roster |
| Reasoning | generic interpreters: `stateMachine`, `rlPolicy`, `remote`, `human` | `agents/<role>/reasoning.js` SM tables + RL weights; the archetype picks a kind |
| Capabilities | builtins (`moveTo`, `nearbyAgents`, `emitMessage`, `drawOrder`, `screenshotConsult`, …) | `environment/verbs/` domain sensors/actuators (`dropWater`, `sprayDryIce`, `scanFire`), surfaced via the environment |
| Environment | `attachEnvironment` / `tickEnvironment` contract | `environment/` the fire CA sim + scenario + the env adapter |
| Narrative | none authored — events emerge from agent interaction | `triggers/` predefined conditions that inject events |
| Rendering | L2 primitives (`markerOverlay`, `modelOverlay`, `polylineOverlay`, `cellGridOverlay`) | `agents/*/render.js` + `environment/render.js`, aggregated by `render/bindings.js`; primitive referenced **by name** |

### Shipped tree

```
games/demo-wildfire/
├── card.json               # (unchanged) Plaza storefront ONLY
├── package.json            # package manifest: id, version, and the entry points
│                           #   below (what the worker imports to boot)
├── media/                  # (unchanged) trailer / poster
│
├── agents/                 # WHO acts — one folder per character (full cohesion)
│   ├── drone/              #   the drone archetype owns everything about itself:
│   │   ├── index.js        #     spec: reasoning:'stateMachine'; owns moveTo+dropWater/sprayDryIce
│   │   ├── reasoning.js    #     the drone state-machine transition table (package CONTENT)
│   │   ├── render.js       #     waterDrone + dryIceDrone bindings (meshUrl + avatarUrl)
│   │   ├── avatar.svg      #     package-declared avatar (2D plan badge + chatbot icon)
│   │   ├── controller_drone.js # kinematics facade (pose integration)
│   │   └── drone.json      #     rig facts as data (units, noseAxis, yawTrimDeg)
│   ├── commander/          #   index.js (reasoning:'human') + render.js + avatar.svg
│   ├── staff/              #   index.js (reasoning:'remote'/VLM) + render.js + avatar.svg
│   ├── index.js            #   archetype registry: name -> spec factory
│   └── roster.js           #   the initial spawn: which archetypes, counts, poses
│
├── environment/            # the ENABLER — the world agents perceive + act on
│   ├── environment.js      #   the generic env adapter: {bounds, cellAt, tick, capabilities}
│   ├── fire_sim.js         #   the CA fire-spread sim (pure JS)
│   ├── scenario.js         #   perimeter/ignitions/wind keyframes (the scenario)
│   ├── render.js           #   fire-grid value -> colour ramp (cellGridOverlay)
│   └── verbs/              #   the domain sensors + actuators (pure JS)
│       ├── dropWater.js    #     actuator: apply a water drop to the environment
│       ├── sprayDryIce.js  #     actuator: dry-ice suppression (new flagship ability)
│       ├── scanFire.js     #     sensor: read the fire grid around the agent
│       └── index.js        #     PACKAGE_CAPABILITIES: the verb registry
│
├── render/                 # L2 bindings aggregator (archetype -> engine primitive, by name)
│   └── bindings.js         #   composes agents/*/render.js + environment/render.js; createRenderBindings()
│
├── meshes/                 # the .glb library
│   └── drone_dji_air3.glb
│
└── dev/                    # (unchanged) developer harnesses + this README
```

(No `triggers/` module was needed yet — events emerge from agent interaction; if a
package later wants authored conditions, `triggers/` is the intended home.)

### Migration mapping (legacy → shipped)

| Legacy | Shipped | Note |
|---|---|---|
| `assets/fire/fire_sim.js` | `environment/fire_sim.js` | the CA sim stays pure-JS content; `environment/environment.js` imports it |
| `assets/fire/controller_fire.js` | `environment/scenario.js` | perimeter/ignitions/wind keyframes (the scenario) |
| `assets/fire/fire.json` | **deleted** | the manifest/driver path is gone; `environment.js` + `package.json` replace it |
| `capabilities/*.js` | `environment/verbs/*.js` | the environment is the enabler: it returns the verbs as `capabilities` |
| `assets/drone/controller_drone.js` | `agents/drone/controller_drone.js` | the drone archetype owns its kinematics facade |
| `assets/drone/drone.json` | `agents/drone/drone.json` | rig facts stay data, now drone-owned |
| `assets/drone/drone_dji_air3.glb` | `meshes/drone_dji_air3.glb` | the mesh library; `agents/drone/render.js` references it by URL |
| `agents/archetypes/<role>.js` | `agents/<role>/index.js` | one folder per character (spec + reasoning + render + avatar) |
| `agents/reasoning/drone_fsm.js` | `agents/drone/reasoning.js` | reasoning CONTENT lives with the archetype that uses it |
| `assets/tank/*` | **deleted** | the flagship drops the tank (E6.8); more drones instead |
| `scene.json` (asset list) | `package.json` (entry points) | the worker boots from `package.json`, not a driver list |

### The one rule still holds

Every directory is **pure content**: `agents/`, `environment/` (incl. `verbs/`),
and `render/bindings.js` are dependency-free ESM that run identically in the core
Web Worker and in plain Node. None of them may touch
`window`/`document`/canvas/WebGL/Cesium/Maps/`fetch` — the `render.js` modules
reference engine primitives **by name** (`engine:modelOverlay`) and the engine
resolves the name to browser code. The audit grep below still applies to the whole
package, and the headless tests import these modules directly.

### Why this is the right shape

- **Adding an agent = adding content, never engine code.** A new archetype file +
  (optionally) a capability + a roster entry + a render binding. The engine's
  `AgentRuntime` mounts it generically.
- **The separation is testable.** The rename litmus (this package `demo-wild-fire`
  → `demo-wildfire`) already proved the engine names no package in code; the
  agent reorg extends that: removing the tank and adding dry-ice drones edits
  ONLY files under this directory.
- **No authored storyline.** `triggers/` holds predefined conditions; the narrative
  emerges from agents reacting to each other and the environment through the
  generic `agents.event` feed. There is no replay/chronicle system (dropped).

## How to author an agent (E6)

This is the forward path. Adding an agent touches **four content files under
this directory and zero engine files**.

### 1. The archetype — `agents/archetypes/<name>.js`

A factory returning a plain descriptor. No browser APIs, no engine imports:

```js
export function makeScout({ id, lon, lat, alt = 200 }) {
  return {
    id,
    archetype: 'scout',                 // the render-binding key
    state: { pose: { lon, lat, alt, headingDeg: 0 }, status: 'scan' },
    sensors:   ['scanFire', { name: 'nearbyAgents', radiusM: 1000 }],
    actuators: ['moveTo', 'emitMessage'],   // names resolved in capabilities/
    reasoning: scoutFsm(),              // { kind:'stateMachine', ... } (fast)
  };
}
```

`reasoning.kind` is one of the engine's four interchangeable interpreters:
`stateMachine` / `rlPolicy` (fast, deterministic, run inside the core worker) or
`remote` / `human` (slow, run through a proxy — the tick uses the last proposed
intent and never awaits the model/player). Register the archetype in
`agents/archetypes/index.js`'s `ARCHETYPES` map.

### 2. Capabilities (only if you need a new one) — `capabilities/`

A **sensor** is a pure query `(agent, world, params) -> JSON`. An **actuator** is
an intent handler that flows through the single funnel `validate → clamp → gate →
apply`; it returns the state mutation (or a note), never a browser call. Export
them from `capabilities/index.js`'s `PACKAGE_CAPABILITIES` so the loader can
resolve the names an archetype lists. Reuse `moveTo` / `emitMessage` before
writing a new actuator.

### 3. The roster — `agents/roster.js`

`createRoster(env, options)` returns the list of agents to spawn (id + position +
archetype factory call). This is the ONLY place that decides **who** is in the
world — `commander` (a `human`) and `staff` (a `remote`/VLM) are characters of
THIS package, not engine concepts. Another game can ship a roster with neither.

### 4. The render binding — `render/bindings.js`

Map the archetype name to an engine primitive **by name** plus its style, and map
an opaque cell value to a colour. Pure data + pure functions:

```js
// agents/<role>/render.js — aggregated into RENDER_BINDINGS by render/bindings.js
export const SCOUT_BINDINGS = {
  scout: {
    primitive: 'engine:modelOverlay', kind: 'model',
    meshUrl: 'meshes/drone_dji_air3.glb', modelScale: 0.1, color: '#38bdf8',
    avatarUrl: 'agents/scout/avatar.svg', displayName: 'Scout', avatarKind: 'machine',
  },
};
```

The engine resolves `engine:modelOverlay` / `engine:markerOverlay` /
`engine:cellGridOverlay` / `engine:polylineOverlay` to browser code; the package
never ships rendering. An unknown archetype degrades to `FALLBACK_STYLE`.

### 5. Declare the entry points — `package.json`

The worker fetches `package.json` FIRST. Its `agents` block tells the generic
loader what to import:

```json
"agents": {
  "environment": "environment/environment.js",
  "environmentOptions": { "seed": 7 },
  "roster": "agents/roster.js"
},
"render": "render/bindings.js"
```

(The environment carries the domain verbs — `createEnvironment()` returns them as
`capabilities` — so there is no separate `agents.capabilities` entry point.)

A fixed `seed` makes the same package replay the same emergence. No `agents`
block ⇒ the runtime stays inert (degrade, never break).

### 6. The environment — `environment/environment.js`

`createEnvironment(options)` returns the shared world: `bounds`, `grid`,
`tick(dt)`, `snapshot()`, the package `capabilities`, and — for the render relay
— `cellFrame()`, which returns `{ grid, cells:[[index,value],…] }` of opaque
per-cell deltas (or `null` when nothing changed). The engine forwards `cellFrame()`
verbatim as `agents.world`; it never interprets a value.

### 7. Test it headlessly (do this first)

The whole agent stack imports in plain Node (no `self`, no `fetch`):

```bash
node --input-type=module -e "
const { createEnvironment } = await import('$(pwd)/environment/environment.js');
const { createRoster } = await import('$(pwd)/agents/roster.js');
const env = createEnvironment({ seed: 7 });
const agents = createRoster(env);
for (let i = 0; i < 100; i++) env.tick(0.5);
console.log(agents.map(a => a.id), env.cellFrame()?.cells.length);
"
```

Assert determinism (same seed ⇒ identical `gridHash` / cell deltas) and the
invariants you care about. The full runtime path (loader + world + reasoning +
`agents.state`/`event`/`world`) is exercised by the scratch worker test
(`/tmp/e6_worker_test.mjs`) and the flagship e2e (`/tmp/e6_flagship_test.mjs`),
which boot the REAL `client/src/workers/gameCore.worker.js` against this package.

## Package content modules (meshes + the fire sim)

There is no `scene.json`, no per-asset manifest and no engine-side driver anymore
(E6.9 removed them); the pure-JS content now lives under `environment/` and
`meshes/`, and each character owns its body under `agents/<role>/`.

- **The fire sim** (`environment/fire_sim.js`) + **scenario**
  (`environment/scenario.js`: perimeter, `noFuelPolygons`, scheduled
  `ignitions`, wind `keyframes`, `loss.occupyFrac`) are dependency-free ESM.
  `environment/environment.js` imports them and adapts them to the engine's
  generic environment contract; the engine never names fire.
- **The drone mesh** (`meshes/drone_dji_air3.glb`) is referenced **by URL**
  from `agents/drone/render.js` (archetype → `modelOverlay`), aggregated by
  `render/bindings.js`. Rig conventions (`units`, `noseAxis`, `yawTrimDeg`,
  `groundLiftM`) live as data in `agents/drone/drone.json` so a host never
  re-derives them.
- Rendering is ENGINE-owned: the `render.js` modules reference the generic L2
  primitives by name (`engine:modelOverlay`, `engine:cellGridOverlay`); a package
  never ships rendering code.

Rules that keep the boundary clean: a package imports nothing from the engine;
`card.json` stays storefront-only; the disaster perimeter is hidden game state
(sim + loss check only) and must never reach a player-facing renderer.

## How to test content headlessly (do this first)

Package modules are dependency-free ESM, so Node runs them directly — the
`environment/` + roster snippet in step 7 above is the quickest smoke test. For
the fire sim itself, assert determinism (`getState().gridHash` equal across two
instances given the same seed + command sequence) and the invariants you care
about (spread anisotropy under wind, water knockdown leaving an ash hole, water
masks impassable, loss latch). Write longer assertions to a scratch `.mjs` file
and run `node file.mjs` — long `node -e` one-liners fight shell quoting.

The generic core WORKER is headless-testable too: stub `globalThis.self`
(capture `postMessage`) and `globalThis.fetch` (read from disk), import
`client/src/workers/gameCore.worker.js`, drive `self.onmessage({data:
{type:'boot', packageBase:'<repo>/games/demo-wildfire/', speed:3600}})` and
assert the agent lifecycle `core.ready{package,agents} → agents.state* →
agents.world* → agents.event*` (`/tmp/e6_worker_test.mjs`). The flagship e2e
(`/tmp/e6_flagship_test.mjs`) boots the same worker and asserts seeded
determinism (same seed ⇒ identical snapshots + fire `gridHash`). An unknown
archetype/capability/reasoning is skipped with a note — degrade, never break.

## How to test visually (the harnesses here)

| Page | Subject | What to verify |
|---|---|---|
| `dev/controller_viewer.html` | drone | mesh loads at sane scale (mm asset!); green nose arrow = mesh −Z; forward translates along the arrow; rotors spin with throttle; chase cam follows |
| `dev/fire_sim_viewer.html` | fire sim | top-down CA: ignition grows radially with calm wind, anisotropically downwind with a Santa Ana preset; water mode knocks a hole that settles to black ash; wet unburned dries back; HUD counts/ha/containment move sensibly |

Open them directly, e.g.
`http://localhost:5173/games/demo-wildfire/dev/fire_sim_viewer.html`. Each page
imports its artifact by relative URL (`../assets/...`), so a harness keeps
working after any package-internal move.

Two related instruments live elsewhere:

- `http://localhost:5173/tools/geo-editor.html` — repo-root, cross-package:
  the full fire-scenario authoring tool. Boundary / water-mask / ignition draw
  modes, wind-keyframe timeline, an in-tool preview that runs the package's
  `fire_sim.js` on exactly the drawn data, and an exporter that emits
  `controller_fire.js` verbatim. Dev-only by deployment (production serves no
  `/tools/*`).
- `http://localhost:5173/play?agentDemo=1` — the in-engine **agent** check: the
  generic core worker boots this package from `package.json`, mounts the
  `AgentRuntime`, spawns the roster (commander / staff / water-drones /
  dry-ice-drone) and streams `agents.state` / `agents.world` / `agents.event`.
  The host relay (`useAgentScene.js`) feeds the L2 primitives: agent markers /
  models + the environment cell grid (the fire scar) coloured via
  `render/bindings.js`, on BOTH the Plan map (2D) and the Steer globe (3D).
  Override the package with `&pkg=/games/<name>/`. The hidden perimeter is NOT
  rendered; add `&fireZone=1` for the dev-only red debug outline. Console handle
  `__agentDemo`: `order(agentId, intent)` (route a player order to a `human`
  agent), `state()` (last snapshot), `speed(x)`, `stop()`.

### The slow clock (remote / VLM agents)

An agent whose archetype declares `reasoning:'remote'` (e.g. `staff`) runs on the
SLOW clock. Alongside the deterministic core worker, the per-session agent worker
`client/src/workers/gameAgent.worker.js` owns every remote-AI call so the tick
never awaits a model. Like the core worker it is engine-side (not package code),
so its `fetch` is legitimate; the one rule binds package content only. Data flow:
the host relays an observation → the agent worker POSTs `/api/game/agent/decide`
with the agent's `archetype` (+ optional inline `actions`, `persona` and a
screenshot `image`) → the server's generic `decide` builds a prompt from the
package-declared tools, runs the ladder `vlm (if image) → llm → hold`, and returns
a whitelist-validated *intent* → the agent worker emits it → the host forwards it
to the core worker as an ordinary `agents.order`, applied at the next tick
commit. The model never mutates state; it only proposes intents the core
validates. Wire protocol: `client/src/engine/families/agent.js` (normative).

- The server is required for `remote` agents. Dev: `cd server && python3
  scripts/agent_dev_server.py` (:8000, `auto` ladder); the Vite `/api` proxy
  forwards `:5173/api/*` to it, so the worker's origin-relative fetch works with
  no client change. A package registers its per-archetype whitelist via
  `POST /api/game/agent/archetype` (or inline per decide call).
- Session lifecycle: on start the worker POSTs `/session/open`; on stop it
  best-effort POSTs `/session/close` (`keepalive`). Both are courtesies — the
  server keeps an authoritative idle GC (`game_agent.session_ttl_s`, default
  900 s), so a closed tab / crash that never sends close is still reaped.
  `GET /api/game/agent/sessions` lists live sessions (ops visibility).
- Production (ECS01): `app.main` mounts the same router under `/api`
  (`game_agent_api.py`) and Caddy forwards `/api/*` → `127.0.0.1:8000`, so the
  identical origin-relative URL works with no client or Caddyfile change — only
  the host differs. Set `game_agent.model` / `vlm_model` and the Bailian creds in
  the gitignored `server/config.json`. `decide` degrades to a safe hold
  (`intent:null`) on any failure, so the beat never blocks on a model.

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
6. Confirm in-engine at `/play?agentDemo=1`; watch the environment grid +
   `occupyFrac`/`lost` via `__agentDemo.state()`.

Game over fires when the latch sets: fire occupied the whole polygon,
residual islands counted, water-saved fuel not.
