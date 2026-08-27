<script setup>
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import LoadingSpinner from '@shared/LoadingSpinner.vue';
import { useVideos, cachedPublicVideos } from '@shared-composables/useVideos.js';

// Gallery (展厅): a grid of equal-width rounded cards, one per published
// video — embedded player on top (YouTube / Bilibili), then title, creation
// time, author and description, and an "explore in 3D" button that jumps to
// the 3D Exploration page. The feed is public: anonymous visitors see the
// same cards as logged-in users (Content stays owner-only).
const { t, locale } = useI18n();
const router = useRouter();
const { listPublicVideos } = useVideos();

const videos = ref([]);
const loading = ref(false);
const loadError = ref(false);

onMounted(async () => {
  // Instant paint from the last successful fetch (page changes remount
  // this view); the GET below silently revalidates.
  const cached = cachedPublicVideos();
  if (cached) videos.value = cached;
  loading.value = !videos.value.length;
  try {
    videos.value = await listPublicVideos();
  } catch {
    if (!videos.value.length) loadError.value = true;
  } finally {
    loading.value = false;
  }
});

// "Aug 22, 2026, 15:25" (en) / "2026年8月22日 15:25" (zh)
function fmtDate(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return d.toLocaleString(locale.value === 'zh' ? 'zh-CN' : 'en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

// The card's displaying window plays YouTube / Bilibili sources only.
function embedUrl(v) {
  const src = [...(v.sources || [])]
    .sort((a, b) => a.position - b.position)
    .find((s) => s.url && s.url.trim() && (s.provider === 'youtube' || s.provider === 'bilibili'));
  if (!src) return null;
  const url = src.url.trim();
  if (src.provider === 'youtube') {
    const m = url.match(/(?:youtu\.be\/|[?/]v=|\/embed\/|\/shorts\/)([A-Za-z0-9_-]{6,})/)
      || url.match(/^([A-Za-z0-9_-]{6,})$/);
    // Plain youtube.com (NOT youtube-nocookie.com): the nocookie domain
    // cannot share cookies with a signed-in Google session, so YouTube's
    // bot detection walls anonymous embeds with "Sign in to confirm
    // you're not a bot". hl pins the player UI to the app language.
    if (m) return `https://www.youtube.com/embed/${m[1]}?hl=${locale.value === 'zh' ? 'zh_CN' : 'en_US'}`;
  } else {
    const bv = url.match(/(BV[0-9A-Za-z]+)/);
    const av = url.match(/av(\d+)/i);
    if (bv) return `https://player.bilibili.com/player.html?bvid=${bv[1]}&autoplay=0&high_quality=1`;
    if (av) return `https://player.bilibili.com/player.html?aid=${av[1]}&autoplay=0&high_quality=1`;
  }
  return null;
}

// "Explore the Scene in 3D": jump to the /play deep link, which lands in
// 3D Exploration with the video's route loaded and the waypoint autopilot
// armed. Prefer the route id (?r=); fall back to the video id (?v=) for
// videos whose route was deleted (they keep a frozen waypoint snapshot).
function onExplore(v) {
  router.push({ path: '/play', query: v.route_id ? { r: v.route_id } : { v: v.id } });
}
</script>

<template>
  <div class="gallery-page">
    <p v-if="loadError" class="gallery__note">{{ t('galleryview.error') }}</p>
    <p v-else-if="!loading && !videos.length" class="gallery__note">{{ t('galleryview.empty') }}</p>

    <LoadingSpinner v-if="loading && !videos.length" />

    <div v-if="videos.length" class="gallery__grid">
      <article v-for="v in videos" :key="v.id" class="gcard">
        <div class="gcard__screen">
          <iframe
            v-if="embedUrl(v)"
            :src="embedUrl(v)"
            class="gcard__iframe"
            frameborder="0"
            allow="autoplay; fullscreen; encrypted-media; picture-in-picture"
            allowfullscreen
          ></iframe>
          <div v-else class="gcard__screen-empty">{{ t('galleryview.no_source') }}</div>
        </div>

        <div class="gcard__title">{{ v.title }}</div>
        <div class="gcard__meta">{{ fmtDate(v.created_at) }}</div>
        <div class="gcard__meta">{{ v.author_name }}</div>
        <div class="gcard__desc">{{ v.description }}</div>

        <button class="gcard__explore" @click="onExplore(v)">
          {{ t('galleryview.explore') }}
        </button>
      </article>
    </div>
  </div>
</template>

<style scoped>
.gallery-page {
  position: absolute;
  inset: 0;
  overflow-y: auto;
  pointer-events: auto;
  background: #ffffff;
  user-select: none;
  padding: 28px 48px 48px;
  box-sizing: border-box;
}

.gallery__note {
  padding: 48px 0;
  font-size: 0.9rem;
  color: #6e6e73;
}

/* Pinterest-style masonry: equal-width columns (1.5x the old 300px card,
   i.e. 450px) laid out with CSS multi-column so cards stack tightly down
   each column — no blank gap under a short card the way a row-based grid
   leaves. column-gap handles horizontal spacing; the card's margin-bottom
   handles vertical spacing. */
.gallery__grid {
  column-width: 450px;
  column-gap: 24px;
}

.gcard {
  display: flex;
  flex-direction: column;
  padding: 16px;
  border: 1px solid #e5e5ea;
  border-radius: 14px;
  background: #ffffff;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.06);
  /* Keep a card whole within one column (never split across columns). */
  break-inside: avoid;
  -webkit-column-break-inside: avoid;
  margin-bottom: 24px;
}

.gcard__screen {
  width: 100%;
  aspect-ratio: 16 / 9;
  border-radius: 10px;
  background: #000000;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
}

.gcard__iframe {
  width: 100%;
  height: 100%;
  border: none;
  display: block;
}

.gcard__screen-empty {
  font-size: 0.85rem;
  color: #f5f5f7;
  text-align: center;
  padding: 0 16px;
}

.gcard__title {
  margin-top: 14px;
  font-size: 1.05rem;
  font-weight: 600;
  color: #111827;
}

.gcard__meta {
  margin-top: 8px;
  font-size: 0.9rem;
  color: #6e6e73;
}

.gcard__desc {
  margin-top: 8px;
  font-size: 0.9rem;
  color: #1d1d1f;
  white-space: pre-wrap;
}

.gcard__explore {
  margin-top: 16px;
  width: 100%;
  padding: 9px 0;
  border: none;
  border-radius: 8px;
  background: #007aff;
  color: #ffffff;
  font-size: 0.95rem;
  font-weight: 600;
  cursor: pointer;
}

.gcard__explore:hover {
  background: #0066d6;
}
</style>
