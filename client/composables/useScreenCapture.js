import { ref } from 'vue';

// Module-scope singleton state (same pattern as useDockRegistry) so that
// only one recording can be active app-wide at any time.
const isRecording = ref(false);
let mediaRecorder = null;
let recordedChunks = [];
let stream = null;

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

function startRecording() {
  const viewer = getViewer();
  if (!viewer || !viewer.canvas || typeof viewer.canvas.captureStream !== 'function') {
    console.warn('[ScreenCapture] Cesium viewer is not ready; recording not started.');
    return;
  }
  if (isRecording.value) {
    console.warn('[ScreenCapture] Recording is already in progress.');
    return;
  }

  try {
    stream = viewer.canvas.captureStream(30);
    const mimeType = MediaRecorder.isTypeSupported('video/mp4') ? 'video/mp4' : 'video/webm';
    mediaRecorder = new MediaRecorder(stream, { mimeType });
    recordedChunks = [];

    mediaRecorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        recordedChunks.push(event.data);
      }
    };

    mediaRecorder.start(1000);
    isRecording.value = true;
  } catch (err) {
    console.error('[ScreenCapture] Failed to start recording:', err);
    cleanup();
  }
}

function stopRecording() {
  if (!mediaRecorder || mediaRecorder.state === 'inactive') {
    return;
  }

  mediaRecorder.onstop = () => {
    const mime = mediaRecorder?.mimeType || 'video/webm';
    const ext = mime.includes('mp4') ? 'mp4' : 'webm';
    if (recordedChunks.length > 0) {
      downloadBlob(new Blob(recordedChunks, { type: mime }), `recording-${timestamp()}.${ext}`);
    }
    cleanup();
  };

  mediaRecorder.stop();
}

function toggleRecording() {
  if (isRecording.value) {
    stopRecording();
  } else {
    startRecording();
  }
}

function cleanup() {
  if (stream) {
    stream.getTracks().forEach((track) => track.stop());
    stream = null;
  }
  mediaRecorder = null;
  recordedChunks = [];
  isRecording.value = false;
}

export function useScreenCapture() {
  return {
    isRecording,
    captureScreenshot,
    startRecording,
    stopRecording,
    toggleRecording,
  };
}
