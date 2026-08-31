<script setup>
import { ref, computed, onMounted, onUnmounted, watch, toRef } from 'vue';
import { useI18n } from 'vue-i18n';
import { MapView } from '@/2d_map/index.js';
import ViewComposer from '@shared/_ViewComposer.vue';
import MeshToolPanel from '@shared/MeshToolPanel.vue';
import { useDockRegistry } from '@shared-composables/useDockRegistry.js';
import { useSessionState } from '@shared-composables/useSessionState.js';
import { useSceneAssets } from '@shared-composables/useSceneAssets.js';
import { useDrone } from '@shared-composables/useDrone.js';
import { useFlightCommands } from '@shared-composables/useFlightCommands.js';
import { useCameraCommands } from '@shared-composables/useCameraCommands.js';
import { useFlightPhysics } from '@shared-composables/useFlightPhysics.js';
import { useCameraPhysics } from '@shared-composables/useCameraPhysics.js';

const { t } = useI18n();
const { session } = useSessionState();
const viewCtx = session.view.buildscene;   // { mode, searchQuery, selectionLatLng }
const mapAlt = toRef(session.view, 'mapAlt');
// The 2D map of this page is about ADDRESSES and placed objects, so it always
// opens at a readable street scale: a stale, very large map altitude left over
// from another page would otherwise render the whole Earth instead of the
// place being searched for.
const BS_MAP_ALT_MIN = 120;
const BS_MAP_ALT_MAX = 1200;
const bsMapAlt = computed(() => {
  const raw = Number(mapAlt.value);
  const v = Number.isFinite(raw) ? raw : 320;
  return Math.min(BS_MAP_ALT_MAX, Math.max(BS_MAP_ALT_MIN, v));
});
const { drone, gimbal } = useDrone();
const {
  scene, findAsset, addAsset, selectAsset, clearAll, applyAsset, moveAsset, setAssetMesh,
  setDotsVisible,
} = useSceneAssets();
const { rightItems, registerRight, clear } = useDockRegistry();

// ── Flight / gimbal drive (Drone View tool) ──────────────────────────────
// Command state is a module-level singleton shared with AerialView, so the
// disks behave exactly like the ones on the flight pages.
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
  showCamera,
  onCameraMove,
  onCameraStop,
  onCameraModeChange,
  startKeyboard: startCameraKeyboard,
  stopKeyboard: stopCameraKeyboard,
} = useCameraCommands();
const { computeDesiredEnuMove, applyEnuMove, updateTelemetry: updateFlightTelemetry } = useFlightPhysics();
const { step: stepCameraPhysics } = useCameraPhysics();

// ── Right sidebar tools ───────────────────────────────────────────────────
// 'reset'    : 2D map + the Reset pop-up (clean up + go to a new location)
// 'asset'    : 2D map armed for placing / dragging assets (no pop-up)
// 'finetune' : 3D Google-earth tiles + the mesh fine-tune pop-up
// ''         : neutral — just the 2D map (landing lands on 'reset' instead)
const panelMode = ref('');
const is2D = computed(() => viewCtx.mode === '2d');
const mapViewRef = ref(null);
// True between mount and unmount: gates the 3D asset dots, whose visibility
// is otherwise re-applied by the 2D/3D watcher (which may still fire from a
// queued watcher after the page is gone).
const pageActive = ref(false);

const resetActive = computed(() => panelMode.value === 'reset');
const assetActive = computed(() => panelMode.value === 'asset');
const finetuneActive = computed(() => panelMode.value === 'finetune');
const driveActive = computed(() => showFlight.value);

const selectedAsset = computed(() => findAsset(scene.selectedId));

function closeTool() {
  panelMode.value = '';
}

function selectTool(mode) {
  panelMode.value = panelMode.value === mode ? '' : mode;
  if (!panelMode.value) return;
  // Pop-ups and the drive disks are mutually exclusive: the disks would
  // otherwise keep re-slaving the camera the finetune view is framing.
  showFlight.value = false;
  showCamera.value = false;
  if (mode === 'reset' || mode === 'asset') {
    // Both 2D tools always land on the Google street/satellite map: the
    // address must read clearly, so never the photoreal 3D globe.
    viewCtx.mode = '2d';
    applyBackground();
  } else if (mode === 'finetune') {
    viewCtx.mode = '3d';
    applyBackground();
    enterFinetune();
  }
}

// Drone View: drop every pop-up, reveal the globe, open Flight + Gimbal.
function toggleDrive() {
  const next = !showFlight.value;
  showFlight.value = next;
  showCamera.value = next;
  if (next) {
    panelMode.value = '';
    viewCtx.mode = '3d';
    applyBackground();
  }
}

// ── Mesh library (GLBs under client/assets/mesh) ──────────────────────────
const MESH_LABELS = {
  drone_dji_air3: 'DJI Air 3',
  drone_dji_inspire3: 'DJI Inspire 3',
  drone_with_camera: 'Drone with Camera',
  lion_lowe: 'Lion (Lowe)',
};
const meshModules = import.meta.glob('../../assets/mesh/*.glb', {
  eager: true,
  query: '?url',
  import: 'default',
});
// A ref (not a plain array): meshes uploaded from the local disk at runtime
// are appended to the bundled library.
const meshes = ref(
  Object.entries(meshModules).map(([path, url]) => {
    const name = path.split('/').pop().replace(/\.glb$/, '');
    return { name, url, label: MESH_LABELS[name] || name };
  })
);

// The library mesh used for the NEXT asset placed on the map.
const templateMesh = computed(() => {
  const known = meshes.value.find((m) => m.url === scene.meshUrl);
  return known || meshes.value[0] || null;
});

function onSetTemplate(url, label) {
  scene.meshUrl = url;
  scene.meshName = label || '';
  // The library also specifies the mesh of the asset currently selected (the
  // dot that was flashing for want of a mesh).
  const asset = selectedAsset.value;
  if (asset && !asset.meshChosen) {
    setAssetMesh(asset.id, url, label).then(() => {
      if (is2D.value && !assetPressed) drawOverlays();
    });
  }
}

// ── Local mesh upload (file_folder in the Finetune pop-up) ─────────────
// The Finetune panel is hidden while the OS picker is up, and restored
// after the pick OR the cancel.
const pickerOpen = ref(false);
const localFileInput = ref(null); // fallback for browsers without showOpenFilePicker

function pickLocalGlbFile() {
  if (typeof window.showOpenFilePicker === 'function') {
    // Chromium: promise-based — resolves on pick, rejects (AbortError) on
    // cancel, so the panel is reliably restored in BOTH cases.
    return window
      .showOpenFilePicker({
        multiple: false,
        types: [{ description: 'GLB mesh', accept: { 'model/gltf-binary': ['.glb'] } }],
      })
      .then(async (handles) => {
        const handle = handles && handles[0];
        return handle ? handle.getFile() : null;
      })
      .catch(() => null); // user cancelled
  }
  // Fallback: hidden <input type="file">. 'change' fires only when a file
  // was actually chosen; the OS dialog also steals focus, so a focus return
  // (with a short grace, as some browsers fire change after focus) covers
  // the cancel case too.
  return new Promise((resolve) => {
    const el = localFileInput.value;
    if (!el) return resolve(null);
    el.value = '';
    let settled = false;
    const settle = (file) => {
      if (settled) return;
      settled = true;
      el.removeEventListener('change', onChange);
      window.removeEventListener('focus', onFocus);
      resolve(file);
    };
    const onChange = () => settle(el.files && el.files[0] ? el.files[0] : null);
    const onFocus = () => window.setTimeout(() => settle(null), 400);
    el.addEventListener('change', onChange);
    window.addEventListener('focus', onFocus);
    el.click();
  });
}

async function ingestLocalMesh(file) {
  const url = URL.createObjectURL(file);
  const label = file.name.replace(/\.glb$/i, '');
  if (!meshes.value.find((m) => m.url === url)) {
    meshes.value.push({ name: label, url, label });
  }
  // The upload becomes the template for the NEXT placement and — when an
  // asset is selected — the mesh of that asset (its dot stops flashing).
  scene.meshUrl = url;
  scene.meshName = label;
  const asset = selectedAsset.value;
  if (asset) await setAssetMesh(asset.id, url, label);
  if (is2D.value && !assetPressed) drawOverlays();
}

async function onPickLocalMesh() {
  if (pickerOpen.value) return;
  pickerOpen.value = true;
  try {
    const file = await pickLocalGlbFile();
    if (file) await ingestLocalMesh(file);
  } catch (err) {
    console.error('[BuildScene] local mesh pick failed:', err);
  } finally {
    pickerOpen.value = false;
  }
}

// ── 2D <-> 3D background toggle ───────────────────────────────────────────
// The shared Cesium globe lives in #cesiumContainer behind the Vue overlay, and
// the Google map stays MOUNTED at all times (only faded out in 3D): the 2D
// tools then always find their map instantly, with warm tiles, and the 3D globe
// can never show through a map that is still re-attaching.
function cesiumEl() {
  return document.getElementById('cesiumContainer');
}

function applyBackground() {
  const twoD = is2D.value;
  const el = cesiumEl();
  if (el) el.classList.toggle('cesium-hidden', twoD);
  // The asset dots only belong to this page's 3D view: hide them while the
  // map is showing and while the user is on another page.
  setDotsVisible(!twoD && pageActive.value);
}

watch(is2D, applyBackground, { immediate: true });

// ── 3D: click an asset dot to fly above it ───────────────────────────────
let picker = null;

function ensurePicker() {
  const v = window.cesiumViewer;
  if (!v || picker) return;
  picker = new Cesium.ScreenSpaceEventHandler(v.scene.canvas);
  picker.setInputAction((movement) => {
    if (panelMode.value !== 'finetune') return;
    const picked = v.scene.pick(movement.position);
    const id = picked && picked.id ? picked.id.assetId : null;
    if (id == null) return;
    selectAsset(id);
    focusAsset(findAsset(id));
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
}

// Nadir view 100 m above the ground, centred on the asset.
function focusAsset(asset) {
  const v = window.cesiumViewer;
  if (!v || !asset || asset.lat == null) return;
  try {
    v.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(
        asset.lon,
        asset.lat,
        (asset.groundAlt || 0) + 100
      ),
      orientation: {
        heading: 0,
        pitch: Cesium.Math.toRadians(-90),
        roll: 0,
      },
      duration: 1.2,
    });
  } catch (err) {
    console.warn('[BuildScene] focusAsset failed:', err);
  }
}

function enterFinetune() {
  ensurePicker();
  const v = window.cesiumViewer;
  if (!v) return;
  const asset = selectedAsset.value || scene.assets[0];
  if (asset) {
    if (selectedAsset.value?.id !== asset.id) selectAsset(asset.id);
    focusAsset(asset);
    return;
  }
  // Nothing placed yet: show the area around the current map centre.
  try {
    v.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(drone.lon, drone.lat, Math.max(300, mapAlt.value || 300)),
      orientation: {
        heading: 0,
        pitch: Cesium.Math.toRadians(-60),
        roll: 0,
      },
      duration: 1.2,
    });
  } catch {
    /* ignore */
  }
}

// ── Slider edits re-compose the model matrix live ────────────────────────
watch(
  () => {
    const a = selectedAsset.value;
    return a ? [a.alt, a.length, a.heading, a.pitch, a.roll] : null;
  },
  () => {
    const a = selectedAsset.value;
    if (a) applyAsset(a.id);
  }
);

// ── Location search (Reset pop-up) ───────────────────────────────────────
const searchQuery = toRef(viewCtx, 'searchQuery');
const selectedLatLng = toRef(viewCtx, 'selectionLatLng');
const searchResults = ref([]);
const searchError = ref('');
const searchBusy = ref(false);
const hasSearched = ref(false);

function onSearchSubmit() {
  const text = (searchQuery.value || '').trim();
  if (!text || !mapViewRef.value) return;
  searchError.value = '';
  searchResults.value = [];
  searchBusy.value = true;
  hasSearched.value = true;
  mapViewRef.value.searchPoisByText(text);
}

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
  if (!searchBusy.value) return;
  searchBusy.value = false;
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

function onPoisError(message) {
  console.error('[BuildScene] poisError:', message);
  if (!searchBusy.value) return;
  searchBusy.value = false;
  searchResults.value = [];
  searchError.value = message;
}

function onResultClick(poi) {
  const loc = poi?.geometry?.location;
  if (!loc || !mapViewRef.value) return;
  selectedLatLng.value = { lat: loc.lat(), lng: loc.lng() };
  mapViewRef.value.panTo(loc.lat(), loc.lng());
  mapViewRef.value.setSelectionMarker(loc.lat(), loc.lng());
  closeTool();
}

// "Clean Up the Assets": drop every placed asset (models + dots).
function onCleanup() {
  clearAll();
  drawOverlays();
}

// ── 2D overlays: independent asset dots (+ the searched address balloon) ──
// Set while the pointer is held on an asset dot (with or without a drag):
// the overlay redraw is then skipped, because rebuilding the markers would
// destroy the very circle being dragged.
let assetPressed = false;

function assetEntries() {
  // Dots of positions whose mesh has not been specified yet pulse while the
  // Asset tool is armed, so the user notices what still needs a choice.
  const flash = panelMode.value === 'asset';
  return scene.assets.map((a) => ({
    id: a.id,
    lat: a.lat,
    lon: a.lon,
    name: a.meshName,
    flash: flash && !a.meshChosen,
  }));
}

// The red balloon belongs to the address found through the Reset tool only:
// placing / dragging an asset shows its blue dot, nothing else.
function drawOverlays() {
  const mv = mapViewRef.value;
  if (!mv) return;
  mv.setAssetMarkers(assetEntries());
  const picked = selectedLatLng.value;
  if (picked) mv.setSelectionMarker(picked.lat, picked.lng);
  else mv.setSelectionMarkerVisible(false);
}

// Redraw whenever the tool, the selection or the asset set changes.
watch([panelMode, () => scene.selectedId, () => scene.assets.length], () => {
  if (is2D.value && !assetPressed) drawOverlays();
});

function onMapCenterChange({ lat, lng }) {
  drone.lat = lat;
  drone.lon = lng;
}

function onMapZoomChange(alt) {
  mapAlt.value = Math.max(0, Math.min(100000, alt));
}

function onMapReady() {
  if (is2D.value) drawOverlays();
}

function onMapClick({ lat, lng }) {
  if (panelMode.value !== 'asset') return;
  const tpl = templateMesh.value;
  // An explicit library choice (scene.meshUrl) counts as "mesh specified";
  // otherwise the new dot carries the fallback mesh and keeps flashing.
  addAsset(tpl ? tpl.url : '', tpl ? tpl.label : '', lat, lng, !!scene.meshUrl);
  drawOverlays();
}

// Press / drag an asset dot: the dot turns red while held and follows the
// pointer — no balloon, the dots alone mark the assets.
function onAssetPress(id) {
  assetPressed = true;
  selectAsset(id);
}

function onAssetMove({ id, lat, lng }) {
  const asset = findAsset(id);
  if (!asset) return;
  asset.lat = lat;
  asset.lon = lng;
  applyAsset(id);
}

function onAssetRelease({ id }) {
  assetPressed = false;
  const asset = findAsset(id);
  if (!asset) return;
  // Resample the terrain height of the new spot once the drag settles.
  moveAsset(id, asset.lat, asset.lon).then(() => {
    if (is2D.value && !assetPressed) drawOverlays();
  });
}

// ── Fine-tune "Save": commit the editable detail lines ───────────────────
function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

function onSaveDetails(values) {
  const asset = selectedAsset.value;
  if (!asset || !values) return;
  const moved =
    (values.lat != null && values.lat !== asset.lat) ||
    (values.lon != null && values.lon !== asset.lon);
  if (values.lat != null) asset.lat = clamp(values.lat, -90, 90);
  if (values.lon != null) asset.lon = clamp(values.lon, -180, 180);
  if (values.alt != null) asset.alt = clamp(values.alt, -500, 500);
  if (values.length != null) asset.length = clamp(values.length, 0.1, 500);
  if (values.heading != null) asset.heading = clamp(values.heading, 0, 360);
  if (values.pitch != null) asset.pitch = clamp(values.pitch, -180, 180);
  if (values.roll != null) asset.roll = clamp(values.roll, -180, 180);
  if (moved) {
    moveAsset(asset.id, asset.lat, asset.lon).then(() => {
      if (is2D.value) drawOverlays();
      else if (panelMode.value === 'finetune') focusAsset(asset);
    });
  } else {
    applyAsset(asset.id);
  }
}

// ── Flight / gimbal drive loop (Drone View) ───────────────────────────────
function syncCesiumCamera() {
  if (typeof window.updateCesiumCamera !== 'function') return;
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

let rafId = null;
let loopErrorLogTs = 0;

function loop() {
  try {
    if (showFlight.value || showCamera.value) {
      const dt = 1 / 60;
      if (showFlight.value) {
        applyEnuMove(computeDesiredEnuMove(dt, true));
        updateFlightTelemetry(true);
        if (activeFlightMode.value === 'R') drone.heading += flightCmd.yaw * 60.0 * dt;
      }
      if (showCamera.value) stepCameraPhysics(dt, { applyMovement: true });
      syncCesiumCamera();
    }
  } catch (err) {
    // A single bad frame must never kill the loop.
    const now = performance.now();
    if (now - loopErrorLogTs > 2000) {
      loopErrorLogTs = now;
      console.error('[BuildScene] Frame error (loop continues):', err);
    }
  }
  rafId = requestAnimationFrame(loop);
}

// Landing behavior — identical to clicking the Reset tool: the Google 2D map
// is shown and the Reset pop-up opens. Runs on mount AND whenever the user
// re-clicks the "Build Scene" menu item while already on the page
// (AppShell dispatches 'shell-page-reenter' for same-path menu clicks).
function landOnResetPage() {
  pageActive.value = true;
  showFlight.value = false;
  showCamera.value = false;
  viewCtx.mode = '2d';
  panelMode.value = 'reset';
  applyBackground();
}

function onShellReenter(ev) {
  if (ev && ev.detail === '/build-scene') landOnResetPage();
}

// ── Right dock: Reset / Asset in 2D Map / Finetune in 3D / Drone View ────
onMounted(() => {
  registerRight({
    id: 'bs_reset',
    icon: 'MENU_RESET',
    titleKey: 'buildsceneview.tool_reset',
    active: resetActive,
    onClick: () => selectTool('reset'),
  });
  registerRight({
    id: 'bs_asset',
    icon: 'MENU_LOCATION',
    titleKey: 'buildsceneview.tool_asset2d',
    active: assetActive,
    onClick: () => selectTool('asset'),
  });
  registerRight({
    id: 'bs_finetune',
    icon: 'MENU_INSTRUMENT',
    titleKey: 'buildsceneview.tool_finetune',
    active: finetuneActive,
    onClick: () => selectTool('finetune'),
  });
  registerRight({
    id: 'bs_droneview',
    icon: 'MENU_CONTROL_STICK',
    titleKey: 'buildsceneview.tool_steer',
    active: driveActive,
    onClick: toggleDrive,
  });

  // Landing on the page (Build Scene menu item) behaves like clicking the
  // Reset tool: the Google 2D map is shown and the Reset pop-up opens,
  // regardless of where the previous visit left off.
  landOnResetPage();
  window.addEventListener('shell-page-reenter', onShellReenter);
  startFlightKeyboard();
  startCameraKeyboard();
  rafId = requestAnimationFrame(loop);
});

onUnmounted(() => {
  window.removeEventListener('shell-page-reenter', onShellReenter);
  pageActive.value = false;
  setDotsVisible(false);
  stopFlightKeyboard();
  stopCameraKeyboard();
  if (rafId) cancelAnimationFrame(rafId);
  if (picker) {
    try {
      picker.destroy();
    } catch {
      /* already gone */
    }
    picker = null;
  }
  showFlight.value = false;
  showCamera.value = false;
  clear();
  // Reveal the globe and free the camera for whichever page comes next.
  const el = cesiumEl();
  if (el) el.classList.remove('cesium-hidden');
  const v = window.cesiumViewer;
  if (v) {
    try {
      v.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
    } catch {
      /* ignore */
    }
  }
});
</script>

<template>
  <div class="build-scene">
    <ViewComposer
      :right-items="rightItems"
      :show-flight="showFlight"
      :show-camera="showCamera"
      :show-hud="false"
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
        <Teleport to="#shell-notices">
          <div v-if="assetActive" class="shell-notice">
            {{ t('buildsceneview.hint_asset') }}
          </div>
        </Teleport>
      </template>

      <!-- 2D background: Google map for locating / placing the assets. It
           stays mounted in 3D too (faded out), so the Reset / Asset tools
           always show the map itself, never the 3D globe behind it. -->
      <template #background>
        <MapView
          ref="mapViewRef"
          class="build-scene__map"
          :class="{ 'build-scene__map--off': !is2D }"
          :lat="drone.lat"
          :lon="drone.lon"
          :alt="bsMapAlt"
          :heading="0"
          map-type-id="satellite"
          :is-picking="assetActive"
          :is-panel-open="resetActive"
          :show-drone-marker="false"
          :waypoints-editable="false"
          @mapReady="onMapReady"
          @centerChange="onMapCenterChange"
          @zoomChange="onMapZoomChange"
          @mapClick="onMapClick"
          @assetPress="onAssetPress"
          @assetMove="onAssetMove"
          @assetRelease="onAssetRelease"
          @poisFound="onPoisFound"
          @poisError="onPoisError"
        />
      </template>
    </ViewComposer>

    <!-- Hidden while the OS mesh file picker is open; restored after the
         pick or the cancel (see onPickLocalMesh). -->
    <div v-show="!pickerOpen">
      <MeshToolPanel
        :mode="panelMode"
        :ctx="viewCtx"
        :assets="scene.assets"
        :asset="selectedAsset"
        :meshes="meshes"
        :templateMeshUrl="templateMesh ? templateMesh.url : ''"
        :results="searchResults"
        :searching="searchBusy"
        :searchError="searchError"
        :hasSearched="hasSearched"
        @cleanup="onCleanup"
        @search="onSearchSubmit"
        @pickResult="onResultClick"
        @setTemplate="onSetTemplate"
        @select="selectAsset"
        @save="onSaveDetails"
        @pickLocal="onPickLocalMesh"
      />
    </div>

    <!-- Fallback picker for browsers without window.showOpenFilePicker -->
    <input ref="localFileInput" type="file" accept=".glb" style="display: none" />
  </div>
</template>

<style scoped>
.build-scene {
  position: absolute;
  inset: 0;
  pointer-events: none;
}

/* The 2D map must receive its pan / zoom / click gestures. */
.build-scene__map {
  pointer-events: auto;
}

/* In the 3D tools the map stays mounted (warm tiles, instant return) but must
   neither show nor swallow any pointer gesture. Two class names raise the
   specificity above the composer's `.view-composer > *` pointer-events rule. */
.build-scene__map.build-scene__map--off {
  opacity: 0;
  pointer-events: none;
}
</style>
