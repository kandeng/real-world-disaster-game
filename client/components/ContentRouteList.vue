<script setup>
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import ConfigurableIcon from '@shared/ConfigurableIcon.vue';
import LoadingSpinner from '@shared/LoadingSpinner.vue';
import WaypointCards from '@shared/WaypointCards.vue';
import { useAuth } from '@shared-composables/useAuth.js';
import { useRoutes, setRouteVideoSignal, cachedRoutes } from '@shared-composables/useRoutes.js';
import { useSessionState } from '@shared-composables/useSessionState.js';

// Content -> Route: the user's saved routes, most recent first, separated
// by thin horizontal lines. Each entry collapses to title + creation time
// with an Expand/Collapse toggle at the right end; expanded, the title
// becomes an editable input and the waypoint card list (same style as the
// Route Planning -> Route popup) appears with Save / Video / Steer below.
const { t, locale } = useI18n();
const router = useRouter();
const { isAuthenticated } = useAuth();
const { listRoutes, saveRoute } = useRoutes();
const { session } = useSessionState();

// Phase 2 (session-state migration): the Steer / Video jumps seed the
// session store's route domain BEFORE navigating, replacing the old
// one-shot handoff. Assigning a fresh array/object keeps reactivity clean
// and the local row ids (:key) unique; Route Planning derives its wpSeq
// from the carried ids on mount.
function seedSessionRoute(r) {
  session.route.sourceRouteId = r.id != null ? r.id : null;
  session.route.title = r.title || '';
  session.route.description = r.description || '';
  session.route.createdAt = r.created_at || '';
  session.route.waypoints = (r.waypoints || []).map((w, i) => ({ ...w, id: i + 1, index: i + 1 }));
  session.route.selectedWpId = null;
  // Phase 3: the handoff lands with the Route panel open (the view context
  // of Route Planning is restored from this slot on every mount).
  session.view.route.subView = 'route';
}

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
      waypoints: r.waypoints,
    });
    r.title = updated.title;
    r.waypoints = updated.waypoints;
    savedId.value = r.id;
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => (savedId.value = null), 1600);
  } catch {
    /* keep the edited copy locally; the user can retry */
  } finally {
    savingId.value = null;
  }
}

// Video generation along the route: jump to Route Planning (like Steer)
// and open the video generation dialog THERE — same code path as clicking
// Route Planning -> Video, so the dialog lives in one place only.
function onVideo(r) {
  seedSessionRoute(r);
  setRouteVideoSignal(true);
  router.push({ name: 'RoutePlanning' });
}

// Steer this route in 3D Exploration: the SAME path as the Gallery's
// "Explore the Scene in 3D" — the /play?r=<16-char route id> deep link.
// AerialView fetches the route, seeds session.route (the 2D Route view then
// shows its read-only dots linked by the blue spline), draws the 3D overlay
// and hands the drone to the waypoint autopilot: cinematic playback of the
// route starts right away, and the Flight / Gimbal disks take over at any
// time.
function onSteer(r) {
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
        <div class="rlist__meta">
          <input
            v-if="expanded[r.id]"
            v-model="r.title"
            class="rlist__title-input"
            type="text"
            maxlength="200"
          />
          <div v-else class="rlist__title">{{ r.title }}</div>
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
        <WaypointCards :waypoints="r.waypoints" @edit="onEditWp(r, $event)" />
        <div class="rlist__actions">
          <button
            class="rlist__action"
            :title="t('contentroutelist.save')"
            :disabled="savingId === r.id"
            @click="onSave(r)"
          >
            <ConfigurableIcon name="MENU_SAVE" :size="26" />
          </button>
          <button class="rlist__action" :title="t('contentroutelist.video')" @click="onVideo(r)">
            <ConfigurableIcon name="MENU_RECORDER" :size="26" />
          </button>
          <button class="rlist__action" :title="t('contentroutelist.steer')" @click="onSteer(r)">
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

.rlist__meta {
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

/* Editable title while the entry is expanded. */
.rlist__title-input {
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

.rlist__title-input:focus {
  outline: 1px solid rgba(37, 99, 235, 0.5);
}

/* Creation time: not editable. */
.rlist__date {
  font-size: 0.95rem;
  color: #1d1d1f;
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
