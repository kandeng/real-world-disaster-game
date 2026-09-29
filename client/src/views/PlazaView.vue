<script setup>
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useRouter } from "vue-router";
import LoadingSpinner from "@shared/LoadingSpinner.vue";
import { useVideos, cachedPublicVideos } from "@shared-composables/useVideos.js";
import {
  cachedGameCards,
  listGameCards,
  cardTitle,
  cardDescription,
} from "@shared-composables/useGames.js";

// Plaza: a masonry feed of equal-width rounded cards. Game packages lead —
// each one is a directory in the repo-root games/ workspace, listed by
// /games/catalog.json and described by its own card.json, so adding or
// hot-fixing a game never touches this file or the engine bundle. The
// published flight videos append below them: embedded player on top
// (YouTube / Bilibili), then title, creation time, author and description,
// and an "explore in 3D" button that jumps to the 3D Exploration page.
// Both feeds are public: anonymous visitors see the same cards as logged-in
// users.
const { t, locale } = useI18n();
const router = useRouter();
const { listPublicVideos } = useVideos();

const games = ref([]);
const videos = ref([]);
const loading = ref(false);
const loadError = ref(false);

// Render-ready cards. The two feeds carry different field shapes, so they
// are normalized here and the template only ever sees one. title and
// description are resolved for the CURRENT locale — a package ships every
// locale it is translated into, so switching language re-resolves from data
// already in memory instead of refetching, and depending on locale.value
// here is what makes that reactive. `kind` picks the button.
const cards = computed(() => [
  ...games.value.map((g) => ({
    kind: "game",
    id: g.id,
    video: g.video,
    poster: g.poster,
    action: g.action,
    title: cardTitle(g, locale.value),
    description: cardDescription(g, locale.value),
  })),
  ...videos.value.map((v) => ({ kind: "video", ...v })),
]);

onMounted(async () => {
  // Instant paint from the last successful fetch — in memory when only the
  // page changed, from localStorage when the browser was reloaded — while
  // the two GETs below silently revalidate.
  games.value = cachedGameCards() || [];
  videos.value = cachedPublicVideos() || [];
  loading.value = !cards.value.length;

  // Independent sources: a games outage must not blank the video feed and
  // vice versa, so they settle together instead of awaiting in sequence.
  // listGameCards() already keeps the previous cache when every package
  // fails, so a rejected settle leaves the stale-but-valid cards showing.
  const [g, v] = await Promise.allSettled([listGameCards(), listPublicVideos()]);
  if (g.status === "fulfilled") games.value = g.value;
  if (v.status === "fulfilled") videos.value = v.value;
  loadError.value = g.status === "rejected" && v.status === "rejected";
  loading.value = false;
});

// "Aug 22, 2026, 15:25" (en) / "2026年8月22日 15:25" (zh)
function fmtDate(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return "";
  return d.toLocaleString(locale.value === "zh" ? "zh-CN" : "en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

// The card's displaying window plays YouTube / Bilibili sources only.
function embedUrl(v) {
  const src = [...(v.sources || [])]
    .sort((a, b) => a.position - b.position)
    .find(
      (s) =>
        s.url && s.url.trim() && (s.provider === "youtube" || s.provider === "bilibili")
    );
  if (!src) return null;
  const url = src.url.trim();
  if (src.provider === "youtube") {
    const m =
      url.match(/(?:youtu\.be\/|[?/]v=|\/embed\/|\/shorts\/)([A-Za-z0-9_-]{6,})/) ||
      url.match(/^([A-Za-z0-9_-]{6,})$/);
    // Plain youtube.com (NOT youtube-nocookie.com): the nocookie domain
    // cannot share cookies with a signed-in Google session, so YouTube's
    // bot detection walls anonymous embeds with "Sign in to confirm
    // you're not a bot". hl pins the player UI to the app language.
    if (m)
      return `https://www.youtube.com/embed/${m[1]}?hl=${
        locale.value === "zh" ? "zh_CN" : "en_US"
      }`;
  } else {
    const bv = url.match(/(BV[0-9A-Za-z]+)/);
    const av = url.match(/av(\d+)/i);
    if (bv)
      return `https://player.bilibili.com/player.html?bvid=${bv[1]}&autoplay=0&high_quality=1`;
    if (av)
      return `https://player.bilibili.com/player.html?aid=${av[1]}&autoplay=0&high_quality=1`;
  }
  return null;
}

// "Play the game": client-side navigate to the Play! page so only the main
// panel swaps — the top bar, left nav, and right assistant stay mounted and
// static. The in-app intro splash plays over the main panel while Cesium /
// Google Earth connect.
//
// The card is intentionally NOT passed on: every package currently plays the
// same hard-coded Palisades scene, and the package root the engine will need
// is already on the card object (card.baseUrl). It deliberately does not go
// in the query string either — AerialView watches route.query and re-runs
// applyPlayQuery on ANY change, so adding a key there is a behaviour change
// rather than a free annotation.
function onPlayGame() {
  router.push("/play");
}

// "Explore the Scene in 3D": client-side navigate to the /play deep link,
// which lands in 3D Exploration with the video's route loaded and the
// waypoint autopilot armed. Prefer the route id (?r=); fall back to the
// video id (?v=) for videos whose route was deleted (they keep a frozen
// waypoint snapshot).
function onExplore(v) {
  router.push({
    path: "/play",
    query: v.route_id ? { r: v.route_id } : { v: v.id },
  });
}
</script>

<template>
  <div class="plaza-page">
    <!-- Notes / spinner only when there is nothing to show at all. A cached
         catalog (in memory or in localStorage) suppresses them, so a
         returning visitor never sees a spinner. -->
    <p v-if="loadError && !cards.length" class="plaza__note">
      {{ t("plazaview.error") }}
    </p>
    <p v-else-if="!loading && !cards.length" class="plaza__note">
      {{ t("plazaview.empty") }}
    </p>

    <LoadingSpinner v-if="loading && !cards.length" />

    <div v-if="cards.length" class="plaza__grid">
      <article v-for="v in cards" :key="v.id" class="pcard">
        <div class="pcard__screen" :class="{ 'pcard__screen--video': v.video }">
          <video
            v-if="v.video"
            class="pcard__video"
            :src="v.video"
            :poster="v.poster || undefined"
            controls
            preload="metadata"
            playsinline
          ></video>
          <iframe
            v-else-if="embedUrl(v)"
            :src="embedUrl(v)"
            class="pcard__iframe"
            frameborder="0"
            allow="autoplay; fullscreen; encrypted-media; picture-in-picture"
            allowfullscreen
          ></iframe>
          <div v-else class="pcard__screen-empty">{{ t("plazaview.no_source") }}</div>
        </div>

        <div class="pcard__title">{{ v.title }}</div>
        <div v-if="v.created_at" class="pcard__meta">{{ fmtDate(v.created_at) }}</div>
        <div v-if="v.author_name" class="pcard__meta">{{ v.author_name }}</div>
        <div v-if="v.description" class="pcard__desc">{{ v.description }}</div>

        <!-- A game card requests a capability by KIND; the engine owns the
             kind -> destination mapping, so a package can never name a route
             or a component. An unknown kind renders no button at all rather
             than falling back to a guess. -->
        <button
          v-if="v.kind === 'game' && v.action === 'play'"
          class="pcard__explore"
          @click="onPlayGame"
        >
          {{ t("plazaview.play_game") }}
        </button>
        <button
          v-else-if="v.kind === 'video'"
          class="pcard__explore"
          @click="onExplore(v)"
        >
          {{ t("plazaview.explore") }}
        </button>
      </article>
    </div>
  </div>
</template>

<style scoped>
.plaza-page {
  position: absolute;
  inset: 0;
  overflow-y: auto;
  pointer-events: auto;
  background: #ffffff;
  user-select: none;
  padding: 28px 48px 48px;
  box-sizing: border-box;
}

.plaza__note {
  padding: 48px 0;
  font-size: 0.9rem;
  color: #6e6e73;
}

/* Pinterest-style masonry: fixed-width columns (450px) laid out with CSS
   multi-column so cards stack tightly down each column — a card's height
   follows its content (title / description length) and no blank gap is
   left under a short card the way a row-based grid would. column-gap
   handles horizontal spacing; the card's margin-bottom the vertical. */
.plaza__grid {
  column-width: 450px;
  column-gap: 24px;
}

.pcard {
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

.pcard__screen {
  width: 100%;
  aspect-ratio: 16 / 9;
  border-radius: 10px;
  background: #000000;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
}

.pcard__iframe {
  width: 100%;
  height: 100%;
  border: none;
  display: block;
}

/* Local mp4 cards: the frame follows the video's intrinsic aspect ratio —
   width fills the masonry column, height scales proportionally (no 16:9
   crop). Embeds keep the fixed 16:9 box because their source ratio is
   unknown until the iframe loads. */
.pcard__screen--video {
  aspect-ratio: auto;
}

.pcard__video {
  width: 100%;
  height: auto;
  display: block;
  object-fit: contain;
  background: #000000;
}

.pcard__screen-empty {
  font-size: 0.85rem;
  color: #f5f5f7;
  text-align: center;
  padding: 0 16px;
}

.pcard__title {
  margin-top: 14px;
  font-size: 1.05rem;
  font-weight: 700;
  color: #111827;
}

.pcard__meta {
  margin-top: 8px;
  font-size: 0.9rem;
  color: #6e6e73;
}

.pcard__desc {
  margin-top: 8px;
  font-size: 0.9rem;
  font-weight: 400;
  color: #1d1d1f;
  /* Multi-line descriptions: keep the author's line breaks and wrap. */
  white-space: pre-wrap;
}

.pcard__explore {
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

.pcard__explore:hover {
  background: #0066d6;
}
</style>
