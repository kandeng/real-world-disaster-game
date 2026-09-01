<script setup>
import { ref, computed, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import TabBar from '@shared/TabBar.vue';
import AccountLoginPanel from '@/views/AccountLoginPanel.vue';
import ContentRouteList from '@shared/ContentRouteList.vue';
import ContentVideoList from '@shared/ContentVideoList.vue';
import ContentMeshList from '@shared/ContentMeshList.vue';
import { useAuth } from '@shared-composables/useAuth.js';
import { useVideos } from '@shared-composables/useVideos.js';
import { useMeshes } from '@shared-composables/useMeshes.js';

// 'account' | 'content' — provided by the router. The shell's left panel
// owns the navigation; this page renders the body. Account carries three
// tabs (Login / Consumption / Income); Component carries four (3D Asset /
// Scene / Route / Video). The active tab is blue + underlined.
const props = defineProps({
  sub: { type: String, default: 'account' },
});

const { t } = useI18n();
const { isAuthenticated } = useAuth();
const { listVideos } = useVideos();
const { listMeshes } = useMeshes();

// Component opens on the Video tab, whose list fetches itself; fire the
// mesh list GET at the same time so BOTH tabs' data arrive within one
// network round-trip instead of waiting for the tab click (the two
// fetches run in parallel, halving the perceived wait).
onMounted(() => {
  if (props.sub === 'content' && isAuthenticated.value) {
    listVideos().catch(() => { /* ContentVideoList retries on open */ });
    listMeshes().catch(() => { /* ContentMeshList retries on open */ });
  }
});

/* 'login' | 'consumption' | 'income' */
const tab = ref('login');
const tabs = computed(() => [
  { id: 'login', label: t('authflow.acct_tab_login') },
  { id: 'consumption', label: t('authflow.acct_tab_consumption') },
  { id: 'income', label: t('authflow.acct_tab_income') },
]);

/* 'mesh' | 'scene' | 'route' | 'video' */
const contentTab = ref('video');
const contentTabs = computed(() => [
  { id: 'mesh', label: t('authflow.content_tab_mesh') },
  { id: 'scene', label: t('authflow.content_tab_scene') },
  { id: 'route', label: t('authflow.content_tab_route') },
  { id: 'video', label: t('authflow.content_tab_video') },
]);
</script>

<template>
  <div class="myspace-page">
    <template v-if="sub === 'account'">
      <TabBar v-model="tab" :tabs="tabs" />

      <AccountLoginPanel v-if="tab === 'login'" />
      <p v-else class="myspace-placeholder">{{ t('authflow.acct_tab_placeholder') }}</p>
    </template>
    <template v-else-if="sub === 'content'">
      <TabBar v-model="contentTab" :tabs="contentTabs" />

      <ContentMeshList v-if="contentTab === 'mesh'" />
      <p v-else-if="contentTab === 'scene'" class="myspace-placeholder">{{ t('authflow.acct_tab_placeholder') }}</p>
      <ContentRouteList v-else-if="contentTab === 'route'" />
      <ContentVideoList v-else-if="contentTab === 'video'" />
    </template>
  </div>
</template>

<style scoped>
.myspace-page {
  position: absolute;
  inset: 0;
  overflow-y: auto;
  pointer-events: auto;
  background: #ffffff;
  user-select: none;
}

.myspace-placeholder {
  padding: 48px;
  font-size: 0.9rem;
  color: #6e6e73;
}
</style>
