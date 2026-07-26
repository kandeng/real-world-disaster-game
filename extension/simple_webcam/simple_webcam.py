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
EXTENSION_ECS_URL = "https://drone-navigation.com/live"

# Specific livestream properties
LIVESTREAM_HOSTNAME = "ubuntu-webcam"
LIVESTREAM_DESCRIPTION = "A webcam stream from Kan's Ubuntu desktop"

# MediaMTX control API (default port 9997). Proxied via Caddy /control-api or directly via ECS IP.
MEDIAMTX_API_URL = "https://drone-navigation.com/control-api"

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

        # Overlay identifying text on frame: the friendly hostname (not
        # the raw stream_id) so the broadcast top line matches the UI.
        cv2.putText(
            frame,
            f"{LIVESTREAM_HOSTNAME} - {time.strftime('%H:%M:%S')}",
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
    """Extract a list of candidate IPs/ports from an SDP block."""
    found = []
    for line in sdp.splitlines():
        if not line.startswith("a=candidate:"):
            continue
        parts = line.split()
        try:
            ip, port = parts[4], parts[5]
            ctype = parts[parts.index("typ") + 1]
        except (ValueError, IndexError):
            continue
        found.append(f"{ip}:{port} ({ctype})")
    return found


def stream_path_name(server_url, stream_id):
    """'https://drone-navigation.com/live' + 'ubuntu-webcam' -> 'live/ubuntu-webcam'."""
    prefix = urlparse(server_url).path.strip("/")
    return f"{prefix}/{stream_id}" if prefix else stream_id


async def log_selected_ice_pair(pc):
    """Report active ICE candidate pair once connected."""
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
    """Log upload bitrate and viewer counts from MediaMTX Control API."""
    api_ok = True
    last_bytes = 0
    async with aiohttp.ClientSession() as session:
        while True:
            await asyncio.sleep(interval)

            # Upload progress
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

            # Viewer count via MediaMTX API
            if not api_base:
                continue
            try:
                async with session.get(
                    f"{api_base.rstrip('/')}/v3/webrtcsessions/list",
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


async def run_whip_publisher(server_url, stream_id):
    whip_endpoint = f"{server_url}/{stream_id}/whip"
    path_name = stream_path_name(server_url, stream_id)

    log("INIT", f"Stream ID: '{stream_id}' (MediaMTX path: '{path_name}')")
    log("INIT", f"WHIP endpoint: {whip_endpoint}")

    # Resolve target host
    host = urlparse(server_url).hostname
    try:
        addrs = sorted({ai[4][0] for ai in socket.getaddrinfo(host, None)})
        log("INIT", f"MediaMTX target host '{host}' resolves to: {', '.join(addrs)}")
    except Exception as e:
        log("INIT", f"Could not resolve host '{host}': {e}")

    log("INIT", f"Using STUN server: {STUN_SERVER}")

    pc = RTCPeerConnection(configuration=rtc_config)

    @pc.on("iceconnectionstatechange")
    async def on_ice_state_change():
        log("ICE", f"ICE connection state -> {pc.iceConnectionState}")
        if pc.iceConnectionState == "connected":
            await log_selected_ice_pair(pc)
        elif pc.iceConnectionState == "failed":
            log("ICE", "Handshake FAILED: check STUN server, firewalls, or UDP ports.")

    # 1. Initialize Video Track
    video_track = None
    try:
        video_track = WebcamStreamTrack(stream_id)
        if video_track.cap.isOpened():
            w = int(video_track.cap.get(cv2.CAP_PROP_FRAME_WIDTH))
            h = int(video_track.cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
            pc.addTrack(video_track)
            log("INIT", f"Webcam opened: {w}x{h}")
        else:
            log("INIT", "WARNING: Webcam device 0 failed to open. Streaming without video.")
    except Exception as e:
        log("INIT", f"WARNING: Video initialization failed ({e}).")

    # 2. Initialize Audio Track
    player = None
    try:
        player = MediaPlayer('default', format='pulse')
        if player.audio:
            pc.addTrack(player.audio)
            log("INIT", "Microphone audio track added successfully.")
    except Exception as e:
        log("INIT", f"WARNING: Audio track initialization failed ({e}).")

    if not pc.getSenders():
        log("INIT", "ERROR: No audio or video tracks could be initialized. Terminating.")
        return

    # 3. WebRTC Offer & ICE Gathering
    offer = await pc.createOffer()
    await pc.setLocalDescription(offer)

    log("ICE", f"Gathering ICE candidates (state: {pc.iceGatheringState})...")
    while pc.iceGatheringState != "complete":
        await asyncio.sleep(0.05)
    ours = describe_sdp_candidates(pc.localDescription.sdp)
    log("ICE", f"ICE gathering complete. Candidates: {', '.join(ours) if ours else 'none'}")

    # 4. WHIP Handshake over HTTPS/Caddy
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
    log("WHIP", f"MediaMTX ICE candidates: {', '.join(theirs) if theirs else 'none in SDP'}")

    answer = RTCSessionDescription(sdp=sdp_answer, type="answer")
    await pc.setRemoteDescription(answer)

    log("LIVE", f"STREAM LIVE. Stream ID: '{stream_id}'")

    monitor_task = asyncio.create_task(monitor(pc, MEDIAMTX_API_URL, path_name))

    try:
        while True:
            await asyncio.sleep(1)
    except (KeyboardInterrupt, asyncio.CancelledError):
        pass
    finally:
        monitor_task.cancel()
        await pc.close()

        if video_track and hasattr(video_track, "cap") and video_track.cap.isOpened():
            video_track.cap.release()
            log("CLEANUP", "Webcam hardware released.")

        if player:
            player.stop()
            log("CLEANUP", "Audio player stopped.")

        log("LIVE", "Stream shutdown complete.")


if __name__ == "__main__":
    asyncio.run(run_whip_publisher(EXTENSION_ECS_URL, LIVESTREAM_HOSTNAME))
    