"""One-off maintenance: purge "unavailable video" placeholders from the
drone-navigation playlist.

Deleting a YouTube video leaves its playlist items behind, so the playlist
shows "1 unavailable video that is hidden" for every video we ever retired
(the old delete_video only called videos.delete). This script lists the
channel playlist, checks every referenced video id against videos.list,
and deletes the items whose video no longer exists. New uploads are safe:
delete_video now removes the playlist items itself.

Run (from anywhere; uses server/config.json -> youtube.refresh_token):

    /home/robot/miniconda3/envs/drone-navigation/bin/python \
        server/scripts/youtube_cleanup_playlist.py
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.youtube_upload import (  # noqa: E402
    _get_playlist_id,
    get_youtube_service,
)


def main() -> int:
    youtube = get_youtube_service()
    playlist_id = _get_playlist_id(youtube)
    print(f"playlist: {playlist_id}")

    # 1) Collect every playlist item (id -> referenced videoId).
    items = []  # (playlist_item_id, video_id)
    page_token = ""
    while True:
        page = youtube.playlistItems().list(
            part="id,snippet",
            playlistId=playlist_id,
            maxResults=50,
            pageToken=page_token,
        ).execute()
        for item in page.get("items", []):
            vid = (item.get("snippet", {}).get("resourceId") or {}).get("videoId")
            items.append((item["id"], vid or ""))
        page_token = page.get("nextPageToken") or ""
        if not page_token:
            break
    print(f"playlist items: {len(items)}")

    # 2) Which referenced videos still exist? (batched, owner sees unlisted)
    alive = set()
    ids = [vid for _, vid in items if vid]
    for i in range(0, len(ids), 50):
        page = youtube.videos().list(part="id", id=",".join(ids[i : i + 50])).execute()
        alive.update(v["id"] for v in page.get("items", []))

    # 3) Delete the items whose video is gone.
    stale = [(pid, vid) for pid, vid in items if vid and vid not in alive]
    if not stale:
        print("no unavailable videos — playlist is clean.")
        return 0
    for pid, vid in stale:
        youtube.playlistItems().delete(id=pid).execute()
        print(f"removed placeholder item {pid} (video {vid} no longer exists)")
    print(f"done: removed {len(stale)} unavailable-video placeholder(s).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
