// engine/protocol.js — E1: the normative message-envelope kernel.
//
// THE ONE RULE, formalized: everything that crosses a realm boundary (core
// worker <-> main thread) is a JSON envelope on this registry; same-thread
// calls keep the identical envelope shape. No RPC, no promises across realms,
// no shared memory.
//
// Envelope v1 (wire format — identical to the protocol already in production):
//   { type: '<wireType>', ...payload }          flat JSON, structured-cloneable
//   wireType taxonomy: '<domain>.<name>' for events ('agents.state') and, in
//   the v2 direction the families already follow, for commands too
//   ('agents.order'); a few bare '<name>' core commands remain v1 debt.
//
// Bus names (Cordis databus): events map '.' -> '/' ('agents.state' ->
// 'agents/state'); commands are prefixed 'cmd/' ('agents.order' ->
// 'cmd/agents.order').
//
// Validation policy (v1 = warn mode):
//   'ok'      — known type, required fields present and well-typed;
//   'unknown' — type not on the registry: IGNORE (a newer package on an older
//               engine degrades, never breaks);
//   'invalid' — known type, bad payload: console.error loudly, still deliver
//               (v1). E2 may promote this to drop-on-invalid.
//
// Zero dependencies on purpose: importable from the core worker, the main
// thread, and headless Node tests alike. Cordis is bridged via
// createBusBridge() but never imported here.

export const ENVELOPE_VERSION = 1;

// ---------- field-spec mini-language ----------
// 'number!' required number | 'number?' optional number | kinds: number,
// string, bool, object, array, any | or a predicate function (truthy = ok).

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
  const check = KIND_CHECK[kind] || KIND_CHECK.any;
  return check(v);
}

function isRequired(spec) {
  return typeof spec === 'string' && spec.endsWith('!');
}

// ---------- family registry ----------

const families = new Map();      // family name -> family
const wireIndex = new Map();     // wireType -> { family, direction, fields }

export function defineFamily(spec) {
  const family = { name: spec.name, version: spec.version ?? 1, events: {}, commands: {} };
  for (const [wireType, fields] of Object.entries(spec.events || {})) {
    family.events[wireType] = fields;
    wireIndex.set(wireType, { family: family.name, direction: 'out', fields });
  }
  for (const [wireType, fields] of Object.entries(spec.commands || {})) {
    family.commands[wireType] = fields;
    wireIndex.set(wireType, { family: family.name, direction: 'in', fields });
  }
  families.set(family.name, family);
  return family;
}

export function getFamily(name) { return families.get(name) || null; }
export function familyNames() { return [...families.keys()]; }

// ---------- bus-name mapping ----------

export function busName(wireType) {
  const entry = wireIndex.get(wireType);
  if (entry?.direction === 'in') return `cmd/${wireType}`;
  return wireType.includes('.') ? wireType.replaceAll('.', '/') : wireType;
}

export function wireType(busNm) {
  if (busNm.startsWith('cmd/')) return busNm.slice(4);
  for (const wt of wireIndex.keys()) if (busName(wt) === busNm) return wt;
  return busNm.replaceAll('/', '.');
}

// ---------- validation ----------

export function validate(msg) {
  if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') {
    return { status: 'invalid', reason: 'envelope must be an object with a string `type`' };
  }
  const entry = wireIndex.get(msg.type);
  if (!entry) return { status: 'unknown', reason: `type '${msg.type}' is not on the registry` };
  for (const [field, spec] of Object.entries(entry.fields)) {
    const v = msg[field];
    if (v === undefined || v === null) {
      if (isRequired(spec)) return { status: 'invalid', reason: `'${msg.type}' missing required field '${field}'` };
      continue;
    }
    if (!checkField(spec, v)) return { status: 'invalid', reason: `'${msg.type}' field '${field}' failed ${typeof spec === 'function' ? 'predicate' : spec}` };
  }
  return { status: 'ok', family: entry.family, direction: entry.direction };
}

// Warn-mode guard: validates, reports violations, always passes through (v1).
export function createGuardedPost(post, { label = 'engine', onViolation } = {}) {
  return function guardedPost(msg) {
    const v = validate(msg);
    if (v.status === 'invalid') {
      const text = `[${label}] protocol violation: ${v.reason}`;
      (onViolation || console.error)(text, msg);
    }
    return post(msg);
  };
}

// Warn-mode gate for inbound envelopes: returns the validation result so the
// dispatcher can ignore 'unknown' per the degrade-never-break policy.
export function gateInbound(msg, { label = 'engine', onViolation } = {}) {
  const v = validate(msg);
  if (v.status === 'invalid') {
    const text = `[${label}] inbound protocol violation: ${v.reason}`;
    (onViolation || console.error)(text, msg);
  }
  return v;
}

// ---------- Cordis databus bridge ----------
//
// Mounts a family onto a Cordis Context: outbound bus events are re-emitted
// as wire envelopes through `post`; inbound envelopes are validated and
// re-emitted on the bus. Listeners attach to `ctx`, so they die with the
// owning fiber (E0-proven lifecycle/GC semantics).

export function createBusBridge(ctx, family, post) {
  for (const wt of Object.keys(family.events)) {
    const bn = busName(wt);
    ctx.on(bn, (payload) => post({ type: wt, ...(payload || {}) }));
  }
  function attachInbound(msg) {
    const v = gateInbound(msg, { label: `bus:${family.name}` });
    if (v.status !== 'ok' || v.direction !== 'in') return v;
    ctx.emit(busName(msg.type), msg);
    return v;
  }
  return { attachInbound, family: family.name };
}
