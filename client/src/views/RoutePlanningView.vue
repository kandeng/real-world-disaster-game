<script setup>
import { onMounted, onUnmounted, h, ref, computed, watch, toRef, toRefs } from 'vue';
import { useI18n } from 'vue-i18n';
import ViewComposer from '@shared/_ViewComposer.vue';
import { MapView } from '@/2d_map/index.js';
import { useDrone } from '@shared-composables/useDrone.js';
import { useSessionState } from '@shared-composables/useSessionState.js';
import { useRouteScene3D } from '@shared-composables/useRouteScene3D.js';
import { useFlightCommands } from '@shared-composables/useFlightCommands.js';
import { useCameraCommands } from '@shared-composables/useCameraCommands.js';
import { useDockRegistry } from '@shared-composables/useDockRegistry.js';
import { useConnectionStatus, checkGoogleConnection, checkCesiumConnection } from '@shared-composables/useConnectionStatus.js';
import { useAuth } from '@shared-composables/useAuth.js';
import { useRoutes, takeRouteVideoSignal } from '@shared-composables/useRoutes.js';
import DockButton from '@shared/DockButton.vue';
import ConnectionError from '@shared/ConnectionError.vue';
import ConfigurableIcon from '@shared/ConfigurableIcon.vue';
import RouteVideoDialog from '@shared/RouteVideoDialog.vue';
import cancelIcon from '../../icons/cancel.svg';

const { t } = useI18n();
const { drone, gimbal } = useDrone();
const { session } = useSessionState();
// Altitude split: the 2D street-map zoom height (mapAlt) is a SEPARATE value
// from the true drone/camera altitude (drone.alt). They are reconciled only
// at the 3D<->2D boundary (watch(is3d)).
const mapAlt = toRef(session.view, 'mapAlt');
// Phase 2 (session-state migration): the route being edited lives in the
// session store, so unsaved waypoints + route meta survive page switches.
// toRefs yields drop-in refs — every existing `.value` usage (and the
// template v-models) keeps working unchanged.
const {
  waypoints,
  selectedWpId,
  sourceRouteId,
  title: routeTitle,
  description: routeDescription,
  createdAt: routeCreatedAt,
} = toRefs(session.route);
// Login state: the finished preview video is only handed out to logged-in
// users (same gate as the captures on 3D Exploration -> 3D Aerial).
const { isAuthenticated } = useAuth();
const { saveRoute, createRoute } = useRoutes();

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

// Phase 3 (session-state migration): this page's view context lives in the
// session store, so the active sub-view (Route panel / Search / Waypoint
// arming / Steer 3D), the search text and the 2D/3D mode survive page
// switches and are restored on return. The panel booleans are READ-ONLY
// views over session.view.route.subView; handlers switch subView instead.
//   'map'     neutral 2D street map (the entry state)
//   'search'  2D + search panel        'waypoint' 2D, picking armed
//   'route'   2D + route panel         'steer'    3D nadir overview
// ('steer' is the only 3D state, so entering 3D closes every panel by
// construction; Search / Waypoint both return to the 2D street map.)
const viewCtx = session.view.route;
const viewMode = computed(() => (viewCtx.subView === 'steer' ? '3d' : 'street'));
const showRoutePanel = computed(() => viewCtx.subView === 'route');
const showSearchPanel = computed(() => viewCtx.subView === 'search');

const mapTypeId = computed(() => 'roadmap');

// Only one of Search / Waypoint / Route may be visible at a time: opening
// one hides the others' popups. In 3D, opening the list stops any preview
// and cancels the waypoint focus (disks hide); the blue overlay dots and
// the spline stay visible in every 3D state.
function onClickRoute() {
  if (controlsLocked.value) return; // locked during preview / save flights
  if (showRoutePanel.value) {
    viewCtx.subView = 'map';
    return;
  }
  ensureWaypointDefaults();
  if (is3d.value) routeScene.stopPreview();
  // The route list lives on the 2D street map: leaving 'steer' makes the
  // street map (with the waypoint dots) the background, keeping the same
  // location and zoom level the user had in 3D. watch(is3d) handles the 3D
  // cleanup (stop loop / hide overlay) and the altitude conversion, and
  // onMapReady redraws the waypoint dots on the 2D map.
  viewCtx.subView = 'route';
}

function onClickSearch() {
  if (controlsLocked.value) return; // locked during preview / save flights
  // Address search lives on the 2D map: leaving 'steer' makes the street
  // map the background (watch(is3d) handles the 3D cleanup).
  viewCtx.subView = showSearchPanel.value ? 'map' : 'search';
  // Re-show the picked-address balloon when the search opens on a live 2D
  // map (after a 3D excursion the recreated map is handled by onMapReady).
  if (showSearchPanel.value && selectedLatLng.value) {
    mapViewRef.value?.setSelectionMarker(selectedLatLng.value.lat, selectedLatLng.value.lng);
  }
}

// Reset (same name / icon / behavior as the Play! page): throw away the
// current route entirely — waypoints, selection, title and the saved-route
// anchor — so the next save mints a brand-new route, then open the address
// search popup unchanged.
function onClickReset() {
  if (controlsLocked.value) return;
  waypoints.value = [];
  selectedWpId.value = null;
  sourceRouteId.value = null;
  routeTitle.value = '';
  routeDescription.value = '';
  mapViewRef.value?.redrawWaypointMarkers([], null);
  mapViewRef.value?.redrawWaypointPath([]);
  if (is3d.value) routeScene.hideRouteOverlay();
  onClickSearch();
}

// ── Waypoint picking (green reminder + numbered blue rectangles) ──────────
const showWaypointHint = computed(() => viewCtx.subView === 'waypoint');
// Maintained waypoint list (session.route.waypoints); indices start at 1
// and increment per click.

function onWaypointClick() {
  if (controlsLocked.value) return; // locked during preview / save flights
  // Waypoint picking happens on the 2D map: leaving 'steer' makes the street
  // map the background (watch(is3d) handles the 3D cleanup).
  viewCtx.subView = showWaypointHint.value ? 'map' : 'waypoint';
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
  // One reminder per waypoint: disarm picking once the user has clicked.
  viewCtx.subView = 'map';
}

// The MapView is recreated when leaving 3D and coming back — redraw all
// maintained waypoint circles and the spline link.
function onMapReady() {
  mapViewRef.value?.redrawWaypointMarkers(waypoints.value, null);
  if (showSearchPanel.value && selectedLatLng.value) {
    mapViewRef.value?.setSelectionMarker(selectedLatLng.value.lat, selectedLatLng.value.lng);
  }
  scheduleTilePrefetch();
}

// ── Route panel: draggable waypoint list ──────────────────────────────────
let wpSeq = session.route.waypoints.reduce((m, w) => Math.max(m, Number(w.id) || 0), 0); // stable row id (Vue :key) independent of the position index; derived from the carried list so restored waypoints never collide

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

// Waypoint row whose cancel icon is currently visible (clicked row):
// session.route.selectedWpId (red circle on the map).

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
const searchQuery = toRef(viewCtx, 'searchQuery');
// The picked address (red balloon), carried in the session store so it is
// re-shown after the map is recreated (3D excursion / page switch) — same
// convention as the Play! page's aerial view domain.
const selectedLatLng = toRef(viewCtx, 'selectionLatLng');
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
    selectedLatLng.value = { lat: loc.lat(), lng: loc.lng() };
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
  mapAlt.value = Math.max(0, Math.min(100000, alt));
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
    if (!is3d.value) routeScene.prefetchTiles(drone.lat, drone.lon, mapAlt.value);
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

// ── Right dock: Reset + Waypoint + Steer + Route (same in every mode) ──
function registerRightDock() {
  registerRight({
    id: 'reset',
    icon: 'MENU_RESET',
    titleKey: 'aerialview.reset',
    active: showSearchPanel.value,
    onClick: onClickReset,
  });
  // No waypoint editing panel on this page: the button arms the green
  // "click the map to add a waypoint" reminder instead.
  registerRight({
    id: 'waypoint',
    render: () => h(DockButton, {
      icon: 'MENU_LOCATION',
      titleKey: 'routeplanningview.waypoint2d',
      size: 35,
      active: showWaypointHint.value,
      disabled: controlsLocked.value,
      onClick: onWaypointClick,
    }),
  });
  registerRight({
    id: 'steer',
    icon: 'MENU_INSTRUMENT',
    titleKey: 'routeplanningview.finetune',
    active: is3d.value,
    onClick: onClickSteer,
  });
  registerRight({
    id: 'route',
    icon: 'MENU_MAP',
    titleKey: 'routeplanningview.route',
    active: showRoutePanel.value,
    onClick: onClickRoute,
  });
  registerRight({
    // The Video button sits below Route: it saves the current route to
    // Content -> Route (new route -> POST, route carried by Steer -> PUT)
    // and opens the video generation dialog, which renders the whole
    // route at exact 30 fps into a 16:9 mp4. This page is the ONLY host
    // of the dialog: Content -> Route -> Video jumps here and reuses
    // this very code path.
    id: 'video',
    icon: 'MENU_RECORDER',
    titleKey: 'routeplanningview.video',
    active: routeScene.saving.value || !!videoRoute.value,
    onClick: onClickVideo,
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
    // 2D -> 3D nadir overview (the watch(is3d) entry sets center/scale; the
    // route panel closes by construction — 'steer' is the only 3D state).
    viewCtx.subView = 'steer';
    return;
  }
  if (focusedWpId.value != null || steerTweenRaf) {
    // Focused on a waypoint (or mid-animation): roll back both stages.
    rollbackFocus();
    return;
  }
  // Plain nadir overview: leave 3D back to the 2D street map.
  viewCtx.subView = 'map';
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

// Green top-center login reminder (same style and content pattern as
// 3D Exploration -> 3D Aerial): saving the route + publishing the video
// both need a login.
const showAuthNotice = ref(false);
let authNoticeTimer = null;

// sourceRouteId (session.route): id of the saved route this editing
// session belongs to. Null = brand-new route (Case 1); set by the
// Content -> Route seeding (Case 2) or after the first successful save,
// so later saves update instead of duplicating.
// True while a POST/PUT /api/routes request is in flight (Save/Update
// button in the Route panel stays disabled meanwhile).
const routeSaving = ref(false);
// Saved route object handed to the video dialog (null = dialog closed).
const videoRoute = ref(null);
// routeTitle / routeDescription / routeCreatedAt (session.route): the Route
// panel inputs under the waypoint list, sent to the API on Save/Update (on
// create an empty title makes the server mint the default one); createdAt
// lets the video dialog show the route's own timestamp before any save.

// Label of the Save/Update button in the Route panel: Case 1 (no saved
// route yet) vs Case 2 (Content -> Route seeding or already saved once).
const saveRouteLabel = computed(() =>
  t(sourceRouteId.value != null ? 'routeplanningview.save_route_update' : 'routeplanningview.save_route_new')
);

// Shared Case 1 / Case 2 save used by the Route panel's Save/Update
// button and by the Video button. Returns the saved route, or null on
// failure (API unavailable).
async function saveCurrentRoute() {
  if (routeSaving.value) return null;
  const wps = waypoints.value.map((w) => ({
    lat: w.lat,
    lng: w.lng,
    alt: w.alt,
    speed: w.speed,
    camYaw: w.camYaw,
    camPitch: w.camPitch,
    camRoll: w.camRoll,
  }));
  routeSaving.value = true;
  let saved = null;
  // Title is optional (omitted on update = kept; empty on create = the
  // server mints the default); description always rides along.
  const extra = { description: routeDescription.value };
  const trimmedTitle = routeTitle.value.trim();
  if (trimmedTitle) extra.title = trimmedTitle;
  try {
    if (sourceRouteId.value != null) {
      // Case 2 — modified version of an existing route (the user arrived
      // via Content -> Route -> Steer, or an earlier save minted the id):
      // update it in place (the server refreshes the Creation Time). A
      // 404 (route deleted meanwhile) falls back to a new one.
      try {
        saved = await saveRoute(sourceRouteId.value, { waypoints: wps, ...extra });
      } catch {
        saved = await createRoute({ waypoints: wps, ...extra });
        sourceRouteId.value = saved.id;
      }
    } else {
      // Case 1 — brand-new route: save it as new with the current time
      // stamp and remember the id so later clicks update instead of
      // creating a duplicate.
      saved = await createRoute({ waypoints: wps, ...extra });
      sourceRouteId.value = saved.id;
    }
  } catch {
    saved = null;
  } finally {
    routeSaving.value = false;
  }
  // Mirror the authoritative title back (e.g. the server-minted default
  // after a create with an empty title input).
  if (saved) {
    routeTitle.value = saved.title;
    routeCreatedAt.value = saved.created_at;
  }
  return saved;
}

// Save/Update button under the waypoint list in the Route panel: writes
// the current route to Content -> Route (and the database) without
// opening the video dialog.
async function onClickSaveRoute() {
  if (controlsLocked.value) return;
  if (waypoints.value.length < 2) {
    showPreviewHint.value = true;
    clearTimeout(previewHintTimer);
    previewHintTimer = setTimeout(() => {
      showPreviewHint.value = false;
    }, 2500);
    return;
  }
  if (!isAuthenticated.value) {
    showAuthNotice.value = true;
    clearTimeout(authNoticeTimer);
    authNoticeTimer = setTimeout(() => { showAuthNotice.value = false; }, 6000);
    return;
  }
  await saveCurrentRoute();
}

// Video button: open the video generation dialog WITHOUT saving the
// route first. The route is persisted only when the dialog's Generate
// button starts the background job with the publish checkbox on; closing
// the dialog (or Generate with the checkbox off) abandons the route (no
// create, no update in Content -> Route).
function onClickVideo() {
  if (controlsLocked.value || videoRoute.value) return;
  if (waypoints.value.length < 2) {
    // Same green reminder: a route needs >= 2 waypoints.
    showPreviewHint.value = true;
    clearTimeout(previewHintTimer);
    previewHintTimer = setTimeout(() => {
      showPreviewHint.value = false;
    }, 2500);
    return;
  }
  // Saving the route (and publishing the video) needs a login.
  if (!isAuthenticated.value) {
    showAuthNotice.value = true;
    clearTimeout(authNoticeTimer);
    authNoticeTimer = setTimeout(() => { showAuthNotice.value = false; }, 6000);
    return;
  }
  // The offline render walks the 3D camera along the route: enter 3D so
  // the render pass (and its frame-counter overlay) is visible.
  if (!is3d.value) viewCtx.subView = 'steer';
  videoRoute.value = makeTransientRoute();
}

// Snapshot of the current (possibly unsaved) route for the dialog: the
// waypoints drive the render, title / created_at feed its header fields.
// id stays null in Case 1 until ensureVideoRouteSaved persists it.
function makeTransientRoute() {
  const w = waypoints.value[0];
  return {
    id: sourceRouteId.value,
    title: routeTitle.value.trim()
      || `Route at: (${w.lat.toFixed(4)}, ${w.lng.toFixed(4)}, ${w.alt.toFixed(4)})`,
    description: routeDescription.value,
    created_at: routeCreatedAt.value || new Date().toISOString(),
    waypoints: waypoints.value.map((wp) => ({
      lat: wp.lat, lng: wp.lng, alt: wp.alt, speed: wp.speed,
      camYaw: wp.camYaw, camPitch: wp.camPitch, camRoll: wp.camRoll,
    })),
  };
}

// Deferred save of the Video flow: the background video job calls this
// when it publishes (Generate click starts the job). Same create/update
// semantics as the Save button; the returned route's id anchors the video
// record.
function ensureVideoRouteSaved() {
  return saveCurrentRoute();
}

function onVideoClose() {
  videoRoute.value = null;
  // The render flight hid the route overlay; restore it in the 3D overview.
  if (is3d.value && !routeScene.previewActive.value && !routeScene.saving.value) {
    routeScene.showRouteOverlay(waypoints.value, null);
  }
}

// Background video job: the dialog can be closed mid-render (the job keeps
// running). When the render pass then ends with no dialog open, restore the
// route overlay in the 3D overview here instead of in onVideoClose.
watch(
  routeScene.saving,
  (saving, wasSaving) => {
    if (
      wasSaving && !saving &&
      !videoRoute.value && is3d.value &&
      !routeScene.previewActive.value
    ) {
      routeScene.showRouteOverlay(waypoints.value, null);
    }
  },
);

// 3D entry: the nadir overview at the 2D map's center and scale, with the
// blue dots + B-spline overlay. convertAlt=true is the live 2D->3D
// transition (2D map zoom height -> true camera altitude); convertAlt=false
// is a REMOUNT that was left in 3D (drone.alt is still the true altitude
// and the panels' state already lives in the session store).
function enter3dNadirOverview(convertAlt) {
  routeScene.startLoop();
  ensureWaypointDefaults();
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
  if (convertAlt) {
    // The 2D map altitude is Google's nominal model altitude; convert it to
    // the true camera altitude that shows the SAME ground scale in the 3D
    // nadir view (otherwise the 3D view looks ~4-6x more zoomed in).
    const scaleAlt = routeScene.trueAltForMapScale(mapAlt.value, drone.lat);
    drone.alt = scaleAlt;
    // Terrain-aware floor: a searched address can sit on high ground or tall
    // buildings, which would put a scale-only camera underground. Raise to
    // at least ground + 1000 m (never lower the chosen scale height).
    routeScene.safeNadirAltitude(scaleAlt, drone.lat, drone.lon).then((alt) => {
      if (is3d.value && alt > drone.alt) drone.alt = alt;
    });
    drone.heading = 0;
    gimbal.yaw = 0;
    gimbal.pitch = -90; // look straight down, satellite style
    gimbal.roll = 0;
  }
}

onMounted(() => {
  checkGoogleConnection();
  checkCesiumConnection();
  connectionCheckInterval = setInterval(() => {
    checkGoogleConnection();
    checkCesiumConnection();
  }, 10000);

  // The right sidebar (Search + Waypoint + Steer + Route + Video) is the
  // same in every view mode, so it is registered once and never swapped.
  // (The old Map button is gone: Search and Waypoint already return to the
  // 2D street map, the page's entry state.)
  registerRightDock();

  // Phase 2+3 (session-state migration): the route being edited AND the
  // active sub-view live in the session store. Content -> Route seeds
  // session.route and session.view.route.subView='route' BEFORE navigating;
  // plain page switches keep both alive. On every (re)mount we only
  // normalize the carried waypoints and redraw the map — the active
  // sub-view (Route panel / Search / Waypoint / Steer) comes straight from
  // the store, so the page returns exactly as left. The carried
  // sourceRouteId marks this session as Case 2 (modified existing route):
  // the Video flow then updates that route instead of creating a new one.
  // The one-shot video signal (Content -> Route -> Video) opens the dialog
  // right after landing via this page's own Video flow.
  if (waypoints.value.length) {
    ensureWaypointDefaults();
    mapViewRef.value?.redrawWaypointMarkers(waypoints.value, null);
  }
  if (takeRouteVideoSignal()) onClickVideo();

  // Keep dock buttons' active (green-border) state in sync. Video greens
  // while its dialog is open (incl. settling / downloading the clip);
  // Search / Waypoint / Steer / Route are mutually exclusive by
  // construction (each handler closes the others' panels).
  watch(
    [viewMode, showRoutePanel, showSearchPanel, showWaypointHint, previewActive, routeScene.showFlight, routeScene.showCamera, routeScene.saving, videoRoute],
    () => {
      const bv = rightItems.find((i) => i.id === 'video');
      if (bv) {
        bv.active = routeScene.saving.value || !!videoRoute.value;
        bv.disabled = controlsLocked.value;
      }

      const bs = rightItems.find((i) => i.id === 'reset');
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
      enter3dNadirOverview(true);
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
      if (!wasPreview) mapAlt.value = routeScene.modelAltForMapScale(drone.alt, drone.lat);
      scheduleTilePrefetch();
    }
  });

  // Phase 3: returning to this page while it was left in Steer (3D) must
  // re-bootstrap the 3D scene — watch(is3d) does not fire for the initial
  // state. No 2D->3D altitude conversion: drone.alt is still the true
  // altitude from before the page switch.
  if (is3d.value) enter3dNadirOverview(false);

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

        <!-- Reminder: the video needs >= 2 waypoints -->
        <div v-if="showPreviewHint" class="shell-notice">
          {{ t('routeplanningview.preview_need_waypoints') }}
        </div>

        <!-- Reminder: saving the route + the video needs a login -->
        <div v-if="showAuthNotice" class="shell-notice">
          {{ t('routeplanningview.auth_notice_preview') }}
        </div>
      </Teleport>

      <!-- Video generation dialog (this page is its only host; Content
           -> Route -> Video lands here via the handoff) -->
      <RouteVideoDialog
        v-if="videoRoute"
        :route="videoRoute"
        :ensure-route="ensureVideoRouteSaved"
        @close="onVideoClose"
      />

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
        <!-- Route title + description (same field styles as the Route
             Planning -> Video dialog); persisted by Save/Update below. -->
        <div class="route-panel__field">
          <span class="route-panel__fieldlabel">{{ t('routeplanningview.title_label') }}</span>
          <input v-model="routeTitle" class="route-panel__title-input" type="text" maxlength="200" />
        </div>
        <textarea
          v-model="routeDescription"
          class="route-panel__desc"
          rows="4"
          maxlength="2000"
          :placeholder="t('routeplanningview.description_ph')"
        ></textarea>
        <!-- Save the route to Content -> Route: Case 1 (no saved route
             yet) creates a new one, Case 2 (Steer handoff / already
             saved once) updates it. Same blue as Account -> Login. -->
        <button
          v-if="waypoints.length"
          class="route-panel__save"
          :disabled="routeSaving || waypoints.length < 2"
          @click="onClickSaveRoute"
        >
          {{ saveRouteLabel }}
        </button>
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
        :alt="mapAlt"
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
  max-height: min(560px, 80vh);
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/* Title + description fields above the Save button — same styles as the
   Route Planning -> Video dialog fields (.vd__title-input / .vd__desc). */
.route-panel__field {
  display: flex;
  align-items: center;
  gap: 10px;
}

.route-panel__fieldlabel {
  flex-shrink: 0;
  font-size: 0.95rem;
  color: #1d1d1f;
  text-shadow: 0 1px 2px rgba(255, 255, 255, 0.5);
}

.route-panel__title-input {
  box-sizing: border-box;
  flex: 1;
  min-width: 0;
  padding: 6px 12px;
  border: 1px solid #8e8e93;
  border-radius: 8px;
  background: #ffffff;
  font-size: 0.95rem;
  font-weight: 600;
  color: #111827;
}

.route-panel__title-input:focus {
  outline: 1px solid rgba(37, 99, 235, 0.5);
}

.route-panel__desc {
  box-sizing: border-box;
  width: 100%;
  padding: 8px 12px;
  border: 1px solid #8e8e93;
  border-radius: 8px;
  background: #ffffff;
  font-family: inherit;
  font-size: 0.9rem;
  color: #111827;
  resize: vertical;
  min-height: 96px;
}

.route-panel__desc:focus {
  outline: 1px solid rgba(37, 99, 235, 0.5);
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

/* Save / Update button under the waypoint list: same blue background
   and white text as the Account -> Login -> Save button. */
.route-panel__save {
  padding: 11px 0;
  border: none;
  border-radius: 8px;
  background: #007aff;
  color: #ffffff;
  font-size: 0.95rem;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s ease;
}

.route-panel__save:hover:not(:disabled) {
  background: #0066d6;
}

.route-panel__save:disabled {
  opacity: 0.6;
  cursor: default;
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
