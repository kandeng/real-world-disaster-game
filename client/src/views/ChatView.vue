<script setup>
import { ref, computed, h, nextTick, watch, onMounted, onUnmounted } from 'vue';
import { useI18n } from 'vue-i18n';
import ViewComposer from '@shared/_ViewComposer.vue';
import ConfigurableIcon from '@shared/ConfigurableIcon.vue';
import DockMenuButton from '@shared/DockMenuButton.vue';
import { useDockRegistry } from '@shared-composables/useDockRegistry.js';
import { usePageRegistry } from '@shared-composables/usePageRegistry.js';
import { useAuth } from '@shared-composables/useAuth.js';
import { useMatrixClient } from '@shared-composables/useMatrixClient.js';
import { createWhepPlayer } from '@shared-composables/useWhepPlayer.js';
import { useWhipBroadcast } from '@shared-composables/useWhipPublisher.js';
import { useLiveCapture } from '@shared-composables/useLiveCapture.js';
import { useStreamConfig } from '@shared-composables/useStreamConfig.js';
import { useRouter } from 'vue-router';

const { t } = useI18n();
const router = useRouter();
const { leftItems, rightItems, registerLeft, registerRight, clear } = useDockRegistry();
const { pages, registerPage, unregisterPage } = usePageRegistry();
const { isAuthenticated, user, fetchMe } = useAuth();
const {
  ready: chatReady, error: chatError,
  dms, teamRooms, activeRoom, activeRoomId, timeline, typingNames, directory,
  bootstrap, setActiveRoom, sendText, noteTyping,
  createDm, createTeamRoom, fetchDirectory,
} = useMatrixClient();

/* ─── Left-column width drag ─── */
const LEFT_MIN = 280;
const LEFT_MAX = 600;
const LEFT_DEFAULT = 40; // percentage
// The dock strips overlay the page on both sides (see .community-page
// padding): 24px _ViewComposer padding + 72px AppDock = 96px from each
// screen edge. The draggable area is the content box between them.
const DOCK_STRIP = 96;
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
  const usable = rect.width - DOCK_STRIP * 2;
  const x = e.clientX - rect.left - DOCK_STRIP;
  const pct = (x / usable) * 100;
  const minPct = (LEFT_MIN / usable) * 100;
  const maxPct = (LEFT_MAX / usable) * 100;
  leftWidthPct.value = Math.min(maxPct, Math.max(minPct, pct));
}

function onDividerPointerUp() {
  isDragging.value = false;
  document.removeEventListener('pointermove', onDividerPointerMove);
  document.removeEventListener('pointerup', onDividerPointerUp);
}

/* ─── Sidebar navigation ─── */
const selectedNav = ref('chat');

/* ─── Livestream Viewer subpage (moved from Real Drone) ─── */
// Catalog from the backend's /api/stream/config (server config.json
// "mediamtx" section) with per-environment fallbacks — see useStreamConfig.
// The WHEP connection is created lazily when the user opens the subpage and
// torn down when they leave, so casual chat browsing costs no bandwidth.
const { streams, whepBase, refreshStreams } = useStreamConfig();

const selectedStreamId = ref(null);
const primaryStream = computed(() => streams.value[0] || null);
const selectedStream = computed(
  () => streams.value.find((s) => s.id === selectedStreamId.value) || primaryStream.value,
);
const targetUrl = computed(() => selectedStream.value?.whep_url || '');
// What the player was last started with — restart only on a real change.
let playingUrl = '';

const viewerVideoEl = ref(null);

// Top-center green progress pill while the connection is being set up.
const liveLoading = ref(false);
const liveProgress = ref(0);

function onLiveProgress(phase) {
  if (phase === 'start') {
    liveLoading.value = true;
    liveProgress.value = 0.15;
  } else if (phase === 'offer') {
    liveProgress.value = Math.max(liveProgress.value, 0.35);
  } else if (phase === 'handshake') {
    liveProgress.value = Math.max(liveProgress.value, 0.65);
  } else if (phase === 'track') {
    liveProgress.value = Math.max(liveProgress.value, 0.85);
  }
}

const livePlayer = createWhepPlayer({
  url: () => targetUrl.value,
  logTag: 'live',
  onProgress: onLiveProgress,
});

// The video element actually rendered a frame — finish the progress bar.
function onLivePlaying() {
  liveProgress.value = 1;
  setTimeout(() => {
    liveLoading.value = false;
  }, 400);
}

/* Fit the video into the right panel: NEVER upscale past the stream's
   natural resolution; downscale to fit when the panel is smaller; always
   centered (flex stage). Panel resizes (divider drag / window resize) are
   tracked via ResizeObserver. */
let stageObserver = null;

function fitViewerVideo() {
  if (liveFullscreen.value) return; // CSS sizes the fullscreen video
  const el = viewerVideoEl.value;
  if (!el || !el.parentElement) return;
  const vw = el.videoWidth;
  const vh = el.videoHeight;
  if (!vw || !vh) return; // stream metadata not available yet
  const rect = el.parentElement.getBoundingClientRect();
  const scale = Math.min(rect.width / vw, rect.height / vh, 1); // cap at 1
  el.style.width = `${Math.floor(vw * scale)}px`;
  el.style.height = `${Math.floor(vh * scale)}px`;
}

function setupViewerStage() {
  teardownViewerStage();
  const el = viewerVideoEl.value;
  if (!el) return;
  el.addEventListener('loadedmetadata', fitViewerVideo);
  el.addEventListener('resize', fitViewerVideo); // intrinsic size changes
  stageObserver = new ResizeObserver(fitViewerVideo);
  stageObserver.observe(el.parentElement);
}

function teardownViewerStage() {
  if (stageObserver) {
    stageObserver.disconnect();
    stageObserver = null;
  }
  const el = viewerVideoEl.value;
  if (el) {
    el.removeEventListener('loadedmetadata', fitViewerVideo);
    el.removeEventListener('resize', fitViewerVideo);
  }
}

function attachLiveStream(el) {
  if (!el) return;
  el.addEventListener('playing', onLivePlaying, { once: true });
  livePlayer.attach(el);
}

/* ─── Fullscreen toggle (right sidebar) ─── */
// Page-fill view of the livestream stage, mirroring the Real Drone Host:
// the video covers the page, the docks stay clickable above it (z-index
// bump), and Esc exits. Only meaningful on the Livestream Viewer subpage —
// clicking it elsewhere opens that subpage first.
const liveFullscreen = ref(false);

function toggleLiveFullscreen() {
  if (selectedNav.value !== 'livestream') selectedNav.value = 'livestream';
  liveFullscreen.value = !liveFullscreen.value;
}

function onLiveEsc(e) {
  if (e.key === 'Escape') liveFullscreen.value = false;
}

watch(liveFullscreen, (fs) => {
  const el = viewerVideoEl.value;
  if (fs) {
    // CSS (object-fit: contain, full viewport) sizes the fullscreen video;
    // fitViewerVideo() is gated while fullscreen.
    if (el) {
      el.style.width = '';
      el.style.height = '';
    }
    document.addEventListener('keydown', onLiveEsc);
  } else {
    document.removeEventListener('keydown', onLiveEsc);
    fitViewerVideo(); // restore the panel-fit pixel size
  }
  // Reflect the state on the dock button (highlight + tooltip swap).
  const item = rightItems.find((i) => i.id === 'fullscreen');
  if (item) {
    item.active = fs;
    item.titleKey = fs ? 'aerialview.exit_fullscreen' : 'aerialview.fullscreen';
  }
});

/* ─── Screenshot / Screen Recording on the livestream video ─── */
// Same login gate and capture singleton (useLiveCapture) as the Real Drone
// Host page. The capture source is whichever stream the Livestream Viewer
// stage currently plays — a remote WHEP stream or the broadcaster's own
// camera preview. Off that subpage there is no video, so the guarded
// actions no-op with a console warning.
const { recorderState, isRecorderActive, captureScreenshot, toggleRecorder, stopRecorder } = useLiveCapture();

function activeVideoEl() {
  return selectedNav.value === 'livestream' ? viewerVideoEl.value : null;
}

const captureAuthNotice = ref(''); // '' | 'screenshot' | 'recording'
let captureAuthTimer = null;
function flashCaptureAuth(action) {
  captureAuthNotice.value = action;
  clearTimeout(captureAuthTimer);
  captureAuthTimer = setTimeout(() => { captureAuthNotice.value = ''; }, 6000);
}

function guardedScreenshot() {
  if (isAuthenticated.value) return captureScreenshot(activeVideoEl());
  flashCaptureAuth('screenshot');
}

function guardedToggleRecorder() {
  // Never trap an ACTIVE recording: toggling off is always allowed.
  if (isAuthenticated.value || recorderState.value !== 'idle') return toggleRecorder(activeVideoEl());
  flashCaptureAuth('recording');
}

/* ─── Browser broadcast (发起直播) ─── */
// Pure-browser publisher: getUserMedia → WHIP → MediaMTX. The session lives
// in a module-level singleton (useWhipBroadcast) so the broadcast survives
// subpage and route navigation — only 结束直播 / tab close / ICE failure
// ends it.
const {
  state: bcState, error: bcError, progress: bcProgress,
  startedAt: bcStartedAt, streamId: bcStreamId, localStream: bcLocalStream,
  startBroadcast, stopBroadcast,
} = useWhipBroadcast();

const broadcastNotice = ref('');

function sanitizeStreamName(name) {
  const slug = (name || '').toLowerCase().normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'user';
}

// The broadcaster's own catalog entry. Stream id: web-<username> — one
// broadcast per user; MediaMTX's overridePublisher handles reconnects.
const broadcastEntry = computed(() => {
  const u = user.value;
  const display = u?.display_name || (u?.email || '').split('@')[0] || 'user';
  const id = `web-${sanitizeStreamName(display)}`;
  return {
    id,
    hostname: display,
    description: t('chatview.broadcast_description'),
    whep_url: `${whepBase.value}/${id}/whep`,
  };
});

// The stage shows the broadcaster's own camera directly (no WHEP loopback)
// while their own card is selected and the stream is live.
const selfMonitor = computed(
  () => bcState.value === 'live'
    && !!selectedStream.value
    && selectedStream.value.id === bcStreamId.value,
);

function attachLocalPreview(el) {
  const stream = bcLocalStream.value;
  if (!el || !stream) return;
  if (el.srcObject !== stream) {
    el.srcObject = stream;
    el.play().catch(() => {});
  }
}

async function toggleBroadcast() {
  if (bcState.value === 'connecting') return;
  broadcastNotice.value = '';
  if (bcState.value === 'live') {
    stopBroadcast();
    selectedStreamId.value = null; // stage falls back to the primary stream
    return;
  }
  if (!isAuthenticated.value) {
    broadcastNotice.value = t('chatview.login_required_broadcast');
    return;
  }
  if (!user.value) await fetchMe().catch(() => {});
  const entry = broadcastEntry.value;
  await startBroadcast(entry);
  if (bcState.value === 'live') {
    selectedStreamId.value = entry.id; // self-monitor the new broadcast
  }
}

const bcErrorMsg = computed(() => {
  if (bcState.value !== 'error') return '';
  const keys = {
    permission: 'chatview.broadcast_err_permission',
    nodevice: 'chatview.broadcast_err_nodevice',
    device: 'chatview.broadcast_err_device',
    handshake: 'chatview.broadcast_err_handshake',
    connection: 'chatview.broadcast_err_connection',
  };
  return t(keys[bcError.value] || keys.handshake);
});

// Elapsed-time ticker for the LIVE badge + stage fallback when the
// broadcast ends/fails while being watched.
const bcElapsed = ref('');
let elapsedTimer = null;

function fmtElapsed(ms) {
  const s = Math.floor(ms / 1000);
  const pad = (n) => String(n).padStart(2, '0');
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`;
}

watch(bcState, (val) => {
  if (elapsedTimer) {
    clearInterval(elapsedTimer);
    elapsedTimer = null;
  }
  if (val === 'live') {
    bcElapsed.value = fmtElapsed(Date.now() - bcStartedAt.value);
    elapsedTimer = setInterval(() => {
      bcElapsed.value = fmtElapsed(Date.now() - bcStartedAt.value);
    }, 1000);
  } else {
    bcElapsed.value = '';
    if (val !== 'connecting'
      && selectedStreamId.value
      && selectedStreamId.value === bcStreamId.value) {
      selectedStreamId.value = null;
    }
    syncLiveStream();
  }
});

// (Re)point the stage at the selected stream. Card clicks and late-arriving
// server config both funnel through targetUrl; only act when the subpage is
// on screen. The broadcaster's own live stream is monitored directly from
// the camera (no WHEP loopback).
function syncLiveStream() {
  if (selectedNav.value !== 'livestream') return;
  if (selfMonitor.value) {
    playingUrl = '';
    livePlayer.stop();
    liveLoading.value = false;
    attachLocalPreview(viewerVideoEl.value);
    return;
  }
  if (!targetUrl.value || targetUrl.value === playingUrl) return;
  playingUrl = targetUrl.value;
  livePlayer.stop();
  attachLiveStream(viewerVideoEl.value);
  livePlayer.start();
}

watch(targetUrl, syncLiveStream);
watch(selfMonitor, syncLiveStream);

// While on the subpage, keep the catalog fresh so other users' browser
// broadcasts (merged from MediaMTX's active paths by the backend) appear.
let catalogTimer = null;

// Entering the subpage mounts the <video> and starts the connection;
// leaving tears both down (one stream at a time, no background bandwidth).
watch(selectedNav, async (val) => {
  if (val === 'livestream') {
    refreshStreams();
    if (!catalogTimer) catalogTimer = setInterval(refreshStreams, 30000);
    await nextTick();
    setupViewerStage();
    attachLiveStream(viewerVideoEl.value);
    syncLiveStream();
  } else {
    if (liveFullscreen.value) liveFullscreen.value = false; // stage unmounts
    if (catalogTimer) {
      clearInterval(catalogTimer);
      catalogTimer = null;
    }
    teardownViewerStage();
    livePlayer.stop();
    playingUrl = '';
    liveLoading.value = false;
  }
});

/* ─── Composer ─── */
const input = ref('');
const sending = ref(false);
const messagesRef = ref(null);

async function sendMessage() {
  const text = input.value.trim();
  if (!text || sending.value || !activeRoomId.value) return;
  sending.value = true;
  try {
    await sendText(text);
    input.value = '';
    await nextTick();
    scrollToBottom();
  } finally {
    sending.value = false;
  }
}

function handleKeydown(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
}

function onComposerInput() {
  noteTyping();
}

function scrollToBottom() {
  if (messagesRef.value) {
    messagesRef.value.scrollTop = messagesRef.value.scrollHeight;
  }
}

async function selectRoom(roomId) {
  setActiveRoom(roomId);
  await nextTick();
  scrollToBottom();
}

/* ─── New chat / team room dialog ─── */
const dialogMode = ref(''); // '' | 'dm' | 'team'
const teamName = ref('');
const teamSelection = ref([]);

function openDialog(mode) {
  dialogMode.value = mode;
  teamName.value = '';
  teamSelection.value = [];
  fetchDirectory();
}

function isTeamSelected(entry) {
  return teamSelection.value.some((e) => e.mxid === entry.mxid);
}

function toggleTeamMember(entry) {
  if (isTeamSelected(entry)) {
    teamSelection.value = teamSelection.value.filter((e) => e.mxid !== entry.mxid);
  } else {
    teamSelection.value = [...teamSelection.value, entry];
  }
}

async function startDm(entry) {
  dialogMode.value = '';
  await createDm(entry);
  await nextTick();
  scrollToBottom();
}

async function createTeam() {
  if (!teamName.value.trim() || !teamSelection.value.length) return;
  const entries = [...teamSelection.value];
  dialogMode.value = '';
  await createTeamRoom(teamName.value, entries);
  await nextTick();
  scrollToBottom();
}

function initials(name) {
  return (name || '?').trim().charAt(0).toUpperCase() || '?';
}

/* ─── Formatting ─── */
function timeFmt(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function dayFmt(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const today = new Date();
  return d.toDateString() === today.toDateString()
    ? timeFmt(ts)
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

const typingText = computed(() => {
  const names = typingNames.value;
  if (!names.length) return '';
  if (names.length === 1) return t('chatview.typing_one', { name: names[0] });
  return t('chatview.typing_many', { names: names.join(', ') });
});

onMounted(() => {
  registerPage({ id: 'aerial', nameKey: 'aerialview.page_aerial', route: '/' });
  registerPage({ id: 'map', nameKey: 'aerialview.page_map', route: '/map' });
  registerPage({ id: 'routeplanning', nameKey: 'aerialview.page_routeplanning', route: '/route-planning' });
  registerPage({ id: 'realdrone', nameKey: 'aerialview.page_realdrone', route: '/real-drone' });
  registerPage({ id: 'extensions', nameKey: 'aerialview.page_extensions', route: '/extensions' });
  registerPage({ id: 'chat', nameKey: 'aerialview.page_chat', route: '/chat' });
  registerPage({ id: 'myspace', nameKey: 'aerialview.page_myspace', route: '/myspace' });

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
    id: 'livestream_viewer',
    icon: 'MENU_LIVESTREAM_VIEWER',
    titleKey: 'chatview.nav_livestream',
    active: computed(() => selectedNav.value === 'livestream'),
    onClick: () => { selectedNav.value = 'livestream'; },
  });
  registerLeft({
    id: 'gallery',
    icon: 'MENU_GALLARY',
    titleKey: 'chatview.nav_gallery',
    active: computed(() => selectedNav.value === 'gallery'),
    onClick: () => { selectedNav.value = 'gallery'; },
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
    id: 'customer_service',
    icon: 'MENU_CUSTOMER_SERVICE',
    titleKey: 'chatview.nav_customer_service',
    active: computed(() => selectedNav.value === 'customer_service'),
    onClick: () => { router.push('/customer-service'); },
  });

  // Register right dock buttons — same Screenshot / Screen Recording /
  // Fullscreen trio as the Real Drone Livestream Host right sidebar.
  registerRight({
    id: 'screenshot',
    icon: 'MENU_PHOTO',
    titleKey: 'aerialview.screenshot',
    onClick: guardedScreenshot,
  });
  registerRight({
    id: 'recorder',
    icon: 'MENU_RECORDER',
    titleKey: 'aerialview.recorder',
    active: isRecorderActive,
    danger: true,
    onClick: guardedToggleRecorder,
  });
  registerRight({
    id: 'fullscreen',
    icon: 'MENU_WINDOW_SIZE',
    titleKey: 'aerialview.fullscreen',
    active: false,
    onClick: toggleLiveFullscreen,
  });

  // Community is the only Matrix entrance. The login/logout lockstep watch
  // lives at module scope in useMatrixClient (never unmounts); here we just
  // kick off the initial bootstrap + directory when already logged in.
  if (isAuthenticated.value) {
    bootstrap();
    fetchDirectory();
  }
});

onUnmounted(() => {
  teardownViewerStage();
  livePlayer.stop();
  stopRecorder(); // an active clip still downloads via the recorder's onstop
  clearTimeout(captureAuthTimer);
  document.removeEventListener('keydown', onLiveEsc);
  if (catalogTimer) {
    clearInterval(catalogTimer);
    catalogTimer = null;
  }
  if (elapsedTimer) {
    clearInterval(elapsedTimer);
    elapsedTimer = null;
  }
  // NOTE: an active browser broadcast is NOT stopped here — it lives in a
  // module-level singleton and survives navigation by design.
  clear();
  unregisterPage('aerial');
  unregisterPage('realdrone');
  unregisterPage('map');
  unregisterPage('routeplanning');
  unregisterPage('myspace');
  unregisterPage('chat');
  unregisterPage('extensions');
});
</script>

<template>
  <ViewComposer
    :class="{ 'live-fullscreen-active': liveFullscreen }"
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
          <!-- Chat: room list -->
          <template v-if="selectedNav === 'chat'">
            <div class="sidebar-actions">
              <button class="sidebar-action" :disabled="!chatReady" @click="openDialog('dm')">
                + {{ t('chatview.new_chat') }}
              </button>
              <button class="sidebar-action" :disabled="!chatReady" @click="openDialog('team')">
                + {{ t('chatview.new_team_room') }}
              </button>
            </div>

            <div v-if="dms.length" class="room-section">
              <h3 class="room-section-title">{{ t('chatview.direct_messages') }}</h3>
              <button
                v-for="room in dms"
                :key="room.roomId"
                class="room-item"
                :class="{ 'room-item--active': room.roomId === activeRoomId }"
                @click="selectRoom(room.roomId)"
              >
                <span class="room-avatar">{{ initials(room.name) }}</span>
                <span class="room-meta">
                  <span class="room-name">{{ room.name }}</span>
                  <span class="room-preview">{{ room.preview }}</span>
                </span>
                <span class="room-time">{{ dayFmt(room.lastTs) }}</span>
              </button>
            </div>

            <div v-if="teamRooms.length" class="room-section">
              <h3 class="room-section-title">{{ t('chatview.team_rooms') }}</h3>
              <button
                v-for="room in teamRooms"
                :key="room.roomId"
                class="room-item"
                :class="{ 'room-item--active': room.roomId === activeRoomId }"
                @click="selectRoom(room.roomId)"
              >
                <span class="room-avatar room-avatar--team">{{ initials(room.name) }}</span>
                <span class="room-meta">
                  <span class="room-name">{{ room.name }}</span>
                  <span class="room-preview">{{ room.preview || t('chatview.members_count', { count: room.members }) }}</span>
                </span>
                <span class="room-time">{{ dayFmt(room.lastTs) }}</span>
              </button>
            </div>

            <p v-if="chatReady && !dms.length && !teamRooms.length" class="sidebar-empty">
              {{ t('chatview.no_conversations') }}
            </p>
          </template>

          <!-- Contacts stub (untouched for now) -->
          <p v-else-if="selectedNav === 'contacts'" class="sidebar-empty">
            {{ t('chatview.contacts_stub') }}
          </p>

          <!-- Gallery stub (untouched for now) -->
          <p v-else-if="selectedNav === 'gallery'" class="sidebar-empty">
            {{ t('chatview.gallery_stub') }}
          </p>

          <!-- Livestream Viewer: broadcast button + stream catalog -->
          <div v-else-if="selectedNav === 'livestream'" class="stream-list">
            <button
              class="broadcast-btn"
              :class="{
                'broadcast-btn--live': bcState === 'live',
                'broadcast-btn--busy': bcState === 'connecting',
              }"
              :disabled="bcState === 'connecting'"
              @click="toggleBroadcast"
            >
              {{ bcState === 'live' ? t('chatview.stop_broadcast') : t('chatview.start_broadcast') }}
            </button>

            <div
              v-for="s in streams"
              :key="s.id"
              class="stream-card"
              :class="{ 'stream-card--active': s.id === selectedStream?.id }"
              @click="selectedStreamId = s.id"
            >
              <div class="stream-card__head">
                <span class="stream-card__title">{{ s.hostname }}</span>
                <span
                  v-if="s.live || (bcState === 'live' && s.id === bcStreamId)"
                  class="stream-card__live"
                >
                  LIVE<span v-if="s.id === bcStreamId && bcElapsed"> · {{ bcElapsed }}</span>
                </span>
              </div>
              <p class="stream-card__desc">{{ s.description }}</p>
            </div>
          </div>
        </aside>

        <!-- Divider (draggable) -->
        <div
          class="community-divider"
          @pointerdown="onDividerPointerDown"
        />

        <!-- Right content area -->
        <main class="community-content">
          <!-- Livestream Viewer stage (moved from Real Drone) -->
          <div v-if="selectedNav === 'livestream'" class="viewer-stage">
            <video
              ref="viewerVideoEl"
              class="viewer-live"
              :class="{
                'viewer-live--mirror': selfMonitor,
                'viewer-live--fullscreen': liveFullscreen,
              }"
              autoplay
              muted
              playsinline
            />
            <div v-if="selfMonitor" class="viewer-live-badge">
              ● LIVE<span v-if="bcElapsed"> · {{ bcElapsed }}</span>
            </div>
            <div
              v-if="broadcastNotice || bcErrorMsg"
              class="viewer-notice"
              :class="{ 'viewer-notice--error': bcErrorMsg }"
            >
              {{ broadcastNotice || bcErrorMsg }}
            </div>
          </div>

          <template v-else>
          <!-- Login gate: same green-banner pattern as the Save/capture gates -->
          <template v-if="!isAuthenticated">
            <div class="chat-notice chat-notice--green">
              {{ t('chatview.login_required') }}
            </div>
            <div class="chat-empty">
              <p>{{ t('chatview.select_room') }}</p>
            </div>
          </template>

          <!-- Backend/Synapse unavailable -->
          <template v-else-if="chatError === 'unavailable'">
            <div class="chat-notice chat-notice--red">
              {{ t('chatview.unavailable') }}
            </div>
            <div class="chat-empty">
              <button class="sidebar-action" @click="bootstrap">{{ t('chatview.retry') }}</button>
            </div>
          </template>

          <!-- Connecting -->
          <template v-else-if="!chatReady">
            <div class="chat-empty">
              <p>{{ t('chatview.connecting') }}</p>
            </div>
          </template>

          <!-- Ready -->
          <template v-else>
            <!-- Chat header -->
            <header class="chat-header">
              <h1 class="chat-header-title">
                {{ activeRoom ? activeRoom.name : t('chatview.conversations') }}
              </h1>
              <span class="chat-status">{{ t('chatview.online') }}</span>
            </header>

            <!-- No room selected -->
            <div v-if="!activeRoom" class="chat-empty">
              <p>{{ t('chatview.select_room') }}</p>
            </div>

            <!-- Messages -->
            <template v-else>
              <div ref="messagesRef" class="messages">
                <div
                  v-for="msg in timeline"
                  :key="msg.id"
                  class="message-wrapper"
                  :class="msg.mine ? 'message-wrapper--user' : 'message-wrapper--bot'"
                >
                  <div class="message-bubble" :class="msg.mine ? 'message-bubble--user' : 'message-bubble--bot'">
                    <span v-if="!msg.mine && !activeRoom.isDm" class="message-sender">{{ msg.senderName }}</span>
                    <p class="message-text">{{ msg.body }}</p>
                    <span class="message-time">{{ timeFmt(msg.ts) }}</span>
                  </div>
                </div>
              </div>

              <!-- Typing indicator -->
              <div v-if="typingText" class="typing-indicator">{{ typingText }}</div>

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
                  @input="onComposerInput"
                />
                <button class="send-btn" :title="t('chatview.send')" :disabled="sending" @click="sendMessage">
                  <ConfigurableIcon name="CHAT_SEND" :size="18" />
                </button>
              </footer>
            </template>
          </template>
          </template>
        </main>

        <!-- New chat / team room dialog -->
        <div v-if="dialogMode" class="chat-modal-overlay" @click.self="dialogMode = ''">
          <div class="chat-modal">
            <h2 class="chat-modal-title">
              {{ dialogMode === 'dm' ? t('chatview.new_chat') : t('chatview.new_team_room') }}
            </h2>
            <input
              v-if="dialogMode === 'team'"
              v-model="teamName"
              class="chat-modal-input"
              :placeholder="t('chatview.team_name_placeholder')"
            />
            <p class="chat-modal-label">
              {{ dialogMode === 'dm' ? t('chatview.pick_member_dm') : t('chatview.pick_members_team') }}
            </p>
            <div class="chat-modal-list">
              <p v-if="!directory.length" class="chat-modal-empty">
                {{ t('chatview.no_members_hint') }}
              </p>
              <button
                v-for="entry in directory"
                :key="entry.mxid"
                class="chat-modal-member"
                :class="{ 'chat-modal-member--selected': dialogMode === 'team' && isTeamSelected(entry) }"
                @click="dialogMode === 'dm' ? startDm(entry) : toggleTeamMember(entry)"
              >
                <span class="room-avatar">{{ initials(entry.display_name) }}</span>
                <span class="member-name">{{ entry.display_name }}</span>
                <span v-if="dialogMode === 'team' && isTeamSelected(entry)" class="member-check">✓</span>
              </button>
            </div>
            <div class="chat-modal-actions">
              <button class="btn-cancel" @click="dialogMode = ''">{{ t('chatview.cancel') }}</button>
              <button
                v-if="dialogMode === 'team'"
                class="btn-create"
                :disabled="!teamName.trim() || !teamSelection.length"
                @click="createTeam"
              >
                {{ t('chatview.create') }}
              </button>
            </div>
          </div>
        </div>
      </div>
    </template>

    <template #top-overlay>
      <!-- Login reminder for Screenshot / Recorder (same gate as Real Drone) -->
      <div
        v-if="captureAuthNotice"
        class="top-center-message top-center-message--auth"
      >
        {{ t(`aerialview.auth_notice_${captureAuthNotice}`) }}
      </div>
      <!-- Green progress pill while a stream connection / broadcast is set up -->
      <div v-if="liveLoading || bcState === 'connecting'" class="top-center-message asset-loading">
        <span>{{ t('aerialview.loading_livestream') }}</span>
        <div class="asset-loading__track">
          <div
            class="asset-loading__fill"
            :style="{ width: ((bcState === 'connecting' ? bcProgress : liveProgress) * 100).toFixed(1) + '%' }"
          />
        </div>
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
  /* Clear the dock strips on both sides: 24px _ViewComposer padding + 72px
     AppDock = 96px. The docks (z-index 10, pointer-events auto) overlay the
     page, so any interactive content in the outer 96px would have its clicks
     eaten by the dock container. */
  padding: 0 96px;
  box-sizing: border-box;
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

.sidebar-actions {
  display: flex;
  gap: 8px;
  padding: 16px 16px 8px;
}

.sidebar-action {
  flex: 1;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid rgba(209, 213, 219, 0.9);
  background: #ffffff;
  color: #1d1d1f;
  font-size: 0.82rem;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s ease;
}

.sidebar-action:hover:not(:disabled) {
  background: #eef2f7;
}

.sidebar-action:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.room-section {
  padding: 8px 8px 0;
}

.room-section-title {
  margin: 8px 8px 6px;
  font-size: 0.72rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: #6e6e73;
}

.room-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 9px 10px;
  border: none;
  border-radius: 10px;
  background: transparent;
  cursor: pointer;
  text-align: left;
  transition: background 0.12s ease;
}

.room-item:hover {
  background: rgba(0, 0, 0, 0.05);
}

.room-item--active {
  background: rgba(59, 130, 246, 0.12);
}

.room-avatar {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: #3b82f6;
  color: #ffffff;
  font-size: 0.9rem;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.room-avatar--team {
  background: #8b5cf6;
}

.room-meta {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.room-name {
  font-size: 0.88rem;
  font-weight: 600;
  color: #1d1d1f;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.room-preview {
  font-size: 0.75rem;
  color: #6e6e73;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.room-time {
  font-size: 0.7rem;
  color: #9ca3af;
  flex-shrink: 0;
}

.sidebar-empty {
  padding: 24px 20px;
  font-size: 0.85rem;
  color: #6e6e73;
  text-align: center;
  line-height: 1.5;
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

/* ─── Notice banners (green matches the Save/capture gates) ─── */
.chat-notice {
  margin: 16px 24px 0;
  padding: 10px 14px;
  border-radius: 8px;
  font-size: 0.85rem;
  line-height: 1.4;
}

.chat-notice--green {
  background: #e8f7ee;
  border: 1px solid #b7e4c7;
  color: #1a7f37;
}

.chat-notice--red {
  background: #fdecec;
  border: 1px solid #f5c2c2;
  color: #b3261e;
}

.chat-empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #6e6e73;
  font-size: 0.9rem;
  gap: 12px;
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
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.chat-status {
  font-size: 0.75rem;
  font-weight: 600;
  color: #16a34a;
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
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

.message-wrapper--bot {
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

.message-sender {
  font-size: 0.72rem;
  font-weight: 700;
  color: #6d28d9;
}

.message-text {
  margin: 0;
  line-height: 1.5;
  font-size: 0.95rem;
  user-select: text;
  white-space: pre-wrap;
  word-break: break-word;
}

.message-time {
  font-size: 0.7rem;
  opacity: 0.7;
  align-self: flex-end;
}

.typing-indicator {
  padding: 0 24px 6px;
  font-size: 0.75rem;
  font-style: italic;
  color: #6e6e73;
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

.send-btn:hover:not(:disabled) {
  background: #2563eb;
}

.send-btn:disabled {
  opacity: 0.6;
  cursor: default;
}

/* ─── New chat / team room dialog ─── */
.chat-modal-overlay {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.35);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 20;
}

.chat-modal {
  width: 380px;
  max-height: 70vh;
  background: #ffffff;
  border-radius: 14px;
  box-shadow: 0 20px 50px rgba(0, 0, 0, 0.2);
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.chat-modal-title {
  margin: 0;
  font-size: 1.05rem;
  font-weight: 700;
  color: #1d1d1f;
}

.chat-modal-input {
  padding: 10px 14px;
  border-radius: 8px;
  border: 1px solid rgba(209, 213, 219, 0.9);
  font-size: 0.9rem;
  outline: none;
}

.chat-modal-input:focus {
  border-color: #3b82f6;
}

.chat-modal-label {
  margin: 0;
  font-size: 0.78rem;
  font-weight: 600;
  color: #6e6e73;
}

.chat-modal-list {
  flex: 1;
  min-height: 80px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.chat-modal-empty {
  padding: 20px 8px;
  font-size: 0.82rem;
  color: #6e6e73;
  text-align: center;
}

.chat-modal-member {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border: none;
  border-radius: 8px;
  background: transparent;
  cursor: pointer;
  text-align: left;
  transition: background 0.12s ease;
}

.chat-modal-member:hover {
  background: rgba(0, 0, 0, 0.05);
}

.chat-modal-member--selected {
  background: rgba(59, 130, 246, 0.12);
}

.member-name {
  flex: 1;
  font-size: 0.9rem;
  font-weight: 600;
  color: #1d1d1f;
}

.member-check {
  color: #3b82f6;
  font-weight: 700;
}

.chat-modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.btn-cancel,
.btn-create {
  padding: 8px 16px;
  border-radius: 8px;
  font-size: 0.85rem;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s ease;
}

.btn-cancel {
  border: 1px solid rgba(209, 213, 219, 0.9);
  background: #ffffff;
  color: #1d1d1f;
}

.btn-cancel:hover {
  background: #f3f4f6;
}

.btn-create {
  border: none;
  background: #3b82f6;
  color: #ffffff;
}

.btn-create:hover:not(:disabled) {
  background: #2563eb;
}

.btn-create:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* ─── Livestream Viewer (moved from Real Drone) ─── */
.stream-list {
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.stream-card {
  background: #ffffff;
  border: 1px solid #e5e5ea;
  border-radius: 10px;
  padding: 12px 14px;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
  cursor: pointer;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}

.stream-card:hover {
  border-color: #007aff;
}

/* The card whose stream is playing in the right panel. */
.stream-card--active {
  border-color: #007aff;
  box-shadow: 0 0 0 3px rgba(0, 122, 255, 0.15);
}

.stream-card__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.stream-card__title {
  font-weight: 700;
  font-size: 0.95rem;
  color: #1c1c1e;
  word-break: break-all;
}

.stream-card__desc {
  margin: 6px 0 0;
  font-weight: 300;
  font-size: 0.8rem;
  color: #8e8e93;
  line-height: 1.4;
}

.viewer-stage {
  flex: 1;
  min-height: 0;
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  background: #ffffff;
}

.viewer-live {
  display: block; /* pixel width/height set by fitViewerVideo() */
}

/* ─── Livestream connection progress pill (mirrors RealDroneView) ─── */
.top-center-message {
  position: fixed;
  top: 24px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 100;
  padding: 12px 28px;
  border-radius: 8px;
  font-family: Calibri, 'Segoe UI', sans-serif;
  font-size: 0.77rem;
  font-weight: 700;
  color: #ffffff;
  white-space: nowrap;
  pointer-events: none;
  text-align: center;
}

.top-center-message--auth {
  background: rgba(34, 197, 94, 0.92);
  box-shadow: 0 0 18px rgba(34, 197, 94, 0.6);
}

.asset-loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  background: rgba(34, 197, 94, 0.88);
  box-shadow: 0 0 18px rgba(34, 197, 94, 0.6);
}

.asset-loading__track {
  width: 240px;
  height: 6px;
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.3);
  overflow: hidden;
}

.asset-loading__fill {
  height: 100%;
  border-radius: 3px;
  background: #ffffff;
  transition: width 0.15s linear;
}

/* ─── Browser broadcast (发起直播) ─── */
.broadcast-btn {
  width: 100%;
  padding: 10px 14px;
  border-radius: 10px;
  border: none;
  background: linear-gradient(135deg, #3b82f6, #2563eb);
  color: #ffffff;
  font-size: 0.92rem;
  font-weight: 700;
  cursor: pointer;
  transition: opacity 0.15s ease;
}

.broadcast-btn:hover:not(:disabled) {
  opacity: 0.9;
}

.broadcast-btn:disabled {
  opacity: 0.6;
  cursor: wait;
}

.broadcast-btn--live {
  background: linear-gradient(135deg, #ef4444, #dc2626);
}

.stream-card__live {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  border-radius: 999px;
  background: rgba(239, 68, 68, 0.12);
  color: #dc2626;
  font-size: 0.68rem;
  font-weight: 800;
  letter-spacing: 0.04em;
}

.viewer-live--mirror {
  transform: scaleX(-1);
}

/* Fullscreen livestream: cover the page for a clean viewing. The docks get
   a z-index bump (below) so the toggle stays clickable above the video. */
.viewer-live--fullscreen {
  position: fixed;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: contain;
  background: #000;
  z-index: 100;
}

.live-fullscreen-active :deep(.app-dock) {
  z-index: 101;
}

.viewer-live-badge {
  position: absolute;
  top: 14px;
  left: 16px;
  padding: 4px 12px;
  border-radius: 999px;
  background: rgba(220, 38, 38, 0.9);
  color: #ffffff;
  font-size: 0.75rem;
  font-weight: 800;
  letter-spacing: 0.04em;
  pointer-events: none;
}

.viewer-notice {
  position: absolute;
  bottom: 20px;
  left: 50%;
  transform: translateX(-50%);
  max-width: 80%;
  padding: 10px 18px;
  border-radius: 8px;
  background: #e8f7ee;
  border: 1px solid #b7e4c7;
  color: #1a7f37;
  font-size: 0.85rem;
  line-height: 1.4;
  text-align: center;
}

.viewer-notice--error {
  background: #fdecec;
  border-color: #f5c2c2;
  color: #b3261e;
}
</style>
