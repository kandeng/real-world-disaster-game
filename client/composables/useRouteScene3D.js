import { ref } from 'vue';
import { Muxer, ArrayBufferTarget } from 'mp4-muxer';
import { useDrone } from './useDrone.js';
import { useFlightCommands } from './useFlightCommands.js';
import { useFlightPhysics } from './useFlightPhysics.js';
import { useCameraCommands } from './useCameraCommands.js';
import { useCameraPhysics } from './useCameraPhysics.js';
import { splinePath } from '../src/2d_map/spline.js';

// Route Planning 3D scene controller (module-scope singleton, same pattern
// as useFlightCommands / useScreenCapture). Encapsulates:
//   1. The simulation loop that keeps the shared Cesium camera slaved to
//      the virtual drone state while the Flight / Gimbal disks are shown
//      (full control parity with 3D Aerial, minus collision / Street View).
//   2. The first-person preview flight along the waypoint route: quality-
//      gated on 3D-tile streaming (the view freezes until every tile of the
//      current view is downloaded and rendered), with waypoint alt / speed /
//      gimbal-angle interpolation between waypoints. Save re-flies the whole
//      route as a capture flight recorded into a 16:9 mp4.

const { drone, gimbal } = useDrone();
const { flightCmd, activeFlightMode, showFlight } = useFlightCommands();
const { computeDesiredEnuMove, applyEnuMove, updateTelemetry: updateFlightTelemetry } = useFlightPhysics();
const { showCamera, cameraCmd } = useCameraCommands();
const { step: stepCameraPhysics } = useCameraPhysics();

// Waypoint parameter defaults (mirror RoutePlanningView's; backfilled there
// before any preview, so these are fallbacks only).
const WP_DEFAULT_ALT_M = 150;
const WP_DEFAULT_SPEED_MPS = 8.0;
const WP_DEFAULT_CAM_PITCH_DEG = -90;

// Preview quality gate. BEFORE takeoff the view is hard-stuck until the
// start view is fully rendered (READY_HOLD stable ready frames). Once
// airborne the flight rides through short tile-streaming "waves" (Google's
// tileset refines in waves — see cesium-main.js) on a GRACE_FRAMES budget
// instead of stopping at every one, and hard-stops (view frozen, spinning
// circle) only once the grace runs out — continuous motion, no judder.
const READY_HOLD = 15;   // ~0.25 s at 60 fps of stable readiness before takeoff
const GRACE_FRAMES = 30; // ~0.5 s at 60 fps of ride-through while tiles stream
const RESUME_HOLD = 5;   // stable ready frames needed to resume after a hard stop

// Virtual-drone cruise speed along the route (the HUD's v while focused).
// Default matches the 3D Aerial Takeoff/Landing auto speed (useAltitudeGate
// AUTO_SPEED = 8 m/s); the Flight disk's V mode trims it within ±100 km/h.
// A negative speed flies the route backward (destination -> origin).
const CRUISE_DEFAULT_MPS = 8.0;
const CRUISE_MAX_MPS = 100 / 3.6; // 100 km/h expressed in m/s
const CRUISE_RATE = 5; // cruise change (m/s) per second at full deflection
const cruiseSpeedMps = ref(CRUISE_DEFAULT_MPS);
const RECORDING_FPS = 30;
const RECORDING_MIN_BITRATE = 8_000_000;
const RECORDING_ASPECT = 16 / 9; // Save always outputs a 16:9 (w:h) frame

const previewActive = ref(false);
// True while Save is settling the recorder / downloading the clip (the HUD
// hides during the save action, same as during preview).
const saving = ref(false);

let rafId = null;
let lastErrorLogTs = 0;

// ── Preview path state ─────────────────────────────────────────────────────
let pathSamples = []; // { lat, lng, dist } — cumulative arc-length table
let pathTotalM = 0;
let previewCursorM = 0;
let previewWps = [];    // waypoint cards (alt / speed / gimbal interpolation)
let wpArcDist = [];     // arc-length position of each waypoint on the path
let flightDir = 1;      // +1 origin->destination, -1 backward (negative speed)
let previewHudSpeed = 0; // signed interpolated speed (HUD v while flying)
let captureMode = false;     // Save: record the flight into a 16:9 mp4
let captureCompleted = false;
let captureDoneResolve = null;
let readyStreak = 0;         // consecutive tile-ready frames
let graceFrames = 0;         // ride-through budget while tiles stream in
let flightReleased = false;  // takeoff gate passed -> grace window applies
// True while the preview/save flight is stuck waiting for the 3D tiles of
// the current view; the view shows a spinning circle and does not advance.
const waitingTiles = ref(false);
// Offline Save renderer state: renderProgress drives the frame-counter
// overlay ({ frame, total }); offlineAbort stops the pass at the next
// frame boundary (Pages / Map / Preview all call stopPreview to abort).
let offlineAbort = false;
const renderProgress = ref(null);
// Phase code of the running Save render pass ('' idle, 'start', 'tiles',
// 'render', 'mux', 'fly') so external UIs (the Content -> Route -> Video
// dialog) can show a live blue status line while frames are generated.
const renderStatus = ref('');
// 0..1 distance traveled along the route while a preview / capture flight
// is airborne (drives progress UIs when the offline frame counter is not
// active, i.e. during the MediaRecorder fallback save).
const flightProgress = ref(0);

// ── Recording state ────────────────────────────────────────────────────────
let mediaRecorder = null;
let recordedChunks = [];
let stream = null;
let mirrorCanvas = null;
let mirrorCtx = null;
let mirrorRafId = null;
let removePostRenderListener = null;
let lastClip = null; // { blob, ext } — most recently finished preview clip
let clipSettlePromise = null; // resolves once the recorder's onstop fires
let clipSettleResolve = null;

function getViewer() {
  const viewer = window.cesiumViewer;
  if (!viewer || typeof viewer.isDestroyed !== 'function' || viewer.isDestroyed()) {
    return null;
  }
  return viewer;
}

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

// ── Simulation loop (active only while the 3D subpage is shown) ──────────

// Focus mode: after the two-stage dive onto one waypoint, the disks edit
// that waypoint instead of flying the drone. Holds the reactive waypoint
// object (or null when not focused).
let focusWaypoint = null;

function setFocusWaypoint(wp) {
  focusWaypoint = wp || null;
  if (focusWaypoint) {
    // V-mode editing continues from the waypoint's own stored speed, and
    // the HUD's v mirrors it immediately (stepFrame slaves drone.speed to
    // cruiseSpeedMps while a waypoint is focused).
    const s = Number(focusWaypoint.speed);
    cruiseSpeedMps.value = Number.isFinite(s)
      ? Math.max(-CRUISE_MAX_MPS, Math.min(CRUISE_MAX_MPS, s))
      : CRUISE_DEFAULT_MPS;
  }
}

// Waypoint editing rates while focused.
const FOCUS_MOVE_RATE = 0.05; // m/s per deflection unit per meter of camera altitude
const FOCUS_ALT_RATE = 10;    // wp.alt change (m/s) per deflection unit
const FOCUS_ANGLE_RATE = 45;  // camera-angle change (deg/s) per deflection unit

function normDeg(v) {
  return ((((v + 180) % 360) + 360) % 360) - 180;
}

function stepFocusFrame(dt) {
  const wp = focusWaypoint;
  if (!wp) return;
  if (showFlight.value) {
    if (activeFlightMode.value === 'M') {
      // Slide the waypoint parallel to the screen; the camera follows it,
      // so the dot stays centered (heading is 0 after the dive: vy=north,
      // vx=east). Movement speed scales with the camera altitude.
      const mps = Math.max(5, drone.alt * FOCUS_MOVE_RATE);
      const mPerDegLat = 111320;
      const mPerDegLon = Math.max(1e-6, 111320 * Math.cos((wp.lat * Math.PI) / 180));
      wp.lat = Math.max(-90, Math.min(90, wp.lat + (flightCmd.vy * mps * dt) / mPerDegLat));
      wp.lng = Math.max(-180, Math.min(180, wp.lng + (flightCmd.vx * mps * dt) / mPerDegLon));
      drone.lat = wp.lat;
      drone.lon = wp.lng;
    } else if (activeFlightMode.value === 'H') {
      // Vertical stick raises/lowers the waypoint; the camera follows.
      wp.alt = Math.max(0, Math.min(100000, wp.alt + flightCmd.vz * FOCUS_ALT_RATE * dt));
      drone.alt = wp.alt;
    } else if (activeFlightMode.value === 'V') {
      // Vertical stick trims the virtual drone's cruise speed (±100 km/h);
      // negative flies the route backward (destination -> origin). The
      // value is stored on the waypoint itself, so its Route list row's
      // v field follows the disk live.
      cruiseSpeedMps.value = Math.max(
        -CRUISE_MAX_MPS,
        Math.min(CRUISE_MAX_MPS, cruiseSpeedMps.value + flightCmd.vz * CRUISE_RATE * dt)
      );
      wp.speed = cruiseSpeedMps.value;
    }
  }
  if (showCamera.value) {
    if (activeCameraMode.value === 'Z') {
      wp.camYaw = normDeg(wp.camYaw + cameraCmd.yaw * FOCUS_ANGLE_RATE * dt);
      gimbal.yaw = wp.camYaw;
    } else if (activeCameraMode.value === 'Y') {
      wp.camPitch = Math.max(-90, Math.min(90, wp.camPitch + cameraCmd.pitch * FOCUS_ANGLE_RATE * dt));
      gimbal.pitch = wp.camPitch;
    } else if (activeCameraMode.value === 'X') {
      wp.camRoll = normDeg(wp.camRoll + cameraCmd.roll * FOCUS_ANGLE_RATE * dt);
      gimbal.roll = wp.camRoll;
    }
  }
}

function stepManualFrame(dt) {
  if (focusWaypoint) {
    // The disks edit the focused waypoint; the drone/camera only mirror it.
    stepFocusFrame(dt);
    return;
  }
  if (showFlight.value) {
    // No altitude gate on this page: H-mode always changes altitude.
    const enuMove = computeDesiredEnuMove(dt, true);
    applyEnuMove(enuMove);
    updateFlightTelemetry(true);
    // R-mode: rotate the drone heading (the 3D view rotates accordingly).
    if (activeFlightMode.value === 'R') {
      drone.heading += flightCmd.yaw * 60.0 * dt;
    }
  }
  if (showCamera.value) {
    stepCameraPhysics(dt, { applyMovement: true });
  }
}

function stepFrame(dt) {
  // Trajectory speed for the HUD: the 3D ground distance + vertical change
  // covered this frame, divided by dt.
  const pLat = drone.lat;
  const pLon = drone.lon;
  const pAlt = drone.alt;
  if (previewActive.value) {
    stepPreviewFrame(dt);
  } else {
    stepManualFrame(dt);
  }
  const dh = haversineMeters(pLat, pLon, drone.lat, drone.lon);
  const dz = drone.alt - pAlt;
  drone.speed = Math.sqrt(dh * dh + dz * dz) / dt;
  // While focused, the HUD's v shows the V-mode cruise speed, not the
  // (usually zero) actual movement of the parked camera; during a preview
  // it shows the signed interpolated waypoint speed.
  if (focusWaypoint) drone.speed = cruiseSpeedMps.value;
  else if (previewActive.value) drone.speed = previewHudSpeed;
  syncCesiumCamera();
}

let lastLoopTs = 0; // rAF timestamp of the previous frame

function loop(ts) {
  // A single bad frame must never kill the loop: if it stops, the scene
  // freezes and the disks appear dead. Log throttled and keep animating.
  try {
    // Real elapsed time, clamped: the flight advances at a constant rate
    // regardless of render fps (photorealistic tiles routinely drop below
    // 60 fps on this machine), and a slow frame / tab switch never causes
    // a big positional jump. A fixed 1/60 s step used to make the motion
    // speed track the frame rate and uneven frames become visible judder.
    const dt = lastLoopTs > 0
      ? Math.min(0.05, Math.max(1 / 240, (ts - lastLoopTs) / 1000))
      : 1 / 60;
    lastLoopTs = ts;
    stepFrame(dt);
  } catch (err) {
    const now = Date.now();
    if (now - lastErrorLogTs > 2000) {
      lastErrorLogTs = now;
      console.warn('[RouteScene3D] frame error:', err);
    }
  }
  rafId = requestAnimationFrame(loop);
}

function startLoop() {
  if (rafId) return;
  lastLoopTs = 0;
  startFlightKeyboard();
  startCameraKeyboard();
  // The loop owns the camera while this page is in 3D: disable Cesium's
  // default controller so the user can neither wheel-zoom nor drag-pan
  // the 3D nadir view (navigation lives only in the 2D street map); the
  // camera moves solely via the focus/rollback tweens and the disks.
  setControllerEnabled(false);
  rafId = requestAnimationFrame(loop);
}

function stopLoop() {
  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
  lastLoopTs = 0;
  drone.speed = 0; // HUD must not show a stale speed once the loop stops.
  stopFlightKeyboard();
  stopCameraKeyboard();
  setControllerEnabled(true); // other pages expect the default controller
}

function setControllerEnabled(enabled) {
  const viewer = getViewer();
  const c = viewer && viewer.scene && viewer.scene.screenSpaceCameraController;
  if (c) c.enableInputs = enabled;
}

// Keyboard helpers (the composable exports the handlers; the singleton
// listeners live in the command composables).
const { startKeyboard: startFlightKeyboard, stopKeyboard: stopFlightKeyboard } = useFlightCommands();
const { startKeyboard: startCameraKeyboard, stopKeyboard: stopCameraKeyboard, activeCameraMode } = useCameraCommands();

// ── Preview flight ─────────────────────────────────────────────────────────

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

// Initial bearing (degrees, 0 = north, clockwise) from A to B.
function bearingDeg(aLat, aLng, bLat, bLng) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const toDeg = (rad) => (rad * 180) / Math.PI;
  const y = Math.sin(toRad(bLng - aLng)) * Math.cos(toRad(bLat));
  const x =
    Math.cos(toRad(aLat)) * Math.sin(toRad(bLat)) -
    Math.sin(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.cos(toRad(bLng - aLng));
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

// ── Waypoint parameter interpolation + tile-quality gate ─────────────────

function lerp(a, b, t) {
  return a + (b - a) * t;
}

// Shortest-arc angular interpolation (yaw / roll wrap at ±180°).
function lerpAngleDeg(a, b, t) {
  return normDeg(a + normDeg(b - a) * t);
}

function wpNum(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

// Linear interpolation of (alt, v, yaw, pitch, roll) between the two
// waypoints bracketing the cursor's arc position.
function interpWpStateAt(distM) {
  const n = wpArcDist.length;
  if (n < 2 || previewWps.length < 2) return null;
  const d = Math.max(0, Math.min(distM, pathTotalM));
  let k = 0;
  while (k < n - 2 && d > wpArcDist[k + 1]) k += 1;
  const a = previewWps[k];
  const b = previewWps[k + 1];
  const span = Math.max(1e-6, wpArcDist[k + 1] - wpArcDist[k]);
  const t = Math.max(0, Math.min(1, (d - wpArcDist[k]) / span));
  return {
    alt: lerp(wpNum(a.alt, WP_DEFAULT_ALT_M), wpNum(b.alt, WP_DEFAULT_ALT_M), t),
    speed: lerp(wpNum(a.speed, WP_DEFAULT_SPEED_MPS), wpNum(b.speed, WP_DEFAULT_SPEED_MPS), t),
    camYaw: lerpAngleDeg(wpNum(a.camYaw, 0), wpNum(b.camYaw, 0), t),
    camPitch: lerp(wpNum(a.camPitch, WP_DEFAULT_CAM_PITCH_DEG), wpNum(b.camPitch, WP_DEFAULT_CAM_PITCH_DEG), t),
    camRoll: lerpAngleDeg(wpNum(a.camRoll, 0), wpNum(b.camRoll, 0), t),
  };
}

// True once every 3D tileset in the scene has finished streaming AND
// rendering the current view (tilesLoaded is the reliable signal — see
// waitForTilesRendered in cesium-main.js). Globe imagery counts too when
// the fallback globe is visible.
function sceneTilesReady() {
  const viewer = getViewer();
  if (!viewer || !viewer.scene) return false;
  const prims = viewer.scene.primitives;
  for (let i = 0; i < prims.length; i += 1) {
    const p = prims.get(i);
    if (p && p.tilesLoaded === false) return false;
  }
  const globe = viewer.scene.globe;
  if (globe && globe.show && !globe.tilesLoaded) return false;
  return true;
}

// Interpolated position + tangent bearing at a distance along the table.
function sampleAtDistance(dist) {
  if (pathSamples.length < 2) return null;
  if (dist <= 0) {
    const a = pathSamples[0];
    const b = pathSamples[1];
    return { lat: a.lat, lng: a.lng, bearing: bearingDeg(a.lat, a.lng, b.lat, b.lng) };
  }
  if (dist >= pathTotalM) {
    const b = pathSamples[pathSamples.length - 1];
    const a = pathSamples[pathSamples.length - 2];
    return { lat: b.lat, lng: b.lng, bearing: bearingDeg(a.lat, a.lng, b.lat, b.lng) };
  }
  // Binary search for the bracketing segment.
  let lo = 0;
  let hi = pathSamples.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (pathSamples[mid].dist <= dist) lo = mid;
    else hi = mid;
  }
  const a = pathSamples[lo];
  const b = pathSamples[hi];
  const span = Math.max(1e-6, b.dist - a.dist);
  const f = (dist - a.dist) / span;
  return {
    lat: a.lat + (b.lat - a.lat) * f,
    lng: a.lng + (b.lng - a.lng) * f,
    bearing: bearingDeg(a.lat, a.lng, b.lat, b.lng),
  };
}

function stepPreviewFrame(dt) {
  // Quality gate. Before takeoff the view is hard-stuck until the start
  // view is fully rendered. Once airborne the flight rides through short
  // tile-streaming waves on the grace budget (tiles keep loading while the
  // drone keeps moving) and only hard-stops — view frozen, spinning circle
  // up — when the budget runs out; it resumes after RESUME_HOLD stable
  // ready frames. Continuous motion instead of stop-and-go judder.
  const ready = sceneTilesReady();
  if (!flightReleased) {
    if (!ready) {
      readyStreak = 0;
      waitingTiles.value = true;
      if (captureMode) renderStatus.value = 'tiles';
      return;
    }
    readyStreak += 1;
    if (readyStreak < READY_HOLD) {
      waitingTiles.value = true;
      if (captureMode) renderStatus.value = 'tiles';
      return;
    }
    flightReleased = true;
    graceFrames = GRACE_FRAMES;
    waitingTiles.value = false;
  } else if (ready) {
    readyStreak += 1;
    graceFrames = GRACE_FRAMES; // refill the ride-through budget
    if (waitingTiles.value && readyStreak < RESUME_HOLD) return; // settle after a hard stop
    waitingTiles.value = false;
  } else if (graceFrames > 0) {
    graceFrames -= 1;
    readyStreak = 0;
    // Ride through: keep flying while the missing tiles stream in.
  } else {
    readyStreak = 0;
    waitingTiles.value = true;
    if (captureMode) renderStatus.value = 'tiles';
    return; // hard stop until the missing tiles arrive
  }
  if (captureMode) renderStatus.value = 'fly';
  // Save: start the recorder only once the first view is fully rendered,
  // so the mp4 contains no blurry pre-roll frames.
  if (captureMode && !mediaRecorder) startRecording();

  const st = interpWpStateAt(previewCursorM);
  if (!st) {
    stopPreview();
    return;
  }
  // Advance at the interpolated waypoint speed; a minimum magnitude keeps
  // a zero-speed waypoint from stalling the flight forever.
  const speed = Math.max(0.1, Math.abs(st.speed));
  previewHudSpeed = flightDir < 0 ? -speed : speed;
  previewCursorM += flightDir * speed * dt;
  const traveled = flightDir < 0 ? pathTotalM - previewCursorM : previewCursorM;
  flightProgress.value = pathTotalM > 0 ? Math.max(0, Math.min(1, traveled / pathTotalM)) : 0;
  const done = previewCursorM <= 0 || previewCursorM >= pathTotalM;
  const s = sampleAtDistance(Math.max(0, Math.min(previewCursorM, pathTotalM)));
  if (!s) {
    stopPreview();
    return;
  }
  drone.lat = s.lat;
  drone.lon = s.lng;
  // Negative speed flies backward: face the opposite way.
  drone.heading = flightDir < 0 ? (s.bearing + 180) % 360 : s.bearing;
  drone.alt = st.alt;
  // The waypoint camera yaw is authored as an ABSOLUTE compass bearing:
  // focus mode flies with heading 0, so gimbal yaw == view azimuth there.
  // Keep it absolute in flight: express it body-relative so that
  // heading + gimbalYaw reproduces the authored azimuth instead of
  // rotating the whole view by the route bearing.
  gimbal.yaw = normDeg(st.camYaw - drone.heading);
  gimbal.pitch = st.camPitch;
  gimbal.roll = st.camRoll;
  if (done) {
    captureCompleted = captureMode;
    stopPreview();
  }
}

// Builds the spline arc table, the per-waypoint arc positions and the
// flight direction; shared by the live preview and the offline Save
// renderer. Returns false when fewer than two usable waypoints exist.
function buildFlightPath(list) {
  const pts = (list || []).map((w) => ({ lat: w.lat, lng: w.lng }));
  if (pts.length < 2) return false;
  const SAMPLES_PER_SEG = 32;
  const samples = splinePath(pts, SAMPLES_PER_SEG);
  if (samples.length < 2) return false;

  // Cumulative arc-length table for constant-speed travel.
  pathSamples = [{ lat: samples[0].lat, lng: samples[0].lng, dist: 0 }];
  for (let i = 1; i < samples.length; i += 1) {
    const prev = pathSamples[i - 1];
    const d = haversineMeters(prev.lat, prev.lng, samples[i].lat, samples[i].lng);
    pathSamples.push({ lat: samples[i].lat, lng: samples[i].lng, dist: prev.dist + d });
  }
  pathTotalM = pathSamples[pathSamples.length - 1].dist;
  if (pathTotalM <= 0) return false;

  // Arc position of each waypoint: sample k*SAMPLES_PER_SEG sits exactly
  // on waypoint k (Catmull-Rom interpolates through every control point).
  // The parameter interpolation is keyed on these distances.
  previewWps = list;
  wpArcDist = list.map((w, k) => {
    const idx = Math.min(k * SAMPLES_PER_SEG, pathSamples.length - 1);
    return pathSamples[idx].dist;
  });
  wpArcDist[wpArcDist.length - 1] = pathTotalM;

  // A negative speed on the first waypoint flies the route backward
  // (destination -> origin); the direction is locked for the whole flight.
  flightDir = wpNum(list[0].speed, WP_DEFAULT_SPEED_MPS) < 0 ? -1 : 1;
  return true;
}

// Start the first-person preview flight along the route: (lat, lon)
// follow the route's B-spline while alt, speed and the camera gimbal
// angles are linearly interpolated between the waypoints. opts.capture
// (the Save button) additionally records the flight into a 16:9 mp4.
// Returns false (nothing started) when fewer than two waypoints exist.
function startPreview(waypoints, opts = {}) {
  if (previewActive.value) return true;
  const list = waypoints || [];
  if (!buildFlightPath(list)) return false;
  previewCursorM = flightDir < 0 ? pathTotalM : 0;
  previewHudSpeed = 0;

  // The preview owns the view: hide both disks and fly first-person. The
  // blue dots + B-spline route overlay stay hidden for the whole flight
  // (the view re-shows them after the flight stops in 3D).
  previewActive.value = true;
  captureMode = Boolean(opts.capture);
  captureCompleted = false;
  flightProgress.value = 0;
  showFlight.value = false;
  showCamera.value = false;
  hideRouteOverlay();
  readyStreak = 0; // stuck until the start view's tiles are fully rendered
  graceFrames = 0;
  flightReleased = false;

  // Jump to the start waypoint with its own altitude and gimbal angles.
  const wpStart = flightDir < 0 ? list[list.length - 1] : list[0];
  const first = sampleAtDistance(previewCursorM);
  drone.lat = first.lat;
  drone.lon = first.lng;
  drone.alt = wpNum(wpStart.alt, WP_DEFAULT_ALT_M);
  drone.heading = flightDir < 0 ? (first.bearing + 180) % 360 : first.bearing;
  drone.speed = 0;
  // Authored view azimuth kept absolute (see stepPreviewFrame).
  gimbal.yaw = normDeg(wpNum(wpStart.camYaw, 0) - drone.heading);
  gimbal.pitch = wpNum(wpStart.camPitch, WP_DEFAULT_CAM_PITCH_DEG);
  gimbal.roll = wpNum(wpStart.camRoll, 0);
  syncCesiumCamera();
  return true;
}

function stopPreview() {
  offlineAbort = true; // also interrupts a running offline Save render pass
  flightProgress.value = 0;
  if (!previewActive.value) return;
  previewActive.value = false;
  waitingTiles.value = false;
  const wasCapture = captureMode;
  captureMode = false;
  pathSamples = [];
  pathTotalM = 0;
  previewCursorM = 0;
  previewWps = [];
  wpArcDist = [];
  readyStreak = 0;
  graceFrames = 0;
  flightReleased = false;
  previewHudSpeed = 0;
  // Back to the nadir, north-up overview orientation.
  drone.heading = 0;
  gimbal.yaw = 0;
  gimbal.pitch = -90;
  gimbal.roll = 0;
  if (wasCapture) stopRecording(); // settles the clip for the Save flow
  if (captureDoneResolve) {
    const resolve = captureDoneResolve;
    captureDoneResolve = null;
    resolve();
  }
}

// ── Recording (mirror canvas + MediaRecorder, same pattern as
//    useScreenCapture: the viewer has no preserveDrawingBuffer, so the
//    WebGL canvas is copied inside scene.postRender while still fresh) ────

function startRecording() {
  const viewer = getViewer();
  if (!viewer || !viewer.canvas || typeof viewer.canvas.captureStream !== 'function') {
    console.warn('[RouteScene3D] Cesium viewer is not ready; Save recording skipped.');
    return;
  }
  try {
    const source = viewer.canvas;
    // Best resolution: never downscale or upscale. The output must be
    // 16:9 (width:height), so each rendered frame is center-cropped to
    // that aspect at the canvas's native pixel size.
    let cw = source.width;
    let ch = source.height;
    if (cw / ch > RECORDING_ASPECT) cw = Math.round(ch * RECORDING_ASPECT);
    else ch = Math.round(cw / RECORDING_ASPECT);
    cw = Math.max(2, cw & ~1); // even dimensions for codec compatibility
    ch = Math.max(2, ch & ~1);
    mirrorCanvas = document.createElement('canvas');
    mirrorCanvas.width = cw;
    mirrorCanvas.height = ch;
    mirrorCtx = mirrorCanvas.getContext('2d');

    const mirrorFrame = () => {
      if (!mirrorCtx) return;
      const w = source.width;
      const h = source.height;
      if (w <= 0 || h <= 0) return;
      // Re-derive the 16:9 crop from the CURRENT canvas size (a window
      // resize mid-save must not skew or letterbox the recording).
      let sw = w;
      let sh = h;
      if (sw / sh > RECORDING_ASPECT) sw = Math.round(sh * RECORDING_ASPECT);
      else sh = Math.round(sw / RECORDING_ASPECT);
      sw = Math.max(2, sw & ~1);
      sh = Math.max(2, sh & ~1);
      mirrorCtx.drawImage(
        source,
        Math.round((w - sw) / 2),
        Math.round((h - sh) / 2),
        sw,
        sh,
        0,
        0,
        mirrorCanvas.width,
        mirrorCanvas.height
      );
    };
    mirrorFrame();
    // postRender fires synchronously after Cesium renders, while the WebGL
    // buffer is still valid to sample.
    if (viewer.scene && viewer.scene.postRender) {
      removePostRenderListener = viewer.scene.postRender.addEventListener(mirrorFrame);
    } else {
      const pump = () => {
        mirrorFrame();
        mirrorRafId = requestAnimationFrame(pump);
      };
      mirrorRafId = requestAnimationFrame(pump);
    }

    // Bitrate scales with the pixel count (~0.12 bits/px/frame), floored.
    const bitrate = Math.max(RECORDING_MIN_BITRATE, Math.round(cw * ch * RECORDING_FPS * 0.12));
    stream = mirrorCanvas.captureStream(RECORDING_FPS);
    const mimeType = MediaRecorder.isTypeSupported('video/mp4') ? 'video/mp4' : 'video/webm';
    mediaRecorder = new MediaRecorder(stream, {
      mimeType,
      videoBitsPerSecond: bitrate,
    });
    recordedChunks = [];
    mediaRecorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) recordedChunks.push(event.data);
    };
    mediaRecorder.start(1000);
  } catch (err) {
    console.error('[RouteScene3D] Failed to start recording:', err);
    cleanupRecording();
  }
}

function stopRecording() {
  if (!mediaRecorder || mediaRecorder.state === 'inactive') {
    cleanupRecording();
    return;
  }
  clipSettlePromise = new Promise((resolve) => {
    clipSettleResolve = resolve;
  });
  const recorder = mediaRecorder;
  // Watchdog: a missing onstop event must never block saveClip forever.
  const watchdog = setTimeout(() => {
    console.warn('[RouteScene3D] MediaRecorder onstop watchdog fired.');
    settle();
  }, 1500);
  const settle = () => {
    clearTimeout(watchdog);
    cleanupRecording();
    if (clipSettleResolve) {
      clipSettleResolve();
      clipSettleResolve = null;
    }
  };
  recorder.onstop = () => {
    const mime = recorder.mimeType || 'video/webm';
    if (recordedChunks.length > 0) {
      lastClip = {
        blob: new Blob(recordedChunks, { type: mime }),
        ext: mime.includes('mp4') ? 'mp4' : 'webm',
      };
    }
    settle();
  };
  try {
    recorder.stop();
  } catch (err) {
    console.error('[RouteScene3D] MediaRecorder stop failed:', err);
    settle();
  }
}

function cleanupRecording() {
  if (typeof removePostRenderListener === 'function') {
    removePostRenderListener();
    removePostRenderListener = null;
  }
  if (mirrorRafId) {
    cancelAnimationFrame(mirrorRafId);
    mirrorRafId = null;
  }
  mirrorCtx = null;
  mirrorCanvas = null;
  if (stream) {
    stream.getTracks().forEach((track) => track.stop());
    stream = null;
  }
  mediaRecorder = null;
  recordedChunks = [];
}

// ── Offline Save renderer (WebCodecs + mp4-muxer) ──────────────────────────
// Instead of recording the live flight in real time, the camera is stepped
// along the route at exact 1/RECORDING_FPS flight-time intervals; every
// frame waits until its view is FULLY rendered, is captured from the WebGL
// buffer and encoded straight into an mp4. Result: exact frame rate, no
// dropped/juddered frames, fully-rendered tiles in every frame. Falls back
// to the live MediaRecorder capture flight when WebCodecs/H.264 is missing.

// 16:9 center crop of a w×h canvas at native resolution (even dimensions).
function computeCropRect(w, h) {
  if (w <= 0 || h <= 0) return null;
  let cw = w;
  let ch = h;
  if (cw / ch > RECORDING_ASPECT) cw = Math.round(ch * RECORDING_ASPECT);
  else ch = Math.round(cw / RECORDING_ASPECT);
  cw = Math.max(2, cw & ~1);
  ch = Math.max(2, ch & ~1);
  return { x: Math.round((w - cw) / 2), y: Math.round((h - ch) / 2), w: cw, h: ch };
}

function ensureMirrorCanvas(w, h) {
  if (!mirrorCanvas) {
    mirrorCanvas = document.createElement('canvas');
    mirrorCtx = mirrorCanvas.getContext('2d');
  }
  if (mirrorCanvas.width !== w) mirrorCanvas.width = w;
  if (mirrorCanvas.height !== h) mirrorCanvas.height = h;
}

// Resolve once the current view reports holdFrames consecutive tile-ready
// frames (or false when the pass is aborted while waiting).
function awaitTilesStable(holdFrames) {
  return new Promise((resolve) => {
    let streak = 0;
    const tick = () => {
      if (offlineAbort) return resolve(false);
      if (sceneTilesReady()) {
        streak += 1;
        if (streak >= holdFrames) return resolve(true);
      } else {
        streak = 0;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

// Copy the 16:9 crop of the NEXT rendered frame into the mirror canvas
// (postRender fires while the WebGL buffer is still valid to sample).
function grabCroppedFrame(crop) {
  const viewer = getViewer();
  if (!viewer || !viewer.canvas || !viewer.scene || !viewer.scene.postRender || !mirrorCtx) {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    let settled = false;
    let remove = null;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      if (typeof remove === 'function') remove();
      resolve(ok);
    };
    remove = viewer.scene.postRender.addEventListener(() => {
      try {
        mirrorCtx.drawImage(
          viewer.canvas, crop.x, crop.y, crop.w, crop.h, 0, 0, crop.w, crop.h
        );
        finish(true);
      } catch (err) {
        finish(false);
      }
    });
    // Watchdog: a stalled renderer must never hang the Save action.
    setTimeout(() => finish(false), 15000);
  });
}

// Flight timeline: integrate the speed interpolated between the waypoints
// along the arc table, so output frames land at exact flight-time steps.
// Returns { times[i] at pathSamples[i], totalT }.
function buildTimeTable() {
  const times = new Array(pathSamples.length);
  times[0] = 0;
  let t = 0;
  for (let i = 1; i < pathSamples.length; i += 1) {
    const seg = pathSamples[i].dist - pathSamples[i - 1].dist;
    const sa = interpWpStateAt(pathSamples[i - 1].dist);
    const sb = interpWpStateAt(pathSamples[i].dist);
    const va = Math.max(0.1, Math.abs(sa ? sa.speed : WP_DEFAULT_SPEED_MPS));
    const vb = Math.max(0.1, Math.abs(sb ? sb.speed : WP_DEFAULT_SPEED_MPS));
    t += seg / ((va + vb) / 2);
    times[i] = t;
  }
  return { times, totalT: t };
}

// Invert the timeline: flight time -> arc distance (binary search + lerp).
function distanceAtTime(timeS, table) {
  if (timeS <= 0) return 0;
  if (timeS >= table.totalT) return pathTotalM;
  let lo = 0;
  let hi = table.times.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (table.times[mid] <= timeS) lo = mid;
    else hi = mid;
  }
  const span = Math.max(1e-9, table.times[hi] - table.times[lo]);
  const f = (timeS - table.times[lo]) / span;
  return pathSamples[lo].dist + (pathSamples[hi].dist - pathSamples[lo].dist) * f;
}

// First H.264 config the platform can encode at this size, or null.
async function probeOfflineEncoder(width, height, bitrate) {
  if (typeof VideoEncoder === 'undefined') return null;
  const candidates = ['avc1.640033', 'avc1.640032', 'avc1.64002A'];
  for (const codec of candidates) {
    try {
      const res = await VideoEncoder.isConfigSupported({
        codec,
        width,
        height,
        bitrate,
        framerate: RECORDING_FPS,
        hardwareAcceleration: 'prefer-hardware',
      });
      if (res && res.supported) return codec;
    } catch (err) {
      // try the next candidate
    }
  }
  return null;
}

// The offline render pass. Returns true = clip encoded + downloaded,
// false = aborted/failed (nothing downloaded), null = WebCodecs H.264
// unavailable -> the caller falls back to the MediaRecorder capture flight.
async function tryOfflineSave(waypoints) {
  if (typeof VideoEncoder === 'undefined') return null;
  if (!buildFlightPath(waypoints)) return false;
  const viewer = getViewer();
  if (!viewer || !viewer.canvas) return false;
  const crop = computeCropRect(viewer.canvas.width, viewer.canvas.height);
  if (!crop) return false;
  // Bitrate scales with the pixel count (~0.12 bits/px/frame), floored.
  const bitrate = Math.max(RECORDING_MIN_BITRATE, Math.round(crop.w * crop.h * RECORDING_FPS * 0.12));
  const codec = await probeOfflineEncoder(crop.w, crop.h, bitrate);
  if (!codec) return null; // no H.264 encoder -> MediaRecorder fallback

  // The pass owns the view exactly like a preview: disks hidden, and the
  // blue dots + spline overlay must never appear in the encoded frames.
  showFlight.value = false;
  showCamera.value = false;
  hideRouteOverlay();

  const table = buildTimeTable();
  const totalFrames = Math.max(1, Math.round(table.totalT * RECORDING_FPS));
  let muxer = null;
  let encoder = null;
  let encoderError = null;
  try {
    muxer = new Muxer({
      target: new ArrayBufferTarget(),
      video: { codec: 'avc', width: crop.w, height: crop.h, frameRate: RECORDING_FPS },
      fastStart: 'in-memory',
    });
    encoder = new VideoEncoder({
      output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
      error: (err) => {
        encoderError = err;
      },
    });
    encoder.configure({
      codec,
      width: crop.w,
      height: crop.h,
      bitrate,
      framerate: RECORDING_FPS,
      hardwareAcceleration: 'prefer-hardware',
    });
  } catch (err) {
    console.warn('[RouteScene3D] Offline encoder setup failed; falling back to MediaRecorder.', err);
    return null;
  }
  ensureMirrorCanvas(crop.w, crop.h);

  try {
    for (let k = 0; k <= totalFrames; k += 1) {
      if (offlineAbort || encoderError) return false;
      renderProgress.value = { frame: k + 1, total: totalFrames + 1 };
      // Exact flight-time sampling: waypoint speeds integrated along the
      // B-spline decide where the drone is at t = k / RECORDING_FPS.
      const time = Math.min(k / RECORDING_FPS, table.totalT);
      const dist = distanceAtTime(time, table);
      const s = sampleAtDistance(dist);
      const st = interpWpStateAt(dist);
      if (!s || !st) return false;
      renderStatus.value = 'tiles';
      drone.lat = s.lat;
      drone.lon = s.lng;
      drone.alt = st.alt;
      drone.heading = flightDir < 0 ? (s.bearing + 180) % 360 : s.bearing;
      // Authored view azimuth kept absolute (see stepPreviewFrame).
      gimbal.yaw = normDeg(st.camYaw - drone.heading);
      gimbal.pitch = st.camPitch;
      gimbal.roll = st.camRoll;
      syncCesiumCamera();
      // Quality gate with no grace window: waiting is free here — every
      // encoded frame must be fully rendered.
      if (!(await awaitTilesStable(3))) return false; // aborted while waiting
      renderStatus.value = 'render';
      if (!(await grabCroppedFrame(crop))) return false;
      const vf = new VideoFrame(mirrorCanvas, {
        timestamp: Math.round((k * 1e6) / RECORDING_FPS),
      });
      encoder.encode(vf, { keyFrame: k % 60 === 0 });
      vf.close();
      // Backpressure: keep the encode queue shallow.
      while (encoder.encodeQueueSize > 8 && !offlineAbort && !encoderError) {
        await new Promise((r) => setTimeout(r, 10));
      }
    }
    renderStatus.value = 'mux';
    await encoder.flush();
    if (offlineAbort || encoderError) return false;
    muxer.finalize();
    const blob = new Blob([muxer.target.buffer], { type: 'video/mp4' });
    // Hand the clip to the UI layer (login gate + save dialog) instead of
    // downloading it directly.
    lastClip = { blob, ext: 'mp4' };
    return true;
  } catch (err) {
    console.error('[RouteScene3D] Offline save failed:', err);
    return false;
  } finally {
    try {
      if (encoder && encoder.state !== 'closed') encoder.close();
    } catch (err) {
      // already closed
    }
    // The pass owned the shared path globals; clear them (the caller
    // restores the route overlay once the Save action settles).
    pathSamples = [];
    pathTotalM = 0;
    previewWps = [];
    wpArcDist = [];
  }
}

// Save = render the WHOLE route (origin -> destination) into a 16:9 mp4 at
// the canvas's native resolution. Preferred path: the offline frame-by-
// frame renderer above (exact 30 fps, every frame fully rendered). Fallback
// when WebCodecs/H.264 is unavailable: a live capture flight recorded with
// MediaRecorder. The finished clip is NOT downloaded here — it is handed to
// the caller via takeLastClip() (which applies the login gate and the save
// dialog). Returns false when nothing was rendered (fewer than two
// waypoints, aborted, or encode error).
async function saveClip(waypoints) {
  if (saving.value) return false;
  if (previewActive.value) stopPreview(); // a live preview is canceled
  offlineAbort = false;
  saving.value = true;
  renderStatus.value = 'start';
  try {
    const offline = await tryOfflineSave(waypoints);
    if (offline !== null) return offline;
    // Fallback: quality-gated capture flight + MediaRecorder.
    if (!startPreview(waypoints, { capture: true })) return false;
    await new Promise((resolve) => {
      captureDoneResolve = resolve;
    });
    if (clipSettlePromise) await clipSettlePromise;
    if (captureCompleted && lastClip) return true; // clip stays in lastClip
    return false;
  } finally {
    saving.value = false;
    renderProgress.value = null;
    renderStatus.value = '';
  }
}

// The 16:9 mirror canvas the offline renderer / capture flight draws every
// finished frame into. Exposed so external progress UIs (the Content ->
// Route -> Video dialog) can blit the frames being generated live.
function peekMirrorCanvas() {
  return mirrorCanvas;
}

// Hand off the clip produced by saveClip() ({ blob, ext }) and clear it.
// Returns null when there is nothing to take.
function takeLastClip() {
  const clip = lastClip;
  lastClip = null;
  return clip;
}

// ── 3D route overlay: blue indexed circles + B-spline polyline ────────────
// Mirrors the 2D map markers (28px #2563eb circle, bold white index) and
// the blue spline link, drawn as Cesium entities at waypoint altitude.
// Entities are UPDATED IN PLACE (positions / images refreshed, entities
// added/removed only when the list changes) because the focus mode edits
// waypoint positions every frame — recreating all entities per frame would
// thrash the scene.
const ROUTE_BLUE = '#2563eb';
const ROUTE_RED = '#ef4444'; // the focused (selected) waypoint circle
let splineEntity = null;
const billboardByWpId = new Map();
const circleImageCache = new Map(); // "index:selected" -> data URL

// The entities live in the SHARED global viewer, but the bookkeeping above
// is module state: after a hot-module reload the tracking resets while the
// viewer keeps the previous instance's dots/spline, which would draw a
// second route overlay. Tag every entity we add and purge untracked ones
// once per module instance, on the first overlay draw.
let staleRouteEntitiesPurged = false;
function purgeStaleRouteEntities(viewer) {
  if (staleRouteEntitiesPurged) return;
  staleRouteEntitiesPurged = true;
  // The route overlay is the ONLY feature that adds entities to the shared
  // viewer, so anything present at the first draw of this module instance
  // is stale leftover (e.g. from before a hot-module reload): clear it all
  // and rebuild from the waypoint list below.
  viewer.entities.removeAll();
  splineEntity = null;
  billboardByWpId.clear();
}

function circleImage(index, selected) {
  const key = `${index}:${selected ? 1 : 0}`;
  const cached = circleImageCache.get(key);
  if (cached) return cached;
  const D = 56; // 2x resolution for a crisp 28px billboard
  const c = D / 2;
  const canvas = document.createElement('canvas');
  canvas.width = D;
  canvas.height = D;
  const ctx = canvas.getContext('2d');
  ctx.beginPath();
  ctx.arc(c, c, c, 0, Math.PI * 2);
  ctx.fillStyle = selected ? ROUTE_RED : ROUTE_BLUE;
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 28px DengXian, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(index), c, c);
  const url = canvas.toDataURL();
  circleImageCache.set(key, url);
  return url;
}

// (Re)draw the waypoint circles + spline in the Cesium scene. The waypoint
// whose id equals selectedId is drawn red (the focused one).
function showRouteOverlay(waypoints, selectedId = null) {
  const viewer = getViewer();
  const Cesium = window.Cesium;
  if (!viewer || !Cesium) return;
  purgeStaleRouteEntities(viewer);
  const list = waypoints || [];

  // Spline: create once, refresh positions in place afterwards.
  if (list.length >= 2) {
    const samples = splinePath(
      list.map((w) => ({ lat: w.lat, lng: w.lng, alt: w.alt })),
      32
    );
    const positions = samples.map((s) =>
      // A couple of meters above the waypoint altitude so the line is
      // never z-fought away by rooftops at the same height.
      Cesium.Cartesian3.fromDegrees(s.lng, s.lat, (s.alt || 0) + 2)
    );
    if (!splineEntity) {
      splineEntity = viewer.entities.add({
        polyline: {
          positions,
          width: 3,
          material: Cesium.Color.fromCssColorString(ROUTE_BLUE).withAlpha(0.8),
        },
      });
      splineEntity.routeOverlayTag = true;
    } else {
      splineEntity.polyline.positions = positions;
    }
  } else if (splineEntity) {
    viewer.entities.remove(splineEntity);
    splineEntity = null;
  }

  // Billboards: reuse existing entities, add missing ones, drop stale ones.
  const seen = new Set();
  list.forEach((w) => {
    seen.add(w.id);
    const img = circleImage(w.index, w.id === selectedId);
    let ent = billboardByWpId.get(w.id);
    if (!ent) {
      ent = viewer.entities.add({
        position: Cesium.Cartesian3.fromDegrees(w.lng, w.lat, (w.alt || 0) + 2),
        billboard: {
          image: img,
          width: 28,
          height: 28,
          // Always visible, even when a building is between camera & marker.
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
      ent.wpId = w.id; // scene.pick() -> entity -> waypoint id
      ent.routeOverlayTag = true;
      billboardByWpId.set(w.id, ent);
    } else {
      ent.position = Cesium.Cartesian3.fromDegrees(w.lng, w.lat, (w.alt || 0) + 2);
      ent.billboard.image = img;
    }
  });
  billboardByWpId.forEach((ent, id) => {
    if (!seen.has(id)) {
      viewer.entities.remove(ent);
      billboardByWpId.delete(id);
    }
  });
}

function hideRouteOverlay() {
  const viewer = getViewer();
  // The route overlay is the only feature that adds entities to the shared
  // viewer, so clear ALL of them: removeAll() also drops stale entities
  // left behind by hot-module reloads (HMR resets the tracked map but the
  // global viewer keeps whatever was added before the reload).
  if (viewer) viewer.entities.removeAll();
  splineEntity = null;
  billboardByWpId.clear();
}

// Left-click picking of the waypoint circles in the 3D scene. Returns a
// cleanup function that removes the handler.
function onWaypointPick(callback) {
  const viewer = getViewer();
  const Cesium = window.Cesium;
  if (!viewer || !Cesium || typeof callback !== 'function') return () => {};
  const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
  handler.setInputAction((movement) => {
    let picked = null;
    try {
      picked = viewer.scene.pick(movement.position);
    } catch {
      picked = null;
    }
    const id = picked && picked.id && picked.id.wpId;
    if (id != null) callback(id);
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  return () => {
    try {
      handler.destroy();
    } catch {
      // Already destroyed — nothing to do.
    }
  };
}

// ── 2D map scale ↔ true 3D camera altitude ────────────────────────────────
// Google's altitude model (20 971 520 / 2^zoom) is a nominal "eye altitude"
// tied to the visible extent, NOT a perspective camera height: a Cesium
// camera at 160 m shows a far smaller area than Google zoom 17. These
// helpers convert between the map-model altitude and the true camera
// altitude whose nadir view has the same ground scale (meters/pixel).
const GOOGLE_MPP_K = 156543.03392 / 20971520; // m/px per model-alt meter at equator

function verticalFovRad(viewer) {
  const frustum = viewer.camera.frustum;
  if (typeof frustum.verticalFov === 'number') return frustum.verticalFov;
  // Cesium convention: frustum.fov is the horizontal FOV when aspect > 1.
  const aspect = viewer.canvas.clientWidth / Math.max(1, viewer.canvas.clientHeight);
  return aspect > 1 ? 2 * Math.atan(Math.tan(frustum.fov / 2) / aspect) : frustum.fov;
}

// True camera altitude (m) whose nadir view matches the 2D map's ground
// scale at the given model altitude.
function trueAltForMapScale(modelAlt, lat) {
  const viewer = getViewer();
  if (!viewer) return modelAlt;
  const H = viewer.canvas.clientHeight || window.innerHeight;
  const mpp = GOOGLE_MPP_K * Math.cos((lat * Math.PI) / 180) * modelAlt;
  return (mpp * H) / (2 * Math.tan(verticalFovRad(viewer) / 2));
}

// Inverse: map-model altitude that matches a true 3D camera altitude.
function modelAltForMapScale(trueAlt, lat) {
  const viewer = getViewer();
  if (!viewer) return trueAlt;
  const H = viewer.canvas.clientHeight || window.innerHeight;
  const mppPerAlt = GOOGLE_MPP_K * Math.cos((lat * Math.PI) / 180);
  return (2 * Math.tan(verticalFovRad(viewer) / 2) * trueAlt) / (H * mppPerAlt);
}

// ── Background 3D-tile prefetch while the 2D map is showing ───────────────
// The shared Cesium canvas keeps rendering (opacity 0) underneath the 2D
// map, so aiming its hidden camera at the current 2D view (nadir, same
// ground scale) makes Google stream + cache the photorealistic tiles the
// user will see after the 2D→3D hand-off — even if they never switch.
function prefetchTiles(lat, lon, modelAlt) {
  const viewer = getViewer();
  const Cesium = window.Cesium;
  if (!viewer || !Cesium) return;
  viewer.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(lon, lat, trueAltForMapScale(modelAlt, lat)),
    orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
  });
}

export function useRouteScene3D() {
  return {
    previewActive,
    saving,
    waitingTiles,
    renderProgress,
    renderStatus,
    flightProgress,
    peekMirrorCanvas,
    startLoop,
    stopLoop,
    startPreview,
    stopPreview,
    saveClip,
    takeLastClip,
    cruiseSpeedMps,
    showRouteOverlay,
    hideRouteOverlay,
    onWaypointPick,
    setFocusWaypoint,
    trueAltForMapScale,
    modelAltForMapScale,
    prefetchTiles,
    sceneTilesReady,
    // Re-exported so the view binds one object only.
    showFlight,
    showCamera,
    activeFlightMode,
    activeCameraMode,
  };
}
