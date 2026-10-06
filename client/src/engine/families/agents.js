// engine/families/agents.js — E6: the agents family, the GENERIC multi-agent
// protocol between the core worker (fast clock) and the host/L2. NORMATIVE;
// keep in lockstep with ENVELOPE_VERSION in ../protocol.js.
//
// This family is domain-agnostic by construction: it carries agent SNAPSHOTS
// (id, archetype, pose, lifecycle, opaque status) and the EVENTS agents produce
// (messages, named effects, degrade notes). It never names a domain — "drone",
// "fire", "commander" are package archetypes/statuses that ride through these
// envelopes as opaque data. Removing the tank or adding water/dry-ice drones
// touches ZERO line here.
//
// Directions:
//   events   = core worker -> host (out): the batched per-frame agent feed;
//   commands = host -> core worker (in): external intents into an agent.
//
// The two-clock model on the wire: a human/remote (slow) reasoning proxy owns a
// package archetype (e.g. demo-wildfire's commander). The host relays that
// player's/model's decision as `agents.order`; the core worker routes it into
// the agent's reasoning proxy (onIntent), and the deterministic tick applies it
// at the next commit through the same capability intent pipeline as everything
// else. A fast autonomous agent (stateMachine/rlPolicy) cannot be "ordered" —
// it is its table — so such an order degrades to a note, never a break.

import { defineFamily } from '../protocol.js';

export const agentsFamily = defineFamily({
  name: 'agents',
  version: 1,

  // core worker -> host
  events: {
    // The batched per-frame snapshot every L2 overlay renders from.
    'agents.state': {
      t: 'number!',       // sim seconds since session start
      agents: 'array!',   // [{ id, archetype, alive, pose:{lon,lat,alt,headingDeg}|null, status }]
    },
    // The batched per-frame event stream: agent comms, engine-owned effects
    // spawned by name, and degrade notes. L2/L3 dispatch by `kind`.
    'agents.event': {
      t: 'number!',
      events: 'array!',   // [{ kind:'message'|'effect'|'note', ... }]
    },
    // The environment's cell-grid frame: generic geometry + OPAQUE per-cell value
    // deltas ([[index, value], ...]). The engine NEVER interprets a value — the
    // package's render/bindings.js maps value -> colour, and the host accumulates
    // the deltas into the full grid the cellGridOverlay paints. This is the
    // domain-agnostic replacement for a bespoke '<domain>.delta' feed: any grid
    // environment (fire, flood, crowd, traffic) relays through it unchanged, so
    // removing the legacy fire family costs the host no special case.
    'agents.world': {
      t: 'number!',
      grid: 'object?',    // { cols, rows, lonMin, latMax, cellDegLon, cellDegLat } (geometry; may repeat)
      cells: 'array?',    // [[index, value], ...] opaque cell deltas since the last frame
    },
  },

  // host -> core worker
  commands: {
    // Inject an external intent into one agent's reasoning proxy. `intent` is
    // an ordinary capability-intent envelope ({ type:'<actuatorName>', ... })
    // or null to clear/hold. Routed via agents.order -> runtime.order.
    'agents.order': {
      agentId: 'string!',
      intent: 'object?',
    },
  },
});
