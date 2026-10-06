// engine/agents/reasoning/remote.js — E6.4: the `remote` reasoning plugin.
//
// The slow-clock proxy for an off-core model (an LLM advisor or a VLM "staff"
// officer). It is the shared slow proxy under the 'remote' label: the agent
// worker multiplexes the actual HTTP decide calls (E6.5) and pushes each answer
// back through onIntent(); the deterministic tick just replays the last one (or
// the package's fast fallback). The engine never names a domain or a character —
// a package's "staff" archetype is simply an agent whose reasoning is `remote`.

import { createSlowProxy } from './proxy.js';

export function createRemote(content, helpers) {
  return createSlowProxy('remote', content, helpers);
}
