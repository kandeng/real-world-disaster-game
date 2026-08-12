<script setup>
import { ref, watch, nextTick, onBeforeUnmount } from 'vue';

// Full-screen FPV clip splash for the Real Drone page, shown while the
// connection to the crazyflie_bridge fails. Mirrors the initial page splash
// (public/splash.js): sequential clips with a dual-video cross-fade, shuffled
// playlist and a per-clip time cap, fading out once the live stream connects.
// Sits at z-index 2 — above the page's live video, but BELOW the Flight disk
// (z 5), the docks (z 10), the HUD (z 50) and the reminder pill (z 100), so
// all sidebars/controls stay visible and clickable over the clips. The
// two-line deployment reminder is shown by the pill, not by this splash.
const props = defineProps({ visible: { type: Boolean, default: false } });

const CLIPS = [
  '/fpv/fpv_bicycle.mp4',
  '/fpv/fpv_cliff.mp4',
  '/fpv/fpv_creek.mp4',
  '/fpv/fpv_shore.mp4',
];
// Same cap as the initial splash: a single clip never holds the screen longer.
const MAX_CLIP_MS = 15000;

const videoA = ref(null);
const videoB = ref(null);

let playlist = [];
let current = 0;
let active = null; // <video> currently visible & playing
let standby = null; // <video> buffering the next clip (hidden)
let clipTimer = null;
let teardownTimer = null;
let running = false;

function shuffle(arr) {
  const copy = arr.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function clearClipTimer() {
  if (clipTimer) {
    clearTimeout(clipTimer);
    clipTimer = null;
  }
}

function startClipTimer() {
  clearClipTimer();
  clipTimer = setTimeout(nextClip, MAX_CLIP_MS);
}

/** Fully stop a video element and abort any in-flight download. */
function stopVideo(el) {
  if (!el) return;
  el.onended = null;
  el.pause();
  el.removeAttribute('src');
  el.load();
}

/** Cross-fade to the given clip URL using the standby element. */
function crossFadeTo(url) {
  const s = standby;
  if (!s || !active) return;
  s.onended = null;
  s.pause();
  s.removeAttribute('src');
  s.load();
  s.src = url;
  s.load();

  const doFade = () => {
    s.currentTime = 0;
    active.style.opacity = '0';
    s.style.opacity = '1';
    s.play().catch(() => {});
    const old = active;
    active = s;
    standby = old;
    old.onended = null;
    active.onended = () => nextClip();
    startClipTimer();
  };

  if (s.readyState >= 3) {
    doFade();
  } else {
    s.addEventListener('canplay', function onCp() {
      s.removeEventListener('canplay', onCp);
      doFade();
    }, { once: true });
    // Safety: fade anyway after 3 s so a slow buffer cannot hang the splash.
    setTimeout(() => {
      if (s.readyState < 3 && running) doFade();
    }, 3000);
  }
}

function nextClip() {
  if (!running) return;
  clearClipTimer();
  current = (current + 1) % playlist.length;
  crossFadeTo(playlist[current]);
}

function start() {
  if (running || !videoA.value || !videoB.value) return;
  if (teardownTimer) {
    clearTimeout(teardownTimer);
    teardownTimer = null;
  }
  running = true;
  playlist = shuffle(CLIPS);
  current = 0;
  active = videoA.value;
  standby = videoB.value;
  standby.style.opacity = '0';
  active.style.opacity = '1';
  active.src = playlist[0];
  active.load();
  active.addEventListener('canplay', function onCp() {
    active.removeEventListener('canplay', onCp);
    active.play().catch(() => {});
  }, { once: true });
  active.onended = () => nextClip();
  startClipTimer();
}

function stop() {
  running = false;
  clearClipTimer();
  stopVideo(videoA.value);
  stopVideo(videoB.value);
  active = null;
  standby = null;
}

// Pause (keep the last frame) so the 0.6 s fade-out shows video, not black;
// full teardown runs after the transition has finished.
function pauseForFade() {
  running = false;
  clearClipTimer();
  if (videoA.value) videoA.value.pause();
  if (videoB.value) videoB.value.pause();
  teardownTimer = setTimeout(() => {
    teardownTimer = null;
    stop();
  }, 800);
}

watch(() => props.visible, (v) => {
  if (v) nextTick(() => start());
  else pauseForFade();
}, { immediate: true });

onBeforeUnmount(stop);
</script>

<template>
  <transition name="fpv-fade">
    <div v-if="visible" class="fpv-splash">
      <video ref="videoA" class="fpv-splash__video" muted playsinline preload="auto"></video>
      <video ref="videoB" class="fpv-splash__video" muted playsinline preload="auto"></video>
    </div>
  </transition>
</template>

<style scoped>
.fpv-splash {
  position: fixed;
  inset: 0;
  /* Above the page's live video, below Flight disk (5) / docks (10) /
     HUD (50) / reminder pill (100) so every control stays usable. */
  z-index: 2;
  background: #000000;
  overflow: hidden;
}

/* div. prefix out-specifies the composer's `.view-composer > *` rule that
   re-enables pointer events on direct children; the splash must never
   intercept clicks meant for the page behind it. */
div.fpv-splash {
  pointer-events: none;
}

.fpv-splash__video {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  opacity: 0;
  transition: opacity 0.4s ease;
}

/* Fade the whole splash in/out like the initial page splash */
.fpv-fade-enter-active,
.fpv-fade-leave-active {
  transition: opacity 0.6s ease;
}

.fpv-fade-enter-from,
.fpv-fade-leave-to {
  opacity: 0;
}
</style>
