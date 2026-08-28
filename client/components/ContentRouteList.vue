<script setup>
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import ConfigurableIcon from '@shared/ConfigurableIcon.vue';
import LoadingSpinner from '@shared/LoadingSpinner.vue';
import WaypointCards from '@shared/WaypointCards.vue';
import { useAuth } from '@shared-composables/useAuth.js';
import { useRoutes, cachedRoutes } from '@shared-composables/useRoutes.js';

// Content -> Route: the user's saved routes, most recent first, separated
// by thin horizontal lines. Each entry collapses to title + creation time
// with an Expand/Collapse toggle at the right end; expanded: Title and
// Description editors (drag the bottom border to resize), the editable
// waypoint card list, the Creation/Update Time and Play! URL lines, and
// the Save / Play! action row.
const { t, locale } = useI18n();
const router = useRouter();
const { isAuthenticated } = useAuth();
const { listRoutes, saveRoute } = useRoutes();

const routes = ref([]);
const loading = ref(false);
const loadError = ref(false);
const expanded = ref({}); // routeId -> bool
const savingId = ref(null);
const savedId = ref(null); // transient "Saved" hint next to the buttons
let savedTimer = null;

onMounted(async () => {
  if (!isAuthenticated.value) return;
  // Instant paint from the last successful fetch (tab switches and page
  // changes remount this component); the GET below silently revalidates.
  const cached = cachedRoutes();
  if (cached) routes.value = cached;
  loading.value = !routes.value.length;
  try {
    routes.value = await listRoutes();
  } catch {
    if (!routes.value.length) loadError.value = true;
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

// "Aug 28, 17:40" (en) / "8月28日 17:40" (zh) — the card's single
// Creation/Update Time value: the last change wins.
function fmtShort(iso) {
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

function displayTime(r) {
  return fmtShort(r.updated_at || r.created_at);
}

// Read-only deep link: the Play! page with this route loaded.
function playUrl(r) {
  return `${window.location.origin}/play?r=${r.id}`;
}

function toggle(r) {
  expanded.value = { ...expanded.value, [r.id]: !expanded.value[r.id] };
}

function onEditWp(r, { pos, field, value }) {
  const wp = r.waypoints[pos];
  if (wp) wp[field] = value;
}

async function onSave(r) {
  if (savingId.value) return;
  savingId.value = r.id;
  try {
    const updated = await saveRoute(r.id, {
      title: r.title,
      description: r.description || '',
      waypoints: r.waypoints,
    });
    r.title = updated.title;
    r.description = updated.description;
    r.waypoints = updated.waypoints;
    r.updated_at = updated.updated_at;
    savedId.value = r.id;
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => (savedId.value = null), 1600);
  } catch {
    /* keep the edited copy locally; the user can retry */
  } finally {
    savingId.value = null;
  }
}

// Fly this route in the Play! page (the button is named after it): the
// SAME path as the Gallery's "Explore the Scene in 3D" — the
// /play?r=<16-char route id> deep link. AerialView fetches the route,
// seeds session.route (the 2D Route view then shows its read-only dots
// linked by the blue spline), draws the 3D overlay and hands the drone
// to the waypoint autopilot: cinematic playback of the route starts
// right away, and the Flight / Gimbal disks take over at any time.
function onPlay(r) {
  router.push({ path: '/play', query: { r: r.id } });
}
</script>

<template>
  <div class="rlist">
    <p v-if="!isAuthenticated" class="rlist__note">{{ t('contentroutelist.sign_in') }}</p>
    <p v-else-if="loadError" class="rlist__note">{{ t('contentroutelist.error') }}</p>
    <p v-else-if="!loading && !routes.length" class="rlist__note">{{ t('contentroutelist.empty') }}</p>

    <LoadingSpinner v-if="loading && !routes.length" />

    <div
      v-for="r in routes"
      :key="r.id"
      class="rlist__entry"
    >
      <div class="rlist__head">
        <div class="rlist__head-info">
          <div class="rlist__title">{{ r.title }}</div>
          <div class="rlist__date">{{ fmtDate(r.created_at) }}</div>
        </div>
        <button
          class="rlist__toggle"
          :title="expanded[r.id] ? t('contentroutelist.collapse') : t('contentroutelist.expand')"
          :aria-label="expanded[r.id] ? t('contentroutelist.collapse') : t('contentroutelist.expand')"
          @click="toggle(r)"
        >
          <ConfigurableIcon
            :name="expanded[r.id] ? 'MENU_UPWARD' : 'MENU_DOWNWARD'"
            :size="28"
          />
        </button>
      </div>

      <template v-if="expanded[r.id]">
        <div class="rlist__label-line">{{ t('contentroutelist.title_label') }}</div>
        <textarea
          v-model="r.title"
          class="rlist__title-input"
          rows="2"
          maxlength="200"
        ></textarea>

        <div class="rlist__label-line">{{ t('contentroutelist.description_label') }}</div>
        <textarea
          v-model="r.description"
          class="rlist__desc"
          rows="3"
          maxlength="2000"
        ></textarea>

        <div class="rlist__label-line">{{ t('contentroutelist.waypoints_label') }}</div>
        <WaypointCards :waypoints="r.waypoints" @edit="onEditWp(r, $event)" />

        <div class="rlist__meta">{{ t('contentroutelist.time_label') }} {{ displayTime(r) }}</div>

        <div class="rlist__meta">
          {{ t('contentroutelist.play_url_label') }}
          <a
            :href="playUrl(r)"
            target="_blank"
            rel="noopener"
            class="rlist__link"
          >{{ playUrl(r) }}</a>
        </div>

        <div class="rlist__actions">
          <button
            class="rlist__action"
            :title="t('contentroutelist.save')"
            :disabled="savingId === r.id"
            @click="onSave(r)"
          >
            <ConfigurableIcon name="MENU_SAVE" :size="26" />
          </button>
          <button class="rlist__action" :title="t('contentroutelist.play')" @click="onPlay(r)">
            <ConfigurableIcon name="MENU_CONTROL_STICK" :size="26" />
          </button>
          <span v-if="savedId === r.id" class="rlist__saved">{{ t('contentroutelist.saved') }}</span>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.rlist {
  padding: 8px 48px 48px;
}

.rlist__note {
  padding: 48px 0;
  font-size: 0.9rem;
  color: #6e6e73;
}

/* Thin horizontal separator between entries. */
.rlist__entry {
  padding: 28px 0;
  border-top: 1px solid #e5e5ea;
}

.rlist__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
}

.rlist__head-info {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.rlist__title {
  font-size: 1.15rem;
  font-weight: 600;
  color: #111827;
}

/* Editable Title box in the expanded body — same language as the video
   card's title textarea (drag the bottom border to resize). */
.rlist__title-input {
  box-sizing: border-box;
  display: block;
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

.rlist__title-input:focus {
  outline: 1px solid rgba(37, 99, 235, 0.5);
}

/* Creation time: not editable. */
.rlist__date {
  font-size: 0.95rem;
  color: #1d1d1f;
}

/* Field labels sit on their own line above the editor boxes and the
   waypoint list (Title: / Description: / Waypoint List:). */
.rlist__label-line {
  margin-top: 18px;
  margin-bottom: 6px;
  font-size: 0.95rem;
  color: #1d1d1f;
}

/* Editable description while expanded — same box language as the video
   card's description textarea in Content -> Video. */
.rlist__desc {
  box-sizing: border-box;
  display: block;
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

.rlist__desc:focus {
  outline: 1px solid rgba(37, 99, 235, 0.5);
}

/* Read-only meta lines: Creation/Update Time, Play! URL. */
.rlist__meta {
  margin-top: 12px;
  font-size: 0.95rem;
  color: #1d1d1f;
}

.rlist__link {
  color: #007aff;
  text-decoration: none;
  word-break: break-all;
}

.rlist__link:hover {
  text-decoration: underline;
}

.rlist__toggle {
  flex-shrink: 0;
  border: none;
  background: none;
  padding: 4px;
  cursor: pointer;
  display: flex;
  align-items: center;
  color: #6e6e73;
}

.rlist__toggle:hover {
  color: #007aff;
}

.rlist__actions {
  margin-top: 18px;
  display: flex;
  align-items: center;
  gap: 22px;
}

.rlist__action {
  border: none;
  background: none;
  padding: 2px;
  cursor: pointer;
  display: flex;
  align-items: center;
  color: #515151;
}

.rlist__action:hover:not(:disabled) {
  color: #007aff;
}

.rlist__action:disabled {
  opacity: 0.4;
  cursor: default;
}

.rlist__saved {
  font-size: 0.85rem;
  color: #34a853;
}
</style>
