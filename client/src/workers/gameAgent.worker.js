// workers/gameAgent.worker.js — E3: the per-session agent worker (the SLOW
// clock). A dedicated module Worker, separate from the core worker, that owns
// every asynchronous remote-AI call so the deterministic tick never awaits a
// model. It is engine-side (not package code), so `fetch` — a Worker API, not
// a DOM API — is allowed here; the one rule still holds for packages.
//
// Two-clock data flow (this worker is the middle hop):
//   core worker --observation--> host --agent.observe--> HERE
//     HERE --HTTP POST /api/game/agent/decide--> server (LLM | VLM | auto)
//       server --intent--> HERE --agent.intent--> host --agents.order--> core worker
//
// Session lifecycle: on start this worker registers its `session` id with the
// server session registry (POST /session/open) so the server can key any
// per-session state to it; on stop it best-effort closes (POST /session/close,
// keepalive). Both are courtesies — the server idle GC is authoritative, so a
// closed tab that never sends close still gets reaped.
//
// Hard invariants:
//   * one in-flight request at a time; observations coalesce to the latest
//     (a slow/unreachable model drops beats, it never queues up or blocks);
//   * beat-throttled (beatMs) so the slow clock stays slow regardless of how
//     often the fast clock emits observations;
//   * never throws into the host — network/parse failures become agent.error
//     and the worker stays alive to retry on the next beat;
//   * decides nothing itself: it forwards the server's intent verbatim. The
//     core worker validates and applies it at its next commit.
//
// Wire protocol: NORMATIVE definitions in src/engine/families/agent.js.

import '../engine/families/agent.js';                 // registers the agent family on this realm's registry
import { createGuardedPost, gateInbound } from '../engine/protocol.js';

const post = createGuardedPost((m) => self.postMessage(m), { label: 'gameAgent' });

const cfg = {
  serverUrl: '',        // '' => origin-relative /api (Vite proxy / Caddy); absolute base for direct tests
  session: '',
  asset: '',
  policy: '',           // per-call override forwarded as `mode` ('' => server default)
  beatMs: 2500,         // min ms between decide calls
  maxConcurrent: 2,     // E6.5: cap on simultaneous in-flight slow agents (slow policies serialize server-side)
};

let started = false;
let stopped = false;
let concurrent = 0;                 // in-flight decide calls across ALL agents

// E6.5: this worker multiplexes N slow agents. Each has its own coalesced
// latest observation, beat throttle and single in-flight guard, keyed by
// agentId. A caller that sends no agentId rides the '_solo' key — one stream,
// session key unchanged — so a single-agent host needs no id bookkeeping.
const SOLO = '_solo';
const agents = new Map();           // agentId -> { agentId, archetype, latest, image, actions, inFlight, lastBeat, aborter }

function ensureAgent(agentId) {
  const id = (typeof agentId === 'string' && agentId) ? agentId : SOLO;
  let a = agents.get(id);
  if (!a) {
    a = { agentId: id, archetype: '', latest: null, image: null, actions: null, inFlight: false, lastBeat: 0, aborter: null };
    agents.set(id, a);
  }
  return a;
}

// Per-agent server session key: the solo stream keeps the bare session id; a
// named agent keys <session>::<id>.
function sessionKey(a) {
  return a.agentId === SOLO ? cfg.session : `${cfg.session}::${a.agentId}`;
}

function decideUrl() { return `${cfg.serverUrl}/api/game/agent/decide`; }
function configUrl() { return `${cfg.serverUrl}/api/game/agent/config`; }
function sessionUrl(action) { return `${cfg.serverUrl}/api/game/agent/session/${action}`; }

// Advertise the server's capability summary once on start (non-fatal).
async function probeConfig() {
  try {
    const res = await fetch(configUrl(), { method: 'GET' });
    if (!res.ok) { post({ type: 'agent.status', online: false }); return; }
    const j = await res.json();
    post({
      type: 'agent.status',
      online: true,
      mode: j.mode,
      model: j.model,
      actions: Array.isArray(j.actions) ? j.actions : undefined,
    });
  } catch (err) {
    post({ type: 'agent.status', online: false });
    post({ type: 'agent.error', message: `config probe failed: ${String((err && err.message) || err)}` });
  }
}

// Register this worker's session with the server-side session registry.
// Best-effort and idempotent — if it fails the decide beats still work (the
// engine lazily opens an anonymous session and the idle GC is authoritative).
// The returned server session id (which may differ if we sent none) is adopted
// so subsequent decide calls key the same persistent session.
async function openSession() {
  try {
    const res = await fetch(sessionUrl('open'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session: cfg.session, asset: cfg.asset }),
    });
    if (!res.ok) return;
    const j = await res.json();
    if (typeof j.session === 'string' && j.session) cfg.session = j.session;
  } catch { /* best-effort: never blocks the slow clock */ }
}

// E4: best-effort close on stop. `keepalive` lets the request outlive an
// imminent worker terminate(); if it is cut off, the server idle GC still
// reaps the session, so this is a courtesy, not a correctness dependency.
function closeSession() {
  try {
    fetch(sessionUrl('close'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session: cfg.session, asset: cfg.asset }),
      keepalive: true,
    }).catch(() => { /* best-effort */ });
  } catch { /* best-effort */ }
}

// Fire one decide call for a single agent's coalesced latest observation, if
// its beat allows AND the global concurrency budget has room. Bounded so a
// burst of slow agents never stampedes the rate-limited gateway.
function maybeBeat(a) {
  if (stopped || a.inFlight || !a.latest) return;
  if (concurrent >= cfg.maxConcurrent) return;      // global cap across agents
  const now = Date.now();
  if (now - a.lastBeat < cfg.beatMs) return;        // slow clock: skip, the next observation retries
  a.lastBeat = now;
  a.inFlight = true;
  concurrent++;
  const observation = a.latest;
  a.aborter = new AbortController();
  const body = { session: sessionKey(a), asset: cfg.asset, observation };
  if (a.agentId !== SOLO) body.agentId = a.agentId;
  if (a.archetype) body.archetype = a.archetype;
  if (a.actions) body.actions = a.actions;
  if (a.image) body.image = a.image;
  if (cfg.policy) body.mode = cfg.policy;

  fetch(decideUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: a.aborter.signal,
  })
    .then(async (res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      post({
        type: 'agent.intent',
        agentId: a.agentId === SOLO ? undefined : a.agentId,
        intent: j.intent ?? null,
        policy: j.policy,
        rationale: j.rationale,
      });
      post({ type: 'agent.status', online: true, agentId: a.agentId === SOLO ? undefined : a.agentId });
    })
    .catch((err) => {
      if (err && err.name === 'AbortError') return;    // stopped mid-flight; silent
      post({ type: 'agent.status', online: false, agentId: a.agentId === SOLO ? undefined : a.agentId });
      post({ type: 'agent.error', message: `decide failed: ${String((err && err.message) || err)}`, agentId: a.agentId === SOLO ? undefined : a.agentId });
    })
    .finally(() => {
      a.inFlight = false;
      a.aborter = null;
      concurrent--;
      pump();   // a freed slot may let another agent (or a fresher obs) beat now
    });
}

// Offer the beat to every agent (round-robin by insertion order) until the
// concurrency budget or the beat throttles stop progress.
function pump() {
  if (stopped) return;
  for (const a of agents.values()) {
    if (concurrent >= cfg.maxConcurrent) return;
    maybeBeat(a);
  }
}

function onStart(m) {
  if (started && !stopped) return;                     // idempotent
  cfg.serverUrl = typeof m.serverUrl === 'string' ? m.serverUrl.replace(/\/+$/, '') : '';
  cfg.session = typeof m.session === 'string' && m.session ? m.session : `s_${Date.now().toString(36)}`;
  cfg.asset = typeof m.asset === 'string' && m.asset ? m.asset : '';
  cfg.policy = typeof m.policy === 'string' ? m.policy : '';
  if (Number.isFinite(m.beatMs) && m.beatMs > 0) cfg.beatMs = m.beatMs;
  if (Number.isFinite(m.maxConcurrent) && m.maxConcurrent > 0) cfg.maxConcurrent = Math.floor(m.maxConcurrent);
  started = true;
  stopped = false;
  probeConfig();
  openSession();   // register the session (best-effort)
}

function onStop() {
  if (started && !stopped) closeSession();   // E4: best-effort; GC is authoritative
  stopped = true;
  for (const a of agents.values()) {
    a.latest = null;
    if (a.aborter) { try { a.aborter.abort(); } catch { /* already done */ } a.aborter = null; }
    a.inFlight = false;
  }
  concurrent = 0;
}

self.onmessage = (e) => {
  const m = e.data || {};
  const v = gateInbound(m, { label: 'gameAgent' });
  if (v.status === 'unknown') return;                  // degrade, never break
  switch (m.type) {
    case 'agent.start': onStart(m); break;
    case 'agent.observe': {
      if (!started || stopped) return;
      const a = ensureAgent(m.agentId);
      a.latest = m.observation || null;                 // coalesce to freshest
      if (typeof m.archetype === 'string') a.archetype = m.archetype;
      if (Array.isArray(m.actions)) a.actions = m.actions;
      a.image = typeof m.image === 'string' ? m.image : null;
      maybeBeat(a);
      break;
    }
    case 'agent.configure':
      if (typeof m.policy === 'string') cfg.policy = m.policy;
      if (Number.isFinite(m.maxConcurrent) && m.maxConcurrent > 0) cfg.maxConcurrent = Math.floor(m.maxConcurrent);
      break;
    case 'agent.stop': onStop(); break;
    default: break;
  }
};
