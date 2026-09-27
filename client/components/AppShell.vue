<script setup>
import { onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute, useRouter } from 'vue-router';
import { useAuth } from '@shared-composables/useAuth.js';
import ConfigurableIcon from '@shared/ConfigurableIcon.vue';
import AssistantPanel from '@shared/AssistantPanel.vue';

const { t, locale } = useI18n();
const router = useRouter();
const route = useRoute();
const { user, isAuthenticated, fetchMe } = useAuth();

/* ─── Left-panel navigation ─── */
function go(path) {
  if (router.currentRoute.value.path === path) return;
  // Client-side navigation for every page, including Play!: only the main
  // panel (.shell-main) swaps, so the top bar, left nav, and right assistant
  // stay mounted and static. The /play route guard bootstraps the Cesium
  // viewer on demand, and the intro splash plays over the main panel.
  router.push(path);
}

// The entry for the page currently on screen turns blue.
function isActive(path) {
  return route.path === path;
}

onMounted(() => {
  // The top-bar user button shows the uploaded avatar when signed in.
  if (isAuthenticated.value && !user.value) fetchMe().catch(() => {});
});

/* ─── Panel open/close state ─── */
// Starts collapsed (mockup left state); the circular toggle flips the
// chevron right→left when the panel unfolds.
const open = ref(false);
// After a successful login (Account -> Login) expand the left panel so the
// functional menu is immediately visible; only on the logged-out -> logged-in
// transition, not on page reloads where the session is already alive.
watch(isAuthenticated, (now, was) => {
  if (now && !was) open.value = true;
});

/* ─── Left-panel width drag (same pattern as Extensions / My Space) ─── */
const LEFT_MIN = 180;
const LEFT_MAX = 420;
const LEFT_DEFAULT = 260;
const leftWidth = ref(LEFT_DEFAULT);
const isDragging = ref(false);

function onDividerPointerDown(e) {
  e.preventDefault();
  isDragging.value = true;
  document.addEventListener('pointermove', onDividerPointerMove);
  document.addEventListener('pointerup', onDividerPointerUp);
}

function onDividerPointerMove(e) {
  if (!isDragging.value) return;
  const panel = document.querySelector('.shell-left');
  if (!panel) return;
  const rect = panel.getBoundingClientRect();
  const x = e.clientX - rect.left;
  leftWidth.value = Math.min(LEFT_MAX, Math.max(LEFT_MIN, x));
}

function onDividerPointerUp() {
  isDragging.value = false;
  document.removeEventListener('pointermove', onDividerPointerMove);
  document.removeEventListener('pointerup', onDividerPointerUp);
}

/* ─── Right assistant-panel width drag (mirror of the left divider) ─── */
const RIGHT_MIN = 300;
const RIGHT_MAX = 720;
const RIGHT_DEFAULT = 420;
const rightWidth = ref(RIGHT_DEFAULT);
const isDraggingRight = ref(false);

function onRightDividerPointerDown(e) {
  e.preventDefault();
  isDraggingRight.value = true;
  document.addEventListener('pointermove', onRightDividerPointerMove);
  document.addEventListener('pointerup', onRightDividerPointerUp);
}

function onRightDividerPointerMove(e) {
  if (!isDraggingRight.value) return;
  // The panel hangs off the right edge, so its width is the distance
  // from the pointer to the window's right border.
  const w = window.innerWidth - e.clientX;
  rightWidth.value = Math.min(RIGHT_MAX, Math.max(RIGHT_MIN, w));
}

function onRightDividerPointerUp() {
  isDraggingRight.value = false;
  document.removeEventListener('pointermove', onRightDividerPointerMove);
  document.removeEventListener('pointerup', onRightDividerPointerUp);
}

/* ─── Top-bar user button ─── */
// A signed-out visitor clicking the user glyph is taken straight to
// Account -> Login; a signed-in user lands on the same page's profile card.
function onClickUser() {
  go('/account');
}

/* ─── Language pill (top right) ─── */
// Shows the *current* language (EN / 中文); clicking switches locale and
// persists the choice exactly like the old LanguageSelector / Settings
// language tab. Adding a language later only means extending this label.
function toggleLocale() {
  locale.value = locale.value === 'en' ? 'zh' : 'en';
  localStorage.setItem('user-lang', locale.value);
}

</script>

<template>
  <div class="shell">
    <!-- ── Top bar: spans the full window width, above every panel ── -->
    <header class="shell-topbar">
      <div class="shell-topbar__left">
        <button
          class="shell-toggle"
          :aria-label="open ? 'Collapse navigation' : 'Expand navigation'"
          @click="open = !open"
        >
          <svg
            class="shell-toggle__arrow"
            :class="{ 'shell-toggle__arrow--flipped': open }"
            width="16"
            height="16"
            viewBox="0 0 16 16"
          >
            <path
              d="M6 3l5 5-5 5"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </button>
      </div>

      <!-- Canonical slot for every page's reminders / warnings: pages
           <Teleport> their .shell-notice divs here (centered; the bar
           grows when a notice wraps onto multiple lines). -->
      <div class="shell-topbar__notices">
        <div id="shell-notices" style="display: contents"></div>
      </div>

      <div class="shell-topbar__right">
        <!-- User: uploaded avatar when signed in, default glyph otherwise -->
        <button
          class="shell-round"
          :title="t('aerialview.topbar_user')"
          :aria-label="t('aerialview.topbar_user')"
          @click="onClickUser"
        >
          <img
            v-if="user && user.avatar"
            class="shell-round__avatar"
            :src="user.avatar"
            alt=""
            draggable="false"
          />
          <ConfigurableIcon v-else name="MENU_USER" :size="20" />
        </button>

        <!-- Shows the *current* language; clicking switches locale and
             persists the choice (ready for more languages later). -->
        <button class="shell-lang" @click="toggleLocale">
          {{ locale === 'en' ? 'EN' : '中文' }}
        </button>
      </div>
    </header>

    <!-- ── Body row under the top bar: left panel | main | assistant ── -->
    <div class="shell-body">
      <!-- Left panel: navigation, from the top bar down to the bottom -->
      <aside v-if="open" class="shell-left" :style="{ width: leftWidth + 'px' }">
        <!-- Top group, aligned to the top. There is deliberately NO Play!
             entry: the only door into the /play view is the Plaza page's
             "Play the game" button (plus the Gallery's "Explore the Scene in
             3D" deep link), so the route and the view stay exactly as they
             were while this nav item is gone. -->
        <div
          class="shell-nav__item shell-nav__item--link"
          :class="{ 'shell-nav__item--active': isActive('/') }"
          @click="go('/')"
        >
          {{ t('aerialview.page_plaza') }}
        </div>

        <div class="shell-left__spacer" />
        <div class="shell-left__divider" />

        <!-- Bottom group (My Space), aligned to the bottom -->
        <div
          class="shell-nav__item shell-nav__item--link"
          :class="{ 'shell-nav__item--active': isActive('/account') }"
          @click="go('/account')"
        >
          {{ t('aerialview.subpage_account') }}
        </div>
      </aside>

      <!-- Draggable vertical divider -->
      <div
        v-if="open"
        class="shell-divider"
        :class="{ 'shell-divider--dragging': isDragging }"
        @pointerdown="onDividerPointerDown"
      />

      <!-- Main panel: pages fill exactly this area -->
      <main class="shell-main">
        <slot />
      </main>

      <!-- Draggable divider + AI assistant panel (rightmost column) -->
      <div
        class="shell-divider"
        :class="{ 'shell-divider--dragging': isDraggingRight }"
        @pointerdown="onRightDividerPointerDown"
      />
      <aside class="shell-assistant" :style="{ width: rightWidth + 'px' }">
        <AssistantPanel />
      </aside>
    </div>
  </div>
</template>

<style scoped>
.shell {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  pointer-events: none; /* let the Cesium canvas / pages decide input capture */
}

/* ── Body row under the full-width top bar: left panel | main | assistant ── */
.shell-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: row;
}

/* ── Top bar ──
   Flexbox (not grid) on purpose: the notices' max-width percentage must
   resolve against the BAR's definite width. In a `1fr auto 1fr` grid the
   percentage resolved against the item's own auto track (sized from the
   message content), so long notices always wrapped at a fraction of
   their own one-line width. */
.shell-topbar {
  flex-shrink: 0;
  min-height: 64px; /* grows when a teleported notice wraps to more lines */
  display: flex;
  align-items: center;
  column-gap: 12px;
  padding: 8px 24px;
  background: rgba(245, 245, 247, 0.92);
  border-bottom: 1px solid #e5e5ea;
  pointer-events: auto;
  z-index: 20;
  box-sizing: border-box;
}

.shell-lang {
  justify-self: end;
}

/* ── Top-bar left / right clusters ── */
.shell-topbar__left {
  flex: 1 1 0; /* equal shares keep the notices centered */
  display: flex;
  align-items: center;
  gap: 12px;
}

.shell-topbar__right {
  flex: 1 1 0;
  display: flex;
  align-items: center;
  gap: 12px;
  justify-content: flex-end;
}

.shell-round {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  border: 1.5px solid #374151;
  background: transparent;
  color: #111827;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  padding: 0;
  flex-shrink: 0;
  overflow: hidden;
}

.shell-round:hover {
  background: rgba(0, 0, 0, 0.06);
}

.shell-round__avatar {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.shell-toggle {
  justify-self: start;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  border: 1.5px solid #374151;
  background: transparent;
  color: #111827;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  padding: 0;
  flex-shrink: 0;
}

.shell-toggle:hover {
  background: rgba(0, 0, 0, 0.06);
}

.shell-toggle__arrow {
  transition: transform 0.2s ease;
}

.shell-toggle__arrow--flipped {
  transform: rotate(180deg);
}

.shell-lang {
  border: 1.5px solid #374151;
  border-radius: 999px;
  padding: 6px 18px;
  background: transparent;
  color: #111827;
  font-size: 0.85rem;
  font-weight: 600;
  cursor: pointer;
}

.shell-lang:hover {
  background: rgba(0, 0, 0, 0.06);
}

.shell-left {
  flex-shrink: 0;
  background: #f5f5f7;
  padding: 24px;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  pointer-events: auto;
  z-index: 10;
}

.shell-nav__item {
  font-size: 0.95rem;
  font-weight: 600;
  color: #111827;
  padding: 10px 0;
  cursor: default;
}

.shell-nav__item--link {
  cursor: pointer;
}

.shell-nav__item--link:hover {
  color: #007aff;
}

.shell-nav__item--active,
.shell-nav__item--active:hover {
  color: #007aff;
}

.shell-left__spacer {
  flex: 1 1 auto;
}

.shell-left__divider {
  height: 1px;
  background: #e5e5ea;
  margin: 12px 0;
  flex-shrink: 0;
}

/* ── Draggable vertical divider ── */
.shell-divider {
  width: 4px;
  flex-shrink: 0;
  background: #e5e5ea;
  cursor: col-resize;
  transition: background 0.15s ease;
  pointer-events: auto;
  z-index: 10;
}

.shell-divider:hover,
.shell-divider--dragging {
  background: #007aff;
}

/* ── Main panel ── */
.shell-main {
  flex: 1;
  position: relative;
  min-width: 0;
  min-height: 0;
  pointer-events: none;
  z-index: 0; /* contain page-internal z-indices under the shell chrome */
}

/* ── Right assistant panel ── */
.shell-assistant {
  flex-shrink: 0;
  pointer-events: auto;
  z-index: 10;
}
</style>

<style>
/* ── Top-bar notices (global: pages Teleport these divs into #shell-notices) ──
   Reminders are plain black text; warnings are red regular text with the ⚠
   icons and a gentle pulse (safety-critical, must stay noticeable). */
.shell-topbar__notices {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  min-width: 0; /* let long messages wrap instead of overflowing */
  flex: 0 1 auto;
  /* 60% of the bar's width (definite in flexbox), so it tracks window
     resizes automatically. */
  max-width: 60%;
}

.shell-notice {
  font-family: Calibri, 'Segoe UI', sans-serif;
  /* Same size as the left-panel page names, regular weight, in blue. */
  font-size: 0.95rem;
  font-weight: 400;
  color: #007aff;
  line-height: 1.35;
  text-align: center;
  max-width: 100%;
  overflow-wrap: break-word;
}

.shell-notice--warning {
  color: #dc143c;
  animation: shell-notice-pulse 1s ease-in-out infinite;
}

@keyframes shell-notice-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.55;
  }
}
</style>
