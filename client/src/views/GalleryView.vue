<script setup>
import { useI18n } from 'vue-i18n';

// Gallery (展厅): placeholder page between Route Planning and Extensions
// in the left panel. Content will land here later.
const { t } = useI18n();
</script>

<template>
  <div class="gallery-page">
    <p class="gallery-placeholder">{{ t('galleryview.empty') }}</p>
  </div>
</template>

<style scoped>
.gallery-page {
  position: absolute;
  inset: 0;
  overflow-y: auto;
  pointer-events: auto;
  background: #ffffff;
  user-select: none;
}

.gallery-placeholder {
  padding: 48px;
  font-size: 0.9rem;
  color: #6e6e73;
}
</style>
