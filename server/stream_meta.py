"""Sidecar metadata service for drone livestreams.

MediaMTX itself stores no custom per-stream metadata, so this tiny service
holds the rich fields (title, description, device, location, resolution, fps)
that publishers push while live. The web client joins this with the MediaMTX
control API (`/v3/paths/list` = source of truth for WHAT IS LIVE) to render
the Livestream Viewer list.

Publisher (simple_webcam.py) contract:
  POST   /streams-meta/            upsert, called periodically while live
  DELETE /streams-meta/{stream_id} deregister on shutdown

Client (Vue) contract:
  GET    /streams-meta/            -> { "items": [ ... ] }
  GET    /streams-meta/{stream_id} -> one entry, 404 if unknown

Run (behind nginx, never exposed directly):
  python stream_meta.py            # or: uvicorn stream_meta:app --host 127.0.0.1 --port 8099
nginx:
  location /streams-meta/ { proxy_pass http://127.0.0.1:8099/; }

Auth: if config.json sets "stream_meta_api_key", POST/DELETE require the
X-API-Key header; GET is always public (titles are public anyway).
"""

import json
import time
from pathlib import Path

from fastapi import FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

CONFIG_PATH = Path(__file__).with_name("config.json")
if CONFIG_PATH.exists():
    CONFIG = json.loads(CONFIG_PATH.read_text())
else:
    CONFIG = {}

API_KEY = CONFIG.get("stream_meta_api_key") or None

app = FastAPI(title="Drone stream metadata sidecar")

# GET is public; nginx normally makes this same-origin anyway. Keep CORS
# permissive so the Vite dev server (localhost:5173) can poll directly.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class StreamMeta(BaseModel):
    stream_id: str
    title: str = ""
    description: str = ""
    device: str = ""
    location: str = ""
    resolution: str = ""
    fps: float | None = None

    model_config = {"extra": "allow"}  # publishers may add custom fields


class StreamStatus(BaseModel):
    stream_id: str
    status: str  # "active" | "offline" — pushed by MediaMTX path hooks


# In-memory registry — fine for a handful of drones; lost on restart, but
# publishers re-announce every META heartbeat, so it heals within seconds.
REGISTRY: dict[str, dict] = {}


def _check_key(x_api_key: str | None) -> None:
    if API_KEY and x_api_key != API_KEY:
        raise HTTPException(status_code=401, detail="invalid API key")


@app.get("/streams-meta/")
async def list_streams():
    return {"items": list(REGISTRY.values())}


@app.get("/streams-meta/{stream_id}")
async def get_stream(stream_id: str):
    entry = REGISTRY.get(stream_id)
    if entry is None:
        raise HTTPException(status_code=404, detail="unknown stream")
    return entry


@app.post("/streams-meta/")
async def upsert_stream(meta: StreamMeta, x_api_key: str | None = Header(default=None)):
    _check_key(x_api_key)
    entry = meta.model_dump()
    entry["updated_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    REGISTRY[meta.stream_id] = entry
    return entry


@app.post("/streams-meta/stream-status")
async def stream_status(update: StreamStatus):
    """Receive liveness pushed by MediaMTX (mediamtx.yml runOnReady /
    runOnNotReady hooks POST {"stream_id": $MTX_PATH, "status": ...}).

    Deliberately NO API key: the hook curls in mediamtx.yml carry no
    secrets, and the worst a forger can do is flip a display flag. The
    publisher upsert/delete routes above still require the key when
    configured.
    """
    entry = REGISTRY.get(update.stream_id)
    if entry is None:
        # Hook fired before any publisher heartbeat — create a stub entry;
        # the next heartbeat (<=30s) fills in the rich fields.
        entry = {"stream_id": update.stream_id}
        REGISTRY[update.stream_id] = entry
    entry["status"] = update.status
    entry["status_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    return entry


@app.delete("/streams-meta/{stream_id}")
async def delete_stream(stream_id: str, x_api_key: str | None = Header(default=None)):
    _check_key(x_api_key)
    removed = REGISTRY.pop(stream_id, None)
    if removed is None:
        raise HTTPException(status_code=404, detail="unknown stream")
    return {"removed": stream_id}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        app,
        host=CONFIG.get("host", "127.0.0.1"),
        port=int(CONFIG.get("port", 8099)),
    )
