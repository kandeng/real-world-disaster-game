// engine/agents/reasoning/proxy.js — E6.4: the shared SLOW reasoning proxy.
//
// A slow agent (an LLM/VLM on the agent worker, or a human commander on the UI)
// cannot decide inside the deterministic tick — the tick must NEVER await a
// model or a player. So the engine runs an in-core PROXY: it holds the last
// intent the slow clock delivered and returns it on demand. The real reasoning
// happens off-tick and calls onIntent() to refresh the proxy (the supervisor
// routes agents.intent -> remote, agents.order -> human; see E6.5/E6.6).
//
// To keep the sim moving before the first answer lands — or if the slow clock
// stalls — a package may attach a FAST `fallback` (a state-machine spec) that
// drives the agent in the meantime. This is the plan's "thin in-core proxy
// holding the last intent + a fast fallback (the tick never stalls)".
//
// Generic and domain-free: `remote` and `human` are this same proxy under two
// kind labels (they may diverge later — e.g. a human order queue). The engine
// never names a character; "commander"/"staff" are package archetypes that
// happen to use `human`/`remote`.

import { createStateMachine } from './stateMachine.js';

export function createSlowProxy(kind, content = {}, helpers = {}) {
  let last = null;
  const once = !!content.once;                 // a one-shot intent clears after it fires
  const fallback = content.fallback && typeof content.fallback === 'object'
    ? createStateMachine(content.fallback)
    : null;

  return {
    kind,
    fast: false,
    get last() { return last; },
    get helpers() { return helpers; },

    // Deterministic + synchronous: return the last delivered intent, else the
    // fast fallback, else null (hold). Never awaits the slow clock.
    decide(agent, obs, ctx) {
      if (last != null) {
        const out = last;
        if (once) last = null;
        return out;
      }
      if (fallback) return fallback.decide(agent, obs, ctx);
      return null;
    },

    // The slow clock pushes a fresh intent here (off-tick). null clears it,
    // letting the fallback (or a hold) resume.
    onIntent(intent) { last = intent ?? null; },
    clear() { last = null; },
  };
}
