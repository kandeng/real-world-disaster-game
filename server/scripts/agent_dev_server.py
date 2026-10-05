#!/usr/bin/env python3
"""DEV-ONLY minimal localhost server for the game-agent slow clock.

Mounts ONLY the game-agent router (``app.game_agent_api``) on :8000, so
localhost testing of the agent worker does not drag in the full ``app.main``
dependency chain (meshes/videos/oauth/youtube/deepseek-harness-sdk). The
production server (ECS01) runs ``app.main`` instead, which mounts the SAME
router — so the client talks to an identical ``/api/game/agent/*`` URL in dev
and prod; only the host changes.

Run from the ``server/`` directory::

    python3 scripts/agent_dev_server.py            # heuristic policy (offline)
    GAME_AGENT_MODE=auto python3 scripts/agent_dev_server.py   # try LLM first
    GAME_AGENT_MODE=dsh  python3 scripts/agent_dev_server.py   # persistent counselor

The mode override is read here (not from config.json) so a dev can flip
policies without editing the gitignored config; it is passed per-call via the
``?mode=`` query on the decide endpoint too.
"""

import os
import sys
from pathlib import Path

# Make ``app`` importable when run as a plain script from server/.
_SERVER_DIR = Path(__file__).resolve().parent.parent
if str(_SERVER_DIR) not in sys.path:
    sys.path.insert(0, str(_SERVER_DIR))

from fastapi import FastAPI  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402

from app.config import CONFIG  # noqa: E402
from app.game_agent_api import router as game_agent_router  # noqa: E402

# Optional env override of the configured policy, applied before the router
# reads it. game_agent_engine resolves ENGINE_MODE at import; re-point it here
# so GAME_AGENT_MODE wins without touching config.json.
_mode = (os.environ.get("GAME_AGENT_MODE") or "").strip().lower()
if _mode in ("heuristic", "llm", "dsh", "auto"):
    from app import game_agent_engine

    game_agent_engine.ENGINE_MODE = _mode

app = FastAPI(title="Game Agent Dev Server", version="0.1")

app.add_middleware(
    CORSMiddleware,
    allow_origins=CONFIG.get("cors_origins", ["http://localhost:5173"]),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    max_age=86400,
)

app.include_router(game_agent_router, prefix="/api")


@app.get("/api/health")
async def health() -> dict:
    from app.game_agent_engine import ENGINE_MODE

    return {"status": "ok", "service": "game-agent-dev", "mode": ENGINE_MODE}


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("GAME_AGENT_PORT", "8000"))
    print(f"[agent-dev] serving /api/game/agent/* on http://localhost:{port} "
          f"(mode={os.environ.get('GAME_AGENT_MODE') or 'config'})")
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="info")
