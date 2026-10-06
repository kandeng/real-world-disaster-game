// games/demo-wildfire/agents/archetypes/drone.js — the drone ARCHETYPE.
//
// An archetype is an agent TEMPLATE: which capabilities it owns (sensors +
// actuators), its starting state, and its reasoning. The engine mounts it
// generically; nothing here is engine code. A water drone and a dry-ice drone
// are the SAME archetype with a different suppression actuator — that single
// parameter is the flagship's proof that a package-declared capability (a new
// suppression mode) needs no engine change.

import { droneFsm } from '../reasoning/drone_fsm.js';

/**
 * makeDrone(options) -> an agent spec for the AgentRuntime.
 *   { id, lon, lat, alt?=200, speedMps?=18, suppression?='dropWater' }
 */
export function makeDrone({ id, lon, lat, alt = 200, speedMps = 18, suppression = 'dropWater' } = {}) {
  return {
    id,
    archetype: suppression === 'sprayDryIce' ? 'dryIceDrone' : 'waterDrone',
    state: {
      pose: { lon, lat, alt, headingDeg: 0 },
      speedMps,
      status: 'scan',          // mirrored by the SM for rendering
      suppression,             // which actuator this drone fires (provenance)
    },
    sensors: ['scanFire', { name: 'nearbyAgents', radiusM: 1000 }],
    actuators: ['moveTo', suppression, 'emitMessage'],
    reasoning: droneFsm(suppression),
  };
}

export default makeDrone;
