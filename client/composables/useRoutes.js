/**
 * API client for the per-user saved flight routes (Content -> Route),
 * plus the one-shot video signal used by the Content -> Route -> Video
 * jump (route data travels through session.route; only the "open the
 * video dialog right after landing" intent is one-shot).
 */

import { useAuth } from './useAuth.js';
import { apiBaseUrl } from './wsUrl.js';

// Prod calls are pinned to the apex origin (see wsUrl.js): the CDN edge
// never caches /api/*, so going through it would add a wasted hop.
const API_BASE = apiBaseUrl();

// One-shot "open the video dialog after landing" signal for the
// Content -> Route -> Video jump. The route DATA itself travels through
// session.route (seeded by the caller before navigating); only this
// transient intent is one-shot. setRouteVideoSignal() arms it,
// takeRouteVideoSignal() consumes it exactly once.
let routeVideoSignal = false;

export function setRouteVideoSignal(on) {
  routeVideoSignal = !!on;
}

export function takeRouteVideoSignal() {
  const s = routeVideoSignal;
  routeVideoSignal = false;
  return s;
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

  /** GET /api/routes/{id} — public single-route read (unlisted link);
   *  backs the /play?r=<id> deep link. No auth header needed. */
  async function getPublicRoute(id) {
    const res = await fetch(`${API_BASE}/api/routes/${id}`);
    if (!res.ok) throw new Error('route_unavailable');
    return res.json();
  }

  return { listRoutes, saveRoute, createRoute, getPublicRoute };
}
