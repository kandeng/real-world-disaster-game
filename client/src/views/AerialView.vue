<script setup>
import { ref, computed, onMounted, onUnmounted, watch, h } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import ViewComposer from '@shared/_ViewComposer.vue';
import CollisionWarning from '@shared/CollisionWarning.vue';
import StreetViewPane from '@shared/StreetViewPane.vue';
import { useDrone } from '@shared-composables/useDrone.js';
import { useAltitudeGate, PHASES, DESCEND_THRESHOLD, ASCEND_THRESHOLD } from '@shared-composables/useAltitudeGate.js';
import { useFlightCommands } from '@shared-composables/useFlightCommands.js';
import { useCameraCommands } from '@shared-composables/useCameraCommands.js';
import { useFlightPhysics } from '@shared-composables/useFlightPhysics.js';
import { useCameraPhysics } from '@shared-composables/useCameraPhysics.js';
import { useDockRegistry } from '@shared-composables/useDockRegistry.js';
import { usePageRegistry } from '@shared-composables/usePageRegistry.js';
import { useScreenCapture } from '@shared-composables/useScreenCapture.js';
import { useConnectionStatus, checkGoogleConnection, checkCesiumConnection } from '@shared-composables/useConnectionStatus.js';
import DockMenuButton from '@shared/DockMenuButton.vue';
import ConnectionError from '@shared/ConnectionError.vue';

const { t } = useI18n();

const router = useRouter();

const { drone, gimbal } = useDrone();
const altitudeGate = useAltitudeGate(drone);

const isLowAltitude = computed(() => (drone.alt - altitudeGate.surfaceAlt.value) < 10);
const isHighAltitude = computed(() => (drone.alt - altitudeGate.surfaceAlt.value) >= 10);

const {
  flight,
  flightCmd,
  activeFlightMode,
  showFlight,
  toggleFlight,
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
  toggleCamera,
  onCameraMove,
  onCameraStop,
  onCameraModeChange,
  startKeyboard: startCameraKeyboard,
  stopKeyboard: stopCameraKeyboard,
} = useCameraCommands();

const { computeDesiredEnuMove, applyEnuMove, updateTelemetry: updateFlightTelemetry } = useFlightPhysics();
const { step: stepCameraPhysics } = useCameraPhysics();
const { leftItems, rightItems, registerLeft, registerRight, clear } = useDockRegistry();
const { pages, registerPage, unregisterPage } = usePageRegistry();
const { recorderState, replayProgress, captureScreenshot, sampleFrame, toggleRecorder, resetRecorder } = useScreenCapture();
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
const showStreetView = computed(() => (drone.alt - altitudeGate.surfaceAlt.value) < ASCEND_THRESHOLD);
const shouldPrewarmSV = computed(() => {
  const phase = altitudeGate.flightPhase.value;
  if (phase === PHASES.PRE_LANDING || phase === PHASES.DESCENDING) return true;
  return (drone.alt - altitudeGate.surfaceAlt.value) < 20;
});
const isTransitioning = computed(() => {
  const rel = drone.alt - altitudeGate.surfaceAlt.value;
  return rel >= DESCEND_THRESHOLD && rel < ASCEND_THRESHOLD;
});
const streetViewOpacity = computed(() => {
  const rel = drone.alt - altitudeGate.surfaceAlt.value;
  if (rel <= DESCEND_THRESHOLD) return 1;
  if (rel >= ASCEND_THRESHOLD) return 0;
  return 1 - (rel - DESCEND_THRESHOLD) / (ASCEND_THRESHOLD - DESCEND_THRESHOLD);
});
const takeoffLandingLabel = computed(() => {
  const p = altitudeGate.flightPhase.value;
  if (p === PHASES.PRE_TAKEOFF) return t('aerialview.preparing_takeoff');
  if (p === PHASES.PRE_LANDING) return t('aerialview.scanning_landing');
  if (p === PHASES.ASCENDING) return t('aerialview.taking_off');
  if (p === PHASES.DESCENDING) return t('aerialview.landing_in_progress');
  return altitudeGate.isOnGround.value ? t('aerialview.takeoff') : t('aerialview.landing');
});

function hideAllDisks() {
  showFlight.value = false;
  showCamera.value = false;
}

function toggleTakeoffLanding() {
  const viewer = window.cesiumViewer;
  if (altitudeGate.isOnGround.value) {
    altitudeGate.startTakeoff(viewer);
  } else {
    altitudeGate.startLanding(viewer);
  }
}

watch(
  [showStreetView, isTransitioning, streetViewReady],
  ([show, transitioning, svReady]) => {
    const viewer = window.cesiumViewer;
    if (viewer) {
      viewer.scene.globe.show = show && transitioning;
    }
    if (cesiumContainer.value) {
      // Only hide Cesium when Street View is fully loaded to prevent black flash
      cesiumContainer.value.classList.toggle('cesium-hidden', show && !transitioning && svReady);
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
  const tileset = window.getGoogleTileset ? window.getGoogleTileset() : null;
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
  if (typeof window.updateCesiumCamera === 'function') {
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
      sampleFrame(drone, gimbal);
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

  // Register pages for the router menu
  registerPage({ id: 'aerial', nameKey: 'aerialview.page_aerial', route: '/' });
  registerPage({ id: 'mesh', nameKey: 'aerialview.page_mesh', route: '/mesh' });
  registerPage({ id: '3dgs', nameKey: 'aerialview.page_3dgs' });
  registerPage({ id: 'map', nameKey: 'aerialview.page_map', route: '/map' });
  registerPage({ id: 'satellite', nameKey: 'aerialview.page_satellite', route: '/satellite' });
  registerPage({ id: 'myspace', nameKey: 'aerialview.page_myspace', route: '/myspace' });
  registerPage({ id: 'chat', nameKey: 'aerialview.page_chat', route: '/chat' });
  registerPage({ id: 'extensions', nameKey: 'aerialview.page_extensions', route: '/extensions' });
  registerPage({ id: 'settings', nameKey: 'aerialview.page_settings', route: '/settings' });

  registerLeft({
    id: 'router',
    render: () => h(DockMenuButton, {
      icon: 'MENU_ROUTER',
      titleKey: 'aerialview.pages',
      pages,
      onBeforeOpen: hideAllDisks,
    }),
  });
  registerLeft({
    id: 'camera',
    icon: 'MENU_CAMERA',
    titleKey: 'aerialview.camera',
    active: showCamera.value,
    onClick: toggleCamera,
  });
  registerLeft({
    id: 'screenshot',
    icon: 'MENU_PHOTO',
    titleKey: 'aerialview.screenshot',
    onClick: captureScreenshot,
  });
  registerLeft({
    id: 'recorder',
    icon: 'MENU_RECORDER',
    titleKey: 'aerialview.recorder',
    active: isRecorderActive,
    danger: true,
    onClick: toggleRecorder,
  });

  registerRight({
    id: 'steer',
    icon: 'MENU_CONTROL_STICK',
    titleKey: 'aerialview.steer',
    active: showFlight.value,
    onClick: toggleFlight,
  });
  registerRight({
    id: 'takeoff',
    icon: isLowAltitude.value ? 'MENU_TAKEOFF' : 'MENU_LANDING',
    titleKey: isLowAltitude.value ? 'aerialview.takeoff' : 'aerialview.landing',
    onClick: toggleTakeoffLanding,
  });

  // Sync dock button active states with toggle state
  watch(showFlight, (val) => {
    const item = rightItems.find((i) => i.id === 'steer');
    if (item) item.active = val;
  });
  watch(showCamera, (val) => {
    const item = leftItems.find((i) => i.id === 'camera');
    if (item) item.active = val;
  });

  // React to recorder state transitions: update the dock button title, and
  // close the Flight/Gimbal disks during replay (restored when it ends).
  watch(recorderState, (state, prev) => {
    const item = leftItems.find((i) => i.id === 'recorder');
    if (item) {
      item.titleKey =
        state === 'recording' ? 'aerialview.recorder_stop'
        : state === 'replaying' ? 'aerialview.recorder_cancel'
        : 'aerialview.recorder';
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

  // Sync takeoff/landing button icon and label.
  // < 10m from ground → Takeoff,  > 100m from ground → Landing.
  // Between 10–100m → keep the previous state unchanged.
  watch(
    [isLowAltitude, isHighAltitude],
    ([low, high]) => {
      const item = rightItems.find((i) => i.id === 'takeoff');
      if (!item) return;
      // In the 10–100m band, preserve the current button state.
      if (!low && !high) return;
      const showTakeoff = low;
      item.icon = showTakeoff ? 'MENU_TAKEOFF' : 'MENU_LANDING';
      item.titleKey = showTakeoff ? 'aerialview.takeoff' : 'aerialview.landing';
    },
    { immediate: true }
  );

  // Disable non-navigation dock buttons during takeoff/landing transitions.
  // During collision pause, only the takeoff/landing button stays disabled
  // (flight/camera controls remain active so user can reposition).
  // Pages (router) and Chat buttons remain enabled so the user can navigate away.
  watch([isTakeoffLanding, isPausedByCollision], ([transitioning, paused]) => {
    const disableAllIds = ['steer', 'takeoff', 'camera', 'recorder'];
    const disableButtonOnlyIds = ['takeoff'];
    const disableIds = paused ? disableButtonOnlyIds : disableAllIds;
    for (const list of [leftItems, rightItems]) {
      for (const item of list) {
        if (disableAllIds.includes(item.id)) {
          item.disabled = transitioning && disableIds.includes(item.id);
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
  unregisterPage('aerial');
  unregisterPage('mesh');
  unregisterPage('3dgs');
  unregisterPage('map');
  unregisterPage('satellite');
  unregisterPage('myspace');
  unregisterPage('chat');
  unregisterPage('extensions');
  unregisterPage('settings');
});
</script>

<template>
  <ViewComposer
    :left-items="leftItems"
    :right-items="rightItems"
    :show-flight="showFlight"
    :show-camera="showCamera"
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
      <StreetViewPane
        class="view-composer__background"
        :lat="drone.lat"
        :lon="drone.lon"
        :heading="getStreetViewPov().headingRad"
        :pitch="getStreetViewPov().pitchRad"
        :altitude="getStreetViewPov().relativeAlt"
        :visible="showStreetView"
        :prewarm="shouldPrewarmSV"
        :style="{ opacity: streetViewOpacity }"
        @ready="streetViewReady = true"
      />
    </template>

    <template #top-overlay>
      <ConnectionError :visible="showConnectionError" :message="connectionMessage" />
      <CollisionWarning :visible="isCollisionFrozen" />
      <div v-if="collisionPausedMessage" class="top-center-message top-center-message--warning">
        {{ collisionPausedMessage }}
      </div>
      <div v-if="lockedMessage" class="top-center-message top-center-message--warning">
        {{ lockedMessage }}
      </div>
      <div
        v-if="isPreCaching"
        class="pre-cache-overlay"
      >
        <span class="pre-cache-overlay__text">{{ takeoffLandingLabel }}</span>
      </div>
      <div
        v-if="recorderState === 'replaying'"
        class="top-center-message replay-pill"
      >
        {{ t('aerialview.replaying', { pct: Math.round(replayProgress * 100) }) }}
      </div>
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

.pre-cache-overlay {
  position: fixed;
  top: 24px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 100;
  display: inline-flex;
  align-items: center;
  pointer-events: none;
}

.pre-cache-overlay__text {
  font-family: Calibri, 'Segoe UI', sans-serif;
  font-size: 0.77rem;
  font-weight: 700;
  color: #ffffff;
  padding: 12px 28px;
  border-radius: 8px;
  background: rgba(34, 197, 94, 0.88);
  letter-spacing: 0.02em;
  white-space: nowrap;
  box-shadow: 0 0 18px rgba(34, 197, 94, 0.6);
  animation: scan-pulse 1.2s ease-in-out infinite;
}

.pre-cache-overlay--shake {
  animation: engine-shake 0.08s infinite alternate;
}

.pre-cache-overlay--scan .pre-cache-overlay__text {
  animation: scan-pulse 1.2s ease-in-out infinite;
}

@keyframes engine-shake {
  0%   { transform: translateX(-50%) translate(1px, -1px); }
  25%  { transform: translateX(-50%) translate(-1px, 2px); }
  50%  { transform: translateX(-50%) translate(2px, 0px); }
  75%  { transform: translateX(-50%) translate(-2px, -1px); }
  100% { transform: translateX(-50%) translate(1px, 1px); }
}

@keyframes scan-pulse {
  0%, 100% { opacity: 0.6; }
  50%      { opacity: 1; }
}

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

.top-center-message--warning {
  background: rgba(180, 100, 0, 0.9);
  box-shadow: 0 0 18px rgba(180, 100, 0, 0.6);
  animation: scan-pulse 1.2s ease-in-out infinite;
}

.replay-pill {
  background: rgba(37, 99, 235, 0.9);
  box-shadow: 0 0 18px rgba(37, 99, 235, 0.55);
}
</style>
