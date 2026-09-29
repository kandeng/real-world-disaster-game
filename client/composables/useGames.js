/**
 * useGames.js — loader for the Plaza's game packages.
 *
 * The game engine (this client bundle) is static; the games are not. They
 * live in the repo-root `games/` workspace, deployed OUTSIDE `client/dist`
 * to /var/www/drone-navigation/games/ and served by Caddy at `/games/*`, so
 * editing or adding a package never touches the engine build. In dev the
 * same URLs come from the middleware in vite.config.js.
 *
 * Two-tier fetch:
 *   /games/catalog.json          the index: {id, baseUrl, packageVersion, order}
 *   <baseUrl>card.json?v=<ver>   one card: title, description, trailer, action
 *
 * catalog.json is served `no-cache` and revalidates on every visit; card.json
 * is cache-busted by the catalog's packageVersion, so the catalog remains the
 * single place an operator edits to publish, retract, reorder or hot-fix a
 * game.
 *
 * A catalog entry whose baseUrl is an absolute URL is used verbatim — that
 * is the slot for a package published from its own repository and served
 * from a CDN. Everything inside a package (media now, scene/story/audio/code
 * later) is addressed RELATIVE to baseUrl, so moving a package between hosts
 * is a one-field catalog edit.
 *
 * Unlike useVideos.js there is no `useGames()` factory: nothing here is
 * reactive and the feed is public, so no auth context and no setup scope are
 * needed. The caches are module-level for the same reason useVideos' are.
 */

import { apexBaseUrl } from './wsUrl.js';

// Pinned to the apex origin, exactly like /api/*: catalog.json and card.json
// are the mutable half of the workspace, and the CDN edge would happily cache
// them, so a hot-fix would not reach edge visitors until it expired.
const GAMES_BASE = apexBaseUrl();

const CATALOG_URL = `${GAMES_BASE}/games/catalog.json`;

// Assembled cards from the last successful fetch. The Plaza unmounts and
// remounts on every page change, so this paints instantly while the GET
// below silently revalidates — same shape as useVideos' publicVideosCache.
let cardsCache = null;

// Survives a reload, which cardsCache does not. Holds the assembled cards
// (JSON text only — media is never stored here; it stays a URL and is cached
// by the browser's HTTP cache under Caddy's Cache-Control).
const LS_KEY = 'plaza.games.v1';

// Descriptions are prose, so a few hundred games could approach the ~5 MB
// per-origin localStorage quota. Skipping persistence beats throwing on
// every visit: the in-memory cache still covers in-session navigation.
const LS_MAX_CHARS = 2_000_000;

function readPersisted() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.cards) ? parsed.cards : null;
  } catch {
    return null; // private mode, disabled storage, or a corrupt payload
  }
}

function persist(cards) {
  try {
    const raw = JSON.stringify({ v: 1, savedAt: Date.now(), cards });
    if (raw.length > LS_MAX_CHARS) return;
    localStorage.setItem(LS_KEY, raw);
  } catch {
    /* quota or private mode: in-memory caching still works for this session */
  }
}

/**
 * Cards for an instant paint: the last fetch this session, else the last
 * fetch of any previous session. Returns null when there is nothing yet, so
 * the caller can tell "empty catalog" from "never loaded" and show the
 * spinner only in the second case.
 */
export function cachedGameCards() {
  if (cardsCache) return cardsCache;
  const persisted = readPersisted();
  if (persisted) cardsCache = persisted;
  return cardsCache;
}

/** Drop both caches — used after a package is edited locally in dev. */
export function invalidateGamesCache() {
  cardsCache = null;
  try {
    localStorage.removeItem(LS_KEY);
  } catch {
    /* nothing to drop */
  }
}

/** Turn a catalog baseUrl into an absolute, trailing-slashed package root. */
function packageBase(baseUrl) {
  const url = new URL(baseUrl, GAMES_BASE);
  return url.href.endsWith('/') ? url.href : `${url.href}/`;
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`games_unavailable:${res.status}`);
  return res.json();
}

/**
 * One catalog entry -> one render-ready card, or null if the package is
 * malformed. Raw title/description are kept as authored (a string, an array
 * of paragraphs, or a locale map) so switching language re-resolves them
 * without a refetch — see cardTitle() / cardDescription().
 */
async function loadCard(entry) {
  if (!entry || typeof entry.id !== 'string' || typeof entry.baseUrl !== 'string') {
    return null;
  }
  const base = packageBase(entry.baseUrl);

  // card.json is version-stamped in the URL. The catalog's packageVersion is
  // therefore the knob that busts a card hot-fix: edit card.json, bump the
  // version, and returning visitors get it immediately instead of after
  // Caddy's max-age expires. Media is NOT stamped — a trailer is megabytes
  // and a copy edit should not re-download it; a replaced trailer picks up
  // within the same max-age window. (Packages served from a tag-addressed CDN
  // are already immutable, so the extra query is merely redundant there.)
  const version = entry.packageVersion;
  const cardUrl = version
    ? `${base}card.json?v=${encodeURIComponent(version)}`
    : `${base}card.json`;

  const card = await fetchJson(cardUrl);
  if (!card) return null;
  return {
    kind: 'game',
    id: typeof card.id === 'string' ? card.id : entry.id,
    order: Number.isFinite(entry.order) ? entry.order : 0,
    packageVersion: version || card.packageVersion || null,
    // Absolute package root: the later scene / story / audio / code files
    // are fetched from here, and only from here.
    baseUrl: base,
    title: card.title ?? null,
    description: card.description ?? null,
    video: card.trailer ? new URL(card.trailer, base).href : null,
    poster: card.poster ? new URL(card.poster, base).href : null,
    // The one engine capability this card may invoke. A package names a
    // KIND, never a route or a component: the engine owns that mapping and
    // an unknown kind renders no button rather than guessing.
    action: typeof card.action?.kind === 'string' ? card.action.kind : null,
  };
}

/**
 * GET the catalog, then every package's card.json in parallel.
 *
 * One broken package must not blank the Plaza, so cards settle individually
 * and the failures are dropped. On a total failure the previous cache is
 * left in place — a stale Plaza is better than an empty one.
 */
export async function listGameCards() {
  const catalog = await fetchJson(CATALOG_URL);
  const entries = Array.isArray(catalog?.games) ? [...catalog.games] : [];
  entries.sort((a, b) => (Number(a?.order) || 0) - (Number(b?.order) || 0));

  const settled = await Promise.allSettled(entries.map(loadCard));
  const cards = settled
    .filter((s) => s.status === 'fulfilled')
    .map((s) => s.value)
    .filter(Boolean);

  // entries.length && !cards.length == every package failed: keep the cache.
  if (cards.length || !entries.length) {
    cardsCache = cards;
    persist(cards);
  }
  return cards;
}

/**
 * Resolve a localized field: a plain string, an array, or a locale map.
 * Falls back to `en`, then to the first locale the package does carry, so an
 * untranslated package still renders instead of showing a blank card.
 */
function pickByLocale(value, locale) {
  if (value == null) return null;
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value;
  if (typeof value === 'object') {
    if (value[locale] !== undefined) return value[locale];
    if (value.en !== undefined) return value.en;
    const first = Object.keys(value).find((k) => value[k] != null);
    return first ? value[first] : null;
  }
  return null;
}

function toText(value, joiner) {
  if (Array.isArray(value)) return value.filter((s) => typeof s === 'string').join(joiner);
  return typeof value === 'string' ? value : '';
}

/** Card heading for `locale` ('en' / 'zh' / ...). */
export function cardTitle(card, locale) {
  return toText(pickByLocale(card?.title, locale), ' ');
}

/** Card body for `locale`: paragraphs joined by a blank line, rendered by
 *  the Plaza with white-space: pre-wrap so the package owns its line breaks. */
export function cardDescription(card, locale) {
  return toText(pickByLocale(card?.description, locale), '\n\n');
}
