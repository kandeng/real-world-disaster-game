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
// list. Expanded, the title is editable and the owner can edit the video
// URL rows (URL input + Open + delete). Save persists the edits (icon
// button, same language as Content -> Route); Download saves the mp4 to
// a local file (this session's in-memory render first, else the server's
// persisted copy).
const { t, locale } = useI18n();
const { isAuthenticated } = useAuth();
const { listVideos, saveVideo, fetchVideoFile, deleteVideo } = useVideos();
const { job: videoJob } = useVideoJob();

const videos = ref([]);
const loading = ref(false);
const loadError = ref(false);
const expanded = ref({}); // videoId -> bool
const brokenThumbs = ref({}); // videoId -> true once the thumb image proves unusable
const savingId = ref(null);
const savedId = ref(null); // transient "Saved" hint next to the buttons
const failedId = ref(null); // transient "Save failed" hint
const downloadingId = ref(null);
const downloadFailedId = ref(null); // transient "Download failed" hint
const deletingId = ref(null);
const deleteFailedId = ref(null); // transient "Delete failed" hint
let hintTimer = null;
let downloadHintTimer = null;

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

// "Aug 22, 2026, 15:25" (en) / "2026年8月22日 15:25" (zh)
function fmtDate(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return d.toLocaleString(locale.value === 'zh' ? 'zh-CN' : 'en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
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

// Embed URL of the primary (lowest-position) playable source, so the card
// tops with a real video displaying window. Returns null when nothing
// parseable is configured yet (black placeholder panel instead).
function embedUrl(v) {
  const src = [...(v.sources || [])]
    .sort((a, b) => a.position - b.position)
    .find((s) => s.url && s.url.trim());
  if (!src) return null;
  const url = src.url.trim();
  if (src.provider === 'youtube') {
    const m = url.match(/(?:youtu\.be\/|[?/]v=|\/embed\/|\/shorts\/)([A-Za-z0-9_-]{6,})/)
      || url.match(/^([A-Za-z0-9_-]{6,})$/);
    // Plain youtube.com (NOT youtube-nocookie.com): the nocookie domain
    // cannot share cookies with a signed-in Google session, so YouTube's
    // bot detection walls anonymous embeds with "Sign in to confirm
    // you're not a bot". hl pins the player UI to the app language.
    if (m) return `https://www.youtube.com/embed/${m[1]}?hl=${locale.value === 'zh' ? 'zh_CN' : 'en_US'}`;
  } else if (src.provider === 'bilibili') {
    const bv = url.match(/(BV[0-9A-Za-z]+)/);
    const av = url.match(/av(\d+)/i);
    if (bv) return `https://player.bilibili.com/player.html?bvid=${bv[1]}&autoplay=0&high_quality=1`;
    if (av) return `https://player.bilibili.com/player.html?aid=${av[1]}&autoplay=0&high_quality=1`;
  } else if (src.provider === 'vimeo') {
    const m = url.match(/vimeo\.com\/(\d+)/);
    if (m) return `https://player.vimeo.com/video/${m[1]}`;
  }
  return null;
}

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
    flash(v.id, 'saved');
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
  hintTimer = setTimeout(() => {
    savedId.value = null;
    failedId.value = null;
  }, 1600);
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
async function onDelete(v) {
  if (deletingId.value) return;
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
        <!-- Collapsed: the video's front-page image thumbnail (title +
             creation time move into the expanded editor). -->
        <div v-if="!expanded[v.id]" class="vlist__thumb">
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
        <div v-else class="vlist__spacer"></div>
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
        <div class="vlist__screen">
          <iframe
            v-if="embedUrl(v)"
            :src="embedUrl(v)"
            class="vlist__iframe"
            frameborder="0"
            allow="autoplay; fullscreen; encrypted-media; picture-in-picture"
            allowfullscreen
          ></iframe>
          <div v-else class="vlist__screen-empty">{{ t('contentvideolist.no_source') }}</div>
        </div>

        <div class="vlist__field">
          <span class="vlist__label">{{ t('contentvideolist.title_label') }}</span>
          <textarea
            v-model="v.title"
            class="vlist__title-input"
            rows="2"
            maxlength="200"
          ></textarea>
        </div>

        <div class="vlist__created">{{ t('contentvideolist.created_at') }} {{ fmtDate(v.created_at) }}</div>

        <textarea
          v-model="v.description"
          class="vlist__desc"
          rows="3"
          maxlength="2000"
          :placeholder="t('contentvideolist.description_ph')"
        ></textarea>

        <div class="vlist__sources">
          <div class="vlist__sources-title">{{ t('contentvideolist.video_url') }}</div>
          <div
            v-for="(s, i) in v.sources"
            :key="i"
            class="vlist__source-row"
          >
            <input
              v-model="s.url"
              class="vlist__source-url"
              type="url"
              :placeholder="t('contentvideolist.url_placeholder')"
            />
            <a
              v-if="s.url.trim()"
              :href="s.url"
              target="_blank"
              rel="noopener"
              class="vlist__source-open"
              :title="t('contentvideolist.open')"
            >{{ t('contentvideolist.open') }}</a>
          </div>
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
            <ConfigurableIcon name="MENU_DOWNLOAD_FILE" :size="26" />
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
          <span v-else-if="downloadFailedId === v.id" class="vlist__failed">{{ t('contentvideolist.download_failed') }}</span>
          <span v-else-if="deleteFailedId === v.id" class="vlist__failed">{{ t('contentvideolist.delete_failed') }}</span>
        </div>
      </template>
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

.vlist__spacer {
  flex: 1;
}

/* Editable title while the entry is expanded. */
.vlist__title-input {
  box-sizing: border-box;
  flex: 1;
  min-width: 0;
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

/* The video displaying window: embedded primary playback URL. */
.vlist__screen {
  width: 100%;
  max-width: 640px;
  aspect-ratio: 16 / 9;
  border-radius: 10px;
  background: #000000;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
}

.vlist__iframe {
  width: 100%;
  height: 100%;
  border: none;
  display: block;
}

.vlist__screen-empty {
  font-size: 0.9rem;
  color: #f5f5f7;
  text-align: center;
  padding: 0 24px;
}

/* Title row: label + editable multi-line input (same box language as the
   description textarea: wraps and is vertically resizable). */
.vlist__field {
  margin-top: 16px;
  display: flex;
  align-items: flex-start;
  gap: 10px;
  max-width: 640px;
}

.vlist__label {
  flex-shrink: 0;
  padding-top: 8px;
  font-size: 0.95rem;
  color: #1d1d1f;
}

.vlist__created {
  margin-top: 12px;
  font-size: 0.95rem;
  color: #1d1d1f;
}

.vlist__desc {
  box-sizing: border-box;
  width: 100%;
  max-width: 640px;
  margin-top: 12px;
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

.vlist__sources {
  margin-top: 20px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-width: 640px;
}

.vlist__sources-title {
  font-size: 0.95rem;
  color: #1d1d1f;
}

.vlist__source-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.vlist__source-url {
  box-sizing: border-box;
  flex: 1;
  min-width: 0;
  padding: 6px 12px;
  border: 1px solid #8e8e93;
  border-radius: 8px;
  background: #ffffff;
  font-size: 0.9rem;
  color: #111827;
}

.vlist__source-url:focus {
  outline: 1px solid rgba(37, 99, 235, 0.5);
}

.vlist__source-open {
  flex-shrink: 0;
  font-size: 0.85rem;
  color: #007aff;
  text-decoration: none;
}

.vlist__source-open:hover {
  text-decoration: underline;
}

.vlist__actions {
  margin-top: 18px;
  display: flex;
  align-items: center;
  gap: 22px;
}

/* Icon-only action buttons (Save / Download) — same language as the
   Content -> Route action row. */
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
</style>
