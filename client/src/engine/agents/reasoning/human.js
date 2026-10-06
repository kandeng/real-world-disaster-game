// engine/agents/reasoning/human.js — E6.4: the `human` reasoning plugin.
//
// The slow-clock proxy for a live player. It is the shared slow proxy under the
// 'human' label: a player's decision arrives off-tick (drawn order, chat, a
// clicked waypoint — see E6.6) as an `agents.order`, the runtime routes it to
// onIntent(), and the deterministic tick replays it (or the package's fast
// fallback) so the sim never blocks on a person. The engine never names a
// character — a package's "commander" archetype is simply an agent whose
// reasoning is `human`; another game may have no such agent at all.

import { createSlowProxy } from './proxy.js';

export function createHuman(content, helpers) {
  return createSlowProxy('human', content, helpers);
}
