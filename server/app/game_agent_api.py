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
logging and (server-side) session keying. Production can layer the same
optional-JWT identity the chat API uses; the intent contract is unchanged.
"""

import logging

from fastapi import APIRouter
from pydantic import BaseModel, Field

from .game_agent_engine import (
    ENGINE_MODE,
    MODEL,
    close_session,
    decide,
    list_archetypes,
    list_sessions,
    open_session,
    register_archetype,
)

log = logging.getLogger(__name__)

router = APIRouter(prefix="/game", tags=["game-agent"])


class DecideBody(BaseModel):
    session: str = Field(default="", max_length=120)
    asset: str = Field(default="", max_length=40)
    observation: dict = Field(default_factory=dict)
    # Optional per-call policy override (llm | vlm | auto); the dev UI uses it
    # to A/B policies without a server restart.
    mode: str | None = Field(default=None, max_length=16)
    # ── generic slow-agent fields: the package declares the archetype policy ──
    archetype: str = Field(default="", max_length=64)   # selects the package policy spec
    agent_id: str = Field(default="", max_length=120, alias="agentId")
    image: str | None = Field(default=None)             # data URL enabling the VLM route
    actions: list | None = Field(default=None)          # inline tool spec [{name, description, parameters}]
    persona: str = Field(default="", max_length=4000)

    model_config = {"populate_by_name": True}


class ArchetypeBody(BaseModel):
    archetype: str = Field(max_length=64)
    actions: list = Field(default_factory=list)
    persona: str = Field(default="", max_length=4000)
    mode: str = Field(default="", max_length=16)


class SessionBody(BaseModel):
    session: str = Field(default="", max_length=120)
    asset: str = Field(default="", max_length=40)


@router.get("/agent/config")
async def agent_config() -> dict:
    """Active policy + the capability summary the agent worker advertises."""
    return {
        "mode": ENGINE_MODE,
        "model": MODEL,
        "modes": ["llm", "vlm", "auto"],
        "archetypes": list_archetypes(),
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
    """One observation in, one intent out. Never raises (engine guarantees).

    Routes to the GENERIC multi-agent decide: the package names an archetype
    (and may carry an inline tool spec), and the engine only ever emits actions
    from that archetype's whitelist.
    """
    spec = {"archetype": body.archetype, "actions": body.actions or [],
            "persona": body.persona, "mode": body.mode or ""} if body.actions else None
    result = await decide(
        body.observation,
        archetype=body.archetype,
        agent_id=body.agent_id,
        mode=body.mode,
        session=body.session,
        image=body.image,
        spec=spec,
    )
    intent = result.get("intent")
    log.info(
        "game_agent decide session=%s asset=%s archetype=%s agent=%s policy=%s intent=%s",
        body.session or "-", body.asset, body.archetype or "-", body.agent_id or "-",
        result.get("policy"), intent.get("type") if intent else None,
    )
    return {"session": body.session, "asset": body.asset, **result}


@router.post("/agent/archetype")
async def agent_archetype_register(body: ArchetypeBody) -> dict:
    """Register a package-declared archetype policy (whitelist + tools + persona).

    This is how the per-archetype ALLOWED_ACTIONS is "sourced from the package":
    the client uploads the archetype's tool schemas and the engine only ever
    emits actions from that set. Idempotent per archetype name.
    """
    rec = register_archetype(body.model_dump())
    log.info("game_agent archetype register %s actions=%s", body.archetype, rec.get("actions"))
    return rec


@router.get("/agent/archetypes")
async def agent_archetypes() -> dict:
    """List the currently registered package archetype policies."""
    archetypes = list_archetypes()
    return {"count": len(archetypes), "archetypes": archetypes}
