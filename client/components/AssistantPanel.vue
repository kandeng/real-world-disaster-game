<script setup>
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import ConfigurableIcon from '@shared/ConfigurableIcon.vue';

const { t } = useI18n();

// Composer draft text only. Sending, streaming and every other piece of
// internal logic intentionally arrives in a later phase — the buttons are
// pure layout for now.
const draft = ref('');
</script>

<template>
  <div class="assistant">
    <!-- ── Header ── -->
    <header class="assistant__header">
      <span class="assistant__title">{{ t('assistantpanel.title') }}</span>
    </header>

    <!-- ── Message list: rendering / streaming lands here later ── -->
    <div class="assistant__messages" />

    <!-- ── Composer: [scan][folder] [multiline input] [send][stop] ── -->
    <div class="assistant__composer">
      <button
        class="assistant__btn"
        type="button"
        :title="t('assistantpanel.capture_viewer')"
        :aria-label="t('assistantpanel.capture_viewer')"
      >
        <ConfigurableIcon name="CHAT_CAPTURE" :size="18" />
      </button>
      <button
        class="assistant__btn"
        type="button"
        :title="t('assistantpanel.attach_folder')"
        :aria-label="t('assistantpanel.attach_folder')"
      >
        <ConfigurableIcon name="MENU_FILE_FOLDER" :size="18" />
      </button>

      <textarea
        v-model="draft"
        class="assistant__input"
        rows="3"
        :placeholder="t('assistantpanel.placeholder')"
      />

      <button
        class="assistant__btn assistant__btn--send"
        type="button"
        :title="t('assistantpanel.send')"
        :aria-label="t('assistantpanel.send')"
      >
        <ConfigurableIcon name="CHAT_SEND" :size="18" color="#fff" />
      </button>
      <button
        class="assistant__btn assistant__btn--stop"
        type="button"
        :title="t('assistantpanel.stop')"
        :aria-label="t('assistantpanel.stop')"
      >
        <ConfigurableIcon name="MENU_STOP" :size="18" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.assistant {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: #ffffff;
  box-sizing: border-box;
  pointer-events: auto;
}

.assistant__header {
  flex-shrink: 0;
  padding: 14px 16px;
  border-bottom: 1px solid #e5e5ea;
}

.assistant__title {
  font-size: 0.95rem;
  font-weight: 600;
  color: #111827;
}

.assistant__messages {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 16px;
}

.assistant__composer {
  flex-shrink: 0;
  display: flex;
  align-items: flex-end;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid #e5e5ea;
}

.assistant__btn {
  width: 36px;
  height: 36px;
  flex-shrink: 0;
  border-radius: 8px;
  border: 1.5px solid #374151;
  background: transparent;
  color: #111827;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  padding: 0;
}

.assistant__btn:hover {
  background: rgba(0, 0, 0, 0.06);
}

.assistant__btn--send {
  background: #007aff;
  border-color: #007aff;
}

.assistant__btn--send:hover {
  background: #0066d6;
}

.assistant__btn--stop {
  background: #d81e06;
  border-color: #d81e06;
}

.assistant__btn--stop:hover {
  background: #b31805;
}

/* stop.svg ships a fixed gray fill; force it white on the red button. */
.assistant__btn--stop :deep(path) {
  fill: #ffffff;
}

.assistant__input {
  flex: 1;
  min-width: 0;
  resize: none;
  border: 1px solid #d1d5db;
  border-radius: 8px;
  padding: 8px 10px;
  font: inherit;
  font-size: 0.9rem;
  line-height: 1.4;
  min-height: 64px;
  max-height: 160px;
  background: #ffffff;
  color: #111827;
  box-sizing: border-box;
}

.assistant__input:focus {
  outline: 2px solid rgba(0, 122, 255, 0.4);
  border-color: #007aff;
}
</style>
