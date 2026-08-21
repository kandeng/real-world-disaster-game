<script setup>
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
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
</script>

<template>
  <div class="myspace-page">
    <template v-if="sub === 'account'">
      <div class="myspace-tabs">
        <button
          class="myspace-tab"
          :class="{ 'myspace-tab--active': tab === 'login' }"
          @click="tab = 'login'"
        >
          {{ t('authflow.acct_tab_login') }}
        </button>
        <button
          class="myspace-tab"
          :class="{ 'myspace-tab--active': tab === 'consumption' }"
          @click="tab = 'consumption'"
        >
          {{ t('authflow.acct_tab_consumption') }}
        </button>
        <button
          class="myspace-tab"
          :class="{ 'myspace-tab--active': tab === 'income' }"
          @click="tab = 'income'"
        >
          {{ t('authflow.acct_tab_income') }}
        </button>
      </div>

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

.myspace-tabs {
  display: flex;
  gap: 64px;
  padding: 32px 48px 0;
}

.myspace-tab {
  border: none;
  background: none;
  padding: 0 2px 10px;
  font-size: 1.05rem;
  font-weight: 600;
  color: #111827;
  cursor: pointer;
  border-bottom: 2px solid transparent;
}

.myspace-tab:hover {
  color: #007aff;
}

.myspace-tab--active,
.myspace-tab--active:hover {
  color: #007aff;
  border-bottom-color: #007aff;
}

.myspace-placeholder {
  padding: 48px;
  font-size: 0.9rem;
  color: #6e6e73;
}
</style>
