"""Game-agent API — the HTTP edge of the slow clock.

The browser's per-session *agent worker* POSTs the core worker's latest state
snapshot here and receives one *intent* (a protocol command) to relay back.
This router is deliberately tiny and dependency-light: it mounts in the full
``app.main`` for production (ECS01) AND in ``scripts/agent_dev_server.py`` for
localhost testing, without dragging in the mesh/video/oauth dependency chain.

Endpoints (mounted under ``/api``)::

    GET  /api/game/agent/config   -> active policy + capability summary
    POST /api/game/agent/decide   -> { observation } -> { intent, policy, rationale }

No auth in dev: the caller supplies an opaque ``session`` id used only for
logging and (server-side) DSH session keying. Production can layer the same
optional-JWT identity the chat API uses; the intent contract is unchanged.
"""

import logging

from fastapi import APIRouter
from pydantic import BaseModel, Field

from . import game_agent_engine
from .game_agent_engine import (
    ALLOWED_ACTIONS,
    DEFAULT_DROP_RADIUS_M,
    ENGINE_MODE,
    MODEL,
    close_session,
    dsh_available,
    list_sessions,
    open_session,
)

log = logging.getLogger(__name__)

router = APIRouter(prefix="/game", tags=["game-agent"])


class DecideBody(BaseModel):
    session: str = Field(default="", max_length=120)
    asset: str = Field(default="fire", max_length=40)
    observation: dict = Field(default_factory=dict)
    # Optional per-call policy override (heuristic | llm | dsh | auto); the dev
    # UI uses it to A/B policies without a server restart.
    mode: str | None = Field(default=None, max_length=16)


class SessionBody(BaseModel):
    session: str = Field(default="", max_length=120)
    asset: str = Field(default="fire", max_length=40)


@router.get("/agent/config")
async def agent_config() -> dict:
    """Active policy + the capability summary the agent worker advertises."""
    return {
        "mode": ENGINE_MODE,
        "model": MODEL,
        "actions": sorted(ALLOWED_ACTIONS),
        "dropRadiusM": DEFAULT_DROP_RADIUS_M,
        # E4: whether the persistent DSH counselor can run here (SDK installed
        # + key present). False on a plain localhost box -> auto degrades to
        # the one-shot llm or the heuristic; true on ECS01.
        "dshAvailable": dsh_available(),
        "modes": ["heuristic", "llm", "dsh", "auto"],
    }


@router.post("/agent/session/open")
async def agent_session_open(body: SessionBody) -> dict:
    """Register (or revive) the counselor session keyed to a browser agent
    worker. Idempotent; also sweeps idle sessions (lazy GC)."""
    rec = open_session(body.session, body.asset)
    log.info("game_agent session open session=%s asset=%s", rec["session"], rec["asset"])
    return {
        "session": rec["session"],
        "asset": rec["asset"],
        "mode": ENGINE_MODE,
        "dshAvailable": dsh_available(),
        "actions": sorted(ALLOWED_ACTIONS),
        "dropRadiusM": DEFAULT_DROP_RADIUS_M,
    }


@router.post("/agent/session/close")
async def agent_session_close(body: SessionBody) -> dict:
    """Best-effort close from the browser. The server-side idle GC is the
    authoritative reaper (a closed tab never sends this)."""
    closed = close_session(body.session)
    log.info("game_agent session close session=%s closed=%s", body.session or "-", closed)
    return {"session": body.session, "closed": closed}


@router.get("/agent/sessions")
async def agent_sessions() -> dict:
    """Live counselor sessions (dev/ops visibility); sweeps idle first."""
    sessions = list_sessions()
    return {"count": len(sessions), "sessions": sessions}


@router.post("/agent/decide")
async def agent_decide(body: DecideBody) -> dict:
    """One observation in, one intent out. Never raises (engine guarantees)."""
    result = await game_agent_engine.decide_intent(
        body.observation, body.mode, body.session
    )
    intent = result.get("intent")
    log.info(
        "game_agent decide session=%s asset=%s policy=%s intent=%s",
        body.session or "-", body.asset, result.get("policy"),
        intent.get("type") if intent else None,
    )
    return {"session": body.session, "asset": body.asset, **result}
