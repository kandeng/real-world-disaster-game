<script setup>
import { ref, computed, watch, h, onMounted, onUnmounted, nextTick } from 'vue';
import { useI18n } from 'vue-i18n';
import ViewComposer from '@shared/_ViewComposer.vue';
import DockMenuButton from '@shared/DockMenuButton.vue';
import VolumeDockButton from '@shared/VolumeDockButton.vue';
import { useFlightCommands } from '@shared-composables/useFlightCommands.js';
import { useDockRegistry } from '@shared-composables/useDockRegistry.js';
import { usePageRegistry } from '@shared-composables/usePageRegistry.js';
import { createWhepPlayer } from '@shared-composables/useWhepPlayer.js';
import { useStreamConfig } from '@shared-composables/useStreamConfig.js';
import { useDroneTelemetry } from '@shared-composables/useDroneTelemetry.js';
import { useDroneCommands } from '@shared-composables/useDroneCommands.js';
import { useAppSettings } from '@shared-composables/useAppSettings.js';
import { useAuth } from '@shared-composables/useAuth.js';
import { useLiveCapture } from '@shared-composables/useLiveCapture.js';

const { t } = useI18n();
const { settings } = useAppSettings();

// Live telemetry of the physical drone (singleton WS subscription; feeds
// the Host subpage's HUD via the ViewComposer's realTelemetry prop).
const { telemetry: droneTelemetry } = useDroneTelemetry();

// Real flight commands (takeoff/land/hover/move/...) — the separated module.
const droneCommands = useDroneCommands();

// ── Takeoff / Stop / Landing switcher (real drone) ──
// Same user-driven 4-state cycle as the 3D Exploration subpages:
//   takeoff -> stop -> landing -> stop -> takeoff -> ...
// No airborne/on-ground judgment: the user cycles freely, even mid-maneuver.
//   takeoff -> bridge MotionCommander takeoff to ~0.5 m
//   stop    -> hover in place (zero velocity — NOT the motor-cut emergency)
//   landing -> the bridge's gentle landing profile
// The state advances only when the command was actually sent (a dropped
// command — link down — must not light up a phantom state). The button is
// never disabled by maneuvers; the subpage locking below is unchanged.
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

function toggleTakeoff() {
  const action = SWITCH_SEQUENCE[switchIndex.value];
  const sent = action === 'takeoff' ? droneCommands.takeoff()
    : action === 'landing' ? droneCommands.land()
    : droneCommands.hover();
  if (!sent) return;
  switchIndex.value = (switchIndex.value + 1) % SWITCH_SEQUENCE.length;
  syncTakeoffSwitchItem();
}

// ── Flight disk -> real drone ──
// Disk payloads are in ±sensitivity units (FlightController default 3),
// scaled here into the bridge's safe ranges. While a command is active it is
// re-sent every 150 ms: the bridge's dead-man switch (0.5 s) would otherwise
// hover the drone — and lost keep-alives (closed tab, dead relay) hover it
// automatically. currentMove holds DISK axes (vx right+, vy forward+);
// sendCurrentMove maps them onto the cflib body frame (vx forward, vy left,
// vz up, yawrate deg/s — sign calibration pending the first flight test).
const DISK_UNITS = 3;
const DISK_MAX_XY = 0.5;  // m/s horizontal
const DISK_MAX_Z = 0.5;   // m/s vertical
const DISK_MAX_YAW = 60;  // deg/s yaw
const MOVE_KEEPALIVE_MS = 150;

const currentMove = { vx: 0, vy: 0, vz: 0, yawRate: 0 };
let moveKeepAlive = null;

function sendCurrentMove() {
  const c = currentMove;
  droneCommands.move({ vx: c.vy, vy: -c.vx, vz: c.vz, yawRate: c.yawRate });
}

function ensureMoveKeepAlive() {
  if (moveKeepAlive) return;
  moveKeepAlive = setInterval(() => {
    const c = currentMove;
    if (c.vx || c.vy || c.vz || c.yawRate) sendCurrentMove();
  }, MOVE_KEEPALIVE_MS);
}

function onRealFlightMove(payload) {
  onFlightMove(payload); // keep the disk UI state in sync
  if (!payload || !payload.mode) return;
  if (payload.mode === 'M') {
    currentMove.vx = ((payload.vx || 0) / DISK_UNITS) * DISK_MAX_XY;
    currentMove.vy = ((payload.vy || 0) / DISK_UNITS) * DISK_MAX_XY;
    currentMove.vz = 0;
    currentMove.yawRate = 0;
  } else if (payload.mode === 'H') {
    currentMove.vx = 0;
    currentMove.vy = 0;
    currentMove.vz = ((payload.vz || 0) / DISK_UNITS) * DISK_MAX_Z;
    currentMove.yawRate = 0;
  } else if (payload.mode === 'R') {
    currentMove.vx = 0;
    currentMove.vy = 0;
    currentMove.vz = 0;
    currentMove.yawRate = ((payload.yaw || 0) / DISK_UNITS) * DISK_MAX_YAW;
  }
  ensureMoveKeepAlive();
  sendCurrentMove(); // immediate response; the interval keeps it alive
}

// Zero the command and tell the drone to hover (the zero-velocity move also
// disarms the bridge watchdog). Called on disk release, disk close, subpage
// switch away from 'host', and unmount.
function stopRealFlight() {
  onFlightStop();
  currentMove.vx = 0;
  currentMove.vy = 0;
  currentMove.vz = 0;
  currentMove.yawRate = 0;
  droneCommands.hover();
}

function onRealFlightStop() {
  stopRealFlight();
}

// ── Emergency stop (red button, top of the right sidebar) ──
// Cuts the motors NOW — the drone falls, even mid-air (bridge 'estop' ->
// commander.send_stop_setpoint). Zero the disk state FIRST so the 150 ms
// keep-alive cannot resurrect thrust before the estop lands; then reset
// the takeoff switcher to offer 'takeoff' again (the drone is down).
// Deliberately NOT the switcher's 'stop' (hover) nor 'landing' (gentle).
function emergencyStop() {
  currentMove.vx = 0;
  currentMove.vy = 0;
  currentMove.vz = 0;
  currentMove.yawRate = 0;
  onFlightStop();
  droneCommands.estop();
  switchIndex.value = 0;
  syncTakeoffSwitchItem();
}

// ── Screenshot / Recorder on the live stream ──
// Same login gate as the 3D subpages: anonymous users get a green top-center
// reminder instead of the capture action. The capture source is whichever
// <video> is on screen (both subpages play the SAME shared stream, so both
// buttons work on the Viewer too).
const { isAuthenticated } = useAuth();
const { recorderState, isRecorderActive, captureScreenshot, toggleRecorder, stopRecorder } = useLiveCapture();

const captureAuthNotice = ref(''); // '' | 'screenshot' | 'recording'
let captureAuthTimer = null;
function flashCaptureAuth(action) {
  captureAuthNotice.value = action;
  clearTimeout(captureAuthTimer);
  captureAuthTimer = setTimeout(() => { captureAuthNotice.value = ''; }, 6000);
}

function guardedScreenshot() {
  if (isAuthenticated.value) return captureScreenshot(activeVideoEl());
  flashCaptureAuth('screenshot');
}

function guardedToggleRecorder() {
  // Never trap an ACTIVE recording: toggling off is always allowed.
  if (isAuthenticated.value || recorderState.value !== 'idle') return toggleRecorder(activeVideoEl());
  flashCaptureAuth('recording');
}

// Real Drone (真机接入) page — UI shell only.
//
// Single subpage: 'host' (Livestream Host / 机主直播) — mirrors the 3D Aerial
// outlook: HUD dashboard (REAL drone telemetry, relayed drone -> server ->
// browser via extension/crazyflie_bridge/telemetry_relay.py) and the Flight
// disk, wired to the REAL drone via the separated flight-functions module
// @shared-composables/useDroneCommands.js (browser -> server
// /api/drone/command -> telemetry_relay.py -> motion_control_ws.py).
// Safety: the bridge REFUSES takeoff while the drone is tethered via USB,
// and a 0.5 s dead-man switch hovers the drone if velocity commands stop
// arriving (closed tab, dead relay/server).
// There is NO Camera/Gimbal UI: the Crazyflie has no gimbal.
//
// The former 'viewer' subpage (stream catalog + player) moved to
// Community -> Livestream Viewer (ChatView); this page always plays the
// PRIMARY stream as the host monitor.

const {
  flight,
  showFlight,
  toggleFlight,
  onFlightMove,
  onFlightStop,
  onFlightModeChange,
} = useFlightCommands();

const { leftItems, rightItems, registerLeft, registerRight, clear } = useDockRegistry();
const { pages, registerPage, unregisterPage } = usePageRegistry();

function hideAllDisks() {
  stopRealFlight(); // never leave a stale velocity running on the real drone
  showFlight.value = false;
}

// Opening the Pages menu hides the disks (safety while navigating away).
// The Viewer subpage moved to Community, so this page IS the Host context
// and the flight-control buttons are always unlocked.
function onPagesBeforeOpen() {
  hideAllDisks();
}

/* ─── Livestream: WHEP playback of the MediaMTX stream catalog ─── */
// ONE shared connection for both subpages, playing ONE selected stream
// (default: the PRIMARY, first catalog entry = our own broadcast).
// The ONLY way to change the stream is clicking a card in the Viewer's
// left panel — a stop()+start() re-handshake, so just one stream ever
// consumes bandwidth. Switching subpages NEVER changes the stream: it
// only re-attaches the already-live MediaStream, no second handshake.
// The catalog comes from the backend's /api/stream/config (server/
// config.json "mediamtx" section) with per-environment fallbacks — see
// useStreamConfig. Passed to the player as a getter so it is resolved at
// every start()/retry — the async config fetch needs no await here.
const { streams } = useStreamConfig();

// The Viewer subpage (stream catalog + card selection) now lives in
// Community -> Livestream Viewer; this page always plays the PRIMARY
// stream (first catalog entry = our own broadcast).
const targetUrl = computed(() => streams.value[0]?.whep_url || '');
// What the player was last started with — restart only on a real change.
let playingUrl = '';

const hostVideoEl = ref(null);

// Top-center green progress pill while the connection is being set up
// (same look as the 3D Aerial/Mesh asset-loading bar).
const liveLoading = ref(false);
const liveProgress = ref(0); // 0..1

function onLiveProgress(phase) {
  if (phase === 'start') {
    liveLoading.value = true;
    liveProgress.value = 0.15;
  } else if (phase === 'offer') {
    liveProgress.value = Math.max(liveProgress.value, 0.35);
  } else if (phase === 'handshake') {
    liveProgress.value = Math.max(liveProgress.value, 0.65);
  } else if (phase === 'track') {
    liveProgress.value = Math.max(liveProgress.value, 0.85);
  }
}

const livePlayer = createWhepPlayer({
  url: () => targetUrl.value,
  logTag: 'live',
  onProgress: onLiveProgress,
});

// The video element actually rendered a frame — finish the progress bar.
function onLivePlaying() {
  liveProgress.value = 1;
  setTimeout(() => {
    liveLoading.value = false;
  }, 400);
}

// Point the shared connection at a freshly mounted <video> element.
// Diagnostic: log how long the first frame takes to appear after attach,
// so view-side delay is separable from connection-side delay.
function attachLiveStream(el) {
  if (!el) return;
  const tAttach = performance.now();
  console.log(`[live] attach -> host <video> (tracks already live: ${livePlayer.hasTracks()})`);
  el.addEventListener('playing', () => {
    console.log(`[live] first frame rendered on host <video> (${el.videoWidth}x${el.videoHeight}) — t+${((performance.now() - tAttach) / 1000).toFixed(2)}s after attach`);
    onLivePlaying();
  }, { once: true });
  livePlayer.attach(el);
}

// Re-point the shared connection at the selected stream. No-op when
// the URL is unchanged. On a real change (Viewer card click or late-
// arriving server config): stop() [which also forgets the render
// target], re-attach, then start() — the progress pill replays via
// onProgress('start').
function syncLiveStream() {
  if (!targetUrl.value || targetUrl.value === playingUrl) return;
  playingUrl = targetUrl.value;
  livePlayer.stop();
  attachLiveStream(activeVideoEl());
  livePlayer.start();
}

// Card clicks and late-arriving server config both funnel through
// targetUrl — a single watcher restarts the connection on any change.
watch(targetUrl, syncLiveStream);

/* ─── Livestream sound / fullscreen state (Host monitor) ─── */
// Default muted: autoplay-friendly, and on the Host's own machine it avoids
// a mic -> stream -> speaker feedback loop.
const liveMuted = ref(true);
const liveFullscreen = ref(false);

/* ─── Livestream sound: splash-style volume pill driving the app-wide setting ─── */
// The volume pill always drives the Host monitor <video>.
function activeVideoEl() {
  return hostVideoEl.value;
}

function applyLiveVolume() {
  const el = activeVideoEl();
  if (el) el.volume = settings.audioVolume;
}

// Slider interaction is a user gesture, so it is safe to unmute here.
function onLiveVolumeInput() {
  const el = activeVideoEl();
  if (el) {
    el.muted = false;
    applyLiveVolume();
  }
  liveMuted.value = false;
}

function toggleLiveMute() {
  const el = activeVideoEl();
  if (!el) return;
  el.muted = !el.muted;
  if (!el.muted) applyLiveVolume();
  liveMuted.value = el.muted;
}

/* ─── Fullscreen toggle (right sidebar) ─── */
// Page-fill <-> raw size; covers the HUD for a clean monitoring view. The
// docks stay clickable above the fullscreen video (z-index bump), and Esc
// exits as well.
function toggleLiveFullscreen() {
  liveFullscreen.value = !liveFullscreen.value;
}

function onLiveEsc(e) {
  if (e.key === 'Escape') liveFullscreen.value = false;
}

// Entering fullscreen lets CSS (object-fit: contain) size the video;
// leaving it restores the Viewer's raw-size fit.
watch(liveFullscreen, (fs) => {
  const el = hostVideoEl.value;
  if (fs) {
    if (el) {
      el.style.width = '';
      el.style.height = '';
    }
    document.addEventListener('keydown', onLiveEsc);
  } else {
    document.removeEventListener('keydown', onLiveEsc);
  }
  // Reflect the state on the dock button (highlight + tooltip swap).
  const item = rightItems.find((i) => i.id === 'fullscreen');
  if (item) {
    item.active = fs;
    item.titleKey = fs ? 'aerialview.exit_fullscreen' : 'aerialview.fullscreen';
  }
});

// Keep the video volume in sync with the app-wide Media setting.
watch(() => settings.audioVolume, applyLiveVolume);

onMounted(() => {
  // Register pages for the router menu
  registerPage({ id: 'aerial', nameKey: 'aerialview.page_aerial', route: '/' });
  registerPage({ id: 'map', nameKey: 'aerialview.page_map', route: '/map' });
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
      onBeforeOpen: onPagesBeforeOpen,
    }),
  });
  registerLeft({
    id: 'subpage_host',
    icon: 'MENU_REMOTE_CONTROLLER',
    titleKey: 'aerialview.subpage_livestream_host',
    active: true,
    onClick: () => {},
  });
  // NOTE: no 'camera' button here — the Crazyflie has no gimbal, so the
  // Gimbal disk and its toggle are deliberately absent on this page.

  // Invisible flex spacer: with .app-dock__inner at full height, the two
  // spacers absorb the free space above/below the button group so the
  // volume pill (registered last) sits at the VERY BOTTOM of the right
  // sidebar while the buttons keep their roughly centered look.
  // Emergency stop pinned to the VERY TOP of the right sidebar, above the
  // flex spacer that centers the other buttons. Never locked by subpage —
  // an emergency button must always be clickable.
  registerRight({
    id: 'estop',
    icon: 'MENU_RED_STOP',
    titleKey: 'aerialview.emergency_stop',
    danger: true,
    onClick: emergencyStop,
  });
  registerRight({ id: 'dock_spacer_top', render: () => h('div', { style: 'flex: 1 1 auto' }) });
  registerRight({
    id: 'steer',
    icon: 'MENU_CONTROL_STICK',
    titleKey: 'aerialview.steer',
    active: showFlight.value,
    onClick: toggleFlight,
  });
  registerRight({
    id: 'takeoff',
    icon: 'MENU_TAKEOFF',
    titleKey: 'aerialview.takeoff',
    onClick: toggleTakeoff,
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
  registerRight({
    id: 'fullscreen',
    icon: 'MENU_WINDOW_SIZE',
    titleKey: 'aerialview.fullscreen',
    active: false,
    onClick: toggleLiveFullscreen,
  });
  registerRight({ id: 'dock_spacer_bottom', render: () => h('div', { style: 'flex: 1 1 auto' }) });
  registerRight({
    id: 'volume',
    render: () =>
      h(VolumeDockButton, {
        muted: liveMuted.value,
        title: t('aerialview.volume'),
        onToggleMute: toggleLiveMute,
        onVolumeInput: onLiveVolumeInput,
      }),
  });

  // Sync dock button active states with toggle state
  watch(showFlight, (val) => {
    const item = rightItems.find((i) => i.id === 'steer');
    if (item) item.active = val;
  });

  // Connect the livestream right away.
  nextTick(() => {
    attachLiveStream(hostVideoEl.value);
    playingUrl = targetUrl.value;
    livePlayer.start();
  });
});

onUnmounted(() => {
  stopRealFlight();
  stopRecorder(); // an active clip still downloads via the recorder's onstop
  clearTimeout(captureAuthTimer);
  if (moveKeepAlive) {
    clearInterval(moveKeepAlive);
    moveKeepAlive = null;
  }
  livePlayer.stop();
  clear();
  unregisterPage('aerial');
  unregisterPage('realdrone');
  unregisterPage('map');
  unregisterPage('myspace');
  unregisterPage('chat');
  unregisterPage('extensions');
});
</script>

<template>
  <ViewComposer
    :class="{ 'live-fullscreen-active': liveFullscreen }"
    :left-items="leftItems"
    :right-items="rightItems"
    :show-flight="showFlight"
    :show-camera="false"
    :show-hud="true"
    :flight="flight"
    :real-telemetry="droneTelemetry"
    @flightMove="onRealFlightMove"
    @flightStop="onRealFlightStop"
    @flightModeChange="onFlightModeChange"
  >
    <template #background>
      <!-- Livestream Host monitor: fullscreen view of the PRIMARY stream.
           Muted so autoplay is allowed and to avoid audio feedback. -->
      <video
        ref="hostVideoEl"
        class="host-live"
        :class="{ 'host-live--fullscreen': liveFullscreen }"
        autoplay
        muted
        playsinline
      />
    </template>

    <template #top-overlay>
      <!-- Login reminder for Screenshot / Recorder (same gate as the 3D pages) -->
      <div
        v-if="captureAuthNotice"
        class="top-center-message top-center-message--auth"
      >
        {{ t(`aerialview.auth_notice_${captureAuthNotice}`) }}
      </div>
      <!-- Green progress pill while the livestream connection is set up -->
      <div v-if="liveLoading" class="top-center-message asset-loading">
        <span>{{ t('aerialview.loading_livestream') }}</span>
        <div class="asset-loading__track">
          <div class="asset-loading__fill" :style="{ width: (liveProgress * 100).toFixed(1) + '%' }" />
        </div>
      </div>
    </template>
  </ViewComposer>
</template>

<style scoped>
/* ─── Livestream Host monitor ─── */
.host-live {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: contain; /* keep the webcam's 4:3 aspect, letterbox the rest */
  background: #000;
  pointer-events: none; /* docks / HUD stay interactive above the video */
}

/* Fullscreen Host monitor: cover the HUD for a clean monitoring view. */
.host-live--fullscreen {
  position: fixed;
  z-index: 100;
}

/* Keep both sidebars clickable above the fullscreen video (video z-index
   is 100; the docks are normally 10) so the toggle can switch back. */
.live-fullscreen-active :deep(.app-dock) {
  z-index: 101;
}

/* ─── Livestream connection progress pill (mirrors AerialView asset-loading) ─── */
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
}

.top-center-message--auth {
  background: rgba(34, 197, 94, 0.92);
  box-shadow: 0 0 18px rgba(34, 197, 94, 0.6);
}

.asset-loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  background: rgba(34, 197, 94, 0.88);
  box-shadow: 0 0 18px rgba(34, 197, 94, 0.6);
}

.asset-loading__track {
  width: 240px;
  height: 6px;
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.3);
  overflow: hidden;
}

.asset-loading__fill {
  height: 100%;
  border-radius: 3px;
  background: #ffffff;
  transition: width 0.15s linear;
}
</style>
