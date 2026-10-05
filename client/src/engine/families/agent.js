// engine/families/agent.js — E3: the agent family, the slow-clock protocol
// between the main-thread host and the per-session agent worker
// (workers/gameAgent.worker.js). NORMATIVE; keep in lockstep with
// ENVELOPE_VERSION in ../protocol.js.
//
// The two-clock model, as wire vocabulary:
//   core worker (fast, deterministic) --fire.observe--> host
//     host --agent.observe--> agent worker (slow) --HTTP--> server decide
//       server --intent--> agent worker --agent.intent--> host
//         host --dropWater (the intent, verbatim)--> core worker --> next commit
//
// The agent worker NEVER talks to the core worker directly (workers can't);
// the host is a dumb relay. The model never mutates state — it returns an
// intent, which is an ordinary fire-family command the core worker validates
// and applies at its next tick commit.
//
// Directions:
//   events   = agent worker -> host (out);
//   commands = host -> agent worker (in).
// Command wireTypes are namespaced ('agent.observe') — the v2 direction the
// protocol kernel already supports; they never collide with bare fire/core
// command names in the shared host registry.

import { defineFamily } from '../protocol.js';

export const agentFamily = defineFamily({
  name: 'agent',
  version: 1,

  // agent worker -> host
  events: {
    'agent.intent': {
      // The decided action, verbatim as a fire-family command envelope
      // ({type:'dropWater', lon, lat, radiusM}) — or null to hold this beat.
      intent: 'object?',
      policy: 'string?',     // 'heuristic' | 'llm' — which server policy answered
      rationale: 'string?',  // short human-readable reason (logged, never trusted)
    },
    'agent.status': {
      online: 'bool?',       // server reachable on the last beat
      mode: 'string?',       // server's active policy (heuristic | llm | auto)
      model: 'string?',      // server model name (advisory)
      actions: 'array?',     // whitelisted intent types the server may emit
    },
    'agent.error': {
      message: 'string!',
    },
  },

  // host -> agent worker
  commands: {
    'agent.start': {
      serverUrl: 'string?',  // '' => origin-relative /api (Vite proxy / Caddy); or an absolute base for direct tests
      session: 'string?',    // opaque id for server-side logging / DSH keying
      asset: 'string?',      // which asset's advisor this is ('fire')
      policy: 'string?',     // per-call policy override (heuristic | llm | auto)
      beatMs: 'number?',     // min ms between decide calls (slow-clock throttle)
    },
    'agent.observe': {
      observation: 'object!',  // fire.observe payload: { phase, lost, hotspot, wind, counts, occupyFrac, pending, time, bounds }
    },
    'agent.configure': {
      policy: 'string?',
    },
    'agent.stop': {},
  },
});
