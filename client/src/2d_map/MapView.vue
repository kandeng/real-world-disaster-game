<script setup>
import { ref, onMounted, onUnmounted, watch, computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { acquireMap, releaseMap } from './mapSingleton.js';
import { splinePath } from './spline.js';
import droneIconUrl from '../../icons/drone.svg';
import zoomFocusUrl from '../../icons/zoom_focus.svg';
import zoomPlusUrl from '../../icons/zoom_plus.svg';
import zoomMinusUrl from '../../icons/zoom_minus.svg';

const { t, locale } = useI18n();

// Google Places / Routes results must follow the app language
// (My Space -> Settings -> Language), NOT the browser locale that
// Google would otherwise default to (a zh browser would otherwise
// render every displayName in Chinese while the UI is English).
const gmapsLanguageCode = computed(() => (locale.value === 'zh' ? 'zh-CN' : 'en-US'));

const props = defineProps({
  lat: { type: Number, required: true },
  lon: { type: Number, required: true },
  alt: { type: Number, default: 0 },
  heading: { type: Number, default: 0 },
  mapTypeId: { type: String, default: 'roadmap' },
  isPicking: { type: Boolean, default: false },
  isPanelOpen: { type: Boolean, default: false },
  showDroneMarker: { type: Boolean, default: true },
  // Waypoint circles are press-and-drag editable by default (Route Planning);
  // read-only route illustrations (3D Exploration -> Route) pass false so the
  // dots are plain markers: not clickable, not draggable.
  waypointsEditable: { type: Boolean, default: true },
});

const emit = defineEmits(['centerChange', 'zoomChange', 'mapClick', 'poisFound', 'poisError', 'routeFound', 'routeError', 'mapReady', 'waypointPress', 'waypointMove', 'waypointRelease', 'assetPress', 'assetMove', 'assetRelease']);

const containerRef = ref(null);
const map = ref(null);
const error = ref('');

const MIN_DRONE_SIZE = 24;
const MAX_DRONE_SIZE = 80;
const ALT_SIZE_RANGE = 500;

const droneSize = computed(() => {
  const ratio = Math.min(Math.max(props.alt / ALT_SIZE_RANGE, 0), 1);
  return Math.round(MAX_DRONE_SIZE - ratio * (MAX_DRONE_SIZE - MIN_DRONE_SIZE));
});

// Altitude (meters) ↔ Google Maps zoom level.
// Uses Google's exponential model: altitude ≈ 20 971 520 / 2^zoom.
//
//    z7 ≈ 163 840 m   z11 ≈ 10 240 m   z15 ≈   640 m   z19 ≈   40 m
//    z8 ≈  81 920 m   z12 ≈  5 120 m   z16 ≈   320 m   z20 ≈   20 m
//    z9 ≈  40 960 m   z13 ≈  2 560 m   z17 ≈   160 m   z21 ≈   10 m
//   z10 ≈  20 480 m   z14 ≈  1 280 m   z18 ≈    80 m
const MIN_ZOOM = 7;      // ~163 840 m
const MAX_ZOOM = 21;     // ~10 m
const MAX_ALT  = 100000; // operational ceiling (meters)
const MIN_ALT  = 10;     // matches Google Maps max zoom (z21 ≈ 10 m)
const ALT_ZOOM_K = 20971520; // exact: 10 m * 2^21

// Guard flags to distinguish programmatic changes from user-initiated gestures.
let lastProgrammaticCenter = null;
let lastProgrammaticZoom = null;
let lastProgrammaticPan = null;  // panTo target: its center_changed must reach the parent
let lastZoomChangeTime = 0;  // timestamp (ms) of last user-initiated zoom
let listeners = [];
let wheelHandler = null;     // stored so we can removeEventListener on unmount
let clickListener = null;    // Google Maps click listener for picking mode
let mapsApi = null;          // loaded Google Maps API namespace
let cursorLatLng = null;     // last mouse position on the map (LatLng)
let selectionMarker = null;  // default Google pin dropped on a picked address
let waypointMarkers = [];    // solid blue circles with white bold indices
let waypointPath = null;     // spline polyline linking the waypoints in order
let selectedWaypointId = null; // id of the red (selected) waypoint circle
let wpDrag = null;           // active waypoint drag: { id, marker, moveL, upL }
let lastWpDragEnd = 0;       // swallow the map click right after a drag
// Build Scene asset dots (mutually independent blue circles, no spline).
let assetMarkers = [];       // one circle per placed asset
let assetDrag = null;        // active asset drag: { id, marker, moveL, endDrag, moved }
let lastAssetDragEnd = 0;    // swallow the map click right after an asset drag
let assetFlashTimer = null;  // pulses the dots whose mesh is still unspecified
let assetFlashDim = false;   // current phase of the pulse

function altToZoom(alt) {
  const clamped = Math.max(MIN_ALT, Math.min(MAX_ALT, alt));
  const z = Math.log2(ALT_ZOOM_K / clamped);
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round(z)));
}

function zoomToAlt(zoom) {
  const clamped = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom));
  return Math.max(MIN_ALT, Math.min(MAX_ALT, ALT_ZOOM_K / Math.pow(2, clamped)));
}

function isSameCenter(a, b) {
  return Math.abs(a.lat - b.lat) < 1e-7 && Math.abs(a.lng - b.lng) < 1e-7;
}

function updateMapCenter(lat, lng) {
  if (!map.value) return;
  const current = map.value.getCenter();
  const target = { lat, lng };
  if (isSameCenter({ lat: current.lat(), lng: current.lng() }, target)) return;
  lastProgrammaticCenter = target;
  map.value.setCenter(target);
}

// ── Anchor-preserving zoom (reverse-engineered from Google Maps internals) ──
//
// Google Maps' native wheel-zoom pipeline:
//   1. Read cursor pixel position from the WheelEvent
//   2. Un-project that pixel to a geographic point (Web Mercator inverse)
//   3. Change the zoom level
//   4. Compute where that geo point lands at the new zoom (forward projection)
//   5. Shift the map center so the geo point stays under the cursor
//
// We replicate this exact pipeline using Google Maps' public Projection API
// (fromLatLngToPoint / fromPointToLatLng).  The same function is used for:
//   • Mouse wheel  – anchor = cursor pixel position  (cursor-anchored)
//   • H-mode       – anchor = map center              (center-anchored)
//
// Neither zoom_changed nor center_changed side-effects are emitted because all
// resulting state changes are guarded by lastProgrammaticZoom / lastProgrammaticCenter.
function anchoredZoom(zoomDelta, anchorX, anchorY, silent = false) {
  if (!map.value) return;
  const projection = map.value.getProjection();
  if (!projection) return;

  const curZoom = map.value.getZoom();
  const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, curZoom + zoomDelta));
  if (newZoom === curZoom) return;

  const scale0 = Math.pow(2, curZoom) * 256;
  const scale1 = Math.pow(2, newZoom) * 256;
  const center = map.value.getCenter();
  const centerWorld = projection.fromLatLngToPoint(center);
  const rect = map.value.getDiv().getBoundingClientRect();
  const halfW = rect.width / 2;
  const halfH = rect.height / 2;

  const ax0 = centerWorld.x + (anchorX - halfW) / scale0;
  const ay0 = centerWorld.y + (anchorY - halfH) / scale0;
  const ax1 = centerWorld.x + (anchorX - halfW) / scale1;
  const ay1 = centerWorld.y + (anchorY - halfH) / scale1;

  const newCx = centerWorld.x + (ax0 - ax1);
  const newCy = centerWorld.y + (ay0 - ay1);
  const newCenter = projection.fromPointToLatLng(new google.maps.Point(newCx, newCy));

  // Always guard the center_changed side effect of the zoom.
  lastProgrammaticCenter = { lat: newCenter.lat(), lng: newCenter.lng() };
  // For silent (programmatic/H-mode) zooms, also guard zoom_changed so the
  // altitude prop update doesn't trigger a feedback loop.
  if (silent) {
    lastProgrammaticZoom = newZoom;
  } else {
    // For user wheel zooms, record timestamp so the center_changed side effect
    // is suppressed regardless of event ordering.
    lastZoomChangeTime = Date.now();
  }

  map.value.setZoom(newZoom);
  map.value.setCenter(newCenter);
}

// H-mode: programmatic zoom always anchors at the map center (drone icon).
function updateMapZoom(alt) {
  if (!map.value) return;
  const rect = map.value.getDiv()?.getBoundingClientRect();
  if (!rect) return;
  anchoredZoom(altToZoom(alt) - map.value.getZoom(), rect.width / 2, rect.height / 2, true);
}

function handleCenterChanged() {
  if (!map.value) return;
  const center = map.value.getCenter();
  const target = { lat: center.lat(), lng: center.lng() };
  // A search-result pan intentionally moves the map: its center_changed
  // must reach the parent (the drone follows to the searched place) even
  // though the accompanying setZoom stamps the zoom throttle below.
  if (lastProgrammaticPan) {
    const pan = lastProgrammaticPan;
    lastProgrammaticPan = null;
    if (isSameCenter(target, pan)) {
      lastProgrammaticCenter = null;
      emit('centerChange', target);
      return;
    }
  }
  if (Date.now() - lastZoomChangeTime < 150) {
    return;
  }
  if (lastProgrammaticCenter && isSameCenter(target, lastProgrammaticCenter)) {
    lastProgrammaticCenter = null;
    return;
  }
  lastProgrammaticCenter = null;
  emit('centerChange', target);
}

function handleZoomChanged() {
  if (!map.value) return;
  const zoom = map.value.getZoom();
  if (lastProgrammaticZoom !== null && Math.abs(zoom - lastProgrammaticZoom) < 0.5) {
    lastProgrammaticZoom = null;
    return;
  }
  lastProgrammaticZoom = null;
  lastZoomChangeTime = Date.now();
  emit('zoomChange', zoomToAlt(zoom));
}

function onWheel(e) {
  if (!map.value) return;
  e.stopPropagation();
  const rect = map.value.getDiv().getBoundingClientRect();
  anchoredZoom(e.deltaY < 0 ? 1 : -1, e.clientX - rect.left, e.clientY - rect.top, false);
}

// ── Bottom-right Google-Maps-style controls (focus / zoom-in / zoom-out) ──
// Un-guarded setZoom / setCenter / fitBounds so the resulting zoom_changed /
// center_changed events reach the parent view and keep the simulated drone's
// altitude + position in sync with the map.
function zoomIn() {
  if (!map.value) return;
  map.value.setZoom(Math.min(MAX_ZOOM, map.value.getZoom() + 1));
}

function zoomOut() {
  if (!map.value) return;
  map.value.setZoom(Math.max(MIN_ZOOM, map.value.getZoom() - 1));
}

// Recenter on the current point of interest: the selected address pin if one
// is down, otherwise fit all waypoint dots in view, otherwise keep the view.
function focusMap() {
  if (!map.value || !mapsApi) return;
  if (selectionMarker) {
    map.value.setCenter(selectionMarker.getPosition());
    return;
  }
  if (waypointMarkers.length) {
    const bounds = new mapsApi.LatLngBounds();
    waypointMarkers.forEach((m) => bounds.extend(m.getPosition()));
    map.value.fitBounds(bounds, 80);
  }
}

onMounted(async () => {
  try {
    // Acquire the session-persistent Google Map (see mapSingleton.js): its
    // container is re-attached here and its tiles stay cached across mounts
    // and page switches — the map is never destroyed/recreated.
    const acquired = await acquireMap(containerRef.value, {
      lat: props.lat,
      lon: props.lon,
      zoom: altToZoom(props.alt),
      mapTypeId: props.mapTypeId,
    });
    map.value = acquired.map;
    mapsApi = acquired.mapsApi;

    listeners.push(mapsApi.event.addListener(map.value, 'center_changed', handleCenterChanged));
    listeners.push(mapsApi.event.addListener(map.value, 'zoom_changed', handleZoomChanged));
    // Track the cursor's geographic position so parents can e.g. sort
    // search results by distance to the cursor.
    listeners.push(mapsApi.event.addListener(map.value, 'mousemove', (e) => {
      cursorLatLng = e.latLng;
    }));
    attachMapClickListener();

    // Capture-phase wheel listener: fires before any Google Maps listener.
    // passive: false avoids Chrome's passive-listener console warning.
    wheelHandler = onWheel;
    containerRef.value.addEventListener('wheel', wheelHandler, { capture: true, passive: false });

    // Let the parent redraw maintained overlays (waypoint markers) whenever
    // the map is (re)acquired — e.g. returning from 3D or another page.
    emit('mapReady');
  } catch (e) {
    console.error('[2D Map]', e);
    error.value = e?.message || String(e);
  }
});

onUnmounted(() => {
  listeners.forEach((listener) => listener?.remove());
  listeners = [];
  if (clickListener) {
    clickListener.remove();
    clickListener = null;
  }
  if (selectionMarker) {
    selectionMarker.setMap(null);
    selectionMarker = null;
  }
  // The Google Map itself is session-persistent (mapSingleton), so any
  // marker not removed here would orphan onto the next mount — two live
  // dots on the same map. Always clear the orange position marker.
  if (liveMarker) {
    liveMarker.setMap(null);
    liveMarker = null;
  }
  assetMarkers.forEach((m) => m.setMap(null));
  assetMarkers = [];
  if (assetDrag) {
    mapsApi.event.removeListener(assetDrag.moveL);
    window.removeEventListener('mouseup', assetDrag.endDrag);
    assetDrag = null;
  }
  if (assetFlashTimer) {
    window.clearInterval(assetFlashTimer);
    assetFlashTimer = null;
  }
  waypointMarkers.forEach((m) => m.setMap(null));
  waypointMarkers = [];
  if (wpDrag) {
    mapsApi.event.removeListener(wpDrag.moveL);
    window.removeEventListener('mouseup', wpDrag.endDrag);
    wpDrag = null;
  }
  if (waypointPath) {
    waypointPath.setMap(null);
    waypointPath = null;
  }
  if (wheelHandler && containerRef.value) {
    containerRef.value.removeEventListener('wheel', wheelHandler, { capture: true });
  }
  wheelHandler = null;
  map.value = null;
  // Detach the persistent map container WITHOUT destroying the map, so its
  // tiles stay warm for the next mount (same view or another page).
  releaseMap();
});

watch(() => [props.lat, props.lon], ([lat, lon]) => {
  updateMapCenter(lat, lon);
});

watch(() => props.alt, (alt) => {
  updateMapZoom(alt);
});

// React to map-type changes (e.g. switching between the 2D Address and
// 2D Satellite subpages) after the map has been created.
watch(() => props.mapTypeId, (mapTypeId) => {
  if (map.value) map.value.setMapTypeId(mapTypeId);
});

function displayNameOf(place) {
  if (!place || !place.displayName) return '';
  return typeof place.displayName === 'string' ? place.displayName : place.displayName.text || '';
}

async function searchNearbyPois(latLng) {
  if (!mapsApi?.places?.Place?.searchNearby) {
    emit('poisError', 'Places API is not available. Please enable the Places API for your Google Maps API key.');
    return;
  }
  try {
    const circle = new mapsApi.Circle({
      center: latLng,
      radius: 500, // meters
    });
    const request = {
      locationRestriction: circle,
      fields: ['id', 'displayName', 'shortFormattedAddress', 'location'],
      // New Places API: the request property is `language` (NOT
      // `languageCode` — that one only exists on the Routes API and
      // throws InvalidValueError here).
      language: gmapsLanguageCode.value,
    };
    const response = await mapsApi.places.Place.searchNearby(request);
    emit('poisFound', (response?.places || []).slice(0, 10).map(toPoi));
  } catch (err) {
    console.error('[MapView] Place.searchNearby error:', err);
    emit('poisError', `Places API request failed: ${err?.message || err}`);
  }
}

// Map a new-Places-API Place onto the legacy POI shape consumed by
// WaypointPanel.vue (place_id / name / geometry.location).
function toPoi(place) {
  return {
    place_id: place.id,
    name: displayNameOf(place),
    address: typeof place.shortFormattedAddress === 'string' ? place.shortFormattedAddress : '',
    geometry: {
      location: place.location,
    },
  };
}

// Text-query twin of searchNearbyPois: free-form place / address strings
// ("Carnegie Mellon University") instead of proximity around a point.
//
// BUG-FIX: without a locationBias, Place.searchByText ranks matches
// GLOBALLY — a brand query like "starbucks" came back with stores in
// Japan even though the map sat on Sunnyvale, CA. Biasing the request
// to the cursor (fallback: map center) with a viewport-sized circle
// makes Google return nearby candidates first; the parent view's
// cursor-distance sort then fine-tunes the order.
function currentBiasCircle() {
  if (!mapsApi || !map.value) return null;
  const anchor = cursorLatLng || map.value.getCenter();
  if (!anchor) return null;
  // Radius ≈ half the viewport diagonal in meters (equirectangular
  // approximation — good enough for a *bias*).
  let radius = 1000;
  const bounds = map.value.getBounds();
  if (bounds) {
    const center = bounds.getCenter();
    const ne = bounds.getNorthEast();
    const dLat = (ne.lat() - center.lat()) * 111320;
    const dLng = (ne.lng() - center.lng()) * 111320 * Math.cos((center.lat() * Math.PI) / 180);
    radius = Math.sqrt(dLat * dLat + dLng * dLng);
  }
  radius = Math.max(500, Math.min(50000, radius));
  return new mapsApi.Circle({
    center: { lat: anchor.lat(), lng: anchor.lng() },
    radius,
  });
}

async function searchPoisByText(text) {
  if (!mapsApi?.places?.Place?.searchByText) {
    emit('poisError', 'Places API is not available. Please enable the Places API for your Google Maps API key.');
    return;
  }
  try {
    const request = {
      textQuery: text,
      fields: ['id', 'displayName', 'shortFormattedAddress', 'location'],
      maxResultCount: 10,
      language: gmapsLanguageCode.value,
      locationBias: currentBiasCircle(),
    };
    const response = await mapsApi.places.Place.searchByText(request);
    emit('poisFound', (response?.places || []).slice(0, 10).map(toPoi));
  } catch (err) {
    console.error('[MapView] Place.searchByText error:', err);
    emit('poisError', `Places API request failed: ${err?.message || err}`);
  }
}

// Recenter the map on a search result. Intentionally UNGUARDED (unlike
// updateMapCenter / updateMapZoom): the resulting center/zoom events must
// reach the parent view so the simulated drone follows the map to the
// searched place.
function panTo(lat, lng, alt = 320) {
  if (!map.value) return;
  lastProgrammaticPan = { lat, lng };
  map.value.setZoom(altToZoom(alt)); // z16 — campus/street level
  map.value.setCenter({ lat, lng });
}

function searchNearbyPoisAt(lat, lng) {
  if (!mapsApi) return;
  searchNearbyPois(new mapsApi.LatLng(lat, lng));
}

function parseWaypointInput(name) {
  if (!name) return null;
  const trimmed = name.trim();
  // Try to parse our coordinate format: "lat, lon, alt"
  const coordMatch = trimmed.match(/^(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)$/);
  if (coordMatch) {
    return new mapsApi.LatLng(parseFloat(coordMatch[1]), parseFloat(coordMatch[2]));
  }
  // Otherwise treat as a place/address string
  return trimmed;
}

// ── Routes API (google.maps.routes.Route.computeRoutes) ──────────────────
// The legacy google.maps.DirectionsService is deprecated (Feb 2026). We use
// the Routes API instead and adapt its response back into the
// DirectionsResult shape that WaypointPanel.vue consumes, so the panel needs
// no changes.

// Routes API durations are protobuf strings such as "300s" (or "3.5s").
function durationStringToSeconds(d) {
  if (typeof d === 'number') return d;
  if (typeof d === 'string') {
    const n = parseFloat(d);
    return isNaN(n) ? 0 : n;
  }
  return 0;
}

function formatDistanceText(meters) {
  if (meters == null) return '';
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(1)} km`;
}

function formatDurationText(seconds) {
  if (seconds == null) return '';
  const mins = Math.round(seconds / 60);
  if (mins < 1) return `${Math.round(seconds)} secs`;
  if (mins < 60) return `${mins} mins`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem ? `${hours} hours ${rem} mins` : `${hours} hours`;
}

// Build a Routes API Waypoint from a waypoint input ("lat, lon, alt" coords
// or a free-form place/address string).
function buildRouteWaypoint(name) {
  const parsed = parseWaypointInput(name);
  if (parsed == null) return null;
  if (typeof parsed === 'string') return { address: parsed };
  // google.maps.LatLng
  return { location: { latLng: { latitude: parsed.lat(), longitude: parsed.lng() } } };
}

function convertRouteStep(step) {
  const distanceMeters = step.distanceMeters ?? step.localizedValues?.distance?.value ?? 0;
  return {
    distance: {
      value: distanceMeters,
      text: step.localizedValues?.distance?.text || formatDistanceText(distanceMeters),
    },
    instructions:
      step.navigationInstruction?.instructions ||
      step.navigationInstruction?.maneuver ||
      '',
  };
}

function convertRouteLeg(leg, startIndex, waypoints) {
  const distanceMeters = leg.distanceMeters ?? leg.localizedValues?.distance?.value ?? 0;
  const durationSeconds =
    leg.localizedValues?.staticDuration?.value ??
    durationStringToSeconds(leg.staticDuration ?? leg.duration);
  // Fall back to the user-entered waypoint names when the API does not return
  // human-readable addresses for the leg endpoints.
  const startName = waypoints[startIndex]?.name || '';
  const endName = waypoints[startIndex + 1]?.name || '';
  return {
    distance: {
      value: distanceMeters,
      text: leg.localizedValues?.distance?.text || formatDistanceText(distanceMeters),
    },
    duration: {
      value: durationSeconds,
      text: leg.localizedValues?.staticDuration?.text || formatDurationText(durationSeconds),
    },
    start_address: leg.startLocation?.address || startName,
    end_address: leg.endLocation?.address || endName,
    steps: (leg.steps || []).map(convertRouteStep),
  };
}

function convertRoute(route, waypoints) {
  return {
    legs: (route.legs || []).map((leg, i) => convertRouteLeg(leg, i, waypoints)),
  };
}

async function searchRoutes(waypoints) {
  if (!mapsApi || waypoints.length < 2) return;
  if (typeof mapsApi.importLibrary !== 'function') {
    emit('routeError', 'Routes API is not available for this Google Maps API key.');
    return;
  }
  try {
    const { Route } = await mapsApi.importLibrary('routes');
    const origin = buildRouteWaypoint(waypoints[0].name);
    const destination = buildRouteWaypoint(waypoints[waypoints.length - 1].name);
    if (!origin || !destination) {
      emit('routeError', 'ZERO_RESULTS');
      return;
    }
    const intermediates = waypoints
      .slice(1, -1)
      .map((wp) => buildRouteWaypoint(wp.name))
      .filter(Boolean);

    const response = await Route.computeRoutes({
      origin,
      destination,
      intermediates,
      travelMode: 'DRIVE',
      computeAlternativeRoutes: true,
      languageCode: gmapsLanguageCode.value,
      units: 'METRIC',
    });

    const routes = (response?.routes || []).map((r) => convertRoute(r, waypoints));
    if (!routes.length) {
      emit('routeError', 'ZERO_RESULTS');
      return;
    }

    // Select the fastest route by total duration.
    const fastest = routes.reduce((best, route) => {
      const duration = route.legs.reduce((sum, leg) => sum + (leg.duration?.value || 0), 0);
      const bestDuration = best.legs.reduce((sum, leg) => sum + (leg.duration?.value || 0), 0);
      return duration < bestDuration ? route : best;
    });
    emit('routeFound', { routes: [fastest] });
  } catch (err) {
    console.error('[MapView] computeRoutes error:', err);
    const msg = err?.message || String(err);
    const code = err?.code || '';
    if (code === 'PERMISSION_DENIED' || /denied|not authorized|forbidden/i.test(msg)) {
      emit('routeError', 'REQUEST_DENIED');
    } else if (code === 'RESOURCE_EXHAUSTED' || /quota/i.test(msg)) {
      emit('routeError', 'OVER_QUERY_LIMIT');
    } else {
      emit('routeError', msg);
    }
  }
}

function attachMapClickListener() {
  if (!map.value) return;
  if (clickListener) {
    clickListener.remove();
    clickListener = null;
  }
  if (props.isPicking || props.isPanelOpen) {
    clickListener = map.value.addListener('click', (e) => {
      // Swallow the click that fires right after a waypoint / asset drag ends.
      if (Date.now() - lastWpDragEnd < 300) return;
      if (Date.now() - lastAssetDragEnd < 300) return;
      const lat = e.latLng.lat();
      const lng = e.latLng.lng();
      emit('mapClick', { lat, lng });
    });
  }
}

// Drop (or move) a marker at the given address, marking the selected search
// result. Uses Google Maps' default pin icon. Always attaches the pin to the
// map so it is (re)shown even if it was previously hidden.
function setSelectionMarker(lat, lng) {
  if (!mapsApi || !map.value) return;
  const position = new mapsApi.LatLng(lat, lng);
  if (selectionMarker) {
    selectionMarker.setPosition(position);
    selectionMarker.setMap(map.value);
  } else {
    selectionMarker = new mapsApi.Marker({ position, map: map.value });
  }
}

// Show or hide the red selection pin without losing its position — the
// Search view shows it while the Route view hides it, and both share the
// same mounted map instance.
function setSelectionMarkerVisible(visible) {
  if (!selectionMarker || !map.value) return;
  selectionMarker.setMap(visible ? map.value : null);
}

function getCursorLatLng() {
  return cursorLatLng;
}

// Build the numbered-circle icon: solid blue, or red while the left mouse
// button is held on the circle (28px, bold white DengXian / 等线体 index).
function waypointIcon(label, selected) {
  const D = 28;
  const c = D / 2;
  const fill = selected ? '#dc2626' : '#2563eb';
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${D}" height="${D}">` +
    `<circle cx="${c}" cy="${c}" r="${c}" fill="${fill}"/>` +
    `<text x="${c}" y="${c}" font-family="DengXian, 等线, sans-serif" ` +
    `font-size="14" font-weight="bold" fill="#ffffff" text-anchor="middle" ` +
    `dominant-baseline="central">${label}</text>` +
    `</svg>`;
  return {
    url: 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svg),
    scaledSize: new mapsApi.Size(D, D),
    anchor: new mapsApi.Point(c, c),
  };
}

// Add a numbered waypoint marker. Pressing it turns it red and makes it
// draggable; releasing turns it back to blue. Read-only maps (the
// waypointsEditable prop is false) get inert markers instead.
function addWaypointMarker(lat, lng, label, selected, id) {
  if (!mapsApi || !map.value) return;
  const marker = new mapsApi.Marker({
    position: new mapsApi.LatLng(lat, lng),
    map: map.value,
    icon: waypointIcon(label, selected),
    clickable: props.waypointsEditable,
    cursor: props.waypointsEditable ? 'pointer' : undefined,
  });
  marker.wpId = id;
  marker.wpLabel = label;
  if (props.waypointsEditable) {
    marker.addListener('mousedown', () => {
      selectedWaypointId = id;
      marker.setIcon(waypointIcon(label, true));
      emit('waypointPress', id);
      startWaypointDrag(marker, id);
    });
  }
  waypointMarkers.push(marker);
}

// Press-and-drag on the selected (red) waypoint circle: move the marker and
// stream the new position to the parent so the Route list follows live.
// The map's own panning is suspended for the duration of the drag.
function startWaypointDrag(marker, id) {
  if (wpDrag || !map.value) return;
  map.value.setOptions({ draggable: false });
  const moveL = map.value.addListener('mousemove', (e) => {
    if (!wpDrag) return;
    wpDrag.moved = true;
    marker.setPosition(e.latLng);
    emit('waypointMove', { id, lat: e.latLng.lat(), lng: e.latLng.lng() });
  });
  // The map's own 'mouseup' does NOT fire when the pointer is released over
  // a marker, so end the drag on the DOM-level mouseup instead — it fires
  // no matter where the release happens.
  const endDrag = () => {
    const moved = !!wpDrag?.moved;
    mapsApi.event.removeListener(moveL);
    if (map.value) map.value.setOptions({ draggable: true });
    wpDrag = null;
    lastWpDragEnd = Date.now();
    // Release: back to the original blue.
    marker.setIcon(waypointIcon(marker.wpLabel, false));
    selectedWaypointId = null;
    emit('waypointRelease', id, moved);
  };
  window.addEventListener('mouseup', endDrag, { once: true });
  wpDrag = { id, marker, moveL, endDrag, moved: false };
}

// Draw the spline as a single polyline UNDER the waypoint markers (Google
// Maps renders polylines in a layer below markers): the link really passes
// through every waypoint, but the opaque blue circles cover it, so it looks
// as if the spline stops at each circle's border.
function redrawWaypointPath(entries) {
  if (waypointPath) {
    waypointPath.setMap(null);
    waypointPath = null;
  }
  if (!mapsApi || !map.value || (entries || []).length < 2) return;
  waypointPath = new mapsApi.Polyline({
    path: splinePath(entries),
    map: map.value,
    strokeColor: '#2563eb',
    strokeOpacity: 0.8,
    strokeWeight: 2,
    clickable: false,
  });
}

// Replace all waypoint markers AND the spline link (used after the waypoint
// list changes — add or reorder — and the indices drawn inside the circles
// shift).
function redrawWaypointMarkers(entries, selectedId) {
  selectedWaypointId = selectedId ?? null;
  waypointMarkers.forEach((m) => m.setMap(null));
  waypointMarkers = [];
  (entries || []).forEach((e) =>
    addWaypointMarker(e.lat, e.lng, e.index, e.id === selectedWaypointId, e.id)
  );
  redrawWaypointPath(entries || []);
}

// ── Live position marker (orange circle, e.g. the flying drone) ──────────
let liveMarker = null;

// 22px orange dot with a white ring so it reads on both street and
// satellite maps; drawn above the waypoint circles (high zIndex).
function livePositionIcon() {
  const D = 22;
  const c = D / 2;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${D}" height="${D}">` +
    `<circle cx="${c}" cy="${c}" r="${c - 2}" fill="#f97316" ` +
    `stroke="#ffffff" stroke-width="2"/>` +
    `</svg>`;
  return {
    url: 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svg),
    scaledSize: new mapsApi.Size(D, D),
    anchor: new mapsApi.Point(c, c),
  };
}

// Move (or create) the orange dot at the given position. Inert marker:
// the parent updates it every frame from the session drone state.
function setLivePosition(lat, lng) {
  if (!mapsApi || !map.value) return;
  const position = new mapsApi.LatLng(lat, lng);
  if (liveMarker) {
    liveMarker.setPosition(position);
  } else {
    liveMarker = new mapsApi.Marker({
      position,
      map: map.value,
      icon: livePositionIcon(),
      clickable: false,
      zIndex: 2000000,
    });
  }
}

function clearLivePosition() {
  if (liveMarker) {
    liveMarker.setMap(null);
    liveMarker = null;
  }
}

// Replace the whole set of asset dots (Build Scene). Unlike the waypoints of
// the Plan Route page, assets never link up: no polyline / spline is drawn
// between them, each circle stands on its own.
//
// `dim` renders the faded phase of the attention pulse; entries flagged
// `flash` (a position whose mesh has not been specified yet) are pulsed
// periodically by syncAssetFlashPulse() below.
function assetIcon(selected, dim) {
  const D = 22;
  const c = D / 2;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${D}" height="${D}">` +
    `<circle cx="${c}" cy="${c}" r="${c - 2}" fill="${selected ? '#dc2626' : '#2563eb'}" ` +
    `fill-opacity="${dim ? 0.15 : 1}" stroke="#ffffff" stroke-opacity="${dim ? 0.2 : 1}" ` +
    `stroke-width="2"/>` +
    `</svg>`;
  return {
    url: 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svg),
    scaledSize: new mapsApi.Size(D, D),
    anchor: new mapsApi.Point(c, c),
  };
}

function paintAssetPulse() {
  assetMarkers.forEach((m) => {
    m.setIcon(assetIcon(m.assetPressed === true, !!m.flash && assetFlashDim));
  });
}

// Start / stop the pulse that highlights asset dots still waiting for a mesh.
function syncAssetFlashPulse() {
  const need = assetMarkers.some((m) => m.flash);
  if (need && !assetFlashTimer) {
    assetFlashTimer = window.setInterval(() => {
      assetFlashDim = !assetFlashDim;
      paintAssetPulse();
    }, 500);
  } else if (!need && assetFlashTimer) {
    window.clearInterval(assetFlashTimer);
    assetFlashTimer = null;
    assetFlashDim = false;
  }
  paintAssetPulse();
}

function startAssetDrag(marker, id) {
  if (assetDrag || !map.value) return;
  map.value.setOptions({ draggable: false });
  const moveL = map.value.addListener('mousemove', (e) => {
    if (!assetDrag) return;
    assetDrag.moved = true;
    marker.setPosition(e.latLng);
    emit('assetMove', { id, lat: e.latLng.lat(), lng: e.latLng.lng() });
  });
  // Same DOM-level release hook as the waypoint drag: the map's own 'mouseup'
  // does not fire when the pointer is released over a marker.
  const endDrag = () => {
    const moved = !!assetDrag?.moved;
    mapsApi.event.removeListener(moveL);
    if (map.value) map.value.setOptions({ draggable: true });
    assetDrag = null;
    lastAssetDragEnd = Date.now();
    // Release: back to plain blue (the parent redraws the set right after).
    marker.assetPressed = false;
    marker.setIcon(assetIcon(false, !!marker.flash && assetFlashDim));
    emit('assetRelease', { id, moved });
  };
  window.addEventListener('mouseup', endDrag, { once: true });
  assetDrag = { id, marker, moveL, endDrag, moved: false };
}

function setAssetMarkers(entries) {
  assetMarkers.forEach((m) => m.setMap(null));
  assetMarkers = [];
  if (!mapsApi || !map.value) return;
  (entries || []).forEach((e) => {
    if (!e || e.lat == null || e.lon == null) return;
    const marker = new mapsApi.Marker({
      position: new mapsApi.LatLng(e.lat, e.lon),
      map: map.value,
      icon: assetIcon(false, false),
      clickable: true,
      cursor: 'pointer',
      title: e.name || '',
    });
    marker.assetId = e.id;
    marker.flash = !!e.flash;
    marker.addListener('mousedown', () => {
      // The pressed dot stops pulsing: it now carries the pointer.
      marker.assetPressed = true;
      marker.flash = false;
      marker.setIcon(assetIcon(true, false));
      emit('assetPress', e.id);
      startAssetDrag(marker, e.id);
    });
    assetMarkers.push(marker);
  });
  syncAssetFlashPulse();
}

defineExpose({
  searchNearbyPoisAt,
  searchPoisByText,
  panTo,
  searchRoutes,
  setSelectionMarker,
  setSelectionMarkerVisible,
  setLivePosition,
  clearLivePosition,
  getCursorLatLng,
  addWaypointMarker,
  redrawWaypointMarkers,
  redrawWaypointPath,
  setAssetMarkers,
});

watch(() => [props.isPicking, props.isPanelOpen], () => {
  attachMapClickListener();
});


</script>

<template>
  <div class="map-view">
    <div ref="containerRef" class="map-container"></div>
    <img
      v-if="showDroneMarker"
      class="drone-marker"
      :src="droneIconUrl"
      alt="Drone"
      draggable="false"
      :width="droneSize"
      :height="droneSize"
      :style="{
        transform: `translate(-50%, -50%) rotate(${props.heading}deg)`,
      }"
    />
    <div class="map-controls">
      <button type="button" class="map-ctrl-btn" :title="t('mapview.focus')" @click="focusMap">
        <img :src="zoomFocusUrl" alt="" draggable="false" />
      </button>
      <div class="map-ctrl-zoom">
        <button type="button" class="map-ctrl-btn" :title="t('mapview.zoom_in')" @click="zoomIn">
          <img :src="zoomPlusUrl" alt="" draggable="false" />
        </button>
        <button type="button" class="map-ctrl-btn" :title="t('mapview.zoom_out')" @click="zoomOut">
          <img :src="zoomMinusUrl" alt="" draggable="false" />
        </button>
      </div>
    </div>
    <div v-if="error" class="map-error">
      <strong>{{ t('mapview.load_failed') }}</strong>
      <p>{{ error }}</p>
      <p class="map-error-hint">
        {{ t('mapview.api_hint') }}
      </p>
    </div>
  </div>
</template>

<style scoped>
.map-view {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  background: #0b0b0b;
  overflow: hidden;
}

.map-container {
  width: 100%;
  height: 100%;
}

.drone-marker {
  position: absolute;
  top: 50%;
  left: 50%;
  z-index: 2;
  pointer-events: none;
  user-select: none;
  -webkit-user-drag: none;
  filter: drop-shadow(0 2px 4px rgba(0, 0, 0, 0.35));
}

/* Google-Maps-style control stack at the bottom-right. Offset from the right
   edge so it clears the 72px (56px mobile) right dock column. */
.map-controls {
  position: absolute;
  right: 88px;
  bottom: 24px;
  z-index: 5;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}

.map-ctrl-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  padding: 0;
  border: none;
  background: #ffffff;
  border-radius: 8px;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.3);
  cursor: pointer;
}

.map-ctrl-btn:hover {
  background: #f1f3f4;
}

.map-ctrl-btn img {
  width: 20px;
  height: 20px;
  display: block;
}

.map-ctrl-zoom {
  display: flex;
  flex-direction: column;
  border-radius: 8px;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.3);
  overflow: hidden;
}

.map-ctrl-zoom .map-ctrl-btn {
  border-radius: 0;
  box-shadow: none;
}

.map-ctrl-zoom .map-ctrl-btn + .map-ctrl-btn {
  border-top: 1px solid #e0e0e0;
}

@media (max-width: 768px) {
  .map-controls {
    right: 72px;
  }
}

/* Hide Google Maps UI widgets and bottom-right attribution links. */
.map-container :deep(.gmnoprint),
.map-container :deep(.gm-style-cc),
.map-container :deep(.gm-style a[href^="https://maps.google.com/maps?"]),
.map-container :deep(.gm-style a[href^="https://www.google.com/intl/"]),
.map-container :deep(.gm-style-cc a),
.map-container :deep(.gm-style .gm-style-cc span),
.map-container :deep(.gm-style > div > a),
.map-container :deep(.gm-style > div > div > a) {
  display: none !important;
}

.map-error {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(0, 0, 0, 0.85);
  color: #f87171;
  text-align: center;
}

.map-error-hint {
  color: #aaaaaa;
  font-size: 0.85rem;
  max-width: 480px;
}
</style>
