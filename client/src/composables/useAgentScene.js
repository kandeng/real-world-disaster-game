// useAgentScene.js — E6.9: the GENERIC host relay for the agent paradigm.
// Enabled ONLY with ?agentDemo=1 on the URL.
//
// This is the host half of "everything can be an agent". It knows NOTHING about
// fire, drones, commanders or tanks: it spawns the generic core worker, hands it
// a package base URL, and relays the three GENERIC agent feeds into the pure L2
// scene model, then attaches the four render primitives to the live map (2D) and
// the shared Cesium viewer (3D).
//
//   core worker -> host:
//     agents.state {t, agents:[{id,archetype,alive,pose,status}]}  -> model.setState
//     agents.event {t, events:[{kind:'effect'|'message'|'note'}]}  -> model.handleEvent (per effect)
//     agents.world {t, grid?, cells:[[index,value],...]}           -> accumulate -> model.setCellGrid
//   host -> core worker:
//     agents.order {agentId, intent}                               <- order(agentId, intent)
//
// The ONLY package-specific thing this file touches is the package's
// render/bindings.js (pure content, no browser APIs), imported by URL at
// runtime for the archetype->style table and the value->colour cell mapper.
// Swapping the package (rename, remove the tank, add water/dry-ice drones)
// changes ZERO line here — that is the separation litmus test.
//
// Manual play from the DevTools console:
//   __agentDemo.order('commander', { type:'route', lon:-118.53, lat:34.05 })
//   __agentDemo.state()      // last agents.state snapshot
//   __agentDemo.speed(8)
//   __agentDemo.stop()

import { createAgentSceneModel, attachAgentOverlays2d, attachAgentOverlays3d } from '@/effects/agent/index.js';
import '@/engine/families/index.js';                    // registers the core + agent + agents families on the engine registry
import { createGuardedPost, gateInbound } from '@/engine/protocol.js';

const DEFAULT_PACKAGE_BASE = '/games/demo-wildfire/';  // overridden by ?pkg=; the engine names no package
const SPEED = 4;                                        // sim seconds per real second

export function useAgentScene() {
  let started = false;
  let worker = null;
  let model = null;
  let raf = 0;
  let overlay2d = null;
  let attachedMap = null;
  let overlay3d = null;
  let attachedViewer = null;
  let lastState = null;
  // agents.world accumulation: the worker sends OPAQUE per-cell deltas; the host
  // owns the full grid the cellGridOverlay paints. values[i] holds the raw cell
  // value (0 = the package's "unpainted" default); render/bindings maps it to a
  // colour. The engine never interprets a value.
  let grid = null;
  let values = null;

  function enabled() {
    return new URLSearchParams(window.location.search).has('agentDemo');
  }

  function packageBase() {
    const q = new URLSearchParams(window.location.search);
    const p = q.get('pkg');
    if (p) return p.endsWith('/') ? p : p + '/';
    return DEFAULT_PACKAGE_BASE;
  }

  // The package's render bindings are PURE content (no browser APIs — the one
  // rule holds), so importing them on the main thread is safe. Degrade never
  // break: a package with no render/bindings.js still draws agents via the
  // fallback marker style; only the cell grid + custom meshes are absent.
  async function loadBindings(base) {
    try {
      const mod = await import(/* @vite-ignore */ base + 'render/bindings.js');
      if (mod && typeof mod.createRenderBindings === 'function') return mod.createRenderBindings();
      if (mod && mod.RENDER_BINDINGS) {
        return { styles: mod.RENDER_BINDINGS, cellColorOf: mod.cellColorOf || null, fallback: mod.FALLBACK_STYLE || null };
      }
    } catch (err) {
      console.warn('[agentScene] no render/bindings.js — using fallback styles', err?.message || err);
    }
    return { styles: {}, cellColorOf: null, fallback: null };
  }

  async function start(getMap, getViewer) {
    if (started || !enabled()) return;
    started = true;

    const base = packageBase();
    const bindings = await loadBindings(base);
    model = createAgentSceneModel({
      styles: bindings.styles || {},
      cellColorOf: bindings.cellColorOf || null,
      fallback: bindings.fallback || undefined,
    });

    worker = new Worker(new URL('../workers/gameCore.worker.js', import.meta.url), { type: 'module' });
    const send = createGuardedPost((m) => worker.postMessage(m), { label: 'agentScene:host' });
    worker.onmessage = (e) => {
      const m = e.data || {};
      const v = gateInbound(m, { label: 'agentScene:host' });
      if (v.status === 'unknown') return;               // degrade, never break
      if (m.type === 'agents.state') {
        lastState = m;
        model.setState(m);
        model.pruneTransients(m.t);
      } else if (m.type === 'agents.event') {
        for (const ev of m.events || []) model.handleEvent(ev);
      } else if (m.type === 'agents.world') {
        applyWorld(m);
      } else if (m.type === 'core.ready') {
        console.info(`[agentScene] ready — package ${m.package}, agents: ${m.agents ? 'yes' : 'no'}`);
      } else if (m.type === 'error') {
        console.error('[agentScene]', m.message);
      }
    };
    worker.onerror = (e) => console.error('[agentScene] worker error', e.message || e);
    send({ type: 'boot', packageBase: base, speed: SPEED });

    function syncOverlays() {
      const m = typeof getMap === 'function' ? getMap() : null;
      if (m && m.map !== attachedMap) {
        overlay2d?.detach();
        overlay2d = attachAgentOverlays2d(m.mapsApi, m.map, model);
        attachedMap = m.map;
      }
      const v = typeof getViewer === 'function' ? getViewer() : null;
      if (v && v !== attachedViewer && !v.isDestroyed?.()) {
        overlay3d?.detach();
        overlay3d = attachAgentOverlays3d(v, model);
        attachedViewer = v;
      }
    }
    const loop = () => { raf = requestAnimationFrame(loop); syncOverlays(); };
    raf = requestAnimationFrame(loop);

    window.__agentDemo = {
      order: (agentId, intent) => send({ type: 'agents.order', agentId, intent }),
      state: () => lastState,
      speed: (s) => send({ type: 'setSpeed', speed: s }),
      stop: () => stop(),
    };
    console.info('[agentScene] worker live: __agentDemo.order(agentId, intent) / .state() / .speed(x) / .stop()');
  }

  // Fold one agents.world frame into the full cell-values array. The first frame
  // (or any frame carrying fresh geometry) (re)allocates the array; deltas are
  // then applied in place. cellVersion bumping inside setCellGrid throttles the
  // raster repaint.
  function applyWorld(m) {
    if (m.grid) {
      const g = m.grid;
      const size = (g.cols | 0) * (g.rows | 0);
      if (!grid || grid.cols !== g.cols || grid.rows !== g.rows) {
        grid = g;
        values = new Array(size).fill(0);
      }
    }
    if (!grid || !values) return;
    for (const pair of m.cells || []) {
      const idx = pair[0];
      if (idx >= 0 && idx < values.length) values[idx] = pair[1];
    }
    // colorOf omitted: setCellGrid falls back to the construction-time
    // cellColorOf from the package's render/bindings.js.
    model.setCellGrid(grid, values);
  }

  function stop() {
    if (!started) return;
    cancelAnimationFrame(raf);
    if (worker) { try { worker.postMessage({ type: 'halt' }); } catch { /* already gone */ } worker.terminate(); }
    worker = null;
    overlay2d?.detach();
    overlay2d = null;
    attachedMap = null;
    overlay3d?.detach();
    overlay3d = null;
    attachedViewer = null;
    model?.clear();
    model = null;
    grid = null;
    values = null;
    lastState = null;
    delete window.__agentDemo;
    started = false;
  }

  return { start, stop, enabled };
}
