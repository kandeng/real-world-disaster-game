// engine/families/fire.js — E1: the fire family, the first typed event family
// on the engine registry. This file is the NORMATIVE definition of the fire
// protocol; the prose in games/demo-wild-fire/dev/README.md and the header
// comments of engine/drivers/fire.js / effects/fireEffect.js describe it, this
// defines it. Keep FIRE_EFFECT_PROTOCOL (effects/fireEffect.js) in lockstep
// with `version` below.
//
// Directions:
//   events   = core worker -> host (out): effect deltas + lifecycle;
//   commands = host -> core worker (in): player capability + dev tools.
//
// E2: session lifecycle (boot/halt) and clock control (setSpeed) moved to the
// core family (./core.js); 'error' and 'game.over' are core-family events.
// This family keeps only fire-domain vocabulary.

import { defineFamily } from '../protocol.js';

export const fireFamily = defineFamily({
  name: 'fire',
  version: 1,

  // worker -> host
  events: {
    'fire.setGrid': {
      grid: 'object!',   // { cols, rows, lonMin, latMax, cellDegLon, cellDegLat } — deep shape owned by fireEffect
    },
    'fire.delta': {
      burning: 'array?', ash: 'array?', wet: 'array?', unburned: 'array?',  // cell indices
    },
    'fire.state': {
      state: 'object!',  // fire_sim getState() snapshot: simT, phase, burning, ash, occupyFrac, pending, lost, wind...
    },
    // E3: the slow-clock observation, emitted alongside fire.state on the same
    // beat. Fire-domain data the AI advisor needs but the renderer does not:
    // { phase, lost, time, occupyFrac, pending, counts, wind, hotspot, bounds }.
    // The host relays it to the agent worker as agent.observe; the core worker
    // never calls the model itself.
    'fire.observe': {
      observation: 'object!',
    },
    'fire.clear': {},
  },

  // host -> worker
  commands: {
    dropWater: { lon: 'number!', lat: 'number!', radiusM: 'number?' },  // player capability
    ignite: { lon: 'number!', lat: 'number!', radiusM: 'number?' },     // dev/debug only
    state: {},                                                          // request a fire.state snapshot
  },
});
