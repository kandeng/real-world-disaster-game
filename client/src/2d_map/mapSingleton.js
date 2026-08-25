// mapSingleton.js — persistent Google Maps 2D instance.
//
// The underlying google.maps.Map object (and every tile it has already
// downloaded) is created ONCE per browser session and kept alive across every
// MapView mount/unmount and across every page switch (3D Exploration /
// Route Planning). MapView components acquire() it on mount — re-attaching
// its container node into their own layout — and release() it on unmount,
// which detaches the container WITHOUT destroying the map. This mirrors the
// Cesium viewer singleton in cesium-main.js, so switching pages never
// re-fetches street-map tiles that are already cached.
import { loadGoogleMaps } from './googleMaps.js';

let mapsApi = null;   // loaded google.maps namespace
let map = null;       // the single persistent google.maps.Map
let container = null; // the DOM node the map is bound to (kept in memory)

// Create (once) or re-attach the persistent map inside hostEl and sync its
// center / zoom / type to the host's current view. Returns { map, mapsApi }.
export async function acquireMap(hostEl, initial) {
  const api = await loadGoogleMaps();
  mapsApi = api;

  if (!container) {
    container = document.createElement('div');
    container.style.width = '100%';
    container.style.height = '100%';
  }
  if (container.parentNode !== hostEl) hostEl.appendChild(container);

  if (!map) {
    map = new api.Map(container, {
      center: { lat: initial.lat, lng: initial.lon },
      zoom: initial.zoom,
      mapTypeId: initial.mapTypeId,
      disableDefaultUI: true,
      clickableIcons: false,
      scrollwheel: false,     // MapView handles wheel events itself
      gestureHandling: 'auto',
      draggable: true,
      keyboardShortcuts: false,
      zoomControl: false,
      mapTypeControl: false,
      streetViewControl: false,
      fullscreenControl: false,
      scaleControl: false,
      rotateControl: false,
    });
  } else {
    // Returning mount: the container moved (and may have been detached).
    // Re-measure, then sync to the host's current location / zoom / type.
    api.event.trigger(map, 'resize');
    map.setMapTypeId(initial.mapTypeId);
    map.setCenter({ lat: initial.lat, lng: initial.lon });
    map.setZoom(initial.zoom);
  }

  return { map, mapsApi: api };
}

// Detach the persistent container from the DOM WITHOUT destroying the map,
// so its tiles and internal state stay warm for the next mount.
export function releaseMap() {
  if (container && container.parentNode) {
    container.parentNode.removeChild(container);
  }
}
