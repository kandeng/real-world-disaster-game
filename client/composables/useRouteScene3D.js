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
const { showCamera, cameraCmd } = useCameraCommands();
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

// Focus mode: after the two-stage dive onto one waypoint, the disks edit
// that waypoint instead of flying the drone. Holds the reactive waypoint
// object (or null when not focused).
let focusWaypoint = null;

function setFocusWaypoint(wp) {
  focusWaypoint = wp || null;
}

// Waypoint editing rates while focused.
const FOCUS_MOVE_RATE = 0.05; // m/s per deflection unit per meter of camera altitude
const FOCUS_SPEED_RATE = 4;   // wp.speed change (m/s) per second at full deflection
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
      // Throttle stick sets the waypoint's cruise speed along the route.
      wp.speed = Math.max(0, Math.min(1000, wp.speed + flightCmd.vz * FOCUS_SPEED_RATE * dt));
    } else if (activeFlightMode.value === 'R') {
      wp.camYaw = normDeg(wp.camYaw + flightCmd.yaw * FOCUS_ANGLE_RATE * dt);
      gimbal.yaw = wp.camYaw; // the view mirrors the waypoint camera
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
    startLoop,
    stopLoop,
    startPreview,
    stopPreview,
    saveClip,
    showRouteOverlay,
    hideRouteOverlay,
    onWaypointPick,
    setFocusWaypoint,
    trueAltForMapScale,
    modelAltForMapScale,
    prefetchTiles,
    // Re-exported so the view binds one object only.
    showFlight,
    showCamera,
    activeFlightMode,
    activeCameraMode,
  };
}
