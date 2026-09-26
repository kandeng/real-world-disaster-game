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
    <!-- ── Message list: rendering / streaming lands here later ── -->
    <div class="assistant__messages" />

    <!-- ── Composer: row 1 [stop][input][send], row 2 [screenshot][upload] ── -->
    <div class="assistant__composer">
      <div class="assistant__row">
        <button
          class="assistant__btn assistant__btn--stop"
          type="button"
          :title="t('assistantpanel.stop')"
          :aria-label="t('assistantpanel.stop')"
        >
          <ConfigurableIcon name="MENU_STOP" :size="18" />
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
      </div>

      <!-- Purely aesthetic hairline between the input row and the tool row. -->
      <div class="assistant__rowline" />

      <div class="assistant__row assistant__row--tools">
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
      </div>
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

.assistant__messages {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 16px;
}

.assistant__composer {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid #e5e5ea;
}

.assistant__row {
  display: flex;
  align-items: flex-end;
  gap: 8px;
}

/* Tool row sits under the textarea, indented past the Stop button. */
.assistant__row--tools {
  margin-left: 44px; /* 36px button + 8px gap */
}

/* Thin horizontal divider between the input row and the tool row. */
.assistant__rowline {
  height: 1px;
  background: #e5e5ea;
  flex-shrink: 0;
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
