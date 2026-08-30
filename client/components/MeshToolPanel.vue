<script setup>
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';

const { t } = useI18n();

const props = defineProps({
  // 'mesh' (choose a GLB) | 'place' (2D lat/lon + heading + length) | 'steer' (3D fine-tune)
  mode: { type: String, default: '' },
  meshes: { type: Array, default: () => [] },
  // The reactive placement state from useMeshPlacement (mutated in place by the sliders).
  state: { type: Object, required: true },
});

const emit = defineEmits(['load']);

const placeFields = [
  { key: 'heading', min: 0, max: 360, step: 1, unit: '°', digits: 0 },
  { key: 'length', min: 0.1, max: 500, step: 0.1, unit: 'm', digits: 1 },
];
const steerFields = [
  { key: 'alt', min: -500, max: 500, step: 1, unit: 'm', digits: 0 },
  { key: 'heading', min: 0, max: 360, step: 1, unit: '°', digits: 0 },
  { key: 'pitch', min: -180, max: 180, step: 1, unit: '°', digits: 0 },
  { key: 'roll', min: -180, max: 180, step: 1, unit: '°', digits: 0 },
  { key: 'length', min: 0.1, max: 500, step: 0.1, unit: 'm', digits: 1 },
];

const fields = computed(() => {
  if (props.mode === 'place') return placeFields;
  if (props.mode === 'steer') return steerFields;
  return [];
});

const title = computed(() => {
  if (props.mode === 'mesh') return t('buildsceneview.panel_mesh');
  if (props.mode === 'place') return t('buildsceneview.panel_place');
  if (props.mode === 'steer') return t('buildsceneview.panel_steer');
  return '';
});
</script>

<template>
  <div v-if="mode" class="mesh-panel">
    <div class="mesh-panel__title">{{ title }}</div>

    <!-- Tool 1: choose a mesh to load -->
    <template v-if="mode === 'mesh'">
      <div
        v-for="m in meshes"
        :key="m.name"
        class="mesh-card"
        :class="{ 'mesh-card--active': state.meshUrl === m.url }"
        @click="emit('load', m.url, m.label)"
      >
        <div class="mesh-card__label">{{ m.label }}</div>
        <div class="mesh-card__name">{{ m.name }}</div>
      </div>
    </template>

    <!-- Tool 2 / 3: placement + fine-tune sliders -->
    <template v-else>
      <div v-if="mode === 'place'" class="mesh-panel__hint">
        {{ t('buildsceneview.hint_place') }}
      </div>
      <div v-if="state.lat != null" class="mesh-panel__pos">
        <span>{{ t('buildsceneview.field_lat') }} {{ state.lat.toFixed(6) }}</span>
        <span>{{ t('buildsceneview.field_lon') }} {{ state.lon.toFixed(6) }}</span>
      </div>
      <div v-for="f in fields" :key="f.key" class="mesh-panel__row">
        <div class="mesh-panel__label-row">
          <span class="mesh-panel__label">{{ t('buildsceneview.field_' + f.key) }}</span>
          <span class="mesh-panel__value">
            {{ Number(state[f.key]).toFixed(f.digits) }} {{ f.unit }}
          </span>
        </div>
        <input
          type="range"
          class="mesh-panel__slider"
          :min="f.min"
          :max="f.max"
          :step="f.step"
          :value="state[f.key]"
          @input="state[f.key] = Number($event.target.value)"
        />
      </div>
    </template>

    <div v-if="state.loading" class="mesh-panel__status">
      {{ t('buildsceneview.status_loading') }}
    </div>
    <div v-else-if="state.error" class="mesh-panel__status mesh-panel__status--error">
      {{ state.error }}
    </div>
  </div>
</template>

<style scoped>
.mesh-panel {
  position: fixed;
  top: 50%;
  right: 96px;
  transform: translateY(-50%);
  width: min(300px, 80vw);
  max-height: 72vh;
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

.mesh-panel__title {
  font-size: 0.95rem;
  font-weight: 700;
  color: rgba(30, 40, 60, 0.95);
  text-shadow: 0 1px 2px rgba(255, 255, 255, 0.5);
}

.mesh-panel__hint {
  font-size: 0.8rem;
  color: rgba(30, 40, 60, 0.75);
}

.mesh-panel__pos {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 0.78rem;
  color: rgba(30, 40, 60, 0.8);
  background: rgba(255, 255, 255, 0.4);
  border-radius: 8px;
  padding: 6px 10px;
}

.mesh-card {
  padding: 10px 12px;
  border-radius: 10px;
  border: 1.5px solid rgba(255, 255, 255, 0.6);
  background: rgba(255, 255, 255, 0.55);
  cursor: pointer;
  transition: background 0.15s ease, border-color 0.15s ease;
}

.mesh-card:hover {
  background: rgba(255, 255, 255, 0.75);
}

.mesh-card--active {
  border-color: #4ade80;
  background: rgba(255, 255, 255, 0.85);
}

.mesh-card__label {
  font-size: 0.9rem;
  font-weight: 600;
  color: rgba(30, 40, 60, 0.95);
}

.mesh-card__name {
  font-size: 0.72rem;
  color: rgba(30, 40, 60, 0.6);
}

.mesh-panel__row {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.mesh-panel__label-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.mesh-panel__label {
  font-size: 0.82rem;
  font-weight: 600;
  color: rgba(30, 40, 60, 0.9);
}

.mesh-panel__value {
  font-size: 0.78rem;
  color: rgba(30, 40, 60, 0.75);
  font-variant-numeric: tabular-nums;
}

.mesh-panel__slider {
  width: 100%;
  accent-color: #007aff;
}

.mesh-panel__status {
  font-size: 0.8rem;
  color: rgba(30, 40, 60, 0.75);
  background: rgba(255, 255, 255, 0.4);
  border-radius: 8px;
  padding: 6px 10px;
}

.mesh-panel__status--error {
  color: rgba(160, 40, 50, 0.95);
  background: rgba(255, 235, 235, 0.6);
}

@media (max-width: 768px) {
  .mesh-panel {
    right: 80px;
  }
}
</style>
