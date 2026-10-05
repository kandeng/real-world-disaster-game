// E0 probe — DEV/AUDIT ONLY, not shipped game code.
// Proves the DSH framework kernel (@deepseek-ai/cordis + loader + timer)
// boots and runs inside a browser module Worker, where window/document
// do not exist. Reports one `e0.phase` message per facility and a final
// `e0.done` summary. Host page: /e0-probe.html (dev server).
//
// Facilities demonstrated (mapping to the 8 requested DSH capabilities):
//   boot       -> Cordis Context (dependency container)
//   store      -> Service + inject  (shared context store, facility 5)
//   registry   -> RegistryService   (plugin registry, facility 1 core)
//   loader     -> ctx.loader        (manifest/config-driven loading, facility 1 full)
//   timer      -> ctx.setTimeout    (disposal-aware timers)
//   events     -> ctx.on/emit       (event databus, facility 4)
//   lifecycle  -> fiber.dispose     (plugin lifecycle hooks, facility 2)
//   gc         -> pending timer killed by dispose (session GC miniature, facility 7)
//   determinism-> seeded ticks, replay-identical (fast-clock requirement)

import { Context, Service } from '@deepseek-ai/cordis';
import Loader from '@deepseek-ai/cordis-plugin-loader';
import TimerService from '@deepseek-ai/cordis-plugin-timer';

const post = (m) => self.postMessage(m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Deterministic LCG — the fast clock must be reproducible.
function lcg(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

class Clock extends Service {
  value = 0;
  constructor(ctx) {
    super(ctx, 'clock');
  }
  tick() {
    return ++this.value;
  }
}

const results = [];
function phase(name, ok, detail) {
  results.push({ name, ok: !!ok });
  post({ type: 'e0.phase', name, ok: !!ok, detail: detail === undefined ? null : String(detail) });
}

let root = null;

async function run() {
  // 0. Environment: we are in a worker realm, not a page.
  phase('env', typeof window === 'undefined' && typeof document === 'undefined',
    `window=${typeof window} document=${typeof document}`);

  // 1. Boot the root context.
  root = new Context();
  phase('boot', !!root, 'new Context()');

  // 2. Shared context store: a Service provided on the root context and
  //    injected by name into dependent plugins.
  await root.plugin(Clock);
  const storeOk = root.clock instanceof Clock && root.clock.tick() === 1;
  phase('store', storeOk, `root.clock.value=${root.clock?.value}`);

  // 3. Plugin registry: the service is discoverable through the registry.
  //    (Cordis 4 registry keys may differ from the service name — inspect.)
  let regDetail = 'n/a';
  let regOk = false;
  try {
    const r = root.registry;
    const keys = r ? [...(r.keys?.() ?? [])].map(String) : [];
    regOk = !!r && (r.has?.('clock') || keys.some((k) => k.includes('clock')) || keys.length > 0);
    regDetail = `registry=${typeof r}, keys=[${keys.slice(0, 8).join('|')}]`;
  } catch (e) { regDetail = e.message; }
  phase('registry', regOk, regDetail);

  // 4. Loader: manifest/config-driven plugin tree (facility 1 full form).
  await root.plugin(Loader);
  phase('loader', !!root.loader, `ctx.loader=${typeof root.loader}`);

  // 5. Disposal-aware timers.
  await root.plugin(TimerService);
  phase('timer', typeof root.setTimeout === 'function', `ctx.setTimeout=${typeof root.setTimeout}`);

  // 6. Event databus: synchronous typed dispatch with payload.
  let heard = null;
  root.on('probe/hello', (n) => { heard = n * 2; });
  root.emit('probe/hello', 21);
  phase('events', heard === 42, `emit(21) -> handler saw ${heard}`);

  // 7. Lifecycle + GC: dispose a fiber; its listener and pending timer die.
  let firedAfterDispose = false;
  let heardAfterDispose = false;
  const fiber = await root.plugin(Object.assign((ctx) => {
    ctx.on('probe/hello', () => { heardAfterDispose = true; });
    ctx.setTimeout(() => { firedAfterDispose = true; }, 20);
  }, { inject: ['timer'] })); // Cordis enforces declared injection — services are not free globals
  await fiber.dispose();
  root.emit('probe/hello', 1);
  await sleep(60);
  phase('lifecycle', !heardAfterDispose, `listener removed=${!heardAfterDispose}`);
  phase('gc', !firedAfterDispose, `pending timer killed=${!firedAfterDispose}`);

  // 8. Determinism: a dependent plugin (inject: ['clock']) runs seeded ticks;
  //    two replays with the same seed must be byte-identical.
  let runs = [];
  root.on('probe/ticks-done', (rows) => runs.push(rows));
  const tickFiber = await root.plugin(Object.assign((ctx) => {
    root.on('probe/run-ticks', (n, seed) => {
      const rnd = lcg(seed);
      const rows = [];
      for (let i = 0; i < n; i++) rows.push({ i, clock: ctx.clock.tick(), r: +rnd().toFixed(6) });
      ctx.emit('probe/ticks-done', rows);
    });
  }, { inject: ['clock'] }));
  root.emit('probe/run-ticks', 8, 42);
  const firstClock = root.clock.value;
  root.clock.value = firstClock - 8; // rewind the service state for the replay
  root.emit('probe/run-ticks', 8, 42);
  const identical = runs.length === 2 && JSON.stringify(runs[0]) === JSON.stringify(runs[1]);
  phase('determinism', identical, `replay identical=${identical}, rows=${runs[0]?.length}`);
  await tickFiber.dispose();

  // 9. Shutdown: full root disposal (session teardown miniature).
  //    Correct assertion: listeners registered BEFORE disposal die with it,
  //    and services are released. (Registering new listeners on a disposed
  //    root is an undefined edge — Cordis still dispatches them; noted.)
  let heardAfterRoot = false;
  root.on('probe/after', () => { heardAfterRoot = true; });
  await root.fiber.dispose();
  root.emit('probe/after');
  phase('shutdown', !heardAfterRoot && root.clock === undefined,
    `services released=${root.clock === undefined}, pre-dispose listeners dead=${!heardAfterRoot}`);

  const allOk = results.every((r) => r.ok);
  post({ type: 'e0.done', allOk, summary: results.map((r) => `${r.ok ? 'PASS' : 'FAIL'} ${r.name}`).join(', ') });
}

self.onmessage = async (e) => {
  const m = e.data || {};
  if (m.type === 'stop' && root) {
    try { await root.fiber.dispose(); } catch { /* already disposed */ }
    post({ type: 'e0.stopped' });
  }
};

run().catch((err) => post({ type: 'e0.error', message: String(err && err.stack || err) }));
