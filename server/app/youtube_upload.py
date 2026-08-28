"""Server-side YouTube upload for generated route videos.

The Route Planning -> Video dialog posts the finished mp4 to
POST /api/videos/{id}/upload-youtube; this module uploads it to the SITE's
YouTube channel (one operator refresh token, minted once by
server/scripts/youtube_authorize.py), adds it to the `drone-navigation`
playlist and returns the watch URL, which the API layer stores as the
video's primary playback source (provider "youtube", position 0).

Videos are uploaded with `youtube.privacy_status` from config.json
(default "unlisted"); the public playlist is what makes the channel
browsable. Bilibili has no public upload API and stays manual for now.
"""

import json
import logging
import threading

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError
from googleapiclient.http import MediaIoBaseUpload

from .config import CONFIG

log = logging.getLogger(__name__)

# Full youtube scope: upload AND playlist management (same scope the
# authorize script requested; a narrower token would be rejected).
YOUTUBE_SCOPE = "https://www.googleapis.com/auth/youtube"
PLAYLIST_TITLE = "drone-navigation"
_CHUNK = 8 * 1024 * 1024  # resumable-upload chunk size (multiple of 256 KiB)
MAX_SIZE = 500 * 1024 * 1024  # hard cap on the mp4 we accept from the dialog

_lock = threading.Lock()
_service = None
_playlist_id = None


class YouTubeUploadError(Exception):
    """Typed failure so the API layer maps it to an HTTP status/i18n code."""

    def __init__(self, code: str, detail: str = ""):
        super().__init__(detail or code)
        self.code = code
        self.detail = detail


def _cfg() -> dict:
    return CONFIG.get("youtube", {})


def get_youtube_service():
    """Cached YouTube v3 service backed by the operator refresh token."""
    global _service
    with _lock:
        if _service is not None:
            return _service
        refresh_token = _cfg().get("refresh_token", "")
        if not refresh_token:
            raise YouTubeUploadError(
                "youtube_not_configured",
                "server config.json has no youtube.refresh_token "
                "(run server/scripts/youtube_authorize.py)",
            )
        oauth = CONFIG.get("oauth", {}).get("google", {})
        creds = Credentials(
            token=None,
            refresh_token=refresh_token,
            token_uri="https://oauth2.googleapis.com/token",
            client_id=oauth.get("client_id", ""),
            client_secret=oauth.get("client_secret", ""),
            scopes=[YOUTUBE_SCOPE],
        )
        try:
            creds.refresh(Request())
        except Exception as err:  # google.auth.exceptions.RefreshError incl. invalid_grant
            raise YouTubeUploadError(
                "youtube_auth",
                f"refresh token rejected by Google: {err}; "
                "re-run server/scripts/youtube_authorize.py",
            ) from err
        _service = build("youtube", "v3", credentials=creds, cache_discovery=False)
        return _service


def _get_playlist_id(youtube) -> str:
    """Find (or create) the channel playlist titled PLAYLIST_TITLE."""
    global _playlist_id
    if _playlist_id:
        return _playlist_id
    page_token = ""
    while True:
        page = youtube.playlists().list(
            part="snippet", mine=True, maxResults=50, pageToken=page_token
        ).execute()
        for item in page.get("items", []):
            if item["snippet"]["title"] == PLAYLIST_TITLE:
                _playlist_id = item["id"]
                return _playlist_id
        page_token = page.get("nextPageToken") or ""
        if not page_token:
            break
    created = (
        youtube.playlists()
        .insert(
            part="snippet,status",
            body={
                "snippet": {
                    "title": PLAYLIST_TITLE,
                    "description": "Virtual drone flights rendered in Google Earth 3D.",
                },
                "status": {"privacyStatus": "public"},
            },
        )
        .execute()
    )
    _playlist_id = created["id"]
    log.info("[youtube] created playlist %s (%s)", PLAYLIST_TITLE, _playlist_id)
    return _playlist_id


def upload_mp4(fileobj, title: str, description: str) -> tuple[str, str]:
    """Chunked resumable upload; returns (video_id, watch_url)."""
    try:
        youtube = get_youtube_service()
        media = MediaIoBaseUpload(
            fileobj, mimetype="video/mp4", chunksize=_CHUNK, resumable=True
        )
        request = youtube.videos().insert(
            part="snippet,status",
            body={
                "snippet": {
                    "title": title,
                    "description": description,
                    "tags": ["drone", "3d tiles", "google earth", "navigation"],
                    "categoryId": "28",  # Science & Technology
                },
                "status": {
                    "privacyStatus": _cfg().get("privacy_status", "unlisted"),
                    "madeForKids": False,
                },
            },
            media_body=media,
        )
        response = None
        while response is None:
            status, response = request.next_chunk()
            if status:
                log.info(
                    "[youtube] uploaded %s / %s bytes",
                    status.resumable_progress,
                    status.total_size,
                )
        video_id = response["id"]
    except Exception as err:  # HttpError (quota/auth) + network failures
        raise translate_error(err) from err

    # Every upload lands in the channel playlist (best-effort: the video
    # itself already exists if this part fails). Kept outside the translate
    # wrapper so a failed insert never masks a successful upload.
    try:
        youtube.playlistItems().insert(
            part="snippet",
            body={
                "snippet": {
                    "playlistId": _get_playlist_id(youtube),
                    "resourceId": {"kind": "youtube#video", "videoId": video_id},
                },
            },
        ).execute()
    except HttpError as err:
        log.warning("[youtube] playlist insert failed: %s", err)
    return video_id, f"https://www.youtube.com/watch?v={video_id}"


def update_metadata(video_id: str, title: str, description: str) -> None:
    """Update the title and description of a video on the site channel.

    videos.update rewrites the whole snippet, so the current snippet
    (categoryId is required, tags/languages carried over) is fetched
    first and only title/description are replaced. An empty items list
    means the video is gone from the channel — reported as a typed
    error, not silently swallowed.
    """
    youtube = get_youtube_service()
    try:
        page = youtube.videos().list(part="snippet", id=video_id).execute()
        items = page.get("items", [])
        if not items:
            raise YouTubeUploadError(
                "youtube_video_missing",
                f"video {video_id} not found on the channel",
            )
        snippet = dict(items[0].get("snippet", {}))
        snippet["title"] = title
        snippet["description"] = description
        snippet.setdefault("categoryId", "28")  # Science & Technology
        youtube.videos().update(
            part="snippet", body={"id": video_id, "snippet": snippet}
        ).execute()
        log.info("[youtube] updated metadata of %s", video_id)
    except YouTubeUploadError:
        raise
    except Exception as err:  # HttpError (quota/auth) + network failures
        raise translate_error(err) from err


def delete_video(video_id: str) -> None:
    """Delete a video from the site channel (previous post of a route).

    Deleting the video also drops the playlist items referencing it, so
    the drone-navigation playlist entry disappears automatically. A 404
    means the video is already gone and counts as success.
    """
    youtube = get_youtube_service()
    try:
        youtube.videos().delete(id=video_id).execute()
        log.info("[youtube] deleted video %s", video_id)
    except HttpError as err:
        if err.resp.status != 404:
            raise


def translate_error(err: Exception) -> YouTubeUploadError:
    """Map Google/client failures to the typed error the API layer raises."""
    if isinstance(err, YouTubeUploadError):
        return err
    if isinstance(err, HttpError):
        reason = ""
        try:
            payload = json.loads(err.content.decode("utf-8", "replace"))
            reason = payload["error"]["errors"][0].get("reason", "")
        except Exception:
            pass
        if reason == "quotaExceeded" or reason == "dailyLimitExceeded":
            return YouTubeUploadError("youtube_quota", str(err))
        if reason == "youtubeSignupRequired":
            return YouTubeUploadError("youtube_signup", str(err))
        return YouTubeUploadError("youtube_upload_failed", f"{reason or err.resp.status}: {err}")
    return YouTubeUploadError("youtube_upload_failed", str(err))
