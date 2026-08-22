/**
 * API client for the per-user saved flight routes (Content -> Route),
 * plus a one-shot handoff channel used by the Steer button to open the
 * Route Planning page with exactly this route's waypoints listed.
 */

import { useAuth } from './useAuth.js';

const API_BASE = import.meta.env.DEV ? 'http://localhost:8000' : '';

// One-shot handoff: Content -> Steer stores a deep copy of the route's
// waypoints here; Route Planning consumes (and clears) them on mount.
let handoffWaypoints = null;

export function setRouteHandoff(waypoints) {
  handoffWaypoints = waypoints;
}

export function takeRouteHandoff() {
  const w = handoffWaypoints;
  handoffWaypoints = null;
  return w;
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

  /** PUT /api/routes/{id} — replace title + waypoint list. */
  async function saveRoute(id, payload) {
    const res = await fetch(`${API_BASE}/api/routes/${id}`, {
      method: 'PUT',
      headers: authHeaders(true),
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error('route_save_failed');
    return res.json();
  }

  return { listRoutes, saveRoute };
}
