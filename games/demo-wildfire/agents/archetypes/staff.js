// games/demo-wildfire/agents/archetypes/staff.js — the STAFF archetype (optional).
//
// A PACKAGE character, NOT an engine concept — and an OPTIONAL one: a game need
// not have a staff at all. The engine only ships the generic `remote` reasoning
// plugin (a slow LLM/VLM proxy). This file declares an agent that uses it: an
// advisor that perceives the fire (scanFire) and, when the slow clock answers,
// proposes comms / assist requests. Its decide() is a PROXY — it returns the
// last intent the agent worker's VLM/LLM route delivered (or null), so the
// deterministic tick NEVER awaits a model. Advisory and on-demand, never per-tick.

/**
 * makeStaff(options) -> an agent spec.
 *   { id?='staff', lon, lat }
 */
export function makeStaff({ id = 'staff', lon, lat } = {}) {
  return {
    id,
    archetype: 'staff',
    state: {
      pose: { lon, lat, alt: 0, headingDeg: 0 },
      status: 'advise',
    },
    sensors: ['scanFire'],
    actuators: ['emitMessage', 'requestAssist'],
    reasoning: { kind: 'remote' },
  };
}

export default makeStaff;
