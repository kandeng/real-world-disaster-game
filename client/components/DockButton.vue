<script setup>
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import ConfigurableIcon from "./ConfigurableIcon.vue";

const props = defineProps({
  icon: { type: String, required: true },
  title: { type: String, default: "" },
  titleKey: { type: String, default: "" },
  active: { type: Boolean, default: false },
  danger: { type: Boolean, default: false },
  disabled: { type: Boolean, default: false },
  size: { type: Number, default: 32 },
});

const emit = defineEmits(["click"]);
const { t } = useI18n();

const resolvedTitle = computed(() => {
  if (props.titleKey) return t(props.titleKey);
  return props.title;
});

function handleClick() {
  if (props.disabled) return;
  emit("click");
}
</script>

<template>
  <button
    class="dock-btn"
    :class="{ 'dock-btn--active': active, 'dock-btn--danger': danger }"
    :title="resolvedTitle"
    :disabled="disabled"
    @click="handleClick"
  >
    <ConfigurableIcon :name="icon" :size="size" />
  </button>
</template>

<style scoped>
.dock-btn {
  width: 56px;
  height: 56px;
  /* border-box: the thick border grows INWARD so the button keeps its exact
     56px footprint inside the 72px dock. */
  box-sizing: border-box;
  border-radius: 12px;
  /* The stroke is 4px in BOTH states (idle used to be 2px): the faint thin
     outline vanished against bright satellite imagery, and a border that
     thickens on activation also nudges the icon. It is also always the SAME
     COLOUR as the icon: currentColor tracks `color`, the single property the
     state rules below recolour (idle slate, active green, danger red). */
  border: 4px solid currentColor;
  background: rgba(255, 255, 255, 1);
  backdrop-filter: blur(8px);
  color: rgba(55, 65, 81, 0.9);
  opacity: 0.5;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: opacity 0.15s ease, background 0.15s ease, transform 0.1s ease,
    border-color 0.15s ease, color 0.15s ease;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.08);
}

.dock-btn:hover {
  opacity: 0.7;
}

/* A state change recolours `color` ONLY — it drives both the icon (every dock
   SVG must use fill="currentColor"; plan.svg was hardcoded to #515151, so it
   stayed grey while steer.svg turned green) and the border (currentColor).
   The 4px stroke width never changes. */
.dock-btn--active {
  color: #4ade80;
}

.dock-btn--active.dock-btn--danger {
  color: #ef4444;
}

.dock-btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.dock-btn:active:not(:disabled) {
  transform: scale(0.96);
}

@media (max-width: 768px) {
  .dock-btn {
    width: 48px;
    height: 48px;
  }
}
</style>
