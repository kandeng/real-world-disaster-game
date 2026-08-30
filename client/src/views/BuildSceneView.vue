<script setup>
import { ref, computed, onMounted, onUnmounted, watch } from 'vue';
import { MapView } from '@/2d_map/index.js';
import ViewComposer from '@shared/_ViewComposer.vue';
import MeshToolPanel from '@shared/MeshToolPanel.vue';
import { useDockRegistry } from '@shared-composables/useDockRegistry.js';
import { useSessionState } from '@shared-composables/useSessionState.js';
import { useMeshPlacement } from '@shared-composables/useMeshPlacement.js';
import { useDrone } from '@shared-composables/useDrone.js';
import { useFlightCommands } from '@shared-composables/useFlightCommands.js';
import { useCameraCommands } from '@shared-composables/useCameraCommands.js';
import { useFlightPhysics } from '@shared-composables/useFlightPhysics.js';
import { useCameraPhysics } from '@shared-composables/useCameraPhysics.js';

const { session } = useSessionState();
const viewCtx = session.view.buildscene; // { mode: '2d' | '3d' }
const { drone, gimbal } = useDrone();
const mesh = useMeshPlacement();
const { rightItems, registerRight, clear } = useDockRegistry();

// ── Flight / gimbal drive (Steer tool) ────────────────────────────────────
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

// ── Mesh asset list (auto-discovered GLBs under client/assets/mesh) ──────
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
const meshes = Object.entries(meshModules).map(([path, url]) => {
  const name = path.split('/').pop().replace(/\.glb$/, '');
  return { name, url, label: MESH_LABELS[name] || name };
});

// ── Tool / background state ───────────────────────────────────────────────
// panelMode drives the floating tool panel; viewCtx.mode drives the background.
const panelMode = ref(''); // '' | 'mesh' | 'place' | 'steer'
const is2D = computed(() => viewCtx.mode === '2d');
const mapViewRef = ref(null);

const meshBtnActive = computed(() => panelMode.value === 'mesh');
const placeBtnActive = computed(() => panelMode.value === 'place');
const finetuneBtnActive = computed(() => panelMode.value === 'steer');
const driveBtnActive = computed(() => showFlight.value);

function togglePanel(mode) {
  if (panelMode.value === mode) {
    panelMode.value = '';
    return;
  }
  panelMode.value = mode;
  // Tool panels and the drive disks are mutually exclusive: while a panel
  // is open the Cesium camera must stay free (framed on the mesh).
  showFlight.value = false;
  showCamera.value = false;
  if (mode === 'place') viewCtx.mode = '2d';
  else if (mode === 'steer') viewCtx.mode = '3d';
}

// Steer tool: close every pop-up, reveal the globe and open the Flight +
// Gimbal disks so the drone can be flown around the placed mesh in 3D.
function toggleDrive() {
  const next = !showFlight.value;
  showFlight.value = next;
  showCamera.value = next;
  if (next) {
    panelMode.value = '';
    viewCtx.mode = '3d';
  }
}

// ── 2D <→ 3D background toggle ────────────────────────────────────────────
// The shared Cesium globe lives in #cesiumContainer (behind the Vue overlay).
// In 2D mode the Google map covers it and the globe is hidden; in 3D mode the
// globe is revealed and framed on the placed mesh.
function cesiumEl() {
  return document.getElementById('cesiumContainer');
}
watch(is2D, (twoD) => {
  const el = cesiumEl();
  if (el) el.classList.toggle('cesium-hidden', twoD);
  if (!twoD) frameMesh();
}, { immediate: true });

// ── 3D framing ────────────────────────────────────────────────────────────
// Point the Cesium camera at the mesh from an oblique viewpoint, then release
// the transform so the user can orbit / pan freely around it.
function frameMesh() {
  const v = window.cesiumViewer;
  if (!v) return;
  const { lat, lon, length, groundAlt, alt } = mesh.state;
  const tLat = lat != null ? lat : drone.lat;
  const tLon = lon != null ? lon : drone.lon;
  const centerAlt = (groundAlt || 0) + (alt || 0) + (length || 10) / 2;
  const dist = Math.max(30, (length || 10) * 2.5);
  try {
    v.camera.lookAt(
      Cesium.Cartesian3.fromDegrees(tLon, tLat, centerAlt),
      new Cesium.HeadingPitchRange(0, Cesium.Math.toRadians(-25), dist)
    );
    v.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
  } catch (err) {
    console.warn('[BuildScene] frameMesh failed:', err);
  }
}

// ── Slider changes re-compose the model matrix live ───────────────────────
watch(
  () => [mesh.state.alt, mesh.state.heading, mesh.state.pitch, mesh.state.roll, mesh.state.length],
  () => mesh.applyTransform()
);

// ── Drive loop: Flight / Gimbal disks move the drone + Cesium camera ──────
// Only steps while the disks are open; otherwise the camera stays free so
// the Finetune framing (frameMesh) is not fought over.
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
        // R-mode: rotate drone heading (3D view rotates accordingly)
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

// ── 2D footprint polygon ──────────────────────────────────────────────────
// A green rectangle centred on the mesh, oriented by heading, `length` long and
// 40% of the length wide. Drawn on the Google map while in 2D place mode.
function footprintCorners() {
  const { lat, lon, heading, length } = mesh.state;
  if (lat == null || lon == null || !length) return null;
  const halfL = length / 2;
  const halfW = (length * 0.4) / 2;
  const rad = (heading * Math.PI) / 180;
  // heading 0 = north, clockwise: forward = (sin, cos), right = (cos, -sin).
  const fwd = { x: Math.sin(rad), y: Math.cos(rad) };
  const right = { x: Math.cos(rad), y: -Math.sin(rad) };
  const mPerDegLat = 111320;
  const mPerDegLon = 111320 * Math.cos((lat * Math.PI) / 180) || 1;
  const corner = (f, r) => ({
    lat: lat + (fwd.y * f + right.y * r) / mPerDegLat,
    lng: lon + (fwd.x * f + right.x * r) / mPerDegLon,
  });
  return [
    corner(halfL, -halfW), // front-left
    corner(halfL, halfW),  // front-right
    corner(-halfL, halfW), // back-right
    corner(-halfL, -halfW) // back-left
  ];
}

function drawFootprint() {
  mapViewRef.value?.setMeshFootprint(footprintCorners());
}

watch(
  [
    () => mesh.state.lat,
    () => mesh.state.lon,
    () => mesh.state.heading,
    () => mesh.state.length,
    is2D
  ],
  () => {
    if (is2D.value) drawFootprint();
  }
);

// ── 2D map interactions ───────────────────────────────────────────────────
function onMapClick({ lat, lng }) {
  mesh.setPosition(lat, lng).then(() => drawFootprint());
}

function onMapReady() {
  if (is2D.value) drawFootprint();
}

// ── Mesh loading ──────────────────────────────────────────────────────────
function onLoadMesh(url, label) {
  mesh.loadMesh(url, label).then((ok) => {
    if (!ok) return;
    if (is2D.value) drawFootprint();
    else frameMesh();
  });
}

// ── Right dock: the four tool buttons ─────────────────────────────────────
onMounted(() => {
  registerRight({
    id: 'bs_mesh',
    icon: 'MENU_MESH',
    titleKey: 'buildsceneview.tool_mesh',
    active: meshBtnActive,
    onClick: () => togglePanel('mesh')
  });
  registerRight({
    id: 'bs_place',
    icon: 'MENU_MAP',
    titleKey: 'buildsceneview.tool_place',
    active: placeBtnActive,
    onClick: () => togglePanel('place')
  });
  registerRight({
    id: 'bs_finetune',
    icon: 'MENU_INSTRUMENT',
    titleKey: 'buildsceneview.tool_finetune',
    active: finetuneBtnActive,
    onClick: () => togglePanel('steer')
  });
  registerRight({
    id: 'bs_steer',
    icon: 'MENU_CONTROL_STICK',
    titleKey: 'buildsceneview.tool_steer',
    active: driveBtnActive,
    onClick: toggleDrive
  });

  // Clean entry: disks stay hidden until the Steer tool is pressed.
  showFlight.value = false;
  showCamera.value = false;
  startFlightKeyboard();
  startCameraKeyboard();
  rafId = requestAnimationFrame(loop);
});

onUnmounted(() => {
  stopFlightKeyboard();
  stopCameraKeyboard();
  if (rafId) cancelAnimationFrame(rafId);
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
      :show-flight="showFlight && !is2D"
      :show-camera="showCamera && !is2D"
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
      <!-- 2D background: Google satellite map for placing the mesh -->
      <template #background>
        <MapView
          v-if="is2D"
          ref="mapViewRef"
          class="build-scene__map"
          :lat="drone.lat"
          :lon="drone.lon"
          :alt="80"
          :heading="0"
          map-type-id="satellite"
          :is-picking="true"
          :show-drone-marker="false"
          :waypoints-editable="false"
          @mapReady="onMapReady"
          @mapClick="onMapClick"
        />
      </template>
    </ViewComposer>

    <!-- Floating tool panel -->
    <MeshToolPanel
      :mode="panelMode"
      :meshes="meshes"
      :state="mesh.state"
      @load="onLoadMesh"
    />
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

</style>
