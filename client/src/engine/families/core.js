// engine/families/core.js — E2: the core family. Engine-level lifecycle and
// clock control, spoken by the generic core worker (workers/gameCore.worker.js)
// and any host/agent-worker bridge. Normative; keep in lockstep with
// ENVELOPE_VERSION in ../protocol.js.

import { defineFamily } from '../protocol.js';

export const coreFamily = defineFamily({
  name: 'core',
  version: 1,

  // core worker -> host
  events: {
    'core.ready': {
      package: 'string!',    // packageBase the worker booted from
      agents: 'bool?',       // E6.8: true when the package declared an agents manifest (package.json) so the generic loader ran
    },
    'game.over': {
      outcome: 'string!',    // package-defined result (e.g. an environment's win/lose latch)
      state: 'object?',      // final state snapshot, if the package has one
    },
    'error': {
      message: 'string!',
    },
  },

  // host -> core worker
  commands: {
    boot: { packageBase: 'string!', speed: 'number?' },   // start the session
    halt: {},                                             // dispose the session
    setSpeed: { speed: 'number!' },                       // fast-clock speed (sim s / real s)
  },
});
