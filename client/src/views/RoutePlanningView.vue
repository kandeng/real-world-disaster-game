<script setup>
import { onMounted, onUnmounted, h, ref, computed, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import ViewComposer from '@shared/_ViewComposer.vue';
import { MapView } from '@/2d_map/index.js';
import { useDrone } from '@shared-composables/useDrone.js';
import { useDockRegistry } from '@shared-composables/useDockRegistry.js';
import { usePageRegistry } from '@shared-composables/usePageRegistry.js';
import { useAppSettings } from '@shared-composables/useAppSettings.js';
import { useConnectionStatus, checkGoogleConnection, checkCesiumConnection } from '@shared-composables/useConnectionStatus.js';
import DockMenuButton from '@shared/DockMenuButton.vue';
import DockButton from '@shared/DockButton.vue';
import ConnectionError from '@shared/ConnectionError.vue';
import ConfigurableIcon from '@shared/ConfigurableIcon.vue';

const Cesium = window.Cesium;
const { t } = useI18n();
const { drone } = useDrone();
const { settings } = useAppSettings();
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
  waypoints.value.push({ id: ++wpSeq, index, lat, lng });
  // Redraw circles + the spline link so both always match the list.
  mapViewRef.value?.redrawWaypointMarkers(waypoints.value);
  // One reminder per waypoint: hide it once the user has clicked.
  showWaypointHint.value = false;
}

// The MapView is recreated when leaving 3D and coming back — redraw all
// maintained waypoint circles and the spline link.
function onMapReady() {
  mapViewRef.value?.redrawWaypointMarkers(waypoints.value);
}

// ── Route panel: draggable waypoint list ──────────────────────────────────
let wpSeq = 0; // stable row id (Vue :key) independent of the position index

function fmtCoord(v) {
  const n = Number(v);
  return isNaN(n) ? '' : n.toFixed(4);
}

// Row height (34px) + list gap (6px) — keep in sync with the CSS below so
// the pointer delta maps 1:1 onto row positions while dragging.
const WP_ROW_HEIGHT = 40;
const drag = ref(null); // { startPos, curPos, startY, offset }

function onRowPointerDown(event, pos) {
  if (event.button !== 0) return;
  event.preventDefault();
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
  mapViewRef.value?.redrawWaypointMarkers(waypoints.value);
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

  // Keep dock buttons' active state in sync with mode / panels.
  watch([viewMode, showRoutePanel, showSearchPanel, showWaypointHint], () => {
    const b2 = leftItems.find((i) => i.id === 'mode_2d');
    if (b2) b2.active = viewMode.value !== '3d';
    const b3 = leftItems.find((i) => i.id === 'mode_3d');
    if (b3) b3.active = viewMode.value === '3d';
    const bs = rightItems.find((i) => i.id === 'search');
    if (bs) bs.active = showSearchPanel.value;
    const br = rightItems.find((i) => i.id === 'route');
    if (br) br.active = showRoutePanel.value;

    if (viewMode.value === '3d') {
      showSearchPanel.value = false;
      showWaypointHint.value = false;
      unregisterRightDock();
    } else if (!rightItems.some((i) => i.id === 'search')) {
      registerRightDock();
    }
  });
});

onUnmounted(() => {
  if (connectionCheckInterval) clearInterval(connectionCheckInterval);
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
    :show-flight="false"
    :show-camera="false"
    :show-hud="false"
    :flight="{ mode: '-', vx: 0, vy: 0, yaw: 0, vz: 0 }"
    :camera="{ mode: '-', yaw: 0, pitch: 0, roll: 0 }"
  >
    <template #top-overlay>
      <ConnectionError :visible="showConnectionError" :message="connectionMessage" />

      <!-- Green top-center reminder while waypoint picking is armed -->
      <div v-if="showWaypointHint" class="top-center-message top-center-message--success">
        {{ t('routeplanningview.waypoint_hint') }}
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

      <!-- Route popup -->
      <div v-if="showRoutePanel" class="route-panel">
        <div class="route-panel__title">{{ t('routeplanningview.panel_title') }}</div>
        <div v-if="waypoints.length" class="route-panel__list">
          <div v-for="(wp, pos) in waypoints" :key="wp.id" class="route-panel__row">
            <!-- Slot index: stays put while the rows are dragged. -->
            <span class="route-panel__idx">{{ pos + 1 }}</span>
            <div
              class="route-panel__wp"
              :class="{ 'route-panel__wp--dragging': drag && drag.curPos === pos }"
              @pointerdown="onRowPointerDown($event, pos)"
            >
              {{ fmtCoord(wp.lat) }}, {{ fmtCoord(wp.lng) }}
            </div>
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
  display: flex;
  flex-direction: column;
  gap: 6px;
}

/* Each waypoint row is a grabbable box; drag it up/down to reorder.
   Height 34px + 6px gap = WP_ROW_HEIGHT (40) in the script. */
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

.route-panel__wp {
  flex: 1;
  min-width: 0;
  height: 34px;
  display: flex;
  align-items: center;
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

.route-panel__wp:hover {
  background: rgba(255, 255, 255, 0.55);
}

.route-panel__wp--dragging {
  border-color: #2563eb;
  background: rgba(37, 99, 235, 0.15);
  cursor: grabbing;
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
