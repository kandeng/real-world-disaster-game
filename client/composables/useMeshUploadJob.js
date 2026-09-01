/**
 * Background mesh-upload jobs (Component -> 3D Asset).
 *
 * The queue lives at module scope, so it survives component
 * mounts/unmounts and SPA navigation: start an upload in the 3D Asset
 * list, wander to any other page, and the transfer keeps running. Terminal
 * states surface as a top-bar notice (rendered by AppShell, mirroring the
 * video job). The transfer itself is chunked + resumable server-side, and a
 * beforeunload guard warns while any job is still transferring — killing
 * the browser outright is the one case where the next visit resumes from
 * the server's last offset instead of restarting (session lifetime
 * permitting).
 */

import { reactive, computed } from 'vue';
import {
  useMeshes,
  invalidateMeshCaches,
  sha256OfFile,
} from './useMeshes.js';

// Chunk size for the resumable transfer (2 MiB keeps retries cheap).
const CHUNK = 2 * 1024 * 1024;
// How long to poll the server's background commit before giving up.
const POLL_MAX_TRIES = 150; // ~2.5 min at 1 s
const POLL_MS = 1000;
const NOTICE_MS = 10000;

// Module-scoped queue: one entry per in-flight (or finished) transfer.
export const jobs = reactive([]);
// Last terminal notice for the AppShell top bar.
export const notice = reactive({ text: '', kind: 'info' });
let noticeTimer = null;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function setNotice(text, kind = 'info') {
  clearTimeout(noticeTimer);
  notice.text = text;
  notice.kind = kind;
  noticeTimer = setTimeout(() => {
    notice.text = '';
  }, NOTICE_MS);
}

/** True while any job is hashing/transferring/committing — drives the
 *  beforeunload guard registered below at module scope. */
export function anyJobRunning() {
  return jobs.some((j) => ['pending', 'hashing', 'transfer', 'commit'].includes(j.status));
}

/** 0..1 across every transfer-phase job (1 when none are running). */
export const overallProgress = computed(() => {
  const act = jobs.filter((j) => j.status === 'transfer');
  if (!act.length) return 1;
  return act.reduce((s, j) => s + (j.progress || 0), 0) / act.length;
});

/** True while this mesh's GLB is being replaced by a background job. */
export function jobRunningFor(meshId) {
  return jobs.some((j) => j.meshId === meshId && anyStatusActive(j.status));
}

function anyStatusActive(status) {
  return ['pending', 'hashing', 'transfer', 'commit'].includes(status);
}

// Warn before closing/reloading the tab while a transfer is in flight.
window.addEventListener('beforeunload', (e) => {
  if (!anyJobRunning()) return;
  e.preventDefault();
  e.returnValue = ''; // Chrome requires a non-empty returnValue
});

function failJob(job, errorKey = 'job_failed') {
  job.status = 'failed';
  job.error = errorKey;
  job._done = true;
  job._doneAt = Date.now();
  invalidateMeshCaches();
  setNotice('job_failed', 'warning');
}

function finishJob(job, mesh, noticeKey) {
  job.mesh = mesh;
  job.progress = 1;
  job.status = 'done';
  job._done = true;
  job._doneAt = Date.now();
  invalidateMeshCaches();
  setNotice(noticeKey, 'info');
}

/** Enqueue the creation of a brand-new mesh asset from a local GLB. The
 *  job runs fully in the background; ContentMeshList watches `jobs` and
 *  applies the finished mesh to its list. Returns the job entry. */
export function startNewMeshJob(file, meta) {
  const { checkMesh, startMeshUpload, meshUploadStatus, putMeshChunk, commitMeshUpload, meshJobStatus } = useMeshes();
  const job = reactive({
    id: `new-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'create',
    meshId: null,
    filename: file.name,
    size: file.size,
    status: 'hashing', // hashing | transfer | commit | done | failed
    progress: 0,
    mesh: null,
    error: null,
    _done: false,
  });
  jobs.push(job);

  (async () => {
    let sha = '';
    try {
      sha = await sha256OfFile(file);
    } catch {
      failJob(job);
      return;
    }
    try {
      // Dedup probe: already-own bytes finish instantly, nothing moves.
      try {
        const chk = await checkMesh(sha, file.size);
        if (chk.status === 'mine' && chk.mesh) {
          finishJob(job, chk.mesh, 'job_created');
          return;
        }
      } catch {
        /* probe failed — the commit still dedups server-side */
      }

      const { upload_id: uploadId } = await startMeshUpload({
        filename: file.name,
        size: file.size,
        sha256: sha,
        name: meta.name,
        description: meta.description,
        animation_script: meta.animation_script,
        visibility: meta.visibility,
      });
      job.uploadId = uploadId;
      job.status = 'transfer';

      // Resume-aware loop: start from whatever the server already has, then
      // push contiguous chunks; on a 409 re-sync from the server's count.
      let offset = 0;
      try {
        const st = await meshUploadStatus(uploadId);
        if (st) offset = st.received || 0;
      } catch {
        offset = 0;
      }
      while (offset < file.size) {
        const end = Math.min(offset + CHUNK, file.size);
        try {
          const res = await putMeshChunk(uploadId, offset, file.slice(offset, end));
          offset = res.received;
        } catch (err) {
          if (err && err.status === 409) {
            const st = await meshUploadStatus(uploadId);
            if (st) {
              offset = st.received || 0;
              continue;
            }
          }
          throw err;
        }
        job.progress = file.size ? offset / file.size : 1;
      }

      job.status = 'commit';
      const { job_id: serverJobId } = await commitMeshUpload(uploadId);
      let result = null;
      let lost = 0;
      for (let i = 0; i < POLL_MAX_TRIES; i++) {
        await sleep(POLL_MS);
        let st = null;
        try {
          st = await meshJobStatus(serverJobId);
        } catch {
          st = null;
        }
        if (!st) {
          // Server forgot the job (restart) — the row may still have been
          // committed before the restart, so revalidate via the list.
          if (++lost > 3) {
            const list = await useMeshesSafeList();
            const found = list.find((x) => x.sha256 === sha);
            if (found) {
              finishJob(job, found, 'job_created');
              return;
            }
            job.status = 'failed';
            job.error = 'job_interrupted';
            job._done = true;
            job._doneAt = Date.now();
            setNotice('job_interrupted', 'warning');
            return;
          }
          continue;
        }
        lost = 0;
        if (st.status === 'done') {
          result = st.mesh;
          break;
        }
        if (st.status === 'failed') throw new Error(st.error || 'COMMIT_FAILED');
      }
      if (!result) throw new Error('COMMIT_TIMEOUT');

      finishJob(job, result, 'job_created');
    } catch (err) {
      // Suppress AbortError from a tab that is closing anyway.
      if (err && err.name === 'AbortError') return;
      failJob(job);
    }
  })();

  return job;
}

// Revalidate helper that tolerates a signed-out moment during polling.
async function useMeshesSafeList() {
  try {
    return await useMeshes().listMeshes();
  } catch {
    return [];
  }
}

/** Enqueue the GLB replacement of an existing mesh card. */
export function startReplaceMeshJob(meshId, file) {
  const { replaceMeshFile } = useMeshes();
  const job = reactive({
    id: `rep-${meshId}-${Date.now()}`,
    kind: 'replace',
    meshId,
    filename: file.name,
    size: file.size,
    status: 'transfer',
    progress: 0,
    mesh: null,
    error: null,
    _done: false,
  });
  jobs.push(job);

  (async () => {
    try {
      const updated = await replaceMeshFile(meshId, file, (p) => {
        job.progress = p;
      });
      finishJob(job, updated, 'job_replaced');
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      failJob(job);
    }
  })();

  return job;
}

/** Drop finished entries the UI has already consumed (keeps the queue
 *  from growing unbounded across a long session). */
export function pruneFinishedJobs(olderThanMs = 60_000) {
  const now = Date.now();
  for (let i = jobs.length - 1; i >= 0; i--) {
    const j = jobs[i];
    if ((j.status === 'done' || j.status === 'failed') && j._doneAt && now - j._doneAt > olderThanMs) {
      jobs.splice(i, 1);
    }
  }
}

export function useMeshUploadJob() {
  return { jobs, notice, anyJobRunning, overallProgress, jobRunningFor, startNewMeshJob, startReplaceMeshJob, pruneFinishedJobs };
}
