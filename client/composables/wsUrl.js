/**
 * wsUrl.js — build a same-origin WebSocket URL for the current page.
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
