/**
 * API client for the per-user 3D mesh assets (Content -> 3D Asset).
 *
 * Storage is content-addressed on the server: the GLB bytes live once per
 * unique SHA-256, and each user owns a catalog row referencing that hash.
 * To avoid re-uploading known bytes, the client hashes the picked file and
 * calls /check first; only a genuinely new hash transfers the file.
 */

import { useAuth } from './useAuth.js';
import { apiBaseUrl } from './wsUrl.js';

// Prod calls are pinned to the apex origin (see wsUrl.js): the CDN edge
// never caches /api/*, so going through it would add a wasted hop.
const API_BASE = apiBaseUrl();

// Module-level cache of the last successful list response. The list
// unmounts/remounts on every tab switch and page change; with the cache it
// paints instantly from memory while a background GET silently revalidates.
let meshesCache = null; // GET /api/meshes (owner list)

export function cachedMeshes() {
  return meshesCache;
}

// Called after a create/delete so a remount refetches instead of painting a
// stale cached list.
export function invalidateMeshCaches() {
  meshesCache = null;
}

/** SHA-256 of a File's bytes as lowercase hex (Web Crypto). Used for the
 *  content-addressed dedup check before any upload. */
export async function sha256OfFile(file) {
  const buf = await file.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function useMeshes() {
  const { token } = useAuth();

  function authHeaders(json = false) {
    const h = { Authorization: `Bearer ${token.value}` };
    if (json) h['Content-Type'] = 'application/json';
    return h;
  }

  /** GET /api/meshes — the caller's meshes, most recent first. */
  async function listMeshes() {
    const res = await fetch(`${API_BASE}/api/meshes`, {
      headers: authHeaders(),
    });
    if (!res.ok) throw new Error('meshes_unavailable');
    // Defensive newest-first (the backend orders by created_at desc too):
    // the list shows the more recent uploads above the older ones.
    meshesCache = (await res.json()).slice().sort((a, b) => {
      const ta = Date.parse(a.created_at) || 0;
      const tb = Date.parse(b.created_at) || 0;
      return tb - ta;
    });
    return meshesCache;
  }

  /** POST /api/meshes/check — dedup probe: {status:'mine'|'new', mesh?}. */
  async function checkMesh(sha256, size) {
    const res = await fetch(`${API_BASE}/api/meshes/check`, {
      method: 'POST',
      headers: authHeaders(true),
      body: JSON.stringify({ sha256, size }),
    });
    if (!res.ok) throw new Error('mesh_check_failed');
    return res.json();
  }

  /** POST /api/meshes — multipart upload of the GLB + metadata. XHR instead
   *  of fetch for upload progress events; onProgress receives 0..1. Resolves
   *  with the serialized mesh (a pre-existing one when the hash deduped). */
  function uploadMesh(file, meta, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${API_BASE}/api/meshes`);
      xhr.setRequestHeader('Authorization', `Bearer ${token.value}`);
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            resolve(JSON.parse(xhr.responseText));
          } catch {
            reject(new Error('mesh_upload_failed'));
          }
          return;
        }
        let code = 'mesh_upload_failed';
        try {
          code = JSON.parse(xhr.responseText).detail || code;
        } catch {
          /* non-JSON body: keep the generic code */
        }
        reject(new Error(code));
      };
      xhr.onerror = () => reject(new Error('mesh_upload_failed'));
      const form = new FormData();
      form.append('file', file, file.name || 'mesh.glb');
      form.append('name', meta.name || '');
      form.append('description', meta.description || '');
      form.append('animation_script', meta.animation_script || '');
      form.append('sha256', meta.sha256 || '');
      form.append('visibility', meta.visibility === 'public' ? 'public' : 'private');
      xhr.send(form);
    });
  }

  /** PUT /api/meshes/{id}/file — replace the GLB of one of the caller's
   *  meshes (Content -> 3D Asset "Upload the GLB file" row). XHR for upload
   *  progress events; onProgress receives 0..1. The server no-ops when the
   *  bytes are identical. Resolves with the serialized mesh. */
  function updateMeshFile(id, file, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', `${API_BASE}/api/meshes/${id}/file`);
      xhr.setRequestHeader('Authorization', `Bearer ${token.value}`);
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            resolve(JSON.parse(xhr.responseText));
          } catch {
            reject(new Error('mesh_upload_failed'));
          }
          return;
        }
        reject(new Error('mesh_upload_failed'));
      };
      xhr.onerror = () => reject(new Error('mesh_upload_failed'));
      const form = new FormData();
      form.append('file', file, file.name || 'mesh.glb');
      xhr.send(form);
    });
  }

  /** PUT /api/meshes/{id} — update name / description / animation_script /
   *  visibility / category. */
  async function saveMesh(id, payload) {
    const res = await fetch(`${API_BASE}/api/meshes/${id}`, {
      method: 'PUT',
      headers: authHeaders(true),
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error('mesh_save_failed');
    return res.json();
  }

  /** POST /api/meshes/{id}/classify — ask the server-side LLM to classify
   *  the asset into one of the twelve Public Component categories. The
   *  suggestion is persisted server-side; resolves with the serialized mesh
   *  (category stays null when the model could not decide). */
  async function classifyMesh(id) {
    const res = await fetch(`${API_BASE}/api/meshes/${id}/classify`, {
      method: 'POST',
      headers: authHeaders(),
    });
    if (!res.ok) throw new Error('mesh_classify_failed');
    return res.json();
  }

  /** GET /api/meshes/{id}/file — the GLB bytes of one of the caller's
   *  meshes, as a Blob. Feeds both the in-card 3D viewer (via an object URL)
   *  and the Download button. Returns null when the server has no GLB. */
  async function fetchMeshFile(id) {
    const res = await fetch(`${API_BASE}/api/meshes/${id}/file`, {
      headers: authHeaders(),
    });
    if (!res.ok) return null;
    return res.blob();
  }

  /** DELETE /api/meshes/{id} — retire the caller's catalog row (the shared
   *  blob is garbage-collected server-side once nothing references it). */
  async function deleteMesh(id) {
    const res = await fetch(`${API_BASE}/api/meshes/${id}`, {
      method: 'DELETE',
      headers: authHeaders(),
    });
    if (!res.ok) throw new Error('mesh_delete_failed');
  }

  /* ── Chunked resumable upload (background commit on the server) ── */

  /** POST /api/meshes/uploads — open a resumable upload session. */
  async function startMeshUpload(meta) {
    const form = new FormData();
    form.append('filename', meta.filename || '');
    form.append('size', String(meta.size || 0));
    form.append('sha256', meta.sha256 || '');
    form.append('name', meta.name || '');
    form.append('description', meta.description || '');
    form.append('animation_script', meta.animation_script || '');
    form.append('visibility', meta.visibility === 'public' ? 'public' : 'private');
    const res = await fetch(`${API_BASE}/api/meshes/uploads`, {
      method: 'POST',
      headers: authHeaders(),
      body: form,
    });
    if (res.status === 413) throw new Error('FILE_TOO_LARGE');
    if (!res.ok) throw new Error('mesh_upload_failed');
    return res.json(); // { upload_id }
  }

  /** GET /api/meshes/uploads/{id} — server-side received count (resume). */
  async function meshUploadStatus(uploadId) {
    const res = await fetch(`${API_BASE}/api/meshes/uploads/${uploadId}`, {
      headers: authHeaders(),
    });
    if (res.status === 404) return null; // session expired / server restart
    if (!res.ok) throw new Error('mesh_upload_failed');
    return res.json(); // { upload_id, received }
  }

  /** PUT /api/meshes/uploads/{id}/chunk?offset= — send one raw-body chunk. */
  async function putMeshChunk(uploadId, offset, blob) {
    const res = await fetch(
      `${API_BASE}/api/meshes/uploads/${uploadId}/chunk?offset=${offset}`,
      {
        method: 'PUT',
        headers: { ...authHeaders(), 'Content-Type': 'application/octet-stream' },
        body: blob,
      }
    );
    if (!res.ok) {
      const err = new Error(res.status === 409 ? 'OFFSET_MISMATCH' : 'mesh_upload_failed');
      err.status = res.status;
      throw err;
    }
    return res.json(); // { received }
  }

  /** POST /api/meshes/uploads/{id}/commit — 202 {job_id}; the server
   *  hashes/verifies/stores/row-mints in a background task. */
  async function commitMeshUpload(uploadId) {
    const res = await fetch(`${API_BASE}/api/meshes/uploads/${uploadId}/commit`, {
      method: 'POST',
      headers: authHeaders(),
    });
    if (!res.ok) throw new Error('mesh_upload_failed');
    return res.json(); // { job_id, status }
  }

  /** GET /api/meshes/jobs/{jobId} — poll the background commit. Returns
   *  null when the server no longer knows the job (restart / expiry). */
  async function meshJobStatus(jobId) {
    const res = await fetch(`${API_BASE}/api/meshes/jobs/${jobId}`, {
      headers: authHeaders(),
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error('mesh_upload_failed');
    return res.json(); // { job_id, status, error, mesh }
  }

  /** PUT /api/meshes/{id}/file but resolving with the serialized mesh, for
   *  the background replace job (the plain updateMeshFile serves the card). */
  function replaceMeshFile(id, file, onProgress) {
    return updateMeshFile(id, file, onProgress);
  }

  return {
    listMeshes,
    checkMesh,
    uploadMesh,
    updateMeshFile,
    replaceMeshFile,
    saveMesh,
    classifyMesh,
    fetchMeshFile,
    deleteMesh,
    startMeshUpload,
    meshUploadStatus,
    putMeshChunk,
    commitMeshUpload,
    meshJobStatus,
  };
}
