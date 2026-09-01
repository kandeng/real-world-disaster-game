<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import ViewComposer from '@shared/_ViewComposer.vue';
import TabBar from '@shared/TabBar.vue';
import LoadingSpinner from '@shared/LoadingSpinner.vue';
import { useDockRegistry } from '@shared-composables/useDockRegistry.js';
import { useMeshes } from '@shared-composables/useMeshes.js';

const { t } = useI18n();
const { clear } = useDockRegistry();
const { listPublicMeshes, publicMeshFileUrl } = useMeshes();

/* ─── Public Component ───
   Plugin-style browsing layout (top category bar + breadcrumb + search +
   results) for the shared public component library. Twelve categories;
   when they no longer fit the top bar, TabBar collapses the remainder into
   its "»" overflow button automatically.
   The feed is the anonymous GET /api/meshes/public endpoint: every mesh an
   owner published (visibility='public') with a classified shelf; each card
   renders the actual GLB through the no-auth public file endpoint. */

const CATEGORIES = [
  { id: 'vehicle', labelKey: 'publiccomponentview.cat_vehicle' },
  { id: 'ship', labelKey: 'publiccomponentview.cat_ship' },
  { id: 'plane', labelKey: 'publiccomponentview.cat_plane' },
  { id: 'architecture', labelKey: 'publiccomponentview.cat_architecture' },
  { id: 'sculpture', labelKey: 'publiccomponentview.cat_sculpture' },
  { id: 'human', labelKey: 'publiccomponentview.cat_human' },
  { id: 'animal', labelKey: 'publiccomponentview.cat_animal' },
  { id: 'vegetation', labelKey: 'publiccomponentview.cat_vegetation' },
  { id: 'equipment', labelKey: 'publiccomponentview.cat_equipment' },
  { id: 'water', labelKey: 'publiccomponentview.cat_water' },
  { id: 'fire', labelKey: 'publiccomponentview.cat_fire' },
  { id: 'cloud', labelKey: 'publiccomponentview.cat_cloud' },
];

const selectedId = ref('vehicle');
const searchQuery = ref('');

const viewerReady = ref(false); // @google/model-viewer loaded + defined
const items = ref([]); // published rows of the current category
const loading = ref(false);
const loadError = ref(false);
let fetchSeq = 0; // drop stale responses after fast category switching

async function loadCategory(id) {
  const seq = ++fetchSeq;
  loading.value = true;
  loadError.value = false;
  try {
    const rows = await listPublicMeshes({ category: id });
    if (seq !== fetchSeq) return;
    items.value = rows;
  } catch {
    if (seq !== fetchSeq) return;
    items.value = [];
    loadError.value = true;
  } finally {
    if (seq === fetchSeq) loading.value = false;
  }
}

const tabs = computed(() =>
  CATEGORIES.map((c) => ({ id: c.id, label: t(c.labelKey) }))
);

function selectCategory(id) {
  selectedId.value = id;
}
watch(selectedId, (id) => loadCategory(id));

/* Search filters the already-fetched category rows client-side (instant
   while typing; the feed of one shelf is small). */
const visibleItems = computed(() => {
  const needle = searchQuery.value.trim().toLowerCase();
  if (!needle) return items.value;
  return items.value.filter(
    (m) =>
      m.name.toLowerCase().includes(needle) ||
      (m.description || '').toLowerCase().includes(needle)
  );
});

function fmtSize(n) {
  if (!n) return '';
  if (n >= 1048576) return `${(n / 1048576).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

/* Breadcrumb: Public Component > <category> (Plugin page convention). */
const breadcrumb = computed(() => {
  const sel = CATEGORIES.find((c) => c.id === selectedId.value);
  const catLabel = sel ? t(sel.labelKey) : '';
  return `${t('aerialview.subpage_public_component')} > ${catLabel}`;
});

onMounted(() => {
  // Register the <model-viewer> web component lazily: its weight only loads
  // when this page is actually visited.
  import('@google/model-viewer')
    .then(() => {
      viewerReady.value = true;
    })
    .catch(() => {
      viewerReady.value = false;
    });
  loadCategory(selectedId.value);
});

onUnmounted(() => {
  clear();
});
</script>

<template>
  <ViewComposer
    :right-items="[]"
    :show-flight="false"
    :show-camera="false"
    :show-hud="false"
    :flight="{ mode: '-', vx: 0, vy: 0, yaw: 0, vz: 0 }"
    :camera="{ mode: '-', yaw: 0, pitch: 0, roll: 0 }"
  >
    <template #background>
      <div class="pc-page">
        <!-- Category tabs: overflow collapses into the TabBar's » button -->
        <TabBar
          :model-value="selectedId"
          :tabs="tabs"
          @update:model-value="selectCategory"
        />

        <!-- Content area -->
        <div class="pc-content">
          <!-- Breadcrumb -->
          <div class="pc-breadcrumb">{{ breadcrumb }}</div>

          <!-- Search bar -->
          <div class="pc-search-bar">
            <svg class="pc-search-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              v-model="searchQuery"
              type="text"
              class="pc-search-input"
              :placeholder="t('publiccomponentview.search_placeholder')"
            />
          </div>

          <!-- Separator -->
          <div class="pc-separator" />

          <!-- Results: the published library, one card per public asset -->
          <LoadingSpinner v-if="loading && !items.length" />
          <p v-else-if="loadError" class="pc-empty">{{ t('publiccomponentview.error') }}</p>
          <p v-else-if="!visibleItems.length" class="pc-empty">{{ t('publiccomponentview.empty') }}</p>

          <div v-else class="pc-grid">
            <div v-for="m in visibleItems" :key="m.id" class="pc-card">
              <div class="pc-card__frame">
                <model-viewer
                  v-if="viewerReady"
                  :src="publicMeshFileUrl(m.id)"
                  class="pc-card__viewer"
                  camera-controls
                  auto-rotate
                  interaction-prompt="none"
                  exposure="1"
                  shadow-intensity="0.6"
                ></model-viewer>
                <LoadingSpinner v-else />
              </div>
              <div class="pc-card__body">
                <div class="pc-card__name">{{ m.name }}</div>
                <div v-if="m.description" class="pc-card__desc">{{ m.description }}</div>
                <div class="pc-card__meta">
                  <span v-if="m.owner_name">{{ m.owner_name }}</span>
                  <span v-if="m.owner_name && m.size_bytes">·</span>
                  <span v-if="m.size_bytes">{{ fmtSize(m.size_bytes) }}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </template>
  </ViewComposer>
</template>

<style scoped>
.pc-page {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  pointer-events: auto;
  background: #ffffff;
  user-select: none;
  z-index: 6;
  box-sizing: border-box;
}

/* ─── Content ─── */
.pc-content {
  flex: 1;
  min-height: 0;
  min-width: 0;
  padding: 8px 48px 32px;
  overflow-y: auto;
  background: #ffffff;
  display: flex;
  flex-direction: column;
}

.pc-breadcrumb {
  font-size: 0.8rem;
  font-weight: 500;
  color: #6e6e73;
  margin-bottom: 16px;
}

.pc-search-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-radius: 8px;
  border: 1px solid #d2d2d7;
  background: #f5f5f7;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}

.pc-search-bar:focus-within {
  border-color: #007aff;
  box-shadow: 0 0 0 3px rgba(0, 122, 255, 0.15);
  background: #ffffff;
}

.pc-search-icon {
  flex-shrink: 0;
  color: #6e6e73;
}

.pc-search-input {
  flex: 1;
  border: none;
  background: transparent;
  font-size: 0.875rem;
  color: #1d1d1f;
  outline: none;
}

.pc-search-input::placeholder {
  color: #8e8e93;
}

.pc-separator {
  height: 1px;
  background: #e5e5ea;
  margin-top: 16px;
  margin-bottom: 1.5em;
  flex-shrink: 0;
}

.pc-empty {
  padding: 24px 0;
  font-size: 0.9rem;
  color: #6e6e73;
}

/* ─── Results grid ─── */
.pc-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 20px;
}

.pc-card {
  border: 1px solid #e5e5ea;
  border-radius: 12px;
  overflow: hidden;
  background: #ffffff;
}

.pc-card__frame {
  aspect-ratio: 4 / 3;
  background: #f5f5f7;
  display: flex;
  align-items: center;
  justify-content: center;
}

.pc-card__viewer {
  width: 100%;
  height: 100%;
}

.pc-card__body {
  padding: 10px 12px 12px;
}

.pc-card__name {
  font-size: 0.95rem;
  font-weight: 700;
  color: #1d1d1f;
  overflow-wrap: anywhere;
}

.pc-card__desc {
  margin-top: 4px;
  font-size: 0.8rem;
  color: #1d1d1f;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.pc-card__meta {
  margin-top: 6px;
  display: flex;
  gap: 6px;
  font-size: 0.75rem;
  color: #6e6e73;
}
</style>
