// Real-drone telemetry subscription for the HUD (Real Drone -> Livestream
// Host). Connects to the server fan-out endpoint, which relays frames
// published by the desktop telemetry_relay.py:
//
//   dev:  ws://localhost:8000/api/drone/telemetry  (same API_BASE as useStreamConfig)
//   prod: wss://<this origin>/api/drone/telemetry  (Caddy proxies /api/*)
//
// Singleton, module-level state (like useStreamConfig): the link stays up
// across subpage switches and view re-mounts. Reconnects every 2 s.
import { reactive, readonly } from 'vue';

const WS_URL = import.meta.env.DEV
  ? 'ws://localhost:8000/api/drone/telemetry'
  : `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/drone/telemetry`;

const RECONNECT_MS = 2000;
// A socket stuck in CONNECTING longer than this is force-closed and
// retried: during the heavy initial page load the WS handshake can be
// starved indefinitely without ever firing onclose/onerror.
const CONNECT_TIMEOUT_MS = 10000;
// Data older than this is treated as "link lost" (publisher/bridge down).
const STALE_MS = 2500;

const telemetry = reactive({
  linked: false, // fresh data arriving right now
  hz: 0, // rolling receive rate over the last 2 s
  lastRx: 0, // Date.now() of the newest frame
  position: { x: null, y: null, z: null }, // metres, drone-local frame
  attitude: { roll: null, pitch: null, yaw: null }, // degrees
  battery: { voltage: null }, // volts
});

let ws = null;
let started = false;
const rxTimes = []; // timestamps of the last ~2 s of frames, for the Hz readout

function onMessage(event) {
  let frame;
  try {
    frame = JSON.parse(event.data);
  } catch {
    return;
  }
  const now = Date.now();
  if (frame.type === 'telemetry' && frame.data && telemetry[frame.category]) {
    Object.assign(telemetry[frame.category], frame.data);
  } else if (frame.type === 'snapshot' && frame.data) {
    // Late join: adopt the server's last known state of every category.
    for (const cat of ['position', 'attitude', 'battery']) {
      if (frame.data[cat]) Object.assign(telemetry[cat], frame.data[cat]);
    }
  } else {
    return;
  }
  telemetry.lastRx = now;
  rxTimes.push(now);
}

function connect() {
  try {
    ws = new WebSocket(WS_URL);
  } catch {
    ws = null;
    setTimeout(connect, RECONNECT_MS);
    return;
  }
  let opened = false;
  let settled = false;
  const retry = () => {
    if (settled) return;
    settled = true;
    ws = null;
    setTimeout(connect, RECONNECT_MS);
  };
  const watchdog = setTimeout(() => {
    if (opened) return;
    try {
      ws.close();
    } catch { /* already gone */ }
    retry(); // belt-and-braces: don't rely on close() firing onclose
  }, CONNECT_TIMEOUT_MS);
  ws.onopen = () => {
    opened = true;
    clearTimeout(watchdog);
  };
  ws.onmessage = onMessage;
  ws.onclose = () => {
    clearTimeout(watchdog);
    retry();
  };
  ws.onerror = () => ws.close();
}

export function useDroneTelemetry() {
  if (!started) {
    started = true;
    connect();
    // Freshness + rate bookkeeping, once per second.
    setInterval(() => {
      const now = Date.now();
      telemetry.linked = telemetry.lastRx > 0 && now - telemetry.lastRx < STALE_MS;
      while (rxTimes.length && rxTimes[0] < now - 2000) rxTimes.shift();
      telemetry.hz = rxTimes.length / 2;
    }, 1000);
  }
  return { telemetry: readonly(telemetry) };
}
