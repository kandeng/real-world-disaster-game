"""Livestream runtime configuration for the SPA.

The playable stream catalog lives in ``server/config.json`` (``mediamtx``
section) so the SAME frontend build plays the desktop MediaMTX in local
dev and the ECS MediaMTX in production — only the deployed config differs:

    local:       "streams": [ { ..., "whep_url": "http://127.0.0.1:8889/<id>/whep" }, ... ]
    production:  "streams": [ { ..., "whep_url": "https://drone-navigation.com/live/<id>/whep" }, ... ]

Each ``streams`` entry: ``{id, hostname, description, whep_url, live}`` —
the first entry is the PRIMARY stream (the one the Livestream Host subpage
monitors; default: ``crazyflie-drone``, the real drone's broadcast
published by ``extension/crazyflie_bridge/crazyflie_mediamtx.py``).
``whep_url`` (singular) is the legacy single-stream form — still returned
for backward compatibility.

Dynamic merge: on every request we also ask the MediaMTX Control API for
its list of READY paths and merge any path that is not already in the
static catalog (e.g. ``web-<user>`` browser broadcasts started from the
Community page). Static entries get ``live: true`` while their path is
ready. The Control API base is taken from ``mediamtx.control_api_url``
when set, otherwise derived from the production Caddy layout
(``https://<host>/live/...`` -> ``https://<host>/control-api``), falling
back to a local MediaMTX (``http://127.0.0.1:9997``). Any failure degrades
to the static catalog — this endpoint must never break the Livestream page.

The endpoint is public: the URLs are not secrets (they are reachable from
the browser anyway) and the Livestream page must work for logged-out
visitors.
"""

import logging

import httpx
from fastapi import APIRouter

from .config import CONFIG

logger = logging.getLogger(__name__)

router = APIRouter(tags=["stream"])


def _control_api_url(mt: dict, streams_cfg: list) -> str:
    """MediaMTX Control API base URL (no trailing slash)."""
    configured = (mt.get("control_api_url") or "").strip()
    if configured:
        return configured.rstrip("/")
    # Production Caddy layout: https://<host>/live/<id>/whep proxies to
    # MediaMTX :8889, and /control-api/* proxies to :9997.
    for s in streams_cfg:
        url = s.get("whep_url") or ""
        if "/live/" in url:
            return url.split("/live/", 1)[0] + "/control-api"
    # Local dev default: MediaMTX next to the backend.
    return "http://127.0.0.1:9997"


def _whep_base(streams_cfg: list) -> str:
    """WHEP base shared by all catalog entries (empty when unconfigured)."""
    for s in streams_cfg:
        url = (s.get("whep_url") or "").rstrip("/")
        if url.endswith("/whep"):
            return url[: -len("/whep")].rsplit("/", 1)[0]
    return ""


async def _active_paths(control_api: str) -> dict | None:
    """name -> path item for every READY path, or None when unreachable."""
    try:
        async with httpx.AsyncClient(timeout=2.0) as client:
            res = await client.get(f"{control_api}/v3/paths/list")
            res.raise_for_status()
            items = res.json().get("items") or []
        return {item["name"]: item for item in items if item.get("ready")}
    except Exception as exc:  # noqa: BLE001 — catalog must degrade, not fail
        logger.info("MediaMTX paths list unavailable (%s): %s", control_api, exc)
        return None


@router.get("/stream/config")
async def stream_config() -> dict:
    mt = CONFIG.get("mediamtx", {})
    static = mt.get("streams", [])

    active = await _active_paths(_control_api_url(mt, static))
    if active is None:
        # MediaMTX unreachable — serve the static catalog unchanged.
        streams_out = static
    else:
        base = _whep_base(static)
        known = set()
        streams_out = []
        for s in static:
            entry = dict(s)
            entry["live"] = entry.get("id") in active
            known.add(entry.get("id"))
            streams_out.append(entry)
        if base:
            # Unknown READY paths = live broadcasts from elsewhere (browser
            # 发起直播, drone bridges, ...). Flat path names only.
            for name in sorted(active):
                if name in known or "/" in name:
                    continue
                streams_out.append({
                    "id": name,
                    "hostname": name,
                    "description": "",
                    "whep_url": f"{base}/{name}/whep",
                    "live": True,
                })

    # Empty values when unconfigured — the SPA then keeps its built-in
    # environment fallback (local in dev, /live via Caddy in production).
    return {
        "whep_url": mt.get("whep_url", ""),
        "streams": streams_out,
    }
