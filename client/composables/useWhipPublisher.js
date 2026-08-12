// WHIP (WebRTC-HTTP Ingestion Protocol) publisher for MediaMTX livestreams.
// The pure-browser replacement for extension/simple_webcam/simple_webcam.py:
// capture camera + microphone via getUserMedia, POST the SDP offer to
// MediaMTX's WHIP endpoint, and the same path becomes watchable via WHEP.
//
// Two layers:
//   createWhipPublisher({...}) — low-level factory owning ONE sendonly
//     PeerConnection (mirrors useWhepPlayer.js style).
//   useWhipBroadcast() — module-level singleton broadcast session. The
//     stream survives component unmounts (route/subpage navigation) and
//     only ends on explicit stop, tab close (best-effort keepalive DELETE),
//     or ICE failure.
//
// WHIP teardown: MediaMTX answers POST with 201 + a Location header
// pointing at the session resource; DELETEing that URL ends the session
// (Caddy already rewrites Location to keep the /live prefix).

import { ref, shallowRef } from 'vue';
import { registerLocalStream, unregisterLocalStream } from './useStreamConfig.js';

export function createWhipPublisher({
  url,
  logTag = 'whip',
  onProgress = null,
  onState = null,
  // No STUN by default: MediaMTX is an ICE-lite server, host candidates
  // suffice (same reasoning as the WHEP player and the Python publisher).
  iceServers = [],
  // Belt & braces: never let ICE gathering hang the handshake.
  iceGatheringTimeoutMs = 3000,
}) {
  let pc = null;
  let localStream = null;
  let resourceUrl = null; // WHIP session resource (DELETE target)
  let active = false;

  const resolveUrl = () => (typeof url === 'function' ? url() : url);

  function log(...args) {
    console.log(`[${logTag}]`, ...args);
  }

  function warn(...args) {
    console.warn(`[${logTag}]`, ...args);
  }

  function report(phase) {
    if (onProgress) {
      try {
        onProgress(phase);
      } catch {
        /* progress callbacks must never break publishing */
      }
    }
  }

  function setState(state) {
    if (onState) {
      try {
        onState(state);
      } catch {
        /* state callbacks must never break publishing */
      }
    }
  }

  // MediaMTX accepts a full (non-trickle) SDP offer, so wait for ICE
  // gathering — capped so a dead STUN server cannot stall the handshake.
  function waitIceGatheringComplete(conn) {
    if (conn.iceGatheringState === 'complete') return Promise.resolve(false);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        conn.removeEventListener('icegatheringstatechange', onState);
        resolve(true);
      }, iceGatheringTimeoutMs);
      const onState = () => {
        if (conn.iceGatheringState === 'complete') {
          clearTimeout(timer);
          conn.removeEventListener('icegatheringstatechange', onState);
          resolve(false);
        }
      };
      conn.addEventListener('icegatheringstatechange', onState);
    });
  }

  function cleanup(stopTracks) {
    if (pc) {
      pc.close();
      pc = null;
    }
    if (stopTracks && localStream) {
      for (const track of localStream.getTracks()) track.stop();
    }
    localStream = null;
  }

  /** Start publishing `mediaStream` (obtained via getUserMedia by the caller). */
  async function start(mediaStream) {
    active = true;
    cleanup(false); // fresh PeerConnection; the caller owns the tracks
    localStream = mediaStream;
    report('start');
    const t0 = performance.now();
    const since = () => `t+${((performance.now() - t0) / 1000).toFixed(2)}s`;

    const conn = new RTCPeerConnection({ iceServers });
    pc = conn;
    for (const track of mediaStream.getTracks()) {
      conn.addTrack(track, mediaStream);
    }
    // Publish-only: MediaMTX must never send media back to the broadcaster.
    for (const transceiver of conn.getTransceivers()) {
      transceiver.direction = 'sendonly';
    }

    conn.oniceconnectionstatechange = () => {
      log(`${since()} ICE connection state -> ${conn.iceConnectionState}`);
      if (conn.iceConnectionState === 'failed' && pc === conn && active) {
        warn(`${since()} ICE FAILED — broadcast lost.`);
        setState('failed');
      }
    };

    try {
      const offer = await conn.createOffer();
      await conn.setLocalDescription(offer);
      const iceTimedOut = await waitIceGatheringComplete(conn);
      log(`${since()} ICE gathering ${iceTimedOut ? 'TIMEOUT — proceeding' : 'complete'}`);
      report('offer');
      const target = resolveUrl();
      log(`${since()} POSTing WHIP SDP offer to ${target} ...`);
      const res = await fetch(target, {
        method: 'POST',
        headers: { 'Content-Type': 'application/sdp' },
        body: conn.localDescription.sdp,
      });
      if (!res.ok) {
        const body = (await res.text()).slice(0, 200);
        throw new Error(`HTTP ${res.status}: ${body}`);
      }
      const answerSdp = await res.text();
      // Session resource for teardown (relative URLs resolve against the
      // WHIP endpoint; Caddy keeps the /live prefix in the rewrite).
      const location = res.headers.get('Location');
      resourceUrl = location ? new URL(location, target).toString() : null;
      await conn.setRemoteDescription({ type: 'answer', sdp: answerSdp });
      log(`${since()} WHIP handshake SUCCEEDED — broadcast is live.`);
      report('handshake');
      setState('live');
    } catch (err) {
      warn(`${since()} WHIP handshake FAILED:`, err.message);
      cleanup(false); // caller decides what to do with the camera tracks
      throw err;
    }
  }

  /** End the session: DELETE the WHIP resource, close PC, stop all tracks. */
  function stop() {
    active = false;
    const target = resourceUrl;
    resourceUrl = null;
    if (target) {
      fetch(target, { method: 'DELETE' }).catch(() => {});
    }
    cleanup(true);
    log('STOP — broadcast session closed.');
  }

  function getResourceUrl() {
    return resourceUrl;
  }

  return { start, stop, getResourceUrl };
}

/* ─── Module-level singleton broadcast session ───
   ChatView mounts/unmounts with routing; keeping the session at module
   scope lets the broadcast survive navigation. State machine:
     idle → connecting → live → idle        (normal flow)
                ↘ error (permission / nodevice / device / handshake)
          live → error:connection           (ICE failure mid-stream)     */

const bcState = ref('idle');
const bcError = ref('');
const bcProgress = ref(0);
const bcStartedAt = ref(0);
const bcStreamId = ref('');
const bcLocalStream = shallowRef(null); // raw MediaStream — never deep-reactive
let publisher = null;
let pagehideHooked = false;

function mediaErrorCode(err) {
  const name = (err && err.name) || '';
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') {
    return 'permission';
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') {
    return 'nodevice';
  }
  return 'device';
}

async function acquireMedia() {
  const video = { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } };
  try {
    return await navigator.mediaDevices.getUserMedia({ video, audio: true });
  } catch (err) {
    // No microphone (or mic denied) → a video-only broadcast is still fine.
    // If VIDEO was the problem the retry below throws and surfaces it.
    if (err && (err.name === 'NotFoundError' || err.name === 'NotAllowedError')) {
      try {
        return await navigator.mediaDevices.getUserMedia({ video });
      } catch (retryErr) {
        throw retryErr;
      }
    }
    throw err;
  }
}

function teardownSession(newState, errorCode) {
  if (publisher) {
    publisher.stop(); // closes PC, stops camera/mic tracks, DELETEs resource
    publisher = null;
  }
  unregisterLocalStream(bcStreamId.value);
  bcLocalStream.value = null;
  bcStreamId.value = '';
  bcStartedAt.value = 0;
  bcError.value = errorCode || '';
  bcState.value = newState;
}

export function useWhipBroadcast() {
  // Best-effort teardown on tab close: a keepalive DELETE so MediaMTX frees
  // the path immediately instead of waiting for the ICE timeout.
  if (!pagehideHooked && typeof window !== 'undefined') {
    pagehideHooked = true;
    window.addEventListener('pagehide', () => {
      const target = publisher && publisher.getResourceUrl();
      if (target) {
        try {
          fetch(target, { method: 'DELETE', keepalive: true }).catch(() => {});
        } catch {
          /* nothing more we can do during teardown */
        }
      }
    });
  }

  /**
   * Start broadcasting. `entry` is the catalog entry for this broadcast:
   * { id, hostname, description, whep_url } — the WHIP endpoint is derived
   * by swapping the trailing '/whep' for '/whip'.
   */
  async function startBroadcast(entry) {
    if (bcState.value === 'connecting' || bcState.value === 'live') return;
    if (!entry || !entry.id || !entry.whep_url) return;
    bcError.value = '';
    bcProgress.value = 0;
    bcStreamId.value = entry.id;
    bcState.value = 'connecting';

    let stream;
    try {
      stream = await acquireMedia();
    } catch (err) {
      console.warn('[broadcast] getUserMedia failed:', err.name, err.message);
      bcStreamId.value = '';
      bcError.value = mediaErrorCode(err);
      bcState.value = 'error';
      return;
    }
    bcLocalStream.value = stream;

    const whipUrl = entry.whep_url.replace(/\/whep\/?$/, '/whip');
    publisher = createWhipPublisher({
      url: whipUrl,
      logTag: 'broadcast',
      onProgress: (phase) => {
        if (phase === 'start') bcProgress.value = 0.15;
        else if (phase === 'offer') bcProgress.value = Math.max(bcProgress.value, 0.35);
        else if (phase === 'handshake') bcProgress.value = Math.max(bcProgress.value, 0.75);
      },
      onState: (state) => {
        if (state === 'live' && publisher) {
          bcStartedAt.value = Date.now();
          bcProgress.value = 1;
          bcState.value = 'live';
          registerLocalStream({ ...entry, live: true });
        } else if (state === 'failed') {
          // ICE died mid-stream — clean everything up and surface the error.
          teardownSession('error', 'connection');
        }
      },
    });

    try {
      await publisher.start(stream);
    } catch (err) {
      console.warn('[broadcast] WHIP publish failed:', err.message);
      teardownSession('error', 'handshake');
    }
  }

  /** End the broadcast (user clicked 结束直播). */
  function stopBroadcast() {
    if (bcState.value === 'idle') return;
    teardownSession('idle', '');
  }

  return {
    state: bcState,
    error: bcError,
    progress: bcProgress,
    startedAt: bcStartedAt,
    streamId: bcStreamId,
    localStream: bcLocalStream,
    startBroadcast,
    stopBroadcast,
  };
}
