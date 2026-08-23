/**
 * API client for the per-user saved flight routes (Content -> Route),
 * plus a one-shot handoff channel used by the Steer and Video buttons to
 * open the Route Planning page with exactly this route's waypoints listed
 * (Video additionally asks for the video dialog to open right after
 * landing, reusing Route Planning's own Video flow).
 */

import { useAuth } from './useAuth.js';

const API_BASE = import.meta.env.DEV ? 'http://localhost:8000' : '';

// One-shot handoff: Content -> Route stores { id, waypoints } here for
// Steer, and the same payload plus openVideo: true for Video (the id
// lets Route Planning tell "modified existing route" from "brand-new
// route" when its Video flow saves back to Content -> Route); Route
// Planning consumes (and clears) the payload on mount.
let handoff = null;

export function setRouteHandoff(payload) {
  handoff = payload;
}

export function takeRouteHandoff() {
  const h = handoff;
  handoff = null;
  return h;
}

// Module-level cache of the last successful GET /api/routes payload.
// Content -> Route unmounts/remounts on every tab switch and page
// change; with the cache the list paints instantly from memory while a
// background GET silently revalidates it (the spinner only shows while
// no cached copy exists yet).
let routesCache = null;

/** Last successfully fetched route list (null before the first load). */
export function cachedRoutes() {
  return routesCache;
}

export function useRoutes() {
  const { token } = useAuth();

  function authHeaders(json = false) {
    const h = { Authorization: `Bearer ${token.value}` };
    if (json) h['Content-Type'] = 'application/json';
    return h;
  }

  /** GET /api/routes — most recent first (server seeds demo routes). */
  async function listRoutes() {
    const res = await fetch(`${API_BASE}/api/routes`, {
      headers: authHeaders(),
    });
    if (!res.ok) throw new Error('routes_unavailable');
    routesCache = await res.json();
    return routesCache;
  }

  /** PUT /api/routes/{id} — replace the waypoint list (and the title too
   *  when provided; omitted title is kept server-side). */
  async function saveRoute(id, payload) {
    const res = await fetch(`${API_BASE}/api/routes/${id}`, {
      method: 'PUT',
      headers: authHeaders(true),
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error('route_save_failed');
    return res.json();
  }

  /** POST /api/routes — save a brand-new route (server mints the default
   *  "Route at: (lat, lon, alt)" title). */
  async function createRoute(payload) {
    const res = await fetch(`${API_BASE}/api/routes`, {
      method: 'POST',
      headers: authHeaders(true),
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error('route_save_failed');
    return res.json();
  }

  return { listRoutes, saveRoute, createRoute };
}
