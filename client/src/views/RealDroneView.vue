<script setup>
import { ref, computed, watch, h, onMounted, onUnmounted } from 'vue';
import ViewComposer from '@shared/_ViewComposer.vue';
import DockMenuButton from '@shared/DockMenuButton.vue';
import { useFlightCommands } from '@shared-composables/useFlightCommands.js';
import { useCameraCommands } from '@shared-composables/useCameraCommands.js';
import { useDockRegistry } from '@shared-composables/useDockRegistry.js';
import { usePageRegistry } from '@shared-composables/usePageRegistry.js';

// Real Drone (真机接入) page — UI shell only.
//
// Two subpages, switched via the left sidebar:
// - 'controller' (Remote Controller / 遥控): mirrors the 3D Aerial outlook —
//   HUD dashboard, Flight / Gimbal disks. All internal functionality is
//   intentionally empty — no video stream, no telemetry, no vehicle link.
// - 'list' (Drone list / 真机名单): mirrors the Customer Service outlook —
//   left/right panels split by a vertical draggable divider, content blank.

const {
  flight,
  showFlight,
  toggleFlight,
  onFlightMove,
  onFlightStop,
  onFlightModeChange,
} = useFlightCommands();

const {
  camera,
  showCamera,
  toggleCamera,
  onCameraMove,
  onCameraStop,
  onCameraModeChange,
} = useCameraCommands();

const { leftItems, rightItems, registerLeft, registerRight, clear } = useDockRegistry();
const { pages, registerPage, unregisterPage } = usePageRegistry();

// Active subpage of the Real Drone page: 'controller' (default) or 'list'.
const activeSubpage = ref('controller');
const isController = computed(() => activeSubpage.value === 'controller');

/* ─── Drone list: left-column width drag (same pattern as Customer Service) ─── */
const LEFT_MIN = 280;
const LEFT_MAX = 600;
const LEFT_DEFAULT = 40; // percentage
const leftWidthPct = ref(LEFT_DEFAULT);
const isDragging = ref(false);

function onDividerPointerDown(e) {
  e.preventDefault();
  isDragging.value = true;
  document.addEventListener('pointermove', onDividerPointerMove);
  document.addEventListener('pointerup', onDividerPointerUp);
}

function onDividerPointerMove(e) {
  if (!isDragging.value) return;
  const panel = document.querySelector('.drone-list-page');
  if (!panel) return;
  const rect = panel.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const pct = (x / rect.width) * 100;
  const minPct = (LEFT_MIN / rect.width) * 100;
  const maxPct = (LEFT_MAX / rect.width) * 100;
  leftWidthPct.value = Math.min(maxPct, Math.max(minPct, pct));
}

function onDividerPointerUp() {
  isDragging.value = false;
  document.removeEventListener('pointermove', onDividerPointerMove);
  document.removeEventListener('pointerup', onDividerPointerUp);
}

function hideAllDisks() {
  showFlight.value = false;
  showCamera.value = false;
}

// Placeholder for dock buttons whose functionality is not implemented yet.
function noop() {}

onMounted(() => {
  // Register pages for the router menu
  registerPage({ id: 'aerial', nameKey: 'aerialview.page_aerial', route: '/' });
  registerPage({ id: 'map', nameKey: 'aerialview.page_map', route: '/map' });
  registerPage({ id: 'realdrone', nameKey: 'aerialview.page_realdrone', route: '/real-drone' });
  registerPage({ id: 'myspace', nameKey: 'aerialview.page_myspace', route: '/myspace' });
  registerPage({ id: 'chat', nameKey: 'aerialview.page_chat', route: '/chat' });
  registerPage({ id: 'extensions', nameKey: 'aerialview.page_extensions', route: '/extensions' });
  registerPage({ id: 'settings', nameKey: 'aerialview.page_settings', route: '/settings' });

  registerLeft({
    id: 'router',
    render: () => h(DockMenuButton, {
      icon: 'MENU_ROUTER',
      titleKey: 'aerialview.pages',
      pages,
      onBeforeOpen: hideAllDisks,
    }),
  });
  registerLeft({
    id: 'camera',
    icon: 'MENU_CAMERA',
    titleKey: 'aerialview.camera',
    active: showCamera.value,
    onClick: toggleCamera,
  });
  registerLeft({
    id: 'subpage_controller',
    icon: 'MENU_REMOTE_CONTROLLER',
    titleKey: 'aerialview.subpage_remote_controller',
    active: activeSubpage.value === 'controller',
    onClick: () => {
      activeSubpage.value = 'controller';
    },
  });
  registerLeft({
    id: 'subpage_list',
    icon: 'MENU_DRONE_PLUS',
    titleKey: 'aerialview.subpage_drone_list',
    active: activeSubpage.value === 'list',
    onClick: () => {
      activeSubpage.value = 'list';
    },
  });

  registerRight({
    id: 'steer',
    icon: 'MENU_CONTROL_STICK',
    titleKey: 'aerialview.steer',
    active: showFlight.value,
    onClick: toggleFlight,
  });
  registerRight({
    id: 'takeoff',
    icon: 'MENU_TAKEOFF',
    titleKey: 'aerialview.takeoff',
    onClick: noop,
  });
  registerRight({
    id: 'screenshot',
    icon: 'MENU_PHOTO',
    titleKey: 'aerialview.screenshot',
    onClick: noop,
  });
  registerRight({
    id: 'recorder',
    icon: 'MENU_RECORDER',
    titleKey: 'aerialview.recorder',
    active: false,
    danger: true,
    onClick: noop,
  });

  // Sync dock button active states with toggle state
  watch(showFlight, (val) => {
    const item = rightItems.find((i) => i.id === 'steer');
    if (item) item.active = val;
  });
  watch(showCamera, (val) => {
    const item = leftItems.find((i) => i.id === 'camera');
    if (item) item.active = val;
  });

  // Keep the subpage selector buttons in sync with the active subpage.
  watch(activeSubpage, (val) => {
    const controllerBtn = leftItems.find((i) => i.id === 'subpage_controller');
    if (controllerBtn) controllerBtn.active = val === 'controller';
    const listBtn = leftItems.find((i) => i.id === 'subpage_list');
    if (listBtn) listBtn.active = val === 'list';
  });
});

onUnmounted(() => {
  onDividerPointerUp();
  clear();
  unregisterPage('aerial');
  unregisterPage('realdrone');
  unregisterPage('map');
  unregisterPage('myspace');
  unregisterPage('chat');
  unregisterPage('extensions');
  unregisterPage('settings');
});
</script>

<template>
  <ViewComposer
    :left-items="leftItems"
    :right-items="rightItems"
    :show-flight="isController && showFlight"
    :show-camera="isController && showCamera"
    :show-hud="isController"
    :flight="flight"
    :camera="camera"
    @flightMove="onFlightMove"
    @flightStop="onFlightStop"
    @flightModeChange="onFlightModeChange"
    @cameraMove="onCameraMove"
    @cameraStop="onCameraStop"
    @cameraModeChange="onCameraModeChange"
  >
    <template #background>
      <!-- Drone list subpage: two blank panels with a draggable divider -->
      <div v-if="activeSubpage === 'list'" class="drone-list-page">
        <!-- Left panel -->
        <aside
          class="drone-list-sidebar"
          :style="{ flexBasis: leftWidthPct + '%' }"
        />

        <!-- Divider (draggable) -->
        <div
          class="drone-list-divider"
          @pointerdown="onDividerPointerDown"
        />

        <!-- Right content area -->
        <main class="drone-list-content" />
      </div>
    </template>
  </ViewComposer>
</template>

<style scoped>
.drone-list-page {
  position: absolute;
  inset: 0;
  display: flex;
  pointer-events: auto;
  background: #ffffff;
  user-select: none;
  z-index: 6;
}

/* ─── Left panel ─── */
.drone-list-sidebar {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  background: #f5f5f7;
  overflow-y: auto;
}

/* ─── Divider ─── */
.drone-list-divider {
  width: 4px;
  flex-shrink: 0;
  background: #e5e5ea;
  cursor: col-resize;
  transition: background 0.15s ease;
}

.drone-list-divider:hover,
.drone-list-divider:active {
  background: #007aff;
}

/* ─── Right content area ─── */
.drone-list-content {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: #ffffff;
  overflow: hidden;
}
</style>
