// engine/agents/agent.js — E6: the Agent container.
//
// The atom of "everything is an agent": a modular entity composed of DSH-style
// plugins — sensors + actuators (NAMED capabilities resolved from the registry)
// + state (memory) + a reasoning plugin. The Agent is pure data + pure methods:
// it runs in the core worker (no browser APIs) and in headless Node alike, and
// the engine never names a domain — WHICH capabilities and WHICH reasoning an
// agent has is declared by its package archetype.
//
// Per-tick contract (the AgentRuntime drives it — see agents/runtime.js, E6.1):
//   const observation = agent.sense(ctx);        // gather from sensor capabilities
//   const intent      = agent.reason(observation, ctx);  // delegate to reasoning
//   const outcome     = agent.act(intent, ctx);  // apply via the intent pipeline
// All three are PURE: time arrives via ctx.t / ctx.dt (never Date.now() inside
// a guard), randomness via ctx.rng (seeded). ctx = { t, dt, rng, world,
// registry, emit }.
//
// Fast vs slow: a fast reasoning plugin (stateMachine, rlPolicy) decides
// synchronously here. A slow plugin (remote LLM/VLM, human) is an in-core
// PROXY whose decide() returns the last intent the slow clock delivered (or
// null) — so the deterministic tick NEVER awaits a model.

/** Normalize a capability list: 'name' | {name, ...params}  ->  [{name, params}]. */
export function normalizeCapList(list) {
  const out = [];
  for (const entry of list || []) {
    if (typeof entry === 'string' && entry) out.push({ name: entry, params: {} });
    else if (entry && typeof entry.name === 'string') {
      const { name, ...params } = entry;
      out.push({ name, params });
    }
  }
  return out;
}

export class Agent {
  /**
   * spec: {
   *   id,                 // unique within a session
   *   archetype?,         // package archetype id (provenance; engine treats it opaquely)
   *   state?,             // memory: { pose?:{lon,lat,alt?,headingDeg?}, status?, ... }
   *   sensors?,           // ['name'] | [{name, ...params}]
   *   actuators?,         // ['name'] | [{name, ...params}]
   *   reasoning?,         // a reasoning plugin INSTANCE (see reasoning/interface.js)
   * }
   */
  constructor(spec = {}) {
    this.id = spec.id;
    this.archetype = spec.archetype || null;
    this.state = spec.state && typeof spec.state === 'object' ? spec.state : {};
    this.sensors = normalizeCapList(spec.sensors);
    this.actuators = normalizeCapList(spec.actuators);
    this.reasoning = spec.reasoning || null;
    this.alive = true;
  }

  /** Convenience: the agent's pose ({lon,lat,alt?,headingDeg?}) or null. */
  get pose() { return this.state.pose || null; }

  /**
   * Gather this agent's observation by running its sensor capabilities.
   * Unknown/failed sensors are skipped with a note (degrade never break); the
   * observation is the merge of every fragment, so a missing sensor just leaves
   * its facts absent — reasoning must tolerate that.
   */
  sense(ctx) {
    const obs = {};
    for (const { name, params } of this.sensors) {
      const frag = ctx.registry.readSensor(this, ctx, name, params);
      if (frag) Object.assign(obs, frag);
    }
    return obs;
  }

  /**
   * Ask the reasoning plugin for the next intent. Returns an intent object
   * ({type:'<actuatorName>', ...}) or null (hold this beat). Pure + sync; a
   * slow plugin returns its last delivered intent so the tick never stalls.
   */
  reason(observation, ctx) {
    const r = this.reasoning;
    if (!r || typeof r.decide !== 'function') return null;
    try {
      return r.decide(this, observation, ctx) || null;
    } catch (err) {
      ctx.registry.note(`agent '${this.id}' reasoning threw: ${String((err && err.message) || err)}`);
      return null;
    }
  }

  /**
   * Apply an intent through the actuator pipeline (validate -> clamp -> gate ->
   * apply). A null intent is a no-op hold. Returns {ok, result?, reason?}.
   */
  act(intent, ctx) {
    if (!intent || typeof intent.type !== 'string') return { ok: true, result: null };
    return ctx.registry.applyActuator(this, ctx, intent);
  }

  /** One sense -> reason -> act beat. The runtime calls this per agent per tick. */
  step(ctx) {
    if (!this.alive) return null;
    const observation = this.sense(ctx);
    const intent = this.reason(observation, ctx);
    const outcome = this.act(intent, ctx);
    return { observation, intent, outcome };
  }

  /**
   * The batched render/telemetry snapshot (agents.state, E6.1). Engine-generic:
   * pose + lifecycle + whatever PUBLIC status the package put on state.status.
   * Hidden state (objectives, memory) never leaves unless the package exposes it.
   */
  toSnapshot() {
    const p = this.state.pose || null;
    return {
      id: this.id,
      archetype: this.archetype,
      alive: this.alive,
      pose: p ? { lon: p.lon, lat: p.lat, alt: p.alt ?? 0, headingDeg: p.headingDeg ?? 0 } : null,
      status: this.state.status ?? null,
    };
  }
}

export function createAgent(spec) { return new Agent(spec); }
