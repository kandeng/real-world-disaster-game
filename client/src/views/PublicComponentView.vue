<script setup>
import { ref, computed, onUnmounted } from 'vue';
import { useI18n } from 'vue-i18n';
import ViewComposer from '@shared/_ViewComposer.vue';
import TabBar from '@shared/TabBar.vue';
import { useDockRegistry } from '@shared-composables/useDockRegistry.js';

const { t } = useI18n();
const { clear } = useDockRegistry();

/* ─── Public Component ───
   Plugin-style browsing layout (top category bar + breadcrumb + search +
   results), but for the shared public component library. Twelve categories;
   when they no longer fit the top bar, TabBar collapses the remainder into
   its "»" overflow button automatically. */

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

const tabs = computed(() =>
  CATEGORIES.map((c) => ({ id: c.id, label: t(c.labelKey) }))
);

function selectCategory(id) {
  selectedId.value = id;
}

/* Breadcrumb: Public Component > <category> (Plugin page convention). */
const breadcrumb = computed(() => {
  const sel = CATEGORIES.find((c) => c.id === selectedId.value);
  const catLabel = sel ? t(sel.labelKey) : '';
  return `${t('aerialview.subpage_public_component')} > ${catLabel}`;
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

          <!-- Results: the library is empty until publishing lands -->
          <p class="pc-empty">{{ t('publiccomponentview.empty') }}</p>
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
</style>
