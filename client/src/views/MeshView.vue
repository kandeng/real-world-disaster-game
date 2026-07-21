<script setup>
import { ref, onMounted, onUnmounted, h } from 'vue';
import { useI18n } from 'vue-i18n';
import ViewComposer from '@shared/_ViewComposer.vue';
import { useDockRegistry } from '@shared-composables/useDockRegistry.js';
import { usePageRegistry } from '@shared-composables/usePageRegistry.js';
import DockMenuButton from '@shared/DockMenuButton.vue';

const { t } = useI18n();
const { leftItems, registerLeft, clear } = useDockRegistry();
const { pages, registerPage, unregisterPage } = usePageRegistry();

const loadingMessage = ref('Loading OSM Buildings…');

let osmBuildingsTileset = null;
let savedGoogleTileset = null;

async function initMeshView() {
  const viewer = window.cesiumViewer;
  if (!viewer) {
    loadingMessage.value = 'Cesium viewer unavailable.';
    return;
  }

  // Save reference to Google tileset so we can restore it on unmount
  savedGoogleTileset = window.getGoogleTileset ? window.getGoogleTileset() : null;

  // Remove Google Photorealistic tileset
  if (savedGoogleTileset) {
    viewer.scene.primitives.remove(savedGoogleTileset);
    console.log('[MeshView] Removed Google tileset.');
  }

  // Re-enable globe for OSM Buildings context
  viewer.scene.globe.show = true;

  // Load Cesium World Terrain for elevation
  try {
    const terrain = await Cesium.createWorldTerrainAsync();
    viewer.terrainProvider = terrain;
    console.log('[MeshView] World Terrain loaded.');
  } catch (e) {
    console.warn('[MeshView] World Terrain failed:', e);
  }

  // Load OSM Buildings 3D Tiles (requires valid Cesium Ion token)
  try {
    osmBuildingsTileset = await Cesium.createOsmBuildingsAsync();
    viewer.scene.primitives.add(osmBuildingsTileset);
    console.log('[MeshView] OSM Buildings loaded.');
  } catch (e) {
    console.warn('[MeshView] OSM Buildings failed:', e);
    // Clear the entire scene — show white page with error
    viewer.scene.globe.show = false;
    viewer.scene.primitives.removeAll();
    viewer.terrainProvider = new Cesium.EllipsoidTerrainProvider();
    loadingMessage.value = 'Failed to load OSM Buildings. Check Cesium Ion token.';
    return;
  }

  // Fly camera to Manhattan, NYC
  // Use a delay to ensure AerialView's animation loop has fully stopped
  // (it cancels on unmount, but there may be a race during view transition)
  setTimeout(() => {
    // Cancel any in-progress camera flight first
    viewer.camera.cancelFlight();

    // Set camera instantly to Manhattan
    viewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(-73.9857, 40.7484, 1500),
      orientation: {
        heading: Cesium.Math.toRadians(0),
        pitch: Cesium.Math.toRadians(-45),
        roll: 0,
      },
    });
    console.log('[MeshView] Camera set to Manhattan.');
  }, 500);

  loadingMessage.value = '';
}

onMounted(() => {
  registerPage({ id: 'aerial', nameKey: 'aerialview.page_aerial', route: '/' });
  registerPage({ id: 'mesh', nameKey: 'aerialview.page_mesh', route: '/mesh' });
  registerPage({ id: '3dgs', nameKey: 'aerialview.page_3dgs' });
  registerPage({ id: 'map', nameKey: 'aerialview.page_map', route: '/map' });
  registerPage({ id: 'satellite', nameKey: 'aerialview.page_satellite', route: '/satellite' });
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
    }),
  });

  initMeshView();
});

onUnmounted(() => {
  // Restore Google Photorealistic tileset
  const viewer = window.cesiumViewer;
  if (viewer) {
    // Remove OSM Buildings
    if (osmBuildingsTileset) {
      viewer.scene.primitives.remove(osmBuildingsTileset);
      osmBuildingsTileset = null;
    }
    // Restore Google tileset
    if (savedGoogleTileset) {
      viewer.scene.primitives.add(savedGoogleTileset);
    }
    // Re-hide globe (matching AerialView default)
    viewer.scene.globe.show = false;
  }

  clear();
  unregisterPage('aerial');
  unregisterPage('mesh');
  unregisterPage('3dgs');
  unregisterPage('map');
  unregisterPage('satellite');
  unregisterPage('myspace');
  unregisterPage('chat');
  unregisterPage('extensions');
  unregisterPage('settings');
});
</script>

<template>
  <ViewComposer
    :left-items="leftItems"
    :right-items="[]"
    :show-flight="false"
    :show-camera="false"
    :flight="{ mode: '-', vx: 0, vy: 0, yaw: 0, vz: 0 }"
    :camera="{ mode: '-', yaw: 0, pitch: 0, roll: 0 }"
  >
    <template #background>
      <div class="mesh-overlay" v-if="loadingMessage">
        <p class="mesh-overlay__message">{{ loadingMessage }}</p>
      </div>
    </template>
  </ViewComposer>
</template>

<style scoped>
.mesh-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
}

.mesh-overlay__message {
  font-size: 1.25rem;
  font-weight: 600;
  color: #c0392b;
  letter-spacing: 0.05em;
  background: rgba(255, 255, 255, 0.9);
  padding: 16px 24px;
  border-radius: 8px;
}
</style>
