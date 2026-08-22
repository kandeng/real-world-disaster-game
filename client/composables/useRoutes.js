/**
 * API client for the per-user saved flight routes (Content -> Route),
 * plus a one-shot handoff channel used by the Steer button to open the
 * Route Planning page with exactly this route's waypoints listed.
 */

import { useAuth } from './useAuth.js';

const API_BASE = import.meta.env.DEV ? 'http://localhost:8000' : '';

// One-shot handoff: Content -> Steer stores { id, waypoints } here (the id
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
    return res.json();
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
