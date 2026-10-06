// games/demo-wildfire/agents/archetypes/commander.js — the COMMANDER archetype.
//
// A PACKAGE character, NOT an engine concept. The engine only ships the generic
// `human` reasoning plugin (an in-core proxy whose decide() returns the last
// order a player issued) and the generic input capabilities (drawOrder,
// screenshotConsult). This file is what makes a "commander" exist: it declares an
// agent that uses the human plugin, owns the drawing/screenshot capabilities, and
// whitelists the order types THIS game understands. Another game may have no
// commander at all — nothing in the engine requires one.
//
// The commander's decisions arrive off-tick (a player draws a line / types an
// order in the UI); the host relays them as `agents.order`, the runtime routes
// them into this agent's human proxy (onIntent), and the deterministic tick
// applies them at the next commit through the same intent pipeline as everything
// else. The tick never waits on a human.

/** The order types this package's commander may issue (drawOrder gates against
 *  state.orderTypes). Semantics are entirely package-declared. */
export const COMMANDER_ORDER_TYPES = ['route', 'boundary', 'engage', 'retreat', 'protect'];

/**
 * makeCommander(options) -> an agent spec.
 *   { id?='commander', lon, lat }
 */
export function makeCommander({ id = 'commander', lon, lat } = {}) {
  return {
    id,
    archetype: 'commander',
    state: {
      pose: { lon, lat, alt: 0, headingDeg: 0 },
      orderTypes: COMMANDER_ORDER_TYPES,
      status: 'command',
    },
    sensors: [],
    actuators: ['drawOrder', 'screenshotConsult', 'emitMessage'],
    reasoning: { kind: 'human' },
  };
}

export default makeCommander;
