// games/demo-wildfire/agents/archetypes/index.js — the archetype REGISTRY.
//
// name -> a factory (options) -> an agent spec. The roster instantiates the cast
// from this table. Adding a character (or a variant, like a dry-ice drone) is a
// one-line edit here; the engine's AgentRuntime mounts whatever the roster hands
// it, generically. This is the "everything can be an agent" surface of the
// package: commander, staff, and drones are all just archetypes.

import { makeDrone } from './drone.js';
import { makeCommander, COMMANDER_ORDER_TYPES } from './commander.js';
import { makeStaff } from './staff.js';

export const ARCHETYPES = {
  waterDrone: (o = {}) => makeDrone({ ...o, suppression: 'dropWater' }),
  dryIceDrone: (o = {}) => makeDrone({ ...o, suppression: 'sprayDryIce' }),
  commander: (o = {}) => makeCommander(o),
  staff: (o = {}) => makeStaff(o),
};

export { makeDrone, makeCommander, makeStaff, COMMANDER_ORDER_TYPES };
export default ARCHETYPES;
