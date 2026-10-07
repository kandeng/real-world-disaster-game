// ── The package-driven CAST STORE (shared, session-scoped) ────────────────────
// The single source of truth for "who is on the team + their avatar", replacing
// the old hardcoded TEAM (commander / staff / drone / tank). The client names NO
// domain: every displayName / avatarUrl / kind comes from the ACTIVE GAME
// PACKAGE's render bindings (createRenderBindings().cast), so a different game
// ships a different cast and nothing here changes.
//
// Fed by the host, from two places:
//   • AppShell boot-loads the active package's cast on mount (loadCast), so the
//     chatbot roster + 2D plan badges are package-driven even before/without the
//     agent worker (the default, non-?agentDemo app).
//   • useAgentScene (?agentDemo=1) feeds the LIVE spawned agents (id/archetype +
//     pose, from each agents.state snapshot) and re-feeds the base-resolved cast.
//
// Roster shape (one entry per teammate): { id, archetype, kind, name, avatar,
// lon?, lat?, alt?, headingDeg? }. `id` doubles as the chat handle. When live
// agents exist the roster is per-AGENT (e.g. two water drones → two entries);
// otherwise it falls back to one entry per declared archetype so the cast still
// shows before the sim boots. Degrade never break: no package → empty roster.
import { reactive, computed } from 'vue';

const DEFAULT_PACKAGE_BASE = '/games/demo-wildfire/';  // mirrors useAgentScene; overridden by ?pkg=

const state = reactive({
  cast: {},        // archetype -> { avatarUrl, displayName, kind }
  agents: [],      // live: [{ id, archetype, lon, lat, alt, headingDeg }]
  base: null,      // package base the current cast was resolved against
  loaded: false,
  loading: false,
});

// ── Relative-URL resolution (mirrors useAgentScene.resolveAssetUrl) ──────────
// A package declares avatarUrl RELATIVE to itself ('agents/drone/avatar.svg');
// resolve it against the package base so it fetches from /games/<pkg>/... The
// helper is duplicated (not imported) to keep this store free of any dependency
// on the host module — useAgentScene imports THIS file, so importing back would
// be circular.
function isRelativeUrl(u) {
  if (typeof u !== 'string' || u.length === 0) return false;
  if (u.startsWith('/')) return false;                  // root-absolute or protocol-relative (//)
  const i = u.indexOf(':');
  if (i > 0 && /^[a-z][a-z0-9+.-]*$/i.test(u.slice(0, i))) return false;  // has a scheme (http:, data:, blob:)
  return true;
}
function resolveAssetUrl(base, u) {
  if (!isRelativeUrl(u)) return u;
  return base + (u.startsWith('./') ? u.slice(2) : u);
}
function resolveCastUrls(base, cast) {
  const out = {};
  for (const [arch, c] of Object.entries(cast || {})) {
    if (c && typeof c === 'object') {
      const cc = { ...c };
      if (cc.avatarUrl) cc.avatarUrl = resolveAssetUrl(base, cc.avatarUrl);
      out[arch] = cc;
    } else out[arch] = c;
  }
  return out;
}

/** The package base to load the cast from: ?pkg= override, else the default. */
function packageBase() {
  try {
    const p = new URLSearchParams(window.location.search).get('pkg');
    if (p) return p.endsWith('/') ? p : p + '/';
  } catch { /* no window (SSR/test) */ }
  return DEFAULT_PACKAGE_BASE;
}

/**
 * Boot-load the active package's cast. Idempotent + safe to call repeatedly
 * (skips when already loading, or when that base is already loaded). Never
 * throws: a package with no render/bindings.js simply leaves the roster empty.
 */
async function loadCast(forceBase) {
  const base = forceBase || packageBase();
  if (state.loading) return;
  if (state.loaded && state.base === base) return;
  state.loading = true;
  try {
    const mod = await import(/* @vite-ignore */ base + 'render/bindings.js');
    const cast = (mod && typeof mod.createRenderBindings === 'function')
      ? (mod.createRenderBindings()?.cast || null)
      : null;
    if (cast) {
      state.cast = resolveCastUrls(base, cast);
      state.base = base;
      state.loaded = true;
    }
  } catch (err) {
    console.warn('[agentCast] package cast unavailable — roster stays empty', err?.message || err);
  } finally {
    state.loading = false;
  }
}

/** Host feed: an already base-resolved cast (useAgentScene resolves on load). */
function setCast(cast, base) {
  state.cast = (cast && typeof cast === 'object') ? cast : {};
  if (typeof base === 'string' && base) state.base = base;
  state.loaded = true;
}

/** Host feed: the live spawned agents from an agents.state snapshot. */
function setAgents(list) {
  state.agents = Array.isArray(list) ? list : [];
}

/** Drop the live agents (keep the boot-loaded cast for the non-agentDemo roster). */
function clearAgents() {
  state.agents = [];
}

function clear() {
  state.cast = {};
  state.agents = [];
  state.base = null;
  state.loaded = false;
}

// ── Derived roster ───────────────────────────────────────────────────────────
function entryFor(id, archetype) {
  const c = state.cast[archetype] || {};
  return {
    id,
    archetype,
    kind: c.kind || 'machine',
    name: c.displayName || archetype || id,
    avatar: c.avatarUrl || null,
  };
}

const roster = computed(() => {
  if (state.agents.length) {
    // Live sim: one entry per spawned agent (carrying its pose for 2D badges).
    return state.agents.map((a) => ({
      ...entryFor(a.id, a.archetype),
      lon: a.lon,
      lat: a.lat,
      alt: a.alt,
      headingDeg: a.headingDeg,
    }));
  }
  // No live agents yet: one entry per declared archetype (ids = archetype keys),
  // so the boot-loaded cast still populates the roster + badges.
  return Object.keys(state.cast).map((arch) => entryFor(arch, arch));
});

function entryById(id) {
  if (id == null) return null;
  return roster.value.find((e) => e.id === id) || null;
}
function avatarOf(id) {
  const e = entryById(id);
  return e ? e.avatar : null;
}
function displayNameOf(id) {
  const e = entryById(id);
  return e ? e.name : id;
}

// Role-derived handles (NO hardcoded literals): the human is the commander, the
// 'staff' kind is the default responder. The fallbacks are the archetype-key
// spellings, used only until the cast loads so routing never throws.
function handleOfKind(kind, fallback) {
  const e = roster.value.find((x) => x.kind === kind);
  return e ? e.id : fallback;
}
const commanderId = computed(() => handleOfKind('human', 'commander'));
const staffId = computed(() => handleOfKind('staff', 'staff'));

export function useAgentCast() {
  return {
    // reactive state + derived views
    state,
    roster,
    commanderId,
    staffId,
    // lookups
    entryById,
    avatarOf,
    displayNameOf,
    // host feeds
    loadCast,
    setCast,
    setAgents,
    clearAgents,
    clear,
  };
}
