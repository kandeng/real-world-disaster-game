// engine/agents/loadPackage.js — E6.8: the GENERIC package agent loader.
//
// This is engine MECHANISM, not domain content. Given an AgentRuntime and a
// package's agent manifest (module paths + a base to resolve them against), it
// dynamically imports the package's environment / capabilities / roster modules
// and wires them into the runtime. It knows ONLY the contract — the export names
// `createEnvironment`, `PACKAGE_CAPABILITIES`, `createRoster` — and NEVER a
// domain: there is no fire, drone, water, or commander anywhere in this file.
//
// That is what makes the separation litmus hold at runtime: adding a dry-ice
// drone or removing a tank edits only the package's modules; this loader (and
// the rest of the engine) is unchanged and mounts whatever the package declares.
//
// Degrade never break: a missing/failing module is recorded as a note and
// skipped, so a package authored for a newer engine still boots.

/**
 * loadAgentPackage(runtime, manifest, importFn?) -> { env, agents, notes }
 *
 * manifest (all paths relative to manifest.base; every entry optional):
 *   {
 *     base: '/games/<pkg>/',
 *     environment?: 'environment/environment.js',
 *     environmentFactory?: 'createEnvironment',   // default
 *     environmentOptions?: {...},
 *     capabilities?: 'capabilities/index.js',      // env may already carry them
 *     capabilitiesExport?: 'PACKAGE_CAPABILITIES', // default
 *     roster?: 'agents/roster.js',
 *     rosterFactory?: 'createRoster',              // default
 *     rosterOptions?: {...},
 *   }
 * importFn(url) -> Promise<module>; defaults to a Vite-ignoring dynamic import.
 */
export async function loadAgentPackage(runtime, manifest = {}, importFn) {
  const notes = [];
  if (!runtime || typeof runtime.addAgents !== 'function') {
    return { env: null, agents: 0, notes: ['loadPackage: no agent runtime'] };
  }
  const imp = typeof importFn === 'function'
    ? importFn
    : (url) => import(/* @vite-ignore */ url);
  const base = typeof manifest.base === 'string' ? manifest.base : '';
  const url = (p) => (typeof p === 'string' && p ? base + p : null);

  // Resolve a factory from a module: an explicit export name, a conventional
  // name, or the default export — whichever is a function.
  const factory = (mod, explicit, conventional) => {
    if (!mod) return null;
    if (explicit && typeof mod[explicit] === 'function') return mod[explicit];
    if (typeof mod[conventional] === 'function') return mod[conventional];
    if (typeof mod.default === 'function') return mod.default;
    return null;
  };

  // 1. Environment — attachEnvironment applies its bounds AND registers the
  //    domain capabilities it carries, so this one call wires the world + most
  //    package capabilities.
  let env = null;
  const envUrl = url(manifest.environment);
  if (envUrl) {
    try {
      const mod = await imp(envUrl);
      const make = factory(mod, manifest.environmentFactory, 'createEnvironment');
      env = typeof make === 'function' ? make(manifest.environmentOptions || {}) : null;
      if (env) runtime.attachEnvironment(env);
      else notes.push(`loadPackage: '${manifest.environment}' exported no environment factory`);
    } catch (err) {
      env = null;
      notes.push(`loadPackage: environment failed: ${String((err && err.message) || err)}`);
    }
  }

  // 2. Standalone capabilities — optional; a package may register caps here
  //    instead of (or in addition to) carrying them on the environment.
  const capUrl = url(manifest.capabilities);
  if (capUrl) {
    try {
      const mod = await imp(capUrl);
      const list = (manifest.capabilitiesExport && mod[manifest.capabilitiesExport])
        || mod.PACKAGE_CAPABILITIES || mod.default;
      if (Array.isArray(list)) runtime.registerCapabilities(list);
      else notes.push(`loadPackage: '${manifest.capabilities}' exported no capability list`);
    } catch (err) {
      notes.push(`loadPackage: capabilities failed: ${String((err && err.message) || err)}`);
    }
  }

  // 3. Roster — instantiated against the attached environment (its bounds frame
  //    the spawn), then added to the runtime.
  let agents = 0;
  const rosterUrl = url(manifest.roster);
  if (rosterUrl) {
    try {
      const mod = await imp(rosterUrl);
      const make = factory(mod, manifest.rosterFactory, 'createRoster');
      let specs = null;
      if (typeof make === 'function') specs = make(env, manifest.rosterOptions || {});
      else if (Array.isArray(make)) specs = make;
      if (Array.isArray(specs)) agents = runtime.addAgents(specs).length;
      else notes.push(`loadPackage: '${manifest.roster}' produced no roster array`);
    } catch (err) {
      notes.push(`loadPackage: roster failed: ${String((err && err.message) || err)}`);
    }
  }

  for (const n of notes) runtime.registry?.note?.(n);
  return { env, agents, notes };
}

export default loadAgentPackage;
