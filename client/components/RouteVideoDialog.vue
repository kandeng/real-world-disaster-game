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
const { publishVideo, uploadToYouTube } = useVideos();

const displayCanvas = ref(null);
const state = ref('rendering'); // 'rendering' | 'done' | 'failed'
const videoUrl = ref('');
let clipBlob = null;
const title = ref(props.route.title);
const description = ref('');
// Creation time is copied from the route (the video card shows the same).
const createdAt = computed(() => new Date(props.route.created_at));
const publish = ref(true);
const deletePrevious = ref(true);
const published = ref(false);
const publishedId = ref(null); // gallery record id (anchors the YouTube source)
const publishFailed = ref(false);
const publishing = ref(false);
const uploading = ref(false); // mp4 -> server -> YouTube in flight
const uploadPct = ref(0);
const uploadedUrl = ref('');
const uploadFailed = ref(false);
let blitRaf = null;
let finished = false;

// Blue live status line at the top of the dialog, driven by the
// renderer's phase code (same 0.95rem blue as the top-bar reminders).
const statusText = computed(() => {
  if (state.value !== 'rendering') return '';
  switch (scene.renderStatus.value) {
    case 'tiles': return t('routevideodialog.status_tiles');
    case 'render': return t('routevideodialog.status_render');
    case 'mux': return t('routevideodialog.status_mux');
    case 'fly': return t('routevideodialog.status_fly');
    default: return t('routevideodialog.status_start');
  }
});

// Errors surface as the red pulsing warning line (same style as the
// 3D Exploration collision warning).
const errorMsg = computed(() => {
  if (state.value === 'failed') return t('routevideodialog.failed');
  if (publishFailed.value) return t('routevideodialog.publish_failed');
  if (uploadFailed.value) return t('routevideodialog.upload_failed');
  return '';
});
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

// Clicking the (blue, ready) button: 1) publish the video card when the
// checkbox is on (optionally deleting the previous video of this route),
// 2) pop the native "Save As" dialog for the mp4.
async function onDownload() {
  const blob = clipBlob;
  if (!blob || publishing.value) return;
  if (publish.value && !published.value) {
    publishing.value = true;
    try {
      const created = await publishVideo({
        route_id: props.route.id,
        title: title.value.trim() || props.route.title,
        description: description.value,
        delete_previous: deletePrevious.value,
      });
      published.value = true;
      publishedId.value = created.id;
    } catch {
      publishFailed.value = true;
    } finally {
      publishing.value = false;
    }
  }
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

// "Upload to YouTube": ensure the gallery record exists (its id anchors
// the source rewrite server-side), then multipart the mp4 — the server
// uploads it to the site channel + drone-navigation playlist and returns
// the watch URL, shown as a link once done.
async function onUploadYouTube() {
  const blob = clipBlob;
  if (!blob || uploading.value || publishing.value) return;
  uploadFailed.value = false;
  try {
    let id = publishedId.value;
    if (!id) {
      publishing.value = true;
      const created = await publishVideo({
        route_id: props.route.id,
        title: title.value.trim() || props.route.title,
        description: description.value,
        delete_previous: deletePrevious.value,
      });
      published.value = true;
      publishedId.value = created.id;
      id = created.id;
    }
    uploading.value = true;
    uploadPct.value = 0;
    const updated = await uploadToYouTube(id, blob, (p) => {
      uploadPct.value = p;
    });
    const yt = (updated.sources || []).find((s) => s.provider === 'youtube');
    uploadedUrl.value = yt ? yt.url : '';
  } catch {
    uploadFailed.value = true;
  } finally {
    uploading.value = false;
    publishing.value = false;
  }
}
</script>

<template>
  <div class="vd-mask">
    <div class="vd" role="dialog" aria-modal="true">
      <div class="vd__head">
        <div class="vd__notice">
          <div v-if="errorMsg" class="vd__error">
            <span class="vd__error-icon">⚠</span>
            <span class="vd__error-text">{{ errorMsg }}</span>
            <span class="vd__error-icon">⚠</span>
          </div>
          <div v-else-if="uploading" class="vd__status">
            {{ t('routevideodialog.uploading_youtube') }} {{ Math.round(uploadPct * 100) }}%
          </div>
          <div v-else-if="state === 'rendering'" class="vd__status">{{ statusText }}</div>
        </div>
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
        <input v-model="publish" type="checkbox" :disabled="published" />
        <span>{{ t('routevideodialog.publish') }}</span>
      </label>
      <label class="vd__publish vd__publish--sub">
        <input v-model="deletePrevious" type="checkbox" :disabled="published" />
        <span>{{ t('routevideodialog.delete_previous') }}</span>
      </label>
      <div v-if="published" class="vd__published">{{ t('routevideodialog.published') }}</div>
      <div v-if="uploadedUrl" class="vd__published">
        {{ t('routevideodialog.uploaded_youtube') }}
        <a
          class="vd__yt-link"
          :href="uploadedUrl"
          target="_blank"
          rel="noopener"
        >{{ uploadedUrl }}</a>
      </div>

      <div class="vd__actions-row">
        <button
          class="vd__download vd__download--yt"
          :class="{ 'vd__download--ready': state === 'done' }"
          :disabled="state !== 'done' || uploading || publishing"
          @click="onUploadYouTube"
        >
          {{ t('routevideodialog.upload_youtube') }}
        </button>
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
  gap: 16px;
  margin-bottom: 12px;
}

/* The live status / warning line, centered in the remaining head space. */
.vd__notice {
  flex: 1;
  min-width: 0;
  display: flex;
  justify-content: center;
  text-align: center;
}

/* Blue like the top-bar reminder notices (0.95rem regular). */
.vd__status {
  color: #007aff;
  font-size: 0.95rem;
  font-weight: 400;
}

/* Red warning, same style as the 3D Exploration collision warning. */
.vd__error {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  color: #dc143c;
  font-family: Calibri, 'Segoe UI', sans-serif;
  font-size: 0.8rem;
  font-weight: 400;
  animation: vdWarningPulse 1s ease-in-out infinite;
}

.vd__error-icon {
  font-size: 1rem;
  line-height: 1;
}

.vd__error-text {
  letter-spacing: 0.02em;
}

@keyframes vdWarningPulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.55;
  }
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

.vd__publish--sub {
  margin-top: 10px;
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

/* Grey like the Account -> Login Save button until the clip is ready. */
.vd__download {
  flex: 1;
  padding: 11px 0;
  border: 1px solid transparent;
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

/* Upload to YouTube: outline variant of the ready state so the two
   actions stay visually distinct side by side. */
.vd__download--yt.vd__download--ready {
  background: #ffffff;
  border-color: #007aff;
  color: #007aff;
}

.vd__actions-row {
  margin-top: 18px;
  display: flex;
  gap: 12px;
}

.vd__yt-link {
  color: #007aff;
  word-break: break-all;
  text-decoration: none;
}

.vd__yt-link:hover {
  text-decoration: underline;
}

.vd__download--ready:hover {
  background: #0066d6;
}

.vd__download:disabled {
  cursor: default;
}
</style>
