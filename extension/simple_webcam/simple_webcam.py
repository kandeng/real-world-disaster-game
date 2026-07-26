import asyncio
import socket
import time
from urllib.parse import urlparse

import cv2
from aiortc import RTCConfiguration, RTCIceServer, RTCPeerConnection, RTCSessionDescription, VideoStreamTrack
from aiortc.contrib.media import MediaPlayer  # PyAV media wrapper
from av import VideoFrame
import aiohttp

# ── Configuration ──────────────────────────────────────────────────────────
# EXTENSION_ECS_URL = "http://47.85.110.135:8889"
EXTENSION_ECS_URL = "https://drone-navigation.com/live"
STREAM_ID = "ubuntu-webcam"

# MediaMTX control API (default port 9997). Used ONLY to list who is viewing
# the broadcast. Set to None to disable viewer logging.
MEDIAMTX_API_URL = "http://47.85.110.135:9997"

# Sidecar metadata service (our own — see server/stream_meta.py). While live we
# periodically POST the rich stream info (title/description/...) that MediaMTX
# itself cannot store, so the web client's stream list can display it.
# Set to None to disable.
STREAM_META_URL = "https://drone-navigation.com/streams-meta/"
STREAM_META_API_KEY = ""  # must match server/config.json when the service sets one
STREAM_META = {
    "title": "Ubuntu Webcam",
    "description": "Kan's desk camera (video + microphone)",
    "device": "/dev/video0",
    "location": "Office",
}
META_INTERVAL = 30  # seconds between metadata heartbeats

STUN_SERVER = "stun:stun.l.google.com:19302"
MONITOR_INTERVAL = 10  # seconds between stats / viewer log lines


def log(tag, msg):
    """Timestamped, tagged log line."""
    print(f"[{time.strftime('%H:%M:%S')}] [{tag}] {msg}", flush=True)


class WebcamStreamTrack(VideoStreamTrack):
    def __init__(self, stream_id):
        super().__init__()
        self.stream_id = stream_id
        self.cap = cv2.VideoCapture(0)

    async def recv(self):
        pts, time_base = await self.next_timestamp()

        ret, frame = self.cap.read()
        if not ret:
            raise Exception("Webcam read failed")

        # Overlay identifying text
        cv2.putText(
            frame,
            f"{self.stream_id} - {time.strftime('%H:%M:%S')}",
            (20, 40),
            cv2.FONT_HERSHEY_SIMPLEX,
            1,
            (0, 255, 0),
            2
        )

        new_frame = VideoFrame.from_ndarray(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB), format="rgb24")
        new_frame.pts = pts
        new_frame.time_base = time_base
        return new_frame


# STUN server configuration for NAT traversal
rtc_config = RTCConfiguration(
    iceServers=[RTCIceServer(urls=[STUN_SERVER])]
)


def describe_sdp_candidates(sdp):
    """Short 'ip:port (type)' list from the a=candidate lines of an SDP blob."""
    found = []
    for line in sdp.splitlines():
        if not line.startswith("a=candidate:"):
            continue
        # a=candidate:<foundation> <component> <transport> <priority> <ip> <port> typ <type> ...
        parts = line.split()
        try:
            ip, port = parts[4], parts[5]
            ctype = parts[parts.index("typ") + 1]
        except (ValueError, IndexError):
            continue
        found.append(f"{ip}:{port} ({ctype})")
    return found


def stream_path_name(server_url, stream_id):
    """'https://host/live' + 'ubuntu-webcam' -> 'live/ubuntu-webcam' (the MediaMTX path)."""
    prefix = urlparse(server_url).path.strip("/")
    return f"{prefix}/{stream_id}" if prefix else stream_id


async def log_selected_ice_pair(pc):
    """Once ICE is connected, report which local<->remote pair actually carries the video."""
    try:
        stats = await pc.getStats()
        for stat in stats.values():
            if getattr(stat, "type", None) != "candidate-pair":
                continue
            if not getattr(stat, "nominated", False) or getattr(stat, "state", None) != "succeeded":
                continue
            local = stats.get(stat.localCandidateId)
            remote = stats.get(stat.remoteCandidateId)
            l_desc = f"{getattr(local, 'ip', '?')}:{getattr(local, 'port', '?')} ({getattr(local, 'candidateType', '?')})"
            r_desc = f"{getattr(remote, 'ip', '?')}:{getattr(remote, 'port', '?')} ({getattr(remote, 'candidateType', '?')})"
            log("ICE", f"Selected path: local {l_desc} <-> remote {r_desc}")
            return
    except Exception as e:
        log("ICE", f"Could not read selected candidate pair: {e}")


async def monitor(pc, api_base, path_name, interval=MONITOR_INTERVAL):
    """Every `interval` seconds: log upload progress and who is viewing the broadcast."""
    api_ok = True
    last_bytes = 0
    async with aiohttp.ClientSession() as session:
        while True:
            await asyncio.sleep(interval)

            # ── Upload progress: proof the media is really flowing ──
            try:
                stats = await pc.getStats()
                for stat in stats.values():
                    if getattr(stat, "type", None) == "outbound-rtp" and getattr(stat, "kind", None) == "video":
                        mb = stat.bytesSent / 1_000_000
                        kbps = (stat.bytesSent - last_bytes) * 8 / 1000 / interval
                        last_bytes = stat.bytesSent
                        log("STATS", f"Uploading: {mb:.2f} MB total, {stat.packetsSent} packets, ~{kbps:.0f} kbps")
            except Exception as e:
                log("STATS", f"Could not read WebRTC stats: {e}")

            # ── Viewers, via the MediaMTX control API ──
            if not api_base:
                continue
            try:
                async with session.get(
                    f"{api_base}/v3/webrtcsessions/list",
                    timeout=aiohttp.ClientTimeout(total=5),
                ) as resp:
                    if resp.status != 200:
                        raise Exception(f"HTTP {resp.status}")
                    data = await resp.json()
                sessions = [s for s in data.get("items", []) if s.get("path") == path_name]
                viewers = [s for s in sessions if s.get("state") == "read"]
                publishers = [s for s in sessions if s.get("state") == "publish"]
                if not api_ok:
                    log("VIEWERS", "MediaMTX control API reachable again.")
                    api_ok = True
                log("VIEWERS", f"{len(viewers)} viewer(s) watching '{path_name}' "
                               f"(publish sessions: {len(publishers)})")
                for v in viewers:
                    log("VIEWERS", f"  - {v.get('remoteAddr', '?')} "
                                   f"({v.get('bytesSent', 0) / 1000:.0f} kB delivered)")
            except Exception as e:
                if api_ok:
                    log("VIEWERS", f"MediaMTX control API unreachable at {api_base} ({e}); "
                                   "viewer stats muted until it recovers.")
                    api_ok = False


async def meta_heartbeat(payload, interval=META_INTERVAL):
    """Best-effort periodic upsert of this stream's metadata to the sidecar service."""
    if not STREAM_META_URL:
        return
    meta_ok = True
    headers = {"X-API-Key": STREAM_META_API_KEY} if STREAM_META_API_KEY else {}
    async with aiohttp.ClientSession() as session:
        while True:
            try:
                async with session.post(
                    STREAM_META_URL, json=payload, headers=headers,
                    timeout=aiohttp.ClientTimeout(total=5),
                ) as resp:
                    if resp.status not in (200, 201):
                        raise Exception(f"HTTP {resp.status}")
                    if not meta_ok:
                        log("META", "Metadata service reachable again.")
                        meta_ok = True
            except Exception as e:
                if meta_ok:
                    log("META", f"Metadata service unreachable ({e}); "
                                "metadata updates muted until it recovers.")
                    meta_ok = False
            await asyncio.sleep(interval)


async def meta_deregister(stream_id):
    """Best-effort removal of this stream's metadata on shutdown."""
    if not STREAM_META_URL:
        return
    headers = {"X-API-Key": STREAM_META_API_KEY} if STREAM_META_API_KEY else {}
    url = f"{STREAM_META_URL.rstrip('/')}/{stream_id}"
    try:
        async with aiohttp.ClientSession() as session:
            async with session.delete(url, headers=headers,
                                      timeout=aiohttp.ClientTimeout(total=5)) as resp:
                if resp.status == 200:
                    log("META", "Stream metadata deregistered.")
    except Exception:
        pass  # shutting down anyway; the entry simply goes stale


async def run_whip_publisher(server_url, stream_id):
    whip_endpoint = f"{server_url}/{stream_id}/whip"
    path_name = stream_path_name(server_url, stream_id)

    log("INIT", f"Stream ID: '{stream_id}' (MediaMTX path: '{path_name}')")
    log("INIT", f"WHIP endpoint we shake hands with: {whip_endpoint}")

    # Metadata pushed to the sidecar service (enriched with webcam info below).
    meta_payload = {"stream_id": stream_id, **STREAM_META}

    # Where is the MediaMTX server? Resolve the host we are about to call.
    host = urlparse(server_url).hostname
    try:
        addrs = sorted({ai[4][0] for ai in socket.getaddrinfo(host, None)})
        log("INIT", f"MediaMTX host '{host}' resolves to: {', '.join(addrs)}")
    except Exception as e:
        log("INIT", f"Could not resolve MediaMTX host '{host}': {e}")

    log("INIT", f"Using STUN server for NAT traversal: {STUN_SERVER}")

    pc = RTCPeerConnection(configuration=rtc_config)

    @pc.on("iceconnectionstatechange")
    async def on_ice_state_change():
        log("ICE", f"ICE connection state -> {pc.iceConnectionState}")
        if pc.iceConnectionState == "connected":
            await log_selected_ice_pair(pc)
        elif pc.iceConnectionState == "failed":
            log("ICE", "Handshake FAILED: no working network path to MediaMTX "
                       "(check STUN reachability / firewall / UDP ports).")

    # 1. Add video track (from OpenCV webcam)
    video_track = None
    try:
        video_track = WebcamStreamTrack(stream_id)
        if video_track.cap.isOpened():
            w = int(video_track.cap.get(cv2.CAP_PROP_FRAME_WIDTH))
            h = int(video_track.cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
            pc.addTrack(video_track)
            log("INIT", f"Webcam opened successfully: {w}x{h}")
            meta_payload["resolution"] = f"{w}x{h}"
            fps = video_track.cap.get(cv2.CAP_PROP_FPS)
            if fps > 0:
                meta_payload["fps"] = round(fps, 1)
        else:
            log("INIT", "WARNING: Webcam (device 0) could not be opened. Skipping video.")
    except Exception as e:
        log("INIT", f"WARNING: Failed to initialize webcam video track ({e}). Continuing without video.")

    # 2. Add audio track (capturing default microphone using PyAV/MediaPlayer)
    player = None
    try:
        player = MediaPlayer('default', format='pulse')
        if player.audio:
            pc.addTrack(player.audio)
            log("INIT", "Microphone audio track added successfully.")
    except Exception as e:
        log("INIT", f"WARNING: Could not open microphone audio track ({e}). Continuing without audio.")

    # 3. Ensure at least one media track is active
    if not pc.getSenders():
        log("INIT", "ERROR: Neither video nor audio tracks could be initialized. Aborting stream.")
        return

    # 4. Create initial offer
    offer = await pc.createOffer()
    await pc.setLocalDescription(offer)

    # 5. Wait until STUN gathers public (srflx) candidates
    log("ICE", f"Gathering ICE candidates (state: {pc.iceGatheringState})...")
    while pc.iceGatheringState != "complete":
        await asyncio.sleep(0.05)
    ours = describe_sdp_candidates(pc.localDescription.sdp)
    log("ICE", f"ICE gathering complete. Our candidates: {', '.join(ours) if ours else 'none'}")

    # 6. The WHIP handshake itself
    async with aiohttp.ClientSession() as session:
        log("WHIP", f"POSTing SDP offer to {whip_endpoint} ...")
        try:
            async with session.post(
                whip_endpoint,
                data=pc.localDescription.sdp,
                headers={"Content-Type": "application/sdp"}
            ) as resp:
                if resp.status not in (200, 201):
                    text = await resp.text()
                    log("WHIP", f"Handshake FAILED: HTTP {resp.status} from {whip_endpoint}")
                    log("WHIP", f"Error details: {text.strip()[:500]}")
                    return
                sdp_answer = await resp.text()
                log("WHIP", f"Handshake SUCCEEDED: HTTP {resp.status}, SDP answer received.")
        except Exception as e:
            log("WHIP", f"Handshake FAILED: could not reach {whip_endpoint} ({e})")
            return

    theirs = describe_sdp_candidates(sdp_answer)
    log("WHIP", f"MediaMTX ICE candidates (where the MediaMTX actually is): "
                f"{', '.join(theirs) if theirs else 'none in SDP'}")

    answer = RTCSessionDescription(sdp=sdp_answer, type="answer")
    await pc.setRemoteDescription(answer)

    log("LIVE", f"STREAM LIVE. Channel ID: '{stream_id}' — "
                f"viewers watch via {server_url}/{stream_id}/")

    monitor_task = asyncio.create_task(monitor(pc, MEDIAMTX_API_URL, path_name))
    meta_task = asyncio.create_task(meta_heartbeat(meta_payload))
    try:
        while True:
            await asyncio.sleep(1)
    except (KeyboardInterrupt, asyncio.CancelledError):
        pass
    finally:
        monitor_task.cancel()
        meta_task.cancel()
        await pc.close()

        # Release webcam hardware
        if video_track and hasattr(video_track, "cap") and video_track.cap.isOpened():
            video_track.cap.release()
            log("CLEANUP", "Webcam device released.")

        # Stop audio player worker thread
        if player:
            player.stop()
            log("CLEANUP", "Audio player stopped.")

        await meta_deregister(stream_id)

        log("LIVE", "Stream stopped.")


if __name__ == "__main__":
    asyncio.run(run_whip_publisher(EXTENSION_ECS_URL, STREAM_ID))