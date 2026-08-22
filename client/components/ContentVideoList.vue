<script setup>
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import ConfigurableIcon from '@shared/ConfigurableIcon.vue';
import WaypointCards from '@shared/WaypointCards.vue';
import { useAuth } from '@shared-composables/useAuth.js';
import { useVideos } from '@shared-composables/useVideos.js';

// Content -> Video: the user's published videos, most recent first,
// separated by thin horizontal lines — same layout language as the Route
// list. Expanded, the title is editable, the waypoint snapshot is listed
// as waypoint cards, and the owner can edit the ordered playback URLs
// (YouTube primary, Bilibili second, more providers later).
const { t, locale } = useI18n();
const { isAuthenticated } = useAuth();
const { listVideos, saveVideo } = useVideos();

const videos = ref([]);
const loading = ref(false);
const loadError = ref(false);
const expanded = ref({}); // videoId -> bool
const savingId = ref(null);
const savedId = ref(null); // transient "Saved" hint next to the buttons
const failedId = ref(null); // transient "Save failed" hint
let hintTimer = null;

// Known playback providers; extend here (and only here) later.
const PROVIDERS = ['youtube', 'bilibili', 'vimeo', 'website'];
const PROVIDER_LABELS = {
  youtube: 'YouTube',
  bilibili: 'Bilibili',
  vimeo: 'Vimeo',
  website: 'Website',
};

onMounted(async () => {
  if (!isAuthenticated.value) return;
  loading.value = true;
  try {
    videos.value = await listVideos();
  } catch {
    loadError.value = true;
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

function onEditWp(v, { pos, field, value }) {
  const wp = v.waypoints[pos];
  if (wp) wp[field] = value;
}

function providerLabel(p) {
  return PROVIDER_LABELS[p] || p;
}

function addSource(v) {
  const used = new Set(v.sources.map((s) => s.provider));
  const provider = PROVIDERS.find((p) => !used.has(p));
  if (!provider) return; // every known provider already listed
  v.sources.push({ provider, url: '', position: v.sources.length });
}

function removeSource(v, i) {
  v.sources.splice(i, 1);
}

async function onSave(v) {
  if (savingId.value) return;
  savingId.value = v.id;
  try {
    const updated = await saveVideo(v.id, {
      title: v.title,
      waypoints: v.waypoints,
      sources: v.sources
        .filter((s) => s.url.trim())
        .map((s, i) => ({ provider: s.provider, url: s.url.trim(), position: i })),
    });
    v.title = updated.title;
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
</script>

<template>
  <div class="vlist">
    <p v-if="!isAuthenticated" class="vlist__note">{{ t('contentvideolist.sign_in') }}</p>
    <p v-else-if="loadError" class="vlist__note">{{ t('contentvideolist.error') }}</p>
    <p v-else-if="!loading && !videos.length" class="vlist__note">{{ t('contentvideolist.empty') }}</p>

    <div
      v-for="v in videos"
      :key="v.id"
      class="vlist__entry"
    >
      <div class="vlist__head">
        <div class="vlist__meta">
          <input
            v-if="expanded[v.id]"
            v-model="v.title"
            class="vlist__title-input"
            type="text"
            maxlength="200"
          />
          <div v-else class="vlist__title">{{ v.title }}</div>
          <div class="vlist__date">{{ fmtDate(v.created_at) }}</div>
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
        <WaypointCards :waypoints="v.waypoints" @edit="onEditWp(v, $event)" />

        <div class="vlist__sources">
          <div class="vlist__sources-title">{{ t('contentvideolist.playback_urls') }}</div>
          <div
            v-for="(s, i) in v.sources"
            :key="i"
            class="vlist__source-row"
          >
            <select v-model="s.provider" class="vlist__source-provider">
              <option
                v-for="p in PROVIDERS"
                :key="p"
                :value="p"
              >
                {{ providerLabel(p) }}
              </option>
            </select>
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
            <button
              class="vlist__source-del"
              :title="t('contentvideolist.remove')"
              :aria-label="t('contentvideolist.remove')"
              @click="removeSource(v, i)"
            >&times;</button>
          </div>
          <button
            class="vlist__source-add"
            :disabled="v.sources.length >= PROVIDERS.length"
            @click="addSource(v)"
          >+ {{ t('contentvideolist.add_source') }}</button>
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
          <span v-if="savedId === v.id" class="vlist__saved">{{ t('contentvideolist.saved') }}</span>
          <span v-else-if="failedId === v.id" class="vlist__failed">{{ t('contentvideolist.save_failed') }}</span>
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

.vlist__meta {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.vlist__title {
  font-size: 1.15rem;
  font-weight: 600;
  color: #111827;
}

/* Editable title while the entry is expanded. */
.vlist__title-input {
  box-sizing: border-box;
  max-width: 480px;
  padding: 6px 12px;
  border: 1px solid #8e8e93;
  border-radius: 8px;
  background: #ffffff;
  font-size: 1.15rem;
  font-weight: 600;
  color: #111827;
}

.vlist__title-input:focus {
  outline: 1px solid rgba(37, 99, 235, 0.5);
}

/* Creation time: not editable. */
.vlist__date {
  font-size: 0.95rem;
  color: #1d1d1f;
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

.vlist__source-provider {
  flex-shrink: 0;
  width: 110px;
  padding: 6px 8px;
  border: 1px solid #8e8e93;
  border-radius: 8px;
  background: #ffffff;
  font-size: 0.9rem;
  color: #111827;
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

.vlist__source-url:focus,
.vlist__source-provider:focus {
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

.vlist__source-del {
  flex-shrink: 0;
  border: none;
  background: none;
  padding: 2px 8px;
  cursor: pointer;
  font-size: 1.1rem;
  line-height: 1;
  color: #8e8e93;
}

.vlist__source-del:hover {
  color: #dc143c;
}

.vlist__source-add {
  align-self: flex-start;
  margin-top: 4px;
  border: none;
  background: none;
  padding: 4px 0;
  cursor: pointer;
  font-size: 0.85rem;
  color: #007aff;
}

.vlist__source-add:hover:not(:disabled) {
  text-decoration: underline;
}

.vlist__source-add:disabled {
  color: #8e8e93;
  cursor: default;
}

.vlist__actions {
  margin-top: 18px;
  display: flex;
  align-items: center;
  gap: 22px;
}

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
