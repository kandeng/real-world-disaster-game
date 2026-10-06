// engine/agents/reasoning/stateMachine.js — E6: the generic state-machine
// reasoning plugin (a FAST, deterministic brain).
//
// The engine owns the INTERPRETER; the package owns the CONTENT (states,
// transitions, guards, intents) as data. No domain knowledge lives here — this
// is a generic machine, as happy driving a civilian's evacuate logic as a
// drone's engage logic, because the meaning is entirely in the package's table.
//
// Content shape (package data; guards are PURE):
//   {
//     kind: 'stateMachine',
//     initial: 'idle',
//     states: {
//       idle:   { on: [ { when: <cond>, to: 'engage', intent: {...} } ], intent?: {...}|null },
//       engage: { on: [ ... ], intent?: {...}|null },
//     }
//   }
// <cond> is a data DSL — or a pure (agent, obs, ctx) => bool for a JS-authored
// package module:
//   { always: true }
//   { fact: 'hazard.distM', op: '<', value: 500 }   // op: < <= > >= == != truthy falsy in
//   { all: [c, ...] } | { any: [c, ...] } | { not: c }
// `fact` paths resolve against the observation, with 'state.*' -> agent.state
// and bare 't' / 'dt' -> ctx.t / ctx.dt (explicit time; NEVER Date.now()).
//
// decide(): evaluate the current state's transitions IN ORDER; the first whose
// guard passes fires -> move to `to` and return its intent. If none fire, hold
// and return the current state's `intent` (or null). Pure + synchronous.

import { resolveFact } from './facts.js';

function compare(v, op, value) {
  switch (op) {
    case '<': return v < value;
    case '<=': return v <= value;
    case '>': return v > value;
    case '>=': return v >= value;
    case '==': return v == value;      // loose on purpose: number/string coercion
    case '!=': return v != value;
    case 'truthy': return !!v;
    case 'falsy': return !v;
    case 'in': return Array.isArray(value) ? value.includes(v) : false;
    default: return false;
  }
}

/** Evaluate a guard condition (data DSL or pure function). Never throws. */
export function evalCondition(cond, agent, obs, ctx) {
  if (!cond) return false;
  if (typeof cond === 'function') {
    try { return !!cond(agent, obs, ctx); } catch { return false; }
  }
  if (cond.always) return true;
  if (Array.isArray(cond.all)) return cond.all.every((c) => evalCondition(c, agent, obs, ctx));
  if (Array.isArray(cond.any)) return cond.any.some((c) => evalCondition(c, agent, obs, ctx));
  if (cond.not) return !evalCondition(cond.not, agent, obs, ctx);
  if (typeof cond.fact === 'string') return compare(resolveFact(cond.fact, agent, obs, ctx), cond.op, cond.value);
  return false;
}

/**
 * Resolve an intent: static data ({type, ...}) is returned as-is; a pure
 * function (agent, obs, ctx) => intent is called so a JS-authored archetype can
 * aim dynamically (e.g. target the nearest neighbour from the observation).
 * Either way the result still flows the actuator pipeline (validate/clamp/gate).
 */
function resolveIntent(intent, agent, obs, ctx) {
  if (typeof intent === 'function') {
    try { return intent(agent, obs, ctx) || null; } catch { return null; }
  }
  return intent || null;
}

/**
 * createStateMachine(content) -> a per-agent reasoning plugin instance.
 * One instance per agent (it holds that agent's current state).
 */
export function createStateMachine(content = {}) {
  const states = content.states && typeof content.states === 'object' ? content.states : {};
  const names = Object.keys(states);
  let current = (typeof content.initial === 'string' && states[content.initial])
    ? content.initial
    : (names[0] || null);

  return {
    kind: 'stateMachine',
    fast: true,
    get current() { return current; },
    decide(agent, obs, ctx) {
      if (!current) return null;
      const st = states[current];
      if (!st) { current = null; return null; }
      for (const tr of st.on || []) {
        if (!tr || typeof tr.to !== 'string' || !states[tr.to]) continue;
        if (evalCondition(tr.when, agent, obs, ctx)) {
          current = tr.to;
          if (agent && agent.state) agent.state.status = current;   // mirror for rendering
          return resolveIntent(tr.intent, agent, obs, ctx);
        }
      }
      if (agent && agent.state) agent.state.status = current;
      return resolveIntent(st.intent, agent, obs, ctx);
    },
  };
}
