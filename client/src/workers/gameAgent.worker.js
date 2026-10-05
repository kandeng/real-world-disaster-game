// workers/gameAgent.worker.js — E3: the per-session agent worker (the SLOW
// clock). A dedicated module Worker, separate from the core worker, that owns
// every asynchronous remote-AI call so the deterministic tick never awaits a
// model. It is engine-side (not package code), so `fetch` — a Worker API, not
// a DOM API — is allowed here; the one rule still holds for packages.
//
// Two-clock data flow (this worker is the middle hop):
//   core worker --fire.observe--> host --agent.observe--> HERE
//     HERE --HTTP POST /api/game/agent/decide--> server (heuristic | LLM | DSH)
//       server --intent--> HERE --agent.intent--> host --dropWater--> core worker
//
// E4 session lifecycle: on start this worker registers its `session` id with
// the server counselor registry (POST /session/open) so the DSH policy can key
// a persistent, memory-bearing harness to it; on stop it best-effort closes
// (POST /session/close, keepalive). Both are courtesies — the server idle GC
// is authoritative, so a closed tab that never sends close still gets reaped.
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
  asset: 'fire',
  policy: '',           // per-call override forwarded as `mode` ('' => server default)
  beatMs: 2500,         // min ms between decide calls
};

let started = false;
let stopped = false;
let inFlight = false;
let lastBeat = 0;
let latest = null;      // most recent observation (coalesced)
let aborter = null;

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

// E4: register this worker's session with the server-side counselor registry.
// Best-effort and idempotent — if it fails the decide beats still work (the
// engine lazily opens an anonymous session and the idle GC is authoritative).
// The returned server session id (which may differ if we sent none) is adopted
// so subsequent decide calls key the same persistent counselor.
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

// Fire one decide call for the coalesced latest observation, if the beat allows.
function maybeBeat() {
  if (stopped || inFlight || !latest) return;
  const now = Date.now();
  if (now - lastBeat < cfg.beatMs) return;   // slow clock: skip, the next observation retries
  lastBeat = now;
  inFlight = true;
  const observation = latest;
  aborter = new AbortController();
  const body = { session: cfg.session, asset: cfg.asset, observation };
  if (cfg.policy) body.mode = cfg.policy;

  fetch(decideUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: aborter.signal,
  })
    .then(async (res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      post({
        type: 'agent.intent',
        intent: j.intent ?? null,
        policy: j.policy,
        rationale: j.rationale,
      });
      post({ type: 'agent.status', online: true });
    })
    .catch((err) => {
      if (err && err.name === 'AbortError') return;    // stopped mid-flight; silent
      post({ type: 'agent.status', online: false });
      post({ type: 'agent.error', message: `decide failed: ${String((err && err.message) || err)}` });
    })
    .finally(() => {
      inFlight = false;
      aborter = null;
      maybeBeat();   // a fresher observation may have landed while we were away
    });
}

function onStart(m) {
  if (started && !stopped) return;                     // idempotent
  cfg.serverUrl = typeof m.serverUrl === 'string' ? m.serverUrl.replace(/\/+$/, '') : '';
  cfg.session = typeof m.session === 'string' && m.session ? m.session : `s_${Date.now().toString(36)}`;
  cfg.asset = typeof m.asset === 'string' && m.asset ? m.asset : 'fire';
  cfg.policy = typeof m.policy === 'string' ? m.policy : '';
  if (Number.isFinite(m.beatMs) && m.beatMs > 0) cfg.beatMs = m.beatMs;
  started = true;
  stopped = false;
  probeConfig();
  openSession();   // E4: register the counselor session (best-effort)
}

function onStop() {
  if (started && !stopped) closeSession();   // E4: best-effort; GC is authoritative
  stopped = true;
  latest = null;
  if (aborter) { try { aborter.abort(); } catch { /* already done */ } aborter = null; }
  inFlight = false;
}

self.onmessage = (e) => {
  const m = e.data || {};
  const v = gateInbound(m, { label: 'gameAgent' });
  if (v.status === 'unknown') return;                  // degrade, never break
  switch (m.type) {
    case 'agent.start': onStart(m); break;
    case 'agent.observe':
      if (!started || stopped) return;
      latest = m.observation || null;                   // coalesce to freshest
      maybeBeat();
      break;
    case 'agent.configure':
      if (typeof m.policy === 'string') cfg.policy = m.policy;
      break;
    case 'agent.stop': onStop(); break;
    default: break;
  }
};
