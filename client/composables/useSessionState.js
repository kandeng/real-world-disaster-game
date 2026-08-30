/**
 * useSessionState.js – the single reactive object carrying everything the
 * system must preserve across button switches within a page AND across page
 * switches (3D Exploration / Route Planning / Gallery / Extensions / Account /
 * Content). Module-scoped singleton, same pattern as useDrone / useAuth.
 *
 * Domains are migrated in, one phase at a time (state moves, behavior stays in
 * the composables that own it):
 *   Phase 1  pose   – drone + gimbal            (wired via useDrone, done)
 *   Phase 2  route  – waypoints + route meta    (wired via RoutePlanningView, done)
 *   Phase 3  view   – page / per-page sub-view context (wired via the two map views + router, done)
 *   +        user   – identity mirror of useAuth (optional)
 *
 * IMPORTANT — never deep-watch or persist this object wholesale. The 60 fps
 * sim loop mutates `drone` every frame; a `watch(session, …, { deep: true })`
 * or `JSON.stringify(session)` would therefore run every frame and jank the
 * app. Persist only an allow-listed subset, debounced, via persistSubset().
 */
import { reactive } from 'vue';
import { useAppSettings } from './useAppSettings.js';

const { settings } = useAppSettings();

export const session = reactive({
  // ── Phase 1: pose (owned here; exposed through useDrone) ────────────────
  drone: {
    lat: settings.defaultLat,
    lon: settings.defaultLon,
    alt: settings.defaultAlt,
    heading: settings.defaultYaw,
    // Scalar speed along the flying trajectory (m/s); written by the sim
    // loop each frame, displayed in the HUD.
    speed: 0,
  },
  gimbal: {
    yaw: settings.defaultCamYaw,
    pitch: settings.defaultPitch,
    roll: settings.defaultRoll,
  },

  // ── Phase 2: route (owned here; edited via RoutePlanningView) ───────────
  route: {
    waypoints: [],        // maintained waypoint list [{id,index,lat,lng,alt,speed,camYaw,camPitch,camRoll}]
    selectedWpId: null,   // red (selected) waypoint circle
    sourceRouteId: null,  // saved route being edited (null = new)
    title: '',
    description: '',
    createdAt: '',
  },

  // ── Phase 3: view context (which page / sub-view the user is on) ────────
  // Per-page slots: each map page remembers ITS OWN last sub-view, so
  // returning to a page restores exactly what was left there. The 2D/3D
  // mode is derived from subView ('steer' is the only 3D state).
  view: {
    page: 'aerial',       // active page ('aerial' | 'route'; set by the router)
    // 2D map "height" (model altitude driving Google zoom), SHARED by both
    // pages. This is the altitude SPLIT: drone.alt is the true 3D
    // camera/gimbal altitude; the 2D street-map zoom is a separate value.
    // They are related only at the 3D<->2D boundary via
    // modelAltForMapScale / trueAltForMapScale so the two views open at
    // the same ground scale.
    mapAlt: settings.defaultAlt,
    // 3D Exploration: 'steer' (3D free flight) | 'search' (2D + panel) |
    // 'route' (2D overview). selectionLatLng = picked address (red balloon).
    aerial: { subView: 'steer', searchQuery: '', selectionLatLng: null },
    // Route Planning: 'map' (neutral 2D) | 'search' | 'waypoint' (picking
    // armed) | 'route' (route panel) | 'steer' (3D nadir overview).
    // selectionLatLng = picked address (red balloon), same as aerial.
    route: { subView: 'map', searchQuery: '', selectionLatLng: null },
    // Build Scene: which background the page shows ('2d' map | '3d' globe).
    // The placed mesh itself lives in the useMeshPlacement singleton.
    buildscene: { mode: '2d' },
  },

  // ── Identity mirror (set by useAuth on login/logout; optional phase) ────
  user: { id: null },
});

export function useSessionState() {
  return { session };
}

// ── Selective, debounced persistence (sessionStorage) ──────────────────────
// Only the allow-listed top-level domains are serialized — never the whole
// store, and never on every mutation. Keep PERSIST_KEYS empty until a real
// restore-across-refresh need appears; then add e.g. 'view' or 'route'.
const STORAGE_KEY = 'drone.session.subset';
const PERSIST_KEYS = [];
let persistTimer = null;

export function persistSubset() {
  if (!PERSIST_KEYS.length) return;
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    const out = {};
    for (const k of PERSIST_KEYS) out[k] = session[k];
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(out));
    } catch {
      /* storage full / unavailable — non-fatal */
    }
  }, 300);
}

export function restoreSubset() {
  if (!PERSIST_KEYS.length) return;
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    for (const k of PERSIST_KEYS) {
      if (saved[k] != null) Object.assign(session[k], saved[k]);
    }
  } catch {
    /* corrupted storage — ignore */
  }
}
