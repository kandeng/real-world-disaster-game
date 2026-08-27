"""Per-user published flight videos (Content -> Video).

GET /api/videos        -> the caller's videos, most recent first, each with
                          its playback sources ordered by position. A brand
                          new account is seeded with a couple of demo videos
                          minted from its demo routes (title + waypoints
                          copied once, route_id recorded as provenance).
GET /api/videos/public -> the Gallery feed: every user's published videos,
                          most recent first, with author names. Open to
                          anonymous callers (the Gallery page is public).
PUT /api/videos/{id}   -> replace title / waypoint snapshot / sources.
POST /api/videos/{id}/upload-youtube
                       -> the Route Planning -> Video dialog posts the
                          finished mp4; the server uploads it to the site's
                          YouTube channel (unlisted, added to the
                          `drone-navigation` playlist) and stores the watch
                          URL as the primary playback source.

Ownership is enforced purely at this layer: every statement is scoped by
the JWT caller's id and foreign ids surface as 404 (API-only hardening,
per the CMS schema decision).
"""

import uuid
from datetime import datetime, timedelta, timezone
from tempfile import SpooledTemporaryFile

import asyncio

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from . import youtube_upload
from .db import get_async_session
from .models import Route, User, Video, VideoSource
from .routes_api import WaypointIn, _seed_rows
from .users import current_active_user

router = APIRouter(tags=["videos"])


class SourceIn(BaseModel):
    provider: str = Field(max_length=32)
    url: str = Field(max_length=2048)
    position: int = 0


class VideoCreate(BaseModel):
    route_id: str
    title: str | None = Field(default=None, max_length=200)
    description: str = Field(default="", max_length=2000)
    delete_previous: bool = False


class VideoUpdate(BaseModel):
    title: str = Field(max_length=200)
    description: str | None = Field(default=None, max_length=2000)
    waypoints: list[WaypointIn]
    sources: list[SourceIn]


async def _user_routes(session: AsyncSession, user_id: uuid.UUID) -> list[Route]:
    stmt = (
        select(Route)
        .where(Route.user_id == user_id)
        .order_by(Route.created_at.desc())
    )
    rows = list((await session.execute(stmt)).scalars().all())
    if not rows:
        rows = _seed_rows(user_id)
        session.add_all(rows)
        await session.commit()
        for r in rows:
            await session.refresh(r)
        rows.sort(key=lambda r: r.created_at, reverse=True)
    return rows


def _seed_videos(user_id: uuid.UUID, routes: list[Route]) -> list[Video]:
    """Demo content: two videos minted from the user's demo routes — the
    title and waypoint snapshot are copied from the route at creation,
    exactly what the real minting flow will do."""
    now = datetime.now(timezone.utc)
    videos: list[Video] = []
    if routes:
        first = routes[0]
        v1 = Video(
            user_id=user_id,
            route_id=first.id,
            title=first.title,
            waypoints=[dict(w) for w in first.waypoints],
            created_at=now - timedelta(days=1),
            updated_at=now - timedelta(days=1),
        )
        videos.append(v1)
        if len(routes) > 1:
            last = routes[-1]
            v2 = Video(
                user_id=user_id,
                route_id=last.id,
                title=last.title,
                waypoints=[dict(w) for w in last.waypoints],
                created_at=now - timedelta(days=10),
                updated_at=now - timedelta(days=10),
            )
            videos.append(v2)
    return videos


def _seed_sources(video: Video, both: bool) -> list[VideoSource]:
    sources = [
        VideoSource(
            video_id=video.id,
            provider="youtube",
            url="https://www.youtube.com/watch?v=drone-stanford-01",
            position=0,
        )
    ]
    if both:
        sources.append(
            VideoSource(
                video_id=video.id,
                provider="bilibili",
                url="https://www.bilibili.com/video/BV1drone01",
                position=1,
            )
        )
    return sources


async def _serialize(
    session: AsyncSession, video: Video, author_name: str | None
) -> dict:
    stmt = (
        select(VideoSource)
        .where(VideoSource.video_id == video.id)
        .order_by(VideoSource.position.asc())
    )
    sources = (await session.execute(stmt)).scalars().all()
    return {
        "id": str(video.id),
        "title": video.title,
        "description": video.description,
        "route_id": str(video.route_id) if video.route_id else None,
        "author_name": author_name,
        "created_at": video.created_at.isoformat(),
        "waypoints": video.waypoints,
        "sources": [
            {"provider": s.provider, "url": s.url, "position": s.position}
            for s in sources
        ],
    }


@router.get("/videos")
async def list_videos(
    user: User = Depends(current_active_user),
    session: AsyncSession = Depends(get_async_session),
) -> list[dict]:
    stmt = (
        select(Video)
        .where(Video.user_id == user.id)
        .order_by(Video.created_at.desc())
    )
    videos = list((await session.execute(stmt)).scalars().all())
    if not videos:
        routes = await _user_routes(session, user.id)
        videos = _seed_videos(user.id, routes)
        if videos:
            session.add_all(videos)
            await session.flush()  # assigns video ids for the FK below
            sources = []
            for i, v in enumerate(videos):
                sources.extend(_seed_sources(v, both=(i == 0)))
            session.add_all(sources)
            await session.commit()
            for v in videos:
                await session.refresh(v)
    return [await _serialize(session, v, user.display_name) for v in videos]


@router.get("/videos/public")
async def list_public_videos(
    session: AsyncSession = Depends(get_async_session),
) -> list[dict]:
    """Gallery feed for every visitor (incl. anonymous): all published
    videos of all users, most recent first, with the author display name."""
    stmt = (
        select(Video, User.display_name)
        .outerjoin(User, Video.user_id == User.id)
        .order_by(Video.created_at.desc())
    )
    rows = (await session.execute(stmt)).all()
    return [await _serialize(session, v, name) for v, name in rows]


@router.post("/videos", status_code=201)
async def create_video(
    body: VideoCreate,
    user: User = Depends(current_active_user),
    session: AsyncSession = Depends(get_async_session),
) -> dict:
    """Mint a video from one of the caller's routes: title and waypoints
    are copied once (frozen snapshot) and route_id kept as provenance.
    Playback sources start empty; the owner adds them later via PUT."""
    stmt = select(Route).where(Route.id == body.route_id, Route.user_id == user.id)
    route = (await session.execute(stmt)).scalar_one_or_none()
    if route is None:
        raise HTTPException(status_code=404, detail="ROUTE_NOT_FOUND")
    if body.delete_previous:
        old = (
            await session.execute(
                select(Video).where(Video.user_id == user.id, Video.route_id == route.id)
            )
        ).scalars().all()
        for ov in old:
            await session.execute(delete(VideoSource).where(VideoSource.video_id == ov.id))
            await session.delete(ov)
    video = Video(
        user_id=user.id,
        route_id=route.id,
        title=body.title if body.title else route.title,
        description=body.description,
        waypoints=[dict(w) for w in route.waypoints],
        created_at=route.created_at,  # the card shows the route's creation time
    )
    session.add(video)
    await session.commit()
    await session.refresh(video)
    return await _serialize(session, video, user.display_name)


@router.put("/videos/{video_id}")
async def update_video(
    video_id: str,
    body: VideoUpdate,
    user: User = Depends(current_active_user),
    session: AsyncSession = Depends(get_async_session),
) -> dict:
    stmt = select(Video).where(Video.id == video_id, Video.user_id == user.id)
    video = (await session.execute(stmt)).scalar_one_or_none()
    if video is None:
        raise HTTPException(status_code=404, detail="VIDEO_NOT_FOUND")

    providers = [s.provider for s in body.sources]
    if len(providers) != len(set(providers)):
        raise HTTPException(status_code=400, detail="DUPLICATE_PROVIDER")

    video.title = body.title
    if body.description is not None:
        video.description = body.description
    video.waypoints = [w.model_dump() for w in body.waypoints]
    await session.execute(
        delete(VideoSource).where(VideoSource.video_id == video.id)
    )
    for pos, s in enumerate(body.sources):
        session.add(
            VideoSource(
                video_id=video.id,
                provider=s.provider,
                url=s.url,
                position=pos,
            )
        )
    await session.commit()
    await session.refresh(video)
    return await _serialize(session, video, user.display_name)


# youtube_upload error codes -> HTTP status (detail carries the code so
# the dialog can show the matching i18n message).
_YT_STATUS = {
    "youtube_not_configured": 503,
    "youtube_auth": 503,
    "youtube_quota": 429,
    "youtube_signup": 409,
}


@router.post("/videos/{video_id}/upload-youtube")
async def upload_video_to_youtube(
    video_id: str,
    file: UploadFile = File(...),
    user: User = Depends(current_active_user),
    session: AsyncSession = Depends(get_async_session),
) -> dict:
    """Receive the generated mp4 and upload it to the site YouTube channel.

    The blocking Google client runs in a worker thread; the mp4 is spooled
    to disk (never held fully in memory). On success the watch URL becomes
    the video's primary source (provider "youtube", position 0), the other
    providers keep their order behind it.
    """
    stmt = select(Video).where(Video.id == video_id, Video.user_id == user.id)
    video = (await session.execute(stmt)).scalar_one_or_none()
    if video is None:
        raise HTTPException(status_code=404, detail="VIDEO_NOT_FOUND")
    ctype = file.content_type or ""
    if ctype not in ("", "video/mp4") and not (file.filename or "").endswith(".mp4"):
        raise HTTPException(status_code=415, detail="NOT_MP4")

    spool = SpooledTemporaryFile(max_size=64 * 1024 * 1024)
    try:
        size = 0
        while chunk := await file.read(1024 * 1024):
            size += len(chunk)
            if size > youtube_upload.MAX_SIZE:
                raise HTTPException(status_code=413, detail="FILE_TOO_LARGE")
            spool.write(chunk)
        spool.seek(0)
        try:
            _, watch_url = await asyncio.to_thread(
                youtube_upload.upload_mp4,
                spool,
                video.title or "Drone route video",
                video.description or "",
            )
        except youtube_upload.YouTubeUploadError as err:
            raise HTTPException(
                status_code=_YT_STATUS.get(err.code, 502), detail=err.code
            )

        # Rewrite sources: the fresh YouTube URL first, the rest behind it.
        existing = (
            (
                await session.execute(
                    select(VideoSource)
                    .where(VideoSource.video_id == video.id)
                    .order_by(VideoSource.position.asc())
                )
            )
            .scalars()
            .all()
        )
        others = [s for s in existing if s.provider != "youtube"]
        await session.execute(
            delete(VideoSource).where(VideoSource.video_id == video.id)
        )
        session.add(
            VideoSource(
                video_id=video.id, provider="youtube", url=watch_url, position=0
            )
        )
        for pos, s in enumerate(others, start=1):
            session.add(
                VideoSource(
                    video_id=video.id, provider=s.provider, url=s.url, position=pos
                )
            )
        await session.commit()
        await session.refresh(video)
        return await _serialize(session, video, user.display_name)
    finally:
        spool.close()
