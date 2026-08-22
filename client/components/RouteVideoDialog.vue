<script setup>
import { computed, onMounted, onBeforeUnmount, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouteScene3D } from '@shared-composables/useRouteScene3D.js';
import { useVideos } from '@shared-composables/useVideos.js';

// Content -> Route -> Video: renders the route's mp4 frame by frame with
// the shared offline renderer (WebCodecs + mp4-muxer; MediaRecorder capture
// flight as fallback) and shows the frames being generated live in the
// panel. Below: a progress bar, the "Publish to the gallery" checkbox
// (checked by default) and the download button — grey until the clip is
// finished, blue afterwards (same grey/blue as the Account Save button).
const props = defineProps({ route: { type: Object, required: true } });
const emit = defineEmits(['close']);

const { t, locale } = useI18n();
const scene = useRouteScene3D();
const { publishVideo } = useVideos();

const displayCanvas = ref(null);
const state = ref('rendering'); // 'rendering' | 'done' | 'failed'
const videoUrl = ref('');
let clipBlob = null;
const title = ref(props.route.title);
const description = ref('');
const createdAt = ref(new Date());
const publish = ref(true);
const published = ref(false);
const publishFailed = ref(false);
let blitRaf = null;
let finished = false;

// Offline pass: { frame, total }; fallback capture flight: distance %.
const progress = computed(() => {
  const rp = scene.renderProgress.value;
  if (rp && rp.total > 0) {
    return { pct: rp.frame / rp.total, text: `${rp.frame} / ${rp.total}` };
  }
  const fp = scene.flightProgress.value;
  return { pct: fp, text: `${Math.round(fp * 100)}%` };
});

// "Aug 20, 2026, 17:30" (en) / "2026年8月20日 17:30" (zh) — same format
// as the route / video lists.
function fmtDate(d) {
  if (!(d instanceof Date) || isNaN(d)) return '';
  return d.toLocaleString(localeOf(), {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}
function localeOf() {
  return locale.value === 'zh' ? 'zh-CN' : 'en-US';
}

// Blit the frames the renderer finishes into the visible panel canvas.
function startBlit() {
  const blit = () => {
    const src = scene.peekMirrorCanvas();
    const dst = displayCanvas.value;
    if (src && dst && src.width > 0 && src.height > 0) {
      if (dst.width !== src.width) dst.width = src.width;
      if (dst.height !== src.height) dst.height = src.height;
      dst.getContext('2d').drawImage(src, 0, 0);
    }
    blitRaf = requestAnimationFrame(blit);
  };
  blitRaf = requestAnimationFrame(blit);
}

onMounted(async () => {
  startBlit();
  const ok = await scene.saveClip(props.route.waypoints);
  const clip = ok ? scene.takeLastClip() : null;
  finished = true;
  if (blitRaf) cancelAnimationFrame(blitRaf);
  blitRaf = null;
  if (ok && clip) {
    clipBlob = clip.blob;
    videoUrl.value = URL.createObjectURL(clip.blob);
    state.value = 'done';
    if (publish.value) {
      try {
        const minted = await publishVideo({
          route_id: props.route.id,
          title: title.value.trim() || props.route.title,
          description: description.value,
        });
        if (minted && minted.created_at) createdAt.value = new Date(minted.created_at);
        published.value = true;
      } catch {
        publishFailed.value = true;
      }
    }
  } else {
    state.value = 'failed';
  }
});

onBeforeUnmount(() => {
  if (!finished) scene.stopPreview(); // closing mid-render aborts the pass
  if (blitRaf) cancelAnimationFrame(blitRaf);
  if (videoUrl.value) URL.revokeObjectURL(videoUrl.value);
});

function onClose() {
  emit('close');
}

// Native "Save As" when available, plain download anchor otherwise (same
// pattern as Route Planning's Save).
async function onDownload() {
  const blob = clipBlob;
  if (!blob) return;
  const ext = 'mp4';
  const pad = (n) => String(n).padStart(2, '0');
  const d = new Date();
  const name = `route-video-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.${ext}`;
  if (typeof window.showSaveFilePicker === 'function') {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: name,
        types: [{ description: 'Video', accept: { 'video/mp4': ['.mp4'] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return;
    } catch (err) {
      if (err && err.name === 'AbortError') return; // user cancelled
    }
  }
  const anchor = document.createElement('a');
  anchor.href = videoUrl.value;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}
</script>

<template>
  <div class="vd-mask">
    <div class="vd" role="dialog" aria-modal="true">
      <div class="vd__head">
        <button class="vd__close" :title="t('routevideodialog.close')" @click="onClose">&times;</button>
      </div>

      <div class="vd__panel">
        <canvas v-show="state === 'rendering'" ref="displayCanvas" class="vd__screen"></canvas>
        <video
          v-if="state === 'done'"
          :src="videoUrl"
          class="vd__screen"
          controls
          autoplay
          muted
          loop
        ></video>
        <div v-if="state === 'failed'" class="vd__failed">{{ t('routevideodialog.failed') }}</div>
      </div>

      <div class="vd__field">
        <span class="vd__label">{{ t('routevideodialog.title_label') }}</span>
        <input v-model="title" class="vd__title-input" type="text" maxlength="200" />
      </div>

      <div class="vd__created">{{ t('routevideodialog.created_at') }} {{ fmtDate(createdAt) }}</div>

      <textarea
        v-model="description"
        class="vd__desc"
        rows="4"
        maxlength="2000"
        :placeholder="t('routevideodialog.description_ph')"
      ></textarea>

      <div class="vd__progress">
        <div class="vd__progress-track">
          <div
            class="vd__progress-fill"
            :class="{ 'vd__progress-fill--done': state === 'done' }"
            :style="{ width: `${Math.round((state === 'done' ? 1 : progress.pct) * 100)}%` }"
          ></div>
        </div>
        <span v-if="state === 'rendering'" class="vd__progress-text">{{ progress.text }}</span>
      </div>

      <label class="vd__publish">
        <input v-model="publish" type="checkbox" :disabled="state !== 'rendering'" />
        <span>{{ t('routevideodialog.publish') }}</span>
      </label>
      <div v-if="published" class="vd__published">{{ t('routevideodialog.published') }}</div>
      <div v-else-if="publishFailed" class="vd__publish-failed">{{ t('routevideodialog.publish_failed') }}</div>

      <button
        class="vd__download"
        :class="{ 'vd__download--ready': state === 'done' }"
        :disabled="state !== 'done'"
        @click="onDownload"
      >
        {{ t('routevideodialog.download') }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.vd-mask {
  position: fixed;
  inset: 0;
  z-index: 5000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.45);
}

.vd {
  box-sizing: border-box;
  width: min(720px, 92vw);
  max-height: 92vh;
  overflow-y: auto;
  padding: 24px 28px 28px;
  border-radius: 14px;
  background: #ffffff;
  box-shadow: 0 18px 60px rgba(0, 0, 0, 0.35);
}

.vd__head {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  margin-bottom: 12px;
}

.vd__close {
  flex-shrink: 0;
  border: none;
  background: none;
  padding: 2px 8px;
  cursor: pointer;
  font-size: 1.3rem;
  line-height: 1;
  color: #8e8e93;
}

.vd__close:hover {
  color: #dc143c;
}

/* The video displaying panel: frames appear here as they are generated. */
.vd__panel {
  width: 100%;
  aspect-ratio: 16 / 9;
  border-radius: 10px;
  background: #000000;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
}

.vd__screen {
  width: 100%;
  height: 100%;
  display: block;
  object-fit: contain;
}

.vd__failed {
  font-size: 0.95rem;
  color: #f5f5f7;
}

/* Title row under the panel: label + editable input. */
.vd__field {
  margin-top: 16px;
  display: flex;
  align-items: center;
  gap: 10px;
}

.vd__label {
  flex-shrink: 0;
  font-size: 0.95rem;
  color: #1d1d1f;
}

.vd__title-input {
  box-sizing: border-box;
  flex: 1;
  min-width: 0;
  padding: 6px 12px;
  border: 1px solid #8e8e93;
  border-radius: 8px;
  background: #ffffff;
  font-size: 0.95rem;
  font-weight: 600;
  color: #111827;
}

.vd__title-input:focus {
  outline: 1px solid rgba(37, 99, 235, 0.5);
}

/* Creation time: not editable. */
.vd__created {
  margin-top: 12px;
  font-size: 0.95rem;
  color: #1d1d1f;
}

.vd__desc {
  box-sizing: border-box;
  width: 100%;
  margin-top: 12px;
  padding: 8px 12px;
  border: 1px solid #8e8e93;
  border-radius: 8px;
  background: #ffffff;
  font-family: inherit;
  font-size: 0.9rem;
  color: #111827;
  resize: vertical;
  min-height: 96px;
}

.vd__desc:focus {
  outline: 1px solid rgba(37, 99, 235, 0.5);
}

.vd__progress {
  margin-top: 16px;
  display: flex;
  align-items: center;
  gap: 12px;
}

.vd__progress-track {
  flex: 1;
  height: 6px;
  border-radius: 3px;
  background: #e5e5ea;
  overflow: hidden;
}

.vd__progress-fill {
  height: 100%;
  border-radius: 3px;
  background: #007aff;
  transition: width 0.2s ease;
}

.vd__progress-text {
  flex-shrink: 0;
  min-width: 64px;
  text-align: right;
  font-size: 0.85rem;
  color: #6e6e73;
  font-variant-numeric: tabular-nums;
}

.vd__publish {
  margin-top: 16px;
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 0.95rem;
  color: #1d1d1f;
  cursor: pointer;
  user-select: none;
}

.vd__publish input {
  width: 16px;
  height: 16px;
  accent-color: #007aff;
  cursor: pointer;
}

.vd__published {
  margin-top: 8px;
  font-size: 0.85rem;
  color: #34a853;
}

.vd__publish-failed {
  margin-top: 8px;
  font-size: 0.85rem;
  color: #dc143c;
}

/* Grey like the Account -> Login Save button until the clip is ready. */
.vd__download {
  margin-top: 18px;
  width: 100%;
  padding: 11px 0;
  border: none;
  border-radius: 8px;
  background: #f5f5f7;
  color: #1d1d1f;
  font-size: 0.95rem;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s ease;
}

.vd__download--ready {
  background: #007aff;
  color: #ffffff;
}

.vd__download--ready:hover {
  background: #0066d6;
}

.vd__download:disabled {
  cursor: default;
}
</style>
