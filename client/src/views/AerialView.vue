<script setup>
import { ref, reactive, computed, onMounted, onUnmounted, watch, toRef } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter, useRoute } from 'vue-router';
import ViewComposer from '@shared/_ViewComposer.vue';
import CollisionWarning from '@shared/CollisionWarning.vue';
import { MapView } from '@/2d_map/index.js';
import ConfigurableIcon from '@shared/ConfigurableIcon.vue';
import { useRouteScene3D } from '@shared-composables/useRouteScene3D.js';
import { useRouteAutopilot } from '@shared-composables/useRouteAutopilot.js';
import { useSteerFreezePen } from '@shared-composables/useSteerFreezePen.js';
import { useRoutes } from '@shared-composables/useRoutes.js';
import { useVideos } from '@shared-composables/useVideos.js';
import { useDrone } from '@shared-composables/useDrone.js';
import { useFleet } from '@shared-composables/useFleet.js';
import { mateById } from '@shared-composables/useTeamRoster.js';
import { useSessionState } from '@shared-composables/useSessionState.js';
import { useAltitudeGate, PHASES } from '@shared-composables/useAltitudeGate.js';
import { useFlightCommands } from '@shared-composables/useFlightCommands.js';
import { useCameraCommands } from '@shared-composables/useCameraCommands.js';
import { useFlightPhysics } from '@shared-composables/useFlightPhysics.js';
import { useCameraPhysics } from '@shared-composables/useCameraPhysics.js';
import { useDockRegistry } from '@shared-composables/useDockRegistry.js';
import { useTilesetSource } from '@shared-composables/useTilesetSource.js';
import { useScreenCapture } from '@shared-composables/useScreenCapture.js';
import { useAppSettings } from '@shared-composables/useAppSettings.js';
import { useConnectionStatus, checkGoogleConnection, checkCesiumConnection } from '@shared-composables/useConnectionStatus.js';
import ConnectionError from '@shared/ConnectionError.vue';
import SplashOverlay from '@shared/SplashOverlay.vue';
import { PALISADES_FIRE, PLAN_VIEW_ALT } from '@/config/palisadesFire.js';
import { useAgentScene } from '@/composables/useAgentScene.js';
import { getGameIntro } from '@/config/gameIntro.js';

const { t, locale } = useI18n();

const router = useRouter();
const route = useRoute();

// Per-game intro briefing overlay: plays over the main panel on entry, then
// dismisses itself (see SplashOverlay). Confined to .shell-main, so the top
// bar, left nav, and right assistant stay visible around it.
const intro = computed(() => getGameIntro(locale.value));
const showIntro = ref(true);
function onIntroDismissed() {
  showIntro.value = false;
}

const { drone, gimbal } = useDrone();
// The machine fleet (drone + tank) and which of them the Steer FPV follows.
// Test phase: both assets are auto-driven along hardcoded routes near the
// fire zone by stepFleet() below; the active-asset pick is wired to the chat
// Team popover and the Plan view's map badges.
const { FLEET, activeAsset, activeAssetId, activeIsDrone, setActiveAsset, stepFleet, getTankSurface, chaseCameraPose, syncFleetModels } = useFleet();
const { session } = useSessionState();
// Altitude split: the 2D street-map zoom height (mapAlt) is a SEPARATE value
// from the true drone/camera altitude (drone.alt). They are reconciled only
// at the 3D<->2D boundary (see toggleSteer). mapAlt belongs to the Search /
// Route street map, which deliberately mirrors the drone so that round trip is
// lossless — it is NOT the Plan view's camera (see planCam below).
const mapAlt = toRef(session.view, 'mapAlt');

// ── The Plan view owns its OWN map camera ───────────────────────────────────
// Plan is the EOC's static briefing map of the disaster zone: a picture of the
// incident, not a machine in the front zone, so its (lat, lon, alt) must be
// COMPLETELY separate from the drone's. It used to share drone.lat/lon +
// mapAlt, which meant every Plan click teleported the drone to the Palisades
// centre and the next Steer click "reconciled" drone.alt from PLAN_VIEW_ALT
// (5200 m of Google model height) into a ~25 km true nadir altitude with the
// gimbal pinned at -90°. From up there globe.show is false and the Google
// tileset can only offer its coarsest LOD, so Steer rendered as a flat
// satellite map — or as nothing at all (black) while those tiles streamed.
const planCam = reactive({
  lat: PALISADES_FIRE.center.lat,
  lon: PALISADES_FIRE.center.lng,
  alt: PLAN_VIEW_ALT,
});

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

const { applyEnuMove, updateTelemetry: updateFlightTelemetry } = useFlightPhysics();
const { step: stepCameraPhysics } = useCameraPhysics();
const { rightItems, registerRight, clear } = useDockRegistry();
const { recorderState, replayProgress, sampleFrame, resetRecorder } = useScreenCapture();
const { settings } = useAppSettings();

let savedDiskVisibility = null;

const isCollisionFrozen = ref(false);
const collisionSurfaceNormal = ref(null);
// Closest the drone may come to a hit surface, in metres. The collision
// look-ahead is a FIXED clearance (MIN_SAFETY_BUFFER + settings.safetyBuffer),
// NOT speed x time: the old `speed * LOOK_AHEAD_TIME` term reached 122 m in H
// and 136-191 m in M at full stick while the drone only travels ~1 m per frame,
// so the ground sat permanently inside the buffer (settings.takeoffAltitude is
// 100 m) and every M/H move was cancelled outright. Speed scaling also buys
// nothing now that resolveCollisionMove() clamps to the MEASURED clearance,
// which makes tunnelling impossible at any speed.
const MIN_SAFETY_BUFFER = 2.0; // meters

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
const isPlanView = computed(() => viewCtx.subView === 'plan');
const isSteerView = computed(() => viewCtx.subView === 'steer');
// Which camera drives the 2D map: Plan drives it from its own planCam; every
// other street sub-view (Search / Route) mirrors the drone, so picking an
// address there and lifting to 3D still lands on the same spot at the same
// ground scale.
const mapCamLat = computed(() => (isPlanView.value ? planCam.lat : drone.lat));
const mapCamLon = computed(() => (isPlanView.value ? planCam.lon : drone.lon));
const mapCamAlt = computed(() => (isPlanView.value ? planCam.alt : mapAlt.value));
// The pencil toolbox lives on both drawing surfaces: the 2D Plan map and the
// 3D Steer globe (each with its own pen engine and its own mark set).
const penViews = computed(() => isPlanView.value || isSteerView.value);
// Plan view base layer: 'terrain' (Google street + terrain, the default)
// cycles to 'satellite' on the second Plan click.
const planLayer = ref('terrain');
const mapTypeId = computed(() => (isPlanView.value ? planLayer.value : 'roadmap'));
// The LA early-2025 wildfire disaster zone polygon. It is HIDDEN GAME STATE:
// players never see the boundary (the demo-wildfire package environment owns
// the perimeter for the sim + loss check only). The red debug outline renders
// solely with the developer flag ?fireZone=1 (alongside ?agentDemo=1).
const showFireZone = new URLSearchParams(window.location.search).has('fireZone');
const planPolygons = computed(() =>
  isPlanView.value && showFireZone
    ? [
        {
          id: 'palisades-fire',
          path: PALISADES_FIRE.perimeter,
          strokeColor: '#ff3b30',
          strokeWeight: 2,
          fillColor: '#ff3b30',
          fillOpacity: 0.22,
        },
      ]
    : []
);

// ── /play?r=<16-char route id> shareable play link ───────────────────────
// A shared copy of the URL lands here: fetch the route publicly, seed the
// session route domain (the 2D Route view then shows its read-only dots) and
// hand the drone to the waypoint autopilot. The 3D waypoint overlay (blue
// dots + spline) is NOT drawn here — the play view keeps a clean cinematic
// scene. ?v=<16-char video id> is the fallback for a published video whose
// source route was deleted (the frozen waypoint snapshot rides on the video
// row).
//
// Nothing in the app mints these links any more — the Plaza's video cards and
// their "Explore the Scene in 3D" button are gone. The handling stays because
// a link already out in the wild must keep working.
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
// E6.9: the GENERIC agent-paradigm host relay (?agentDemo=1). Package-agnostic:
// it spawns the core worker, relays agents.state/event/world into the L2 scene
// model and attaches the four render primitives (2D map + 3D Cesium viewer).
const agentScene = useAgentScene();
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

// ── Lossless 2D<->3D round trips (Search / Route street map only) ───────────
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

// Panning / zooming the 2D map moves whichever camera OWNS it: the Plan
// briefing map moves planCam and leaves the drone exactly where it is.
function onMapCenterChange({ lat, lng }) {
  if (isPlanView.value) {
    planCam.lat = lat;
    planCam.lon = lng;
    return;
  }
  drone.lat = lat;
  drone.lon = lng;
}

function onMapZoomChange(alt) {
  const clamped = Math.max(0, Math.min(100000, alt));
  if (isPlanView.value) planCam.alt = clamped;
  else mapAlt.value = clamped;
}

// The Google Map is recreated whenever we return from the 3D view; re-apply
// the picked-address balloon if we are back on the Search view, and the
// read-only route illustration if we are back on the Route view.
function onMapReady() {
  // A Plan entry while the map was still mounting parks its camera target
  // here (the acquire used the old drone position).
  if (planPendingCenter) {
    planPendingCenter = false;
    mapViewRef.value?.panTo(PALISADES_FIRE.center.lat, PALISADES_FIRE.center.lng, PLAN_VIEW_ALT);
  }
  if (isStreet.value && showSearchPanel.value && selectedLatLng.value) {
    mapViewRef.value?.setSelectionMarker(selectedLatLng.value.lat, selectedLatLng.value.lng);
  }
  if (routeActive.value) redrawRouteMarkers();
  if (showLivePos.value) mapViewRef.value?.setLivePosition(drone.lat, drone.lon);
  // No-op unless ?agentDemo=1; the generic agent overlay set re-attaches when the
  // map instance changes (Plan <-> Steer round trips recreate the Google map). The
  // Cesium viewer is a page-lifetime singleton, handed over for the 3D overlays.
  agentScene.start(
    () => mapViewRef.value?.getGoogleMap?.() ?? null,
    () => window.cesiumViewer || null
  );
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
    // altitude for a few frames. Only allow that while the 2D street map
    // fully covers the (still rendering) Cesium canvas — mirrored from the
    // .cesium-hidden watcher below — otherwise the teleport shows up as a
    // visible tremble.
    const cesiumCovered = isStreet.value;
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

// Steer has three jobs, one per view it can be pressed from:
// - on the Plan briefing map it just switches back to 3D: that map has its
//   own camera, so the drone is left completely alone;
// - on the Search / Route street map it lifts the view to the Google Earth 3D
//   tiles NADIR overview of the SAME spot and ground scale (the red selection
//   balloon is a 2D-map-only overlay, so the 3D view has none);
// - in the 3D view it shows (or hides) the Flight and the Camera (gimbal)
//   disks together — the old separate Camera button is gone.
function toggleSteer() {
  if (isStreet.value) {
    // Leaving the Plan view must NOT touch the drone. Plan is the EOC's own
    // briefing map with its own camera, so Steer simply resumes the flight
    // where it was left — position, altitude, heading and gimbal all intact,
    // no scale reconciliation and no nadir re-framing.
    if (isPlanView.value) {
      viewCtx.subView = 'steer';
      return;
    }
    if (mapMoved()) {
      // The map was panned / zoomed / re-picked while in street mode: the
      // lift re-matches the map. The 2D map height is Google's nominal model
      // altitude; convert it to the true camera altitude that shows the SAME
      // ground scale in the 3D nadir view (otherwise the 3D view looks ~4-6x
      // more zoomed in).
      const scaleAlt = routeScene.trueAltForMapScale(mapAlt.value, drone.lat);
      drone.alt = scaleAlt;
      // Terrain-aware floor: a searched address can sit on high ground or
      // tall buildings, which would put a scale-only camera underground.
      // Raise to at least ground + 1000 m (never lower the scale height).
      routeScene.safeNadirAltitude(scaleAlt, drone.lat, drone.lon).then((alt) => {
        if (!isStreet.value && alt > drone.alt) drone.alt = alt;
      });
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

// Cesium canvas visibility + globe state. Extracted into a named function
// because it has to run from TWO places: this watcher, and onMounted right
// after the container is looked up. The watcher is registered during setup
// with { immediate: true }, so its first pass runs while cesiumContainer.value
// is still null (it is assigned in onMounted) and therefore toggles nothing.
// onUnmounted adds .cesium-hidden, and on a client-side re-entry to /play none
// of the watched sources has to change — so without the onMounted call the
// canvas keeps opacity: 0 from the previous visit and the Play view is BLACK.
function applyCesiumVisibility() {
  const viewer = window.cesiumViewer;
  const street = isStreet.value;
  if (viewer) {
    // In mesh (OSM) mode the globe must stay visible as ground context; in
    // aerial (Google) mode the photorealistic tiles render their own ground,
    // so the globe is switched off. The 2D street map always covers it.
    viewer.scene.globe.show = activeSource.value === 'osm' && !street;
  }
  if (cesiumContainer.value) {
    cesiumContainer.value.classList.toggle('cesium-hidden', street);
  }
}

watch([activeSource, isStreet], applyCesiumVisibility, { immediate: true });

/**
 * Unit direction (ECEF) the flight disk is asking the drone to travel in.
 * Returns null when the stick is centred or the mode does not translate.
 */
function getFlightCommandDirection() {
  const viewer = window.cesiumViewer;
  if (!viewer) return null;
  if (!Number.isFinite(drone.lat) || !Number.isFinite(drone.lon) || !Number.isFinite(drone.alt)) return null;

  const position = Cesium.Cartesian3.fromDegrees(drone.lon, drone.lat, drone.alt);
  const enuTransform = Cesium.Transforms.eastNorthUpToFixedFrame(position);

  let enuDir = null;
  if (activeFlightMode.value === 'M') {
    const mag = Math.hypot(flightCmd.vx, flightCmd.vy);
    if (!(mag > 0)) return null;
    // M is WORLD-ALIGNED (useFlightPhysics: W=north, S=south, A=west, D=east),
    // so the probe must be too. It used to be rotated by drone.heading, which
    // made the ray test a direction unrelated to the actual movement: after any
    // R rotation the guard blocked clear directions and cleared blocked ones.
    enuDir = new Cesium.Cartesian3(flightCmd.vx / mag, flightCmd.vy / mag, 0);
  } else if (activeFlightMode.value === 'H') {
    if (!flightCmd.vz) return null;
    enuDir = new Cesium.Cartesian3(0, 0, flightCmd.vz > 0 ? 1 : -1);
  }
  if (!enuDir) return null;

  const worldDir = Cesium.Matrix4.multiplyByPointAsVector(enuTransform, enuDir, new Cesium.Cartesian3());
  const worldMag = Cesium.Cartesian3.magnitude(worldDir);
  // divideByScalar rather than normalize: Cartesian3.normalize throws a
  // RuntimeError on a degenerate vector, and loop() would swallow it silently.
  if (!Number.isFinite(worldMag) || worldMag < 1e-6) return null;
  return Cesium.Cartesian3.divideByScalar(worldDir, worldMag, worldDir);
}

function checkCollisionAhead() {
  const viewer = window.cesiumViewer;
  const tileset = getActiveTileset();
  if (!viewer || !tileset || !showFlight.value) return null;

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

  const offset = Cesium.Cartesian3.subtract(result.position, position, new Cesium.Cartesian3());
  const distance = Cesium.Cartesian3.magnitude(offset);
  // While grounded the camera is parked exactly ON the mesh, so the hit can
  // coincide with the drone. A degenerate offset would normalize to NaN and
  // poison drone.lat/lon/alt through applyEnuMove, so drop the frame instead.
  if (!Number.isFinite(distance) || distance < 1e-3) return null;

  // The ground is a floor, not an obstacle — the same rule
  // useAltitudeGate.checkVerticalCollision() applies to the auto sequences.
  // M-mode flight is purely horizontal and snapToGround() already owns the
  // vertical, so a hit at (or below) the sampled surface height must never
  // block the stick; without this a grounded drone cannot move at all. H-mode
  // keeps the ground as a real obstacle so a descent stops above the surface
  // instead of tunnelling through it.
  if (activeFlightMode.value === 'M') {
    const hitCartographic = Cesium.Cartographic.fromCartesian(result.position);
    const hitAlt = hitCartographic ? hitCartographic.height : NaN;
    if (Number.isFinite(hitAlt) && hitAlt <= altitudeGate.surfaceAlt.value + 1.0) return null;
  }

  const buffer = MIN_SAFETY_BUFFER + settings.safetyBuffer;
  if (distance > buffer) return null;

  // Surface normal: away from the hit, back toward the drone.
  const normal = Cesium.Cartesian3.divideByScalar(offset, distance, offset);

  return { distance, position: result.position, normal };
}

/**
 * Clamp a desired ENU move against a surface hit instead of cancelling it:
 * the into-surface component is capped at the clearance actually left, and the
 * tangential component survives, so the drone slides along a facade or settles
 * onto a roof rather than freezing in mid-air.
 * Returns the clamped move, or null when no change is needed.
 */
function resolveCollisionMove(enuMove, collision) {
  const position = Cesium.Cartesian3.fromDegrees(drone.lon, drone.lat, drone.alt);
  const invTransform = Cesium.Matrix4.inverse(
    Cesium.Transforms.eastNorthUpToFixedFrame(position),
    new Cesium.Matrix4()
  );
  const enuNormal = Cesium.Matrix4.multiplyByPointAsVector(invTransform, collision.normal, new Cesium.Cartesian3());
  const normalMag = Cesium.Cartesian3.magnitude(enuNormal);
  if (!Number.isFinite(normalMag) || normalMag < 1e-6) return null;
  Cesium.Cartesian3.divideByScalar(enuNormal, normalMag, enuNormal);

  const move = Cesium.Cartesian3.fromElements(Number(enuMove.x) || 0, Number(enuMove.y) || 0, Number(enuMove.z) || 0);
  const intoSurface = Cesium.Cartesian3.dot(move, enuNormal); // negative = toward the surface
  if (!Number.isFinite(intoSurface) || intoSurface >= 0) return null; // travelling away — unrestricted

  // Clearance left before the minimum stand-off is reached. Large look-ahead
  // buffers are harmless here: room dwarfs a ~1 m frame step, so nothing is
  // restricted until the drone is genuinely about to touch the surface.
  const room = Math.max(0, collision.distance - MIN_SAFETY_BUFFER);
  const allowed = Math.max(intoSurface, -room);
  if (allowed === intoSurface) return null; // this frame's step already fits

  const excess = Cesium.Cartesian3.multiplyByScalar(enuNormal, intoSurface - allowed, new Cesium.Cartesian3());
  const clamped = Cesium.Cartesian3.subtract(move, excess, new Cesium.Cartesian3());
  if (!Number.isFinite(clamped.x) || !Number.isFinite(clamped.y) || !Number.isFinite(clamped.z)) return null;
  return clamped;
}

// ── Camera ownership: mouse vs. drone ──────────────────────────────────────
// window.updateCesiumCamera() hard-assigns the camera via camera.setView().
// Calling it unconditionally at 60 fps overwrites whatever the mouse did ~16 ms
// earlier, so Cesium's ScreenSpaceCameraController can never win: a left-drag
// rubber-bands straight back and a wheel zoom snaps back to drone.alt. The
// globe then reads as permanently locked even though the controller is fully
// enabled and nothing covers the canvas (every Vue layer over the map area is
// pointer-events: none). Pushing ONLY when the drone / gimbal pose actually
// moved hands the camera to the mouse while both disks are idle, and the first
// flight-disk, gimbal-disk, autopilot or takeoff/landing change re-pins it.
let lastPushedPose = null;

// Altitude needs the loosest tolerance: while grounded, altitudeGate
// .snapToGround() re-assigns drone.alt from a per-frame surface raycast that
// jitters by millimetres as tiles refine — an exact compare would re-pin the
// camera every frame and re-lock the mouse. 1 cm is far below anything the eye
// or the collision gate can resolve.
const POSE_EPS_LATLON = 1e-9; // degrees (~0.1 mm)
const POSE_EPS_ALT = 0.01; // metres
const POSE_EPS_DEG = 1e-6; // degrees

function samePose(a, b) {
  return (
    Math.abs(a.lat - b.lat) <= POSE_EPS_LATLON &&
    Math.abs(a.lon - b.lon) <= POSE_EPS_LATLON &&
    Math.abs(a.alt - b.alt) <= POSE_EPS_ALT &&
    Math.abs(a.heading - b.heading) <= POSE_EPS_DEG &&
    Math.abs(a.gimbalYaw - b.gimbalYaw) <= POSE_EPS_DEG &&
    Math.abs(a.gimbalPitch - b.gimbalPitch) <= POSE_EPS_DEG &&
    Math.abs(a.gimbalRoll - b.gimbalRoll) <= POSE_EPS_DEG
  );
}

// ── Mouse-look safety net ──────────────────────────────────────────────────
// Handing the camera to the mouse means nothing pulls it back on its own, and
// in Google mode globe.show is false — so one wheel-zoom out or one orbit past
// the horizon leaves the user staring at empty space (a black screen) or at the
// tileset's lowest LOD, which reads as a flat satellite map, with no way home
// except touching a disk. The mouse therefore keeps the camera only while it is
// actually being used: CAMERA_IDLE_REPIN_MS after the last canvas input the
// drone takes it back. Drag / wheel look-around stays fully usable meanwhile
// (every event pushes the deadline out, and a held button never re-pins).
const CAMERA_IDLE_REPIN_MS = 2500;
let mouseOwnsCamera = false;
let canvasPointerDown = false;
let lastCanvasInputTs = 0;

function noteCanvasInput() {
  lastCanvasInputTs = performance.now();
  if (!mouseOwnsCamera) {
    mouseOwnsCamera = true;
    // Invalidate the cached pose so handing the camera back ALWAYS re-pins,
    // even when the drone has not moved since the mouse took over.
    lastPushedPose = null;
  }
}
function onCanvasPointerDown() {
  canvasPointerDown = true;
  noteCanvasInput();
}
function onCanvasPointerUp() {
  // Bound on window (a drag can end outside the canvas); ignore stray ups.
  if (!canvasPointerDown) return;
  canvasPointerDown = false;
  noteCanvasInput();
}
function onCanvasWheel() {
  noteCanvasInput();
}

function pushCameraPose(pose) {
  // Steer FPV freeze (pencil session): the still screenshot owns the screen,
  // so the drone follow must not move the live camera underneath it. Dropping
  // the cached pose makes the first push after the release snap straight to
  // the drone's NEW pose — the accepted post-freeze "jump".
  if (fpvFrozen.value) {
    lastPushedPose = null;
    return;
  }
  if (mouseOwnsCamera) {
    if (canvasPointerDown || performance.now() - lastCanvasInputTs < CAMERA_IDLE_REPIN_MS) return;
    mouseOwnsCamera = false; // idle window elapsed — hand the camera back below
  }
  // During an auto takeoff / landing the app owns the camera outright: the
  // sequence must stay framed on the drone, and altitudeGate.prewarmTiles()
  // deliberately teleports the (2D-map-covered) camera during PRE_TAKEOFF,
  // when the pose is otherwise static. Never idle-skip there, or a pre-warm
  // pose could be left parked on screen.
  if (!isTakeoffLanding.value && lastPushedPose && samePose(pose, lastPushedPose)) return;
  lastPushedPose = pose;
  window.updateCesiumCamera(pose);
}

function syncCesiumCamera() {
  if (typeof window.updateCesiumCamera !== 'function') return;
  // The Plan map has its own camera, so the hidden globe keeps mirroring the
  // ACTIVE ASSET's FPV there rather than the map: that is what makes the
  // return to Steer land on the machine that has been flying (or driving)
  // all along, and what keeps its tiles warm. Only Search / Route mirror the
  // map into a nadir pre-stream.
  if (isStreet.value && !isPlanView.value) {
    // While the 2D street map covers the globe, the hidden (still
    // rendering, opacity 0) Cesium canvas mirrors the map as a nadir view
    // at the same ground scale: the Google 3D tiles of the visible area
    // stream in the background, so the Steer lift to 3D is instant.
    pushCameraPose({
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
  // Steer chase cam (and the Plan warm mirror): a third-person virtual
  // camera 15 m above the ACTIVE asset and 30 m behind it (opposite its
  // travel direction), framing the asset's GLB mesh in the Google 3D scene.
  // Burial rescue: if the live Cesium camera ever ends up BELOW the sampled
  // tileset surface of the ACTIVE asset (a mouse wheel dug it in, or a
  // transient bad state), drop the mouse ownership and the cached pose so
  // this frame re-pins the camera to the chase pose. A landed asset sits
  // exactly ON the surface, so the 1 m underground threshold never fires
  // legitimately.
  const viewer = window.cesiumViewer;
  const camAlt = viewer?.camera?.positionCartographic?.height;
  const activeSurface = activeIsDrone.value
    ? altitudeGate.surfaceAlt.value
    : (getTankSurface() ?? altitudeGate.surfaceAlt.value);
  if (Number.isFinite(camAlt) && camAlt < activeSurface - 1) {
    mouseOwnsCamera = false;
    lastPushedPose = null;
  }
  const cam = chaseCameraPose(activeAsset.value);
  pushCameraPose({
    lat: cam.lat,
    lon: cam.lon,
    alt: cam.alt,
    heading: cam.heading,
    gimbalYaw: 0,
    gimbalPitch: cam.pitch,
    gimbalRoll: cam.roll,
  });
}

// Switching the ACTIVE asset (chat Team popover / Plan-map badge click): drop
// the cached pose and the mouse-look ownership so the FPV re-pins straight to
// the newly selected machine — same accepted "jump" as the freeze release.
watch(activeAssetId, () => {
  lastPushedPose = null;
  mouseOwnsCamera = false;
});

// Fleet test-phase autopilot: the hardcoded routes own both machine assets
// until the human takes the stick. Steer-disk / WASD input is car-style and
// is consumed by the fleet sim EVERY FRAME while held (continuous motion):
// up/w forward, down/s backward, left/a turn left, right/d turn right on the
// ACTIVE machine; releasing hands the machine back to its route with a
// smooth glide (no snap). The drone also yields to the takeoff/landing
// sequence and the play-link route autopilot.
function stepFleetSim() {
  // Normalise the ±3 sensitivity range of the disk / keys to −1..1.
  const norm = (v) => Math.max(-1, Math.min(1, v / 3));
  const flightInput = !!(flightCmd.vx || flightCmd.vy || flightCmd.vz || flightCmd.yaw);
  const fwd = norm(flightCmd.vy);
  const turn = norm(flightCmd.vx + flightCmd.yaw);
  const climb = norm(flightCmd.vz);
  stepFleet(1 / 60, {
    viewer: window.cesiumViewer,
    droneSurfaceAlt: altitudeGate.surfaceAlt.value,
    droneSurfaceOk: altitudeGate.hasSurface.value,
    droneManual: isTakeoffLanding.value || autopilot.active.value,
    droneCtl: flightInput && activeIsDrone.value ? { fwd, turn, climb } : null,
    tankCtl: flightInput && !activeIsDrone.value ? { fwd, turn } : null,
  });
}

// Plan view: feed the fleet's live positions into the 2D map's team badges
// (fixed screen size at every zoom). A badge click makes that asset ACTIVE
// but never switches the view; any other street sub-view clears the badges.
let planTeamFed = false;
function updatePlanTeamMarkers() {
  if (!mapViewRef.value) return;
  if (!isPlanView.value) {
    if (planTeamFed) {
      mapViewRef.value.setTeamMarkers([]);
      planTeamFed = false;
    }
    return;
  }
  planTeamFed = true;
  mapViewRef.value.setTeamMarkers(
    FLEET.map((a) => ({
      id: a.id,
      lat: a.pose.lat,
      lon: a.pose.lon,
      active: a.id === activeAssetId.value,
      name: t(mateById(a.id)?.nameKey || a.id),
    }))
  );
}

// A Plan-map badge click only re-targets the fleet (requirement: NO view
// switch); the Steer button then lifts into the ACTIVE asset's FPV.
function onTeamMarkerClick(id) {
  setActiveAsset(id);
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
    // flies on toward the next waypoint (same movement + collision path).
    // Manual stick input on the ACTIVE machine is NOT applied here: the
    // fleet sim consumes flightCmd every frame while it is held (car-style
    // forward / turn / climb), which keeps hold-input continuous.
    if (autopilot.active.value && autopilot.flightIdle()) {
      enuMove = autopilot.stepFlight(dt);
    }
  }

  const collision = checkCollisionAhead();
  // null = the collision did not restrict this frame's move at all.
  const clampedMove = collision && enuMove ? resolveCollisionMove(enuMove, collision) : null;
  if (clampedMove) {
    enuMove = clampedMove;
    isCollisionFrozen.value = true;
    collisionSurfaceNormal.value = collision.normal;
  } else {
    isCollisionFrozen.value = false;
    collisionSurfaceNormal.value = null;
  }

  if (showFlight.value) {
    // Only the autopilot's ENU move reaches the drone pose from here; stick
    // input is owned by the fleet sim (see stepFleetSim). Telemetry still
    // mirrors the stick so the HUD reads live while held.
    if (enuMove) applyEnuMove(enuMove);
    updateFlightTelemetry(allowAltitude);
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
    // The Gimbal disk writes the shared `gimbal` object (drone's). When the
    // TANK is active, mirror the per-frame delta into the tank's gimbal and
    // undo it on the drone's, so the chase view (whose heading = machine
    // heading + gimbal yaw) responds and the drone keeps its own angles.
    const gSnap = activeIsDrone.value ? null : { yaw: gimbal.yaw, pitch: gimbal.pitch, roll: gimbal.roll };
    stepCameraPhysics(dt, { applyMovement: true });
    if (gSnap) {
      session.tankGimbal.yaw += gimbal.yaw - gSnap.yaw;
      session.tankGimbal.pitch += gimbal.pitch - gSnap.pitch;
      session.tankGimbal.roll += gimbal.roll - gSnap.roll;
      gimbal.yaw = gSnap.yaw;
      gimbal.pitch = gSnap.pitch;
      gimbal.roll = gSnap.roll;
    }
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
      sampleFrame(drone, gimbal);
    }
    // During replay the replay engine owns the Cesium camera; skip the flight
    // physics, collision checks and camera sync so they cannot fight it.
    if (recorderState.value !== 'replaying') {
      updateDroneState();
      stepFleetSim();
      syncFleetModels(window.cesiumViewer);
      syncCesiumCamera();
      updatePlanTeamMarkers();
    } else {
      // The replay engine owns the Cesium camera; drop the cached pose so the
      // first frame after the replay always re-pins to the drone.
      lastPushedPose = null;
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

// ── Plan view: LA wildfire disaster zone (2D map, terrain ↔ satellite) ────
// First Plan click: enter the Plan sub-view on the Google street + terrain
// map, centered on the Palisades fire zone with its perimeter overlay.
// Every further click cycles the base layer terrain ↔ satellite and
// re-centers on the zone.
let planPendingCenter = false;

// Re-seat the Plan camera on the disaster zone. Touches planCam ONLY: the
// drone keeps flying wherever it was, and clicking Steer afterwards returns to
// that flight instead of to a 25 km nadir shot of the fire perimeter.
function centerPlanView() {
  planCam.lat = PALISADES_FIRE.center.lat;
  planCam.lon = PALISADES_FIRE.center.lng;
  planCam.alt = PLAN_VIEW_ALT;
  if (mapViewRef.value) {
    mapViewRef.value.panTo(PALISADES_FIRE.center.lat, PALISADES_FIRE.center.lng, PLAN_VIEW_ALT);
  } else {
    // MapView not mounted yet (coming from the 3D Steer view): the pending
    // flag is consumed by onMapReady right after the map is acquired.
    planPendingCenter = true;
  }
}

function onClickPlan() {
  if (isPlanView.value) {
    planLayer.value = planLayer.value === 'terrain' ? 'satellite' : 'terrain';
    centerPlanView();
    return;
  }
  planLayer.value = 'terrain';
  viewCtx.subView = 'plan';
  // Always seat the Plan camera — it is plain state, no DOM required. The
  // panTo inside only runs when the map is already mounted (Search / Route);
  // from Steer the onMapReady hook does it instead, and the :lat/:lon/:alt
  // props already open the freshly created map on the zone.
  centerPlanView();
}

// Leaving the Plan view only flips the dock button state; the pens themselves
// are dismissed by the penViews watch below (both Plan and Steer draw).
watch(isPlanView, (plan) => {
  const item = rightItems.find((i) => i.id === 'plan');
  if (item) item.active = plan;
});

// ── Pencil toolbox state (Plan 2D map + Steer FPV freeze) ──────────────
// The toolbox is controlled from here; two pen engines draw and report their
// mark counts: MapView (Google polylines — geographic marks on the Plan map)
// and the Steer freeze pen. Arming any pen in Steer FREEZES the drone FPV
// into a still 2D screenshot which the commander annotates in screen space;
// the chat's Screenshot button sends the marked still to the transcript and
// releases the freeze (see useSteerFreezePen.js). The toolbox shows the
// ACTIVE view's count; Clear wipes both engines.
const penTool = ref(null);
const penInk = ref('#ff3b30');
const penMarkCount2D = ref(0);
const {
  frozen: fpvFrozen,
  snapshotUrl: fpvSnapshot,
  markCount: penMarkCount3D,
  beginFreeze,
  endFreeze,
  bindCanvas: bindFreezeCanvas,
  clearMarks: clearFreezeMarks,
  pointerDown: freezePenDown,
  pointerMove: freezePenMove,
  pointerUp: freezePenUp,
} = useSteerFreezePen();
const penMarkCount = computed(() =>
  isSteerView.value ? penMarkCount3D.value : penMarkCount2D.value
);

// Arming a pen in Steer freezes the FPV; putting the pen away (the toolbox
// freeze button, or leaving Steer) releases the freeze and drops the marks.
watch([isSteerView, penTool], ([steer, tool]) => {
  if (steer && tool) {
    if (!fpvFrozen.value) beginFreeze();
  } else if (fpvFrozen.value) {
    endFreeze();
  }
});

// The chat's Screenshot button releases the freeze after submitting; the pen
// follows suit so the toolbox never shows an armed tool over a live view.
watch(fpvFrozen, (f) => {
  if (!f) penTool.value = null;
});

// Leaving both drawing surfaces puts the pens away (each engine drops its
// own work: MapView on unmount, the freeze pen when the freeze releases).
watch(penViews, (on) => {
  if (!on) penTool.value = null;
});

function onPenToolChange(tool) {
  penTool.value = tool;
}
function onPenInkChange(color) {
  penInk.value = color;
}
function onPenClear() {
  mapViewRef.value?.clearPenMarks();
  clearFreezeMarks();
}

// Overlay-canvas input, forwarded to the freeze pen with the armed tool/ink.
function onFreezePointerDown(e) {
  freezePenDown(e, penTool.value, penInk.value);
}
function onFreezePointerMove(e) {
  freezePenMove(e);
}
function onFreezePointerUp(e) {
  freezePenUp(e);
}

onMounted(() => {
  cesiumContainer.value = document.getElementById('cesiumContainer');
  // Resume the shared Cesium viewer if it was paused when we last left /play
  // (see onUnmounted). It is a page-lifetime singleton, so on a warm
  // client-side re-entry it already holds the streamed tiles.
  if (window.cesiumViewer) window.cesiumViewer.useDefaultRenderLoop = true;
  // The cesium-visibility watcher's { immediate: true } pass already ran during
  // setup, when cesiumContainer.value was still null, so it could not clear the
  // .cesium-hidden that the previous onUnmounted added. Re-apply it now that the
  // container is known — otherwise a client-side re-entry to /play stays BLACK.
  applyCesiumVisibility();
  // Mouse-look safety net: see pushCameraPose / CAMERA_IDLE_REPIN_MS.
  if (cesiumContainer.value) {
    cesiumContainer.value.addEventListener('pointerdown', onCanvasPointerDown);
    cesiumContainer.value.addEventListener('wheel', onCanvasWheel, { passive: true });
  }
  window.addEventListener('pointerup', onCanvasPointerUp);
  startFlightKeyboard();
  startCameraKeyboard();
  syncCesiumCamera();
  // Mounted already in street mode (restored sub-view): remember the map
  // state so an untouched lift back to Steer restores the 3D pose. The Plan
  // view has no lift to reconcile (its camera is its own), so skip it.
  if (isStreet.value && !isPlanView.value) snapshotMap();

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
    id: 'plan',
    icon: 'MENU_PLAN',
    titleKey: 'aerialview.plan',
    active: isPlanView.value,
    onClick: onClickPlan,
  });
  registerRight({
    id: 'steer',
    icon: 'MENU_CONTROL_STICK',
    titleKey: 'aerialview.steer',
    active: isSteerView.value,
    onClick: toggleSteer,
  });

  // The highlight follows the ACTIVE VIEW, not the flight-disk toggle: Plan
  // is lit in the Plan sub-view, Steer in the 3D Steer sub-view, and neither
  // in Search / Route.
  watch(isSteerView, (steer) => {
    const item = rightItems.find((i) => i.id === 'steer');
    if (item) item.active = steer;
  });
  // Close the Flight/Gimbal disks during replay (restored when it ends): the
  // replay engine owns the Cesium camera, so the manual disks must not fight it.
  watch(recorderState, (state, prev) => {
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
    const lockableIds = ['steer'];
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
  agentScene.stop();
  resetRecorder();
  // A freeze session must never outlive the view: it stops the camera push
  // and holds a full-viewport overlay.
  endFreeze();
  stopFlightKeyboard();
  stopCameraKeyboard();
  if (rafId) cancelAnimationFrame(rafId);
  if (connectionCheckInterval) clearInterval(connectionCheckInterval);
  if (cesiumContainer.value) {
    cesiumContainer.value.removeEventListener('pointerdown', onCanvasPointerDown);
    cesiumContainer.value.removeEventListener('wheel', onCanvasWheel);
  }
  window.removeEventListener('pointerup', onCanvasPointerUp);
  canvasPointerDown = false;
  mouseOwnsCamera = false;
  // Pause the shared Cesium viewer while /play is off screen. It is a
  // page-lifetime singleton on the global #cesiumContainer, so keep it alive
  // (tiles stay cached for an instant re-entry) but stop the render loop and
  // hide the canvas so it cannot burn GPU/network behind another page.
  if (window.cesiumViewer) window.cesiumViewer.useDefaultRenderLoop = false;
  if (cesiumContainer.value) cesiumContainer.value.classList.add('cesium-hidden');
  clear();
});
</script>

<template>
  <ViewComposer
    :right-items="rightItems"
    :show-flight="showFlight && !isStreet"
    :show-camera="showCamera && !isStreet"
    :show-hud="false"
    :flight="flight"
    :camera="camera"
    :show-pens="penViews"
    :pen-tool="penTool"
    :ink-color="penInk"
    :mark-count="penMarkCount"
        :disabled="isAutoActive"
    @flightMove="onFlightMove"
    @flightStop="onFlightStop"
    @flightModeChange="onFlightModeChange"
    @cameraMove="onCameraMove"
    @cameraStop="onCameraStop"
    @cameraModeChange="onCameraModeChange"
    @penToolChange="onPenToolChange"
    @inkColorChange="onPenInkChange"
    @penClear="onPenClear"
  >
    <template #background>
      <!-- Google 2D map background: shown while the page is in 'street'
           mode, entered via Search / Route / Plan. Stays mounted across
           those switches so center / zoom / the red selection balloon are
           preserved. Search + Route mirror the drone's camera; Plan drives
           it from its own planCam (see mapCamLat / mapCamLon / mapCamAlt),
           so the EOC briefing map never moves the drone. -->
      <MapView
        v-if="isStreet"
        ref="mapViewRef"
        class="view-composer__background aerial-street-map"
        :map-type-id="mapTypeId"
        :lat="mapCamLat"
        :lon="mapCamLon"
        :alt="mapCamAlt"
        :heading="drone.heading"
        :is-picking="false"
        :show-drone-marker="false"
        :waypoints-editable="false"
        :polygons="planPolygons"
        :pen-tool="penTool"
        :pen-color="penInk"
        @mapReady="onMapReady"
        @centerChange="onMapCenterChange"
        @zoomChange="onMapZoomChange"
        @poisFound="onPoisFound"
        @poisError="onPoisError"
        @teamClick="onTeamMarkerClick"
        @marksChange="penMarkCount2D = $event"
      />
      <!-- Steer FPV freeze: while a pencil is armed the live globe is
           replaced by its still screenshot, and annotations are drawn on
           that still in screen space. The chat's Screenshot button sends
           the marked still and releases the freeze; the view then jumps to
           the drone's current pose. -->
      <div v-if="fpvFrozen" class="fpv-freeze">
        <img
          v-if="fpvSnapshot"
          class="fpv-freeze__shot"
          :src="fpvSnapshot"
          alt=""
          draggable="false"
        />
        <canvas
          :ref="bindFreezeCanvas"
          class="fpv-freeze__ink"
          @pointerdown="onFreezePointerDown"
          @pointermove="onFreezePointerMove"
          @pointerup="onFreezePointerUp"
        />
      </div>
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
        <!-- Deep link armed + tiles ready: remind the user to start the
             journey with the Steer button (blue reminder, top bar). -->
        <div v-if="showPlayReady" class="shell-notice">
          {{ t('aerialview.play_ready') }}
        </div>
      </Teleport>
    </template>
  </ViewComposer>

  <!-- Game intro briefing, confined to the main panel (.shell-main). Shown
       on entry; dismisses itself when the clips finish (or on Skip), once the
       3D scene is ready. Sibling root node so it overlays the whole panel. -->
  <SplashOverlay
    v-if="showIntro"
    :clips="intro.clips"
    :slogan="intro.slogan"
    :music="intro.music"
    @dismissed="onIntroDismissed"
  />
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

/* The 2D street map must receive its pan / zoom gestures. It fills the page
   area (the composer / shell-main) instead of the whole viewport: the right
   assistant panel (z-index above the page) would otherwise cover the map's
   bottom-right zoom controls and shift the visible map centre. The 3D globe
   background stays full-bleed (position: fixed). */
:deep(.view-composer__background.aerial-street-map) {
  position: absolute;
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

/* ── Steer FPV freeze overlay (pencil screenshot session) ──
   Composer background layer: above the Cesium canvas / 2D map,
   below every control (joystick area z 5, pens toolbox z 6, docks above),
   so the toolbox, chat and flight disks stay usable while the FPV is frozen
   and the drone keeps flying. */
.fpv-freeze {
  position: absolute;
  inset: 0;
  z-index: 1;
  pointer-events: auto;
  overflow: hidden;
  background: #000;
}

.fpv-freeze__shot,
.fpv-freeze__ink {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}

.fpv-freeze__shot {
  user-select: none;
}

.fpv-freeze__ink {
  touch-action: none;
  cursor: crosshair;
}
</style>
