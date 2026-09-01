<script setup>
import { onMounted, onUnmounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import ConfigurableIcon from '@shared/ConfigurableIcon.vue';
import LoadingSpinner from '@shared/LoadingSpinner.vue';
import { useAuth } from '@shared-composables/useAuth.js';
import {
  useMeshes,
  cachedMeshes,
  invalidateMeshCaches,
  sha256OfFile,
} from '@shared-composables/useMeshes.js';

// Content -> 3D Asset: the user's GLB mesh assets, most recent first,
// separated by thin horizontal lines — same layout language as the Video
// list. Collapsed, a card is its draggable 3D preview (a <model-viewer>
// fed by the auth-scoped GLB); expanded: the GLB update control, Name +
// Description + Animation Script editors, the upload/update time, and the
// Save / Download / Delete action row. Storage is content-addressed server
// side, so every upload runs a SHA-256 dedup check first.
const { t, locale } = useI18n();
const { isAuthenticated } = useAuth();
const { listMeshes, checkMesh, uploadMesh, updateMeshFile, saveMesh, fetchMeshFile, deleteMesh } = useMeshes();

const meshes = ref([]);
const loading = ref(false);
const loadError = ref(false);
const expanded = ref({}); // meshId -> bool
const viewerReady = ref(false); // @google/model-viewer loaded + defined
const modelUrls = ref({}); // meshId -> object URL feeding the viewer
const savingId = ref(null);
const savedId = ref(null); // transient "Saved" hint
const failedId = ref(null); // transient "Save failed" hint
const downloadingId = ref(null);
const downloadFailedId = ref(null); // transient "Download failed" hint
const uploadingId = ref(null); // a card's GLB is being replaced
const uploadedId = ref(null); // transient "Uploaded" hint
const uploadFailedId = ref(null); // transient "Upload failed" hint
const deletingId = ref(null);
const deleteFailedId = ref(null); // transient "Delete failed" hint
const creating = ref(false); // the top "new asset" upload is running
const createHint = ref(null); // 'created' | 'failed'
const pendingDelete = ref(null); // mesh waiting in the Delete warning dialog
const filePicker = ref(null); // hidden <input type="file">
let pickMode = null; // 'new' | 'replace'
let pickTargetId = null; // the mesh the next picked GLB replaces
let hintTimer = null;
let downloadHintTimer = null;
let uploadHintTimer = null;
let createHintTimer = null;

// GLB blobs fetched for the viewer, kept at module scope so tab switches do
// not re-download them. Object URLs are created per mount and revoked on
// unmount.
const blobCache = new Map(); // meshId -> Blob

onMounted(async () => {
  // Register the <model-viewer> web component lazily: its weight only loads
  // when this tab is actually visited.
  import('@google/model-viewer')
    .then(() => {
      viewerReady.value = true;
    })
    .catch(() => {
      viewerReady.value = false;
    });

  if (!isAuthenticated.value) return;
  // Instant paint from the last successful fetch; the GET revalidates.
  const cached = cachedMeshes();
  if (cached) meshes.value = cached;
  loading.value = !meshes.value.length;
  try {
    meshes.value = await listMeshes();
  } catch {
    if (!meshes.value.length) loadError.value = true;
  } finally {
    loading.value = false;
  }
  meshes.value.forEach((m) => ensureModelUrl(m));
});

onUnmounted(() => {
  Object.values(modelUrls.value).forEach((url) => URL.revokeObjectURL(url));
});

// "Aug 28, 17:40" (en) / "8月28日 17:40" (zh)
function fmtDate(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return d.toLocaleString(locale.value === 'zh' ? 'zh-CN' : 'en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

// Upload/update Time: the last change wins.
function displayTime(m) {
  return fmtDate(m.updated_at || m.created_at);
}

function toggle(m) {
  expanded.value = { ...expanded.value, [m.id]: !expanded.value[m.id] };
}

// Fetch (once) and object-URL the GLB so the auth-scoped bytes can feed the
// unauthenticated <model-viewer src>.
async function ensureModelUrl(m) {
  if (modelUrls.value[m.id]) return;
  let blob = blobCache.get(m.id);
  if (!blob) {
    blob = await fetchMeshFile(m.id);
    if (!blob) return;
    blobCache.set(m.id, blob);
  }
  modelUrls.value = { ...modelUrls.value, [m.id]: URL.createObjectURL(blob) };
}

function dropModel(m) {
  const url = modelUrls.value[m.id];
  if (url) URL.revokeObjectURL(url);
  const next = { ...modelUrls.value };
  delete next[m.id];
  modelUrls.value = next;
  blobCache.delete(m.id);
}

// ── File picking (create new + replace existing) ────────────────────────
function pickNew() {
  if (creating.value || uploadingId.value) return;
  pickMode = 'new';
  pickTargetId = null;
  openPicker();
}

function pickReplace(m) {
  if (creating.value || uploadingId.value) return;
  pickMode = 'replace';
  pickTargetId = m.id;
  openPicker();
}

function openPicker() {
  const input = filePicker.value;
  if (!input) return;
  input.value = ''; // allow re-picking the very same file
  input.click();
}

async function onFilePicked(e) {
  const file = e.target.files && e.target.files[0];
  const mode = pickMode;
  const targetId = pickTargetId;
  pickMode = null;
  pickTargetId = null;
  if (!file) return;
  if (!/\.glb$/i.test(file.name) && file.type !== 'model/gltf-binary') {
    if (mode === 'replace' && targetId) flashUpload(targetId, 'failed');
    else flashCreate('failed');
    return;
  }
  let sha = '';
  try {
    sha = await sha256OfFile(file);
  } catch {
    if (mode === 'replace' && targetId) flashUpload(targetId, 'failed');
    else flashCreate('failed');
    return;
  }
  if (mode === 'new') await createFromFile(file, sha);
  else await replaceFile(targetId, file, sha);
}

// Creation-on-upload: hash, dedup-probe, then upload (or reuse an existing
// row when the bytes are already ours) and prepend the new card.
async function createFromFile(file, sha) {
  creating.value = true;
  try {
    let mesh = null;
    try {
      const chk = await checkMesh(sha, file.size);
      if (chk.status === 'mine' && chk.mesh) mesh = chk.mesh;
    } catch {
      /* probe failed — fall through to the upload, which dedups too */
    }
    if (!mesh) {
      mesh = await uploadMesh(file, { name: '', description: '', animation_script: '', sha256: sha });
    }
    if (!meshes.value.find((x) => x.id === mesh.id)) {
      meshes.value = [mesh, ...meshes.value];
    }
    invalidateMeshCaches();
    await ensureModelUrl(mesh);
    expanded.value = { ...expanded.value, [mesh.id]: true };
    flashCreate('created');
  } catch {
    flashCreate('failed');
  } finally {
    creating.value = false;
  }
}

// Replace a card's GLB: no-op when the bytes are identical, otherwise swap
// to the new content-addressed blob and refresh the preview.
async function replaceFile(id, file, sha) {
  const m = meshes.value.find((x) => x.id === id);
  if (!m) return;
  if (m.sha256 && m.sha256 === sha) {
    flashUpload(id, 'uploaded');
    return;
  }
  uploadingId.value = id;
  try {
    const updated = await updateMeshFile(id, file);
    meshes.value = meshes.value.map((x) => (x.id === id ? { ...x, ...updated } : x));
    invalidateMeshCaches();
    dropModel(m);
    await ensureModelUrl(updated);
    flashUpload(id, 'uploaded');
  } catch {
    flashUpload(id, 'failed');
  } finally {
    uploadingId.value = null;
  }
}

// ── Save / Download / Delete ────────────────────────────────────────────
async function onSave(m) {
  if (savingId.value) return;
  savingId.value = m.id;
  try {
    const updated = await saveMesh(m.id, {
      name: m.name,
      description: m.description || '',
      animation_script: m.animation_script || '',
    });
    m.name = updated.name;
    m.description = updated.description;
    m.animation_script = updated.animation_script;
    m.updated_at = updated.updated_at;
    flash(m.id, 'saved');
  } catch {
    flash(m.id, 'failed');
  } finally {
    savingId.value = null;
  }
}

function flash(id, kind) {
  clearTimeout(hintTimer);
  savedId.value = kind === 'saved' ? id : null;
  failedId.value = kind === 'failed' ? id : null;
  hintTimer = setTimeout(() => {
    savedId.value = null;
    failedId.value = null;
  }, 2400);
}

function flashUpload(id, kind) {
  clearTimeout(uploadHintTimer);
  uploadedId.value = kind === 'uploaded' ? id : null;
  uploadFailedId.value = kind === 'failed' ? id : null;
  uploadHintTimer = setTimeout(() => {
    uploadedId.value = null;
    uploadFailedId.value = null;
  }, 1600);
}

function flashCreate(kind) {
  clearTimeout(createHintTimer);
  createHint.value = kind;
  createHintTimer = setTimeout(() => (createHint.value = null), 2400);
}

async function onDownload(m) {
  if (downloadingId.value) return;
  downloadingId.value = m.id;
  downloadFailedId.value = null;
  try {
    let blob = blobCache.get(m.id);
    if (!blob) blob = await fetchMeshFile(m.id);
    if (!blob) {
      downloadFailedId.value = m.id;
      clearTimeout(downloadHintTimer);
      downloadHintTimer = setTimeout(() => (downloadFailedId.value = null), 1600);
      return;
    }
    blobCache.set(m.id, blob);
    await saveBlobAsGlb(blob, m.name);
  } catch {
    downloadFailedId.value = m.id;
    clearTimeout(downloadHintTimer);
    downloadHintTimer = setTimeout(() => (downloadFailedId.value = null), 1600);
  } finally {
    downloadingId.value = null;
  }
}

async function saveBlobAsGlb(blob, name) {
  const base = (name || 'mesh').replace(/[\\/:*?"<>|]+/g, '_').trim() || 'mesh';
  const filename = `${base}.glb`;
  if (typeof window.showSaveFilePicker === 'function') {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: filename,
        types: [{ description: 'GLB mesh', accept: { 'model/gltf-binary': ['.glb'] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return;
    } catch (err) {
      if (err && err.name === 'AbortError') return; // user cancelled
    }
  }
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function onDelete(m) {
  if (deletingId.value) return;
  pendingDelete.value = m;
}

function cancelDelete() {
  pendingDelete.value = null;
}

async function confirmDelete() {
  const m = pendingDelete.value;
  pendingDelete.value = null;
  if (!m || deletingId.value) return;
  deletingId.value = m.id;
  deleteFailedId.value = null;
  try {
    await deleteMesh(m.id);
    meshes.value = meshes.value.filter((x) => x.id !== m.id);
    dropModel(m);
    // A remount must refetch, not paint the stale cached copy.
    invalidateMeshCaches();
  } catch {
    deleteFailedId.value = m.id;
    clearTimeout(downloadHintTimer);
    downloadHintTimer = setTimeout(() => (deleteFailedId.value = null), 1600);
  } finally {
    deletingId.value = null;
  }
}
</script>

<template>
  <div class="mlist">
    <p v-if="!isAuthenticated" class="mlist__note">{{ t('contentmeshlist.sign_in') }}</p>
    <p v-else-if="loadError" class="mlist__note">{{ t('contentmeshlist.error') }}</p>
    <p v-else-if="!loading && !meshes.length" class="mlist__note">{{ t('contentmeshlist.empty') }}</p>

    <!-- Creation-on-upload: picking a GLB mints a fresh asset card. -->
    <div v-if="isAuthenticated" class="mlist__new-row">
      <button class="mlist__new" :disabled="creating" @click="pickNew">
        <ConfigurableIcon name="MENU_FILE_UPLOAD" :size="20" />
        <span>{{ t('contentmeshlist.new_asset') }}</span>
      </button>
      <span v-if="createHint === 'created'" class="mlist__saved">{{ t('contentmeshlist.uploaded') }}</span>
      <span v-else-if="createHint === 'failed'" class="mlist__failed">{{ t('contentmeshlist.upload_failed') }}</span>
    </div>

    <LoadingSpinner v-if="loading && !meshes.length" />

    <div
      v-for="m in meshes"
      :key="m.id"
      class="mlist__entry"
    >
      <div class="mlist__head">
        <!-- Draggable 3D preview of the GLB (Sketchfab-like). Fed by an
             object URL built from the auth-scoped GLB fetch. -->
        <div class="mlist__thumb">
          <model-viewer
            v-if="viewerReady && modelUrls[m.id]"
            :src="modelUrls[m.id]"
            class="mlist__viewer"
            camera-controls
            auto-rotate
            interaction-prompt="none"
            exposure="1"
            shadow-intensity="0.6"
          ></model-viewer>
          <div v-else class="mlist__thumb-empty">{{ t('contentmeshlist.no_model') }}</div>
        </div>
        <button
          class="mlist__toggle"
          :title="expanded[m.id] ? t('contentmeshlist.collapse') : t('contentmeshlist.expand')"
          :aria-label="expanded[m.id] ? t('contentmeshlist.collapse') : t('contentmeshlist.expand')"
          @click="toggle(m)"
        >
          <ConfigurableIcon
            :name="expanded[m.id] ? 'MENU_UPWARD' : 'MENU_DOWNWARD'"
            :size="28"
          />
        </button>
      </div>

      <template v-if="expanded[m.id]">
        <!-- 3D Asset: Upload the GLB file from local disk (replaces this
             card's content-addressed bytes; identical bytes are a no-op). -->
        <div class="mlist__asset-row">
          <span class="mlist__inline-label">{{ t('contentmeshlist.asset_label') }}</span>
          <button
            class="mlist__upload"
            :disabled="uploadingId === m.id || creating"
            @click="pickReplace(m)"
          >
            <span>{{ t('contentmeshlist.upload_glb') }}</span>
            <ConfigurableIcon name="MENU_FILE_UPLOAD" :size="20" />
          </button>
        </div>

        <div class="mlist__label-line">{{ t('contentmeshlist.name_label') }}</div>
        <textarea
          v-model="m.name"
          class="mlist__title-input"
          rows="2"
          maxlength="200"
        ></textarea>

        <div class="mlist__label-line">{{ t('contentmeshlist.description_label') }}</div>
        <textarea
          v-model="m.description"
          class="mlist__desc"
          rows="3"
          maxlength="4000"
        ></textarea>

        <div class="mlist__label-line">{{ t('contentmeshlist.animation_label') }}</div>
        <textarea
          v-model="m.animation_script"
          class="mlist__desc"
          rows="3"
          maxlength="8000"
        ></textarea>

        <div class="mlist__meta">
          <div class="mlist__meta-label">{{ t('contentmeshlist.time_label') }}</div>
          <div class="mlist__meta-value">{{ displayTime(m) }}</div>
        </div>

        <div class="mlist__actions">
          <button
            class="mlist__action"
            :title="t('contentmeshlist.save')"
            :disabled="savingId === m.id"
            @click="onSave(m)"
          >
            <ConfigurableIcon name="MENU_SAVE" :size="26" />
          </button>
          <button
            class="mlist__action"
            :title="t('contentmeshlist.download')"
            :disabled="downloadingId === m.id"
            @click="onDownload(m)"
          >
            <ConfigurableIcon name="MENU_FILE_DOWNLOAD" :size="26" />
          </button>
          <button
            class="mlist__action"
            :title="t('contentmeshlist.delete')"
            :disabled="deletingId === m.id"
            @click="onDelete(m)"
          >
            <ConfigurableIcon name="MENU_CANCEL" :size="26" />
          </button>
          <span v-if="savedId === m.id" class="mlist__saved">{{ t('contentmeshlist.saved') }}</span>
          <span v-else-if="failedId === m.id" class="mlist__failed">{{ t('contentmeshlist.save_failed') }}</span>
          <span v-else-if="downloadFailedId === m.id" class="mlist__failed">{{ t('contentmeshlist.download_failed') }}</span>
          <span v-else-if="deleteFailedId === m.id" class="mlist__failed">{{ t('contentmeshlist.delete_failed') }}</span>
          <span v-else-if="uploadedId === m.id" class="mlist__saved">{{ t('contentmeshlist.uploaded') }}</span>
          <span v-else-if="uploadFailedId === m.id" class="mlist__failed">{{ t('contentmeshlist.upload_failed') }}</span>
        </div>
      </template>
    </div>

    <!-- Shared hidden GLB picker for the "new asset" button and every card's
         replace control (pickMode/pickTargetId remember the intent). -->
    <input
      ref="filePicker"
      type="file"
      accept=".glb,model/gltf-binary"
      style="display: none"
      @change="onFilePicked"
    />

    <!-- Delete warning dialog: the card's Delete button only opens it; the
         blue Delete button inside performs the delete (blob GC'd server-side
         when nothing else references it). -->
    <div v-if="pendingDelete" class="mlist__dialog-overlay" @click.self="cancelDelete">
      <div class="mlist__dialog">
        <p class="mlist__dialog-text">{{ t('contentmeshlist.delete_warning') }}</p>
        <div class="mlist__dialog-actions">
          <button class="mlist__dialog-cancel" @click="cancelDelete">
            {{ t('contentmeshlist.cancel') }}
          </button>
          <button class="mlist__dialog-confirm" @click="confirmDelete">
            {{ t('contentmeshlist.delete') }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.mlist {
  padding: 8px 48px 48px;
}

.mlist__note {
  padding: 48px 0;
  font-size: 0.9rem;
  color: #6e6e73;
}

/* "Upload new 3D Asset" control above the list. */
.mlist__new-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 0 4px;
}

.mlist__new {
  border: none;
  background: none;
  padding: 2px;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 8px;
  font-family: inherit;
  font-size: 0.95rem;
  font-weight: 600;
  color: #007aff;
}

.mlist__new:hover:not(:disabled) {
  color: #0066d6;
}

.mlist__new:disabled {
  opacity: 0.4;
  cursor: default;
}

/* Thin horizontal separator between entries. */
.mlist__entry {
  padding: 28px 0;
  border-top: 1px solid #e5e5ea;
}

.mlist__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
}

/* Collapsed row: 16:9 draggable 3D preview, same footprint as the video
   thumbnail. */
.mlist__thumb {
  width: 280px;
  aspect-ratio: 16 / 9;
  flex-shrink: 0;
  border-radius: 10px;
  overflow: hidden;
  background: #f0f0f3;
}

.mlist__viewer {
  width: 100%;
  height: 100%;
  display: block;
  background: #f0f0f3;
}

.mlist__thumb-empty {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 12px;
  box-sizing: border-box;
  font-size: 0.85rem;
  color: #6e6e73;
  text-align: center;
}

/* Field labels sit on their own line above the editor boxes, bold; editors
   are vertically resizable (drag the bottom border). */
.mlist__label-line {
  margin-top: 18px;
  margin-bottom: 6px;
  font-size: 0.95rem;
  font-weight: 700;
  color: #1d1d1f;
}

.mlist__title-input {
  box-sizing: border-box;
  width: 100%;
  max-width: 640px;
  padding: 8px 12px;
  border: 1px solid #8e8e93;
  border-radius: 8px;
  background: #ffffff;
  font-family: inherit;
  font-size: 1.05rem;
  font-weight: 600;
  color: #111827;
  resize: vertical;
  min-height: 56px;
}

.mlist__desc {
  box-sizing: border-box;
  width: 100%;
  max-width: 640px;
  padding: 8px 12px;
  border: 1px solid #8e8e93;
  border-radius: 8px;
  background: #ffffff;
  font-family: inherit;
  font-size: 0.9rem;
  color: #111827;
  resize: vertical;
  min-height: 72px;
}

.mlist__title-input:focus,
.mlist__desc:focus {
  outline: 1px solid rgba(37, 99, 235, 0.5);
}

/* "3D Asset: Upload the GLB file from local disk" row. */
.mlist__asset-row {
  margin-top: 18px;
  display: flex;
  align-items: center;
  gap: 10px;
}

.mlist__inline-label {
  font-size: 0.95rem;
  font-weight: 700;
  color: #1d1d1f;
}

.mlist__upload {
  border: none;
  background: none;
  padding: 2px;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 6px;
  font-family: inherit;
  font-size: 0.9rem;
  color: #515151;
}

.mlist__upload:hover:not(:disabled) {
  color: #007aff;
}

.mlist__upload:disabled {
  opacity: 0.4;
  cursor: default;
}

/* Read-only meta line: Upload/update Time. */
.mlist__meta {
  margin-top: 12px;
  font-size: 0.95rem;
  color: #1d1d1f;
}

.mlist__meta-label {
  font-weight: 700;
}

.mlist__meta-value {
  font-weight: 400;
}

.mlist__toggle {
  flex-shrink: 0;
  border: none;
  background: none;
  padding: 4px;
  cursor: pointer;
  display: flex;
  align-items: center;
  color: #6e6e73;
}

.mlist__toggle:hover {
  color: #007aff;
}

.mlist__actions {
  margin-top: 18px;
  display: flex;
  align-items: center;
  gap: 22px;
}

/* Icon-only action buttons (Save / Download / Delete). */
.mlist__action {
  border: none;
  background: none;
  padding: 2px;
  cursor: pointer;
  display: flex;
  align-items: center;
  color: #515151;
}

.mlist__action:hover:not(:disabled) {
  color: #007aff;
}

.mlist__action:disabled {
  opacity: 0.4;
  cursor: default;
}

.mlist__saved {
  font-size: 0.85rem;
  color: #34a853;
}

.mlist__failed {
  font-size: 0.85rem;
  color: #dc143c;
}

/* Delete warning dialog (dimmed full-screen overlay, centered card). */
.mlist__dialog-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.35);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}

.mlist__dialog {
  width: 420px;
  max-width: calc(100vw - 48px);
  background: #ffffff;
  border-radius: 14px;
  box-shadow: 0 20px 50px rgba(0, 0, 0, 0.2);
  padding: 24px;
}

.mlist__dialog-text {
  margin: 0;
  font-size: 0.95rem;
  line-height: 1.7;
  color: #1d1d1f;
  white-space: pre-line;
}

.mlist__dialog-actions {
  margin-top: 20px;
  display: flex;
  justify-content: flex-end;
  gap: 12px;
}

.mlist__dialog-cancel {
  border: none;
  background: none;
  padding: 8px 16px;
  cursor: pointer;
  font-family: inherit;
  font-size: 0.95rem;
  color: #6e6e73;
}

.mlist__dialog-cancel:hover {
  color: #1d1d1f;
}

.mlist__dialog-confirm {
  border: none;
  background: #007aff;
  color: #ffffff;
  border-radius: 8px;
  padding: 8px 26px;
  cursor: pointer;
  font-family: inherit;
  font-size: 0.95rem;
  font-weight: 600;
}

.mlist__dialog-confirm:hover {
  background: #0066d6;
}
</style>
