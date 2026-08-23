/**
 * API client for the per-user published flight videos (Content -> Video).
 * Each video carries a title (copied from its source route at creation,
 * then independently editable), a frozen waypoint snapshot, and an ordered
 * list of playback sources (YouTube primary, Bilibili second, extensible).
 */

import { useAuth } from './useAuth.js';

const API_BASE = import.meta.env.DEV ? 'http://localhost:8000' : '';

// Module-level caches of the last successful list responses. The lists
// unmount/remount on every tab switch and page change; with the caches
// they paint instantly from memory while a background GET silently
// revalidates (the spinner only shows while no cached copy exists yet).
let videosCache = null;        // GET /api/videos (owner list)
let publicVideosCache = null;  // GET /api/videos/public (Gallery feed)

export function cachedVideos() {
  return videosCache;
}

export function cachedPublicVideos() {
  return publicVideosCache;
}

export function useVideos() {
  const { token } = useAuth();

  function authHeaders(json = false) {
    const h = { Authorization: `Bearer ${token.value}` };
    if (json) h['Content-Type'] = 'application/json';
    return h;
  }

  /** GET /api/videos — most recent first (server seeds demo videos). */
  async function listVideos() {
    const res = await fetch(`${API_BASE}/api/videos`, {
      headers: authHeaders(),
    });
    if (!res.ok) throw new Error('videos_unavailable');
    videosCache = await res.json();
    return videosCache;
  }

  /** GET /api/videos/public — the Gallery feed: every user's published
   *  videos, most recent first. Anonymous callers allowed. */
  async function listPublicVideos() {
    const res = await fetch(`${API_BASE}/api/videos/public`);
    if (!res.ok) throw new Error('videos_unavailable');
    publicVideosCache = await res.json();
    return publicVideosCache;
  }

  /** PUT /api/videos/{id} — replace title + waypoint snapshot + sources. */
  async function saveVideo(id, payload) {
    const res = await fetch(`${API_BASE}/api/videos/${id}`, {
      method: 'PUT',
      headers: authHeaders(true),
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error('video_save_failed');
    return res.json();
  }

  /** POST /api/videos — mint a video entry from one of the caller's
   *  routes (waypoint snapshot copied server-side; title/description as
   *  edited in the generation dialog). */
  async function publishVideo(payload) {
    const res = await fetch(`${API_BASE}/api/videos`, {
      method: 'POST',
      headers: authHeaders(true),
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error('video_publish_failed');
    return res.json();
  }

  return { listVideos, listPublicVideos, saveVideo, publishVideo };
}
