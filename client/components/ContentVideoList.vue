<script setup>
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import ConfigurableIcon from '@shared/ConfigurableIcon.vue';
import LoadingSpinner from '@shared/LoadingSpinner.vue';
import { useAuth } from '@shared-composables/useAuth.js';
import { useVideos, cachedVideos, invalidateVideoCaches } from '@shared-composables/useVideos.js';
import { useVideoJob } from '@shared-composables/useVideoJob.js';

// Content -> Video: the user's published videos, most recent first,
// separated by thin horizontal lines — same layout language as the Route
// list. Collapsed, a card is its thumbnail; expanded: thumbnail on top,
// then the mp4 update control, Title + Description editors, the creation/
// update time, the read-only Play!/video links, and the Save / Download /
// Delete action row.
const { t, locale } = useI18n();
const { isAuthenticated } = useAuth();
const { listVideos, saveVideo, fetchVideoFile, updateVideoFile, deleteVideo } = useVideos();
const { job: videoJob } = useVideoJob();

const videos = ref([]);
const loading = ref(false);
const loadError = ref(false);
const expanded = ref({}); // videoId -> bool
const brokenThumbs = ref({}); // videoId -> true once the thumb image proves unusable
const savingId = ref(null);
const savedId = ref(null); // transient "Saved" hint next to the buttons
const failedId = ref(null); // transient "Save failed" hint
const syncFailedId = ref(null); // "saved locally, YouTube sync failed" hint
const downloadingId = ref(null);
const downloadFailedId = ref(null); // transient "Download failed" hint
const uploadingId = ref(null);
const uploadedId = ref(null); // transient "Uploaded" hint
const uploadFailedId = ref(null); // transient "Upload failed" hint
const deletingId = ref(null);
const deleteFailedId = ref(null); // transient "Delete failed" hint
const pendingDelete = ref(null); // video waiting in the Delete warning dialog
const filePicker = ref(null); // hidden <input type="file">
let pickTargetId = null; // the video the next picked mp4 belongs to
let hintTimer = null;
let downloadHintTimer = null;
let uploadHintTimer = null;

onMounted(async () => {
  if (!isAuthenticated.value) return;
  // Instant paint from the last successful fetch (tab switches and page
  // changes remount this component); the GET below silently revalidates.
  const cached = cachedVideos();
  if (cached) videos.value = cached;
  loading.value = !videos.value.length;
  try {
    videos.value = await listVideos();
  } catch {
    if (!videos.value.length) loadError.value = true;
  } finally {
    loading.value = false;
  }
});

// "Aug 28, 17:40" (en) / "8月28日 17:40" (zh)
function fmtDate(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return d.toLocaleString(locale.value === 'zh' ? 'zh-CN' : 'en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

// The card's single "Creation/Update Time" value: the last change wins
// (a video is minted from a route, so updated_at is the mint/last-edit
// moment the owner cares about).
function displayTime(v) {
  return fmtDate(v.updated_at || v.created_at);
}

// Read-only deep links on the card: the Play! link lands on the Play!
// page with this video's route loaded; the video link is the primary
// (lowest-position) playback URL.
function playUrl(v) {
  return v.route_id ? `${window.location.origin}/play?r=${v.route_id}` : null;
}

function videoUrl(v) {
  const src = [...(v.sources || [])]
    .sort((a, b) => a.position - b.position)
    .find((s) => s.url && s.url.trim());
  return src ? src.url.trim() : null;
}

function toggle(v) {
  expanded.value = { ...expanded.value, [v.id]: !expanded.value[v.id] };
}

// Front-page image thumbnail of the primary (lowest-position) source,
// shown in the collapsed list row instead of title + creation time.
// YouTube serves its thumbnails freely; other providers have no such
// endpoint, so they fall back to a dark placeholder panel.
function thumbUrl(v) {
  const src = [...(v.sources || [])]
    .sort((a, b) => a.position - b.position)
    .find((s) => s.url && s.url.trim());
  if (!src) return null;
  const url = src.url.trim();
  if (src.provider === 'youtube') {
    const m = url.match(/(?:youtu\.be\/|[?/]v=|\/embed\/|\/shorts\/)([A-Za-z0-9_-]{6,})/)
      || url.match(/^([A-Za-z0-9_-]{6,})$/);
    if (m) return `https://img.youtube.com/vi/${m[1]}/hqdefault.jpg`;
  }
  return null;
}

// A configured URL can still point at a nonexistent video. YouTube then
// answers the thumbnail request with its 120x90 gray "..." placeholder
// (404 status, but a valid JPEG body, so the <img> fires @load, not
// @error). A real hqdefault.jpg is 480x360 — a tiny naturalWidth means
// the video is gone/invalid and the row falls back to the dark panel.
function onThumbLoad(e, v) {
  const w = e.target.naturalWidth;
  if (w > 0 && w < 200) markThumbBroken(v);
}

function onThumbError(v) {
  markThumbBroken(v);
}

function markThumbBroken(v) {
  brokenThumbs.value = { ...brokenThumbs.value, [v.id]: true };
}

// Save lands in three places: this card, the Plaza feed (same server
// row) and the YouTube post — the server does the YouTube sync and
// reports it back in youtube_sync ("ok" / "skipped" / error code). A
// sync problem downgrades the hint, never the local save.
async function onSave(v) {
  if (savingId.value) return;
  savingId.value = v.id;
  try {
    const updated = await saveVideo(v.id, {
      title: v.title,
      description: v.description || '',
      waypoints: v.waypoints,
      sources: v.sources
        .filter((s) => s.url.trim())
        .map((s, i) => ({ provider: s.provider, url: s.url.trim(), position: i })),
    });
    v.title = updated.title;
    v.description = updated.description;
    v.waypoints = updated.waypoints;
    v.sources = updated.sources;
    v.updated_at = updated.updated_at;
    const sync = updated.youtube_sync;
    flash(v.id, sync && sync !== 'ok' && sync !== 'skipped' ? 'sync_failed' : 'saved');
  } catch {
    flash(v.id, 'failed');
  } finally {
    savingId.value = null;
  }
}

function flash(id, kind) {
  clearTimeout(hintTimer);
  savedId.value = kind === 'saved' ? id : null;
  failedId.value = kind === 'failed' ? id : null;
  syncFailedId.value = kind === 'sync_failed' ? id : null;
  hintTimer = setTimeout(() => {
    savedId.value = null;
    failedId.value = null;
    syncFailedId.value = null;
  }, 2400);
}

function flashUpload(id, kind) {
  clearTimeout(uploadHintTimer);
  uploadedId.value = kind === 'uploaded' ? id : null;
  uploadFailedId.value = kind === 'failed' ? id : null;
  uploadHintTimer = setTimeout(() => {
    uploadedId.value = null;
    uploadFailedId.value = null;
  }, 1600);
}

// "Video: update the mp4 video file" — the icon control opens the native
// file picker; the chosen mp4 replaces the server's cached copy (the one
// the Download button serves). The YouTube post stays untouched.
function pickFile(v) {
  if (uploadingId.value) return;
  pickTargetId = v.id;
  const input = filePicker.value;
  if (!input) return;
  input.value = ''; // allow re-picking the very same file
  input.click();
}

async function onFilePicked(e) {
  const file = e.target.files && e.target.files[0];
  const id = pickTargetId;
  pickTargetId = null;
  if (!file || !id) return;
  const v = videos.value.find((x) => x.id === id);
  if (!v) return;
  if (file.type !== 'video/mp4' && !/\.mp4$/i.test(file.name)) {
    flashUpload(id, 'failed');
    return;
  }
  uploadingId.value = id;
  try {
    const updated = await updateVideoFile(id, file);
    v.updated_at = updated.updated_at;
    flashUpload(id, 'uploaded');
  } catch {
    flashUpload(id, 'failed');
  } finally {
    uploadingId.value = null;
  }
}

// Download the mp4 to a local file directory. Source order: 1) the mp4
// rendered earlier in THIS session (the background job keeps the Blob in
// memory when it published this very video — no round trip needed);
// 2) the server's persisted copy (GET .../download). The native "Save
// As" picker is preferred (same as the old dialog button); browsers
// without it fall back to a download anchor.
async function onDownload(v) {
  if (downloadingId.value) return;
  downloadingId.value = v.id;
  downloadFailedId.value = null;
  try {
    let blob = videoJob.publishedId === v.id ? videoJob.clipBlob : null;
    if (!blob) blob = await fetchVideoFile(v.id);
    if (!blob) {
      downloadFailedId.value = v.id;
      clearTimeout(downloadHintTimer);
      downloadHintTimer = setTimeout(() => (downloadFailedId.value = null), 1600);
      return;
    }
    await saveBlobAsMp4(blob, v.title);
  } catch {
    downloadFailedId.value = v.id;
    clearTimeout(downloadHintTimer);
    downloadHintTimer = setTimeout(() => (downloadFailedId.value = null), 1600);
  } finally {
    downloadingId.value = null;
  }
}

async function saveBlobAsMp4(blob, title) {
  const base = (title || 'route-video').replace(/[\\/:*?"<>|]+/g, '_').trim() || 'route-video';
  const name = `${base}.mp4`;
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
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// Delete this video everywhere: the card disappears from Content ->
// Video and from the Plaza feed, and the related YouTube post is
// retired server-side (best-effort). The persisted mp4 is unlinked.
// The card's Delete button only OPENS the warning dialog; the actual
// delete runs once the user confirms with the dialog's blue button.
function onDelete(v) {
  if (deletingId.value) return;
  pendingDelete.value = v;
}

function cancelDelete() {
  pendingDelete.value = null;
}

async function confirmDelete() {
  const v = pendingDelete.value;
  pendingDelete.value = null;
  if (!v || deletingId.value) return;
  deletingId.value = v.id;
  deleteFailedId.value = null;
  try {
    await deleteVideo(v.id);
    videos.value = videos.value.filter((x) => x.id !== v.id);
    // Plaza (and any remount of this list) must refetch, not paint the
    // stale cached copy that still contains the deleted card.
    invalidateVideoCaches();
  } catch {
    deleteFailedId.value = v.id;
    clearTimeout(downloadHintTimer);
    downloadHintTimer = setTimeout(() => (deleteFailedId.value = null), 1600);
  } finally {
    deletingId.value = null;
  }
}
</script>

<template>
  <div class="vlist">
    <p v-if="!isAuthenticated" class="vlist__note">{{ t('contentvideolist.sign_in') }}</p>
    <p v-else-if="loadError" class="vlist__note">{{ t('contentvideolist.error') }}</p>
    <p v-else-if="!loading && !videos.length" class="vlist__note">{{ t('contentvideolist.empty') }}</p>

    <LoadingSpinner v-if="loading && !videos.length" />

    <div
      v-for="v in videos"
      :key="v.id"
      class="vlist__entry"
    >
      <div class="vlist__head">
        <!-- The video's front-page image thumbnail, same size collapsed
             and expanded (the expanded editor unfolds below it). -->
        <div class="vlist__thumb">
          <img
            v-if="thumbUrl(v) && !brokenThumbs[v.id]"
            :src="thumbUrl(v)"
            :alt="v.title"
            class="vlist__thumb-img"
            draggable="false"
            @load="onThumbLoad($event, v)"
            @error="onThumbError(v)"
          />
          <div v-else class="vlist__thumb-empty">{{ t('contentvideolist.no_video') }}</div>
        </div>
        <button
          class="vlist__toggle"
          :title="expanded[v.id] ? t('contentvideolist.collapse') : t('contentvideolist.expand')"
          :aria-label="expanded[v.id] ? t('contentvideolist.collapse') : t('contentvideolist.expand')"
          @click="toggle(v)"
        >
          <ConfigurableIcon
            :name="expanded[v.id] ? 'MENU_UPWARD' : 'MENU_DOWNWARD'"
            :size="28"
          />
        </button>
      </div>

      <template v-if="expanded[v.id]">
        <!-- Video: update the mp4 video file (native picker; replaces the
             server's cached mp4 that the Download button serves). -->
        <div class="vlist__video-row">
          <span class="vlist__inline-label">{{ t('contentvideolist.video_label') }}</span>
          <button
            class="vlist__upload"
            :disabled="uploadingId === v.id"
            @click="pickFile(v)"
          >
            <span>{{ t('contentvideolist.update_mp4') }}</span>
            <ConfigurableIcon name="MENU_FILE_UPLOAD" :size="20" />
          </button>
        </div>

        <div class="vlist__label-line">{{ t('contentvideolist.title_label') }}</div>
        <textarea
          v-model="v.title"
          class="vlist__title-input"
          rows="2"
          maxlength="200"
        ></textarea>

        <div class="vlist__label-line">{{ t('contentvideolist.description_label') }}</div>
        <textarea
          v-model="v.description"
          class="vlist__desc"
          rows="3"
          maxlength="2000"
        ></textarea>

        <div class="vlist__meta">{{ t('contentvideolist.time_label') }} {{ displayTime(v) }}</div>

        <div class="vlist__meta">
          {{ t('contentvideolist.play_url_label') }}
          <a
            v-if="playUrl(v)"
            :href="playUrl(v)"
            target="_blank"
            rel="noopener"
            class="vlist__link"
          >{{ playUrl(v) }}</a>
          <span v-else class="vlist__none">—</span>
        </div>

        <div class="vlist__meta">
          {{ t('contentvideolist.video_url_label') }}
          <a
            v-if="videoUrl(v)"
            :href="videoUrl(v)"
            target="_blank"
            rel="noopener"
            class="vlist__link"
          >{{ videoUrl(v) }}</a>
          <span v-else class="vlist__none">—</span>
        </div>

        <div class="vlist__actions">
          <button
            class="vlist__action"
            :title="t('contentvideolist.save')"
            :disabled="savingId === v.id"
            @click="onSave(v)"
          >
            <ConfigurableIcon name="MENU_SAVE" :size="26" />
          </button>
          <button
            class="vlist__action"
            :title="t('contentvideolist.download')"
            :disabled="downloadingId === v.id"
            @click="onDownload(v)"
          >
            <ConfigurableIcon name="MENU_FILE_DOWNLOAD" :size="26" />
          </button>
          <button
            class="vlist__action"
            :title="t('contentvideolist.delete')"
            :disabled="deletingId === v.id"
            @click="onDelete(v)"
          >
            <ConfigurableIcon name="MENU_CANCEL" :size="26" />
          </button>
          <span v-if="savedId === v.id" class="vlist__saved">{{ t('contentvideolist.saved') }}</span>
          <span v-else-if="failedId === v.id" class="vlist__failed">{{ t('contentvideolist.save_failed') }}</span>
          <span v-else-if="syncFailedId === v.id" class="vlist__failed">{{ t('contentvideolist.sync_failed') }}</span>
          <span v-else-if="downloadFailedId === v.id" class="vlist__failed">{{ t('contentvideolist.download_failed') }}</span>
          <span v-else-if="deleteFailedId === v.id" class="vlist__failed">{{ t('contentvideolist.delete_failed') }}</span>
          <span v-else-if="uploadedId === v.id" class="vlist__saved">{{ t('contentvideolist.uploaded') }}</span>
          <span v-else-if="uploadFailedId === v.id" class="vlist__failed">{{ t('contentvideolist.upload_failed') }}</span>
        </div>
      </template>
    </div>

    <!-- Shared hidden mp4 picker for every card's "update the mp4 video
         file" control (pickFile remembers which card opened it). -->
    <input
      ref="filePicker"
      type="file"
      accept="video/mp4,.mp4"
      style="display: none"
      @change="onFilePicked"
    />

    <!-- Delete warning dialog: the card's Delete button only opens it;
         the blue Delete button inside performs the three-place delete. -->
    <div v-if="pendingDelete" class="vlist__dialog-overlay" @click.self="cancelDelete">
      <div class="vlist__dialog">
        <p class="vlist__dialog-text">{{ t('contentvideolist.delete_warning') }}</p>
        <div class="vlist__dialog-actions">
          <button class="vlist__dialog-cancel" @click="cancelDelete">
            {{ t('contentvideolist.cancel') }}
          </button>
          <button class="vlist__dialog-confirm" @click="confirmDelete">
            {{ t('contentvideolist.delete') }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.vlist {
  padding: 8px 48px 48px;
}

.vlist__note {
  padding: 48px 0;
  font-size: 0.9rem;
  color: #6e6e73;
}

/* Thin horizontal separator between entries. */
.vlist__entry {
  padding: 28px 0;
  border-top: 1px solid #e5e5ea;
}

.vlist__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
}

/* Collapsed row: 16:9 front-page image thumbnail of the primary source
   (title + creation time now live inside the expanded editor). */
.vlist__thumb {
  width: 280px;
  aspect-ratio: 16 / 9;
  flex-shrink: 0;
  border-radius: 10px;
  overflow: hidden;
  background: #000000;
}

.vlist__thumb-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

/* Provider without a free thumbnail endpoint (Bilibili / Vimeo / ...). */
.vlist__thumb-empty {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 12px;
  box-sizing: border-box;
  font-size: 0.85rem;
  color: #f5f5f7;
  text-align: center;
}

/* Field labels sit on their own line above the editor boxes (Title: /
   Description:); editors are vertically resizable (drag the bottom
   border). */
.vlist__label-line {
  margin-top: 18px;
  margin-bottom: 6px;
  font-size: 0.95rem;
  color: #1d1d1f;
}

.vlist__title-input {
  box-sizing: border-box;
  width: 100%;
  max-width: 640px;
  padding: 8px 12px;
  border: 1px solid #8e8e93;
  border-radius: 8px;
  background: #ffffff;
  font-family: inherit;
  font-size: 1.05rem;
  font-weight: 600;
  color: #111827;
  resize: vertical;
  min-height: 56px;
}

.vlist__title-input:focus {
  outline: 1px solid rgba(37, 99, 235, 0.5);
}

/* "Video: update the mp4 video file <icon>" row. */
.vlist__video-row {
  margin-top: 18px;
  display: flex;
  align-items: center;
  gap: 10px;
}

.vlist__inline-label {
  font-size: 0.95rem;
  color: #1d1d1f;
}

.vlist__upload {
  border: none;
  background: none;
  padding: 2px;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 6px;
  font-family: inherit;
  font-size: 0.9rem;
  color: #515151;
}

.vlist__upload:hover:not(:disabled) {
  color: #007aff;
}

.vlist__upload:disabled {
  opacity: 0.4;
  cursor: default;
}

/* Read-only meta lines: Creation/Update Time, Play! URL, Video URL. */
.vlist__meta {
  margin-top: 12px;
  font-size: 0.95rem;
  color: #1d1d1f;
}

.vlist__link {
  color: #007aff;
  text-decoration: none;
  word-break: break-all;
}

.vlist__link:hover {
  text-decoration: underline;
}

.vlist__none {
  color: #6e6e73;
}

.vlist__desc {
  box-sizing: border-box;
  width: 100%;
  max-width: 640px;
  padding: 8px 12px;
  border: 1px solid #8e8e93;
  border-radius: 8px;
  background: #ffffff;
  font-family: inherit;
  font-size: 0.9rem;
  color: #111827;
  resize: vertical;
  min-height: 72px;
}

.vlist__desc:focus,
.vlist__title-input:focus {
  outline: 1px solid rgba(37, 99, 235, 0.5);
}

.vlist__toggle {
  flex-shrink: 0;
  border: none;
  background: none;
  padding: 4px;
  cursor: pointer;
  display: flex;
  align-items: center;
  color: #6e6e73;
}

.vlist__toggle:hover {
  color: #007aff;
}

.vlist__actions {
  margin-top: 18px;
  display: flex;
  align-items: center;
  gap: 22px;
}

/* Icon-only action buttons (Save / Download / Delete) — same language as
   the Content -> Route action row. */
.vlist__action {
  border: none;
  background: none;
  padding: 2px;
  cursor: pointer;
  display: flex;
  align-items: center;
  color: #515151;
}

.vlist__action:hover:not(:disabled) {
  color: #007aff;
}

.vlist__action:disabled {
  opacity: 0.4;
  cursor: default;
}

.vlist__saved {
  font-size: 0.85rem;
  color: #34a853;
}

.vlist__failed {
  font-size: 0.85rem;
  color: #dc143c;
}

/* Delete warning dialog (dimmed full-screen overlay, centered card). */
.vlist__dialog-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.35);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}

.vlist__dialog {
  width: 420px;
  max-width: calc(100vw - 48px);
  background: #ffffff;
  border-radius: 14px;
  box-shadow: 0 20px 50px rgba(0, 0, 0, 0.2);
  padding: 24px;
}

/* The warning text is a single i18n string with \n separators. */
.vlist__dialog-text {
  margin: 0;
  font-size: 0.95rem;
  line-height: 1.7;
  color: #1d1d1f;
  white-space: pre-line;
}

.vlist__dialog-actions {
  margin-top: 20px;
  display: flex;
  justify-content: flex-end;
  gap: 12px;
}

.vlist__dialog-cancel {
  border: none;
  background: none;
  padding: 8px 16px;
  cursor: pointer;
  font-family: inherit;
  font-size: 0.95rem;
  color: #6e6e73;
}

.vlist__dialog-cancel:hover {
  color: #1d1d1f;
}

.vlist__dialog-confirm {
  border: none;
  background: #007aff;
  color: #ffffff;
  border-radius: 8px;
  padding: 8px 26px;
  cursor: pointer;
  font-family: inherit;
  font-size: 0.95rem;
  font-weight: 600;
}

.vlist__dialog-confirm:hover {
  background: #0066d6;
}
</style>
