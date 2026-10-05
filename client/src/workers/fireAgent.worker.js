// fireAgent.worker.js — ENGINE-owned per-session game worker: the fire agent.
//
// This is the Worker boundary that makes the package rule structural: package
// code (fire_sim.js + controller_fire.js, resolved through the package's
// scene.json -> fire.json manifests) runs HERE, where window/document do not
// exist. Everything crossing this boundary is a JSON message.
//
// host -> worker:
//   { type: 'start', packageBase, speed?, }      resolve + build sim + run
//   { type: 'dropWater', lon, lat, radiusM }     player drone water drop
//   { type: 'ignite', lon, lat, radiusM }        dev/debug ignition
//   { type: 'setSpeed', speed }                  sim seconds per real second
//   { type: 'state' }                            request a fire.state snapshot
//   { type: 'stop' }                             end the session
//
// worker -> host:
//   { type: 'fire.setGrid', grid }               engine effect protocol,
//   { type: 'fire.delta', burning, ash, wet, unburned }   passed through verbatim
//   { type: 'fire.state', state }                periodic (2 s) + on demand
//   { type: 'game.over', outcome: 'lost'|'held', state }
//   { type: 'error', message }
//
// Outcomes:
//   'lost' — the loss latch fired (fire occupied the hidden polygon; the
//            scenario's loss.occupyFrac rule, islands counted, water-saved
//            fuel not).
//   'held' — fire is out (phase extinguished) with no scheduled beats left
//            and the latch never fired: the players defended the line.

let sim = null;
let timer = 0;            // setTimeout handle of the tick loop
let acc = 0;              // sim-time accumulator (s)
let last = 0;             // last frame wall clock (ms)
let speed = 4;            // sim seconds per real second
const STEP_S = 0.5;       // sim tick size (s)
const STATE_EVERY_MS = 2000;
let lastStatePost = 0;
let over = false;

function post(m) { self.postMessage(m); }

function flushChanges() {
  if (!sim) return;
  const ch = sim.takeChanges();
  if (ch.burning.length || ch.ash.length || ch.wet.length || ch.unburned.length) {
    post({ type: 'fire.delta', ...ch });
  }
}

async function start(packageBase, opts) {
  const scene = await (await fetch(packageBase + 'scene.json')).json();
  const fireEntry = (scene.assets || []).find((a) => a.id === 'fire');
  if (!fireEntry) throw new Error('package scene.json has no fire asset');
  const manifestBase = packageBase + fireEntry.manifest.slice(0, fireEntry.manifest.lastIndexOf('/') + 1);
  const manifest = await (await fetch(packageBase + fireEntry.manifest)).json();
  // Manifest-internal URLs are relative to the MANIFEST's directory.
  const [simMod, scenMod] = await Promise.all([
    import(/* @vite-ignore */ manifestBase + manifest.sim.url),
    import(/* @vite-ignore */ manifestBase + manifest.scenario.url),
  ]);
  const scenario = scenMod[manifest.scenario.factory || 'createFireScenario']();
  sim = simMod[manifest.sim.factory || 'createFireSim'](scenario);
  speed = Number.isFinite(opts?.speed) && opts.speed > 0 ? opts.speed : 4;

  const g = sim.gridInfo();
  post({
    type: 'fire.setGrid',
    grid: {
      cols: g.cols, rows: g.rows,
      lonMin: g.lonMin, latMax: g.latMax,
      cellDegLon: g.cellDegLon, cellDegLat: g.cellDegLat,
    },
  });
  over = false;
  acc = 0;
  last = performance.now();
  lastStatePost = last;
  ensureLoop();
}

function ensureLoop() {
  if (!timer && sim && !over) timer = setTimeout(frame, 100);
}

function frame() {
  timer = 0;
  if (!sim || over) return;
  const now = performance.now();
  acc += ((now - last) / 1000) * speed;
  last = now;
  let n = 0;
  while (acc >= STEP_S && n < 4000) { sim.tick(STEP_S); acc -= STEP_S; n++; }
  if (n) flushChanges();

  const st = sim.getState();
  if (now - lastStatePost >= STATE_EVERY_MS) {
    lastStatePost = now;
    post({ type: 'fire.state', state: st });
  }
  if (st.lost) return finish('lost', st);
  if (st.phase === 'extinguished' && st.pending === 0) return finish('held', st);
  ensureLoop();
}

function finish(outcome, st) {
  over = true;
  post({ type: 'fire.state', state: st });
  post({ type: 'game.over', outcome, state: st });
}

self.onmessage = (e) => {
  const m = e.data || {};
  (async () => {
    switch (m.type) {
      case 'start':
        await start(String(m.packageBase || '/games/demo-wild-fire/'), m);
        break;
      case 'dropWater':
        if (!sim) return;
        sim.dropWater(m.lon, m.lat, m.radiusM || 400);
        flushChanges();
        break;
      case 'ignite':
        if (!sim) return;
        sim.ignite(m.lon, m.lat, m.radiusM || 90);
        over = false;              // dev sandbox: allow reigniting after an outcome
        flushChanges();
        ensureLoop();
        break;
      case 'setSpeed':
        if (Number.isFinite(m.speed) && m.speed > 0) speed = m.speed;
        break;
      case 'state':
        if (sim) post({ type: 'fire.state', state: sim.getState() });
        break;
      case 'stop':
        sim = null;
        if (timer) { clearTimeout(timer); timer = 0; }
        over = true;
        break;
    }
  })().catch((err) => post({ type: 'error', message: String(err && err.message || err) }));
};
