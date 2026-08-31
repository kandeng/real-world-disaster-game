<script setup>
import { computed, reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import ConfigurableIcon from '@shared/ConfigurableIcon.vue';

const { t } = useI18n();

/**
 * MeshToolPanel.vue — the floating pop-ups of the Build Scene right sidebar.
 *
 *   mode 'reset'    : "Clean Up the Assets" (only when assets exist) + the
 *                     "Go to New Location:" search box and its result list.
 *   mode 'finetune' : asset / mesh-library pickers, the five placement sliders,
 *                     the "More details" editable block and the Save button.
 *   mode 'asset'    : no pop-up at all — the 2D map itself is the tool
 *                     (blue dots + red balloon), just like waypoint picking.
 *
 * Slider edits mutate the reactive asset record in place (the parent watches
 * it and recomposes the Cesium model matrix); the details block edits a local
 * string mirror and only commits on Save.
 */
const props = defineProps({
  mode: { type: String, default: '' },
  // session.view.buildscene — the search query textbox binds straight in.
  ctx: { type: Object, default: () => ({}) },
  // All placed assets (session.scene.assets) and the selected one.
  assets: { type: Array, default: () => [] },
  asset: { type: Object, default: null },
  // Mesh library (GLBs under client/assets/mesh) + current template mesh.
  meshes: { type: Array, default: () => [] },
  templateMeshUrl: { type: String, default: '' },
  // Location search state, owned by the parent view.
  results: { type: Array, default: () => [] },
  searching: { type: Boolean, default: false },
  searchError: { type: String, default: '' },
  hasSearched: { type: Boolean, default: false },
});

const emit = defineEmits(['cleanup', 'search', 'pickResult', 'setTemplate', 'select', 'save', 'pickLocal']);

const sliders = [
  { key: 'alt', labelKey: 'ft_alt', min: -500, max: 500, step: 1, unit: 'm', digits: 0 },
  { key: 'length', labelKey: 'ft_length', min: 0.1, max: 500, step: 0.1, unit: 'm', digits: 1 },
  { key: 'heading', labelKey: 'ft_yaw', min: 0, max: 360, step: 1, unit: '°', digits: 0 },
  { key: 'pitch', labelKey: 'ft_pitch', min: -180, max: 180, step: 1, unit: '°', digits: 0 },
  { key: 'roll', labelKey: 'ft_roll', min: -180, max: 180, step: 1, unit: '°', digits: 0 },
];

const detailFields = [
  { key: 'lat', labelKey: 'd_lat', digits: 4 },
  { key: 'lon', labelKey: 'd_lon', digits: 4 },
  { key: 'alt', labelKey: 'ft_alt', digits: 1 },
  { key: 'length', labelKey: 'ft_length', digits: 1 },
  { key: 'heading', labelKey: 'ft_yaw', digits: 2 },
  { key: 'pitch', labelKey: 'ft_pitch', digits: 2 },
  { key: 'roll', labelKey: 'ft_roll', digits: 2 },
];

// ── Pop-up local UI state ─────────────────────────────────────────────────
// The file_folder button no longer toggles a local list: it asks the parent to
// open the OS file picker (emit 'pickLocal'). The archive button toggles the
// combined list: mesh library (bundled + uploaded) + placed assets.
const showAssets = ref(false);
const showDetails = ref(false);
const details = reactive({});

const hasAssets = computed(() => props.assets.length > 0);

function syncDetails() {
  const a = props.asset;
  detailFields.forEach((f) => {
    details[f.key] = a && a[f.key] != null ? Number(a[f.key]).toFixed(f.digits) : '';
  });
}

// Refresh the text lines when the selected asset changes or the block opens;
// NOT on every slider tick, so typing is never clobbered mid-keystroke.
watch(() => props.asset?.id ?? null, syncDetails);
watch(showDetails, (open) => { if (open) syncDetails(); });
watch(() => props.mode, (m) => {
  if (m !== 'finetune') {
    showAssets.value = false;
  }
});

function toggleAssets() {
  showAssets.value = !showAssets.value;
}

function onSliderInput(field, event) {
  if (!props.asset) return;
  props.asset[field] = Number(event.target.value);
}

function onSave() {
  if (!props.asset) return;
  const out = {};
  detailFields.forEach((f) => {
    const raw = String(details[f.key] ?? '').trim();
    const v = Number(raw);
    if (raw !== '' && Number.isFinite(v)) out[f.key] = v;
  });
  emit('save', out);
}

function onSubmit(event) {
  event.preventDefault();
  emit('search');
}

function nameOf(asset) {
  return asset?.meshName || `#${asset?.id ?? ''}`;
}
</script>

<template>
  <div v-if="mode === 'reset'" class="bs-panel">
    <!-- Only offered when the session actually carries placed assets -->
    <button v-if="hasAssets" type="button" class="bs-btn" @click="emit('cleanup')">
      {{ t('buildsceneview.reset_cleanup') }}
    </button>

    <div class="bs-title bs-title--spaced">{{ t('buildsceneview.reset_location') }}</div>
    <form class="bs-search" @submit.prevent="onSubmit">
      <input
        v-model="ctx.searchQuery"
        class="bs-input"
        type="text"
        :placeholder="t('buildsceneview.search_placeholder')"
      />
      <button type="submit" class="bs-icon-btn" :title="t('buildsceneview.search')">
        <ConfigurableIcon name="MENU_SEARCH" :size="18" color="rgba(30, 40, 60, 0.9)" />
      </button>
    </form>
    <ul v-if="results.length" class="bs-list">
      <li
        v-for="(poi, idx) in results"
        :key="poi.place_id || idx"
        class="bs-list__item"
        @click="emit('pickResult', poi)"
      >
        <span class="bs-list__name">{{ poi.name }}</span>
        <span v-if="poi.address" class="bs-list__address">{{ poi.address }}</span>
      </li>
    </ul>
    <div v-else-if="searchError" class="bs-error">{{ searchError }}</div>
    <div v-else-if="hasSearched && !searching" class="bs-hint">
      {{ t('buildsceneview.no_results') }}
    </div>
  </div>

  <div v-else-if="mode === 'finetune'" class="bs-panel">
    <div class="bs-title">{{ t('buildsceneview.ft_select') }}</div>
    <div class="bs-pickers">
      <button
        type="button"
        class="bs-icon-btn"
        :title="t('buildsceneview.ft_upload')"
        @click="emit('pickLocal')"
      >
        <ConfigurableIcon name="MENU_FILE_FOLDER" :size="18" color="rgba(30, 40, 60, 0.9)" />
      </button>
      <button
        type="button"
        class="bs-icon-btn"
        :class="{ 'bs-icon-btn--on': showAssets }"
        :title="t('buildsceneview.ft_assets')"
        @click="toggleAssets"
      >
        <ConfigurableIcon name="MENU_ARCHIVE" :size="18" color="rgba(30, 40, 60, 0.9)" />
      </button>
    </div>

    <!-- Combined picker: mesh library (bundled + uploaded from disk) first,
         then the already placed assets. -->
    <template v-if="showAssets">
      <div class="bs-sub">{{ t('buildsceneview.ft_library') }}</div>
      <ul class="bs-list">
        <li
          v-for="m in meshes"
          :key="m.name"
          class="bs-list__item"
          :class="{ 'bs-list__item--on': m.url === (asset ? asset.meshUrl : templateMeshUrl) }"
          @click="emit('setTemplate', m.url, m.label)"
        >
          <span class="bs-list__name">{{ m.label }}</span>
        </li>
      </ul>

      <div class="bs-sub">{{ t('buildsceneview.ft_assets') }}</div>
      <ul class="bs-list">
        <li v-if="!hasAssets" class="bs-hint">{{ t('buildsceneview.ft_no_assets') }}</li>
        <li
          v-for="a in assets"
          :key="a.id"
          class="bs-list__item"
          :class="{ 'bs-list__item--on': a.id === asset?.id }"
          @click="emit('select', a.id)"
        >
          <span class="bs-list__name">
            {{ nameOf(a) }}
            <span v-if="!a.meshChosen" class="bs-badge">{{ t('buildsceneview.ft_unspecified') }}</span>
          </span>
          <span class="bs-list__address">{{ a.lat.toFixed(4) }}, {{ a.lon.toFixed(4) }}</span>
        </li>
      </ul>
    </template>

    <div v-if="asset" class="bs-sub">
      {{ nameOf(asset) }}
      <span v-if="!asset.meshChosen" class="bs-badge">{{ t('buildsceneview.ft_unspecified') }}</span>
    </div>

    <div v-if="!asset" class="bs-hint">{{ t('buildsceneview.ft_pick_hint') }}</div>
    <template v-else>
      <div v-for="f in sliders" :key="f.key" class="bs-row">
        <div class="bs-row__head">
          <span class="bs-row__label">{{ t('buildsceneview.' + f.labelKey) }}</span>
          <span class="bs-row__value">{{ Number(asset[f.key]).toFixed(f.digits) }} {{ f.unit }}</span>
        </div>
        <input
          type="range"
          class="bs-slider"
          :min="f.min"
          :max="f.max"
          :step="f.step"
          :value="asset[f.key]"
          @input="onSliderInput(f.key, $event)"
        />
      </div>

      <div class="bs-row bs-row--toggle">
        <span class="bs-row__label">{{ t('buildsceneview.ft_details') }}</span>
        <button
          type="button"
          class="bs-icon-btn"
          :title="t('buildsceneview.ft_details')"
          @click="showDetails = !showDetails"
        >
          <ConfigurableIcon
            :name="showDetails ? 'MENU_UPWARD' : 'MENU_DOWNWARD'"
            :size="18"
            color="rgba(30, 40, 60, 0.9)"
          />
        </button>
      </div>

      <div v-if="showDetails" class="bs-details">
        <label v-for="f in detailFields" :key="f.key" class="bs-detail">
          <span class="bs-detail__label">{{ t('buildsceneview.' + f.labelKey) }}</span>
          <input v-model="details[f.key]" class="bs-detail__input" type="text" inputmode="decimal" />
        </label>
      </div>

      <button type="button" class="bs-btn bs-btn--spaced" @click="onSave">
        {{ t('buildsceneview.ft_save') }}
      </button>
    </template>
  </div>
</template>

<style scoped>
.bs-panel {
  position: fixed;
  top: 50%;
  right: 96px;
  transform: translateY(-50%);
  width: min(320px, 82vw);
  max-height: 76vh;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px 18px;
  border-radius: 18px;
  background: rgba(255, 255, 255, 0.18);
  backdrop-filter: blur(6px);
  border: 2px solid rgba(255, 255, 255, 0.45);
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.2), inset 0 0 20px rgba(255, 255, 255, 0.08);
  box-sizing: border-box;
  z-index: 50;
  pointer-events: auto;
}

.bs-title {
  font-size: 0.92rem;
  font-weight: 700;
  color: rgba(30, 40, 60, 0.95);
  text-shadow: 0 1px 2px rgba(255, 255, 255, 0.5);
}

.bs-title--spaced {
  margin-top: 6px;
}

.bs-sub {
  margin-top: -8px;
  font-size: 0.76rem;
  color: rgba(30, 40, 60, 0.8);
}

.bs-badge {
  margin-left: 6px;
  padding: 1px 6px;
  border-radius: 7px;
  background: rgba(220, 38, 38, 0.14);
  color: #b91c1c;
  font-size: 0.68rem;
  font-weight: 600;
}

.bs-btn {
  border: none;
  border-radius: 10px;
  padding: 9px 14px;
  background: #007aff;
  color: #ffffff;
  font-size: 0.88rem;
  font-weight: 600;
  cursor: pointer;
  transition: filter 0.15s ease;
}

.bs-btn:hover {
  filter: brightness(1.08);
}

.bs-btn--spaced {
  margin-top: 4px;
}

.bs-search {
  display: flex;
  align-items: center;
  gap: 8px;
}

.bs-input {
  flex: 1;
  min-width: 0;
  padding: 7px 10px;
  border-radius: 9px;
  border: 1.5px solid rgba(255, 255, 255, 0.6);
  background: rgba(255, 255, 255, 0.65);
  font-size: 0.84rem;
  color: rgba(20, 30, 45, 0.95);
  outline: none;
}

.bs-input:focus {
  border-color: #007aff;
  background: rgba(255, 255, 255, 0.9);
}

.bs-icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  flex-shrink: 0;
  border-radius: 9px;
  border: 1.5px solid rgba(255, 255, 255, 0.6);
  background: rgba(255, 255, 255, 0.55);
  cursor: pointer;
  transition: background 0.15s ease, border-color 0.15s ease;
}

.bs-icon-btn:hover {
  background: rgba(255, 255, 255, 0.8);
}

.bs-icon-btn--on {
  border-color: #007aff;
  background: rgba(255, 255, 255, 0.9);
}

.bs-pickers {
  display: flex;
  gap: 8px;
}

.bs-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 190px;
  overflow-y: auto;
}

.bs-list__item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 7px 10px;
  border-radius: 9px;
  border: 1.5px solid rgba(255, 255, 255, 0.55);
  background: rgba(255, 255, 255, 0.5);
  cursor: pointer;
}

.bs-list__item:hover {
  background: rgba(255, 255, 255, 0.75);
}

.bs-list__item--on {
  border-color: #007aff;
  background: rgba(255, 255, 255, 0.88);
}

.bs-list__name {
  font-size: 0.84rem;
  font-weight: 600;
  color: rgba(30, 40, 60, 0.95);
}

.bs-list__address {
  font-size: 0.72rem;
  color: rgba(30, 40, 60, 0.65);
}

.bs-hint,
.bs-error {
  font-size: 0.78rem;
  color: rgba(30, 40, 60, 0.8);
}

.bs-error {
  color: rgba(160, 40, 50, 0.95);
}

.bs-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.bs-row--toggle {
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
}

.bs-row__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
}

.bs-row__label {
  font-size: 0.82rem;
  font-weight: 700;
  color: rgba(30, 40, 60, 0.9);
}

.bs-row__value {
  font-size: 0.76rem;
  color: rgba(30, 40, 60, 0.75);
  font-variant-numeric: tabular-nums;
}

.bs-slider {
  width: 100%;
  accent-color: #007aff;
}

.bs-details {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.45);
  border: 1.5px solid rgba(255, 255, 255, 0.6);
}

.bs-detail {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 0.78rem;
  color: rgba(30, 40, 60, 0.9);
}

.bs-detail__label {
  font-weight: 600;
}

.bs-detail__input {
  width: 110px;
  padding: 4px 8px;
  border-radius: 7px;
  border: 1.5px solid rgba(255, 255, 255, 0.7);
  background: rgba(255, 255, 255, 0.85);
  font-size: 0.78rem;
  font-variant-numeric: tabular-nums;
  color: rgba(20, 30, 45, 0.95);
  outline: none;
  text-align: right;
}

.bs-detail__input:focus {
  border-color: #007aff;
}

@media (max-width: 768px) {
  .bs-panel {
    right: 80px;
  }
}
</style>
