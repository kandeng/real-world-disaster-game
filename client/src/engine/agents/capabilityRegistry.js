// engine/agents/capabilityRegistry.js — E6: the capability registry.
//
// "Everything is an agent" => an agent is a container of NAMED capabilities
// (sensors + actuators) plus a reasoning plugin. The registry is the engine's
// generic, domain-agnostic index of capabilities BY NAME:
//   • the engine ships built-ins (capabilities/builtin.js): moveTo,
//     nearbyAgents, worldCellAt, emitMessage, spawnEffect, requestAssist;
//   • a PACKAGE registers its OWN domain capabilities the same way (pure JS,
//     imported at boot) — e.g. a wildfire package adds dropWater/sprayDryIce/
//     digFirebreak/hazardProximity. The engine never names a domain.
//
// Capability descriptor:
//   {
//     name,                       // unique id an archetype references
//     kind: 'sensor'|'actuator',
//     schema?:  { field: 'number!' | 'number?' | 'string!' | ... },  // intent shape
//     clamp?:   (intent, ctx) -> intent,        // spatial/numeric gate (pure)
//     gate?:    (agent, intent, ctx) -> {ok, reason?},  // cooldown/resource/legality
//     invoke:   (agent, ctx, arg) -> fragment|result,   // sensor read | actuator apply
//     tool?:    { description, parameters }     // JSON-schema view for LLM/VLM
//   }
//   sensor.invoke(agent, ctx, params)  -> observation fragment (pure read)
//   actuator.invoke(agent, ctx, intent) -> result (mutates world / emits)
//
// THE INTENT PIPELINE (a governing principle): every actuator call AND every
// commander order flows validate -> clamp -> gate -> apply, so a hallucinated
// or out-of-bounds intent can never reach the world. applyActuator() is that
// single funnel.
//
// Degrade never break: an unknown name resolves to null and is recorded as a
// note (a newer package on an older engine still runs). Dependency-free ESM.

export const CAPABILITY_KINDS = ['sensor', 'actuator'];

// Field-spec mini-language, matching protocol.js so authors learn one dialect:
// 'number!' required | 'number?' optional | kinds: number,string,bool,object,
// array,any | or a predicate function (truthy = ok).
const KIND_CHECK = {
  number: (v) => typeof v === 'number' && Number.isFinite(v),
  string: (v) => typeof v === 'string',
  bool: (v) => typeof v === 'boolean',
  object: (v) => v !== null && typeof v === 'object' && !Array.isArray(v),
  array: (v) => Array.isArray(v),
  any: () => true,
};

function checkField(spec, v) {
  if (typeof spec === 'function') return !!spec(v);
  const kind = spec.endsWith('!') || spec.endsWith('?') ? spec.slice(0, -1) : spec;
  return (KIND_CHECK[kind] || KIND_CHECK.any)(v);
}

function isRequired(spec) {
  return typeof spec === 'string' && spec.endsWith('!');
}

/** Validate an intent against a capability schema. -> {ok, reason?} */
export function validateIntent(schema, intent) {
  if (!schema) return { ok: true };
  if (!intent || typeof intent !== 'object') return { ok: false, reason: 'intent must be an object' };
  for (const [field, spec] of Object.entries(schema)) {
    const v = intent[field];
    if (v === undefined || v === null) {
      if (isRequired(spec)) return { ok: false, reason: `missing required field '${field}'` };
      continue;
    }
    if (!checkField(spec, v)) return { ok: false, reason: `field '${field}' failed ${typeof spec === 'function' ? 'predicate' : spec}` };
  }
  return { ok: true };
}

export function createCapabilityRegistry() {
  const caps = new Map();   // name -> descriptor
  const notes = [];         // degrade-never-break log

  function note(message) { notes.push(message); return null; }

  function register(desc) {
    if (!desc || typeof desc.name !== 'string' || !desc.name) return note('capability: missing name');
    if (!CAPABILITY_KINDS.includes(desc.kind)) return note(`capability '${desc.name}': unknown kind '${desc.kind}'`);
    if (typeof desc.invoke !== 'function') return note(`capability '${desc.name}': invoke must be a function`);
    caps.set(desc.name, {
      name: desc.name,
      kind: desc.kind,
      schema: desc.schema || null,
      clamp: typeof desc.clamp === 'function' ? desc.clamp : null,
      gate: typeof desc.gate === 'function' ? desc.gate : null,
      invoke: desc.invoke,
      tool: desc.tool || null,
    });
    return desc.name;
  }

  function registerAll(list) { for (const d of list || []) register(d); }

  function resolve(name) { return caps.get(name) || null; }
  function has(name) { return caps.has(name); }
  function kindOf(name) { return caps.get(name)?.kind || null; }

  function list(kind) {
    const out = [];
    for (const d of caps.values()) if (!kind || d.kind === kind) out.push(d.name);
    return out;
  }

  /** Run a sensor capability -> observation fragment ({} on any failure). */
  function readSensor(agent, ctx, name, params) {
    const cap = resolve(name);
    if (!cap || cap.kind !== 'sensor') { note(`sensor '${name}' unavailable (agent '${agent?.id}')`); return {}; }
    try {
      const frag = cap.invoke(agent, ctx, params || {});
      return frag && typeof frag === 'object' ? frag : {};
    } catch (err) {
      note(`sensor '${name}' threw: ${String((err && err.message) || err)}`);
      return {};
    }
  }

  /**
   * THE intent pipeline for one actuator call: validate -> clamp -> gate ->
   * apply. Returns {ok, result?, reason?}. `intent.type` names the actuator.
   */
  function applyActuator(agent, ctx, intent) {
    const type = intent && intent.type;
    const cap = typeof type === 'string' ? resolve(type) : null;
    if (!cap || cap.kind !== 'actuator') {
      note(`actuator '${type}' unavailable (agent '${agent?.id}')`);
      return { ok: false, reason: `unknown actuator '${type}'` };
    }
    const v = validateIntent(cap.schema, intent);
    if (!v.ok) return { ok: false, reason: `invalid: ${v.reason}` };
    let scoped = intent;
    try {
      if (cap.clamp) scoped = cap.clamp(intent, ctx) || intent;
    } catch (err) {
      return { ok: false, reason: `clamp threw: ${String((err && err.message) || err)}` };
    }
    if (cap.gate) {
      let g;
      try { g = cap.gate(agent, scoped, ctx); }
      catch (err) { return { ok: false, reason: `gate threw: ${String((err && err.message) || err)}` }; }
      if (g && g.ok === false) return { ok: false, reason: g.reason || 'gated' };
    }
    try {
      const result = cap.invoke(agent, ctx, scoped);
      return { ok: true, result };
    } catch (err) {
      note(`actuator '${type}' threw: ${String((err && err.message) || err)}`);
      return { ok: false, reason: `apply threw: ${String((err && err.message) || err)}` };
    }
  }

  /**
   * The thin JSON-schema "tool" view of a set of actuator names — what an
   * LLM/VLM reasoning plugin is offered (Capability vs Tool: the engine keeps
   * the pure-JS capability; the model only sees this schema). Unknown names are
   * skipped. Used by the slow-clock supervisor (E6.5).
   */
  function toolView(names) {
    const tools = [];
    for (const name of names || []) {
      const cap = resolve(name);
      if (!cap || cap.kind !== 'actuator') continue;
      tools.push({
        name: cap.name,
        description: cap.tool?.description || '',
        parameters: cap.tool?.parameters || schemaToParameters(cap.schema),
      });
    }
    return tools;
  }

  function schemaToParameters(schema) {
    const properties = {};
    const required = [];
    for (const [field, spec] of Object.entries(schema || {})) {
      const type = typeof spec === 'string' ? spec.replace(/[!?]$/, '') : 'any';
      properties[field] = { type: type === 'any' ? 'string' : type };
      if (isRequired(spec)) required.push(field);
    }
    return { type: 'object', properties, required };
  }

  function takeNotes() { return notes.splice(0, notes.length); }

  return {
    register, registerAll, resolve, has, kindOf, list,
    readSensor, applyActuator, toolView, note, takeNotes,
  };
}
