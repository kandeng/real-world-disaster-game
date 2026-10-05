// workers/gameCore.worker.js — E2: the generic per-session core worker (L1).
// Replaces the fire-specialized fireAgent.worker.js.
//
// One worker = one game session = one Cordis root Context. Boot flow:
//   host --{type:'boot', packageBase, speed?}--> here
//     1. mount framework services: timer (disposal-aware), clock (fast clock);
//     2. mount the protocol family bridges (core + fire): databus events are
//        re-emitted as wire envelopes through the guarded post;
//     3. fetch scene.json, and for each asset resolve its manifest and mount
//        the engine-side driver plugin it declares (manifest.driver, falling
//        back to the asset id). Package modules are imported BY THE DRIVER,
//        here in the worker, where window/document do not exist — the one
//        rule stays structural;
//     4. emit core.ready { package, assets }.
//
// Inbound routing: every envelope is validated against the registry (warn
// mode); unknown types are ignored (degrade, never break). 'boot'/'halt' are
// handled by the worker itself; all other commands are emitted on the bus as
// 'cmd/<name>' for the owning driver/service (setSpeed is consumed by the
// clock service itself).
//
// Wire protocol: NORMATIVE definitions in src/engine/families/{core,fire}.js.

import { Context } from '@deepseek-ai/cordis';
import TimerService from '@deepseek-ai/cordis-plugin-timer';
import { createGuardedPost, gateInbound, createBusBridge } from '../engine/protocol.js';
import { coreFamily, fireFamily } from '../engine/families/index.js';
import { ClockService } from '../engine/clock.js';
import { fireDriver } from '../engine/drivers/fire.js';

const DRIVERS = {
  // engine-side asset drivers, keyed by manifest.driver || asset.id.
  // Mounted through ctx.inject(deps, apply, config): Cordis 4 forks a child
  // context per plugin and ONLY exposes the declared services ('clock' for
  // the tick scheduler, 'timer' for disposal-aware ctx.setTimeout).
  fire: { inject: ['clock', 'timer'], apply: fireDriver },
};

const post = createGuardedPost((m) => self.postMessage(m), { label: 'gameCore' });
const bridges = new Map();              // family name -> bus bridge
let root = null;

async function boot(msg) {
  if (root) { post({ type: 'error', message: 'gameCore: session already booted' }); return; }
  const packageBase = String(msg.packageBase || '/games/demo-wild-fire/');
  root = new Context();
  await root.plugin(TimerService);          // disposal-aware ctx.setTimeout
  await root.plugin(ClockService);          // the fast clock ('clock' service)
  for (const fam of [coreFamily, fireFamily]) {
    bridges.set(fam.name, createBusBridge(root, fam, post));
  }

  const scene = await (await fetch(packageBase + 'scene.json')).json();
  const assets = [];
  const skipped = [];
  for (const asset of scene.assets || []) {
    try {
      const manifestBase = packageBase + asset.manifest.slice(0, asset.manifest.lastIndexOf('/') + 1);
      const manifest = await (await fetch(packageBase + asset.manifest)).json();
      const driverName = manifest.driver || asset.id;
      const driver = DRIVERS[driverName];
      if (!driver) {
        // Degrade, never break: a content-only asset (or one authored for a
        // newer engine) is skipped with a note — it is not a session error.
        skipped.push({ id: asset.id, reason: `no driver '${driverName}'` });
        continue;
      }
      await root.inject(driver.inject, (ctx) => driver.apply(ctx, { asset, manifestBase, manifest, speed: msg.speed }));
      assets.push(asset.id);
    } catch (err) {
      post({ type: 'error', message: `gameCore: asset '${asset.id}' failed to mount: ${String(err && err.message || err)}` });
      skipped.push({ id: asset.id, reason: 'mount failed' });
    }
  }
  root.emit('core/ready', { package: packageBase, assets, skipped });
}

function halt() {
  if (!root) return;
  const r = root;
  root = null;
  bridges.clear();
  try { r.clock?.stop(); } catch { /* service may be gone */ }
  r.fiber.dispose().catch(() => { /* already disposed */ });
}

self.onmessage = (e) => {
  const m = e.data || {};
  const v = gateInbound(m, { label: 'gameCore' });
  if (v.status === 'unknown') return;                    // degrade, never break
  if (m.type === 'boot') { boot(m); return; }
  if (m.type === 'halt') { halt(); return; }
  if (!root) return;                                     // commands before boot are dropped
  const bridge = bridges.get(v.family);
  bridge?.attachInbound(m);                              // -> bus 'cmd/<name>'
};
