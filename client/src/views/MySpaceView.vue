<script setup>
import { ref, computed } from 'vue';
import { useI18n } from 'vue-i18n';
import TabBar from '@shared/TabBar.vue';
import AccountLoginPanel from '@/views/AccountLoginPanel.vue';

// 'account' | 'content' — provided by the router. The shell's left panel
// owns the navigation; this page renders the body. Account carries three
// tabs (Login / Consumption / Income); the active one is blue + underlined.
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
</script>

<template>
  <div class="myspace-page">
    <template v-if="sub === 'account'">
      <TabBar v-model="tab" :tabs="tabs" />

      <AccountLoginPanel v-if="tab === 'login'" />
      <p v-else class="myspace-placeholder">{{ t('authflow.acct_tab_placeholder') }}</p>
    </template>
    <!-- content: intentionally blank -->
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
