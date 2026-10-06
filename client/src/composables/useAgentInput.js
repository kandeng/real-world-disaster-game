// composables/useAgentInput.js — E6.6 host relay for the generic input
// capabilities (engine/agents/capabilities/input.js).
//
// This is the BROWSER half of drawOrder / screenshotConsult, and it is
// deliberately package-agnostic: it names no character and no domain. The host
// (a game's view layer) binds three functions and gets two methods that any
// agent may use — iff that agent's package archetype declared the matching
// capability:
//
//   sendOrder(msg)   -> post an `agents.order` command to the CORE worker
//   sendConsult(msg) -> post an `agent.observe` (with an image) to the SLOW agent worker
//   capture()        -> resolve a PNG data URL of the current viewport (the UI's own
//                       screenshot/freeze-pen surface, e.g. useSteerFreezePen)
//
// Flow:
//   draw:  UI pen -> geometry -> drawOrder(agentId, orderType, geometry)
//          -> sendOrder -> core worker -> the drawOrder capability gates the
//          orderType against the package whitelist and emits an 'order' event.
//   consult: screenshotConsult(agentId, prompt) -> capture() -> sendConsult
//          -> agent worker VLM route -> the answer lands in that agent's remote
//          proxy as its next intent (advisory, on-demand, never per-tick).

/**
 * @param {{ sendOrder?: Function, sendConsult?: Function, capture?: Function }} bind
 * @returns {{ drawOrder: Function, screenshotConsult: Function }}
 */
export function createAgentInput(bind = {}) {
  const sendOrder = typeof bind.sendOrder === 'function' ? bind.sendOrder : () => {};
  const sendConsult = typeof bind.sendConsult === 'function' ? bind.sendConsult : () => {};
  const capture = typeof bind.capture === 'function' ? bind.capture : async () => null;

  /**
   * Translate a drawn geometry into an agents.order for a target agent.
   * @param {string} agentId   the agent that OWNS the drawOrder capability
   * @param {string} orderType package-declared order semantics (opaque to the engine)
   * @param {Array<{lon:number,lat:number}>} geometry
   * @param {{ targetId?: string, params?: object }} [opts]
   */
  function drawOrder(agentId, orderType, geometry, opts = {}) {
    const intent = {
      type: 'drawOrder',
      orderType,
      geometry: Array.isArray(geometry) ? geometry : [],
    };
    if (opts.targetId != null) intent.targetId = opts.targetId;
    if (opts.params != null) intent.params = opts.params;
    sendOrder({ type: 'agents.order', agentId, intent });
    return intent;
  }

  /**
   * Capture the viewport and route it to a VLM-reasoning agent for advice.
   * @param {string} agentId  the agent that OWNS the screenshotConsult capability
   * @param {string} [prompt] optional question for the model
   * @param {{ archetype?: string, observation?: object }} [opts]
   * @returns {Promise<{ sent: boolean, image: string|null }>}
   */
  async function screenshotConsult(agentId, prompt = '', opts = {}) {
    const image = await capture();
    if (!image) return { sent: false, image: null };
    sendConsult({
      type: 'agent.observe',
      agentId,
      archetype: opts.archetype || '',
      image,
      observation: { prompt, ...(opts.observation || {}) },
    });
    return { sent: true, image };
  }

  return { drawOrder, screenshotConsult };
}

export function useAgentInput(bind) {
  return createAgentInput(bind);
}
