<script setup>
import { ref, computed, onMounted, onUnmounted, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import ViewComposer from '@shared/_ViewComposer.vue';
import CollisionWarning from '@shared/CollisionWarning.vue';
import StreetViewPane from '@shared/StreetViewPane.vue';
import { MapView } from '@/2d_map/index.js';
import ConfigurableIcon from '@shared/ConfigurableIcon.vue';
import { useRouteScene3D } from '@shared-composables/useRouteScene3D.js';
import { useDrone } from '@shared-composables/useDrone.js';
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

const { drone, gimbal } = useDrone();

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
const viewMode = ref('3d');
const isStreet = computed(() => viewMode.value === 'street');
const mapTypeId = computed(() => 'roadmap');

// ── Search panel state (address finding — same workflow as Route Planning) ──
const mapViewRef = ref(null);
const showSearchPanel = ref(false);
const searchQuery = ref('');
const searchResults = ref([]);
const searchError = ref('');
// True while a search query is in flight; the next poisFound event then
// fills the results list.
const searchBusy = ref(false);
// True once at least one query has been submitted (gates the
// "No results found." hint so it never shows while merely typing).
const hasSearched = ref(false);
// Route button green border: on the 2D map without the search panel.
const routeActive = computed(() => isStreet.value && !showSearchPanel.value);
// The address the user picked from the search results (the red balloon). Kept
// so the balloon can be re-shown when returning to the Search view after the
// map was recreated (e.g. after a 3D excursion).
const selectedLatLng = ref(null);

function onClickSearch() {
  // Address search always shows the 2D street map, matched to the location /
  // zoom the user currently has (leaving 3D first if needed).
  if (!isStreet.value) enterStreetFrom3d();
  viewMode.value = 'street';
  showSearchPanel.value = true;
  // The Search view marks the picked address with the red balloon.
  if (selectedLatLng.value) {
    mapViewRef.value?.setSelectionMarker(selectedLatLng.value.lat, selectedLatLng.value.lng);
  }
}

function onClickRoute() {
  // Route shows the same 2D street map as Search (same center / zoom) but
  // WITHOUT the red balloon. Leaving 3D first matches the current view.
  if (!isStreet.value) enterStreetFrom3d();
  viewMode.value = 'street';
  showSearchPanel.value = false;
  mapViewRef.value?.setSelectionMarkerVisible(false);
}

function enterStreetFrom3d() {
  // Convert the true 3D camera altitude back to the 2D map model altitude so
  // the street map opens at the same location and ground scale (zoom level)
  // the user was seeing in 3D.
  drone.alt = routeScene.modelAltForMapScale(drone.alt, drone.lat);
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
  drone.alt = Math.max(0, Math.min(100000, alt));
}

// The Google Map is recreated whenever we return from the 3D view; re-apply
// the picked-address balloon if we are back on the Search view.
function onMapReady() {
  if (isStreet.value && showSearchPanel.value && selectedLatLng.value) {
    mapViewRef.value?.setSelectionMarker(selectedLatLng.value.lat, selectedLatLng.value.lng);
  }
}

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
    // The 2D map altitude is Google's nominal model altitude; convert it
    // to the true camera altitude that shows the SAME ground scale in the
    // 3D nadir view (otherwise the 3D view looks ~4-6x more zoomed in).
    drone.alt = routeScene.trueAltForMapScale(drone.alt, drone.lat);
    drone.heading = 0;
    gimbal.yaw = 0;
    gimbal.pitch = -90; // look straight down, satellite style
    gimbal.roll = 0;
    showSearchPanel.value = false;
    viewMode.value = '3d';
    return;
  }
  const next = !showFlight.value;
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
      alt: routeScene.trueAltForMapScale(drone.alt, drone.lat),
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
    enuMove = computeDesiredEnuMove(dt, allowAltitude);
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

  // Initial connection check and periodic re-check.
  checkGoogleConnection();
  checkCesiumConnection();
  connectionCheckInterval = setInterval(() => {
    checkGoogleConnection();
    checkCesiumConnection();
  }, 10000);

  registerRight({
    id: 'search',
    icon: 'MENU_SEARCH',
    titleKey: 'aerialview.search',
    active: showSearchPanel,
    onClick: onClickSearch,
  });
  registerRight({
    id: 'steer',
    icon: 'MENU_CONTROL_STICK',
    titleKey: 'aerialview.steer',
    active: showFlight.value,
    onClick: toggleSteer,
  });
  registerRight({
    id: 'route',
    icon: 'MENU_MAP',
    titleKey: 'aerialview.route',
    active: routeActive,
    onClick: onClickRoute,
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
        :alt="drone.alt"
        :heading="drone.heading"
        :is-picking="false"
        :show-drone-marker="false"
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

      <!-- Address search panel (same workflow as Route Planning) -->
      <div v-if="showSearchPanel && isStreet" class="search-panel">
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
      </Teleport>
    </template>
  </ViewComposer>
</template>

<style scoped>
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
