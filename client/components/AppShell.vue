<script setup>
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute, useRouter } from 'vue-router';
import { useAuth } from '@shared-composables/useAuth.js';
import ConfigurableIcon from '@shared/ConfigurableIcon.vue';
import bannerUrl from '../assets/media/drone_earth.png';

const { t, locale } = useI18n();
const router = useRouter();
const route = useRoute();
const { user, isAuthenticated, fetchMe } = useAuth();

/* ─── Left-panel navigation ─── */
// Integrated pages navigate on click; the remaining names stay plain text
// until their pages are wired into the shell.
function go(path) {
  if (router.currentRoute.value.path !== path) router.push(path);
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
    <!-- ── Left panel: full height, from the top of the page to the bottom ── -->
    <aside v-if="open" class="shell-left" :style="{ width: leftWidth + 'px' }">
      <!-- Brand banner: its width tracks the panel width, so dragging the
           vertical divider scales it too. -->
      <img
        class="shell-left__banner"
        :src="bannerUrl"
        alt=""
        draggable="false"
      />

      <!-- Top group, aligned to the top -->
      <div
        class="shell-nav__item shell-nav__item--link"
        :class="{ 'shell-nav__item--active': isActive('/') }"
        @click="go('/')"
      >
        {{ t('aerialview.page_aerial') }}
      </div>
      <div
        class="shell-nav__item shell-nav__item--link"
        :class="{ 'shell-nav__item--active': isActive('/route-planning') }"
        @click="go('/route-planning')"
      >
        {{ t('aerialview.page_routeplanning') }}
      </div>
      <div class="shell-nav__item">{{ t('aerialview.page_extensions') }}</div>

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
      <div
        class="shell-nav__item shell-nav__item--link"
        :class="{ 'shell-nav__item--active': isActive('/content') }"
        @click="go('/content')"
      >
        {{ t('aerialview.subpage_content') }}
      </div>
    </aside>

    <!-- Draggable vertical divider (full height) -->
    <div
      v-if="open"
      class="shell-divider"
      :class="{ 'shell-divider--dragging': isDragging }"
      @pointerdown="onDividerPointerDown"
    />

    <!-- ── Right column: top bar starts right of the divider ── -->
    <div class="shell-right">
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

          <!-- Customer service (no action wired yet) -->
          <button
            class="shell-round"
            :title="t('aerialview.topbar_customer_service')"
            :aria-label="t('aerialview.topbar_customer_service')"
          >
            <ConfigurableIcon name="MENU_CUSTOMER_SERVICE" :size="20" />
          </button>
        </div>

        <!-- Canonical slot for every page's reminders / warnings: pages
             <Teleport> their .shell-notice divs here (centered; the bar
             grows when a notice wraps onto multiple lines). -->
        <div id="shell-notices" class="shell-topbar__notices"></div>

        <div class="shell-topbar__right">
          <!-- User: uploaded avatar when signed in, default glyph otherwise -->
          <button
            class="shell-round"
            :title="t('aerialview.topbar_user')"
            :aria-label="t('aerialview.topbar_user')"
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

      <!-- Main panel: pages fill exactly this area -->
      <main class="shell-main">
        <slot />
      </main>
    </div>
  </div>
</template>

<style scoped>
.shell {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: row;
  pointer-events: none; /* let the Cesium canvas / pages decide input capture */
}

/* ── Right column: top bar + main, starts right of the divider ── */
.shell-right {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

/* ── Top bar ── */
.shell-topbar {
  flex-shrink: 0;
  min-height: 64px; /* grows when a teleported notice wraps to more lines */
  display: grid;
  grid-template-columns: 1fr auto 1fr;
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
  justify-self: start;
  display: flex;
  align-items: center;
  gap: 12px;
}

.shell-topbar__right {
  justify-self: end;
  display: flex;
  align-items: center;
  gap: 12px;
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

.shell-left__banner {
  width: 100%;
  height: auto;
  display: block;
  margin-bottom: 16px;
  flex-shrink: 0;
  user-select: none;
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
  min-width: 0;
  max-width: 100%;
}

.shell-notice {
  font-family: Calibri, 'Segoe UI', sans-serif;
  font-size: 0.8rem;
  font-weight: 400;
  color: #111827;
  line-height: 1.35;
  text-align: center;
  max-width: 100%;
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
