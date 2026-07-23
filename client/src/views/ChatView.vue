<script setup>
import { ref, computed, h, nextTick, onMounted, onUnmounted } from 'vue';
import { useI18n } from 'vue-i18n';
import ViewComposer from '@shared/_ViewComposer.vue';
import ConfigurableIcon from '@shared/ConfigurableIcon.vue';
import DockMenuButton from '@shared/DockMenuButton.vue';
import { useDockRegistry } from '@shared-composables/useDockRegistry.js';
import { usePageRegistry } from '@shared-composables/usePageRegistry.js';
import { useRouter } from 'vue-router';

const { t } = useI18n();
const router = useRouter();
const { leftItems, rightItems, registerLeft, registerRight, clear } = useDockRegistry();
const { pages, registerPage, unregisterPage } = usePageRegistry();

/* ─── Left-column width drag ─── */
const LEFT_MIN = 280;
const LEFT_MAX = 600;
const LEFT_DEFAULT = 40; // percentage
const leftWidthPct = ref(LEFT_DEFAULT);
const isDragging = ref(false);

function onDividerPointerDown(e) {
  e.preventDefault();
  isDragging.value = true;
  document.addEventListener('pointermove', onDividerPointerMove);
  document.addEventListener('pointerup', onDividerPointerUp);
}

function onDividerPointerMove(e) {
  if (!isDragging.value) return;
  const panel = document.querySelector('.community-page');
  if (!panel) return;
  const rect = panel.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const pct = (x / rect.width) * 100;
  const minPct = (LEFT_MIN / rect.width) * 100;
  const maxPct = (LEFT_MAX / rect.width) * 100;
  leftWidthPct.value = Math.min(maxPct, Math.max(minPct, pct));
}

function onDividerPointerUp() {
  isDragging.value = false;
  document.removeEventListener('pointermove', onDividerPointerMove);
  document.removeEventListener('pointerup', onDividerPointerUp);
}

/* ─── Sidebar navigation ─── */
const selectedNav = ref('chat');

const messages = ref([
  {
    id: 1,
    sender: 'system',
    text: t('chatview.connected'),
    time: '10:00 AM',
  },
  {
    id: 2,
    sender: 'user',
    text: t('chatview.patrol_request'),
    time: '10:02 AM',
  },
  {
    id: 3,
    sender: 'bot',
    text: t('chatview.patrol_response'),
    time: '10:02 AM',
  },
  {
    id: 4,
    sender: 'bot',
    image: 'https://placehold.co/400x200/3b82f6/ffffff?text=Route+Preview',
    text: '',
    time: '10:03 AM',
  },
]);

const input = ref('');
const messagesRef = ref(null);

async function sendMessage() {
  const text = input.value.trim();
  if (!text) return;

  messages.value.push({
    id: Date.now(),
    sender: 'user',
    text,
    time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
  });
  input.value = '';

  await nextTick();
  scrollToBottom();

  // Simulated assistant reply
  setTimeout(() => {
    messages.value.push({
      id: Date.now() + 1,
      sender: 'bot',
      text: t('chatview.acknowledged'),
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    });
    nextTick().then(scrollToBottom);
  }, 800);
}

function handleKeydown(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
}

function scrollToBottom() {
  if (messagesRef.value) {
    messagesRef.value.scrollTop = messagesRef.value.scrollHeight;
  }
}

onMounted(() => {
  registerPage({ id: 'aerial', nameKey: 'aerialview.page_aerial', route: '/' });
  registerPage({ id: 'map', nameKey: 'aerialview.page_map', route: '/map' });
  registerPage({ id: 'myspace', nameKey: 'aerialview.page_myspace', route: '/myspace' });
  registerPage({ id: 'chat', nameKey: 'aerialview.page_chat', route: '/chat' });
  registerPage({ id: 'extensions', nameKey: 'aerialview.page_extensions', route: '/extensions' });
  registerPage({ id: 'settings', nameKey: 'aerialview.page_settings', route: '/settings' });

  // Register dock sidebar buttons
  registerLeft({
    id: 'pages',
    render: () => h(DockMenuButton, {
      icon: 'MENU_ROUTER',
      titleKey: 'chatview.nav_pages',
      pages,
    }),
  });
  registerLeft({
    id: 'chat',
    icon: 'MENU_CHAT',
    titleKey: 'chatview.nav_chat',
    active: computed(() => selectedNav.value === 'chat'),
    onClick: () => { selectedNav.value = 'chat'; },
  });
  registerLeft({
    id: 'contacts',
    icon: 'MENU_CONTACTS',
    titleKey: 'chatview.nav_contacts',
    active: computed(() => selectedNav.value === 'contacts'),
    onClick: () => { selectedNav.value = 'contacts'; },
  });
  registerLeft({
    id: 'gallery',
    icon: 'MENU_GALLARY',
    titleKey: 'chatview.nav_gallery',
    active: computed(() => selectedNav.value === 'gallery'),
    onClick: () => { selectedNav.value = 'gallery'; },
  });
  registerLeft({
    id: 'customer_service',
    icon: 'MENU_CUSTOMER_SERVICE',
    titleKey: 'chatview.nav_customer_service',
    active: computed(() => selectedNav.value === 'customer_service'),
    onClick: () => { router.push('/customer-service'); },
  });

  // Register right dock buttons
  registerRight({
    id: 'photo',
    icon: 'MENU_PHOTO',
    titleKey: 'chatview.tool_photo',
    onClick: () => {},
  });
  registerRight({
    id: 'file',
    icon: 'MENU_ARCHIVE',
    titleKey: 'chatview.tool_file',
    onClick: () => {},
  });
  registerRight({
    id: 'note',
    icon: 'MENU_NOTE',
    titleKey: 'chatview.tool_note',
    onClick: () => {},
  });
  registerRight({
    id: 'tool',
    icon: 'MENU_TOOL',
    titleKey: 'chatview.tool_tool',
    onClick: () => {},
  });
});

onUnmounted(() => {
  clear();
  unregisterPage('aerial');
  unregisterPage('map');
  unregisterPage('myspace');
  unregisterPage('chat');
  unregisterPage('extensions');
  unregisterPage('settings');
});
</script>

<template>
  <ViewComposer
    :left-items="leftItems"
    :right-items="rightItems"
    :show-flight="false"
    :show-camera="false"
    :show-hud="false"
    :flight="{ mode: '-', vx: 0, vy: 0, yaw: 0, vz: 0 }"
    :camera="{ mode: '-', yaw: 0, pitch: 0, roll: 0 }"
  >
    <template #background>
      <div class="community-page">
        <!-- Left panel -->
        <aside
          class="community-sidebar"
          :style="{ flexBasis: leftWidthPct + '%' }"
        >
          <!-- Content area based on selectedNav -->
        </aside>

        <!-- Divider (draggable) -->
        <div
          class="community-divider"
          @pointerdown="onDividerPointerDown"
        />

        <!-- Right content area -->
        <main class="community-content">
          <!-- Chat header -->
          <header class="chat-header">
            <h1 class="chat-header-title">{{ t('chatview.mission_control') }}</h1>
            <span class="chat-status">{{ t('chatview.online') }}</span>
          </header>

          <!-- Messages -->
          <div ref="messagesRef" class="messages">
            <div
              v-for="msg in messages"
              :key="msg.id"
              class="message-wrapper"
              :class="`message-wrapper--${msg.sender}`"
            >
              <div class="message-bubble" :class="`message-bubble--${msg.sender}`">
                <p v-if="msg.text" class="message-text">{{ msg.text }}</p>
                <img
                  v-if="msg.image"
                  :src="msg.image"
                  alt="Shared image"
                  class="message-image"
                />
                <span class="message-time">{{ msg.time }}</span>
              </div>
            </div>
          </div>

          <!-- Input bar -->
          <footer class="chat-inputbar">
            <button class="icon-btn" :title="t('chatview.attach_file')">
              <ConfigurableIcon name="CHAT_ATTACHMENT" :size="22" />
            </button>
            <textarea
              v-model="input"
              class="chat-input"
              :placeholder="t('chatview.type_a_message')"
              rows="1"
              @keydown="handleKeydown"
            />
            <button class="send-btn" :title="t('chatview.send')" @click="sendMessage">
              <ConfigurableIcon name="CHAT_SEND" :size="18" />
            </button>
          </footer>
        </main>
      </div>
    </template>
  </ViewComposer>
</template>

<style scoped>
.community-page {
  position: absolute;
  inset: 0;
  display: flex;
  pointer-events: auto;
  background: #ffffff;
  user-select: none;
  z-index: 6;
}

/* ─── Left sidebar ─── */
.community-sidebar {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  background: #f5f5f7;
  overflow-y: auto;
}

.community-sidebar::-webkit-scrollbar {
  width: 8px;
}

.community-sidebar::-webkit-scrollbar-track {
  background: transparent;
}

.community-sidebar::-webkit-scrollbar-thumb {
  background: rgba(0, 0, 0, 0.15);
  border-radius: 4px;
}

.community-sidebar::-webkit-scrollbar-thumb:hover {
  background: rgba(0, 0, 0, 0.25);
}

/* ─── Divider ─── */
.community-divider {
  width: 4px;
  flex-shrink: 0;
  background: #e5e5ea;
  cursor: col-resize;
  transition: background 0.15s ease;
}

.community-divider:hover,
.community-divider:active {
  background: #007aff;
}

/* ─── Right content area ─── */
.community-content {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: #ffffff;
  overflow: hidden;
}

/* ─── Chat header ─── */
.chat-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 24px;
  border-bottom: 1px solid rgba(229, 231, 235, 0.8);
  background: rgba(255, 255, 255, 0.7);
}

.chat-header-title {
  font-size: 1.125rem;
  font-weight: 700;
  margin: 0;
  color: #1d1d1f;
}

.chat-status {
  font-size: 0.75rem;
  font-weight: 600;
  color: #16a34a;
  display: flex;
  align-items: center;
  gap: 6px;
}

.chat-status::before {
  content: '';
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #22c55e;
}

/* ─── Messages ─── */
.messages {
  flex: 1;
  overflow-y: auto;
  padding: 24px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.message-wrapper {
  display: flex;
  width: 100%;
}

.message-wrapper--user {
  justify-content: flex-end;
}

.message-wrapper--bot,
.message-wrapper--system {
  justify-content: flex-start;
}

.message-bubble {
  max-width: 60%;
  padding: 12px 16px;
  border-radius: 16px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.message-bubble--user {
  background: #3b82f6;
  color: white;
  border-bottom-right-radius: 4px;
}

.message-bubble--bot {
  background: #f3f4f6;
  color: #1f2937;
  border-bottom-left-radius: 4px;
}

.message-bubble--system {
  background: #dbeafe;
  color: #1e40af;
  border-radius: 999px;
  padding: 8px 16px;
  max-width: max-content;
  margin: 0 auto;
}

.message-text {
  margin: 0;
  line-height: 1.5;
  font-size: 0.95rem;
}

.message-image {
  max-width: 100%;
  max-height: 240px;
  border-radius: 10px;
  object-fit: cover;
}

.message-time {
  font-size: 0.7rem;
  opacity: 0.7;
  align-self: flex-end;
}

/* ─── Input bar ─── */
.chat-inputbar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px 24px;
  border-top: 1px solid rgba(229, 231, 235, 0.8);
  background: rgba(255, 255, 255, 0.7);
}

.chat-input {
  flex: 1;
  resize: none;
  padding: 12px 18px;
  border-radius: 24px;
  border: 1px solid rgba(209, 213, 219, 0.8);
  background: #f9fafb;
  font-size: 0.95rem;
  line-height: 1.4;
  outline: none;
  min-height: 24px;
  max-height: 120px;
}

.chat-input:focus {
  border-color: #3b82f6;
  background: white;
}

.icon-btn {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  border: 1px solid rgba(209, 213, 219, 0.8);
  background: white;
  color: #4b5563;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: background 0.15s ease;
  flex-shrink: 0;
}

.icon-btn:hover {
  background: #f3f4f6;
}

.send-btn {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  border: none;
  background: #3b82f6;
  color: white;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: background 0.15s ease;
  flex-shrink: 0;
}

.send-btn:hover {
  background: #2563eb;
}
</style>
