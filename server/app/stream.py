"""Livestream runtime configuration for the SPA.

The catalog is LIVE-ONLY: the left panel lists exactly the streams that
have an active publisher on MediaMTX (drone bridges, browser 发起直播,
...) — nothing static. The backend asks the MediaMTX Control API for its
READY paths on every request and serves them as catalog entries; static
``mediamtx.streams`` entries (usually none) are merged in first and get
``live: true`` while their path is ready.

The WHEP base URL every entry is built from comes from the top-level
``mediamtx.whep_url`` (legacy single-stream pointer, kept precisely as
the base source) or any static entry:

    local:       "whep_url": "http://127.0.0.1:8889/<id>/whep"
    production:  "whep_url": "https://drone-navigation.com/live/<id>/whep"

The Control API base is taken from ``mediamtx.control_api_url`` when set,
otherwise derived from the production Caddy layout (``.../live/...`` ->
``.../control-api``), falling back to a local MediaMTX
(``http://127.0.0.1:9997``). Any failure degrades to the static catalog —
this endpoint must never break the Livestream page.

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


def _candidate_urls(mt: dict, streams_cfg: list) -> list:
    """Every configured WHEP URL (top-level legacy pointer first)."""
    urls = [mt.get("whep_url") or ""]
    urls += [s.get("whep_url") or "" for s in streams_cfg]
    return [u for u in urls if u]


def _control_api_url(mt: dict, streams_cfg: list) -> str:
    """MediaMTX Control API base URL (no trailing slash)."""
    configured = (mt.get("control_api_url") or "").strip()
    if configured:
        return configured.rstrip("/")
    # Production Caddy layout: https://<host>/live/<id>/whep proxies to
    # MediaMTX :8889, and /control-api/* proxies to :9997.
    for url in _candidate_urls(mt, streams_cfg):
        if "/live/" in url:
            return url.split("/live/", 1)[0] + "/control-api"
    # Local dev default: MediaMTX next to the backend.
    return "http://127.0.0.1:9997"


def _whep_base(mt: dict, streams_cfg: list) -> str:
    """WHEP base shared by all catalog entries (empty when unconfigured)."""
    for url in _candidate_urls(mt, streams_cfg):
        url = url.rstrip("/")
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
        base = _whep_base(mt, static)
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
