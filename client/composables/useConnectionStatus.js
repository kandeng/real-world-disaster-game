import { ref } from 'vue';

const googleReady = ref(false);
const cesiumReady = ref(false);
const googleError = ref('');
const cesiumError = ref('');

let googleCheckPromise = null;

// Flip cesiumReady the instant the 3D scene reports ready (cesium-main.js
// dispatches 'cesiumReady' once the first tile wave renders) instead of waiting
// for the next 10s poll, and honor a scene that was already ready before this
// module evaluated (warm SPA re-entry back to /play).
if (typeof window !== 'undefined') {
  const markCesiumReady = () => {
    cesiumReady.value = true;
    cesiumError.value = '';
  };
  window.addEventListener('cesiumReady', markCesiumReady);
  if (window.__cesiumReady === true) markCesiumReady();
}

/**
 * Check whether the Google Maps JavaScript API can be loaded.
 * Caches the promise so multiple callers share one check.
 */
export async function checkGoogleConnection() {
  if (typeof window === 'undefined') return false;
  if (window.google?.maps?.Map) {
    googleReady.value = true;
    googleError.value = '';
    return true;
  }
  if (!googleCheckPromise) {
    googleCheckPromise = import('../src/2d_map/googleMaps.js')
      .then((mod) => mod.loadGoogleMaps())
      .then(() => {
        googleReady.value = true;
        googleError.value = '';
        return true;
      })
      .catch((err) => {
        googleReady.value = false;
        googleError.value = err.message || 'Cannot connect to Google.';
        googleCheckPromise = null;
        return false;
      });
  }
  return googleCheckPromise;
}

/**
 * Check whether Cesium and the 3D viewer are available.
 */
export async function checkCesiumConnection() {
  if (typeof window === 'undefined') return false;
  if (window.Cesium && window.cesiumViewer) {
    cesiumReady.value = true;
    cesiumError.value = '';
    return true;
  }
  // Not up yet. Cesium is lazy-loaded on /play, so an absent viewer is normally
  // just "still initializing" — surface an error ONLY if the loader recorded a
  // genuine failure. Leaving cesiumError empty while pending stops the banner
  // flashing "Cannot connect to Cesium." during a normal (slow) start.
  cesiumReady.value = false;
  cesiumError.value = window.__cesiumLoadError || '';
  return false;
}

/**
 * Reactive connection status for Vue views.
 */
export function useConnectionStatus() {
  return {
    googleReady,
    cesiumReady,
    googleError,
    cesiumError,
    checkGoogleConnection,
    checkCesiumConnection,
  };
}
