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
      assets: 'array!',      // asset ids whose drivers mounted successfully
      skipped: 'array?',     // [{ id, reason }] — content-only assets / missing drivers (degrade, never break)
    },
    'game.over': {
      outcome: 'string!',    // driver-defined result; fire uses 'lost' | 'held'
      state: 'object?',      // final state snapshot, if the driver has one
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
