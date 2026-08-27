/**
 * Background video-generation job (Produce -> Video -> Generate).
 *
 * The renderer in useRouteScene3D is a single async frame-by-frame loop
 * (WebCodecs encode runs off the UI path), so the job survives the dialog
 * being closed: all state lives here at module scope, not in the dialog
 * component. The dialog is only a viewer of `job`; closing it never
 * aborts anything. One job at a time (single renderer).
 *
 * Pipeline (every input snapshotted at Generate-click time):
 *   1. render  — scene.saveClip(waypoints) -> clip kept as an in-memory
 *                Blob (the browser's client-side temp store)
 *   2. publish — persist the route (ensureRoute), mint the video card on
 *                the Plaza (POST /api/videos, optionally deleting the
 *                previous video of the route + its YouTube post), then
 *                upload the mp4 to the site YouTube channel
 * Terminal states set `job.notice`; AppShell shows it in the top bar so
 * the user sees completion even after closing the dialog.
 */

import { reactive, ref } from 'vue';
import { useRouteScene3D } from './useRouteScene3D.js';
import { useVideos, invalidateVideoCaches } from './useVideos.js';

const NOTICE_MS = 10000; // top-bar completion/failure notice lifetime

export const job = reactive({
  phase: 'idle', // 'idle' | 'rendering' | 'publishing' | 'uploading' | 'done' | 'failed'
  error: '', // failed step: 'render' | 'publish' | 'youtube'
  uploadPct: 0,
  clipBlob: null, // finished mp4 (client-side temp store until replaced)
  videoUrl: '', // object URL for the preview <video>
  publishedId: null, // video record id once published to the Plaza
  uploadedUrl: '', // YouTube watch URL once uploaded
  notice: null, // { text: i18n suffix, kind: 'info' | 'warning' }
});

export const isActive = ref(false);

let noticeTimer = null;

function setNotice(text, kind) {
  job.notice = { text, kind };
  if (noticeTimer) clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    job.notice = null;
    noticeTimer = null;
  }, NOTICE_MS);
}

function resetClip() {
  if (job.videoUrl) URL.revokeObjectURL(job.videoUrl);
  job.clipBlob = null;
  job.videoUrl = '';
  job.publishedId = null;
  job.uploadedUrl = '';
}

/** True while a job is rendering / publishing / uploading. */
export function jobRunning() {
  return job.phase === 'rendering' || job.phase === 'publishing' || job.phase === 'uploading';
}

/**
 * Start the background job. Inputs are the Generate-click snapshot; later
 * dialog edits do not affect the running job. Refuses while another job
 * is running. `ensureRoute` persists the route and returns it (its id
 * anchors the video record); `fallbackRouteId` covers already-saved
 * routes when ensureRoute is absent or fails.
 */
export function startVideoJob({
  waypoints,
  title,
  description,
  publish,
  deletePrevious,
  ensureRoute,
  fallbackRouteId,
}) {
  if (jobRunning()) return false;

  const scene = useRouteScene3D();
  const { publishVideo, uploadToYouTube } = useVideos();

  resetClip();
  job.error = '';
  job.uploadPct = 0;
  job.notice = null;
  job.phase = 'rendering';
  isActive.value = true;

  (async () => {
    try {
      // 1) Generate the mp4 into the client-side temp store (in-memory).
      const ok = await scene.saveClip(waypoints);
      const clip = ok ? scene.takeLastClip() : null;
      if (!ok || !clip) {
        job.phase = 'failed';
        job.error = 'render';
        setNotice('failed_render', 'warning');
        return;
      }
      job.clipBlob = clip.blob;
      job.videoUrl = URL.createObjectURL(clip.blob);

      if (publish) {
        // 2) Publish to the Plaza (and the previous video of this route
        //    + its YouTube post when the checkbox is on).
        job.phase = 'publishing';
        let rid = null;
        if (typeof ensureRoute === 'function') {
          try {
            const saved = await ensureRoute();
            rid = saved && saved.id != null ? saved.id : null;
          } catch {
            /* fall back to the id the route object carries */
          }
        }
        if (rid == null) rid = fallbackRouteId ?? null;
        if (rid == null) throw { step: 'publish' };

        const created = await publishVideo({
          route_id: rid,
          title,
          description,
          delete_previous: deletePrevious,
        });
        job.publishedId = created.id;
        invalidateVideoCaches(); // Content -> Video / Plaza refetch fresh lists

        // 3) Upload the mp4 to the site YouTube channel; the server appends
        //    the Play! deep link of this route to the description.
        job.phase = 'uploading';
        const updated = await uploadToYouTube(created.id, clip.blob, (p) => {
          job.uploadPct = p;
        });
        const yt = (updated.sources || []).find((s) => s.provider === 'youtube');
        job.uploadedUrl = yt ? yt.url : '';
        invalidateVideoCaches();
        setNotice('done_published', 'info');
      } else {
        setNotice('done', 'info');
      }
      job.phase = 'done';
    } catch (err) {
      const step = err && err.step === 'publish' ? 'publish' : 'youtube';
      job.phase = 'failed';
      job.error = step;
      setNotice(step === 'publish' ? 'failed_publish' : 'failed_youtube', 'warning');
    } finally {
      isActive.value = false;
    }
  })();

  return true;
}

export function useVideoJob() {
  return { job, isActive, startVideoJob, jobRunning };
}
