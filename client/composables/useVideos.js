/**
 * API client for the per-user published flight videos (Content -> Video).
 * Each video carries a title (copied from its source route at creation,
 * then independently editable), a frozen waypoint snapshot, and an ordered
 * list of playback sources (YouTube primary, Bilibili second, extensible).
 */

import { useAuth } from './useAuth.js';

const API_BASE = import.meta.env.DEV ? 'http://localhost:8000' : '';

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
    return res.json();
  }

  /** GET /api/videos/public — the Gallery feed: every user's published
   *  videos, most recent first. Anonymous callers allowed. */
  async function listPublicVideos() {
    const res = await fetch(`${API_BASE}/api/videos/public`);
    if (!res.ok) throw new Error('videos_unavailable');
    return res.json();
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
