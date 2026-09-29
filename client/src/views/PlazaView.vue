<script setup>
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useRouter } from "vue-router";
import LoadingSpinner from "@shared/LoadingSpinner.vue";
import {
  cachedGameCards,
  listGameCards,
  cardTitle,
  cardDescription,
} from "@shared-composables/useGames.js";

// Plaza: a masonry feed of equal-width rounded cards, one per game package.
// Each package is a directory in the repo-root games/ workspace, listed by
// /games/catalog.json and described by its own card.json, so adding or
// hot-fixing a game never touches this file or the engine bundle. The feed is
// public: anonymous visitors see the same cards as logged-in users.
//
// The published-flight-video cards that used to append below the games are
// gone, together with their YouTube / Bilibili iframe and their "Explore the
// Scene in 3D" button. That button deep-linked into /play with a saved route
// (?r= / ?v=), which is not a capability a game package may request: a card
// names an action KIND and the engine owns the kind -> destination mapping,
// so `play` is the only button this view can render. Bringing those cards back
// means adding such a kind to the engine, not re-adding a branch here.
const { t, locale } = useI18n();
const router = useRouter();

const games = ref([]);
const loading = ref(false);
const loadError = ref(false);

// Render-ready cards. title and description are resolved for the CURRENT
// locale — a package ships every locale it is translated into, so switching
// language re-resolves from data already in memory instead of refetching, and
// depending on locale.value here is what makes that reactive. `kind` picks the
// button.
const cards = computed(() =>
  games.value.map((g) => ({
    kind: "game",
    id: g.id,
    video: g.video,
    poster: g.poster,
    action: g.action,
    title: cardTitle(g, locale.value),
    description: cardDescription(g, locale.value),
  })),
);

onMounted(async () => {
  // Instant paint from the last successful fetch — in memory when only the
  // page changed, from localStorage when the browser was reloaded — while the
  // GET below silently revalidates.
  games.value = cachedGameCards() || [];
  loading.value = !cards.value.length;

  // listGameCards() already keeps the previous cache when every package fails,
  // so a rejection leaves the stale-but-valid cards showing and the error note
  // is only ever reached when there is nothing cached to show at all.
  try {
    games.value = await listGameCards();
  } catch {
    loadError.value = true;
  }
  loading.value = false;
});

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
          <div v-else class="pcard__screen-empty">{{ t("plazaview.no_source") }}</div>
        </div>

        <div class="pcard__title">{{ v.title }}</div>
        <div v-if="v.description" class="pcard__desc">{{ v.description }}</div>

        <!-- A game card requests a capability by KIND; the engine owns the
             kind -> destination mapping, so a package can never name a route
             or a component. An unknown kind renders no button at all rather
             than falling back to a guess. -->
        <button
          v-if="v.kind === 'game' && v.action === 'play'"
          class="pcard__cta"
          @click="onPlayGame"
        >
          {{ t("plazaview.play_game") }}
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

/* A card with a local mp4 trailer: the frame follows the video's intrinsic
   aspect ratio — width fills the masonry column, height scales proportionally
   (no 16:9 crop). A card without one keeps the fixed 16:9 box, so the "no
   playable source" note still has somewhere to sit. */
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

.pcard__desc {
  margin-top: 8px;
  font-size: 0.9rem;
  font-weight: 400;
  color: #1d1d1f;
  /* Multi-line descriptions: keep the author's line breaks and wrap. */
  white-space: pre-wrap;
}

/* The card's one call to action. Renamed from `pcard__explore` when the
   video cards left: "explore" described THAT button, and this one plays a
   game. Scoped CSS, so the rename cannot reach any other component. */
.pcard__cta {
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

.pcard__cta:hover {
  background: #0066d6;
}
</style>
