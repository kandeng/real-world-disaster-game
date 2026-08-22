<script setup>
import { useI18n } from 'vue-i18n';

// Editable waypoint card list — same visual language as the
// Route Planning -> Route popup: slot index on the left, then a card
// with Position / Speed / Camera lines of inline-editable values.
// Inputs commit on blur or Enter; values are clamped like on the
// planning page and the committed change is emitted as
// { pos, field, value } so the owner of the array stays in control.
const props = defineProps({
  waypoints: { type: Array, required: true },
});
const emit = defineEmits(['edit']);

const { t } = useI18n();

function fmtCoord(v, digits = 4) {
  const n = Number(v);
  return isNaN(n) ? '' : n.toFixed(digits);
}

// Wrap an angle into (-180, 180].
function normAngle(v) {
  return ((((v + 180) % 360) + 360) % 360) - 180;
}

const SPEED_MAX_MPS = 100 / 3.6; // ±100 km/h in m/s

function onEdit(event, pos, field) {
  const wp = props.waypoints[pos];
  if (!wp) return;
  const digits = field.startsWith('cam') ? 2 : 4;
  let v = parseFloat(event.target.value);
  if (isNaN(v)) {
    event.target.value = fmtCoord(wp[field], digits);
    return;
  }
  if (field === 'lat') v = Math.max(-90, Math.min(90, v));
  else if (field === 'lng') v = Math.max(-180, Math.min(180, v));
  else if (field === 'alt') v = Math.max(0, Math.min(100000, v));
  else if (field === 'speed') v = Math.max(-SPEED_MAX_MPS, Math.min(SPEED_MAX_MPS, v));
  else if (field === 'camPitch') v = Math.max(-90, Math.min(90, v));
  else v = normAngle(v); // camYaw / camRoll
  event.target.value = fmtCoord(v, digits);
  emit('edit', { pos, field, value: v });
}
</script>

<template>
  <div class="wpcards">
    <div v-for="(wp, pos) in waypoints" :key="pos" class="wpcards__row">
      <span class="wpcards__idx">{{ pos + 1 }}</span>
      <div class="wpcards__card">
        <div class="wpcards__line">
          <span class="wpcards__label">{{ t('routeplanningview.position') }}</span>
          <span class="wpcards__unit">lat:</span>
          <input
            class="wpcards__coord wpcards__coord--lat"
            :value="fmtCoord(wp.lat)"
            @keyup.enter="$event.target.blur()"
            @change="onEdit($event, pos, 'lat')"
          />
          <span class="wpcards__sep">|</span>
          <span class="wpcards__unit">lon:</span>
          <input
            class="wpcards__coord"
            :value="fmtCoord(wp.lng)"
            @keyup.enter="$event.target.blur()"
            @change="onEdit($event, pos, 'lng')"
          />
          <span class="wpcards__sep">|</span>
          <span class="wpcards__unit">alt:</span>
          <input
            class="wpcards__coord wpcards__coord--alt"
            :value="fmtCoord(wp.alt)"
            @keyup.enter="$event.target.blur()"
            @change="onEdit($event, pos, 'alt')"
          />
        </div>
        <div class="wpcards__line">
          <span class="wpcards__label">{{ t('routeplanningview.speed') }}</span>
          <span class="wpcards__unit">v:</span>
          <input
            class="wpcards__coord"
            :value="fmtCoord(wp.speed)"
            @keyup.enter="$event.target.blur()"
            @change="onEdit($event, pos, 'speed')"
          />
        </div>
        <div class="wpcards__line">
          <span class="wpcards__label">{{ t('routeplanningview.camera') }}</span>
          <span class="wpcards__unit">yaw:</span>
          <input
            class="wpcards__coord wpcards__coord--ang"
            :value="fmtCoord(wp.camYaw, 2)"
            @keyup.enter="$event.target.blur()"
            @change="onEdit($event, pos, 'camYaw')"
          />
          <span class="wpcards__sep">|</span>
          <span class="wpcards__unit">pitch:</span>
          <input
            class="wpcards__coord wpcards__coord--pitch"
            :value="fmtCoord(wp.camPitch, 2)"
            @keyup.enter="$event.target.blur()"
            @change="onEdit($event, pos, 'camPitch')"
          />
          <span class="wpcards__sep">|</span>
          <span class="wpcards__unit">roll:</span>
          <input
            class="wpcards__coord wpcards__coord--ang"
            :value="fmtCoord(wp.camRoll, 2)"
            @keyup.enter="$event.target.blur()"
            @change="onEdit($event, pos, 'camRoll')"
          />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.wpcards {
  display: flex;
  flex-direction: column;
  gap: 6px;
  /* Same vertical breathing room above the cards (below the timestamp)
     as the actions row keeps below them. */
  margin-top: 18px;
}

.wpcards__row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.wpcards__idx {
  flex-shrink: 0;
  min-width: 22px;
  text-align: right;
  font-size: 0.85rem;
  color: rgba(30, 40, 60, 0.95);
}

.wpcards__card {
  flex: 1;
  min-width: 0;
  height: 78px;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 4px;
  padding: 0 12px;
  border: 1px solid rgba(37, 99, 235, 0.5);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.35);
  color: rgba(30, 40, 60, 0.95);
  font-size: 0.85rem;
}

.wpcards__line {
  height: 18px;
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 0.8rem;
  white-space: nowrap;
}

.wpcards__label {
  flex-shrink: 0;
  width: 62px;
  font-weight: 600;
  color: rgba(30, 40, 60, 0.8);
}

.wpcards__unit {
  flex-shrink: 0;
  color: rgba(30, 40, 60, 0.8);
}

.wpcards__sep {
  margin: 0 4px;
}

.wpcards__coord {
  width: 9ch;
  height: 18px;
  box-sizing: border-box;
  padding: 0;
  border: none;
  background: transparent;
  font: inherit;
  color: inherit;
  text-align: left;
}

.wpcards__coord--lat {
  width: 8ch; /* -90.0000 */
}

.wpcards__coord--alt {
  width: 11ch; /* 100000.0000 */
}

.wpcards__coord--ang {
  width: 7ch; /* -180.00 */
}

.wpcards__coord--pitch {
  width: 6ch; /* -90.00 */
}

.wpcards__coord:focus {
  outline: 1px solid rgba(37, 99, 235, 0.5);
  border-radius: 3px;
}
</style>
