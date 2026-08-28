"""Per-user published flight videos (Content -> Video).

GET /api/videos        -> the caller's videos, most recent first, each with
                          its playback sources ordered by position. A brand
                          new account is seeded with a couple of demo videos
                          minted from its demo routes (title + waypoints
                          copied once, route_id recorded as provenance).
GET /api/videos/public -> the Gallery feed: every user's published videos,
                          most recent first, with author names. Open to
                          anonymous callers (the Gallery page is public).
PUT /api/videos/{id}   -> replace title / waypoint snapshot / sources and
                          keep the YouTube post in step: title and
                          description always, the footage too when the
                          cached mp4 is newer than the post.
DELETE /api/videos/{id}
                       -> retire one of the caller's videos: the YouTube
                          post (best-effort), the playback sources, the
                          row itself and the persisted mp4.
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
from pathlib import Path
from tempfile import SpooledTemporaryFile
from urllib.parse import parse_qs, urlparse

import asyncio
import logging
import shutil

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask
from pydantic import BaseModel, Field
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from . import youtube_upload
from .config import CONFIG
from .db import get_async_session
from .models import Route, User, Video, VideoSource
from .routes_api import WaypointIn, _seed_rows
from .users import current_active_user

router = APIRouter(tags=["videos"])
log = logging.getLogger(__name__)

# Bounded mp4 cache: every mp4 received via upload-youtube is kept on disk
# here so Content -> Video's Download button can serve it back (the
# workspace/ directory is excluded from the deploy rsync, so the files
# survive backend redeploys). The cache is capped by file count:
#  - a download consumes its file (unlinked after the response is sent);
#  - a new upload that overflows the cap evicts the oldest entries.
# The canonical copy of every published video lives on YouTube, so losing
# a cache entry only disables re-download of that render.
VIDEO_DIR = Path(__file__).resolve().parent.parent / "workspace" / "videos"
CACHE_MAX_FILES = int(CONFIG.get("video_cache_max_files", 10))

# One-shot temp files for Download's fetch-from-YouTube fallback. Kept
# OUTSIDE the cache dir so the file-count cap and eviction never see
# them; each entry is unlinked after its response is sent.
TMP_DIR = VIDEO_DIR.parent / "videos_tmp"

# Operator-exported browser cookies (Netscape format) authenticating
# yt-dlp against YouTube — needed because datacenter IPs hit the
# "Sign in to confirm you're not a bot" wall on anonymous fetches.
_YT_COOKIES_PATH = Path(__file__).resolve().parent.parent / "workspace" / "youtube_cookies.txt"


def _mp4_path(video_id: str) -> Path:
    return VIDEO_DIR / f"{video_id}.mp4"


# Marker recording that the cached mp4 and the YouTube footage match.
# Written after every successful YouTube upload of the cache file,
# removed whenever the cache file is replaced; its absence (with a
# cache file present) tells Save to re-upload the footage.
def _yt_marker_path(video_id: str) -> Path:
    return VIDEO_DIR / f"{video_id}.ytsync"


def _write_yt_marker(video_id: str) -> None:
    try:
        VIDEO_DIR.mkdir(parents=True, exist_ok=True)
        _yt_marker_path(video_id).touch()
    except OSError as err:
        log.warning("[videos] write ytsync marker %s failed: %s", video_id, err)


def _remove_yt_marker(video_id: str) -> None:
    try:
        _yt_marker_path(video_id).unlink(missing_ok=True)
    except OSError as err:
        log.warning("[videos] remove ytsync marker %s failed: %s", video_id, err)


def _youtube_description(video: Video, description: str) -> str:
    """The YouTube description carries a final Play! deep-link line: an
    anonymous viewer clicking it lands on our Play! page with this
    route loaded (frontend_base_url is the public site origin)."""
    text = description or ""
    base = CONFIG.get("frontend_base_url", "").rstrip("/")
    if video.route_id and base:
        line = f"Play! URL: {base}/play?r={video.route_id}"
        text = f"{text}\n\n{line}" if text.strip() else line
    return text


def _evict_overflow() -> None:
    """Keep at most CACHE_MAX_FILES mp4s in the cache: while over the
    cap, unlink the oldest entries (by modification time). Best-effort —
    an eviction hiccup must never fail the upload that triggered it."""
    try:
        files = [p for p in VIDEO_DIR.glob("*.mp4") if p.is_file()]
        overflow = len(files) - CACHE_MAX_FILES
        if overflow <= 0:
            return
        for p in sorted(files, key=lambda q: q.stat().st_mtime)[:overflow]:
            p.unlink(missing_ok=True)
            log.info("[videos] cache eviction: removed %s", p.name)
    except OSError as err:
        log.warning("[videos] cache eviction failed: %s", err)


async def _retire_video(session: AsyncSession, video: Video) -> None:
    """Delete one video everywhere: the YouTube post (best-effort — the
    site channel token may be missing/expired, and a stuck YouTube video
    must never block local deletion), the playback sources, the row and
    the persisted mp4. Caller commits."""
    yt_sources = (
        await session.execute(
            select(VideoSource).where(
                VideoSource.video_id == video.id,
                VideoSource.provider == "youtube",
            )
        )
    ).scalars().all()
    for src in yt_sources:
        yt_id = _youtube_id(src.url)
        if not yt_id:
            continue
        try:
            await asyncio.to_thread(youtube_upload.delete_video, yt_id)
        except Exception as err:
            log.warning("[videos] youtube delete %s failed: %s", yt_id, err)
    await session.execute(delete(VideoSource).where(VideoSource.video_id == video.id))
    await session.delete(video)
    try:
        _mp4_path(video.id).unlink(missing_ok=True)
    except OSError as err:
        log.warning("[videos] unlink mp4 %s failed: %s", video.id, err)
    _remove_yt_marker(video.id)


def _youtube_id(url: str) -> str | None:
    """Extract the YouTube video id from a watch / share URL, if any."""
    try:
        parsed = urlparse(url)
        if "youtu.be" in parsed.netloc:
            return parsed.path.lstrip("/").split("/")[0] or None
        ids = parse_qs(parsed.query).get("v", [])
        return ids[0] if ids else None
    except Exception:
        return None


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
        "updated_at": video.updated_at.isoformat(),
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
            await _retire_video(session, ov)
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


async def _sync_youtube(session: AsyncSession, video: Video) -> str:
    """Push the card's current state to its YouTube post (the Save
    button's third place): title and description always; the footage
    too when the cached mp4 is newer than the post — YouTube cannot
    replace a video's media, so a fresh copy is uploaded, the old post
    retired and the youtube source pointed at the new watch URL.

    Returns "ok", "skipped" (no youtube source), or the error code —
    the local row is already committed either way, so a sync failure
    only downgrades the response hint, never the save itself.
    """
    yt_src = (
        await session.execute(
            select(VideoSource)
            .where(
                VideoSource.video_id == video.id,
                VideoSource.provider == "youtube",
            )
            .order_by(VideoSource.position.asc())
        )
    ).scalars().first()
    yt_id = _youtube_id(yt_src.url) if yt_src else None
    title = video.title or "Drone route video"
    description = _youtube_description(video, video.description or "")
    mp4 = _mp4_path(video.id)
    try:
        if mp4.is_file() and not _yt_marker_path(video.id).is_file():
            with open(mp4, "rb") as fh:
                new_id, watch_url = await asyncio.to_thread(
                    youtube_upload.upload_mp4, fh, title, description
                )
            if yt_id:
                try:
                    await asyncio.to_thread(youtube_upload.delete_video, yt_id)
                except Exception as err:
                    log.warning(
                        "[videos] youtube delete %s failed: %s", yt_id, err
                    )
            if yt_src is not None:
                yt_src.url = watch_url
            else:
                yt_src = VideoSource(
                    video_id=video.id,
                    provider="youtube",
                    url=watch_url,
                    position=0,
                )
                session.add(yt_src)
                await session.flush()
            # The fresh footage post becomes the primary source; the
            # other providers keep their relative order behind it.
            others = (
                await session.execute(
                    select(VideoSource)
                    .where(
                        VideoSource.video_id == video.id,
                        VideoSource.id != yt_src.id,
                    )
                    .order_by(VideoSource.position.asc())
                )
            ).scalars().all()
            yt_src.position = 0
            for pos, s in enumerate(others, start=1):
                s.position = pos
            await session.commit()
            _write_yt_marker(video.id)
            log.info("[videos] re-uploaded footage of %s as %s", video.id, new_id)
            return "ok"
        if not yt_id:
            return "skipped"
        await asyncio.to_thread(
            youtube_upload.update_metadata, yt_id, title, description
        )
        return "ok"
    except youtube_upload.YouTubeUploadError as err:
        log.warning("[videos] youtube sync for %s failed: %s", video.id, err)
        return err.code
    except Exception as err:
        log.warning("[videos] youtube sync for %s failed: %s", video.id, err)
        return "youtube_sync_failed"


@router.put("/videos/{video_id}")
async def update_video(
    video_id: str,
    body: VideoUpdate,
    user: User = Depends(current_active_user),
    session: AsyncSession = Depends(get_async_session),
) -> dict:
    """Content -> Video Save button: one write lands in all three
    places — the owner's card, the Plaza feed (same table) and the
    YouTube post (title/description always, footage when it changed;
    see _sync_youtube). The response carries youtube_sync so the card
    can tell a full save from a local-only one."""
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
    yt_status = await _sync_youtube(session, video)
    payload = await _serialize(session, video, user.display_name)
    payload["youtube_sync"] = yt_status
    return payload


# youtube_upload error codes -> HTTP status (detail carries the code so
# the dialog can show the matching i18n message).
_YT_STATUS = {
    "youtube_not_configured": 503,
    "youtube_auth": 503,
    "youtube_quota": 429,
    "youtube_signup": 409,
}


@router.delete("/videos/{video_id}", status_code=204)
async def delete_video_entry(
    video_id: str,
    user: User = Depends(current_active_user),
    session: AsyncSession = Depends(get_async_session),
) -> None:
    """Content -> Video Delete button: retire the video card (owner's
    list and the public Plaza feed) plus its YouTube post and mp4."""
    stmt = select(Video).where(Video.id == video_id, Video.user_id == user.id)
    video = (await session.execute(stmt)).scalar_one_or_none()
    if video is None:
        raise HTTPException(status_code=404, detail="VIDEO_NOT_FOUND")
    await _retire_video(session, video)
    await session.commit()


def _fetch_from_youtube(yt_id: str, dest_stem: Path) -> Path:
    """Blocking yt-dlp fetch of a YouTube video's best single-file mp4
    rendition into dest_stem.<ext>; returns the written path. Runs in a
    worker thread (a fetch can take tens of seconds for large videos).

    YouTube answers anonymous requests from datacenter IPs with a bot
    wall ("Sign in to confirm you're not a bot"), so the operator
    exports browser cookies once (Netscape format) to
    server/workspace/youtube_cookies.txt; present, they authenticate
    every fetch.
    """
    import yt_dlp

    opts = {
        # One progressive mp4 stream: no ffmpeg merge step needed. The
        # footage is our own re-hosted render, so the platform's best
        # mp4 rendition is exactly what the Download button promises.
        "format": "b[ext=mp4]/best",
        "outtmpl": f"{dest_stem}.%(ext)s",
        "quiet": True,
        "no_warnings": True,
    }
    if _YT_COOKIES_PATH.is_file():
        opts["cookiefile"] = str(_YT_COOKIES_PATH)
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(
            f"https://www.youtube.com/watch?v={yt_id}", download=True
        )
    downs = (info or {}).get("requested_downloads") or []
    filepath = downs[0].get("filepath") if downs else None
    if not filepath:
        raise RuntimeError("yt-dlp produced no file")
    return Path(filepath)


@router.get("/videos/{video_id}/download")
async def download_video(
    video_id: str,
    user: User = Depends(current_active_user),
    session: AsyncSession = Depends(get_async_session),
) -> FileResponse:
    """Serve the mp4 of one of the caller's videos (the Content ->
    Video Download button). Serves the cached copy when present; when
    the cache no longer holds it, the footage is fetched back from
    YouTube (the canonical store) into a one-shot temp file. Either
    way the served file is CONSUMED: unlinked after the response is
    fully sent, so the server keeps no growing pile of downloads.
    404 when there is neither a cache file nor a YouTube source."""
    stmt = select(Video).where(Video.id == video_id, Video.user_id == user.id)
    video = (await session.execute(stmt)).scalar_one_or_none()
    if video is None:
        raise HTTPException(status_code=404, detail="VIDEO_NOT_FOUND")
    path = _mp4_path(video.id)
    if not path.is_file():
        yt_src = (
            await session.execute(
                select(VideoSource)
                .where(
                    VideoSource.video_id == video.id,
                    VideoSource.provider == "youtube",
                )
                .order_by(VideoSource.position.asc())
            )
        ).scalars().first()
        yt_id = _youtube_id(yt_src.url) if yt_src else None
        if not yt_id:
            raise HTTPException(status_code=404, detail="NO_MP4")
        try:
            TMP_DIR.mkdir(parents=True, exist_ok=True)
            stem = TMP_DIR / f"{video.id}-{uuid.uuid4().hex[:8]}"
            path = await asyncio.to_thread(_fetch_from_youtube, yt_id, stem)
        except Exception as err:
            log.warning(
                "[videos] youtube fetch for %s failed: %s", video.id, err
            )
            raise HTTPException(status_code=502, detail="YOUTUBE_FETCH_FAILED")
    safe = "".join(c for c in (video.title or "") if c not in '\\/:*?"<>|').strip()
    filename = f"{safe or video.id}.mp4"
    return FileResponse(
        path,
        media_type="video/mp4",
        filename=filename,
        # Runs AFTER the response is fully sent, so the streamed file is
        # never removed mid-transfer (POSIX keeps the open fd readable).
        background=BackgroundTask(path.unlink, missing_ok=True),
    )


@router.put("/videos/{video_id}/file")
async def replace_video_file(
    video_id: str,
    file: UploadFile = File(...),
    user: User = Depends(current_active_user),
    session: AsyncSession = Depends(get_async_session),
) -> dict:
    """Content -> Video "update the mp4 video file": replace the cached
    mp4 of one of the caller's videos with a fresh upload. The YouTube
    post and the playback sources stay untouched — this only swaps the
    file the Download button serves, then bumps updated_at."""
    stmt = select(Video).where(Video.id == video_id, Video.user_id == user.id)
    video = (await session.execute(stmt)).scalar_one_or_none()
    if video is None:
        raise HTTPException(status_code=404, detail="VIDEO_NOT_FOUND")
    ctype = file.content_type or ""
    if ctype not in ("", "video/mp4") and not (file.filename or "").endswith(".mp4"):
        raise HTTPException(status_code=415, detail="NOT_MP4")

    spool = SpooledTemporaryFile(max_size=64 * 1024 * 1024)
    size = 0
    while chunk := await file.read(1024 * 1024):
        size += len(chunk)
        if size > youtube_upload.MAX_SIZE:
            raise HTTPException(status_code=413, detail="FILE_TOO_LARGE")
        spool.write(chunk)
    if size == 0:
        raise HTTPException(status_code=400, detail="EMPTY_FILE")
    try:
        VIDEO_DIR.mkdir(parents=True, exist_ok=True)
        spool.seek(0)
        with open(_mp4_path(video.id), "wb") as fh:
            shutil.copyfileobj(spool, fh)
        _evict_overflow()
    except OSError as err:
        log.warning("[videos] replace mp4 %s failed: %s", video.id, err)
        raise HTTPException(status_code=500, detail="FILE_STORE_FAILED")
    # The cache now differs from the YouTube footage: Save's next sync
    # must re-upload it.
    _remove_yt_marker(video.id)
    video.updated_at = datetime.now(timezone.utc)
    await session.commit()
    await session.refresh(video)
    return await _serialize(session, video, user.display_name)


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
        # Keep a persistent copy for the Download button BEFORE the
        # YouTube upload: a YouTube failure must not lose the mp4.
        # Overflowing the file-count cap evicts the oldest entries.
        try:
            VIDEO_DIR.mkdir(parents=True, exist_ok=True)
            spool.seek(0)
            with open(_mp4_path(video.id), "wb") as fh:
                shutil.copyfileobj(spool, fh)
            _evict_overflow()
        except OSError as err:
            log.warning("[videos] persist mp4 %s failed: %s", video.id, err)
        spool.seek(0)
        # The YouTube description carries a final Play! deep-link line
        # (see _youtube_description).
        description = _youtube_description(video, video.description or "")
        try:
            _, watch_url = await asyncio.to_thread(
                youtube_upload.upload_mp4,
                spool,
                video.title or "Drone route video",
                description,
            )
        except youtube_upload.YouTubeUploadError as err:
            raise HTTPException(
                status_code=_YT_STATUS.get(err.code, 502), detail=err.code
            )
        # Cache file and YouTube footage now match.
        _write_yt_marker(video.id)

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
