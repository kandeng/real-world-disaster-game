// Runtime MediaMTX stream catalog, fetched ONCE from the backend
// (server/config.json "mediamtx" section -> GET /api/stream/config).
//
// This lets the SAME frontend build play the desktop MediaMTX in local dev
// and the ECS MediaMTX in production — the deployed server config decides,
// no hardcoded environment URLs in views and no rebuild.
//
// Catalog entry shape: { id, hostname, description, whep_url, live }.
// `live` marks a stream with an active publisher on MediaMTX (set by the
// backend merge of active paths, and for the browser's own broadcast).
// The FIRST entry is the PRIMARY stream — the one the Livestream Host
// subpage monitors (our own broadcast, 'crazyflie-drone').
//
// registerLocalStream()/unregisterLocalStream() let the in-browser
// broadcaster inject its own entry at the top of the catalog; local
// entries survive refreshStreams() re-fetches.
import { ref, computed } from 'vue';

const API_BASE = import.meta.env.DEV ? 'http://localhost:8000' : '';

// Last-resort catalog when the endpoint is unreachable or unconfigured:
// local MediaMTX in dev, the public Caddy /live path in production.
const WHEP_BASE = import.meta.env.DEV
  ? 'http://127.0.0.1:8889'
  : 'https://drone-navigation.com/live';

const FALLBACK_STREAMS = [
  {
    id: 'crazyflie-drone',
    hostname: 'crazyflie-drone',
    description: 'Live video from the Crazyflie drone (ESP32 AI-Deck)',
    whep_url: `${WHEP_BASE}/crazyflie-drone/whep`,
  },
  {
    id: 'ubuntu-webcam',
    hostname: 'ubuntu-webcam',
    description: "A webcam stream from Kan's Ubuntu desktop",
    whep_url: `${WHEP_BASE}/ubuntu-webcam/whep`,
  },
];

const streams = ref(FALLBACK_STREAMS);
// Primary stream's WHEP URL (first catalog entry), kept for backward
// compatibility with single-stream consumers.
const whepUrl = computed(() => streams.value[0]?.whep_url || '');
// Base URL of the WHEP/WHIP server, derived from the first catalog entry
// (e.g. 'https://drone-navigation.com/live' or 'http://127.0.0.1:8889').
// Used to build the broadcaster's own stream URLs.
const whepBase = computed(() => {
  const m = /^(.*)\/[^/]+\/whep\/?$/.exec(streams.value[0]?.whep_url || '');
  return m ? m[1] : WHEP_BASE;
});

// Ids registered locally via registerLocalStream() — kept across refreshes.
const localIds = new Set();
let requested = false;
let fetching = null;

// Legacy single-stream config ("whep_url" only, no "streams"): derive a
// one-entry catalog from the URL — the stream id is the path segment
// right before '/whep'.
function legacyStream(url) {
  const m = /\/([^/]+)\/whep\/?$/.exec(url || '');
  const id = m ? m[1] : 'livestream';
  return [{ id, hostname: id, description: '', whep_url: url }];
}

function normalize(list) {
  return list
    .map((s) => ({
      id: s.id || s.hostname || s.whep_url,
      hostname: s.hostname || s.id || '',
      description: s.description || '',
      whep_url: s.whep_url || '',
      live: !!s.live,
    }))
    .filter((s) => s.whep_url);
}

// Fresh server catalog + locally registered broadcasts (locals first).
function mergeWithLocal(list) {
  const locals = streams.value.filter((s) => localIds.has(s.id));
  return [...locals, ...list.filter((s) => !localIds.has(s.id))];
}

/** Insert/replace the browser's own broadcast at the TOP of the catalog. */
export function registerLocalStream(entry) {
  const e = normalize([entry])[0];
  if (!e) return;
  localIds.add(e.id);
  streams.value = [e, ...streams.value.filter((s) => s.id !== e.id)];
}

/** Remove a locally registered broadcast (ended or failed). */
export function unregisterLocalStream(id) {
  if (!id) return;
  localIds.delete(id);
  streams.value = streams.value.filter((s) => s.id !== id);
}

/** (Re)fetch the catalog from the backend; safe to call repeatedly. */
export function refreshStreams() {
  if (fetching) return fetching;
  fetching = fetch(`${API_BASE}/api/stream/config`)
    .then((r) => (r.ok ? r.json() : null))
    .then((data) => {
      if (!data) return;
      if (Array.isArray(data.streams) && data.streams.length) {
        const list = normalize(data.streams);
        if (list.length) streams.value = mergeWithLocal(list);
      } else if (data.whep_url) {
        streams.value = mergeWithLocal(legacyStream(data.whep_url));
      }
    })
    .catch(() => { /* keep the current catalog */ })
    .finally(() => { fetching = null; });
  return fetching;
}

export function useStreamConfig() {
  if (!requested) {
    requested = true;
    refreshStreams();
  }
  return { streams, whepUrl, whepBase, refreshStreams, registerLocalStream, unregisterLocalStream };
}
