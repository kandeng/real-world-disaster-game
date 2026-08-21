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
let attachSeq = 0;

// Full-size viewer state: { kind, url, poster } — null = closed.
const viewer = ref(null);

const listRef = ref(null);
const fileInput = ref(null);

/* ─── Bottom-border drag: adjust the panel height ─── */
// null = CSS default (62%); once the user drags, an explicit px height.
const layerRef = ref(null);
const dialogRef = ref(null);
const dialogHeight = ref(null);
const RESIZE_MIN = 240;
let resizeStartY = 0;
let resizeStartH = 0;

function onResizePointerDown(e) {
  e.preventDefault();
  resizeStartY = e.clientY;
  resizeStartH = dialogRef.value.getBoundingClientRect().height;
  document.addEventListener('pointermove', onResizePointerMove);
  document.addEventListener('pointerup', onResizePointerUp);
}

function onResizePointerMove(e) {
  const layer = layerRef.value;
  if (!layer) return;
  // Keep the layer's 24px top/bottom padding visible at full stretch.
  const maxH = layer.clientHeight - 48;
  const h = Math.min(maxH, Math.max(RESIZE_MIN, resizeStartH + (e.clientY - resizeStartY)));
  dialogHeight.value = Math.round(h);
}

function onResizePointerUp() {
  document.removeEventListener('pointermove', onResizePointerMove);
  document.removeEventListener('pointerup', onResizePointerUp);
}

function scrollBottom() {
  const el = listRef.value;
  if (el) el.scrollTop = el.scrollHeight;
}

onMounted(scrollBottom);

function openFilePicker() {
  fileInput.value?.click();
}

function onFileChange(e) {
  const files = Array.from(e.target.files || []);
  // Each uploaded file becomes its own right-aligned row with the user
  // avatar, exactly like a sent textual message.
  for (const f of files) {
    messages.value.push({ role: 'user', kind: 'text', text: '', files: [makeAttachment(f)] });
  }
  e.target.value = '';
  nextTick(scrollBottom);
}

function makeAttachment(file) {
  const kind = file.type.startsWith('image/')
    ? 'image'
    : file.type.startsWith('video/')
      ? 'video'
      : 'file';
  const att = { id: ++attachSeq, name: file.name, kind, url: null, videoUrl: null };
  if (kind === 'image') {
    att.url = URL.createObjectURL(file);
  } else if (kind === 'video') {
    // Kept for the click-to-play popup; the poster is captured below.
    att.videoUrl = URL.createObjectURL(file);
    captureVideoPoster(file).then((url) => {
      att.url = url;
    });
  }
  return att;
}

// Seek a muted off-screen <video> to its first frame and draw it onto a
// canvas; returns a small JPEG data-URL (null on failure).
function captureVideoPoster(file) {
  return new Promise((resolve) => {
    const src = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    const fail = () => {
      URL.revokeObjectURL(src);
      resolve(null);
    };
    video.addEventListener('error', fail);
    video.addEventListener('loadeddata', () => {
      try {
        video.currentTime = Math.min(0.1, (video.duration || 1) / 2);
      } catch {
        fail();
      }
    });
    video.addEventListener('seeked', () => {
      try {
        const w = video.videoWidth || 320;
        const h = video.videoHeight || 180;
        const scale = Math.min(1, 320 / w);
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(w * scale);
        canvas.height = Math.round(h * scale);
        canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', 0.7));
      } catch {
        fail();
      } finally {
        URL.revokeObjectURL(src);
      }
    });
    video.src = src;
  });
}

function openViewer(a) {
  viewer.value = { kind: a.kind, url: a.kind === 'video' ? a.videoUrl : a.url, poster: a.url };
}

function closeViewer() {
  viewer.value = null;
}

function send() {
  const body = text.value.trim();
  if (!body) return;
  messages.value.push({ role: 'user', kind: 'text', text: body });
  text.value = '';
  nextTick(scrollBottom);
}
</script>

<template>
  <!-- Semi-transparent layer, same recipe as the Flight disk inner circle
       (rgba(255,255,255,0.55) + blur(6px)): the page below is barely
       visible while the dialog stays crisp. -->
  <div ref="layerRef" class="chatbot-layer">
    <section
      ref="dialogRef"
      class="chatbot-dialog"
      :style="dialogHeight ? { height: dialogHeight + 'px' } : null"
    >
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
          <div
            v-else
            class="chatbot-bubble"
            :class="{ 'chatbot-bubble--plain': !m.text && m.files && m.files.length }"
          >
            <span v-if="m.text">{{ m.text }}</span>
            <template v-if="m.files && m.files.length">
              <template v-for="a in m.files" :key="a.id">
                <!-- Video: first-frame poster + play glyph; click = player -->
                <button
                  v-if="a.kind === 'video'"
                  type="button"
                  class="chatbot-attach"
                  :title="a.name"
                  @click="openViewer(a)"
                >
                  <img v-if="a.url" class="chatbot-attach__img" :src="a.url" :alt="a.name" />
                  <span v-else class="chatbot-attach__loading"></span>
                  <span class="chatbot-attach__play">▶</span>
                </button>
                <!-- Image: fixed-width thumbnail; click = raw-size viewer -->
                <img
                  v-else-if="a.kind === 'image' && a.url"
                  class="chatbot-attach__img"
                  :src="a.url"
                  :alt="a.name"
                  :title="a.name"
                  @click="openViewer(a)"
                />
                <span v-else class="chatbot-file">📎 {{ a.name }}</span>
              </template>
            </template>
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
        <input ref="fileInput" type="file" multiple class="chatbot-file-input" @change="onFileChange" />

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

      <!-- Drag this bottom border up/down to resize the panel -->
      <div class="chatbot-resize" @pointerdown="onResizePointerDown" />
    </section>

    <!-- Full-size viewer: raw-size image (shrunk to fit, ratio kept) or a
         video player; click the backdrop to close. -->
    <div v-if="viewer" class="chatbot-viewer" @click="closeViewer">
      <video
        v-if="viewer.kind === 'video'"
        class="chatbot-viewer__media"
        :src="viewer.url"
        :poster="viewer.poster"
        controls
        autoplay
        @click.stop
      ></video>
      <img v-else class="chatbot-viewer__media" :src="viewer.url" alt="" @click.stop />
    </div>
  </div>
</template>

<style scoped>
.chatbot-layer {
  position: absolute;
  inset: 0;
  /* Above every page-internal stack (the 3D HUD dashboard uses z-50). */
  z-index: 60;
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
  position: relative;
  width: 100%;
  height: 62%;
  min-height: 240px;
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

/* File-only messages: no bubble chrome, just the thumbnail + avatar. */
.chatbot-bubble--plain,
.chatbot-row--user .chatbot-bubble--plain {
  background: transparent;
  padding: 0;
}

.chatbot-file {
  display: block;
  margin-top: 6px;
  font-size: 0.8rem;
  color: #007aff;
}

.chatbot-attach {
  position: relative;
  display: block;
  margin-top: 8px;
  padding: 0;
  border: none;
  background: none;
  cursor: pointer;
}

/* Consistent width across files; height follows each file's own ratio. */
.chatbot-attach__img {
  display: block;
  width: 220px;
  max-width: 100%;
  height: auto;
  border-radius: 6px;
  margin-top: 8px;
  cursor: pointer;
}

.chatbot-attach .chatbot-attach__img {
  margin-top: 0;
  cursor: pointer;
}

.chatbot-attach__loading {
  display: block;
  width: 220px;
  height: 124px;
  background: #d1d1d6;
  border-radius: 6px;
}

.chatbot-attach__play {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #ffffff;
  font-size: 26px;
  text-shadow: 0 1px 6px rgba(0, 0, 0, 0.65);
  pointer-events: none;
}

/* ─── Full-size viewer (image / video popup) ─── */
.chatbot-viewer {
  position: absolute;
  inset: 0;
  z-index: 10;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
}

/* Natural size when it fits; shrink-to-fit (ratio kept) when larger. */
.chatbot-viewer__media {
  max-width: calc(100% - 64px);
  max-height: calc(100% - 64px);
  width: auto;
  height: auto;
  border-radius: 8px;
  background: #000000;
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

/* ─── Bottom-border resize handle ─── */
.chatbot-resize {
  position: absolute;
  left: 0;
  right: 0;
  bottom: -5px;
  height: 10px;
  cursor: ns-resize;
  user-select: none;
  touch-action: none;
}

.chatbot-resize:hover {
  background: rgba(0, 122, 255, 0.12);
}
</style>
