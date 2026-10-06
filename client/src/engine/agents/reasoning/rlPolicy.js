// engine/agents/reasoning/rlPolicy.js — E6.4: the generic RL-policy reasoning
// plugin (a FAST, deterministic brain).
//
// The engine owns the INFERENCE; the package owns the CONTENT (the feature
// extraction, the action set, and the weight matrix) as data. There is no
// training here and no GPU/TF nondeterminism — it is a pure-JS linear scorer,
// so a policy is as reproducible as a state machine (the plan's "RL
// determinism" requirement: weights as data, training out of scope).
//
// Content shape (package data):
//   {
//     kind: 'rlPolicy',
//     features: ['hazard.distM', 'state.fuel', ...] | (agent, obs, ctx) => number[],
//     actions:  [ <intentTemplate> | (agent, obs, ctx) => intent, ... ],
//     weights:  [ [bias, w0, w1, ...], ... ],   // actions.length × (features.length + 1)
//     temperature?: 0,    // 0 => greedy argmax (fully deterministic);
//                         // >0 => softmax sample drawn from ctx.rng (still seeded)
//   }
// `features` paths resolve exactly like state-machine guards (see facts.js):
// 't'/'dt' -> ctx, 'state.*' -> agent.state, else the observation. decide()
// scores every action, picks one, and returns its intent (which still flows the
// actuator pipeline). No domain knowledge lives here.

import { resolveFact } from './facts.js';

function buildFeatures(spec, agent, obs, ctx) {
  if (typeof spec.features === 'function') {
    try { const f = spec.features(agent, obs, ctx); return Array.isArray(f) ? f.map((v) => Number(v) || 0) : []; }
    catch { return []; }
  }
  if (Array.isArray(spec.features)) return spec.features.map((p) => Number(resolveFact(p, agent, obs, ctx)) || 0);
  return [];
}

function intentFor(action, agent, obs, ctx) {
  if (typeof action === 'function') { try { return action(agent, obs, ctx) || null; } catch { return null; } }
  return action || null;   // a static intent template
}

export function createRlPolicy(content = {}) {
  const actions = Array.isArray(content.actions) ? content.actions : [];
  const weights = Array.isArray(content.weights) ? content.weights : [];
  const temperature = Number.isFinite(content.temperature) ? content.temperature : 0;

  function scores(features) {
    return actions.map((_, a) => {
      const w = weights[a] || [];
      let s = Number(w[0]) || 0;                       // w[0] = bias
      for (let i = 0; i < features.length; i++) s += (Number(w[i + 1]) || 0) * (features[i] || 0);
      return s;
    });
  }

  function choose(s, ctx) {
    if (temperature > 0 && typeof ctx?.rng === 'function' && s.length > 1) {
      const max = Math.max(...s);
      const exps = s.map((v) => Math.exp((v - max) / temperature));
      const sum = exps.reduce((a, b) => a + b, 0) || 1;
      let r = ctx.rng() * sum, acc = 0;
      for (let i = 0; i < exps.length; i++) { acc += exps[i]; if (r <= acc) return i; }
      return exps.length - 1;
    }
    let best = 0;                                       // greedy argmax; ties -> lowest index
    for (let i = 1; i < s.length; i++) if (s[i] > s[best]) best = i;
    return best;
  }

  return {
    kind: 'rlPolicy',
    fast: true,
    decide(agent, obs, ctx) {
      if (!actions.length) return null;
      const s = scores(buildFeatures(content, agent, obs, ctx));
      return intentFor(actions[choose(s, ctx)], agent, obs, ctx);
    },
  };
}
