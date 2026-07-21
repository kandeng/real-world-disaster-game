<script setup>
import { onMounted, onUnmounted, h } from 'vue';
import { useI18n } from 'vue-i18n';
import ViewComposer from '@shared/_ViewComposer.vue';
import { useDockRegistry } from '@shared-composables/useDockRegistry.js';
import { usePageRegistry } from '@shared-composables/usePageRegistry.js';
import DockMenuButton from '@shared/DockMenuButton.vue';

const { t } = useI18n();
const { leftItems, registerLeft, clear } = useDockRegistry();
const { pages, registerPage, unregisterPage } = usePageRegistry();

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
});

onUnmounted(() => {
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
      <div class="empty-page">
        <h1 class="empty-page__title">{{ t('aerialview.page_myspace') }}</h1>
      </div>
    </template>
  </ViewComposer>
</template>

<style scoped>
.empty-page {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: auto;
}

.empty-page__title {
  font-size: 1.5rem;
  font-weight: 600;
  color: rgba(255, 255, 255, 0.6);
  letter-spacing: 0.05em;
}
</style>
