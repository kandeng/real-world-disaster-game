<script setup>
import { useI18n } from 'vue-i18n';
import { useDrone } from '@shared-composables/useDrone.js';

const { drone, gimbal } = useDrone();
const { t } = useI18n();

defineProps({
  flight: {
    type: Object,
    default: () => ({ mode: '-', vx: 0, vy: 0, yaw: 0, vz: 0 }),
  },
  camera: {
    type: Object,
    default: () => ({ mode: '-', yaw: 0, pitch: 0, roll: 0 }),
  },
});

// Null-safe number formatting ('-' until the first frame of a category).
const fmt = (v, digits = 2) =>
  v === null || v === undefined || Number.isNaN(Number(v)) ? '-' : Number(v).toFixed(digits);
</script>

<template>
  <!-- Simulator (3D Aerial / 2D maps). -->
  <div class="telemetry">
    <div class="telemetry-row">
      <span class="telemetry-key">{{ t('hud.position') }}</span>
      <span class="telemetry-value">
        {{ t('hud.lat') }} {{ drone.lat.toFixed(4) }} | {{ t('hud.lon') }} {{ drone.lon.toFixed(4) }} | {{ t('hud.alt') }} {{ drone.alt.toFixed(4) }}
      </span>
    </div>
    <div class="telemetry-row">
      <span class="telemetry-key">{{ t('hud.speed') }}</span>
      <span class="telemetry-value">v: {{ drone.speed.toFixed(4) }}</span>
    </div>
    <div class="telemetry-row">
      <span class="telemetry-key">{{ t('hud.camera') }}</span>
      <span class="telemetry-value">
        {{ t('hud.yaw') }} {{ gimbal.yaw.toFixed(1) }} | {{ t('hud.pitch') }} {{ gimbal.pitch.toFixed(1) }} | {{ t('hud.roll') }} {{ gimbal.roll.toFixed(1) }}
      </span>
    </div>
  </div>
</template>

<style scoped>
.telemetry {
  position: absolute;
  bottom: 48px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 14px 20px;
  border-radius: 10px;
  background: rgba(0, 0, 0, 0.72);
  backdrop-filter: blur(6px);
  color: #4ade80;
  font-family: 'Courier New', Courier, monospace;
  font-size: 0.82rem;
  line-height: 1.4;
  pointer-events: none;
  z-index: 50;
}

.telemetry-row {
  display: flex;
  gap: 16px;
  white-space: nowrap;
}

.telemetry-key {
  width: 72px;
  flex-shrink: 0;
  font-weight: 700;
  color: #86efac;
}

.telemetry-value {
  flex: 1;
}

@media (max-width: 768px) {
  .telemetry {
    font-size: 0.7rem;
    padding: 10px 14px;
    bottom: 40px;
  }

  .telemetry-key {
    width: 60px;
  }
}
</style>
