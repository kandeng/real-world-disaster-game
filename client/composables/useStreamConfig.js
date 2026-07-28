// Runtime MediaMTX stream configuration, fetched ONCE from the backend
// (server/config.json "mediamtx" section -> GET /api/stream/config).
//
// This lets the SAME frontend build play the desktop MediaMTX in local dev
// and the ECS MediaMTX in production — the deployed server config decides,
// no hardcoded environment URLs in views and no rebuild.
import { ref } from 'vue';

const API_BASE = import.meta.env.DEV ? 'http://localhost:8000' : '';

// Last-resort values when the endpoint is unreachable or unconfigured:
// local MediaMTX in dev, the public Caddy /live path in production.
const FALLBACK_WHEP_URL = import.meta.env.DEV
  ? 'http://127.0.0.1:8889/ubuntu-webcam/whep'
  : 'https://drone-navigation.com/live/ubuntu-webcam/whep';

const whepUrl = ref(FALLBACK_WHEP_URL);
let requested = false;

export function useStreamConfig() {
  if (!requested) {
    requested = true;
    fetch(`${API_BASE}/api/stream/config`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data && data.whep_url) whepUrl.value = data.whep_url;
      })
      .catch(() => { /* keep the fallback URL */ });
  }
  return { whepUrl };
}
