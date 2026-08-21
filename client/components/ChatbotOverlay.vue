<script setup>
import { nextTick, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useAuth } from '@shared-composables/useAuth.js';
import ConfigurableIcon from '@shared/ConfigurableIcon.vue';

const { t } = useI18n();
const { user } = useAuth();

/* ─── Conversation state (layout stage: local only, no backend yet) ─── */
// The assistant opens the conversation with the tutorial-video card.
const messages = ref([{ role: 'ai', kind: 'video', text: '' }]);
const text = ref('');
const pendingFile = ref(null);

const listRef = ref(null);
const fileInput = ref(null);

function scrollBottom() {
  const el = listRef.value;
  if (el) el.scrollTop = el.scrollHeight;
}

onMounted(scrollBottom);

function openFilePicker() {
  fileInput.value?.click();
}

function onFileChange(e) {
  const f = e.target.files && e.target.files[0];
  pendingFile.value = f ? f.name : null;
  // Allow re-selecting the same file after removing the chip.
  e.target.value = '';
}

function send() {
  const body = text.value.trim();
  if (!body && !pendingFile.value) return;
  messages.value.push({ role: 'user', kind: 'text', text: body, fileName: pendingFile.value });
  text.value = '';
  pendingFile.value = null;
  nextTick(scrollBottom);
}
</script>

<template>
  <!-- Semi-transparent layer, same recipe as the Flight disk inner circle
       (rgba(255,255,255,0.55) + blur(6px)): the page below is barely
       visible while the dialog stays crisp. -->
  <div class="chatbot-layer">
    <section class="chatbot-dialog">
      <!-- Messages -->
      <div ref="listRef" class="chatbot-messages">
        <div
          v-for="(m, i) in messages"
          :key="i"
          class="chatbot-row"
          :class="m.role === 'user' ? 'chatbot-row--user' : 'chatbot-row--ai'"
        >
          <!-- Assistant avatar: headset glyph, no outer circle -->
          <span v-if="m.role === 'ai'" class="chatbot-avatar chatbot-avatar--ai">
            <ConfigurableIcon name="MENU_CUSTOMER_SERVICE" :size="36" />
          </span>

          <div v-if="m.kind === 'video'" class="chatbot-video">
            {{ t('chatbotoverlay.tutorial_video') }}
          </div>
          <div v-else class="chatbot-bubble">
            <span v-if="m.text">{{ m.text }}</span>
            <span v-if="m.fileName" class="chatbot-file">📎 {{ m.fileName }}</span>
          </div>

          <!-- User avatar: uploaded avatar, or the user glyph in a circle -->
          <span v-if="m.role === 'user'" class="chatbot-avatar chatbot-avatar--user">
            <img
              v-if="user && user.avatar"
              class="chatbot-avatar__img"
              :src="user.avatar"
              alt=""
              draggable="false"
            />
            <ConfigurableIcon v-else name="MENU_USER" :size="20" />
          </span>
        </div>
      </div>

      <!-- Pending attachment chip -->
      <div v-if="pendingFile" class="chatbot-chip">
        <span class="chatbot-chip__name">📎 {{ pendingFile }}</span>
        <button class="chatbot-chip__x" aria-label="Remove" @click="pendingFile = null">
          ×
        </button>
      </div>

      <!-- Input row: [upload] [input] [send] -->
      <div class="chatbot-input-row">
        <button
          class="chatbot-round"
          :title="t('chatbotoverlay.upload')"
          :aria-label="t('chatbotoverlay.upload')"
          @click="openFilePicker"
        >
          <ConfigurableIcon name="MENU_FILE_FOLDER" :size="20" />
        </button>
        <input ref="fileInput" type="file" class="chatbot-file-input" @change="onFileChange" />

        <input
          v-model="text"
          class="chatbot-input"
          :placeholder="t('chatbotoverlay.placeholder')"
          @keydown.enter="send"
        />

        <button
          class="chatbot-round"
          :title="t('chatbotoverlay.send')"
          :aria-label="t('chatbotoverlay.send')"
          @click="send"
        >
          <ConfigurableIcon name="CHAT_SEND" :size="30" />
        </button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.chatbot-layer {
  position: absolute;
  inset: 0;
  z-index: 30;
  pointer-events: auto;
  background: rgba(255, 255, 255, 0.55);
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
  display: flex;
  align-items: flex-start;
  padding: 24px 32px;
  box-sizing: border-box;
}

.chatbot-dialog {
  width: 100%;
  height: 62%;
  min-height: 320px;
  background: #ffffff;
  border: 1px solid #8e8e93;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  padding: 24px 28px;
}

/* ─── Messages ─── */
.chatbot-messages {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 20px;
  padding-right: 8px;
}

.chatbot-row {
  display: flex;
  align-items: flex-start;
  gap: 16px;
}

.chatbot-row--user {
  justify-content: flex-end;
}

.chatbot-avatar--ai {
  display: flex;
  color: #111827;
  flex-shrink: 0;
}

.chatbot-avatar--user {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  border: 1.5px solid #374151;
  background: transparent;
  color: #111827;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  flex-shrink: 0;
}

.chatbot-avatar__img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.chatbot-video {
  width: min(420px, 70%);
  height: 160px;
  background: #d1d1d6;
  color: #3c3c43;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.9rem;
  flex-shrink: 0;
}

.chatbot-bubble {
  max-width: 70%;
  background: #f2f2f7;
  border-radius: 8px;
  padding: 10px 14px;
  font-size: 0.9rem;
  color: #111827;
  white-space: pre-wrap;
  box-sizing: border-box;
}

.chatbot-row--user .chatbot-bubble {
  background: #e8f1ff;
}

.chatbot-file {
  display: block;
  margin-top: 6px;
  font-size: 0.8rem;
  color: #007aff;
}

/* ─── Attachment chip ─── */
.chatbot-chip {
  margin-top: 12px;
  display: flex;
  align-items: center;
  gap: 8px;
  background: #f2f2f7;
  border: 1px solid #d1d1d6;
  border-radius: 999px;
  padding: 4px 12px;
  align-self: flex-start;
  font-size: 0.8rem;
  color: #111827;
}

.chatbot-chip__name {
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chatbot-chip__x {
  border: none;
  background: none;
  cursor: pointer;
  font-size: 1rem;
  line-height: 1;
  color: #6e6e73;
  padding: 0 2px;
}

.chatbot-chip__x:hover {
  color: #111827;
}

/* ─── Input row ─── */
.chatbot-input-row {
  margin-top: 16px;
  display: flex;
  align-items: center;
  gap: 16px;
}

.chatbot-round {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  border: 1.5px solid #374151;
  background: transparent;
  color: #111827;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  flex-shrink: 0;
  padding: 0;
}

.chatbot-round:hover {
  background: rgba(0, 0, 0, 0.06);
}

.chatbot-file-input {
  display: none;
}

.chatbot-input {
  flex: 1;
  min-width: 0;
  height: 56px;
  background: #ececf0;
  border: 1px solid #d1d1d6;
  border-radius: 4px;
  padding: 0 16px;
  font-size: 0.9rem;
  color: #111827;
  outline: none;
  box-sizing: border-box;
}

.chatbot-input:focus {
  border-color: #007aff;
  background: #ffffff;
}
</style>
