import { ref } from 'vue';
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
//   2. The first-person preview flight along the waypoint B-spline, recorded
//      into a video clip through a mirror canvas + MediaRecorder.

const { drone, gimbal } = useDrone();
const { flightCmd, activeFlightMode, showFlight } = useFlightCommands();
const { computeDesiredEnuMove, applyEnuMove, updateTelemetry: updateFlightTelemetry } = useFlightPhysics();
const { showCamera } = useCameraCommands();
const { step: stepCameraPhysics } = useCameraPhysics();

const PREVIEW_SPEED_MPS = 8; // cruise speed along the spline
const PREVIEW_CRUISE_ALT_M = 30; // height above the sampled surface
const PREVIEW_PITCH_DEG = -10; // slight downward look while flying
const RECORDING_MAX_WIDTH = 1920;
const RECORDING_FPS = 30;
const RECORDING_BITRATE = 6_000_000;

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
let previewSurfaceAlt = 0;

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

function stepManualFrame(dt) {
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

function stepFrame() {
  const dt = 1 / 60;
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
  syncCesiumCamera();
}

function loop() {
  // A single bad frame must never kill the loop: if it stops, the scene
  // freezes and the disks appear dead. Log throttled and keep animating.
  try {
    stepFrame();
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
  startFlightKeyboard();
  startCameraKeyboard();
  rafId = requestAnimationFrame(loop);
}

function stopLoop() {
  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
  drone.speed = 0; // HUD must not show a stale speed once the loop stops.
  stopFlightKeyboard();
  stopCameraKeyboard();
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

// Sample the tileset surface height under (lat, lng); updates
// previewSurfaceAlt asynchronously (fallback stays 0 -> 30 m AMSL).
function sampleSurfaceAt(lat, lng) {
  const viewer = getViewer();
  const Cesium = window.Cesium;
  if (!viewer || !Cesium || typeof viewer.scene?.sampleHeightMostDetailed !== 'function') return;
  const position = Cesium.Cartesian3.fromDegrees(lng, lat);
  const apply = (result) => {
    const p = result && result.position ? result.position : result;
    if (!p) return;
    try {
      const carto = Cesium.Cartographic.fromCartesian(p);
      if (carto && Number.isFinite(carto.height)) previewSurfaceAlt = carto.height;
    } catch {
      // Keep the previous value; a bad sample must not break the flight.
    }
  };
  try {
    // Callback style (older Cesium) — newer versions return a promise too.
    const ret = viewer.scene.sampleHeightMostDetailed(position, apply);
    if (ret && typeof ret.then === 'function') {
      ret.then(apply).catch(() => {});
    }
  } catch (err) {
    console.warn('[RouteScene3D] surface sampling unavailable:', err);
  }
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
  previewCursorM += PREVIEW_SPEED_MPS * dt;
  const atEnd = previewCursorM >= pathTotalM;
  const s = sampleAtDistance(Math.min(previewCursorM, pathTotalM));
  if (!s) {
    stopPreview();
    return;
  }
  drone.lat = s.lat;
  drone.lon = s.lng;
  drone.alt = previewSurfaceAlt + PREVIEW_CRUISE_ALT_M;
  drone.heading = s.bearing;
  if (atEnd) stopPreview();
}

// Start the first-person preview flight along the waypoint spline.
// Returns false (nothing started) when fewer than two waypoints exist.
function startPreview(waypoints) {
  if (previewActive.value) return true;
  const pts = (waypoints || []).map((w) => ({ lat: w.lat, lng: w.lng }));
  if (pts.length < 2) return false;
  const samples = splinePath(pts, 32);
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
  previewCursorM = 0;

  // The preview owns the view: hide both disks and fly first-person.
  previewActive.value = true;
  showFlight.value = false;
  showCamera.value = false;
  gimbal.yaw = 0;
  gimbal.roll = 0;
  gimbal.pitch = PREVIEW_PITCH_DEG;

  // Jump to the first waypoint; the surface height arrives asynchronously.
  previewSurfaceAlt = 0;
  const first = sampleAtDistance(0);
  drone.lat = first.lat;
  drone.lon = first.lng;
  drone.heading = first.bearing;
  drone.alt = PREVIEW_CRUISE_ALT_M;
  sampleSurfaceAt(first.lat, first.lng);
  syncCesiumCamera();

  startRecording();
  return true;
}

function stopPreview() {
  if (!previewActive.value) return;
  previewActive.value = false;
  pathSamples = [];
  pathTotalM = 0;
  previewCursorM = 0;
  stopRecording();
}

// ── Recording (mirror canvas + MediaRecorder, same pattern as
//    useScreenCapture: the viewer has no preserveDrawingBuffer, so the
//    WebGL canvas is copied inside scene.postRender while still fresh) ────

function timestamp() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function startRecording() {
  const viewer = getViewer();
  if (!viewer || !viewer.canvas || typeof viewer.canvas.captureStream !== 'function') {
    console.warn('[RouteScene3D] Cesium viewer is not ready; preview recording skipped.');
    return;
  }
  try {
    const source = viewer.canvas;
    // Downscale only when the window exceeds 1080p; even dimensions for
    // codec compatibility. Never upscale.
    const scale = Math.min(1, RECORDING_MAX_WIDTH / source.width);
    mirrorCanvas = document.createElement('canvas');
    mirrorCanvas.width = Math.max(2, Math.round(source.width * scale) & ~1);
    mirrorCanvas.height = Math.max(2, Math.round(source.height * scale) & ~1);
    mirrorCtx = mirrorCanvas.getContext('2d');

    const mirrorFrame = () => {
      if (!mirrorCtx) return;
      if (source.width > 0 && source.height > 0) {
        mirrorCtx.drawImage(source, 0, 0, mirrorCanvas.width, mirrorCanvas.height);
      }
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

    stream = mirrorCanvas.captureStream(RECORDING_FPS);
    const mimeType = MediaRecorder.isTypeSupported('video/mp4') ? 'video/mp4' : 'video/webm';
    mediaRecorder = new MediaRecorder(stream, {
      mimeType,
      videoBitsPerSecond: RECORDING_BITRATE,
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

// Download the last recorded preview clip. Stops a running preview first so
// the clip is complete; resolves after the recorder has settled.
async function saveClip() {
  saving.value = true;
  try {
    if (previewActive.value) stopPreview();
    if (clipSettlePromise) await clipSettlePromise;
    if (!lastClip) return false;
    downloadBlob(lastClip.blob, `route-preview-${timestamp()}.${lastClip.ext}`);
    return true;
  } finally {
    saving.value = false;
  }
}

export function useRouteScene3D() {
  return {
    previewActive,
    saving,
    startLoop,
    stopLoop,
    startPreview,
    stopPreview,
    saveClip,
    // Re-exported so the view binds one object only.
    showFlight,
    showCamera,
    activeFlightMode,
    activeCameraMode,
  };
}
