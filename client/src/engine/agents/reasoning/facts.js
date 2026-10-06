// engine/agents/reasoning/facts.js — shared fact resolution for reasoning.
//
// A "fact" is a dotted path resolved against the per-tick inputs, with two
// reserved roots so reasoning stays PURE and deterministic:
//   't' / 'dt'   -> ctx.t / ctx.dt    (explicit time; NEVER Date.now() in a guard)
//   'state.<p>'  -> agent.state.<p>   (the agent's own memory)
//   '<p>'        -> observation.<p>   (what the sensors reported this beat)
// Shared by the state machine (guards) and the RL policy (feature vector) so
// both read the world identically. Dependency-free ESM.

export function getPath(obj, path) {
  if (obj == null || typeof path !== 'string') return undefined;
  let cur = obj;
  for (const seg of path.split('.')) {
    if (cur == null) return undefined;
    cur = cur[seg];
  }
  return cur;
}

export function resolveFact(fact, agent, obs, ctx) {
  if (fact === 't') return ctx?.t;
  if (fact === 'dt') return ctx?.dt;
  if (typeof fact === 'string' && fact.startsWith('state.')) return getPath(agent?.state, fact.slice(6));
  return getPath(obs, fact);
}
