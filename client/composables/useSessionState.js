/**
 * useSessionState.js – the single reactive object carrying everything the
 * system must preserve across button switches within a page AND across page
 * switches (3D Exploration / Route Planning / Gallery / Extensions / Account /
 * Content). Module-scoped singleton, same pattern as useDrone / useAuth.
 *
 * Domains are migrated in, one phase at a time (state moves, behavior stays in
 * the composables that own it):
 *   Phase 1  pose   – drone + gimbal            (wired via useDrone, done)
 *   Phase 2  route  – waypoints + route meta    (planned: RoutePlanningView)
 *   Phase 3  view   – page/sub-view/2D-3D/mapType/selection/search (planned)
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
    yaw: 0.0,
    pitch: settings.defaultPitch,
    roll: settings.defaultRoll,
  },

  // ── Phase 2: route (populated once RoutePlanningView migrates) ──────────
  route: {
    waypoints: [],        // maintained waypoint list [{id,index,lat,lng,alt,speed,camYaw,camPitch,camRoll}]
    selectedWpId: null,   // red (selected) waypoint circle
    sourceRouteId: null,  // saved route being edited (null = new)
    title: '',
    description: '',
    createdAt: '',
  },

  // ── Phase 3: view context (which page / sub-view / map the user is on) ──
  view: {
    page: 'aerial',       // 'aerial' | 'route' | 'gallery' | 'extensions' | 'account' | 'content'
    subView: 'steer',     // 'steer' | 'search' | 'waypoint' | 'route'
    mode: '3d',           // '3d' | 'street'
    mapTypeId: 'roadmap', // Google 2D map type
    // 2D map "height" (model altitude driving Google zoom). This is the
    // altitude SPLIT: drone.alt is the true 3D camera/gimbal altitude; the
    // 2D street-map zoom is a separate value. They are related only at the
    // 3D<->2D boundary via modelAltForMapScale / trueAltForMapScale so the
    // two views open at the same ground scale.
    mapAlt: settings.defaultAlt,
    selectionLatLng: null,// chosen search result (red balloon)
    searchQuery: '',
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
