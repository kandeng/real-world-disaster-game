<script setup>
import AccountLoginPanel from '@/views/AccountLoginPanel.vue';

// 'account' | 'wallet' | 'content' — provided by the router. The shell's
// left panel owns the navigation; this page only renders the body:
// Account shows the login/register card, Wallet and Content are blank
// placeholder pages for now.
defineProps({
  sub: { type: String, default: 'account' },
});
</script>

<template>
  <div class="myspace-page">
    <AccountLoginPanel v-if="sub === 'account'" />
    <!-- wallet / content: intentionally blank -->
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
</style>
