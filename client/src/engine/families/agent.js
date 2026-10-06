// engine/families/agent.js — E3: the agent family, the slow-clock protocol
// between the main-thread host and the per-session agent worker
// (workers/gameAgent.worker.js). NORMATIVE; keep in lockstep with
// ENVELOPE_VERSION in ../protocol.js.
//
// The two-clock model, as wire vocabulary:
//   core worker (fast, deterministic) --observation--> host
//     host --agent.observe--> agent worker (slow) --HTTP--> server decide
//       server --intent--> agent worker --agent.intent--> host
//         host --agents.order (the intent, verbatim)--> core worker --> next commit
//
// The agent worker NEVER talks to the core worker directly (workers can't);
// the host is a dumb relay. The model never mutates state — it returns an
// intent, which is an ordinary package capability command the core worker validates
// and applies at its next tick commit.
//
// Directions:
//   events   = agent worker -> host (out);
//   commands = host -> agent worker (in).
// Command wireTypes are namespaced ('agent.observe') — the v2 direction the
// protocol kernel already supports; they never collide with bare core
// command names in the shared host registry.

import { defineFamily } from '../protocol.js';

export const agentFamily = defineFamily({
  name: 'agent',
  version: 1,

  // agent worker -> host
  events: {
    'agent.intent': {
      // The decided action, verbatim as a package capability command envelope
      // ({ type, ...args }) — or null to hold this beat.
      intent: 'object?',
      policy: 'string?',     // 'llm' | 'vlm' | 'auto' — which server policy answered
      rationale: 'string?',  // short human-readable reason (logged, never trusted)
      agentId: 'string?',    // E6.5: which slow agent this intent is for ('' => the legacy solo stream)
    },
    'agent.status': {
      online: 'bool?',       // server reachable on the last beat
      mode: 'string?',       // server's active policy (llm | vlm | auto)
      model: 'string?',      // server model name (advisory)
      actions: 'array?',     // whitelisted intent types the server may emit
      agentId: 'string?',    // E6.5: which slow agent this status is for
    },
    'agent.error': {
      message: 'string!',
      agentId: 'string?',    // E6.5: which slow agent errored (optional)
    },
  },

  // host -> agent worker
  commands: {
    'agent.start': {
      serverUrl: 'string?',  // '' => origin-relative /api (Vite proxy / Caddy); or an absolute base for direct tests
      session: 'string?',    // opaque id for server-side logging / session keying
      asset: 'string?',      // which package asset this advisor is bound to ('' = unbound)
      policy: 'string?',     // per-call policy override (llm | vlm | auto)
      beatMs: 'number?',     // min ms between decide calls (slow-clock throttle)
      maxConcurrent: 'number?', // E6.5: cap on simultaneous in-flight slow agents
    },
    'agent.observe': {
      observation: 'object!',  // opaque per-agent observation payload (the engine never interprets it)
      agentId: 'string?',      // E6.5: which slow agent ('' => the legacy solo stream)
      archetype: 'string?',    // E6.5: package archetype — selects the server-side policy/whitelist
      actions: 'array?',       // E6.5: optional inline tool spec [{name, description, parameters}]
      image: 'string?',        // E6.5: optional data URL for the VLM route
    },
    'agent.configure': {
      policy: 'string?',
      maxConcurrent: 'number?',
    },
    'agent.stop': {},
  },
});
