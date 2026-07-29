"""Livestream runtime configuration for the SPA.

The WHEP playback URL lives in ``server/config.json`` (``mediamtx`` section)
so the SAME frontend build plays the desktop MediaMTX in local dev and the
ECS MediaMTX in production — only the deployed config differs:

    local:       "mediamtx": { "whep_url": "http://127.0.0.1:8889/crazyflie-drone/whep" }
    production:  "mediamtx": { "whep_url": "https://drone-navigation.com/live/crazyflie-drone/whep" }

The default stream id is ``crazyflie-drone`` — the real drone's broadcast
published by ``extension/crazyflie_bridge/crazyflie_mediamtx.py``.

The endpoint is public: the URL is not a secret (it is reachable from the
browser anyway) and the Livestream page must work for logged-out visitors.
"""

from fastapi import APIRouter

from .config import CONFIG

router = APIRouter(tags=["stream"])


@router.get("/stream/config")
async def stream_config() -> dict:
    mt = CONFIG.get("mediamtx", {})
    # Empty string when unconfigured — the SPA then keeps its built-in
    # environment fallback (local in dev, /live via Caddy in production).
    return {"whep_url": mt.get("whep_url", "")}
