/**
 * wsUrl.js — build same-origin URLs pinned to the apex origin.
 *
 * Alibaba's base CDN cannot proxy WebSocket upgrades, so when the page was
 * served through a CDN edge domain (www. / cdn.) the socket must target the
 * APEX origin instead of the edge host. Stripping the known edge prefix turns
 *   www.drone-navigation.com / cdn.drone-navigation.com -> drone-navigation.com
 * which DNS-resolves directly to ECS 1 (Caddy), bypassing the CDN edge. The
 * apex Caddy /ws and /api/* handlers already allowlist the edge Origins
 * (https://www.drone-navigation.com, https://cdn.drone-navigation.com), so the
 * cross-origin upgrade is accepted.
 *
 * Local dev (http://localhost:5173) is unaffected: no edge prefix, ws:// kept.
 *
 * Every WebSocket in the app MUST be built through this helper — a raw
 * `location.host` URL silently breaks for visitors on the CDN edge domains.
 */
export function sameOriginWsUrl(path) {
  const { protocol, host } = window.location;
  const scheme = protocol === 'https:' ? 'wss' : 'ws';
  const bareHost = host.replace(/^(www\.|cdn\.)/, '');
  return `${scheme}://${bareHost}${path}`;
}

/**
 * apexBaseUrl() — the origin every non-CDN-cacheable request must target.
 *
 * Same rationale as sameOriginWsUrl(), applied to plain HTTP: the CDN edge
 * never caches /api/* (X-Swift-CacheTime: 0), so a request made against the
 * edge domain travels browser -> edge -> Virginia origin -> edge -> browser.
 * Stripping the edge prefix pins the call to the apex (one ocean round trip
 * instead of two). The server's CORS allowlist (cors_origins in the prod
 * config) accepts the resulting cross-origin requests from the www./cdn.
 * pages, and apex visitors stay same-origin (no preflight at all).
 *
 * Unlike apiBaseUrl() this has NO dev override: it is for content served by
 * the same web server as the page itself (Vite's dev middleware locally,
 * Caddy in production), so the page's own origin is always the right answer.
 */
export function apexBaseUrl() {
  const { protocol, origin, host } = window.location;
  const bareHost = host.replace(/^(www\.|cdn\.)/, '');
  return bareHost === host ? origin : `${protocol}//${bareHost}`;
}

/**
 * apiBaseUrl() — base URL prefix for every REST fetch() to /api/*.
 *
 * apexBaseUrl() plus the dev override: locally the API runs in a separate
 * uvicorn process on :8000, not behind the Vite dev server.
 *
 * Every fetch() to /api/* MUST be prefixed with this base — a same-origin
 * relative fetch silently regains the CDN double hop for edge visitors.
 */
export function apiBaseUrl() {
  if (import.meta.env.DEV) return 'http://localhost:8000';
  return apexBaseUrl();
}
