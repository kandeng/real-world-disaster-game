<script setup>
import { ref, computed } from 'vue';
import { useI18n } from 'vue-i18n';
import TabBar from '@shared/TabBar.vue';
import AccountLoginPanel from '@/views/AccountLoginPanel.vue';
import ContentRouteList from '@shared/ContentRouteList.vue';
import ContentVideoList from '@shared/ContentVideoList.vue';

// 'account' | 'content' — provided by the router. The shell's left panel
// owns the navigation; this page renders the body. Account carries three
// tabs (Login / Consumption / Income); Content carries two (Route / Video).
// The active tab is blue + underlined.
defineProps({
  sub: { type: String, default: 'account' },
});

const { t } = useI18n();

/* 'login' | 'consumption' | 'income' */
const tab = ref('login');
const tabs = computed(() => [
  { id: 'login', label: t('authflow.acct_tab_login') },
  { id: 'consumption', label: t('authflow.acct_tab_consumption') },
  { id: 'income', label: t('authflow.acct_tab_income') },
]);

/* 'route' | 'video' */
const contentTab = ref('route');
const contentTabs = computed(() => [
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

      <ContentRouteList v-if="contentTab === 'route'" />
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
