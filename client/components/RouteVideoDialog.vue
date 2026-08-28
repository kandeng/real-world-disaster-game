<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouteScene3D } from '@shared-composables/useRouteScene3D.js';
import { useVideoJob } from '@shared-composables/useVideoJob.js';

// Produce -> Video (and Content -> Route -> Video): the dialog collects
// title / description / the publish options, and the Generate button
// starts the BACKGROUND video job (useVideoJob). The job renders the
// route into an mp4 and — with the publish checkbox on — publishes it to
// the Plaza and to YouTube, all INDEPENDENT of this dialog: the window
// can be closed at any moment, the job keeps running until it is done,
// and the shell top bar shows a completion notice. This dialog is only a
// viewer of the job state: it blits the frames live while they are
// rendered, shows the progress bar, and plays the clip once finished.
// The route is persisted only by the job (at publish time), so Generate
// with the checkbox off leaves the route unsaved.
const props = defineProps({
  route: { type: Object, required: true },
  ensureRoute: { type: Function, default: null },
});
const emit = defineEmits(['close']);

const { t, locale } = useI18n();
const scene = useRouteScene3D();
const { job, isActive, startVideoJob } = useVideoJob();

const displayCanvas = ref(null);
// Title and description start as copies of the Route panel's values; the
// user can edit both here so the video's metadata may differ from the
// route's afterwards.
const title = ref(props.route.title);
const description = ref(props.route.description || '');
// Creation time is copied from the route (the video card shows the same).
const createdAt = computed(() => new Date(props.route.created_at));
const publish = ref(true);
const deletePrevious = ref(true);
let blitRaf = null;

const rendering = computed(() => job.phase === 'rendering');
// Everything after the render pass (publish / upload / terminal states).
const finished = computed(() => rendering.value === false && job.phase !== 'idle');
// Before Generate (or after a render failure) the 16:9 panel shows the
// live static view of the first waypoint instead of a black box.
const previewing = computed(
  () => !rendering.value && !job.videoUrl && (props.route.waypoints || []).length > 0
);

// Blue live status line at the top of the dialog, driven by the job's
// phase (same 0.95rem blue as the top-bar reminders).
const statusText = computed(() => {
  if (job.phase === 'publishing') return t('routevideodialog.publishing');
  if (job.phase === 'uploading') {
    return `${t('routevideodialog.uploading_youtube')} ${Math.round(job.uploadPct * 100)}%`;
  }
  if (job.phase !== 'rendering') return '';
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
  if (job.phase !== 'failed') return '';
  if (job.error === 'publish') return t('routevideodialog.publish_failed');
  if (job.error === 'youtube') return t('routevideodialog.upload_failed');
  return t('routevideodialog.failed');
});
// Offline pass: { frame, total }; fallback capture flight: distance %.
// After the render pass the bar stays full (publish / upload follow).
const progress = computed(() => {
  if (!rendering.value) return { pct: finished.value ? 1 : 0, text: '' };
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

// Blit the frames the renderer finishes into the visible panel canvas —
// active exactly while the job's render pass runs (incl. when the dialog
// is reopened mid-render).
function startBlit() {
  if (blitRaf) return;
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
function stopBlit() {
  if (blitRaf) {
    cancelAnimationFrame(blitRaf);
    blitRaf = null;
  }
}
watch(rendering, (on) => {
  if (on) startBlit();
  else stopBlit();
}, { immediate: true });

// Idle preview: park the shared camera at the first waypoint's authored
// pose and blit the live viewer crop into the panel canvas until Generate
// takes over (rendering) or the clip is ready (video player).
let stopViewerBlit = null;
function startPreviewBlit() {
  if (stopViewerBlit) return;
  scene.parkAtFirstWaypoint(props.route.waypoints);
  stopViewerBlit = scene.startViewerBlit(displayCanvas.value);
}
function endPreviewBlit() {
  if (stopViewerBlit) {
    stopViewerBlit();
    stopViewerBlit = null;
  }
}
watch(previewing, (on) => {
  if (on) startPreviewBlit();
  else endPreviewBlit();
});
onMounted(() => {
  if (previewing.value) startPreviewBlit();
});

// Closing the dialog NEVER aborts the job: the render / publish / upload
// keep running in the background (the shell top bar reports completion).
onBeforeUnmount(() => {
  stopBlit();
  endPreviewBlit();
});

function onClose() {
  emit('close');
}

// Generate: snapshot the fields + checkboxes and hand them to the
// background job. Edits made afterwards do not affect the running job.
function onGenerate() {
  if (isActive.value) return;
  startVideoJob({
    waypoints: props.route.waypoints,
    title: title.value.trim() || props.route.title,
    description: description.value,
    publish: publish.value,
    deletePrevious: deletePrevious.value,
    ensureRoute: props.ensureRoute,
    fallbackRouteId: props.route.id ?? null,
  });
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
          <div v-else-if="statusText" class="vd__status">{{ statusText }}</div>
        </div>
        <button class="vd__close" :title="t('routevideodialog.close')" @click="onClose">&times;</button>
      </div>

      <div class="vd__panel">
        <canvas v-show="rendering || previewing" ref="displayCanvas" class="vd__screen"></canvas>
        <video
          v-if="job.videoUrl && !rendering"
          :src="job.videoUrl"
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
            :class="{ 'vd__progress-fill--done': finished }"
            :style="{ width: `${Math.round(progress.pct * 100)}%` }"
          ></div>
        </div>
        <span v-if="rendering" class="vd__progress-text">{{ progress.text }}</span>
      </div>

      <label class="vd__publish">
        <input v-model="publish" type="checkbox" :disabled="isActive || !!job.publishedId" />
        <span>{{ t('routevideodialog.publish') }}</span>
      </label>
      <label class="vd__publish vd__publish--sub">
        <input v-model="deletePrevious" type="checkbox" :disabled="isActive || !!job.publishedId" />
        <span>{{ t('routevideodialog.delete_previous') }}</span>
      </label>
      <div v-if="job.publishedId" class="vd__published">{{ t('routevideodialog.published') }}</div>
      <!-- While the YouTube upload runs the line reads "Publishing…"; once
           the watch URL lands it flips to "Uploaded to YouTube: <link>". -->
      <div v-if="job.phase === 'uploading'" class="vd__published">
        {{ t('routevideodialog.publishing_youtube') }}
      </div>
      <div v-else-if="job.uploadedUrl" class="vd__published">
        {{ t('routevideodialog.uploaded_youtube') }}
        <a
          class="vd__yt-link"
          :href="job.uploadedUrl"
          target="_blank"
          rel="noopener"
        >{{ job.uploadedUrl }}</a>
      </div>

      <div class="vd__actions-row">
        <button
          class="vd__download"
          :class="{ 'vd__download--ready': !isActive }"
          :disabled="isActive"
          @click="onGenerate"
        >
          {{ t('routevideodialog.generate') }}
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
