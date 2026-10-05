// useFireAgent.js — engine-side client of the per-session fire agent worker
// (step 5). Enabled ONLY with ?fireDemo=1 on the URL.
//
// The sim, the scenario and the loss latch live in the generic core worker
// (workers/gameCore.worker.js, E2): it boots a Cordis context, loads the
// package through scene.json -> manifests, and mounts the fire driver plugin
// (engine/drivers/fire.js). Package code runs where window/document do not
// exist, so "packages message the engine; only the engine touches the
// browser" is structural, not discipline. This composable is the thin host:
//   1. spawn the worker, hand it the package base URL;
//   2. relay its protocol messages (fire.setGrid / fire.delta) into the
//      engine fireEffect;
//   3. attach the effect's glue layers: fireOverlay2d on the live Google map
//      (Plan view) and fireOverlay3d on the shared Cesium viewer (Steer view);
//   4. surface game.over (outcome 'lost' | 'held') as a window event
//      'fire:gameover' — the supervisor/chat integration consumes it later;
//   5. expose the dropWater capability + dev console handles;
//   6. E3 (?aiAdvisor=1): spawn the per-session agent worker (the slow clock),
//      relay fire.observe -> agent.observe, and forward the server's intents
//      (agent.intent) back to the core worker as ordinary dropWater commands.
//
// Manual play from the DevTools console:
//   __fireDemo.drop(-118.53, 34.05)   // 400 m water drop (player capability)
//   __fireDemo.ignite(-118.54, 34.06) // dev-only ignition
//   __fireDemo.state()                // last fire.state snapshot from the worker
//   __fireDemo.stop()

import { createFireEffect } from '@/effects/fireEffect.js';
import { attachFireOverlay2d } from '@/effects/fireOverlay2d.js';
import { attachFireOverlay3d } from '@/effects/fireOverlay3d.js';
import '@/engine/families/index.js';                    // registers core + fire families on the engine registry
import { createGuardedPost, gateInbound } from '@/engine/protocol.js';

const PACKAGE_BASE = '/games/demo-wild-fire/';   // catalog baseUrl of the active package
const SPEED = 4;                                 // sim seconds per real second

export function useFireAgent() {
  let started = false;
  let worker = null;
  let agentWorker = null;
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

  // The AI advisor (slow clock) is opt-in: it needs the game-agent server
  // running, so plain ?fireDemo=1 must never spawn it and spam failed fetches.
  function advisorEnabled() {
    return new URLSearchParams(window.location.search).has('aiAdvisor');
  }

  // E3: spawn the per-session agent worker and wire the two-clock relay.
  // `send` is the guarded post toward the CORE worker, so a returned intent is
  // forwarded verbatim as an ordinary command (the core validates + commits).
  function spawnAdvisor(send) {
    const q = new URLSearchParams(window.location.search);
    agentWorker = new Worker(new URL('../workers/gameAgent.worker.js', import.meta.url), { type: 'module' });
    agentWorker.onmessage = (e) => {
      const m = e.data || {};
      const v = gateInbound(m, { label: 'fireAgent:advisor' });
      if (v.status === 'unknown') return;
      if (m.type === 'agent.intent') {
        if (m.intent) {
          send(m.intent);
          console.info(`[advisor] ${m.intent.type} (${m.policy || '?'}) — ${m.rationale || ''}`);
        }
      } else if (m.type === 'agent.status') {
        if (m.online === false) console.warn('[advisor] server offline');
        else if (m.mode) console.info(`[advisor] online — policy ${m.mode}, actions ${(m.actions || []).join(',') || '-'}`);
      } else if (m.type === 'agent.error') {
        console.warn('[advisor]', m.message);
      }
    };
    agentWorker.onerror = (e) => console.error('[advisor] worker error', e.message || e);
    agentWorker.postMessage({
      type: 'agent.start',
      serverUrl: q.get('agentApi') || '',
      session: q.get('session') || '',
      asset: 'fire',
      policy: q.get('agentPolicy') || '',
      beatMs: Number(q.get('agentBeatMs')) || undefined,
    });
    console.info('[advisor] agent worker live (slow clock) — intents relay to the core worker');
  }

  async function start(getMap, getViewer) {
    if (started || !enabled()) return;
    started = true;
    effect = createFireEffect();

    worker = new Worker(new URL('../workers/gameCore.worker.js', import.meta.url), { type: 'module' });
    const send = createGuardedPost((m) => worker.postMessage(m), { label: 'fireAgent:host' });
    worker.onmessage = (e) => {
      const m = e.data || {};
      const v = gateInbound(m, { label: 'fireAgent:host' });
      if (v.status === 'unknown') return;               // degrade, never break
      if (m.type === 'fire.setGrid' || m.type === 'fire.delta' || m.type === 'fire.clear') {
        effect.handleCommand(m);
      } else if (m.type === 'fire.state') {
        lastState = m.state;
      } else if (m.type === 'fire.observe') {
        if (agentWorker) agentWorker.postMessage({ type: 'agent.observe', observation: m.observation });
      } else if (m.type === 'game.over') {
        lastState = m.state || lastState;
        console.warn(`[fireAgent] GAME OVER — outcome: ${m.outcome}`, m.state);
        window.dispatchEvent(new CustomEvent('fire:gameover', { detail: { outcome: m.outcome, state: m.state } }));
      } else if (m.type === 'core.ready') {
        console.info(`[gameCore] ready — package ${m.package}, assets: ${m.assets.join(', ') || 'none'}`
          + (m.skipped?.length ? `, skipped: ${m.skipped.map((s) => `${s.id} (${s.reason})`).join(', ')}` : ''));
      } else if (m.type === 'error') {
        console.error('[fireAgent]', m.message);
      }
    };
    worker.onerror = (e) => console.error('[fireAgent] worker error', e.message || e);
    send({ type: 'boot', packageBase: PACKAGE_BASE, speed: SPEED });
    if (advisorEnabled()) spawnAdvisor(send);

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
      drop: (lon, lat, radiusM = 400) => send({ type: 'dropWater', lon, lat, radiusM }),
      ignite: (lon, lat, radiusM = 90) => send({ type: 'ignite', lon, lat, radiusM }),
      state: () => { send({ type: 'state' }); return lastState; },
      speed: (s) => send({ type: 'setSpeed', speed: s }),
      advisor: (on) => {
        if (on && !agentWorker) spawnAdvisor(send);
        else if (!on && agentWorker) { agentWorker.postMessage({ type: 'agent.stop' }); agentWorker.terminate(); agentWorker = null; }
      },
      policy: (p) => agentWorker?.postMessage({ type: 'agent.configure', policy: p }),
      stop: () => stop(),
    };
    console.info('[fireAgent] worker live: __fireDemo.drop(lon, lat) / .ignite(lon, lat) / .state() / .speed(x)');
  }

  function stop() {
    if (!started) return;
    cancelAnimationFrame(raf);
    if (worker) { try { worker.postMessage({ type: 'halt' }); } catch { /* already gone */ } worker.terminate(); }
    worker = null;
    if (agentWorker) { try { agentWorker.postMessage({ type: 'agent.stop' }); } catch { /* already gone */ } agentWorker.terminate(); }
    agentWorker = null;
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
