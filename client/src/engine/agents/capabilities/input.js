// engine/agents/capabilities/input.js — E6.6: the engine's GENERIC input
// capabilities.
//
// Two capabilities that let ANY agent — iff its package archetype declares them
// — turn human/UI input into simulation intents. They are package-agnostic
// mechanisms: the engine carries the envelope (drawn geometry, a consult
// request); the MEANING of an orderType, who may issue it, and which agent owns
// the capability are all PACKAGE decisions. No character or domain is named
// here: a package might give these to a human-reasoning planner, a VLM advisor,
// or nothing at all.
//
// One rule: both are pure JS (they run in the core worker). They never touch
// the DOM/Maps/Cesium — drawing and screenshot capture happen in the UI (host);
// these capabilities only emit engine events the host relays. That keeps the
// browser work engine-side and the package content pure.

/** Coerce a drawn path into a clean [{lon,lat}] array (finite numbers only). */
function normalizeGeometry(geometry) {
  const pts = [];
  for (const p of Array.isArray(geometry) ? geometry : []) {
    if (!p || typeof p !== 'object') continue;
    const lon = Number(p.lon), lat = Number(p.lat);
    if (Number.isFinite(lon) && Number.isFinite(lat)) pts.push({ lon, lat });
  }
  return pts;
}

/**
 * actuator: drawOrder — apply a geometry the human drew in the UI (a line,
 * curve, route or boundary) as a typed order. The orderType is OPAQUE to the
 * engine; if the agent's package declared an allowed set (state.orderTypes) the
 * order is gated against it (degrade never break: an unknown type is noted and
 * rejected, never applied). Emits an 'order' event carrying the orderType +
 * normalized geometry so the host can render it (e.g. a polyline overlay) and
 * route it. Returns { ok, orderType, points }.
 */
const drawOrder = {
  name: 'drawOrder',
  kind: 'actuator',
  schema: { orderType: 'string!', geometry: 'array?', targetId: 'string?', params: 'object?' },
  invoke(agent, ctx, intent) {
    const orderType = typeof intent.orderType === 'string' ? intent.orderType.trim() : '';
    if (!orderType) {
      ctx.registry?.note?.(`agent '${agent.id}' drawOrder: missing orderType`);
      return { ok: false, reason: 'missing orderType' };
    }
    const allowed = Array.isArray(agent.state?.orderTypes) ? agent.state.orderTypes : null;
    if (allowed && allowed.length && !allowed.includes(orderType)) {
      ctx.registry?.note?.(`agent '${agent.id}' drawOrder: orderType '${orderType}' not in the package whitelist`);
      return { ok: false, reason: 'orderType not allowed' };
    }
    const geometry = normalizeGeometry(intent.geometry);
    ctx.emit?.({
      kind: 'order',
      orderType,
      geometry,
      by: agent.id,
      targetId: typeof intent.targetId === 'string' ? intent.targetId : null,
      params: intent.params ?? null,
      t: ctx.t,
    });
    return { ok: true, orderType, points: geometry.length };
  },
  tool: {
    description: 'Issue a typed order carrying drawn geometry (a line/curve/route/boundary).',
    parameters: {
      type: 'object',
      properties: {
        orderType: { type: 'string' },
        geometry: { type: 'array', items: { type: 'object', properties: { lon: { type: 'number' }, lat: { type: 'number' } } } },
        targetId: { type: 'string' },
      },
      required: ['orderType'],
    },
  },
};

/**
 * actuator: screenshotConsult — ask the host to capture the current viewport
 * and consult a vision-language model on this agent's behalf. The capability
 * ONLY emits a 'consult' request (one rule: no capture here); the host grabs the
 * screenshot and routes it to the slow clock (the agent worker's VLM route), and
 * the returned suggestion lands in this agent's remote proxy as its next intent.
 * Advisory and on-demand — never per-tick. Returns { ok }.
 */
const screenshotConsult = {
  name: 'screenshotConsult',
  kind: 'actuator',
  schema: { prompt: 'string?', to: 'string?', params: 'object?' },
  invoke(agent, ctx, intent) {
    ctx.emit?.({
      kind: 'consult',
      by: agent.id,
      to: typeof intent.to === 'string' ? intent.to : null,
      prompt: typeof intent.prompt === 'string' ? intent.prompt : '',
      params: intent.params ?? null,
      t: ctx.t,
    });
    return { ok: true };
  },
  tool: {
    description: 'Request a screenshot of the current view and consult a vision-language model for advice.',
    parameters: { type: 'object', properties: { prompt: { type: 'string' }, to: { type: 'string' } }, required: [] },
  },
};

/** The engine's generic input capabilities (available by name; owned only if an archetype declares them). */
export const INPUT_CAPABILITIES = [drawOrder, screenshotConsult];
