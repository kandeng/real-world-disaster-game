<script setup>
import { ref, computed, onMounted, onUnmounted, watch, toRef } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter, useRoute } from 'vue-router';
import ViewComposer from '@shared/_ViewComposer.vue';
import CollisionWarning from '@shared/CollisionWarning.vue';
import StreetViewPane from '@shared/StreetViewPane.vue';
import { MapView } from '@/2d_map/index.js';
import ConfigurableIcon from '@shared/ConfigurableIcon.vue';
import { useRouteScene3D } from '@shared-composables/useRouteScene3D.js';
import { useRouteAutopilot } from '@shared-composables/useRouteAutopilot.js';
import { useRoutes } from '@shared-composables/useRoutes.js';
import { useVideos } from '@shared-composables/useVideos.js';
import { useDrone } from '@shared-composables/useDrone.js';
import { useSessionState } from '@shared-composables/useSessionState.js';
import { useAltitudeGate, PHASES, DESCEND_THRESHOLD, ASCEND_THRESHOLD } from '@shared-composables/useAltitudeGate.js';
import { useFlightCommands } from '@shared-composables/useFlightCommands.js';
import { useCameraCommands } from '@shared-composables/useCameraCommands.js';
import { useFlightPhysics } from '@shared-composables/useFlightPhysics.js';
import { useCameraPhysics } from '@shared-composables/useCameraPhysics.js';
import { useDockRegistry } from '@shared-composables/useDockRegistry.js';
import { useTilesetSource } from '@shared-composables/useTilesetSource.js';
import { useScreenCapture } from '@shared-composables/useScreenCapture.js';
import { useAppSettings } from '@shared-composables/useAppSettings.js';
import { useAuth } from '@shared-composables/useAuth.js';
import { useConnectionStatus, checkGoogleConnection, checkCesiumConnection } from '@shared-composables/useConnectionStatus.js';
import ConnectionError from '@shared/ConnectionError.vue';

const { t } = useI18n();

const router = useRouter();
const route = useRoute();

const { drone, gimbal } = useDrone();
const { session } = useSessionState();
// Altitude split: the 2D street-map zoom height (mapAlt) is a SEPARATE value
// from the true drone/camera altitude (drone.alt). They are reconciled only
// at the 3D<->2D boundary (see enterStreetFrom3d / toggleSteer).
const mapAlt = toRef(session.view, 'mapAlt');

// 3D data source of the shared Cesium viewer (Google tiles vs OSM Buildings).
const { activeSource, getActiveTileset } = useTilesetSource();
const altitudeGate = useAltitudeGate(drone);

const {
  flight,
  flightCmd,
  activeFlightMode,
  showFlight,
  onFlightMove,
  onFlightStop,
  onFlightModeChange,
  startKeyboard: startFlightKeyboard,
  stopKeyboard: stopFlightKeyboard,
} = useFlightCommands();

const {
  camera,
  cameraCmd,
  activeCameraMode,
  showCamera,
  onCameraMove,
  onCameraStop,
  onCameraModeChange,
  startKeyboard: startCameraKeyboard,
  stopKeyboard: stopCameraKeyboard,
} = useCameraCommands();

const { computeDesiredEnuMove, applyEnuMove, updateTelemetry: updateFlightTelemetry } = useFlightPhysics();
const { step: stepCameraPhysics } = useCameraPhysics();
const { rightItems, registerRight, clear } = useDockRegistry();
const { recorderState, replayProgress, replayPov, captureScreenshot, sampleFrame, toggleRecorder, resetRecorder } = useScreenCapture();
const { isAuthenticated } = useAuth();
const { settings } = useAppSettings();

// Login gate for Screenshot / Screen Recording (the 3D Aerial and 3D Mesh
// subpages share this right dock): anonymous users get a green top-center
// reminder instead of the capture action.
const captureAuthNotice = ref(''); // '' | 'screenshot' | 'recording'
let captureAuthTimer = null;
function flashCaptureAuth(action) {
  captureAuthNotice.value = action;
  clearTimeout(captureAuthTimer);
  captureAuthTimer = setTimeout(() => { captureAuthNotice.value = ''; }, 6000);
}
function guardedScreenshot() {
  if (isAuthenticated.value) return captureScreenshot();
  flashCaptureAuth('screenshot');
}
function guardedToggleRecorder() {
  // Never trap an ACTIVE recording: toggling off is always allowed.
  if (isAuthenticated.value || recorderState.value !== 'idle') return toggleRecorder();
  flashCaptureAuth('recording');
}
const isRecorderActive = computed(() => recorderState.value !== 'idle');
let savedDiskVisibility = null;

const isCollisionFrozen = ref(false);
const collisionSurfaceNormal = ref(null);
const MIN_SAFETY_BUFFER = 2.0; // meters
const LOOK_AHEAD_TIME = 2.0; // seconds

const { googleReady, cesiumReady, googleError, cesiumError } = useConnectionStatus();
const connectionMessage = computed(() => {
  if (!cesiumReady.value && !googleReady.value) {
    return cesiumError.value || googleError.value || 'Cannot connect to Cesium and Google.';
  }
  if (!cesiumReady.value) return cesiumError.value || 'Cannot connect to Cesium.';
  if (!googleReady.value) return googleError.value || 'Cannot connect to Google.';
  return '';
});
const showConnectionError = computed(() => !cesiumReady.value || !googleReady.value);
let connectionCheckInterval = null;

const cesiumContainer = ref(null);
const streetViewReady = ref(false);
const lockedMessage = ref('');
let lockedMessageTimer = null;

// Active background of this page:
//   '3d'     – the shared Cesium 3D globe (default, the classic view)
//   'street' – Google 2D street map, entered via the Search / Route buttons
// Same workflow as the Route Planning page: address search lives on the 2D
// map; the Route button keeps exactly the same map (center / zoom / the red
// balloon of the picked address); Steer lifts the view to the Google Earth
// 3D tiles nadir overview of the same spot and scale.
const routeScene = useRouteScene3D();
// Phase 3 (session-state migration): this page's view context lives in the
// session store, so the sub-view (Steer 3D / Search / Route overview), the
// search text and the picked-address balloon survive page switches and are
// restored on return. subView drives everything; the 2D/3D mode is derived
// ('steer' is the only 3D state).
const viewCtx = session.view.aerial;
const isStreet = computed(() => viewCtx.subView !== 'steer');
const mapTypeId = computed(() => 'roadmap');

// ── /play?r=<16-char route id> shareable play link ───────────────────────
// The Gallery's "Explore the Scene in 3D" (or any shared copy of the URL)
// lands here: fetch the route publicly, seed the session route domain (the
// 2D Route view then shows its read-only dots) and hand the drone to the
// waypoint autopilot. The 3D waypoint overlay (blue dots + spline) is NOT
// drawn here — the play view keeps a clean cinematic scene. ?v=<16-char
// video id> is the fallback for gallery videos whose source route was
// deleted (the frozen waypoint snapshot rides on the video row).
const autopilot = useRouteAutopilot();
const { getPublicRoute } = useRoutes();
const { listPublicVideos } = useVideos();

function stopPlay() {
  autopilot.stop();
}

// ── Play-link tile loading progress bar ──────────────────────────────────
// Deep links (Plaza -> "Explore the scene in 3D", Content -> Route ->
// Steer) land on a fresh camera pose, so Google Earth 3D tiles for the
// route area stream in from scratch — show a progress bar until every
// tileset reports tilesLoaded. Cesium exposes no per-tileset percentage
// in this build, so the bar eases toward 90% (pseudo-progress) and snaps
// to 100% once the scene stays ready for a short streak; a 45 s safety
// cap mirrors waitForTilesRendered in cesium-main.js so the bar never
// blocks forever on a flaky connection.
const playLoading = ref(false);
const playLoadPct = ref(0);
let playLoadTimer = null;

// Deep-link journey gating (all six Play! entrances funnel here):
//   playArmed      – a rideable route was loaded from the ?r/?v query;
//   playTilesReady – the progress bar finished (tiles downloaded + rendered);
//   playLaunched   – the user clicked Steer to start the flight.
// The blue top-bar reminder shows only in the armed + ready + not-launched
// window; the waypoint animation only runs once launched.
const playArmed = ref(false);
const playTilesReady = ref(false);
const playLaunched = ref(false);
const showPlayReady = computed(
  () => playArmed.value && playTilesReady.value && !playLaunched.value
);

function stopPlayLoading() {
  if (playLoadTimer) {
    clearInterval(playLoadTimer);
    playLoadTimer = null;
  }
  playLoading.value = false;
  playLoadPct.value = 0;
}

function startPlayLoading() {
  stopPlayLoading();
  playLoading.value = true;
  playLoadPct.value = 0;
  let readyStreak = 0;
  let elapsed = 0;
  playLoadTimer = setInterval(() => {
    elapsed += 100;
    if (routeScene.sceneTilesReady()) {
      readyStreak += 1;
      // Ease faster while tiles demonstrably arrive.
      playLoadPct.value = Math.min(0.95, playLoadPct.value + (0.95 - playLoadPct.value) * 0.08);
    } else {
      readyStreak = 0;
      playLoadPct.value = Math.min(0.9, playLoadPct.value + (0.9 - playLoadPct.value) * 0.03);
    }
    if (readyStreak >= 5 || elapsed >= 45000) {
      playLoadPct.value = 1;
      clearInterval(playLoadTimer);
      playLoadTimer = null;
      setTimeout(() => {
        playLoading.value = false;
        playTilesReady.value = true;
      }, 400);
    }
  }, 100);
}

async function applyPlayQuery() {
  const r = typeof route.query.r === 'string' ? route.query.r : '';
  const v = typeof route.query.v === 'string' ? route.query.v : '';
  if (!r && !v) {
    playArmed.value = false;
    playLaunched.value = false;
    stopPlay();
    stopPlayLoading();
    return;
  }
  let payload = null;
  try {
    if (r) {
      const row = await getPublicRoute(r);
      payload = { ...row, sourceRouteId: row.id };
    } else {
      const list = await listPublicVideos();
      const vid = (list || []).find((x) => x.id === v);
      if (vid) payload = { ...vid, sourceRouteId: vid.route_id };
    }
  } catch {
    /* offline or unknown id: stay on the default view */
  }
  const wps = ((payload && payload.waypoints) || []).map((w, i) => ({ ...w, id: i + 1, index: i + 1 }));
  if (!wps.length) {
    playArmed.value = false;
    playLaunched.value = false;
    stopPlay();
    stopPlayLoading();
    return;
  }
  session.route.sourceRouteId = payload.sourceRouteId ?? null;
  session.route.title = payload.title || '';
  session.route.description = payload.description || '';
  session.route.createdAt = payload.created_at || '';
  session.route.waypoints = wps;
  session.route.selectedWpId = null;
  // Journey gating: park the drone at the first waypoint (static authored
  // view, no animation) while the progress bar runs; the disks stay hidden
  // and the flight only launches when the user clicks Steer.
  playArmed.value = true;
  playLaunched.value = false;
  showFlight.value = false;
  showCamera.value = false;
  viewCtx.subView = 'steer';
  startPlayLoading();
  autopilot.prime(wps);
}
watch(() => route.query, applyPlayQuery);

// ── Search panel state (address finding — same workflow as Route Planning) ──
const mapViewRef = ref(null);
const showSearchPanel = computed(() => viewCtx.subView === 'search');
const searchQuery = toRef(viewCtx, 'searchQuery');
const searchResults = ref([]);
const searchError = ref('');
// True while a search query is in flight; the next poisFound event then
// fills the results list.
const searchBusy = ref(false);
// True once at least one query has been submitted (gates the
// "No results found." hint so it never shows while merely typing).
const hasSearched = ref(false);
// Read-only route illustration (blue dots + spline) whenever the 2D
// street map is up — including under the Reset popup, which hosts the
// Replay / Restart actions.
const routeActive = computed(() => isStreet.value);
// The address the user picked from the search results (the red balloon),
// carried in the session store so the balloon is re-shown when returning to
// the Search view after the map was recreated (e.g. after a 3D excursion or
// a page switch).
const selectedLatLng = toRef(viewCtx, 'selectionLatLng');

function onClickSearch(altOverride = null) {
  // Address search always shows the 2D street map. Without an override it
  // matches the location / zoom the user currently has (leaving 3D first);
  // an override (Reset with a carried route) frames the map instead.
  if (altOverride != null) mapAlt.value = altOverride;
  else if (!isStreet.value) enterStreetFrom3d();
  viewCtx.subView = 'search';
  snapshotMap();
  // The Search view marks the picked address with the red balloon.
  if (selectedLatLng.value) {
    mapViewRef.value?.setSelectionMarker(selectedLatLng.value.lat, selectedLatLng.value.lng);
  }
}

// Reset: open the address search popup. The popup hosts the route-aware
// actions (Replay / Restart) above the address lookup; the current route
// is left untouched until the user explicitly clicks Restart inside.
// With a carried route, the 2D street map opens framed at TWICE the
// average waypoint altitude so the read-only blue dots + spline fit.
function onClickReset() {
  const wps = session.route.waypoints;
  let altOverride = null;
  if (wps.length) {
    const avgAlt = wps.reduce((s, w) => s + (Number(w.alt) || 0), 0) / wps.length;
    altOverride = Math.max(0, Math.min(100000, 2 * avgAlt));
  }
  onClickSearch(altOverride);
}

// Route-aware popup actions:
// - Replay re-runs the virtual drone flight from the first waypoint to the
//   last (the autopilot teleports the drone to the start and flies it).
// - Restart wipes the current route so the user starts from scratch with
//   an address search.
const hasRoute = computed(() => session.route.waypoints.length > 0);

function onClickReplay() {
  const wps = session.route.waypoints;
  if (!wps.length) return;
  viewCtx.subView = 'steer'; // leave the popup (and 2D map) for the 3D view
  playLaunched.value = true; // explicit replay: never re-show the reminder
  autopilot.start(wps);
}

function onClickRestart() {
  stopPlay();
  playArmed.value = false;
  playLaunched.value = false;
  session.route.sourceRouteId = null;
  session.route.title = '';
  session.route.description = '';
  session.route.waypoints = [];
  session.route.selectedWpId = null;
}

function enterStreetFrom3d() {
  // Convert the true 3D camera altitude into the separate 2D map height so
  // the street map opens at the same location and ground scale (zoom level)
  // the user was seeing in 3D. drone.alt itself stays the true altitude.
  mapAlt.value = routeScene.modelAltForMapScale(drone.alt, drone.lat);
}

// ── Lossless 2D<->3D round trips ──────────────────────────────────────────
// Snapshot of the map state (center + zoom height) taken when the street
// map is entered. Pans / zooms / search picks mutate drone.lat/lon or
// mapAlt (the map emits those events only for real interactions), so
// comparing against the snapshot tells whether the user moved the map.
let knownMap = null;
function snapshotMap() {
  knownMap = { lat: drone.lat, lon: drone.lon, alt: mapAlt.value };
}
function mapMoved() {
  if (!knownMap) return true;
  return (
    Math.abs(drone.lat - knownMap.lat) > 1e-9 ||
    Math.abs(drone.lon - knownMap.lon) > 1e-9 ||
    Math.abs(mapAlt.value - knownMap.alt) > 1e-6
  );
}

function onSearchSubmit() {
  const text = searchQuery.value.trim();
  if (!text || !mapViewRef.value) return;
  searchError.value = '';
  searchResults.value = [];
  searchBusy.value = true;
  hasSearched.value = true;
  mapViewRef.value.searchPoisByText(text);
}

function onResultClick(poi) {
  const loc = poi?.geometry?.location;
  if (loc && mapViewRef.value) {
    selectedLatLng.value = { lat: loc.lat(), lng: loc.lng() };
    mapViewRef.value.panTo(loc.lat(), loc.lng());
    // Mark the picked address with Google's default red pin ("balloon").
    mapViewRef.value.setSelectionMarker(loc.lat(), loc.lng());
  }
}

function onMapCenterChange({ lat, lng }) {
  drone.lat = lat;
  drone.lon = lng;
}

function onMapZoomChange(alt) {
  mapAlt.value = Math.max(0, Math.min(100000, alt));
}

// The Google Map is recreated whenever we return from the 3D view; re-apply
// the picked-address balloon if we are back on the Search view, and the
// read-only route illustration if we are back on the Route view.
function onMapReady() {
  if (isStreet.value && showSearchPanel.value && selectedLatLng.value) {
    mapViewRef.value?.setSelectionMarker(selectedLatLng.value.lat, selectedLatLng.value.lng);
  }
  if (routeActive.value) redrawRouteMarkers();
  if (showLivePos.value) mapViewRef.value?.setLivePosition(drone.lat, drone.lon);
}

// Read-only route illustration (Content -> Steer handoff): while the Route
// sub-view is active, the carried route (session.route) is drawn exactly as
// Route Planning draws it — numbered blue dots linked by the blue spline —
// but NOT editable: this page's MapView passes waypoints-editable=false, so
// the dots are inert (not draggable).
function redrawRouteMarkers() {
  mapViewRef.value?.redrawWaypointMarkers(session.route.waypoints, null);
}
function clearRouteMarkers() {
  mapViewRef.value?.redrawWaypointMarkers([], null);
}
watch(routeActive, (active) => {
  if (!isStreet.value) return; // leaving for 3D unmounts the map (it cleans up)
  if (active) redrawRouteMarkers();
  else clearRouteMarkers();
});

// Live drone position on the 2D map (orange circle): the flight keeps
// stepping while the Reset popup is up, so the dot rides the blue route —
// and deviates from it whenever the player grabs the Flight / Gimbal disks.
const showLivePos = computed(
  () => isStreet.value && session.route.waypoints.length > 0
);
watch(
  [() => drone.lat, () => drone.lon, showLivePos],
  () => {
    if (showLivePos.value) mapViewRef.value?.setLivePosition(drone.lat, drone.lon);
    else mapViewRef.value?.clearLivePosition();
  }
);

// Great-circle distance (meters) between two lat/lon pairs.
function haversineMeters(aLat, aLng, bLat, bLng) {
  const R = 6371000;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

function onPoisFound(pois) {
  if (searchBusy.value) {
    searchBusy.value = false;
    // Order results by distance to the cursor's current map position
    // (closest first).
    const list = [...(pois || [])];
    const cursor = mapViewRef.value?.getCursorLatLng?.();
    if (cursor) {
      list.sort((a, b) => {
        const aLoc = a?.geometry?.location;
        const bLoc = b?.geometry?.location;
        if (!aLoc || !bLoc) return 0;
        return (
          haversineMeters(cursor.lat(), cursor.lng(), aLoc.lat(), aLoc.lng()) -
          haversineMeters(cursor.lat(), cursor.lng(), bLoc.lat(), bLoc.lng())
        );
      });
    }
    searchResults.value = list;
  }
}

function onPoisError(message) {
  console.error('[AerialView] poisError:', message);
  if (searchBusy.value) {
    searchBusy.value = false;
    searchResults.value = [];
    searchError.value = message;
  }
}

const isTakeoffLanding = computed(() => altitudeGate.isTransitioning.value);
const isPausedByCollision = computed(() => altitudeGate.isPausedByCollision.value);
const isAutoActive = computed(() => isTakeoffLanding.value && !isPausedByCollision.value);
const collisionPausedMessage = computed(() => {
  if (!isPausedByCollision.value) return '';
  const p = altitudeGate.flightPhase.value;
  if (p === PHASES.ASCENDING) return t('aerialview.obstacle_above');
  if (p === PHASES.DESCENDING) return t('aerialview.obstacle_below');
  return '';
});
const isPreCaching = computed(() => {
  const p = altitudeGate.flightPhase.value;
  return p === PHASES.PRE_TAKEOFF || p === PHASES.PRE_LANDING;
});
// Street View is only used on the 3D Aerial (Google tiles) subpage. On the
// 3D Mesh (OSM Buildings) subpage the drone renders OSM buildings all the way
// from airborne to ground, so no Street View switch-over happens. Loading
// Google Street View there would also spin up a second WebGL context that
// fights the Cesium context (the source of the uniform3fv warnings).
const streetViewEnabled = computed(() => activeSource.value !== 'osm');
const showStreetView = computed(() => streetViewEnabled.value && (drone.alt - altitudeGate.surfaceAlt.value) < ASCEND_THRESHOLD);
const shouldPrewarmSV = computed(() => {
  if (!streetViewEnabled.value) return false;
  const phase = altitudeGate.flightPhase.value;
  if (phase === PHASES.PRE_LANDING || phase === PHASES.DESCENDING) return true;
  return (drone.alt - altitudeGate.surfaceAlt.value) < 20;
});
const isTransitioning = computed(() => {
  const rel = drone.alt - altitudeGate.surfaceAlt.value;
  return rel >= DESCEND_THRESHOLD && rel < ASCEND_THRESHOLD;
});
const streetViewOpacity = computed(() => {
  if (!streetViewEnabled.value) return 0;
  const rel = drone.alt - altitudeGate.surfaceAlt.value;
  if (rel <= DESCEND_THRESHOLD) return 1;
  if (rel >= ASCEND_THRESHOLD) return 0;
  return 1 - (rel - DESCEND_THRESHOLD) / (ASCEND_THRESHOLD - DESCEND_THRESHOLD);
});
// Effective state bound to StreetViewPane: live flight values normally, the
// replayed trajectory while the recorder replays it. Without this the replay
// (and the recorded clip) would stick to the 3D tiles and never reproduce
// the aerial -> street view asset switch.
const svPaneState = computed(() => {
  if (recorderState.value === 'replaying' && replayPov.value) {
    const pov = replayPov.value;
    return {
      lat: pov.lat,
      lon: pov.lon,
      headingRad: pov.headingRad,
      pitchRad: pov.pitchRad,
      relativeAlt: pov.relativeAlt,
      visible: pov.showStreetView,
      opacity: pov.streetViewOpacity,
      transitioning: pov.relativeAlt >= DESCEND_THRESHOLD && pov.relativeAlt < ASCEND_THRESHOLD,
    };
  }
  const pov = getStreetViewPov();
  return {
    lat: drone.lat,
    lon: drone.lon,
    headingRad: pov.headingRad,
    pitchRad: pov.pitchRad,
    relativeAlt: pov.relativeAlt,
    visible: showStreetView.value,
    opacity: streetViewOpacity.value,
    transitioning: isTransitioning.value,
  };
});
const takeoffLandingLabel = computed(() => {
  const p = altitudeGate.flightPhase.value;
  if (p === PHASES.PRE_TAKEOFF) return t('aerialview.preparing_takeoff');
  if (p === PHASES.PRE_LANDING) return t('aerialview.scanning_landing');
  if (p === PHASES.ASCENDING) return t('aerialview.taking_off');
  if (p === PHASES.DESCENDING) return t('aerialview.landing_in_progress');
  return altitudeGate.isOnGround.value ? t('aerialview.takeoff') : t('aerialview.landing');
});

// ── Takeoff / Stop / Landing switcher ──
// The dock button is a 3-state switcher cycled ENTIRELY by the user:
//   takeoff -> stop -> landing -> stop -> takeoff -> ...
// It never judges whether the drone is on the ground or airborne:
// - 'takeoff' starts the auto takeoff sequence (climb to takeoffAltitude);
// - 'landing' starts the auto landing sequence (descend to the surface);
// - 'stop' aborts an in-progress sequence and holds the current altitude
//   (inside the bottom ground band the ground clamp settles the drone onto
//   the surface, so a low-altitude stop behaves like an early landing).
// The button stays ENABLED during takeoff/landing so the sequence can be
// interrupted mid-flight; the other buttons keep their original locking.
const SWITCH_SEQUENCE = ['takeoff', 'stop', 'landing', 'stop'];
const switchIndex = ref(0); // index of the action the button currently offers

function syncTakeoffSwitchItem() {
  const item = rightItems.find((i) => i.id === 'takeoff');
  if (!item) return;
  const action = SWITCH_SEQUENCE[switchIndex.value];
  item.icon = action === 'takeoff' ? 'MENU_TAKEOFF'
    : action === 'landing' ? 'MENU_LANDING'
    : 'MENU_STOP';
  item.titleKey = `aerialview.${action}`;
}

function toggleTakeoffLanding() {
  const viewer = window.cesiumViewer;
  const action = SWITCH_SEQUENCE[switchIndex.value];
  if (action === 'takeoff') {
    // startTakeoff returns false when the drone is already above the takeoff
    // altitude (settings.takeoffAltitude, default 100 m): no sequence starts,
    // the user just gets the green reminder below.
    //
    // The takeoff tile pre-warm teleports the Cesium camera to the target
    // altitude for a few frames. Only allow that while the Street View
    // overlay fully covers the (still rendering) Cesium canvas — mirrored
    // from the .cesium-hidden watcher below — otherwise the teleport shows
    // up as a visible tremble.
    const cesiumCovered = svPaneState.value.visible && !svPaneState.value.transitioning && streetViewReady.value;
    if (!altitudeGate.startTakeoff(viewer, { cameraPrewarm: cesiumCovered })) {
      flashTakeoffLimitNotice();
    }
  } else if (action === 'landing') {
    altitudeGate.startLanding(viewer);
  } else {
    altitudeGate.stopAuto();
  }
  switchIndex.value = (switchIndex.value + 1) % SWITCH_SEQUENCE.length;
  syncTakeoffSwitchItem();
}

// Green top-center reminder: 'takeoff' was clicked while the drone is already
// beyond the takeoff altitude. Auto-hides after a few seconds.
const takeoffLimitNotice = ref('');
let takeoffLimitTimer = null;
function flashTakeoffLimitNotice() {
  takeoffLimitNotice.value = t('aerialview.takeoff_above_limit', { alt: settings.takeoffAltitude });
  clearTimeout(takeoffLimitTimer);
  takeoffLimitTimer = setTimeout(() => { takeoffLimitNotice.value = ''; }, 5000);
}

// Steer has two jobs:
// - on the 2D street map it lifts the view to the Google Earth 3D tiles
//   NADIR overview of the SAME spot and ground scale (the red selection
//   balloon is a 2D-map-only overlay, so the 3D view has none);
// - in the 3D view it shows (or hides) the Flight and the Camera (gimbal)
//   disks together — the old separate Camera button is gone.
function toggleSteer() {
  if (isStreet.value) {
    if (mapMoved()) {
      // The map was panned / zoomed / re-picked while in street mode: the
      // lift re-matches the map. The 2D map height is Google's nominal model
      // altitude; convert it to the true camera altitude that shows the SAME
      // ground scale in the 3D nadir view (otherwise the 3D view looks ~4-6x
      // more zoomed in).
      drone.alt = routeScene.trueAltForMapScale(mapAlt.value, drone.lat);
      drone.heading = 0;
      gimbal.yaw = 0;
      gimbal.pitch = -90; // look straight down, satellite style
      gimbal.roll = 0;
    }
    // Untouched map: the 3D pose (altitude / heading / gimbal) was never
    // invalidated, so the lift restores the exact view left behind.
    knownMap = null;
    viewCtx.subView = 'steer';
    return;
  }
  const next = !showFlight.value;
  // First Steer press of an armed deep link: launch the waypoint flight —
  // the disks appear and the journey runs from the first waypoint to the
  // last (grabbing a disk mid-flight takes that domain over per-frame).
  if (next && playArmed.value && !playLaunched.value) {
    playLaunched.value = true;
    autopilot.launch();
  }
  showFlight.value = next;
  showCamera.value = next;
}

watch(
  [() => svPaneState.value.visible, () => svPaneState.value.transitioning, streetViewReady, isStreet],
  ([show, transitioning, svReady, street]) => {
    const viewer = window.cesiumViewer;
    if (viewer) {
      // In mesh (OSM) mode the globe must stay visible as ground context; in
      // aerial (Google) mode it is only shown during the street-view
      // transition crossfade. The 2D street map always covers the globe.
      viewer.scene.globe.show = (activeSource.value === 'osm' || (show && transitioning)) && !street;
    }
    if (cesiumContainer.value) {
      // Only hide Cesium when Street View is fully loaded to prevent black flash
      cesiumContainer.value.classList.toggle('cesium-hidden', street || (show && !transitioning && svReady));
    }
  },
  { immediate: true }
);

function getFlightCommandSpeed() {
  if (activeFlightMode.value === 'M') {
    const cmdMag = Math.hypot(flightCmd.vx, flightCmd.vy);
    return cmdMag * 0.0002 * 111320;
  }
  if (activeFlightMode.value === 'H') {
    return Math.abs(flightCmd.vz) * 20.0;
  }
  return 0;
}

function getFlightCommandDirection() {
  const viewer = window.cesiumViewer;
  if (!viewer) return null;

  const position = Cesium.Cartesian3.fromDegrees(drone.lon, drone.lat, drone.alt);
  const enuTransform = Cesium.Transforms.eastNorthUpToFixedFrame(position);

  if (activeFlightMode.value === 'M') {
    const mag = Math.hypot(flightCmd.vx, flightCmd.vy) || 1;
    const headingRad = Cesium.Math.toRadians(drone.heading);
    const enuDir = new Cesium.Cartesian3(
      (flightCmd.vy * Math.sin(headingRad) + flightCmd.vx * Math.cos(headingRad)) / mag,
      (flightCmd.vy * Math.cos(headingRad) - flightCmd.vx * Math.sin(headingRad)) / mag,
      0
    );
    const worldDir = Cesium.Matrix4.multiplyByPointAsVector(enuTransform, enuDir, new Cesium.Cartesian3());
    return Cesium.Cartesian3.normalize(worldDir, worldDir);
  }

  if (activeFlightMode.value === 'H') {
    const enuUp = new Cesium.Cartesian3(0, 0, flightCmd.vz >= 0 ? 1 : -1);
    const worldDir = Cesium.Matrix4.multiplyByPointAsVector(enuTransform, enuUp, new Cesium.Cartesian3());
    return Cesium.Cartesian3.normalize(worldDir, worldDir);
  }

  return null;
}

function checkCollisionAhead() {
  const viewer = window.cesiumViewer;
  const tileset = getActiveTileset();
  if (!viewer || !tileset || !showFlight.value) return null;

  const speed = getFlightCommandSpeed();
  if (speed <= 0) return null;

  const direction = getFlightCommandDirection();
  if (!direction) return null;

  const position = Cesium.Cartesian3.fromDegrees(drone.lon, drone.lat, drone.alt);
  const ray = new Cesium.Ray(position, direction);
  let result = null;
  try {
    result = viewer.scene.pickFromRay(ray);
  } catch {
    return null; // transient raycast failure while tiles stream — skip this frame
  }

  if (!result || !result.position) return null;

  const hitObject = result.object;
  const isTilesetHit =
    hitObject === tileset ||
    (hitObject && hitObject.tileset === tileset) ||
    (hitObject && hitObject.primitive === tileset);
  if (!isTilesetHit) return null;

  const distance = Cesium.Cartesian3.distance(position, result.position);
  const buffer = MIN_SAFETY_BUFFER + speed * LOOK_AHEAD_TIME;
  if (distance > buffer) return null;

  const normal = Cesium.Cartesian3.normalize(
    Cesium.Cartesian3.subtract(position, result.position, new Cesium.Cartesian3()),
    new Cesium.Cartesian3()
  );

  return { distance, position: result.position, normal };
}

function projectEnuMove(enuMove, collision) {
  const position = Cesium.Cartesian3.fromDegrees(drone.lon, drone.lat, drone.alt);
  const enuTransform = Cesium.Transforms.eastNorthUpToFixedFrame(position);
  const invTransform = Cesium.Matrix4.inverse(enuTransform, new Cesium.Matrix4());
  const enuNormal = Cesium.Matrix4.multiplyByPointAsVector(invTransform, collision.normal, new Cesium.Cartesian3());
  Cesium.Cartesian3.normalize(enuNormal, enuNormal);

  const dot = Cesium.Cartesian3.dot(enuMove, enuNormal);
  if (dot >= 0) return enuMove;

  const normalComponent = Cesium.Cartesian3.multiplyByScalar(enuNormal, dot, new Cesium.Cartesian3());
  return Cesium.Cartesian3.subtract(enuMove, normalComponent, new Cesium.Cartesian3());
}

function syncCesiumCamera() {
  if (typeof window.updateCesiumCamera !== 'function') return;
  if (isStreet.value) {
    // While the 2D street map covers the globe, the hidden (still
    // rendering, opacity 0) Cesium canvas mirrors the map as a nadir view
    // at the same ground scale: the Google 3D tiles of the visible area
    // stream in the background, so the Steer lift to 3D is instant.
    window.updateCesiumCamera({
      lat: drone.lat,
      lon: drone.lon,
      alt: routeScene.trueAltForMapScale(mapAlt.value, drone.lat),
      heading: 0,
      gimbalYaw: 0,
      gimbalPitch: -90,
      gimbalRoll: 0,
    });
    return;
  }
  window.updateCesiumCamera({
    lat: drone.lat,
    lon: drone.lon,
    alt: drone.alt,
    heading: drone.heading,
    gimbalYaw: gimbal.yaw,
    gimbalPitch: gimbal.pitch,
    gimbalRoll: gimbal.roll,
  });
}

function getStreetViewPov() {
  const headingRad = ((drone.heading + gimbal.yaw) * Math.PI) / 180;
  const pitchRad = (gimbal.pitch * Math.PI) / 180;
  const relativeAlt = Math.max(0, drone.alt - altitudeGate.surfaceAlt.value);
  return { headingRad, pitchRad, relativeAlt };
}

let rafId = null;

function updateDroneState() {
  const dt = 1 / 60;
  const viewer = window.cesiumViewer;

  altitudeGate.update(viewer);

  if (isTakeoffLanding.value) {
    altitudeGate.stepAuto(dt, viewer);
    // During collision pause, allow manual flight/camera so user can reposition.
    // Only block manual input when the auto sequence is actively moving.
    if (!isPausedByCollision.value) {
      onFlightStop();
      onCameraStop();
      return;
    }
  }

  const allowAltitude = !altitudeGate.isOnGround.value || activeFlightMode.value === 'H';
  let enuMove = null;

  if (showFlight.value) {
    // Play-link autopilot: with the Flight stick / keys released the drone
    // flies on toward the next waypoint; any manual input takes over the
    // flight domain for that frame (same movement + collision path).
    if (autopilot.active.value && autopilot.flightIdle()) {
      enuMove = autopilot.stepFlight(dt);
    } else {
      enuMove = computeDesiredEnuMove(dt, allowAltitude);
    }
  }

  const collision = checkCollisionAhead();
  if (collision && enuMove) {
    enuMove = projectEnuMove(enuMove, collision);
    isCollisionFrozen.value = true;
    collisionSurfaceNormal.value = collision.normal;
  } else {
    isCollisionFrozen.value = false;
    collisionSurfaceNormal.value = null;
  }

  if (showFlight.value) {
    applyEnuMove(enuMove);
    updateFlightTelemetry(allowAltitude);
    // R-mode: rotate drone heading (3D view rotates accordingly)
    if (activeFlightMode.value === 'R') {
      drone.heading += flightCmd.yaw * 60.0 * dt;
    }
  }

  if (altitudeGate.isOnGround.value) {
    if (activeFlightMode.value === 'M') {
      // M-mode: clamp to ground, no vertical movement allowed
      altitudeGate.snapToGround();
      flightCmd.vz = 0;
    } else if (activeFlightMode.value === 'R') {
      // R-mode: allow rotation, clamp altitude to ground
      altitudeGate.snapToGround();
      flightCmd.vz = 0;
    }
    // H-mode: no ground clamp — user controls altitude freely
  }

  if (showCamera.value) {
    stepCameraPhysics(dt, { applyMovement: true });
    // Released Gimbal stick / keys during play: ease the camera back to the
    // target waypoint's saved angles (cinematic playback of the route).
    if (autopilot.active.value && autopilot.cameraIdle()) {
      autopilot.stepGimbal(dt);
    }
  }
}

let loopErrorLogTs = 0;

function loop() {
  // A single bad frame (e.g., a Cesium raycast failing while tiles stream)
  // must never kill the loop: if it stops, the scene freezes and the disks
  // appear dead. Log throttled and keep animating.
  try {
    if (recorderState.value === 'recording') {
      sampleFrame(drone, gimbal, altitudeGate.surfaceAlt.value);
    }
    // During replay the replay engine owns the Cesium camera; skip the flight
    // physics, collision checks and camera sync so they cannot fight it.
    if (recorderState.value !== 'replaying') {
      updateDroneState();
      syncCesiumCamera();
    }
  } catch (err) {
    const now = performance.now();
    if (now - loopErrorLogTs > 2000) {
      loopErrorLogTs = now;
      console.error('[AerialView] Frame error (loop continues):', err);
    }
  }
  rafId = requestAnimationFrame(loop);
}

onMounted(() => {
  cesiumContainer.value = document.getElementById('cesiumContainer');
  startFlightKeyboard();
  startCameraKeyboard();
  syncCesiumCamera();
  // Mounted already in street mode (restored sub-view): remember the map
  // state so an untouched lift back to Steer restores the 3D pose.
  if (isStreet.value) snapshotMap();

  // /play?r=… deep link: arm the route autopilot (no-op without the query).
  applyPlayQuery();

  // Initial connection check and periodic re-check.
  checkGoogleConnection();
  checkCesiumConnection();
  connectionCheckInterval = setInterval(() => {
    checkGoogleConnection();
    checkCesiumConnection();
  }, 10000);

  registerRight({
    id: 'reset',
    icon: 'MENU_RESET',
    titleKey: 'aerialview.reset',
    active: showSearchPanel,
    onClick: onClickReset,
  });
  registerRight({
    id: 'steer',
    icon: 'MENU_CONTROL_STICK',
    titleKey: 'aerialview.steer',
    active: showFlight.value,
    onClick: toggleSteer,
  });
  registerRight({
    id: 'screenshot',
    icon: 'MENU_PHOTO',
    titleKey: 'aerialview.screenshot',
    onClick: guardedScreenshot,
  });
  registerRight({
    id: 'recorder',
    icon: 'MENU_RECORDER',
    titleKey: 'aerialview.recorder',
    active: isRecorderActive,
    danger: true,
    onClick: guardedToggleRecorder,
  });

  // Sync dock button active states with toggle state
  watch(showFlight, (val) => {
    const item = rightItems.find((i) => i.id === 'steer');
    if (item) item.active = val;
  });
  // React to recorder state transitions: update the dock button title, and
  // close the Flight/Gimbal disks during replay (restored when it ends).
  watch(recorderState, (state, prev) => {
    const item = rightItems.find((i) => i.id === 'recorder');
    if (item) {
      item.titleKey =
        state === 'recording' ? 'aerialview.recorder_stop'
        : state === 'replaying' ? 'aerialview.recorder_cancel'
        : 'aerialview.recorder';
    }
    // Lock the 3D Aerial / 3D Mesh source switch and the Screenshot button
    // while the recorder is active: swapping the 3D data source mid-recording
    // would corrupt the aerial/street-view asset tracking of the clip, and a
    // screenshot during capture is redundant.
    const assetLocked = state !== 'idle';
    for (const list of [rightItems]) {
      for (const dockItem of list) {
        if (dockItem.id === 'screenshot') {
          dockItem.disabled = assetLocked;
        }
      }
    }
    if (state === 'replaying' && prev === 'recording') {
      savedDiskVisibility = { flight: showFlight.value, camera: showCamera.value };
      showFlight.value = false;
      showCamera.value = false;
    } else if (state === 'idle' && prev === 'replaying' && savedDiskVisibility) {
      showFlight.value = savedDiskVisibility.flight;
      showCamera.value = savedDiskVisibility.camera;
      savedDiskVisibility = null;
    }
  });

  // Disable non-navigation dock buttons during takeoff/landing transitions —
  // EXCEPT the takeoff/stop/landing switcher itself, which must stay clickable
  // so the user can interrupt the sequence mid-flight (its whole purpose).
  // During a collision pause the other buttons unlock so the user can
  // reposition. Pages (router) and Chat buttons remain enabled so the user
  // can navigate away.
  watch([isTakeoffLanding, isPausedByCollision], ([transitioning, paused]) => {
    const lockableIds = ['steer', 'recorder'];
    for (const list of [rightItems]) {
      for (const item of list) {
        if (lockableIds.includes(item.id)) {
          item.disabled = transitioning && !paused;
        }
      }
    }
  });

  rafId = requestAnimationFrame(loop);
});

onUnmounted(() => {
  stopPlay();
  stopPlayLoading();
  resetRecorder();
  stopFlightKeyboard();
  stopCameraKeyboard();
  if (rafId) cancelAnimationFrame(rafId);
  if (connectionCheckInterval) clearInterval(connectionCheckInterval);
  clear();
});
</script>

<template>
  <ViewComposer
    :right-items="rightItems"
    :show-flight="showFlight && !isStreet"
    :show-camera="showCamera && !isStreet"
    :show-hud="recorderState !== 'replaying'"
    :flight="flight"
    :camera="camera"
        :disabled="isAutoActive"
    @flightMove="onFlightMove"
    @flightStop="onFlightStop"
    @flightModeChange="onFlightModeChange"
    @cameraMove="onCameraMove"
    @cameraStop="onCameraStop"
    @cameraModeChange="onCameraModeChange"
  >
    <template #background>
      <!-- Google 2D street map background: shown while the page is in
           'street' mode, entered via Search / Route. Stays mounted across
           Search <-> Route switches so center / zoom / the red selection
           balloon are preserved. -->
      <MapView
        v-if="isStreet"
        ref="mapViewRef"
        class="view-composer__background aerial-street-map"
        :map-type-id="mapTypeId"
        :lat="drone.lat"
        :lon="drone.lon"
        :alt="mapAlt"
        :heading="drone.heading"
        :is-picking="false"
        :show-drone-marker="false"
        :waypoints-editable="false"
        @mapReady="onMapReady"
        @centerChange="onMapCenterChange"
        @zoomChange="onMapZoomChange"
        @poisFound="onPoisFound"
        @poisError="onPoisError"
      />
      <StreetViewPane
        class="view-composer__background"
        :lat="svPaneState.lat"
        :lon="svPaneState.lon"
        :heading="svPaneState.headingRad"
        :pitch="svPaneState.pitchRad"
        :altitude="svPaneState.relativeAlt"
        :visible="svPaneState.visible && !isStreet"
        :prewarm="shouldPrewarmSV"
        :style="{ opacity: svPaneState.opacity }"
        @ready="streetViewReady = true"
      />
    </template>

    <template #top-overlay>
      <ConnectionError :visible="showConnectionError" :message="connectionMessage" />

      <!-- /play deep-link progress: Google Earth 3D tiles streaming in -->
      <div v-if="playLoading" class="play-load-mask">
        <div class="play-load-box">
          <div class="play-load-text">{{ t('aerialview.loading_assets') }}</div>
          <div class="play-load-track">
            <div class="play-load-fill" :style="{ width: `${Math.round(playLoadPct * 100)}%` }"></div>
          </div>
          <div class="play-load-pct">{{ Math.round(playLoadPct * 100) }}%</div>
        </div>
      </div>

      <!-- Address search panel (same workflow as Route Planning), hosting
           the route-aware Replay / Restart actions around the search bar. -->
      <div v-if="showSearchPanel && isStreet" class="search-panel">
        <template v-if="hasRoute">
          <button class="search-panel__action" type="button" @click="onClickReplay">
            {{ t('aerialview.replay') }}
          </button>
          <div class="search-panel__divider"></div>
        </template>
        <form class="search-panel__row" @submit.prevent="onSearchSubmit">
          <input
            v-model="searchQuery"
            class="search-panel__input"
            type="text"
            :placeholder="t('aerialview.search_placeholder')"
          />
          <button
            class="search-panel__btn"
            type="submit"
            :title="t('aerialview.search')"
          >
            <ConfigurableIcon name="MENU_SEARCH" :size="18" color="rgba(30, 40, 60, 0.9)" />
          </button>
        </form>
        <ul v-if="searchResults.length" class="search-panel__list">
          <li
            v-for="(poi, idx) in searchResults"
            :key="poi.place_id || idx"
            class="search-panel__item"
            @click="onResultClick(poi)"
          >
            <span class="search-panel__name">{{ poi.name }}</span>
            <span v-if="poi.address" class="search-panel__address">{{ poi.address }}</span>
          </li>
        </ul>
        <div v-else-if="searchError" class="search-panel__error">{{ searchError }}</div>
        <div v-else-if="hasSearched && !searchBusy" class="search-panel__empty">
          {{ t('aerialview.no_results') }}
        </div>
        <button class="search-panel__action" type="button" @click="onClickRestart">
          {{ t('aerialview.restart') }}
        </button>
      </div>
      <CollisionWarning :visible="isCollisionFrozen" />
      <!-- Reminders / warnings live in the shell top bar (centered). -->
      <Teleport to="#shell-notices">
        <div v-if="collisionPausedMessage" class="shell-notice shell-notice--warning">
          {{ collisionPausedMessage }}
        </div>
        <div v-if="lockedMessage" class="shell-notice shell-notice--warning">
          {{ lockedMessage }}
        </div>
        <div v-if="takeoffLimitNotice" class="shell-notice">
          {{ takeoffLimitNotice }}
        </div>
        <div v-if="isPreCaching" class="shell-notice">
          {{ takeoffLandingLabel }}
        </div>
        <div v-if="recorderState === 'replaying'" class="shell-notice">
          {{ t('aerialview.replaying', { pct: Math.round(replayProgress * 100) }) }}
        </div>
        <div v-if="captureAuthNotice" class="shell-notice">
          {{ t(`aerialview.auth_notice_${captureAuthNotice}`) }}
        </div>
        <!-- Deep link armed + tiles ready: remind the user to start the
             journey with the Steer button (blue reminder, top bar). -->
        <div v-if="showPlayReady" class="shell-notice">
          {{ t('aerialview.play_ready') }}
        </div>
      </Teleport>
    </template>
  </ViewComposer>
</template>

<style scoped>
/* /play deep-link tile-loading progress overlay */
.play-load-mask {
  position: absolute;
  inset: 0;
  z-index: 40;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.35);
  pointer-events: none;
}
.play-load-box {
  min-width: 300px;
  max-width: 420px;
  padding: 18px 22px;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.92);
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.35);
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.play-load-text {
  font-size: 13px;
  color: #1c1c1e;
}
.play-load-track {
  height: 6px;
  border-radius: 3px;
  background: rgba(0, 0, 0, 0.12);
  overflow: hidden;
}
.play-load-fill {
  height: 100%;
  border-radius: 3px;
  background: #007aff;
  transition: width 0.15s linear;
}
.play-load-pct {
  font-size: 12px;
  color: #6e6e73;
  text-align: right;
}

:deep(.view-composer__background) {
  position: fixed;
  inset: 0;
  z-index: 0;
  pointer-events: none;
}

:deep(.view-composer__background.street-view-pane--visible) {
  pointer-events: auto;
}

/* The 2D street map must receive its pan / zoom gestures. */
:deep(.view-composer__background.aerial-street-map) {
  pointer-events: auto;
}

/* Address search panel — same frosted card as Route Planning. */
.search-panel {
  position: fixed;
  top: 50%;
  right: 112px;
  transform: translateY(-50%);
  width: min(480px, 90vw);
  max-height: 70vh;
  display: flex;
  flex-direction: column;
  gap: 12px;
  border-radius: 18px;
  background: rgba(255, 255, 255, 0.18);
  backdrop-filter: blur(6px);
  border: 2px solid rgba(255, 255, 255, 0.45);
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.2), inset 0 0 20px rgba(255, 255, 255, 0.08);
  z-index: 50;
  padding: 16px 20px;
  box-sizing: border-box;
}

.search-panel__row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.search-panel__input {
  flex: 1;
  min-width: 0;
  padding: 8px 12px;
  border: 1px solid rgba(255, 255, 255, 0.7);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.85);
  color: rgba(30, 40, 60, 0.95);
  font-size: 0.9rem;
  outline: none;
}

.search-panel__input::placeholder {
  color: rgba(30, 40, 60, 0.45);
}

.search-panel__btn {
  flex-shrink: 0;
  width: 34px;
  height: 34px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid rgba(255, 255, 255, 0.7);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.55);
  cursor: pointer;
  transition: background 0.15s ease;
}

.search-panel__btn:hover {
  background: rgba(255, 255, 255, 0.75);
}

/* Full-width route-aware actions (Replay / Restart) in the search popup:
   same blue fill / white font as the Plaza "Explore the scene in 3D"
   button (gcard__explore). */
.search-panel__action {
  width: 100%;
  padding: 9px 12px;
  border: none;
  border-radius: 8px;
  background: #007aff;
  color: #ffffff;
  font-size: 0.95rem;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s ease;
}

.search-panel__action:hover {
  background: #0066d6;
}

/* Static (not draggable) separator below Replay. */
.search-panel__divider {
  height: 1px;
  background: rgba(255, 255, 255, 0.55);
}

.search-panel__list {
  list-style: none;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.search-panel__item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 10px;
  border-radius: 8px;
  cursor: pointer;
  transition: background 0.15s ease;
}

.search-panel__item:hover {
  background: rgba(255, 255, 255, 0.35);
}

.search-panel__name {
  font-size: 0.9rem;
  font-weight: 600;
  color: rgba(30, 40, 60, 0.95);
  text-shadow: 0 1px 2px rgba(255, 255, 255, 0.5);
}

.search-panel__address {
  font-size: 0.78rem;
  color: rgba(30, 40, 60, 0.7);
}

.search-panel__error,
.search-panel__empty {
  font-size: 0.85rem;
  color: rgba(160, 40, 50, 0.9);
  background: rgba(255, 235, 235, 0.6);
  border: 1px solid rgba(200, 80, 90, 0.4);
  border-radius: 8px;
  padding: 8px 10px;
}

.search-panel__empty {
  color: rgba(30, 40, 60, 0.75);
  background: rgba(255, 255, 255, 0.4);
  border-color: rgba(255, 255, 255, 0.6);
}

@media (max-width: 768px) {
  .search-panel {
    right: 96px;
  }
}
</style>
