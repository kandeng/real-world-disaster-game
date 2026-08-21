<script setup>
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';

// Google-style avatar editor: fixed circular stencil over a square viewport;
// the user pans (drag / pinch) and zooms (wheel / slider) the image beneath.
// No rotation on purpose (EXIF orientation is applied at decode time).
const props = defineProps({
  file: { type: File, required: true },
  exportSize: { type: Number, default: 256 },
});
const emit = defineEmits(['done', 'cancel']);

const { t } = useI18n();

const VIEW = 320; // CSS px of the square viewport
const MIN_ZOOM = 1;
const MAX_ZOOM = 4;

const canvasRef = ref(null);
const zoom = ref(1);

let bmp = null; // ImageBitmap | HTMLImageElement
let iw = 0;
let ih = 0;
let ox = 0; // image top-left in viewport coordinates
let oy = 0;
let objectUrl = '';

/* ── Loading (EXIF orientation applied) ─────────────────────────────── */

onMounted(async () => {
  try {
    bmp = await createImageBitmap(props.file, { imageOrientation: 'from-image' });
  } catch {
    bmp = await new Promise((resolve, reject) => {
      objectUrl = URL.createObjectURL(props.file);
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = objectUrl;
    });
  }
  iw = bmp.width;
  ih = bmp.height;
  resetView();
  canvasRef.value.addEventListener('wheel', onWheel, { passive: false });
  draw();
});

onBeforeUnmount(() => {
  canvasRef.value?.removeEventListener('wheel', onWheel);
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  if (bmp && bmp.close) bmp.close();
});

/* ── Crop math ──────────────────────────────────────────────────────── */
// baseScale = "cover": at zoom 1 the image just fills the square, so the
// pan clamp range always keeps the crop window fully covered.

function baseScale() {
  return Math.max(VIEW / iw, VIEW / ih);
}

function scale() {
  return baseScale() * zoom.value;
}

function clampOffsets() {
  const w = iw * scale();
  const h = ih * scale();
  ox = Math.min(0, Math.max(VIEW - w, ox));
  oy = Math.min(0, Math.max(VIEW - h, oy));
}

function resetView() {
  zoom.value = MIN_ZOOM;
  const w = iw * scale();
  const h = ih * scale();
  ox = (VIEW - w) / 2;
  oy = (VIEW - h) / 2;
}

// Zoom while keeping the viewport point (cx, cy) visually fixed.
function setZoom(next, cx = VIEW / 2, cy = VIEW / 2) {
  const oldS = scale();
  zoom.value = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next));
  const newS = scale();
  ox = cx - ((cx - ox) / oldS) * newS;
  oy = cy - ((cy - oy) / oldS) * newS;
  clampOffsets();
  draw();
}

function onSlider(e) {
  setZoom(parseFloat(e.target.value));
}

function onWheel(e) {
  e.preventDefault();
  const rect = canvasRef.value.getBoundingClientRect();
  setZoom(
    zoom.value * (e.deltaY < 0 ? 1.1 : 1 / 1.1),
    e.clientX - rect.left,
    e.clientY - rect.top,
  );
}

/* ── Pan / pinch via pointer events ─────────────────────────────────── */

const pointers = new Map();
let pinchDist = 0;

function onPointerDown(e) {
  e.target.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
  }
}

function onPointerMove(e) {
  if (!pointers.has(e.pointerId)) return;
  const prev = pointers.get(e.pointerId);
  const cur = { x: e.clientX, y: e.clientY };
  pointers.set(e.pointerId, cur);
  if (pointers.size === 1) {
    ox += cur.x - prev.x;
    oy += cur.y - prev.y;
    clampOffsets();
    draw();
  } else if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    if (pinchDist > 0 && d > 0) {
      const rect = canvasRef.value.getBoundingClientRect();
      setZoom(
        zoom.value * (d / pinchDist),
        (a.x + b.x) / 2 - rect.left,
        (a.y + b.y) / 2 - rect.top,
      );
    }
    pinchDist = d;
  }
}

function onPointerUp(e) {
  pointers.delete(e.pointerId);
  pinchDist = 0;
}

/* ── Rendering ──────────────────────────────────────────────────────── */

function draw() {
  const canvas = canvasRef.value;
  if (!canvas || !bmp) return;
  const dpr = window.devicePixelRatio || 1;
  const px = Math.round(VIEW * dpr);
  if (canvas.width !== px) {
    canvas.width = px;
    canvas.height = px;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, VIEW, VIEW);
  ctx.imageSmoothingQuality = 'high';
  const s = scale();
  ctx.drawImage(bmp, ox, oy, iw * s, ih * s);
}

// Render exactly what the stencil shows into exportSize × exportSize.
function exportCrop() {
  const E = props.exportSize;
  const ratio = E / VIEW;
  const out = document.createElement('canvas');
  out.width = E;
  out.height = E;
  const ctx = out.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  const s = scale() * ratio;
  ctx.drawImage(bmp, ox * ratio, oy * ratio, iw * s, ih * s);
  emit('done', out.toDataURL('image/jpeg', 0.85));
}
</script>

<template>
  <div class="crop-overlay" @wheel.prevent>
    <div class="crop-card">
      <h3 class="crop-title">{{ t('authflow.avatar_crop_title') }}</h3>

      <div class="crop-stage" :style="{ width: VIEW + 'px', height: VIEW + 'px' }">
        <canvas
          ref="canvasRef"
          class="crop-canvas"
          :style="{ width: VIEW + 'px', height: VIEW + 'px' }"
          @pointerdown="onPointerDown"
          @pointermove="onPointerMove"
          @pointerup="onPointerUp"
          @pointercancel="onPointerUp"
        />
        <div class="crop-stencil">
          <div class="crop-stencil__hole" />
        </div>
      </div>

      <div class="crop-zoom">
        <span class="crop-zoom__label">{{ t('authflow.avatar_crop_zoom') }}</span>
        <input
          type="range"
          class="crop-zoom__slider"
          :min="MIN_ZOOM"
          :max="MAX_ZOOM"
          step="0.01"
          :value="zoom"
          @input="onSlider"
        />
        <span class="crop-zoom__value">{{ zoom.toFixed(1) }}×</span>
      </div>

      <div class="crop-actions">
        <button type="button" class="crop-btn" @click="emit('cancel')">
          {{ t('authflow.avatar_crop_cancel') }}
        </button>
        <button type="button" class="crop-btn crop-btn--primary" @click="exportCrop">
          {{ t('authflow.avatar_crop_done') }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.crop-overlay {
  position: fixed;
  inset: 0;
  z-index: 1000;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: auto;
}

.crop-card {
  background: #ffffff;
  border-radius: 14px;
  padding: 24px 28px;
  display: flex;
  flex-direction: column;
  gap: 18px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.25);
}

.crop-title {
  margin: 0;
  font-size: 1.05rem;
  font-weight: 600;
  color: #1d1d1f;
}

.crop-stage {
  position: relative;
  overflow: hidden;
  border-radius: 8px;
  background: #000000;
}

.crop-canvas {
  display: block;
  cursor: grab;
  touch-action: none;
}

.crop-canvas:active {
  cursor: grabbing;
}

/* Circular stencil: the hole dims everything outside via a huge shadow. */
.crop-stencil {
  position: absolute;
  inset: 0;
  pointer-events: none;
}

.crop-stencil__hole {
  width: 100%;
  height: 100%;
  border-radius: 50%;
  border: 2px solid #007aff;
  box-sizing: border-box;
  box-shadow: 0 0 0 9999px rgba(17, 24, 39, 0.55);
}

.crop-zoom {
  display: flex;
  align-items: center;
  gap: 12px;
}

.crop-zoom__label {
  font-size: 0.85rem;
  color: #6e6e73;
  flex-shrink: 0;
}

.crop-zoom__slider {
  flex: 1;
  accent-color: #007aff;
}

.crop-zoom__value {
  font-size: 0.8rem;
  color: #6e6e73;
  width: 38px;
  text-align: right;
  flex-shrink: 0;
}

.crop-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}

.crop-btn {
  padding: 9px 20px;
  border: none;
  border-radius: 999px;
  background: #f5f5f7;
  color: #1d1d1f;
  font-size: 0.9rem;
  font-weight: 600;
  cursor: pointer;
}

.crop-btn:hover {
  background: #e5e5ea;
}

.crop-btn--primary {
  background: #007aff;
  color: #ffffff;
}

.crop-btn--primary:hover {
  background: #0066d6;
}
</style>
