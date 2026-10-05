// useFireAgent.js — engine-side client of the per-session fire agent worker
// (step 5). Enabled ONLY with ?fireDemo=1 on the URL.
//
// The sim, the scenario and the loss latch live in the Worker
// (workers/fireAgent.worker.js): package code runs where window/document do
// not exist, so "packages message the engine; only the engine touches the
// browser" is structural, not discipline. This composable is the thin host:
//   1. spawn the worker, hand it the package base URL;
//   2. relay its protocol messages (fire.setGrid / fire.delta) into the
//      engine fireEffect;
//   3. attach the effect's glue layers: fireOverlay2d on the live Google map
//      (Plan view) and fireOverlay3d on the shared Cesium viewer (Steer view);
//   4. surface game.over (outcome 'lost' | 'held') as a window event
//      'fire:gameover' — the supervisor/chat integration consumes it later;
//   5. expose the dropWater capability + dev console handles.
//
// Manual play from the DevTools console:
//   __fireDemo.drop(-118.53, 34.05)   // 400 m water drop (player capability)
//   __fireDemo.ignite(-118.54, 34.06) // dev-only ignition
//   __fireDemo.state()                // last fire.state snapshot from the worker
//   __fireDemo.stop()

import { createFireEffect } from '@/effects/fireEffect.js';
import { attachFireOverlay2d } from '@/effects/fireOverlay2d.js';
import { attachFireOverlay3d } from '@/effects/fireOverlay3d.js';

const PACKAGE_BASE = '/games/demo-wild-fire/';   // catalog baseUrl of the active package
const SPEED = 4;                                 // sim seconds per real second

export function useFireAgent() {
  let started = false;
  let worker = null;
  let effect = null;
  let raf = 0;
  let overlay2d = null;
  let attachedMap = null;
  let overlay3d = null;
  let attachedViewer = null;
  let lastState = null;

  function enabled() {
    return new URLSearchParams(window.location.search).has('fireDemo');
  }

  async function start(getMap, getViewer) {
    if (started || !enabled()) return;
    started = true;
    effect = createFireEffect();

    worker = new Worker(new URL('../workers/fireAgent.worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      const m = e.data || {};
      if (m.type === 'fire.setGrid' || m.type === 'fire.delta' || m.type === 'fire.clear') {
        effect.handleCommand(m);
      } else if (m.type === 'fire.state') {
        lastState = m.state;
      } else if (m.type === 'game.over') {
        lastState = m.state || lastState;
        console.warn(`[fireAgent] GAME OVER — outcome: ${m.outcome}`, m.state);
        window.dispatchEvent(new CustomEvent('fire:gameover', { detail: { outcome: m.outcome, state: m.state } }));
      } else if (m.type === 'error') {
        console.error('[fireAgent]', m.message);
      }
    };
    worker.onerror = (e) => console.error('[fireAgent] worker error', e.message || e);
    worker.postMessage({ type: 'start', packageBase: PACKAGE_BASE, speed: SPEED });

    function syncOverlays() {
      const m = typeof getMap === 'function' ? getMap() : null;
      if (m && m.map !== attachedMap) {
        overlay2d?.detach();
        overlay2d = attachFireOverlay2d(m.mapsApi, m.map, effect);
        attachedMap = m.map;
      }
      const v = typeof getViewer === 'function' ? getViewer() : null;
      if (v && v !== attachedViewer && !v.isDestroyed?.()) {
        overlay3d?.detach();
        overlay3d = attachFireOverlay3d(v, effect);
        attachedViewer = v;
      }
    }
    const loop = () => { raf = requestAnimationFrame(loop); syncOverlays(); };
    raf = requestAnimationFrame(loop);

    window.__fireDemo = {
      drop: (lon, lat, radiusM = 400) => worker?.postMessage({ type: 'dropWater', lon, lat, radiusM }),
      ignite: (lon, lat, radiusM = 90) => worker?.postMessage({ type: 'ignite', lon, lat, radiusM }),
      state: () => { worker?.postMessage({ type: 'state' }); return lastState; },
      speed: (s) => worker?.postMessage({ type: 'setSpeed', speed: s }),
      stop: () => stop(),
    };
    console.info('[fireAgent] worker live: __fireDemo.drop(lon, lat) / .ignite(lon, lat) / .state() / .speed(x)');
  }

  function stop() {
    if (!started) return;
    cancelAnimationFrame(raf);
    worker?.postMessage({ type: 'stop' });
    worker?.terminate();
    worker = null;
    effect?.handleCommand({ type: 'fire.clear' });
    overlay2d?.detach();
    overlay2d = null;
    attachedMap = null;
    overlay3d?.detach();
    overlay3d = null;
    attachedViewer = null;
    lastState = null;
    delete window.__fireDemo;
    started = false;
  }

  return { start, stop, enabled };
}
