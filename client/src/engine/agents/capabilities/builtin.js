// engine/agents/capabilities/builtin.js — E6: the engine's domain-agnostic
// built-in capabilities.
//
// These are the capabilities EVERY package can rely on without declaring them,
// because they mean the same thing in any game: talk to another agent, ask the
// engine to render something, find who is near. They carry ZERO domain meaning
// — a package composes them (and its own domain capabilities) into archetypes.
//
// E6.0 shipped the world-minimal set (comms + effects + a naive neighbour
// scan). E6.2 adds the geospatial capabilities that need the world model +
// spatial hash (moveTo, worldCellAt, requestAssist) and upgrades nearbyAgents
// to bucket queries when the world is a WorldModel — same names, same
// signatures, same observation shape, so package archetypes never change.
//
// Every capability is pure JS (runs in the core worker, no browser APIs): an
// actuator either mutates the world through ctx or emits an engine-owned effect
// by NAME (ctx.emit) — it never touches the DOM/Maps/Cesium itself. The one rule
// holds structurally.

import { distanceM, offsetMeters, bearingDeg } from '../geo.js';
import { INPUT_CAPABILITIES } from './input.js';

/**
 * sensor: nearbyAgents — who is within radiusM of this agent?
 * params: { radiusM=500, kinds?/archetypes? (optional filter) }
 * E6.0 is a naive O(n) scan over ctx.world.agents; E6.2 swaps in the spatial
 * hash. Returns { nearby: [{id, archetype, distM, lon, lat}], count }.
 */
const nearbyAgents = {
  name: 'nearbyAgents',
  kind: 'sensor',
  invoke(agent, ctx, params = {}) {
    const radiusM = Number.isFinite(params.radiusM) ? params.radiusM : 500;
    const from = agent?.state?.pose;
    if (!from) return { nearby: [], count: 0 };
    const archetypes = Array.isArray(params.archetypes) && params.archetypes.length ? new Set(params.archetypes) : null;
    const world = ctx?.world;
    const nearby = [];
    if (world && typeof world.query === 'function') {
      // WorldModel: spatial-hash bucket query (scales to hundreds of agents).
      const hits = world.query(from.lon, from.lat, radiusM, (o) => o !== agent && (!archetypes || archetypes.has(o.archetype)));
      for (const { agent: o, distM } of hits) {
        const p = o.state.pose;
        nearby.push({ id: o.id, archetype: o.archetype, distM, lon: p.lon, lat: p.lat });
      }
    } else {
      // Naive fallback for a plain { agents: [] } world (headless unit tests).
      for (const other of world?.agents || []) {
        if (!other || other === agent || !other.alive) continue;
        if (archetypes && !archetypes.has(other.archetype)) continue;
        const p = other.state?.pose;
        if (!p) continue;
        const d = distanceM(from, p);
        if (d <= radiusM) nearby.push({ id: other.id, archetype: other.archetype, distM: d, lon: p.lon, lat: p.lat });
      }
      nearby.sort((a, b) => a.distM - b.distM);
    }
    return { nearby, count: nearby.length };
  },
};

/**
 * actuator: emitMessage — agent-to-agent (or agent-to-world) communication.
 * The engine carries the envelope; the meaning of `text`/`data` is the package's.
 * Emitted on ctx.emit as a 'message' event (the chronicle/UI may surface it).
 */
const emitMessage = {
  name: 'emitMessage',
  kind: 'actuator',
  schema: { to: 'string?', text: 'string?', data: 'object?' },
  invoke(agent, ctx, intent) {
    ctx.emit?.({ kind: 'message', from: agent.id, to: intent.to ?? null, text: intent.text ?? '', data: intent.data ?? null, t: ctx.t });
    return { ok: true };
  },
  tool: { description: 'Send a message to another agent (or broadcast).', parameters: { type: 'object', properties: { to: { type: 'string' }, text: { type: 'string' } }, required: [] } },
};

/**
 * actuator: spawnEffect — ask the engine to render a named, engine-owned effect
 * at a location (the same "effect by name" contract the render bindings use:
 * `engine:cellGridOverlay`). The package names the effect + supplies data; the
 * engine's L2 layer (E6.3) turns it into browser API calls. Never renders here.
 */
const spawnEffect = {
  name: 'spawnEffect',
  kind: 'actuator',
  schema: { effect: 'string!', lon: 'number?', lat: 'number?', params: 'object?' },
  invoke(agent, ctx, intent) {
    ctx.emit?.({ kind: 'effect', effect: intent.effect, by: agent.id, lon: intent.lon ?? null, lat: intent.lat ?? null, params: intent.params ?? null, t: ctx.t });
    return { ok: true };
  },
};

/**
 * actuator: moveTo — generic geospatial movement toward a lon/lat waypoint.
 * Speed is a package characteristic (state.speedMps) or an intent override;
 * movement is metrically correct along the compass bearing, clamped to the
 * world bounds, and never overshoots the target. Updates pose + heading and
 * re-buckets the agent in the spatial hash. Zero domain knowledge: it drives a
 * drone, a ground unit, or a civilian identically.
 */
const moveTo = {
  name: 'moveTo',
  kind: 'actuator',
  schema: { lon: 'number?', lat: 'number?', alt: 'number?', speedMps: 'number?' },
  clamp: (intent, ctx) => {
    const w = ctx?.world;
    if (!w || typeof w.clamp !== 'function') return intent;
    if (!Number.isFinite(intent.lon) || !Number.isFinite(intent.lat)) return intent;
    const c = w.clamp(intent.lon, intent.lat);
    return { ...intent, lon: c.lon, lat: c.lat };
  },
  invoke(agent, ctx, intent) {
    const pose = agent.state.pose || (agent.state.pose = { lon: 0, lat: 0, alt: 0, headingDeg: 0 });
    const target = { lon: Number.isFinite(intent.lon) ? intent.lon : pose.lon, lat: Number.isFinite(intent.lat) ? intent.lat : pose.lat };
    if (Number.isFinite(intent.alt)) pose.alt = intent.alt;
    const speed = Number.isFinite(intent.speedMps) ? intent.speedMps : (Number(agent.state.speedMps) || 0);
    const dt = Number(ctx?.dt) || 0;
    const dist = distanceM(pose, target);
    const heading = dist > 1e-9 ? bearingDeg(pose, target) : pose.headingDeg;
    const maxStep = speed > 0 ? speed * dt : Infinity;
    if (dist <= maxStep) {
      pose.lon = target.lon; pose.lat = target.lat;
      if (dist > 1e-9) pose.headingDeg = heading;
    } else {
      const rad = (heading * Math.PI) / 180;
      const next = offsetMeters(pose, Math.sin(rad) * maxStep, Math.cos(rad) * maxStep);
      pose.lon = next.lon; pose.lat = next.lat; pose.headingDeg = heading;
    }
    ctx?.world?.rebucket?.(agent);
    return { moved: Math.min(dist, maxStep), remaining: distanceM(pose, target), headingDeg: pose.headingDeg, atTarget: dist <= maxStep };
  },
  tool: { description: 'Move toward a lon/lat waypoint at the agent speed.', parameters: { type: 'object', properties: { lon: { type: 'number' }, lat: { type: 'number' }, alt: { type: 'number' } }, required: [] } },
};

/**
 * sensor: worldCellAt — read the environment layer's cell state at a position
 * (the agent's pose by default, or params.lon/lat). The cell value is OPAQUE
 * (the package interprets it); the engine only routes the read. Returns
 * { cell, layer }; a missing layer/cell degrades to { cell: null }.
 */
const worldCellAt = {
  name: 'worldCellAt',
  kind: 'sensor',
  invoke(agent, ctx, params = {}) {
    const layerName = typeof params.layer === 'string' ? params.layer : 'environment';
    const layer = ctx?.world?.getLayer?.(layerName);
    const at = (Number.isFinite(params.lon) && Number.isFinite(params.lat)) ? { lon: params.lon, lat: params.lat } : agent?.state?.pose;
    if (!layer || typeof layer.cellAt !== 'function' || !at) return { cell: null, layer: layerName };
    let cell = null;
    try { cell = layer.cellAt(at.lon, at.lat) ?? null; } catch { cell = null; }
    return { cell, layer: layerName };
  },
};

/**
 * actuator: requestAssist — broadcast a request for help to the world. The
 * engine carries the envelope (an 'assist' event); WHO answers and what the
 * request MEANS is package logic (other agents' sensors/SM tables, the UI).
 * A generic cooperation primitive.
 */
const requestAssist = {
  name: 'requestAssist',
  kind: 'actuator',
  schema: { request: 'string?', text: 'string?', data: 'object?' },
  invoke(agent, ctx, intent) {
    const p = agent.state?.pose;
    ctx.emit?.({ kind: 'assist', from: agent.id, request: intent.request ?? 'help', text: intent.text ?? '', data: intent.data ?? null, lon: p?.lon ?? null, lat: p?.lat ?? null, t: ctx.t });
    return { ok: true };
  },
  tool: { description: 'Broadcast a request for assistance to other agents.', parameters: { type: 'object', properties: { request: { type: 'string' }, text: { type: 'string' } }, required: [] } },
};

/** The engine's domain-agnostic built-in set (E6.2: comms + effects + geospatial). */
export const BUILTIN_CAPABILITIES = [nearbyAgents, emitMessage, spawnEffect, moveTo, worldCellAt, requestAssist];

/**
 * Every capability the engine registers by name at boot: the world built-ins
 * plus the generic input capabilities (E6.6). Registering makes them AVAILABLE;
 * an agent only owns the ones its package archetype lists, so nothing is forced.
 */
export const ENGINE_CAPABILITIES = [...BUILTIN_CAPABILITIES, ...INPUT_CAPABILITIES];

/** Register every engine capability onto a registry. Idempotent per registry. */
export function registerBuiltins(registry) {
  registry.registerAll(ENGINE_CAPABILITIES);
  return registry;
}
