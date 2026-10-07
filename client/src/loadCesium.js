/**
 * loadCesium.js — lazy, self-hosted CesiumJS loader (the /play 3D bootstrap).
 *
 * WHY THIS EXISTS
 * CesiumJS is used ONLY by the 3D Exploration route (/play). It used to be
 * loaded by a synchronous <script src="https://cesium.com/.../Cesium.js"> in
 * <head>, which blocked first paint on EVERY page — including the Plaza, which
 * never renders a globe — and pulled ~5 MB from a third-party CDN we neither
 * control nor cache. This module replaces that with an on-demand, same-origin
 * load:
 *
 *   • self-hosted — the script/CSS come from /cesium/ (vendored into
 *     client/public/cesium by scripts/copy-cesium.js from the `cesium` npm
 *     package), so the file is served from our own domain, gzip/zstd-compressed
 *     and cacheable by our CDN edge, with no cesium.com hop through the
 *     visitor's VPN.
 *   • lazy + non-blocking — nothing is fetched until a /play navigation calls
 *     loadCesium(); the Plaza downloads zero Cesium bytes.
 *   • ordered — it resolves only once window.Cesium exists, so the caller can
 *     safely import cesium-main.js afterwards (that module touches the Cesium
 *     global at module scope: Cesium.Viewer, Cesium.GoogleMaps, buildModuleUrl).
 *   • idempotent — every caller (the /play gate in index.html and the route's
 *     beforeEnter guard) awaits the SAME cached promise, so the script tag is
 *     injected at most once however the user arrives at /play (hard load or SPA
 *     navigation), matching the existing cesium-main.js singleton pattern.
 */

// Absolute base so Cesium's buildModuleUrl() resolves Workers/Assets/Widgets
// against our own origin. MUST be set before Cesium.js executes.
const CESIUM_BASE = '/cesium/';

let cesiumPromise = null;

function injectWidgetsCss() {
  if (document.querySelector('link[data-cesium-css]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = CESIUM_BASE + 'Widgets/widgets.css';
  link.setAttribute('data-cesium-css', '');
  document.head.appendChild(link);
}

function injectCesiumScript() {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = CESIUM_BASE + 'Cesium.js';
    // Deterministic execution order (a single script here, but async=false also
    // preserves order if this loader is ever extended).
    script.async = false;
    script.onload = resolve;
    script.onerror = () => reject(new Error('Failed to load ' + script.src));
    document.head.appendChild(script);
  });
}

/**
 * Ensure the self-hosted CesiumJS library is loaded. Resolves with window.Cesium.
 * Safe to call repeatedly and from multiple entry points (index.html gate +
 * router beforeEnter): all callers share one in-flight promise.
 */
export function loadCesium() {
  // Already available (warm SPA re-entry, or the script finished while another
  // caller was awaiting) — nothing to do.
  if (window.Cesium) return Promise.resolve(window.Cesium);
  if (cesiumPromise) return cesiumPromise;

  // Set the base URL BEFORE the library executes so Cesium locates its
  // Workers/Assets/Widgets under /cesium/ instead of guessing from the document.
  window.CESIUM_BASE_URL = CESIUM_BASE;
  injectWidgetsCss();

  cesiumPromise = injectCesiumScript()
    .then(() => {
      if (!window.Cesium) {
        throw new Error('Cesium.js loaded but window.Cesium is still undefined.');
      }
      window.__cesiumLoadError = '';
      console.log('[cesium] self-hosted CesiumJS ready from ' + CESIUM_BASE);
      return window.Cesium;
    })
    .catch((err) => {
      // Do not cache a failure: clear the promise so the next /play navigation
      // retries (e.g. a transient network blip) instead of staying broken.
      cesiumPromise = null;
      // Record the failure so the connection-status check can tell a genuine
      // load error apart from "still initializing" and only then surface a
      // banner (an absent window.Cesium during a normal slow start is not an
      // error and must not flash "Cannot connect to Cesium.").
      window.__cesiumLoadError = (err && err.message) || 'Failed to load CesiumJS';
      console.error('[cesium] failed to load self-hosted CesiumJS:', err);
      throw err;
    });

  return cesiumPromise;
}
