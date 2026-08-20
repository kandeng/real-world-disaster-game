<script setup>
import { onMounted, onUnmounted, h, ref, computed, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import ViewComposer from '@shared/_ViewComposer.vue';
import { MapView } from '@/2d_map/index.js';
import { useDrone } from '@shared-composables/useDrone.js';
import { useRouteScene3D } from '@shared-composables/useRouteScene3D.js';
import { useFlightCommands } from '@shared-composables/useFlightCommands.js';
import { useCameraCommands } from '@shared-composables/useCameraCommands.js';
import { useDockRegistry } from '@shared-composables/useDockRegistry.js';
import { useConnectionStatus, checkGoogleConnection, checkCesiumConnection } from '@shared-composables/useConnectionStatus.js';
import { useAuth } from '@shared-composables/useAuth.js';
import DockButton from '@shared/DockButton.vue';
import ConnectionError from '@shared/ConnectionError.vue';
import ConfigurableIcon from '@shared/ConfigurableIcon.vue';
import cancelIcon from '../../icons/cancel.svg';

const { t } = useI18n();
const { drone, gimbal } = useDrone();
// Login state: the finished preview video is only handed out to logged-in
// users (same gate as the captures on 3D Exploration -> 3D Aerial).
const { isAuthenticated } = useAuth();

// 3D subpage scene controller: sim loop, Flight/Gimbal disk state and the
// first-person preview flight + recording (singleton composable).
const routeScene = useRouteScene3D();
const { flight, onFlightMove, onFlightStop, onFlightModeChange } = useFlightCommands();
const { camera, onCameraMove, onCameraStop, onCameraModeChange } = useCameraCommands();
const is3d = computed(() => viewMode.value === '3d');
const previewActive = routeScene.previewActive; // template binding (auto-unwrapped)
// The disks mirror the 3D Aerial positions; they are hidden while a preview
// is running AND while the Route list box is open (no overlap).
const showFlightDisk = computed(
  () => is3d.value && routeScene.showFlight.value && !routeScene.previewActive.value && !showRoutePanel.value
);
const showCameraDisk = computed(
  () => is3d.value && routeScene.showCamera.value && !routeScene.previewActive.value && !showRoutePanel.value
);
// HUD dashboard as in 3D Aerial — hidden only while the preview flight is
// playing or while Save is settling/downloading the clip.
const showHudDashboard = computed(() => is3d.value && !routeScene.previewActive.value && !routeScene.saving.value);
// Spinning-circle overlay: the preview/save flight freezes (view stuck)
// until the Google 3D tiles of the current view are fully downloaded and
// rendered — quality of each frame beats speed of the simulation.
const showTileSpinner = computed(() => is3d.value && (routeScene.waitingTiles.value || routeScene.renderProgress.value != null));
// While a preview or a Save capture flight runs, the whole right sidebar
// (Search / Waypoint / Steer / Route) is locked: buttons dim + ignore
// clicks, and the Flight / Gimbal disks stay hidden.
const controlsLocked = computed(() => routeScene.previewActive.value || routeScene.saving.value);
// Flight disk on this page cycles M (move lat/lon) -> H (height) ->
// V (velocity), unlike 3D Aerial's M/R/H.
const FLIGHT_MODES = ['M', 'H', 'V'];
const { rightItems, registerRight, clear } = useDockRegistry();

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

// Active background of this page:
//   'street' – 2D Google street map (default; the `Waypoint` view)
//   '3d'     – Google Earth 3D tiles (the shared global Cesium viewer)
// The `Search` and `Waypoint` buttons both return to the 2D street map
// (the entry state).
const viewMode = ref('street');
const showRoutePanel = ref(false);
const showSearchPanel = ref(false);

const mapTypeId = computed(() => 'roadmap');

// Only one of Search / Waypoint / Route may be visible at a time: opening
// one hides the others' popups. In 3D, opening the list stops any preview
// and cancels the waypoint focus (disks hide); the blue overlay dots and
// the spline stay visible in every 3D state.
function onClickRoute() {
  if (controlsLocked.value) return; // locked during preview / save flights
  const opening = !showRoutePanel.value;
  showRoutePanel.value = opening;
  if (opening) {
    showSearchPanel.value = false;
    showWaypointHint.value = false;
    ensureWaypointDefaults();
    if (is3d.value) {
      routeScene.stopPreview();
      cancelFocus();
    }
  }
}

function onClickSearch() {
  if (controlsLocked.value) return; // locked during preview / save flights
  // Address search lives on the 2D map: leave 3D first if needed.
  if (!showSearchPanel.value && is3d.value) viewMode.value = 'street';
  showSearchPanel.value = !showSearchPanel.value;
  if (showSearchPanel.value) {
    showRoutePanel.value = false;
    showWaypointHint.value = false;
  }
}

// ── Waypoint picking (green reminder + numbered blue rectangles) ──────────
const showWaypointHint = ref(false);
// Maintained waypoint list; indices start at 1 and increment per click.
const waypoints = ref([]);

function onWaypointClick() {
  if (controlsLocked.value) return; // locked during preview / save flights
  const arming = !showWaypointHint.value;
  // Waypoint picking happens on the 2D map: leave 3D first if needed.
  if (arming && is3d.value) viewMode.value = 'street';
  showWaypointHint.value = arming;
  if (arming) {
    showSearchPanel.value = false;
    showRoutePanel.value = false;
  }
}

function onMapClick({ lat, lng }) {
  if (!showWaypointHint.value) return;
  const index = waypoints.value.length + 1;
  // Each waypoint card carries its own position / speed / camera values.
  waypoints.value.push({
    id: ++wpSeq,
    index,
    lat,
    lng,
    alt: WP_DEFAULT_ALT_M,
    speed: WP_DEFAULT_SPEED_MPS,
    camYaw: 0,
    camPitch: WP_DEFAULT_CAM_PITCH_DEG,
    camRoll: 0,
  });
  // Redraw circles + the spline link so both always match the list.
  // Always blue here: red is reserved for an active press.
  mapViewRef.value?.redrawWaypointMarkers(waypoints.value, null);
  // One reminder per waypoint: hide it once the user has clicked.
  showWaypointHint.value = false;
}

// The MapView is recreated when leaving 3D and coming back — redraw all
// maintained waypoint circles and the spline link.
function onMapReady() {
  mapViewRef.value?.redrawWaypointMarkers(waypoints.value, null);
  scheduleTilePrefetch();
}

// ── Route panel: draggable waypoint list ──────────────────────────────────
let wpSeq = 0; // stable row id (Vue :key) independent of the position index

// Default waypoint values, used both when a waypoint is created and to
// backfill any missing field when the Route list is opened.
const WP_DEFAULT_ALT_M = 150;        // cruise altitude
const WP_DEFAULT_SPEED_MPS = 8.0;    // same as the Takeoff/Landing auto speed
const WP_SPEED_MAX_MPS = 100 / 3.6;  // ±100 km/h expressed in m/s (negative = fly backward)
const WP_DEFAULT_CAM_PITCH_DEG = -90; // nadir: look straight down

// Fill in any missing waypoint field with its default value.
function ensureWaypointDefaults() {
  for (const wp of waypoints.value) {
    if (wp.alt == null || isNaN(wp.alt)) wp.alt = WP_DEFAULT_ALT_M;
    if (wp.speed == null || isNaN(wp.speed)) wp.speed = WP_DEFAULT_SPEED_MPS;
    if (wp.camYaw == null || isNaN(wp.camYaw)) wp.camYaw = 0;
    if (wp.camPitch == null || isNaN(wp.camPitch)) wp.camPitch = WP_DEFAULT_CAM_PITCH_DEG;
    if (wp.camRoll == null || isNaN(wp.camRoll)) wp.camRoll = 0;
  }
}

function fmtCoord(v, digits = 4) {
  const n = Number(v);
  return isNaN(n) ? '' : n.toFixed(digits);
}

// Wrap an angle into (-180, 180].
function normAngle(v) {
  return ((((v + 180) % 360) + 360) % 360) - 180;
}

// Edit one field of a waypoint card directly in the Route list: commit on
// blur or Enter. Position / speed keep 4 decimals, camera angles 2. For
// lat/lon the blue circle moves to the new position and the spline redraws.
function onEditCoord(event, pos, field) {
  const wp = waypoints.value[pos];
  if (!wp) return;
  const digits = field.startsWith('cam') ? 2 : 4;
  let v = parseFloat(event.target.value);
  if (isNaN(v)) {
    event.target.value = fmtCoord(wp[field], digits);
    return;
  }
  if (field === 'lat') v = Math.max(-90, Math.min(90, v));
  else if (field === 'lng') v = Math.max(-180, Math.min(180, v));
  else if (field === 'alt') v = Math.max(0, Math.min(100000, v));
  else if (field === 'speed') v = Math.max(-WP_SPEED_MAX_MPS, Math.min(WP_SPEED_MAX_MPS, v));
  else if (field === 'camPitch') v = Math.max(-90, Math.min(90, v));
  else v = normAngle(v); // camYaw / camRoll
  wp[field] = v;
  event.target.value = fmtCoord(v, digits);
  // The preview flight flies at the shared cruise speed: keep it in sync
  // with the waypoint row edited last (same value the V disk mode trims).
  if (field === 'speed') routeScene.cruiseSpeedMps.value = v;
  // Only the horizontal position affects the map circles / spline.
  if (field === 'lat' || field === 'lng') {
    mapViewRef.value?.redrawWaypointMarkers(waypoints.value, null);
  }
}

// Card height (78px) + list gap (6px) — keep in sync with the CSS below so
// the pointer delta maps 1:1 onto row positions while dragging.
const WP_ROW_HEIGHT = 84;
const drag = ref(null); // { startPos, curPos, startY, offset }

// Waypoint row whose cancel icon is currently visible (clicked row).
const selectedWpId = ref(null);

function onRowPointerDown(event, pos) {
  if (event.button !== 0) return;
  event.preventDefault();
  selectedWpId.value = waypoints.value[pos] ? waypoints.value[pos].id : null;
  // The clicked row's waypoint turns red on the map.
  mapViewRef.value?.redrawWaypointMarkers(waypoints.value, selectedWpId.value);
  // 3D: selecting a row flies the virtual drone to that waypoint. The HUD
  // rows read the shared drone/gimbal state, so they update immediately,
  // and the sim loop re-slaves the Cesium camera to the new position with
  // the current gimbal angles on the next frame.
  if (viewMode.value === '3d') {
    const wp = waypoints.value[pos];
    if (wp) {
      drone.lat = wp.lat;
      drone.lon = wp.lng;
    }
  }
  drag.value = { startPos: pos, curPos: pos, startY: event.clientY, offset: 0 };
  window.addEventListener('pointermove', onRowPointerMove);
  window.addEventListener('pointerup', onRowPointerUp);
}

function onRowPointerMove(event) {
  if (!drag.value) return;
  drag.value.offset = event.clientY - drag.value.startY;
  const last = waypoints.value.length - 1;
  const target = Math.max(0, Math.min(last, drag.value.startPos + Math.round(drag.value.offset / WP_ROW_HEIGHT)));
  if (target !== drag.value.curPos) {
    const [item] = waypoints.value.splice(drag.value.curPos, 1);
    waypoints.value.splice(target, 0, item);
    drag.value.curPos = target;
  }
}

function onRowPointerUp() {
  window.removeEventListener('pointermove', onRowPointerMove);
  window.removeEventListener('pointerup', onRowPointerUp);
  if (!drag.value) return;
  drag.value = null;
  // Indices are positional: renumber 1..N and refresh the numbers drawn
  // inside the blue circles + the spline link on the map.
  waypoints.value.forEach((wp, i) => {
    wp.index = i + 1;
  });
  // Release: circles back to blue; the spline matches the final order.
  mapViewRef.value?.redrawWaypointMarkers(waypoints.value, null);
}

// Remove the waypoint whose cancel icon was clicked; renumber 1..N and
// redraw the map circles + B-spline link.
function onRemoveWaypoint(id) {
  const at = waypoints.value.findIndex((w) => w.id === id);
  if (at === -1) return;
  waypoints.value.splice(at, 1);
  waypoints.value.forEach((w, i) => {
    w.index = i + 1;
  });
  selectedWpId.value = null;
  mapViewRef.value?.redrawWaypointMarkers(waypoints.value, selectedWpId.value);
}

// Pressing a waypoint circle on the map selects it (the cancel icon shows
// on its Route list row); the MapView turns the circle red itself.
function onWaypointPress(id) {
  selectedWpId.value = id;
}

// Releasing the left mouse button on a waypoint circle (with or without a
// drag) just redraws the B-spline link to match the final positions.
function onWaypointRelease() {
  mapViewRef.value?.redrawWaypointPath(waypoints.value);
}

// Live drag of the selected (red) circle on the map: update the stored
// coordinates (the Route list row follows reactively) and re-shape the
// B-spline link without recreating the marker being dragged.
function onWaypointMove({ id, lat, lng }) {
  const wp = waypoints.value.find((w) => w.id === id);
  if (!wp) return;
  wp.lat = lat;
  wp.lng = lng;
  mapViewRef.value?.redrawWaypointPath(waypoints.value);
}

// ── Search popup (address finding) ────────────────────────────────────────
const mapViewRef = ref(null);
const searchQuery = ref('');
const searchResults = ref([]);
const searchError = ref('');
// True while a search-popup text query is in flight; the next poisFound
// event then fills the popup list (waypoint searches leave it untouched).
const searchBusy = ref(false);
// True once at least one query has been submitted (gates the
// "No results found." hint so it never shows while merely typing).
const hasSearched = ref(false);

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
    mapViewRef.value.panTo(loc.lat(), loc.lng());
    // Mark the picked address with Google's default pin on the map.
    mapViewRef.value.setSelectionMarker(loc.lat(), loc.lng());
  }
}

// ── Waypoint plumbing ─────────────────────────────────
function onMapCenterChange({ lat, lng }) {
  drone.lat = lat;
  drone.lon = lng;
  scheduleTilePrefetch();
}

function onMapZoomChange(alt) {
  drone.alt = Math.max(0, Math.min(100000, alt));
  scheduleTilePrefetch();
}

// ── 3D-tile prefetch while the 2D map is showing ──────────────────────────
// The shared Cesium canvas keeps rendering (opacity 0) underneath the 2D
// map; aiming its hidden camera at the current view streams/caches the
// photorealistic tiles ahead of the 2D→3D hand-off. Throttled, and only
// while in 2D (in 3D the sim loop owns the camera).
let prefetchTimer = null;
function scheduleTilePrefetch() {
  if (is3d.value || prefetchTimer) return;
  prefetchTimer = setTimeout(() => {
    prefetchTimer = null;
    if (!is3d.value) routeScene.prefetchTiles(drone.lat, drone.lon, drone.alt);
  }, 250);
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
    // Address search popup: order results by distance to the cursor's
    // current map position (closest first).
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
  console.error('[RoutePlanningView] poisError:', message);
  if (searchBusy.value) {
    searchBusy.value = false;
    searchResults.value = [];
    searchError.value = message;
  }
}

// ── Right dock: Search + Waypoint + Steer + Route (same in every mode) ──
function registerRightDock() {
  registerRight({
    id: 'search',
    icon: 'MENU_SEARCH',
    titleKey: 'routeplanningview.search',
    active: showSearchPanel.value,
    onClick: onClickSearch,
  });
  // No waypoint editing panel on this page: the button arms the green
  // "click the map to add a waypoint" reminder instead.
  registerRight({
    id: 'waypoint',
    render: () => h(DockButton, {
      icon: 'MENU_LOCATION',
      titleKey: 'aerialview.waypoint',
      size: 35,
      active: showWaypointHint.value,
      disabled: controlsLocked.value,
      onClick: onWaypointClick,
    }),
  });
  registerRight({
    id: 'steer',
    icon: 'MENU_CONTROL_STICK',
    titleKey: 'routeplanningview.steer',
    active: is3d.value,
    onClick: onClickSteer,
  });
  registerRight({
    id: 'route',
    icon: 'MENU_LIST',
    titleKey: 'routeplanningview.route',
    active: showRoutePanel.value,
    onClick: onClickRoute,
  });
  registerRight({
    // The single Preview button sits below Route: renders the whole route
    // on screen at exact 30 fps (offline pass, every frame fully rendered)
    // and saves it as a 16:9 mp4.
    id: 'preview',
    icon: 'MENU_PREVIEW',
    titleKey: 'routeplanningview.preview',
    active: routeScene.saving.value,
    onClick: onClickSave,
  });
}

// ── Steer mode: 3D nadir overview + two-stage waypoint focus ──────────────
// Steer is a three-state cycle:
//   2D street  -> 3D nadir overview (same center + scale as the 2D map,
//                 blue dots + B-spline overlay)
//   focused    -> roll back both animation stages to the nadir overview
//   overview   -> back to the 2D street map
// Clicking a blue dot in 3D starts the focus animation; afterwards the
// Flight / Gimbal disks edit that waypoint (position / speed / angles).
const focusedWpId = ref(null);
let overviewPose = null;   // 3D nadir overview pose captured on first focus
let steerTweenRaf = null;  // running drone-state tween (focus / rollback)
let pickCleanup = null;    // 3D overlay waypoint click handler teardown

function onClickSteer() {
  if (controlsLocked.value) return; // locked during preview / save flights
  routeScene.stopPreview();
  if (!is3d.value) {
    // 2D -> 3D nadir overview (the watch(is3d) entry sets center/scale).
    showRoutePanel.value = false;
    viewMode.value = '3d';
    return;
  }
  if (focusedWpId.value != null || steerTweenRaf) {
    // Focused on a waypoint (or mid-animation): roll back both stages.
    rollbackFocus();
    return;
  }
  // Plain nadir overview: leave 3D back to the 2D street map.
  viewMode.value = 'street';
}

function cancelSteerTween() {
  if (steerTweenRaf) {
    cancelAnimationFrame(steerTweenRaf);
    steerTweenRaf = null;
  }
}

// Animate the camera by tweening the drone state: the sim loop re-slaves
// the Cesium camera to it every frame (cubic ease-in-out).
function tweenDrone(to, durationMs, onDone) {
  cancelSteerTween();
  const from = { lat: drone.lat, lon: drone.lon, alt: drone.alt };
  const t0 = performance.now();
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const frame = (now) => {
    const f = Math.min(1, (now - t0) / durationMs);
    const k = ease(f);
    drone.lat = from.lat + (to.lat - from.lat) * k;
    drone.lon = from.lon + (to.lon - from.lon) * k;
    drone.alt = from.alt + (to.alt - from.alt) * k;
    if (f < 1) steerTweenRaf = requestAnimationFrame(frame);
    else {
      steerTweenRaf = null;
      if (onDone) onDone();
    }
  };
  steerTweenRaf = requestAnimationFrame(frame);
}

// Drop the focus state without any rollback animation (Route list opened,
// leaving 3D, ...): disks hide, the overlay dot turns back to blue.
function cancelFocus() {
  cancelSteerTween();
  routeScene.setFocusWaypoint(null);
  routeScene.showFlight.value = false;
  routeScene.showCamera.value = false;
  focusedWpId.value = null;
  selectedWpId.value = null;
  routeScene.showRouteOverlay(waypoints.value, null);
}

// Two-stage focus animation on a blue overlay dot:
//   stage 1 — horizontal glide at unchanged height until the waypoint is
//             centered; stage 2 — zoom down to the waypoint's own height
//             (150 m by default).
// Afterwards the dots + spline hide and the Flight + Gimbal disks show,
// editing THIS waypoint.
function startFocus(id) {
  if (routeScene.previewActive.value) return;
  const wp = waypoints.value.find((w) => w.id === id);
  if (!wp) return;
  if (wp.alt == null || isNaN(wp.alt)) wp.alt = WP_DEFAULT_ALT_M;
  cancelSteerTween();
  routeScene.setFocusWaypoint(null);
  routeScene.showFlight.value = false;
  routeScene.showCamera.value = false;
  // Remember the overview pose once so Steer can roll back to it.
  if (!overviewPose) overviewPose = { lat: drone.lat, lon: drone.lon, alt: drone.alt };
  focusedWpId.value = id;
  selectedWpId.value = id;
  routeScene.showRouteOverlay(waypoints.value, id);
  // Nadir, north-up while the animation runs.
  drone.heading = 0;
  gimbal.yaw = 0;
  gimbal.pitch = -90;
  gimbal.roll = 0;
  const cruiseAlt = drone.alt;
  // Stage 2 ends at the waypoint's own height (default 150 m).
  const diveAlt = Math.max(1, wp.alt);
  const dist = haversineMeters(drone.lat, drone.lon, wp.lat, wp.lng);
  const glideMs = Math.max(700, Math.min(2200, Math.round(dist * 3)));
  tweenDrone({ lat: wp.lat, lon: wp.lng, alt: cruiseAlt }, glideMs, () => {
    tweenDrone({ lat: wp.lat, lon: wp.lng, alt: diveAlt }, 1100, () => {
      // Arrived: the dots + spline hide, the camera takes the waypoint's
      // own gimbal angles, and the disks start editing it.
      routeScene.hideRouteOverlay();
      gimbal.yaw = wp.camYaw;
      gimbal.pitch = wp.camPitch;
      gimbal.roll = wp.camRoll;
      routeScene.setFocusWaypoint(wp);
      routeScene.showFlight.value = true;
      routeScene.showCamera.value = true;
    });
  });
}

// Reverse of startFocus: zoom back up to the overview height, then glide
// horizontally back to the overview center (blue dots + B-spline remain).
function rollbackFocus() {
  cancelSteerTween();
  routeScene.setFocusWaypoint(null);
  routeScene.showFlight.value = false;
  routeScene.showCamera.value = false;
  focusedWpId.value = null;
  selectedWpId.value = null;
  routeScene.showRouteOverlay(waypoints.value, null);
  drone.heading = 0;
  gimbal.yaw = 0;
  gimbal.pitch = -90;
  gimbal.roll = 0;
  const back = overviewPose || { lat: drone.lat, lon: drone.lon, alt: drone.alt };
  tweenDrone({ lat: drone.lat, lon: drone.lon, alt: back.alt }, 1100, () => {
    tweenDrone(back, 1200, () => {
      overviewPose = null;
    });
  });
}

// Cesium entity pick of a blue overlay dot (registered while in 3D).
function onOverlayWpClick(id) {
  if (!is3d.value || routeScene.previewActive.value) return;
  if (focusedWpId.value === id && !steerTweenRaf) return; // already there
  startFocus(id);
}

const showPreviewHint = ref(false);
let previewHintTimer = null;

// Green top-center login reminder after the render completes (same style
// and content pattern as 3D Exploration -> 3D Aerial).
const showAuthNotice = ref(false);
let authNoticeTimer = null;

// Ask the user where to save the clip: the native "Save As" dialog of the
// File System Access API; browsers without it fall back to a plain download
// anchor. A cancelled dialog keeps nothing — the render can simply be
// started again (the tile cache makes reruns fast).
async function saveClipToFile(clip) {
  const pad = (n) => String(n).padStart(2, '0');
  const d = new Date();
  const name = `route-preview-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.${clip.ext}`;
  const mime = clip.ext === 'mp4' ? 'video/mp4' : 'video/webm';
  if (typeof window.showSaveFilePicker === 'function') {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: name,
        types: [{ description: 'Video', accept: { [mime]: [`.${clip.ext}`] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(clip.blob);
      await writable.close();
      return;
    } catch (err) {
      if (err && err.name === 'AbortError') return; // user cancelled
      // Any other failure falls through to the anchor download below.
    }
  }
  const url = URL.createObjectURL(clip.blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

async function onClickSave() {
  if (routeScene.saving.value) return;
  if (waypoints.value.length < 2) {
    // Same green reminder as Preview: a route needs >= 2 waypoints.
    showPreviewHint.value = true;
    clearTimeout(previewHintTimer);
    previewHintTimer = setTimeout(() => {
      showPreviewHint.value = false;
    }, 2500);
    return;
  }
  // The offline renderer walks the 3D camera along the route: enter 3D so
  // the render pass (and its frame-counter overlay) is visible.
  if (!is3d.value) viewMode.value = '3d';
  // Preview renders the whole route (origin -> destination) at exact 30 fps
  // into a 16:9 mp4 (MediaRecorder capture flight only as a fallback when
  // WebCodecs is unavailable).
  const ok = await routeScene.saveClip(waypoints.value);
  // The flight hid the route overlay; restore it in the 3D overview.
  if (is3d.value && !routeScene.previewActive.value) {
    routeScene.showRouteOverlay(waypoints.value, null);
  }
  if (!ok) return; // aborted or failed: no clip was produced
  const clip = routeScene.takeLastClip();
  if (!clip) return;
  // Login gate: once the render is done, anonymous users get the green
  // top-center reminder instead of the video file.
  if (!isAuthenticated.value) {
    showAuthNotice.value = true;
    clearTimeout(authNoticeTimer);
    authNoticeTimer = setTimeout(() => { showAuthNotice.value = false; }, 6000);
    return;
  }
  await saveClipToFile(clip);
}

onMounted(() => {
  checkGoogleConnection();
  checkCesiumConnection();
  connectionCheckInterval = setInterval(() => {
    checkGoogleConnection();
    checkCesiumConnection();
  }, 10000);

  // The right sidebar (Search + Waypoint + Steer + Route + Preview) is the
  // same in every view mode, so it is registered once and never swapped.
  // (The old Map button is gone: Search and Waypoint already return to the
  // 2D street map, the page's entry state.)
  registerRightDock();

  // Keep dock buttons' active (green-border) state in sync. Preview greens
  // while settling / downloading the clip; Search / Waypoint / Steer / Route
  // are mutually exclusive by construction (each handler closes the others'
  // panels).
  watch(
    [viewMode, showRoutePanel, showSearchPanel, showWaypointHint, previewActive, routeScene.showFlight, routeScene.showCamera, routeScene.saving],
    () => {
      const savingNow = routeScene.saving.value;
      const bsv = rightItems.find((i) => i.id === 'preview');
      if (bsv) bsv.active = savingNow;

      const bs = rightItems.find((i) => i.id === 'search');
      if (bs) {
        bs.active = showSearchPanel.value;
        bs.disabled = controlsLocked.value;
      }
      const bt = rightItems.find((i) => i.id === 'steer');
      if (bt) {
        bt.active = is3d.value;
        bt.disabled = controlsLocked.value;
      }
      const br = rightItems.find((i) => i.id === 'route');
      if (br) {
        br.active = showRoutePanel.value;
        br.disabled = controlsLocked.value;
      }
    }
  );

  // Sim loop lifecycle: 3D entry is always the nadir overview at the 2D
  // map's center and scale (drone.lat/lon/alt track the 2D map), with the
  // blue dots + B-spline overlay; exit returns to the 2D street map at the
  // same center and scale.
  watch(is3d, (now3d) => {
    if (now3d) {
      routeScene.startLoop();
      ensureWaypointDefaults();
      showSearchPanel.value = false;
      showWaypointHint.value = false;
      showRoutePanel.value = false;
      focusedWpId.value = null;
      overviewPose = null;
      routeScene.setFocusWaypoint(null);
      routeScene.showFlight.value = false; // no disks in the nadir overview
      routeScene.showCamera.value = false;
      // A preview started from 2D already hid the overlay: don't re-show it
      // (same for an offline Save render pass, which hides it itself).
      if (!routeScene.previewActive.value && !routeScene.saving.value) {
        routeScene.showRouteOverlay(waypoints.value, null);
      }
      if (pickCleanup) pickCleanup();
      pickCleanup = routeScene.onWaypointPick(onOverlayWpClick);
      if (routeScene.previewActive.value) return; // preview owns the camera
      // The 2D map altitude is Google's nominal model altitude; convert
      // it to the true camera altitude that shows the SAME ground scale
      // in the 3D nadir view (otherwise the 3D view looks ~4-6x more
      // zoomed in).
      drone.alt = routeScene.trueAltForMapScale(drone.alt, drone.lat);
      drone.heading = 0;
      gimbal.yaw = 0;
      gimbal.pitch = -90; // look straight down, satellite style
      gimbal.roll = 0;
    } else {
      const wasPreview = routeScene.previewActive.value;
      if (pickCleanup) {
        pickCleanup();
        pickCleanup = null;
      }
      cancelSteerTween();
      routeScene.stopPreview();
      routeScene.stopLoop();
      routeScene.hideRouteOverlay();
      routeScene.setFocusWaypoint(null);
      routeScene.showFlight.value = false;
      routeScene.showCamera.value = false;
      focusedWpId.value = null;
      selectedWpId.value = null;
      // Leaving from a focused view: reopen the 2D map at the nadir
      // overview's center and scale (where Steer was entered).
      if (overviewPose) {
        drone.lat = overviewPose.lat;
        drone.lon = overviewPose.lon;
        drone.alt = overviewPose.alt;
        overviewPose = null;
      }
      // Convert the true 3D camera altitude back to the 2D map model
      // altitude so the 2D map reopens at the same ground scale (skipped
      // after a preview: the altitude then is a true flight height).
      if (!wasPreview) drone.alt = routeScene.modelAltForMapScale(drone.alt, drone.lat);
      scheduleTilePrefetch();
    }
  });

  // Keep the 3D route overlay in sync with every waypoint change (Route
  // list card edits / reorders / removals). While a waypoint is focused
  // the overlay is hidden, so skip updates then — and never re-show it in
  // the middle of a preview / Save flight (it hides for the whole flight).
  watch(
    waypoints,
    () => {
      if (is3d.value && focusedWpId.value == null && !routeScene.previewActive.value && !routeScene.saving.value) {
        routeScene.showRouteOverlay(waypoints.value, null);
      }
    },
    { deep: true }
  );
});

onUnmounted(() => {
  if (connectionCheckInterval) clearInterval(connectionCheckInterval);
  if (previewHintTimer) clearTimeout(previewHintTimer);
  if (pickCleanup) pickCleanup();
  cancelSteerTween();
  routeScene.stopPreview(); // aborts a running preview / Save capture flight
  routeScene.stopLoop();
  // The overlay entities live in the SHARED global viewer: clear them so
  // they never linger on the other pages after leaving Route Planning.
  routeScene.hideRouteOverlay();
  clear();
});
</script>

<template>
  <ViewComposer
    :right-items="rightItems"
    :show-flight="showFlightDisk"
    :show-camera="showCameraDisk"
    :show-hud="showHudDashboard"
    :flight-modes="FLIGHT_MODES"
    :flight="flight"
    :camera="camera"
    @flightMove="onFlightMove"
    @flightStop="onFlightStop"
    @flightModeChange="onFlightModeChange"
    @cameraMove="onCameraMove"
    @cameraStop="onCameraStop"
    @cameraModeChange="onCameraModeChange"
  >
    <template #top-overlay>
      <ConnectionError :visible="showConnectionError" :message="connectionMessage" />

      <!-- Reminders live centered in the shell top bar. -->
      <Teleport to="#shell-notices">
        <!-- Reminder while waypoint picking is armed -->
        <div v-if="showWaypointHint" class="shell-notice">
          {{ t('routeplanningview.waypoint_hint') }}
        </div>

        <!-- Reminder: preview needs >= 2 waypoints -->
        <div v-if="showPreviewHint" class="shell-notice">
          {{ t('routeplanningview.preview_need_waypoints') }}
        </div>

        <!-- Reminder: the preview video needs a login
             (same gate as 3D Exploration -> 3D Aerial) -->
        <div v-if="showAuthNotice" class="shell-notice">
          {{ t('routeplanningview.auth_notice_preview') }}
        </div>
      </Teleport>

      <!-- Spinning circle: the preview/save flight is stuck waiting for
           the Google 3D tiles of the current view to download + render;
           during an offline Save the frame counter shows the progress. -->
      <div v-if="showTileSpinner" class="tile-wait-overlay">
        <div class="tile-wait-box">
          <div class="tile-wait-spinner" />
          <div v-if="routeScene.renderProgress.value" class="tile-wait-text">
            {{ routeScene.renderProgress.value.frame }} / {{ routeScene.renderProgress.value.total }}
          </div>
        </div>
      </div>

      <!-- Address search popup -->
      <div v-if="showSearchPanel" class="search-panel">
        <form class="search-panel__row" @submit.prevent="onSearchSubmit">
          <input
            v-model="searchQuery"
            class="search-panel__input"
            type="text"
            :placeholder="t('routeplanningview.search_placeholder')"
          />
          <button
            class="search-panel__btn"
            type="submit"
            :title="t('routeplanningview.search')"
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
          {{ t('routeplanningview.no_results') }}
        </div>
      </div>

      <!-- Route popup (hidden while a preview flight is running) -->
      <div v-if="showRoutePanel && !previewActive" class="route-panel">
        <div class="route-panel__title">{{ t('routeplanningview.panel_title') }}</div>
        <div v-if="waypoints.length" class="route-panel__list">
          <div v-for="(wp, pos) in waypoints" :key="wp.id" class="route-panel__row">
            <!-- Slot index: stays put while the rows are dragged. -->
            <span class="route-panel__idx">{{ pos + 1 }}</span>
            <div
              class="route-panel__card"
              :class="{ 'route-panel__card--dragging': drag && drag.curPos === pos }"
              @pointerdown="onRowPointerDown($event, pos)"
            >
              <!-- Position: editable lat/lon/alt (editing lat/lon moves the
                   blue circle). The stop keeps text selection/caret clicks
                   from starting a row drag. 4 decimals. -->
              <div class="route-panel__line">
                <span class="route-panel__label">{{ t('routeplanningview.position') }}</span>
                <span class="route-panel__unit">lat:</span>
                <input
                  class="route-panel__coord route-panel__coord--lat"
                  :value="fmtCoord(wp.lat)"
                  @pointerdown.stop
                  @keyup.enter="$event.target.blur()"
                  @change="onEditCoord($event, pos, 'lat')"
                />
                <span class="route-panel__sep">|</span>
                <span class="route-panel__unit">lon:</span>
                <input
                  class="route-panel__coord"
                  :value="fmtCoord(wp.lng)"
                  @pointerdown.stop
                  @keyup.enter="$event.target.blur()"
                  @change="onEditCoord($event, pos, 'lng')"
                />
                <span class="route-panel__sep">|</span>
                <span class="route-panel__unit">alt:</span>
                <input
                  class="route-panel__coord route-panel__coord--alt"
                  :value="fmtCoord(wp.alt)"
                  @pointerdown.stop
                  @keyup.enter="$event.target.blur()"
                  @change="onEditCoord($event, pos, 'alt')"
                />
              </div>
              <!-- Speed along the trajectory. Editable, 4 decimals. -->
              <div class="route-panel__line">
                <span class="route-panel__label">{{ t('routeplanningview.speed') }}</span>
                <span class="route-panel__unit">v:</span>
                <input
                  class="route-panel__coord"
                  :value="fmtCoord(wp.speed)"
                  @pointerdown.stop
                  @keyup.enter="$event.target.blur()"
                  @change="onEditCoord($event, pos, 'speed')"
                />
              </div>
              <!-- Camera (gimbal) angles. Editable, 2 decimals. -->
              <div class="route-panel__line">
                <span class="route-panel__label">{{ t('routeplanningview.camera') }}</span>
                <span class="route-panel__unit">yaw:</span>
                <input
                  class="route-panel__coord route-panel__coord--ang"
                  :value="fmtCoord(wp.camYaw, 2)"
                  @pointerdown.stop
                  @keyup.enter="$event.target.blur()"
                  @change="onEditCoord($event, pos, 'camYaw')"
                />
                <span class="route-panel__sep">|</span>
                <span class="route-panel__unit">pitch:</span>
                <input
                  class="route-panel__coord route-panel__coord--pitch"
                  :value="fmtCoord(wp.camPitch, 2)"
                  @pointerdown.stop
                  @keyup.enter="$event.target.blur()"
                  @change="onEditCoord($event, pos, 'camPitch')"
                />
                <span class="route-panel__sep">|</span>
                <span class="route-panel__unit">roll:</span>
                <input
                  class="route-panel__coord route-panel__coord--ang"
                  :value="fmtCoord(wp.camRoll, 2)"
                  @pointerdown.stop
                  @keyup.enter="$event.target.blur()"
                  @change="onEditCoord($event, pos, 'camRoll')"
                />
              </div>
            </div>
            <button
              class="route-panel__cancel"
              :class="{ 'route-panel__cancel--visible': selectedWpId === wp.id }"
              :title="t('routeplanningview.remove_waypoint')"
              @click="onRemoveWaypoint(wp.id)"
            >
              <img :src="cancelIcon" alt="" draggable="false" />
            </button>
          </div>
        </div>
        <div v-else class="route-panel__empty">{{ t('routeplanningview.no_waypoints') }}</div>
      </div>
    </template>
    <template #background>
      <MapView
        v-if="viewMode !== '3d'"
        ref="mapViewRef"
        class="view-composer__background"
        :map-type-id="mapTypeId"
        :lat="drone.lat"
        :lon="drone.lon"
        :alt="drone.alt"
        :heading="drone.heading"
        :is-picking="showWaypointHint"
        :show-drone-marker="false"
        @mapReady="onMapReady"
        @centerChange="onMapCenterChange"
        @zoomChange="onMapZoomChange"
        @mapClick="onMapClick"
        @waypointPress="onWaypointPress"
        @waypointMove="onWaypointMove"
        @waypointRelease="onWaypointRelease"
        @poisFound="onPoisFound"
        @poisError="onPoisError"
      />
    </template>
  </ViewComposer>
</template>

<style scoped>
:deep(.view-composer__background) {
  position: absolute;
  inset: 0;
  z-index: 0;
  pointer-events: auto;
}

/* Tile-wait spinner: preview/save freeze with this spinning circle until
   the 3D tiles of the current view are fully downloaded and rendered. */
.tile-wait-overlay {
  position: fixed;
  inset: 0;
  z-index: 120;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
}

.tile-wait-box {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
}

.tile-wait-text {
  font: 600 16px/1 system-ui, sans-serif;
  color: #fff;
  letter-spacing: 0.5px;
  text-shadow: 0 1px 4px rgba(0, 0, 0, 0.6);
}

.tile-wait-spinner {
  width: 64px;
  height: 64px;
  border-radius: 50%;
  border: 5px solid rgba(255, 255, 255, 0.3);
  border-top-color: #4ade80;
  animation: tile-wait-spin 0.9s linear infinite;
}

@keyframes tile-wait-spin {
  to {
    transform: rotate(360deg);
  }
}

/* Translucent rounded rectangles styled after the Flight / Gimbal disk
   circles (same frosted-white palette). */
.route-panel,
.search-panel {
  position: fixed;
  top: 50%;
  transform: translateY(-50%);
  border-radius: 18px;
  background: rgba(255, 255, 255, 0.18);
  backdrop-filter: blur(6px);
  border: 2px solid rgba(255, 255, 255, 0.45);
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.2), inset 0 0 20px rgba(255, 255, 255, 0.08);
  z-index: 50;
  padding: 16px 20px;
  box-sizing: border-box;
}

.route-panel {
  /* Hugged to the right sidebar with a gap (24px page padding + 72px dock
     + 16px gap). Width shrinks to the content (index + "lat, lon" row). */
  right: 112px;
  width: fit-content;
  max-width: min(560px, 86vw);
  height: auto;
  max-height: min(420px, 70vh);
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.route-panel__list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  /* Reserve the scrollbar gutter up front so the shrink-wrapped panel
     is wide enough to contain the vertical scrollbar without squeezing
     the waypoint rows. */
  scrollbar-gutter: stable;
  padding-right: 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

/* Each waypoint row holds a grabbable card; drag it up/down to reorder.
   Card height 78px + 6px gap = WP_ROW_HEIGHT (84) in the script. */
.route-panel__row {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 8px;
}

.route-panel__idx {
  flex-shrink: 0;
  min-width: 22px;
  text-align: right;
  font-size: 0.85rem;
  color: rgba(30, 40, 60, 0.95);
  text-shadow: 0 1px 2px rgba(255, 255, 255, 0.5);
}

/* Reserved 20px slot between the row and the scrollbar so the panel width
   never jumps; the icon only shows for the clicked (selected) row. */
.route-panel__cancel {
  flex-shrink: 0;
  width: 20px;
  height: 20px;
  padding: 0;
  border: none;
  background: transparent;
  cursor: pointer;
  visibility: hidden;
}

.route-panel__cancel--visible {
  visibility: visible;
}

.route-panel__cancel img {
  display: block;
  width: 100%;
  height: 100%;
}

/* Editable fields inside the card lines. Left-aligned and sized to the
   widest value of each field so the value hugs its name (one space). */
.route-panel__coord {
  width: 9ch;
  height: 18px;
  box-sizing: border-box;
  padding: 0;
  border: none;
  background: transparent;
  font: inherit;
  color: inherit;
  text-align: left;
}

.route-panel__coord--lat {
  width: 8ch; /* -90.0000 */
}

.route-panel__coord--alt {
  width: 11ch; /* 100000.0000 */
}

.route-panel__coord--ang {
  width: 7ch; /* -180.00 */
}

.route-panel__coord--pitch {
  width: 6ch; /* -90.00 */
}

.route-panel__coord:focus {
  outline: 1px solid rgba(37, 99, 235, 0.5);
  border-radius: 3px;
}

/* Pipe separators: two character spaces on each side (line gap 4px +
   margin 4px per side). */
.route-panel__sep {
  margin: 0 4px;
}

/* Small field prefixes inside a card line (lat:, lon:, alt:, v:, yaw: ...). */
.route-panel__unit {
  flex-shrink: 0;
  color: rgba(30, 40, 60, 0.8);
}

/* Waypoint card: three lines — Position, Speed, Camera. Fixed height so
   the drag math (WP_ROW_HEIGHT) stays exact. */
.route-panel__card {
  flex: 1;
  min-width: 0;
  height: 78px;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 4px;
  padding: 0 12px;
  border: 1px solid rgba(37, 99, 235, 0.5);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.35);
  color: rgba(30, 40, 60, 0.95);
  font-size: 0.85rem;
  cursor: grab;
  user-select: none;
  -webkit-user-select: none;
  touch-action: none;
  transition: background 0.15s ease, border-color 0.15s ease;
}

.route-panel__card:hover {
  background: rgba(255, 255, 255, 0.55);
}

.route-panel__card--dragging {
  border-color: #2563eb;
  background: rgba(37, 99, 235, 0.15);
  cursor: grabbing;
}

/* One line inside the card: fixed label column + values. The gap between
   a variable name and its value is a single character space. */
.route-panel__line {
  height: 18px;
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 0.8rem;
  white-space: nowrap;
}

.route-panel__label {
  flex-shrink: 0;
  width: 62px;
  font-weight: 600;
  color: rgba(30, 40, 60, 0.8);
}

.route-panel__empty {
  font-size: 0.85rem;
  color: rgba(30, 40, 60, 0.75);
}

.route-panel__title {
  font-size: 1rem;
  font-weight: 700;
  color: rgba(30, 40, 60, 0.95);
  text-shadow: 0 1px 2px rgba(255, 255, 255, 0.5);
}

.search-panel {
  /* Hugged to the right sidebar with the same gap. */
  right: 112px;
  width: min(480px, 90vw);
  max-height: 70vh;
  display: flex;
  flex-direction: column;
  gap: 12px;
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
  .route-panel {
    right: 96px;
  }
  .search-panel {
    right: 96px;
  }
}
</style>
