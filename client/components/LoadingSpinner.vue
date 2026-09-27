<script setup>
// The app-wide "please wait" rotating wheel while page data loads.
// Every page that waits for data must use THIS component so the wheel
// always looks the same (blue ring on the page's white background,
// 0.9 s linear spin).
</script>

<template>
  <div class="loading-spinner" role="status" aria-busy="true">
    <div class="loading-spinner__ring"></div>
  </div>
</template>

<style scoped>
.loading-spinner {
  display: flex;
  justify-content: center;
  padding: 72px 0;
}

.loading-spinner__ring {
  width: 44px;
  height: 44px;
  border-radius: 50%;
  border: 4px solid #e5e5ea;
  border-top-color: #007aff;
  animation: loading-spinner-spin 0.9s linear infinite;
}

@keyframes loading-spinner-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
