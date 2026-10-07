<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { useI18n } from 'vue-i18n';
import LoadingSpinner from '@shared/LoadingSpinner.vue';

// In-app game intro / briefing overlay. It is rendered inside AerialView, so
// its absolutely-positioned box resolves against `.shell-main` and is confined
// to the main panel — the top bar, left nav, and right assistant stay visible.
// It plays the game's intro clips in sequence and dismisses when they finish
// (optionally gated on the 3D scene being ready so it never reveals an empty
// globe). Skip and the fallback timeout always win.
const { t } = useI18n();

const props = defineProps({
  // Ordered list of intro video URLs (per-game content; see config/gameIntro.js).
  clips: { type: Array, default: () => [] },
  // Localized one-line slogan shown near the bottom.
  slogan: { type: String, default: '' },
  // Optional soundtrack looped beneath the clips. When present the clips are
  // muted (the music is the audio); when absent the clips play their own audio.
  music: { type: String, default: '' },
  // Hold auto-dismissal until the scene reports ready (window.__cesiumReady /
  // the 'cesiumReady' event), so the intro never reveals an empty globe.
  minSceneReady: { type: Boolean, default: true },
  // Safety cap: dismiss regardless after this long (ms) if the scene never
  // reports ready.
  fallbackMs: { type: Number, default: 45000 },
});

const emit = defineEmits(['dismissed']);

const vidEl = ref(null);
const index = ref(0);
const muted = ref(false);
const fading = ref(false);
const progress = ref(0); // 0..1 across the whole playlist

let dismissed = false;
const clipsDone = ref(false);
const sceneReady = ref(typeof window !== 'undefined' && window.__cesiumReady === true);
// True once the current intro clip has buffered enough to play (its @canplay
// fired). Until then — and again after the clips end while the 3D scene is
// still streaming — the overlay shows a black "please wait" spinner instead of
// a blank panel with no feedback.
const clipPlayable = ref(false);
let musicEl = null;
let fallbackTimer = null;
let finalizeTimer = null;
let finalized = false;
let gestureUnlock = null;

const hasClips = computed(() => Array.isArray(props.clips) && props.clips.length > 0);
const current = computed(() => (hasClips.value ? props.clips[index.value] : ''));
const videoMuted = computed(() => (props.music ? true : muted.value));
const progressPct = computed(() => `${Math.round(progress.value * 100)}%`);

// Black-screen + spinner "please wait" state. Shows whenever the overlay has
// nothing to present yet:
//   • clips exist but the first one has not reached @canplay (still downloading), OR
//   • there are no clips and the 3D scene is not ready, OR
//   • the clips have finished but minSceneReady is gating dismissal on a scene
//     that is still streaming.
// It clears the instant a clip becomes playable (the video takes over) and again
// drives the wait after the playlist ends if the globe is not ready. Skip and the
// fallback timer always win, so this can never trap the user.
const showWait = computed(() => {
  if (fading.value) return false;
  if (!hasClips.value) return !sceneReady.value;
  if (!clipPlayable.value) return true;
  return clipsDone.value && props.minSceneReady && !sceneReady.value;
});

function loadInitialVolume() {
  try {
    const raw = localStorage.getItem('app-settings');
    if (raw) {
      const v = Number(JSON.parse(raw).audioVolume);
      if (!isNaN(v)) return Math.max(0, Math.min(1, v));
    }
  } catch {
    /* ignore */
  }
  return 0.9;
}

function playVideo() {
  const v = vidEl.value;
  if (!v) return;
  v.muted = videoMuted.value;
  const p = v.play();
  if (p && typeof p.catch === 'function') {
    p.catch(() => {
      // Autoplay with sound was blocked (e.g. a hard deep-link load with no
      // user gesture). When the clip carries the audio, retry muted so the
      // visuals still run; when music carries it, startMusic handles unlock.
      if (!props.music) {
        v.muted = true;
        v.play().catch(() => {});
      }
    });
  }
}

function onCanPlay() {
  clipPlayable.value = true;
  playVideo();
}

function onEnded() {
  if (index.value < props.clips.length - 1) {
    index.value += 1; // the :src binding swaps; @canplay plays the next clip
  } else {
    clipsDone.value = true;
    tryDismiss();
  }
}

function onTimeUpdate() {
  const v = vidEl.value;
  if (!v || !v.duration || !hasClips.value) return;
  const within = Math.min(1, Math.max(0, v.currentTime / v.duration));
  progress.value = (index.value + within) / props.clips.length;
}

function applyMute() {
  if (musicEl) {
    musicEl.muted = muted.value;
    if (muted.value) musicEl.pause();
    else musicEl.play().catch(() => {});
  }
  const v = vidEl.value;
  if (v) v.muted = videoMuted.value;
}

function startMusic() {
  if (!props.music) return;
  musicEl = new Audio(props.music);
  musicEl.loop = true;
  musicEl.volume = loadInitialVolume();
  if (muted.value) return;
  const p = musicEl.play();
  if (p && typeof p.catch === 'function') {
    p.catch(() => {
      // Blocked until a user gesture; start on the first click/touch.
      gestureUnlock = () => {
        if (musicEl && !muted.value) musicEl.play().catch(() => {});
        if (gestureUnlock) {
          document.removeEventListener('click', gestureUnlock);
          document.removeEventListener('touchstart', gestureUnlock);
          gestureUnlock = null;
        }
      };
      document.addEventListener('click', gestureUnlock);
      document.addEventListener('touchstart', gestureUnlock);
    });
  }
}

function toggleMute() {
  muted.value = !muted.value;
  applyMute();
}

function onCesiumReady() {
  sceneReady.value = true;
  tryDismiss();
}

function tryDismiss() {
  if (dismissed || !clipsDone.value) return;
  if (props.minSceneReady && !sceneReady.value) return; // wait for the scene (or skip / fallback)
  dismiss();
}

function requestSkip() {
  dismiss();
}

function dismiss() {
  if (dismissed) return;
  dismissed = true;
  fading.value = true;
  fadeOutMusic(800);
  // Emit after the fade; guard with a timer in case transitionend is missed.
  finalizeTimer = setTimeout(finalize, 1000);
}

function onTransitionEnd(e) {
  if (e.target === e.currentTarget) finalize();
}

function finalize() {
  if (finalized) return;
  finalized = true;
  if (finalizeTimer) {
    clearTimeout(finalizeTimer);
    finalizeTimer = null;
  }
  const v = vidEl.value;
  if (v) v.pause();
  emit('dismissed');
}

function fadeOutMusic(duration = 800) {
  if (!musicEl) return;
  const el = musicEl;
  const start = el.volume || 0;
  const t0 = performance.now();
  function step(now) {
    const k = Math.min(1, (now - t0) / duration);
    el.volume = Math.max(0, start * (1 - k));
    if (k < 1) requestAnimationFrame(step);
    else {
      el.pause();
      el.currentTime = 0;
    }
  }
  requestAnimationFrame(step);
}

onMounted(() => {
  window.addEventListener('cesiumReady', onCesiumReady);
  startMusic();
  fallbackTimer = setTimeout(() => {
    if (!dismissed) dismiss();
  }, props.fallbackMs);
  // Nothing to show (no clips): treat as done so the scene-ready gate applies.
  if (!hasClips.value) {
    clipsDone.value = true;
    tryDismiss();
  }
});

onBeforeUnmount(() => {
  window.removeEventListener('cesiumReady', onCesiumReady);
  if (fallbackTimer) clearTimeout(fallbackTimer);
  if (finalizeTimer) clearTimeout(finalizeTimer);
  if (gestureUnlock) {
    document.removeEventListener('click', gestureUnlock);
    document.removeEventListener('touchstart', gestureUnlock);
    gestureUnlock = null;
  }
  if (musicEl) {
    musicEl.pause();
    musicEl.removeAttribute('src');
    musicEl.load();
    musicEl = null;
  }
  const v = vidEl.value;
  if (v) v.pause();
});
</script>

<template>
  <div class="splash" :class="{ 'splash--fading': fading }" @transitionend="onTransitionEnd">
    <video
      v-if="hasClips"
      ref="vidEl"
      class="splash__video"
      :src="current"
      :muted="videoMuted"
      playsinline
      autoplay
      preload="auto"
      @canplay="onCanPlay"
      @ended="onEnded"
      @timeupdate="onTimeUpdate"
    ></video>
    <div v-else class="splash__empty">{{ t('splashoverlay.loading') }}</div>

    <!-- Black "please wait" veil + the app-wide spinning wheel, shown while the
         intro clips are still downloading and/or the 3D scene has not streamed
         in (see showWait). Sits above the video / slogan / progress but below
         Skip and Mute, so those controls stay reachable while waiting. -->
    <div
      v-if="showWait"
      class="splash__wait"
      role="status"
      aria-busy="true"
      :aria-label="t('splashoverlay.loading')"
    >
      <LoadingSpinner />
    </div>

    <div class="splash__progress">
      <div class="splash__progress-bar" :style="{ width: progressPct }"></div>
    </div>

    <p v-if="slogan" class="splash__slogan">{{ slogan }}</p>

    <button class="splash__skip" type="button" @click="requestSkip">
      {{ t('splashoverlay.skip') }}
    </button>

    <button
      class="splash__mute"
      type="button"
      :aria-label="muted ? t('splashoverlay.unmute') : t('splashoverlay.mute')"
      :title="muted ? t('splashoverlay.unmute') : t('splashoverlay.mute')"
      @click="toggleMute"
    >
      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
        <path d="M4 9v6h4l5 4V5L8 9H4z" fill="currentColor" />
        <path
          v-if="!muted"
          d="M16.5 8.5a5 5 0 0 1 0 7"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
        />
        <path
          v-else
          d="M16.5 9.5l4 5M20.5 9.5l-4 5"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
        />
      </svg>
    </button>
  </div>
</template>

<style scoped>
.splash {
  position: absolute;
  inset: 0;
  /* High, but contained within .shell-main's stacking context (z-index:0), so
     it covers the in-panel HUD/disks yet can never escape over the top bar,
     left nav, or right assistant. */
  z-index: 5000;
  background: #000;
  overflow: hidden;
  pointer-events: auto;
  opacity: 1;
  transition: opacity 0.8s ease;
}

.splash--fading {
  opacity: 0;
  pointer-events: none;
}

.splash__video {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.splash__empty {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #f5f5f7;
  font-size: 0.95rem;
}

/* Opaque black veil that hides a not-yet-playable clip (or a frozen last frame)
   and centres the shared spinner. Above the video / slogan / progress (all
   z-auto); below Skip / Mute (z-index 3) so the escape hatch stays clickable. */
.splash__wait {
  position: absolute;
  inset: 0;
  z-index: 2;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #000;
}

.splash__progress {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 3px;
  background: rgba(255, 255, 255, 0.18);
}

.splash__progress-bar {
  height: 100%;
  width: 0;
  background: rgba(255, 255, 255, 0.75);
  transition: width 0.2s linear;
}

.splash__slogan {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 48px;
  margin: 0;
  padding: 0 24px;
  text-align: center;
  color: #ffffff;
  font-weight: 300;
  letter-spacing: 0.06em;
  font-size: clamp(1.2rem, 3vw, 2rem);
  text-shadow: 0 2px 10px rgba(0, 0, 0, 0.7);
  pointer-events: none;
}

.splash__skip {
  position: absolute;
  top: 16px;
  right: 16px;
  z-index: 3;
  padding: 7px 16px;
  border: 1px solid rgba(255, 255, 255, 0.5);
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.35);
  color: #ffffff;
  font-size: 0.85rem;
  font-weight: 600;
  cursor: pointer;
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
}

.splash__skip:hover {
  background: rgba(255, 255, 255, 0.18);
}

.splash__mute {
  position: absolute;
  bottom: 20px;
  right: 20px;
  z-index: 3;
  width: 40px;
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 1px solid rgba(255, 255, 255, 0.4);
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.35);
  color: #ffffff;
  cursor: pointer;
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
}

.splash__mute:hover {
  background: rgba(255, 255, 255, 0.18);
}
</style>
