<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue';

// Shared horizontal tab bar (Account / Extensions). Active tab is blue with
// a blue underline. When the tabs no longer fit the available width, the
// ones that overflow collapse into a "»" button at the right end of the bar
// which opens a vertical menu — the standard toolbar overflow pattern.
const props = defineProps({
  /* [{ id: String, label: String }] */
  tabs: { type: Array, required: true },
  /* active tab id */
  modelValue: { type: String, required: true },
});
const emit = defineEmits(['update:modelValue']);

const GAP = 64; // must match .tab-bar { gap: 64px }
const MORE_W = 32; // reserved width for the » button

const wrapRef = ref(null);
const moreWrapRef = ref(null);
const measureEls = ref({});
const visibleCount = ref(props.tabs.length);
const menuOpen = ref(false);

function setMeasureEl(id) {
  return (el) => {
    if (el) measureEls.value[id] = el;
  };
}

const overflow = computed(() => visibleCount.value < props.tabs.length);
const visibleTabs = computed(() => props.tabs.slice(0, visibleCount.value));
const hiddenTabs = computed(() => props.tabs.slice(visibleCount.value));

/* ─── Fit computation ─── */
// Widths are read from a hidden measurement row that always renders every
// tab, so resizing works even while some tabs are collapsed.
function layout() {
  const wrap = wrapRef.value;
  if (!wrap) return;
  const containerW = wrap.clientWidth;
  const widths = props.tabs.map((tb) => measureEls.value[tb.id]?.offsetWidth ?? 0);
  const total = widths.reduce((a, b) => a + b, 0) + GAP * (props.tabs.length - 1);
  if (total <= containerW) {
    visibleCount.value = props.tabs.length;
    return;
  }
  const avail = containerW - MORE_W - GAP;
  let used = 0;
  let count = 0;
  for (let i = 0; i < widths.length; i++) {
    const add = widths[i] + (count ? GAP : 0);
    if (used + add > avail) break;
    used += add;
    count++;
  }
  visibleCount.value = Math.max(1, count);
}

let ro = null;
onMounted(() => {
  nextTick(layout);
  ro = new ResizeObserver(() => layout());
  if (wrapRef.value) ro.observe(wrapRef.value);
});
onBeforeUnmount(() => {
  if (ro) ro.disconnect();
});

watch(() => props.tabs, () => nextTick(layout), { deep: true });

/* ─── Selection ─── */
function select(id) {
  emit('update:modelValue', id);
  menuOpen.value = false;
}

/* ─── Overflow menu open/close ─── */
function toggleMenu() {
  menuOpen.value = !menuOpen.value;
}

function onDocumentPointerDown(e) {
  if (moreWrapRef.value && !moreWrapRef.value.contains(e.target)) {
    menuOpen.value = false;
  }
}

watch(menuOpen, (open) => {
  if (open) document.addEventListener('pointerdown', onDocumentPointerDown);
  else document.removeEventListener('pointerdown', onDocumentPointerDown);
});
</script>

<template>
  <div ref="wrapRef" class="tab-bar-wrap">
    <!-- Hidden measurement row (always renders every tab) -->
    <div class="tab-bar tab-bar--measure" aria-hidden="true">
      <button
        v-for="tb in tabs"
        :ref="setMeasureEl(tb.id)"
        class="tab-bar__tab"
        tabindex="-1"
      >
        {{ tb.label }}
      </button>
    </div>

    <!-- Visible row -->
    <div class="tab-bar">
      <button
        v-for="tb in visibleTabs"
        :key="tb.id"
        class="tab-bar__tab"
        :class="{ 'tab-bar__tab--active': modelValue === tb.id }"
        @click="select(tb.id)"
      >
        {{ tb.label }}
      </button>

      <div v-if="overflow" ref="moreWrapRef" class="tab-bar__more-wrap">
        <button
          class="tab-bar__more"
          :aria-label="'More tabs'"
          @click="toggleMenu"
        >
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="6 5 13 12 6 19" />
            <polyline points="13 5 20 12 13 19" />
          </svg>
        </button>
        <div v-if="menuOpen" class="tab-bar__menu">
          <button
            v-for="tb in hiddenTabs"
            :key="tb.id"
            class="tab-bar__menu-item"
            :class="{ 'tab-bar__menu-item--active': modelValue === tb.id }"
            @click="select(tb.id)"
          >
            {{ tb.label }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tab-bar-wrap {
  position: relative;
  padding: 32px 48px 0;
}

.tab-bar {
  display: flex;
  align-items: flex-end;
  gap: 64px;
}

/* Measurement row: same styles, invisible, out of flow */
.tab-bar--measure {
  position: absolute;
  top: 0;
  left: 48px;
  visibility: hidden;
  pointer-events: none;
}

.tab-bar__tab {
  border: none;
  background: none;
  padding: 0 2px 10px;
  font-size: 1.05rem;
  font-weight: 600;
  color: #111827;
  cursor: pointer;
  border-bottom: 2px solid transparent;
  white-space: nowrap;
}

.tab-bar__tab:hover {
  color: #007aff;
}

.tab-bar__tab--active,
.tab-bar__tab--active:hover {
  color: #007aff;
  border-bottom-color: #007aff;
}

/* » button pinned to the right end of the bar */
.tab-bar__more-wrap {
  position: relative;
  margin-left: auto;
}

.tab-bar__more {
  border: none;
  background: none;
  padding: 0 2px 10px;
  color: #6e6e73;
  cursor: pointer;
  display: flex;
  align-items: center;
}

.tab-bar__more:hover {
  color: #007aff;
}

/* Vertical dropdown with the collapsed tabs */
.tab-bar__menu {
  position: absolute;
  right: 0;
  top: calc(100% + 4px);
  min-width: 160px;
  display: flex;
  flex-direction: column;
  padding: 6px;
  background: #ffffff;
  border: 1px solid #e5e5ea;
  border-radius: 8px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.08);
  z-index: 20;
}

.tab-bar__menu-item {
  text-align: left;
  border: none;
  background: none;
  padding: 8px 12px;
  font-size: 0.9rem;
  font-weight: 500;
  color: #1d1d1f;
  cursor: pointer;
  border-radius: 6px;
  white-space: nowrap;
}

.tab-bar__menu-item:hover {
  background: #f5f5f7;
}

.tab-bar__menu-item--active {
  color: #007aff;
}
</style>
