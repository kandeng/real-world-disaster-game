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
import { usePageRegistry } from '@shared-composables/usePageRegistry.js';
import { useAppSettings } from '@shared-composables/useAppSettings.js';
import { useConnectionStatus, checkGoogleConnection, checkCesiumConnection } from '@shared-composables/useConnectionStatus.js';
import DockMenuButton from '@shared/DockMenuButton.vue';
import DockButton from '@shared/DockButton.vue';
import ConnectionError from '@shared/ConnectionError.vue';
import ConfigurableIcon from '@shared/ConfigurableIcon.vue';
import cancelIcon from '../../icons/cancel.svg';

const Cesium = window.Cesium;
const { t } = useI18n();
const { drone, gimbal } = useDrone();
const { settings } = useAppSettings();

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
const { leftItems, rightItems, registerLeft, registerRight, unregisterRight, clear } = useDockRegistry();
const { pages, registerPage, unregisterPage } = usePageRegistry();

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
//   'street'    – 2D Google street map   (default)
//   'satellite' – 2D Google satellite imagery
//   '3d'        – Google Earth 3D tiles (the shared global Cesium viewer)
// The `2D` dock button is a switcher between street and satellite.
const viewMode = ref('street');
const showRoutePanel = ref(false);
const showSearchPanel = ref(false);

const mapTypeId = computed(() => (viewMode.value === 'satellite' ? 'satellite' : 'roadmap'));

function onClick2D() {
  // Switcher: street -> satellite -> street ...; from 3D enter at street.
  viewMode.value = viewMode.value === 'street' ? 'satellite' : 'street';
}

function onClick3D() {
  if (viewMode.value === '3d') return;
  viewMode.value = '3d';
  // Recenter the shared Cesium viewer on the default location (Stanford
  // campus), exactly like the 3D Exploration page's initial view.
  const viewer = window.cesiumViewer;
  if (viewer && Cesium) {
    viewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(settings.defaultLon, settings.defaultLat, settings.defaultAlt),
      orientation: {
        heading: Cesium.Math.toRadians(settings.defaultYaw),
        pitch: Cesium.Math.toRadians(settings.defaultPitch),
        roll: Cesium.Math.toRadians(settings.defaultRoll),
      },
    });
  }
}

// Only one of Search / Waypoint / Route may be visible at a time: opening
// one hides the others' popups. The other buttons stay clickable —
// clicking one simply switches which popup is shown.
function onClickRoute() {
  showRoutePanel.value = !showRoutePanel.value;
  if (showRoutePanel.value) {
    showSearchPanel.value = false;
    showWaypointHint.value = false;
  }
}

function onClickSearch() {
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
  showWaypointHint.value = !showWaypointHint.value;
  if (showWaypointHint.value) {
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
    alt: 0,
    speed: 0,
    camYaw: 0,
    camPitch: 0,
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
}

// ── Route panel: draggable waypoint list ──────────────────────────────────
let wpSeq = 0; // stable row id (Vue :key) independent of the position index

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
  else if (field === 'speed') v = Math.max(0, Math.min(1000, v));
  else if (field === 'camPitch') v = Math.max(-90, Math.min(90, v));
  else v = normAngle(v); // camYaw / camRoll
  wp[field] = v;
  event.target.value = fmtCoord(v, digits);
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

// Releasing the left mouse button: the MapView turned the circle back to
// blue; redraw the B-spline link to match the final positions.
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

// ── Waypoint plumbing (mirrors Map2DView) ─────────────────────────────────
function onMapCenterChange({ lat, lng }) {
  drone.lat = lat;
  drone.lon = lng;
}

function onMapZoomChange(alt) {
  drone.alt = Math.max(0, Math.min(100000, alt));
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

// ── Right dock: Search + Waypoint + Route, only while a 2D mode is active ──
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
      onClick: onWaypointClick,
    }),
  });
  // Route lives in the right sidebar, third position (below Waypoint).
  registerRight({
    id: 'route',
    icon: 'MENU_LIST',
    titleKey: 'routeplanningview.route',
    active: showRoutePanel.value,
    onClick: onClickRoute,
  });
}

function unregisterRightDock() {
  unregisterRight('search');
  unregisterRight('waypoint');
  unregisterRight('route');
}

// ── Right dock in the 3D subpage: Camera / Steer / Route / Preview / Save ──
// The Route list box and the Flight / Gimbal disks are mutually exclusive:
// opening one hides the other. Any of Camera / Steer / Route clicked while
// a preview is running stops the preview first.
function onClickCamera3D() {
  routeScene.stopPreview();
  const turningOn = !routeScene.showCamera.value;
  routeScene.showCamera.value = turningOn;
  if (turningOn) showRoutePanel.value = false; // disk shows -> list hides
}

function onClickSteer3D() {
  routeScene.stopPreview();
  const turningOn = !routeScene.showFlight.value;
  routeScene.showFlight.value = turningOn;
  if (turningOn) showRoutePanel.value = false; // disk shows -> list hides
}

function onClickRoute3D() {
  routeScene.stopPreview();
  const opening = !showRoutePanel.value;
  onClickRoute();
  if (opening) {
    // List shows -> both disks hide.
    routeScene.showFlight.value = false;
    routeScene.showCamera.value = false;
  }
}

const showPreviewHint = ref(false);
let previewHintTimer = null;

function onClickPreview() {
  if (routeScene.previewActive.value) {
    routeScene.stopPreview();
    return;
  }
  // Preview owns the screen: disks and the Route list are hidden.
  showRoutePanel.value = false;
  if (!routeScene.startPreview(waypoints.value)) {
    // Green top-center reminder: the preview needs at least two waypoints.
    showPreviewHint.value = true;
    clearTimeout(previewHintTimer);
    previewHintTimer = setTimeout(() => {
      showPreviewHint.value = false;
    }, 2500);
  }
}

function onClickSave() {
  routeScene.saveClip();
}

function registerRightDock3D() {
  registerRight({
    id: 'camera',
    icon: 'MENU_CAMERA',
    titleKey: 'routeplanningview.camera',
    active: routeScene.showCamera.value,
    onClick: onClickCamera3D,
  });
  registerRight({
    id: 'steer',
    icon: 'MENU_CONTROL_STICK',
    titleKey: 'routeplanningview.steer',
    active: routeScene.showFlight.value,
    onClick: onClickSteer3D,
  });
  registerRight({
    id: 'route',
    icon: 'MENU_LIST',
    titleKey: 'routeplanningview.route',
    active: showRoutePanel.value,
    onClick: onClickRoute3D,
  });
  registerRight({
    id: 'preview',
    icon: 'MENU_PREVIEW',
    titleKey: 'routeplanningview.preview',
    active: routeScene.previewActive.value,
    onClick: onClickPreview,
  });
  registerRight({
    id: 'save',
    icon: 'MENU_SAVE',
    titleKey: 'routeplanningview.save',
    onClick: onClickSave,
  });
}

function unregisterRightDock3D() {
  ['camera', 'steer', 'route', 'preview', 'save'].forEach((id) => unregisterRight(id));
}

onMounted(() => {
  checkGoogleConnection();
  checkCesiumConnection();
  connectionCheckInterval = setInterval(() => {
    checkGoogleConnection();
    checkCesiumConnection();
  }, 10000);

  // Register pages for the router menu (Route Planning is the third page).
  registerPage({ id: 'aerial', nameKey: 'aerialview.page_aerial', route: '/' });
  registerPage({ id: 'map', nameKey: 'aerialview.page_map', route: '/map' });
  registerPage({ id: 'routeplanning', nameKey: 'aerialview.page_routeplanning', route: '/route-planning' });
  registerPage({ id: 'realdrone', nameKey: 'aerialview.page_realdrone', route: '/real-drone' });
  registerPage({ id: 'extensions', nameKey: 'aerialview.page_extensions', route: '/extensions' });
  registerPage({ id: 'chat', nameKey: 'aerialview.page_chat', route: '/chat' });
  registerPage({ id: 'myspace', nameKey: 'aerialview.page_myspace', route: '/myspace' });

  registerLeft({
    id: 'router',
    render: () => h(DockMenuButton, {
      icon: 'MENU_ROUTER',
      titleKey: 'aerialview.pages',
      pages,
    }),
  });
  registerLeft({
    id: 'mode_2d',
    icon: 'MENU_CHAR_2D',
    titleKey: 'routeplanningview.mode_2d',
    // The 2D/3D character glyphs render large inside the 56px square —
    // shrink the icon to 80% of the standard dock icon size (32px).
    size: 26,
    active: viewMode.value !== '3d',
    onClick: onClick2D,
  });
  registerLeft({
    id: 'mode_3d',
    icon: 'MENU_CHAR_3D',
    titleKey: 'routeplanningview.mode_3d',
    size: 26,
    active: viewMode.value === '3d',
    onClick: onClick3D,
  });

  // The right sidebar (Search + Waypoint + Route) exists in both 2D modes
  // and is removed entirely while the 3D tiles are shown.
  registerRightDock();

  // Keep dock buttons' active state in sync with mode / panels, and swap
  // the right sidebar content between the 2D and 3D subpages.
  watch(
    [viewMode, showRoutePanel, showSearchPanel, showWaypointHint, previewActive, routeScene.showFlight, routeScene.showCamera],
    () => {
      const b2 = leftItems.find((i) => i.id === 'mode_2d');
      if (b2) b2.active = viewMode.value !== '3d';
      const b3 = leftItems.find((i) => i.id === 'mode_3d');
      if (b3) b3.active = viewMode.value === '3d';

      if (viewMode.value === '3d') {
        showSearchPanel.value = false;
        showWaypointHint.value = false;
        if (!rightItems.some((i) => i.id === 'preview')) {
          unregisterRightDock();
          registerRightDock3D();
        }
        const bc = rightItems.find((i) => i.id === 'camera');
        if (bc) bc.active = routeScene.showCamera.value;
        const bs = rightItems.find((i) => i.id === 'steer');
        if (bs) bs.active = routeScene.showFlight.value;
        const br = rightItems.find((i) => i.id === 'route');
        if (br) br.active = showRoutePanel.value;
        const bp = rightItems.find((i) => i.id === 'preview');
        if (bp) bp.active = routeScene.previewActive.value;
      } else {
        if (!rightItems.some((i) => i.id === 'search')) {
          unregisterRightDock3D();
          registerRightDock();
        }
        const bs = rightItems.find((i) => i.id === 'search');
        if (bs) bs.active = showSearchPanel.value;
        const br = rightItems.find((i) => i.id === 'route');
        if (br) br.active = showRoutePanel.value;
      }
    }
  );

  // Sim loop lifecycle: runs only while the 3D subpage is shown.
  watch(is3d, (now3d) => {
    if (now3d) {
      // The sim loop slaves the Cesium camera to the drone state every
      // frame; point the virtual drone at the default view so the 3D
      // subpage opens exactly where onClick3D recenters.
      drone.lat = settings.defaultLat;
      drone.lon = settings.defaultLon;
      drone.alt = settings.defaultAlt;
      drone.heading = settings.defaultYaw;
      gimbal.yaw = 0;
      gimbal.pitch = settings.defaultPitch;
      gimbal.roll = settings.defaultRoll;
      routeScene.startLoop();
    } else {
      routeScene.stopPreview();
      routeScene.stopLoop();
      routeScene.showFlight.value = false;
      routeScene.showCamera.value = false;
    }
  });
});

onUnmounted(() => {
  if (connectionCheckInterval) clearInterval(connectionCheckInterval);
  if (previewHintTimer) clearTimeout(previewHintTimer);
  routeScene.stopPreview();
  routeScene.stopLoop();
  clear();
  unregisterPage('aerial');
  unregisterPage('map');
  unregisterPage('routeplanning');
  unregisterPage('realdrone');
  unregisterPage('myspace');
  unregisterPage('chat');
  unregisterPage('extensions');
});
</script>

<template>
  <ViewComposer
    :left-items="leftItems"
    :right-items="rightItems"
    :show-flight="showFlightDisk"
    :show-camera="showCameraDisk"
    :show-hud="showHudDashboard"
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

      <!-- Green top-center reminder while waypoint picking is armed -->
      <div v-if="showWaypointHint" class="top-center-message top-center-message--success">
        {{ t('routeplanningview.waypoint_hint') }}
      </div>

      <!-- Green top-center reminder: preview needs >= 2 waypoints -->
      <div v-if="showPreviewHint" class="top-center-message top-center-message--success">
        {{ t('routeplanningview.preview_need_waypoints') }}
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

/* Green top-center reminder — same style as the 3D Exploration page. */
.top-center-message {
  position: fixed;
  top: 24px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 100;
  padding: 12px 28px;
  border-radius: 8px;
  font-family: Calibri, 'Segoe UI', sans-serif;
  font-size: 0.77rem;
  font-weight: 700;
  color: #ffffff;
  white-space: nowrap;
  pointer-events: none;
  text-align: center;
  letter-spacing: 0.02em;
}

.top-center-message--success {
  background: rgba(34, 197, 94, 0.9);
  box-shadow: 0 0 18px rgba(34, 197, 94, 0.6);
}
</style>
