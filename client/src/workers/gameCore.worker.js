// workers/gameCore.worker.js — E2/E6: the generic per-session core worker (L1).
//
// One worker = one game session = one Cordis root Context. Boot flow:
//   host --{type:'boot', packageBase, speed?}--> here
//     1. mount framework services: timer (disposal-aware), clock (fast clock);
//     2. fetch package.json; if it declares an 'agents' manifest, park it in the
//        module-scoped slot the AgentRuntime constructor consumes once, so the
//        generic loader imports the package's environment/capabilities/roster
//        HERE in the worker, where window/document do not exist — the one rule
//        stays structural;
//     3. mount the protocol family bridges (core + agents): databus events are
//        re-emitted as wire envelopes through the guarded post;
//     4. start the fast clock (idempotent) and emit core.ready { package, agents }.
//
// The engine names no package and no domain: it mounts whatever THIS package
// declares. A package with no package.json (or no 'agents' block) leaves the
// runtime inert and silent — degrade, never break.
//
// Inbound routing: every envelope is validated against the registry (warn
// mode); unknown types are ignored (degrade, never break). 'boot'/'halt' are
// handled by the worker itself; all other commands are emitted on the bus as
// 'cmd/<name>' for the owning service (setSpeed by the clock service itself;
// agents.order by the AgentRuntime).
//
// Wire protocol: NORMATIVE definitions in src/engine/families/{core,agents}.js.

import { Context } from '@deepseek-ai/cordis';
import TimerService from '@deepseek-ai/cordis-plugin-timer';
import { createGuardedPost, gateInbound, createBusBridge } from '../engine/protocol.js';
import { coreFamily, agentsFamily } from '../engine/families/index.js';
import { ClockService } from '../engine/clock.js';
import { AgentRuntime, setAgentPackageManifest } from '../engine/agents/service.js';

const post = createGuardedPost((m) => self.postMessage(m), { label: 'gameCore' });
const bridges = new Map();              // family name -> bus bridge
let root = null;

async function boot(msg) {
  if (root) { post({ type: 'error', message: 'gameCore: session already booted' }); return; }
  // packageBase is a REQUIRED boot field (families/core.js declares it 'string!').
  // The engine names no package: the host resolves one from the catalog and
  // passes it in, so renaming/adding a package never touches this file. A boot
  // without a packageBase is a host bug — degrade with an error, never guess.
  const packageBase = String(msg.packageBase || '');
  if (!packageBase) { post({ type: 'error', message: 'gameCore: boot requires a packageBase' }); return; }
  root = new Context();
  await root.plugin(TimerService);          // disposal-aware ctx.setTimeout
  await root.plugin(ClockService);          // the fast clock ('clock' service)

  // E6.8: discover the package's agent entry points BEFORE mounting the runtime.
  // package.json is the package manifest (the agent paradigm) and the SINGLE
  // source of truth for what a package contains. The WORKER resolves it and
  // parks the agent manifest in the module-scoped slot the AgentRuntime
  // constructor consumes once — so the engine still names no domain, it mounts
  // whatever this package declares. A package with no package.json, or no
  // 'agents' block, leaves the runtime inert and silent. Degrade never break: a
  // missing/invalid package.json is not an error.
  let agentManifest = null;
  try {
    const pkg = await (await fetch(packageBase + 'package.json')).json();
    if (pkg && pkg.agents) agentManifest = { ...pkg.agents, base: packageBase };
  } catch { /* no package.json: a legacy/content-only package — agents stay inert */ }
  if (agentManifest) setAgentPackageManifest(agentManifest);

  await root.plugin(AgentRuntime);          // E6: the generic agent runtime ('agents' service); inert + silent when a package declares no agents
  for (const fam of [coreFamily, agentsFamily]) {
    bridges.set(fam.name, createBusBridge(root, fam, post));
  }

  // E6.9: the legacy scene.json -> manifest -> driver path is gone. A package is
  // defined by its package.json 'agents' manifest (resolved above); the fast clock
  // is started here so the agents tick. start() is idempotent and ignores a
  // non-finite/<=0 speed, so an undefined speed keeps the clock default.
  if (agentManifest) { try { root.clock?.start?.(msg.speed); } catch { /* clock may be gone */ } }

  root.emit('core/ready', { package: packageBase, agents: !!agentManifest });
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
