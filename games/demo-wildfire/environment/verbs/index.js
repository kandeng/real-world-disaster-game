// games/demo-wildfire/environment/verbs/index.js — the package capability (verb) registry.
//
// Every domain sensor/actuator this package declares, as pure-JS descriptors the
// engine registers BY NAME. An agent owns one only if its archetype lists it, so
// registering makes a capability AVAILABLE, never forced. Adding a capability
// (a new suppression mode, a sensor) is a package-only edit — the engine's
// AgentRuntime picks it up generically at boot: the environment adapter returns
// these as `capabilities`, and attachEnvironment registers them (registerAll).

import { dropWater } from './dropWater.js';
import { sprayDryIce } from './sprayDryIce.js';
import { scanFire } from './scanFire.js';

/** The package's domain capabilities (sensors + actuators). */
export const PACKAGE_CAPABILITIES = [dropWater, sprayDryIce, scanFire];

export { dropWater, sprayDryIce, scanFire };
export default PACKAGE_CAPABILITIES;
