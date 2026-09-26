<script setup>
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';

const { t } = useI18n();

// Pen glyphs on a 20×20 grid; strokes follow currentColor so the active
// tool highlight recolors them for free.
const TOOLS = [
  { id: 'arrow', path: 'M3 10 H16 M16 10 L11 5.5 M16 10 L11 14.5', titleKey: 'tool_arrow' },
  { id: 'rect', path: 'M4 4 H16 V16 H4 Z', titleKey: 'tool_rect' },
  { id: 'curve', path: 'M3 13 C6 3, 8 17, 11 9 C13 4, 15 6, 17 8', titleKey: 'tool_curve' },
  { id: 'text', path: 'M5 5 H15 M10 5 V16', titleKey: 'tool_text' },
];

// Layout-only state for now: which pen is armed and the ink colour.
// The mark canvas / stroke model arrives in a later phase, so markCount
// stays 0 (clear stays disabled) until then.
const tool = ref(null);
const inkColor = ref('#ff3b30');
const markCount = ref(0);

function toggleTool(id) {
  tool.value = tool.value === id ? null : id;
}

function clearMarks() {
  markCount.value = 0;
}

function disarm() {
  tool.value = null;
}
</script>

<template>
  <div class="pens">
    <button
      v-for="tl in TOOLS"
      :key="tl.id"
      type="button"
      class="pens__btn"
      :class="{ 'pens__btn--on': tool === tl.id }"
      :title="t('pentoolbox.' + tl.titleKey)"
      :aria-label="t('pentoolbox.' + tl.titleKey)"
      @click="toggleTool(tl.id)"
    >
      <svg
        class="pens__pic"
        viewBox="0 0 20 20"
        fill="none"
        stroke="currentColor"
        stroke-width="1.9"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      ><path :d="tl.path" /></svg>
    </button>

    <input
      v-model="inkColor"
      type="color"
      class="pens__color"
      :title="t('pentoolbox.ink_colour')"
      :aria-label="t('pentoolbox.ink_colour')"
    />

    <span class="pens__sep" aria-hidden="true" />

    <!-- Clear every mark (disabled while nothing is drawn) -->
    <button
      type="button"
      class="pens__btn"
      :disabled="!markCount"
      :title="t('pentoolbox.clear')"
      :aria-label="t('pentoolbox.clear')"
      @click="clearMarks"
    >
      <svg
        class="pens__pic"
        viewBox="0 0 20 20"
        fill="none"
        stroke="currentColor"
        stroke-width="1.9"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      ><circle cx="10" cy="10" r="7.3" /><path d="M7.6 7.6 L12.4 12.4 M12.4 7.6 L7.6 12.4" /></svg>
    </button>

    <!-- Put the pens away (disabled while no pen is armed) -->
    <button
      type="button"
      class="pens__btn"
      :class="{ 'pens__btn--on': !!tool }"
      :disabled="!tool"
      :title="t('pentoolbox.disarm')"
      :aria-label="t('pentoolbox.disarm')"
      @click="disarm"
    >
      <svg
        class="pens__pic"
        viewBox="0 0 20 20"
        fill="none"
        stroke="currentColor"
        stroke-width="1.9"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      ><path d="M10.22 4.22 A6.6 6.6 0 1 1 4.22 10.22" /><path d="M7.3 4.6 H4.6 V7.3" /><path d="M4.6 4.6 L10.4 10.4" /></svg>
    </button>
  </div>
</template>

<style scoped>
.pens {
  position: absolute;
  bottom: 12px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 6;
  display: flex;
  align-items: center;
  gap: 3px;
  background: rgba(255, 255, 255, 0.92);
  border: 1px solid #e5e5ea;
  border-radius: 8px;
  padding: 4px 6px;
  pointer-events: auto;
}

.pens__btn {
  width: 26px;
  height: 24px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: #6b7280;
  cursor: pointer;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.pens__pic {
  width: 18px;
  height: 18px;
  display: block;
}

.pens__btn:hover {
  background: rgba(0, 0, 0, 0.06);
}

.pens__btn--on {
  border-color: #007aff;
  color: #111827;
  background: rgba(0, 122, 255, 0.12);
}

.pens__btn:disabled {
  opacity: 0.35;
  cursor: default;
}

.pens__btn:disabled:hover {
  background: transparent;
}

.pens__sep {
  width: 1px;
  height: 16px;
  background: #e5e5ea;
  margin: 0 2px;
}

/* The visible swatch is the content box (12×12) so the solid block does
   not outweigh the outline glyphs beside it; the 26×24 box stays the
   click target. */
.pens__color {
  width: 26px;
  height: 24px;
  padding: 6px 7px;
  border: none;
  background: transparent;
  cursor: pointer;
}

.pens__color::-webkit-color-swatch-wrapper {
  padding: 0;
}

.pens__color::-webkit-color-swatch {
  border: none;
  border-radius: 2px;
}

.pens__color::-moz-color-swatch {
  border: none;
  border-radius: 2px;
}
</style>
