// useFireDemo.js — temporary protocol client standing in for the future fire
// agent worker (step 3). Enabled ONLY with ?fireDemo=1 on the URL.
//
// It does exactly what the worker will do later, minus the Worker boundary:
//   1. dynamically import the PACKAGE simulation (/games/demo-wild-fire/
//      fire_sim.js) — package code, loaded as data, never bundled;
//   2. tick it at 4× real time;
//   3. feed the ENGINE effect exclusively through protocol commands
//      (fire.setGrid / fire.delta) — no direct effect internals;
//   4. attach the 2D overlay glue to whichever Google map is live, re-attaching
//      when the map instance changes (Plan <-> Steer round trips).
//
// Manual play from the DevTools console:
//   __fireDemo.drop(-118.53, 34.05)        // 400 m water drop
//   __fireDemo.ignite(-118.54, 34.06)      // new ignition
//   __fireDemo.state()                     // phase / counts / ha / containment

import { PALISADES_FIRE, SANTA_MONICA_BAY } from '@/config/palisadesFire.js';
import { createFireEffect } from '@/effects/fireEffect.js';
import { attachFireOverlay2d } from '@/effects/fireOverlay2d.js';

const SIM_URL = '/games/demo-wild-fire/fire_sim.js';
const SPEED = 4;          // sim seconds per real second
const STEP = 0.5;         // sim tick size (s)

export function useFireDemo() {
  let started = false;
  let raf = 0;
  let overlay = null;
  let attachedMap = null;

  function enabled() {
    return new URLSearchParams(window.location.search).has('fireDemo');
  }

  async function start(getMap) {
    if (started || !enabled()) return;
    started = true;

    const mod = await import(/* @vite-ignore */ SIM_URL);
    const sim = mod.createFireSim({
      perimeter: PALISADES_FIRE.perimeter,
      noFuelPolygons: [SANTA_MONICA_BAY],   // the perimeter's south lobe is ocean
      cellSizeM: 60,
      seed: 7,
      wind: { toDeg: 225, speedMps: 12 },   // Santa Ana toward the southwest
    });
    const effect = createFireEffect();
    const g = sim.gridInfo();
    effect.handleCommand({
      type: 'fire.setGrid',
      grid: {
        cols: g.cols, rows: g.rows,
        lonMin: g.lonMin, latMax: g.latMax,
        cellDegLon: g.cellDegLon, cellDegLat: g.cellDegLat,
      },
    });

    const push = () => {
      const ch = sim.takeChanges();
      if (ch.burning.length || ch.ash.length || ch.wet.length || ch.unburned.length) {
        effect.handleCommand({ type: 'fire.delta', ...ch });
      }
    };

    function syncOverlay() {
      const m = typeof getMap === 'function' ? getMap() : null;
      if (m && m.map !== attachedMap) {
        overlay?.detach();
        overlay = attachFireOverlay2d(m.mapsApi, m.map, effect);
        attachedMap = m.map;
      }
    }

    sim.ignite(PALISADES_FIRE.center.lng, PALISADES_FIRE.center.lat, 150);
    push();

    let acc = 0;
    let last = performance.now();
    const loop = (now) => {
      raf = requestAnimationFrame(loop);
      acc += ((now - last) / 1000) * SPEED;
      last = now;
      let stepped = false;
      while (acc >= STEP) { sim.tick(STEP); acc -= STEP; stepped = true; }
      if (stepped) push();
      syncOverlay();
    };
    raf = requestAnimationFrame(loop);

    window.__fireDemo = {
      drop: (lon, lat, radiusM = 400) => { sim.dropWater(lon, lat, radiusM); push(); return sim.getState(); },
      ignite: (lon, lat, radiusM = 90) => { sim.ignite(lon, lat, radiusM); push(); return sim.getState(); },
      state: () => sim.getState(),
      stop: () => stop(),
    };
    console.info('[fireDemo] live: __fireDemo.drop(lon, lat) / .ignite(lon, lat) / .state()');
  }

  function stop() {
    if (!started) return;
    cancelAnimationFrame(raf);
    overlay?.detach();
    overlay = null;
    attachedMap = null;
    delete window.__fireDemo;
    started = false;
  }

  return { start, stop, enabled };
}
