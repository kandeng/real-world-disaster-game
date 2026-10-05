// engine/drivers/fire.js — E2: the fire asset driver. This is the ENTIRE body
// of the old fireAgent.worker.js, demoted to one Cordis plugin that the
// generic core worker mounts per manifest (`driver: 'fire'`, falling back to
// the asset id). It owns: manifest resolution of the package's sim+scenario
// modules, the deterministic tick phase on the fast clock, and the fire-domain
// commands. It speaks ONLY through the databus — wire envelopes are produced
// by the family bridge, never here.
//
// Outcomes (posted as core-family 'game.over'):
//   'lost' — the loss latch fired (fire occupied the hidden polygon; the
//            scenario's loss.occupyFrac rule, islands counted, water-saved
//            fuel not).
//   'held' — fire is out (phase extinguished) with no scheduled beats left
//            and the latch never fired: the players defended the line.
//
// Config (passed by the core worker): { asset, manifestBase, manifest, speed }.
// Manifest-internal URLs are relative to the MANIFEST's directory; the core
// worker pre-computes manifestBase (the bug E2's predecessor was born from).

// Mounted by the core worker via ctx.inject(['clock','timer'], fireDriver,
// config) — Cordis 4's API for plain-function plugins with dependencies
// (ctx.plugin() only reads `inject` from object-shaped plugins). Accessing
// an undeclared service throws 'cannot get property X without inject'.
export function fireDriver(ctx, config) {
  const { manifestBase, manifest, speed } = config || {};
  const STATE_EVERY_MS = 2000;
  let sim = null;
  let over = false;
  let lastStatePost = 0;
  let bounds = null;   // { lonMin, latMin, lonMax, latMax } — cached from gridInfo (E3 observation)

  // Assemble the slow-clock observation: everything the AI advisor needs to
  // aim a drop, gathered from the sim (the only realm that owns fire state).
  // Pure read — the driver decides nothing; the server proposes, the core
  // worker applies. Emitted as fire.observe and relayed by the host.
  function buildObservation(st) {
    const hs = sim.hotspot();               // { lon, lat, burning } | null
    return {
      phase: st.phase,
      lost: st.lost,
      time: st.time,
      occupyFrac: st.occupyFrac,
      pending: st.pending,
      counts: st.counts,
      wind: st.wind,
      hotspot: hs ? { lon: hs.lon, lat: hs.lat } : null,
      bounds,
    };
  }

  function flush() {
    if (!sim) return;
    const ch = sim.takeChanges();
    if (ch.burning.length || ch.ash.length || ch.wet.length || ch.unburned.length) {
      ctx.emit('fire/delta', ch);
    }
  }

  function finish(outcome, st) {
    over = true;
    ctx.emit('fire/state', { state: st });
    ctx.emit('fire/observe', { observation: buildObservation(st) });   // terminal observation (parity with fire.state)
    ctx.emit('game/over', { outcome, state: st });
    ctx.clock.stop();
  }

  // fire-domain commands (host -> worker, routed by the family bridge)
  ctx.on('cmd/dropWater', (m) => {
    if (!sim) return;
    sim.dropWater(m.lon, m.lat, m.radiusM || 400);
    flush();
  });
  ctx.on('cmd/ignite', (m) => {
    if (!sim) return;
    sim.ignite(m.lon, m.lat, m.radiusM || 90);
    over = false;                  // dev sandbox: allow reigniting after an outcome
    flush();
    ctx.clock.start();
  });
  ctx.on('cmd/state', () => {
    if (sim) ctx.emit('fire/state', { state: sim.getState() });
  });

  // async load of the package modules, then mount the tick phase
  (async () => {
    const [simMod, scenMod] = await Promise.all([
      import(/* @vite-ignore */ manifestBase + manifest.sim.url),
      import(/* @vite-ignore */ manifestBase + manifest.scenario.url),
    ]);
    const scenario = scenMod[manifest.scenario.factory || 'createFireScenario']();
    sim = simMod[manifest.sim.factory || 'createFireSim'](scenario);

    const g = sim.gridInfo();
    bounds = {
      lonMin: g.lonMin,
      latMax: g.latMax,
      lonMax: g.lonMin + g.cols * g.cellDegLon,
      latMin: g.latMax - g.rows * g.cellDegLat,
    };
    ctx.emit('fire/setGrid', {
      grid: {
        cols: g.cols, rows: g.rows,
        lonMin: g.lonMin, latMax: g.latMax,
        cellDegLon: g.cellDegLon, cellDegLat: g.cellDegLat,
      },
    });

    ctx.clock.addPhase({
      step: (dt) => sim.tick(dt),
      frame: (now) => {
        if (!sim || over) return;
        flush();
        const st = sim.getState();
        if (now - lastStatePost >= STATE_EVERY_MS) {
          lastStatePost = now;
          ctx.emit('fire/state', { state: st });
          ctx.emit('fire/observe', { observation: buildObservation(st) });
        }
        if (st.lost) return finish('lost', st);
        if (st.phase === 'extinguished' && st.pending === 0) return finish('held', st);
      },
    });

    lastStatePost = performance.now();
    ctx.clock.start(speed);
  })().catch((err) => {
    ctx.emit('error', { message: `fire driver: ${String(err && err.message || err)}` });
  });
}
