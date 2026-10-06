// engine/agents/runtime.js — E6.1: the AgentRuntime (pure core).
//
// The single owner of a session's agent roster and the deterministic per-tick
// loop. It is PURE, dependency-free ESM (no Cordis, no browser): the Cordis
// Service wrapper (agents/service.js) connects it to the fast clock + databus,
// and headless Node tests drive it directly. This split mirrors the package's
// own environment sim (pure ESM) vs the engine's Cordis service glue.
//
// Responsibilities:
//   • own the capability registry (engine built-ins + package-declared caps);
//   • own the roster of Agents and the generic WorldModel (E6.2: spatial hash +
//     bounds + the package environment layer);
//   • run the tick: per step every agent senses -> reasons -> acts against a
//     shared ctx { t, dt, rng, world, registry, emit };
//   • batch the result for L2: agents.state (snapshots) + agents.event (comms /
//     effects / notes), flushed once per frame;
//   • route external orders (agents.order) into an agent's reasoning proxy.
//
// Determinism: the rng is seeded once (options.seed) and drawn ONLY inside
// steps (a fixed count), never on wall-clock frames — so a session is a pure
// function of (seed, roster, step count). There is NO replay system: a session
// is reproduced by reseeding (the E6 simplification).
//
// Degrade never break: an empty roster is inert AND silent (flush emits no
// agents.state), so mounting the runtime in a package that doesn't use agents
// (the legacy fire demo) changes nothing on the wire.

import { createCapabilityRegistry } from './capabilityRegistry.js';
import { registerBuiltins } from './capabilities/builtin.js';
import { createAgent } from './agent.js';
import { createReasoning } from './reasoning/interface.js';
import { mulberry32 } from './rng.js';
import { createWorldModel } from './world/worldModel.js';
import { attachEnvironment, tickEnvironment } from './world/environment.js';

export function createAgentRuntime(options = {}) {
  const registry = options.registry || createCapabilityRegistry();
  registerBuiltins(registry);

  const world = createWorldModel({ bounds: options.bounds, cellSizeM: options.cellSizeM });

  const stepS = Number.isFinite(options.stepS) && options.stepS > 0 ? options.stepS : 0.5;
  const seed = Number.isFinite(options.seed) ? options.seed : 1;
  const rng = mulberry32(seed);
  const emit = typeof options.emit === 'function' ? options.emit : () => {};

  const pending = [];      // capability events collected during steps, flushed per frame
  let simT = 0;
  let steps = 0;

  /** Register package-declared domain capabilities onto the shared registry. */
  function registerCapabilities(list) { registry.registerAll(list); }

  /**
   * Add an agent from a spec. `spec.reasoning` may be a plugin INSTANCE (has
   * .decide) or a reasoning SPEC ({ kind, ...content }) built here via the
   * generic factory. Degrade: an unknown reasoning kind -> null -> the agent is
   * still added and simply holds (alive but senseless).
   */
  function addAgent(spec) {
    if (!spec || typeof spec.id !== 'string' || !spec.id) {
      registry.note('runtime: agent spec needs a non-empty string id');
      return null;
    }
    const existing = world.get(spec.id);
    if (existing) {
      registry.note(`runtime: duplicate agent id '${spec.id}' ignored`);
      return existing;
    }
    let reasoning = spec.reasoning;
    if (reasoning && typeof reasoning === 'object' && typeof reasoning.decide !== 'function') {
      reasoning = createReasoning(reasoning, { registry, world, agentId: spec.id, actuators: spec.actuators });
    }
    const agent = createAgent({ ...spec, reasoning });
    world.add(agent);
    return agent;
  }

  function addAgents(list) {
    const out = [];
    for (const s of list || []) { const a = addAgent(s); if (a) out.push(a); }
    return out;
  }

  function getAgent(id) { return world.get(id); }

  /**
   * Route an external intent (a human commander's order, a VLM suggestion) into
   * an agent. Generic: it delegates to the reasoning plugin's onIntent() — which
   * slow proxies (human/remote, E6.4) implement to refresh their last intent. A
   * fast autonomous agent (stateMachine/rlPolicy) has no onIntent, so the order
   * is a NOTED no-op: you cannot "order" a state machine, you redefine its table.
   * Returns true if the intent was accepted by a proxy.
   */
  function order(agentId, intent) {
    const agent = world.get(agentId);
    if (!agent) { registry.note(`runtime: order for unknown agent '${agentId}'`); return false; }
    if (intent && typeof intent === 'object' && typeof intent.type === 'string' && !registry.has(intent.type)) {
      // Warn but still deliver: the proxy decides what to do, and the actuator
      // pipeline (validate/clamp/gate) is the real authority when it is applied.
      registry.note(`runtime: order intent '${intent.type}' is not a registered capability (agent '${agentId}')`);
    }
    if (agent.reasoning && typeof agent.reasoning.onIntent === 'function') {
      agent.reasoning.onIntent(intent);
      return true;
    }
    registry.note(`runtime: agent '${agentId}' reasoning cannot accept an order (kind '${agent.reasoning?.kind || 'none'}')`);
    return false;
  }

  /** One deterministic sim step: every living agent senses -> reasons -> acts. */
  function step(dt) {
    const useDt = Number.isFinite(dt) && dt > 0 ? dt : stepS;
    tickEnvironment(world, useDt);   // environment advances first; agents then observe a stable beat
    const ctx = { t: simT, dt: useDt, rng, world, registry, emit: (e) => pending.push(e) };
    for (const agent of world.agents) {
      if (!agent.alive) continue;
      agent.step(ctx);
    }
    simT += useDt;
    steps++;
  }

  /** The batched snapshot for L2 rendering / telemetry. */
  function snapshot() {
    return { t: simT, agents: world.agents.map((a) => a.toSnapshot()) };
  }

  /**
   * Flush the frame's batched output. SILENT when the roster is empty and
   * nothing happened, so an agent-less package sees no new traffic. Emits
   * agents.state (whenever there are agents) + agents.event (comms / effects /
   * notes, whenever any accumulated since the last flush).
   */
  function flush() {
    for (const text of registry.takeNotes()) pending.push({ kind: 'note', text, t: simT });
    if (world.agents.length) emit('agents.state', snapshot());
    // E6.9: relay the environment's cell grid (generic geometry + OPAQUE value
    // deltas) so the host's cellGridOverlay can paint it — the domain-agnostic
    // replacement for a bespoke '<domain>.delta' feed. The runtime interprets
    // nothing: it forwards whatever the package environment's cellFrame() returns
    // (null => nothing changed => stay silent). An environment with no cellFrame
    // (a non-grid world) simply emits no agents.world.
    const env = world.getLayer?.('environment');
    if (env && typeof env.cellFrame === 'function') {
      const frame = env.cellFrame();
      if (frame) emit('agents.world', { t: simT, grid: frame.grid || null, cells: frame.cells || [] });
    }
    if (pending.length) emit('agents.event', { t: simT, events: pending.splice(0, pending.length) });
  }

  /** Attach a package environment: applies bounds, registers its domain
   *  capabilities, stores it as the 'environment' layer, and (via step) ticks it. */
  function attachEnv(env) { return attachEnvironment(world, registry, env); }

  return {
    registry, world,
    get simT() { return simT; },
    get steps() { return steps; },
    get agents() { return world.agents; },
    registerCapabilities, addAgent, addAgents, getAgent, order, attachEnvironment: attachEnv,
    step, flush, snapshot,
  };
}
