"""Customer-service chat API: per-(identity, page) transcripts with SSE
streaming turns.

Identity model
--------------
* Signed-in visitors  -> ``user:<uuid>`` (fastapi-users JWT, optional auth).
* Anonymous visitors  -> ``anon:<device-uuid>`` (X-Device-Id header; the SPA
  mints and persists the UUID in localStorage).

Every page owns its own conversation; navigating hides the popup client-side
and reopening reloads that page's transcript. Transcripts expire after
``chat.retention_days`` (default 10) via an hourly sweep plus a lazy check on
read. "Clear conversation" empties the transcript AND mints a new generation
so the DeepSeek-Harness session forgets too.
"""

import asyncio
import json
import logging
import re
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import delete, select

from . import chat_engine
from .config import CONFIG
from .db import async_session_maker
from .models import ChatContext
from .users import fastapi_users

log = logging.getLogger(__name__)

router = APIRouter(prefix="/chat", tags=["chat"])

_optional_user = fastapi_users.current_user(optional=True)

RETENTION_DAYS = int(CONFIG.get("chat", {}).get("retention_days", 10))

_PAGE_RE = re.compile(r"^/[a-zA-Z0-9/_-]{0,119}$")
_DEVICE_RE = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")


def _identity(user, request: Request) -> str:
    if user is not None:
        return f"user:{user.id}"
    device = request.headers.get("x-device-id", "")
    if not _DEVICE_RE.match(device):
        # No trustworthy device id: the turn still works, it just cannot
        # persist history across visits.
        device = uuid.uuid4().hex
    return f"anon:{device.lower()}"


def _normalize_page(page: str) -> str:
    page = page.strip() or "/"
    if not _PAGE_RE.match(page):
        return "/"
    return page


def _aware(dt: datetime) -> datetime:
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _expired(row: ChatContext) -> bool:
    cutoff = datetime.now(timezone.utc) - timedelta(days=RETENTION_DAYS)
    return _aware(row.updated_at) < cutoff


def _sse(obj: dict) -> str:
    return f"data: {json.dumps(obj, ensure_ascii=False)}\n\n"


# ─── History ────────────────────────────────────────────────────────────────


@router.get("/history")
async def get_history(
    request: Request,
    page: str = Query(...),
    user=Depends(_optional_user),
) -> dict:
    identity = _identity(user, request)
    page_key = _normalize_page(page)
    async with async_session_maker() as session:
        row = (
            await session.execute(
                select(ChatContext).where(
                    ChatContext.identity == identity, ChatContext.page_key == page_key
                )
            )
        ).scalar_one_or_none()
        if row is None:
            return {"messages": []}
        if _expired(row):
            await session.delete(row)
            await session.commit()
            return {"messages": []}
        return {"messages": row.messages}


# ─── Streaming turn ─────────────────────────────────────────────────────────


class TurnBody(BaseModel):
    page: str = Field(max_length=120)
    text: str = Field(min_length=1, max_length=2000)
    locale: str = Field(default="en", max_length=8)


@router.post("/turn")
async def post_turn(
    body: TurnBody,
    request: Request,
    user=Depends(_optional_user),
) -> StreamingResponse:
    identity = _identity(user, request)
    page_key = _normalize_page(body.page)
    user_text = body.text.strip()

    # Persist the user turn first (own session: the SSE generator outlives
    # the request scope).
    async with async_session_maker() as session:
        row = (
            await session.execute(
                select(ChatContext).where(
                    ChatContext.identity == identity, ChatContext.page_key == page_key
                )
            )
        ).scalar_one_or_none()
        if row is None:
            row = ChatContext(
                identity=identity,
                page_key=page_key,
                generation=str(uuid.uuid4()),
                messages=[],
            )
            session.add(row)
            await session.commit()
            await session.refresh(row)
        elif _expired(row):
            row.messages = []
            row.generation = str(uuid.uuid4())
        history = [m for m in row.messages if m.get("kind") == "text"]
        row.messages = (row.messages or []) + [
            {
                "role": "user",
                "kind": "text",
                "text": user_text,
                "ts": int(datetime.now(timezone.utc).timestamp() * 1000),
            }
        ]
        await session.commit()
        generation = row.generation

    async def event_stream():
        parts: list[str] = []
        try:
            async for delta in chat_engine.stream_reply(
                page_key, identity, generation, history, user_text
            ):
                parts.append(delta)
                yield _sse({"delta": delta})
        except Exception as exc:  # noqa: BLE001 — keep the SSE contract
            log.exception("chat turn failed: %r", exc)
            yield _sse({"error": "generic"})
        ai_text = "".join(parts).strip()
        if ai_text:
            async with async_session_maker() as session:
                stored = (
                    await session.execute(
                        select(ChatContext).where(
                            ChatContext.identity == identity,
                            ChatContext.page_key == page_key,
                        )
                    )
                ).scalar_one_or_none()
                if stored is not None:
                    stored.messages = (stored.messages or []) + [
                        {
                            "role": "ai",
                            "kind": "text",
                            "text": ai_text,
                            "ts": int(datetime.now(timezone.utc).timestamp() * 1000),
                        }
                    ]
                    # Bound stored transcript size (UI + cost).
                    if len(stored.messages) > 200:
                        stored.messages = stored.messages[-200:]
                    await session.commit()
        yield _sse({"done": True})

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",  # disable Caddy/nginx buffering
        },
    )


# ─── Clear conversation ─────────────────────────────────────────────────────


@router.delete("/context")
async def clear_context(
    request: Request,
    page: str = Query(...),
    user=Depends(_optional_user),
) -> dict:
    identity = _identity(user, request)
    page_key = _normalize_page(page)
    async with async_session_maker() as session:
        row = (
            await session.execute(
                select(ChatContext).where(
                    ChatContext.identity == identity, ChatContext.page_key == page_key
                )
            )
        ).scalar_one_or_none()
        if row is not None:
            row.messages = []
            row.generation = str(uuid.uuid4())  # model forgets as well
            await session.commit()
    return {"ok": True}


# ─── Retention sweep (hourly, started from main.lifespan) ───────────────────


async def sweep_expired() -> int:
    cutoff = datetime.now(timezone.utc) - timedelta(days=RETENTION_DAYS)
    async with async_session_maker() as session:
        result = await session.execute(
            delete(ChatContext).where(ChatContext.updated_at < cutoff)
        )
        await session.commit()
        return result.rowcount or 0


async def sweep_loop() -> None:
    while True:
        try:
            removed = await sweep_expired()
            if removed:
                log.info("chat retention sweep removed %d transcript(s)", removed)
        except Exception:  # noqa: BLE001 — never kill the loop
            log.exception("chat retention sweep failed")
        await asyncio.sleep(3600)
