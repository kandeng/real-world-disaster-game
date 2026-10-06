// engine/agents/reasoning/interface.js — E6: the reasoning plugin contract +
// factory.
//
// A reasoning plugin is the "brain" of an agent. The engine ships FOUR generic
// kinds; a package picks one per archetype and supplies its CONTENT (SM tables,
// RL weights, model config) — it never writes reasoning code, and the engine
// never names a domain or a character. "commander" and "staff" are just package
// archetypes that happen to use the `human` and `remote` plugins; another game
// may have neither.
//
//   stateMachine  fast, deterministic — interprets a package SM table
//   rlPolicy      fast, deterministic — pure-JS inference over package weights
//   remote        slow — LLM/VLM proxy (server decides off-tick)
//   human         slow — commander proxy (a player decides off-tick)
//
// Plugin instance contract:
//   {
//     kind: string,
//     fast: boolean,                          // true => decides synchronously in the tick
//     decide(agent, observation, ctx) -> intent | null,
//     onIntent?(intent) -> void,              // slow plugins: the supervisor pushes a fresh intent
//   }
// Fast plugins are PURE (time via ctx.t/ctx.dt, randomness via ctx.rng). Slow
// plugins are in-core PROXIES: decide() returns the last intent the slow clock
// delivered (or null) so the deterministic tick NEVER awaits a model; the real
// reasoning runs off-tick (agent worker -> server, or a player via L3) and calls
// onIntent() to update the proxy.
//
// Degrade never break: an unknown kind resolves to null and the agent stays
// alive but senseless (it simply holds). Dependency-free ESM.

import { createStateMachine } from './stateMachine.js';
import { createRlPolicy } from './rlPolicy.js';
import { createRemote } from './remote.js';
import { createHuman } from './human.js';

export const REASONING_KINDS = ['stateMachine', 'rlPolicy', 'remote', 'human'];

// The engine's generic reasoning plugins, keyed by kind. Each is a factory
// (content, helpers) -> plugin instance. Two are FAST (decide synchronously in
// the deterministic tick); two are SLOW in-core proxies whose real reasoning
// runs off-tick (agent worker -> server, or a player via L3) and is pushed back
// through onIntent() — so the tick never awaits a model or a person.
const PLUGINS = {
  stateMachine: createStateMachine,
  rlPolicy: createRlPolicy,
  remote: createRemote,
  human: createHuman,
};

/** Register (or override) a reasoning plugin factory by kind. */
export function registerReasoning(kind, factory) {
  if (typeof kind === 'string' && typeof factory === 'function') PLUGINS[kind] = factory;
}

/** True for the kinds that decide synchronously inside the fast tick. */
export function isFastKind(kind) { return kind === 'stateMachine' || kind === 'rlPolicy'; }

/**
 * createReasoning(spec, helpers) -> plugin instance | null.
 *   spec    = { kind, ...content } from the archetype manifest.
 *   helpers = { registry, actuators, world, agentId, session, ... } a plugin may
 *             need (e.g. `remote` builds its tool view from
 *             registry.toolView(actuators)).
 * Unknown kind / bad factory -> null (degrade never break).
 */
export function createReasoning(spec, helpers = {}) {
  const kind = spec && typeof spec.kind === 'string' ? spec.kind : null;
  const factory = kind ? PLUGINS[kind] : null;
  if (typeof factory !== 'function') return null;
  try {
    const instance = factory(spec, helpers);
    if (!instance || typeof instance.decide !== 'function') return null;
    if (typeof instance.kind !== 'string') instance.kind = kind;
    if (typeof instance.fast !== 'boolean') instance.fast = isFastKind(kind);
    return instance;
  } catch {
    return null;
  }
}
