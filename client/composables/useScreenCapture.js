import { ref } from 'vue';

// Module-scope singleton state (same pattern as useDockRegistry) so that
// only one recorder session can be active app-wide at any time.
//
// The Screen Recording button is a 3-state flight-replay recorder:
//   idle -> recording: sample flight telemetry each frame while the user
//                       flies normally (no encoder running, controls stay
//                       fully responsive).
//   recording -> replaying: replay the sampled path on the 3D scene while
//                       capturing the Cesium canvas into a video clip.
//   replaying -> idle: cancel discards the partial clip; reaching the end
//                       saves the clip and returns to idle automatically.
const recorderState = ref('idle'); // 'idle' | 'recording' | 'replaying'
const replayProgress = ref(0); // 0..1 during replay

let samples = []; // { t, lat, lon, alt, heading, gimbalYaw, gimbalPitch, gimbalRoll }
let recordStartTs = 0;
let replayRafId = null;
let replayStartTs = 0;
let replayIndex = 0;

let mediaRecorder = null;
let recordedChunks = [];
let stream = null;
let mirrorCanvas = null;
let mirrorCtx = null;
let mirrorRafId = null;
let removePostRenderListener = null;

// Downscale only when the window exceeds 1080p: the encoder's cost scales
// with pixels * fps, so capping resolution (plus a bitrate cap) keeps the
// replay true-to-speed even on integrated GPUs. Never upscale — a smaller
// window is recorded directly from the original canvas.
const RECORDING_MAX_WIDTH = 1920;
const RECORDING_FPS = 30;
const RECORDING_BITRATE = 6_000_000;

function getViewer() {
  const viewer = window.cesiumViewer;
  if (!viewer || typeof viewer.isDestroyed !== 'function' || viewer.isDestroyed()) {
    return null;
  }
  return viewer;
}

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

function dataUrlToBlob(dataUrl) {
  const [header, base64] = dataUrl.split(',');
  const mime = /data:(.*?)(;|$)/.exec(header)?.[1] || 'image/png';
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mime });
}

function captureScreenshot() {
  const viewer = getViewer();
  if (!viewer || !viewer.canvas) {
    console.warn('[ScreenCapture] Cesium viewer is not ready; screenshot skipped.');
    return;
  }

  // Synchronous render keeps the WebGL drawing buffer valid for toDataURL,
  // so preserveDrawingBuffer is not required.
  viewer.render();
  const dataUrl = viewer.canvas.toDataURL('image/png');
  downloadBlob(dataUrlToBlob(dataUrl), `screenshot-${timestamp()}.png`);
}

// ---------------------------------------------------------------------------
// Telemetry recording (state: recording)
// ---------------------------------------------------------------------------

function startTelemetryCapture() {
  samples = [];
  recordStartTs = performance.now();
  recorderState.value = 'recording';
}

// Called from AerialView's rAF loop while state is 'recording'.
function sampleFrame(droneState, gimbalState) {
  if (recorderState.value !== 'recording') return;
  samples.push({
    t: performance.now() - recordStartTs,
    lat: droneState.lat,
    lon: droneState.lon,
    alt: droneState.alt,
    heading: droneState.heading,
    gimbalYaw: gimbalState.yaw,
    gimbalPitch: gimbalState.pitch,
    gimbalRoll: gimbalState.roll,
  });
}

// ---------------------------------------------------------------------------
// Canvas capture (state: replaying) — mirror canvas clamped to 1080p max
// ---------------------------------------------------------------------------

function startCanvasCapture() {
  const viewer = getViewer();
  if (!viewer || !viewer.canvas || typeof viewer.canvas.captureStream !== 'function') {
    console.warn('[ScreenCapture] Cesium viewer is not ready; capture not started.');
    return false;
  }

  try {
    const source = viewer.canvas;
    let captureCanvas = source;

    if (source.width > RECORDING_MAX_WIDTH) {
      // Mirror each rendered frame into a downscaled 2D canvas. The blit is
      // GPU-side and cheap; the encoder works at <=1080p instead of full
      // window size. Even dimensions for codec compatibility.
      const scale = RECORDING_MAX_WIDTH / source.width;
      mirrorCanvas = document.createElement('canvas');
      mirrorCanvas.width = RECORDING_MAX_WIDTH;
      mirrorCanvas.height = Math.max(2, Math.round(source.height * scale) & ~1);
      mirrorCtx = mirrorCanvas.getContext('2d');

      const mirrorFrame = () => {
        if (!mirrorCtx) return;
        mirrorCtx.drawImage(source, 0, 0, mirrorCanvas.width, mirrorCanvas.height);
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
      captureCanvas = mirrorCanvas;
    }

    stream = captureCanvas.captureStream(RECORDING_FPS);
    const mimeType = MediaRecorder.isTypeSupported('video/mp4') ? 'video/mp4' : 'video/webm';
    mediaRecorder = new MediaRecorder(stream, {
      mimeType,
      videoBitsPerSecond: RECORDING_BITRATE,
    });
    recordedChunks = [];

    mediaRecorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        recordedChunks.push(event.data);
      }
    };

    mediaRecorder.start(1000);
    return true;
  } catch (err) {
    console.error('[ScreenCapture] Failed to start capture:', err);
    cleanupCapture();
    return false;
  }
}

function stopCanvasCapture(save) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      cleanupCapture();
      resolve();
    };

    if (!mediaRecorder || mediaRecorder.state === 'inactive') {
      finish();
      return;
    }

    const recorder = mediaRecorder;
    // Watchdog: a missing onstop event must never leave the state machine
    // stuck in 'replaying'.
    const watchdog = setTimeout(() => {
      console.warn('[ScreenCapture] MediaRecorder onstop watchdog fired.');
      finish();
    }, 1500);

    recorder.onstop = () => {
      clearTimeout(watchdog);
      const mime = recorder.mimeType || 'video/webm';
      if (save && recordedChunks.length > 0) {
        const ext = mime.includes('mp4') ? 'mp4' : 'webm';
        downloadBlob(new Blob(recordedChunks, { type: mime }), `recording-${timestamp()}.${ext}`);
      }
      finish();
    };

    try {
      recorder.stop();
    } catch (err) {
      clearTimeout(watchdog);
      console.error('[ScreenCapture] MediaRecorder stop failed:', err);
      finish();
    }
  });
}

function cleanupCapture() {
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

// ---------------------------------------------------------------------------
// Replay (state: replaying)
// ---------------------------------------------------------------------------

function lerp(a, b, f) {
  return a + (b - a) * f;
}

// Shortest-path interpolation for angles in degrees.
function lerpAngle(a, b, f) {
  let d = (b - a) % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return a + d * f;
}

function applyReplaySample(s) {
  if (typeof window.updateCesiumCamera !== 'function') return;
  // Skip corrupt samples instead of letting Cesium throw on bad input.
  const values = [s.lat, s.lon, s.alt, s.heading, s.gimbalYaw, s.gimbalPitch, s.gimbalRoll];
  if (!values.every(Number.isFinite)) return;
  window.updateCesiumCamera({
    lat: s.lat,
    lon: s.lon,
    alt: s.alt,
    heading: s.heading,
    gimbalYaw: s.gimbalYaw,
    gimbalPitch: s.gimbalPitch,
    gimbalRoll: s.gimbalRoll,
  });
}

function runReplayLoop() {
  // A failure here must never leave the recorder stuck in 'replaying':
  // AerialView skips flight physics and camera sync in that state, so a
  // stuck replay would freeze the scene and disable the Flight/Gimbal disks.
  try {
    const lastSample = samples[samples.length - 1];
    const elapsed = performance.now() - replayStartTs;

    if (elapsed >= lastSample.t) {
      replayRafId = null;
      applyReplaySample(lastSample);
      replayProgress.value = 1;
      finishReplay();
      return;
    }

    // Advance the sample cursor, then interpolate between the two samples
    // bracketing the elapsed time so replay is smooth at 1x real time.
    while (replayIndex < samples.length - 2 && samples[replayIndex + 1].t <= elapsed) {
      replayIndex += 1;
    }
    const a = samples[replayIndex];
    const b = samples[replayIndex + 1];
    const span = Math.max(1, b.t - a.t);
    const f = Math.min(1, Math.max(0, (elapsed - a.t) / span));

    applyReplaySample({
      lat: lerp(a.lat, b.lat, f),
      lon: lerp(a.lon, b.lon, f),
      alt: lerp(a.alt, b.alt, f),
      heading: lerpAngle(a.heading, b.heading, f),
      gimbalYaw: lerpAngle(a.gimbalYaw, b.gimbalYaw, f),
      gimbalPitch: lerp(a.gimbalPitch, b.gimbalPitch, f),
      gimbalRoll: lerp(a.gimbalRoll, b.gimbalRoll, f),
    });

    replayProgress.value = elapsed / lastSample.t;
    replayRafId = requestAnimationFrame(runReplayLoop);
  } catch (err) {
    console.error('[ScreenCapture] Replay aborted after an error:', err);
    replayRafId = null;
    cancelReplay();
  }
}

async function stopAndReplay() {
  if (recorderState.value !== 'recording') return;

  if (samples.length < 2) {
    // Nothing meaningful recorded — quietly return to idle.
    samples = [];
    recorderState.value = 'idle';
    return;
  }

  recorderState.value = 'replaying';
  replayProgress.value = 0;

  if (!startCanvasCapture()) {
    samples = [];
    recorderState.value = 'idle';
    return;
  }

  replayStartTs = performance.now();
  replayIndex = 0;
  replayRafId = requestAnimationFrame(runReplayLoop);
}

async function finishReplay() {
  await stopCanvasCapture(true); // save the completed clip
  samples = [];
  recorderState.value = 'idle';
  replayProgress.value = 0;
}

async function cancelReplay() {
  if (recorderState.value !== 'replaying') return;
  if (replayRafId) {
    cancelAnimationFrame(replayRafId);
    replayRafId = null;
  }
  await stopCanvasCapture(false); // discard the partial clip
  samples = [];
  recorderState.value = 'idle';
  replayProgress.value = 0;
}

function toggleRecorder() {
  if (recorderState.value === 'idle') {
    startTelemetryCapture();
  } else if (recorderState.value === 'recording') {
    stopAndReplay();
  } else {
    cancelReplay();
  }
}

// Abort whatever is active and discard everything (view unmount).
function resetRecorder() {
  if (replayRafId) {
    cancelAnimationFrame(replayRafId);
    replayRafId = null;
  }
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    try {
      mediaRecorder.stop();
    } catch {
      // Best-effort stop; cleanup continues regardless.
    }
  }
  cleanupCapture();
  samples = [];
  recorderState.value = 'idle';
  replayProgress.value = 0;
}

export function useScreenCapture() {
  return {
    recorderState,
    replayProgress,
    captureScreenshot,
    sampleFrame,
    toggleRecorder,
    cancelReplay,
    resetRecorder,
  };
}
