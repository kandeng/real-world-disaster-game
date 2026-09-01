<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import ConfigurableIcon from '@shared/ConfigurableIcon.vue';
import LoadingSpinner from '@shared/LoadingSpinner.vue';
import { useAuth } from '@shared-composables/useAuth.js';
import {
  useMeshes,
  cachedMeshes,
  invalidateMeshCaches,
} from '@shared-composables/useMeshes.js';
import { jobs, startNewMeshJob, startReplaceMeshJob, jobRunningFor } from '@shared-composables/useMeshUploadJob.js';

// Content -> 3D Asset: the user's GLB mesh assets, most recent first,
// separated by thin horizontal lines — same layout language as the Video
// list. At the top sits the persistent "Upload new 3D Asset" draft card:
// a blank 3D frame carrying the call-to-action text; clicking the frame
// collapses/expands the editor layout below (3D Asset upload row, Name,
// Description, Animation Script with the AI automation icon, upload/update
// time). Picking a GLB there enqueues a background upload job (module-scoped
// queue, chunked + resumable server-side): the user can navigate anywhere
// while it runs, and the top bar shows the terminal notice; this list only
// applies the finished job to its cards.
// Each asset card: collapsed it is its draggable 3D preview (a
// <model-viewer> fed by the auth-scoped GLB; clicking the preview toggles
// the card too); expanded: the GLB update control, Name + Description +
// Animation Script editors, the upload/update time, and the Save /
// Download / Delete action row. Storage is content-addressed server side,
// so every upload runs a SHA-256 dedup check first.
const { t, locale } = useI18n();
const { isAuthenticated } = useAuth();
const { listMeshes, saveMesh, classifyMesh, fetchMeshFile, deleteMesh } = useMeshes();
const meshes = ref([]);
const loading = ref(false);
const loadError = ref(false);
const expanded = ref({}); // meshId -> bool
const viewerReady = ref(false); // @google/model-viewer loaded + defined
const modelUrls = ref({}); // meshId -> object URL feeding the viewer
const modelLoading = ref({}); // meshId -> the GLB is still downloading
const modelMissing = ref({}); // meshId -> the server has no GLB for this row
const savingId = ref(null);
const savedId = ref(null); // transient "Saved" hint
const failedId = ref(null); // transient "Save failed" hint
const downloadingId = ref(null);
const downloadFailedId = ref(null); // transient "Download failed" hint
const deletingId = ref(null);
const deleteFailedId = ref(null); // transient "Delete failed" hint
const uploadedId = ref(null); // transient "Uploaded" hint (set by the job watcher)
const uploadFailedId = ref(null); // transient "Upload failed" hint
const createHint = ref(null); // 'created' | 'failed' (set by the job watcher)
// Persistent "Upload new 3D Asset" draft card at the top of the list.
const draft = ref({ name: '', description: '', animation_script: '' });
const draftPublic = ref(false); // "Make this 3D asset public" on the draft card
// The twelve Public Component shelves (mirrors PublicComponentView.vue).
const MESH_CATEGORIES = [
  'vehicle', 'ship', 'plane', 'architecture', 'sculpture', 'human',
  'animal', 'vegetation', 'equipment', 'water', 'fire', 'cloud',
];
const classifyingId = ref(null); // mesh whose DSH classification is in flight
const draftExpanded = ref(true);
const automationHint = ref(null); // 'draft' | meshId transient hint
const pendingDelete = ref(null); // mesh waiting in the Delete warning dialog
const filePicker = ref(null); // hidden <input type="file">
let pickMode = null; // 'new' | 'replace'
let pickTargetId = null; // the mesh the next picked GLB replaces
let hintTimer = null;
let downloadHintTimer = null;
let uploadHintTimer = null;
let createHintTimer = null;
let automationHintTimer = null;

// Background upload jobs (useMeshUploadJob): the draft card's creation
// transfer plus any card's GLB replacement run in the module-scoped queue.
const createJob = computed(() => jobs.find((j) => j.kind === 'create') || null);
const replaceJobs = computed(() => jobs.filter((j) => j.kind === 'replace'));
const creating = computed(
  () => !!createJob.value && ['pending', 'hashing', 'transfer', 'commit'].includes(createJob.value.status)
);
const replaceActive = computed(() =>
  replaceJobs.value.some((j) => ['pending', 'hashing', 'transfer', 'commit'].includes(j.status))
);

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

// Applying finished upload jobs: the watcher sees the terminal transition
// regardless of which page the transfer finished on (module-scoped queue).
watch(
  () => jobs.map((j) => `${j.id}:${j.status}`),
  (now, was) => {
    const prev = new Set(was || []);
    for (const j of jobs) {
      if (j.status !== 'done' && j.status !== 'failed') continue;
      if (prev.has(`${j.id}:${j.status}`)) continue;
      applyJobResult(j);
    }
  }
);

function jobStatusActive(status) {
  return ['pending', 'hashing', 'transfer', 'commit'].includes(status);
}

function applyJobResult(job) {
  if (job.kind === 'create') {
    if (job.status === 'done' && job.mesh) {
      const mesh = job.mesh;
      if (!meshes.value.find((x) => x.id === mesh.id)) {
        meshes.value = [mesh, ...meshes.value];
      }
      ensureModelUrl(mesh);
      expanded.value = { ...expanded.value, [mesh.id]: true };
      if (mesh.visibility === 'public') autoClassify(mesh); // DSH suggestion
      draft.value = { name: '', description: '', animation_script: '' };
      draftPublic.value = false;
      flashCreate('created');
    } else if (job.status === 'failed') {
      flashCreate('failed');
    }
    return;
  }
  // A card's GLB replacement.
  const id = job.meshId;
  if (job.status === 'done' && job.mesh) {
    const prev = meshes.value.find((x) => x.id === id);
    meshes.value = meshes.value.map((x) => (x.id === id ? { ...x, ...job.mesh } : x));
    if (prev) dropModel(prev);
    ensureModelUrl(job.mesh);
    flashUpload(id, 'uploaded');
  } else if (job.status === 'failed') {
    flashUpload(id, 'failed');
  }
}

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
  ensureModelUrl(m); // retry hook when an earlier fetch failed
}

// Fetch (once) and object-URL the GLB so the auth-scoped bytes can feed the
// unauthenticated <model-viewer src>. While the (possibly large) download
// runs the card shows a spinner; "No model available" is reserved for rows
// whose GLB is genuinely absent. A transient network error is treated like
// "missing" but can be retried by toggling the card again.
async function ensureModelUrl(m) {
  if (modelUrls.value[m.id] || modelLoading.value[m.id]) return;
  let blob = blobCache.get(m.id);
  if (!blob) {
    modelLoading.value = { ...modelLoading.value, [m.id]: true };
    try {
      blob = await fetchMeshFile(m.id);
    } catch {
      blob = null; // network hiccup: show unavailable, retry on re-open
    }
    const loadingNext = { ...modelLoading.value };
    delete loadingNext[m.id];
    modelLoading.value = loadingNext;
    if (!blob) {
      modelMissing.value = { ...modelMissing.value, [m.id]: true };
      return;
    }
    blobCache.set(m.id, blob);
  }
  const missNext = { ...modelMissing.value };
  delete missNext[m.id];
  modelMissing.value = missNext;
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
  if (creating.value || replaceActive.value) return;
  pickMode = 'new';
  pickTargetId = null;
  openPicker();
}

function pickReplace(m) {
  if (creating.value || jobRunningFor(m.id)) return;
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

function onFilePicked(e) {
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
  // Hashing, dedup, chunked transfer and commit all run inside the job.
  if (mode === 'new') enqueueCreate(file);
  else enqueueReplace(targetId, file);
}

// Creation-on-upload now runs as a background job: the queue hashes, dedups,
// transfers chunked + resumable, and polls the server-side commit, all while
// the user may be on another page. This list only watches `jobs`.
function enqueueCreate(file) {
  startNewMeshJob(file, {
    name: draft.value.name,
    description: draft.value.description,
    animation_script: draft.value.animation_script,
    visibility: draftPublic.value ? 'public' : 'private',
  });
}

// Replace a card's GLB as a background job too (the watcher applies the
// updated row and refreshes the 3D preview when it lands).
function enqueueReplace(id, file) {
  startReplaceMeshJob(id, file);
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

// "Make this 3D asset public": flip the row's visibility ('private' <->
// 'public') and persist it right away; revert the optimistic toggle when
// the save fails. Publishing triggers the DSH auto-classification into a
// Public Component category.
async function onTogglePublic(m) {
  const next = m.visibility === 'public' ? 'private' : 'public';
  const prev = m.visibility;
  m.visibility = next;
  try {
    const updated = await saveMesh(m.id, {
      name: m.name,
      description: m.description || '',
      animation_script: m.animation_script || '',
      visibility: next,
    });
    m.visibility = updated.visibility;
    m.category = updated.category;
    if (updated.visibility === 'public') autoClassify(m);
  } catch {
    m.visibility = prev;
  }
}

// DSH auto-classification: ask the server LLM to shelf the asset into one
// of the twelve Public Component categories. The suggestion is persisted
// server-side and shown in the category select, which stays available as
// the manual override. Failures are swallowed (manual pick remains).
async function autoClassify(m) {
  if (classifyingId.value) return;
  classifyingId.value = m.id;
  try {
    const updated = await classifyMesh(m.id);
    m.category = updated.category;
  } catch {
    /* engine unavailable: the owner picks a shelf manually */
  } finally {
    if (classifyingId.value === m.id) classifyingId.value = null;
  }
}

// Manual shelf override (also covers a failed/absent classification).
async function onCategoryChange(m, ev) {
  const cat = ev.target.value;
  const prev = m.category;
  m.category = cat;
  try {
    const updated = await saveMesh(m.id, {
      name: m.name,
      description: m.description || '',
      animation_script: m.animation_script || '',
      category: cat,
    });
    m.category = updated.category;
  } catch {
    m.category = prev;
  }
}

// The automation (AI script generation) icon is a UI placeholder until the
// AI backend lands; clicking it flashes a transient "coming soon" hint.
function flashAutomation(key) {
  clearTimeout(automationHintTimer);
  automationHint.value = key;
  automationHintTimer = setTimeout(() => (automationHint.value = null), 2400);
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

    <!-- Persistent "Upload new 3D Asset" draft card: the blank 3D frame
         carries the call-to-action; clicking the frame collapses/expands
         the editor layout below. Picking a GLB in the 3D Asset row mints
         the asset with the drafted metadata (creation-on-upload). -->
    <div v-if="isAuthenticated" class="mlist__entry">
      <div class="mlist__head">
        <div
          class="mlist__thumb mlist__thumb--clickable"
          @click="draftExpanded = !draftExpanded"
        >
          <div class="mlist__thumb-empty">{{ t('contentmeshlist.new_asset') }}</div>
        </div>
        <button
          class="mlist__toggle"
          :title="draftExpanded ? t('contentmeshlist.collapse') : t('contentmeshlist.expand')"
          :aria-label="draftExpanded ? t('contentmeshlist.collapse') : t('contentmeshlist.expand')"
          @click="draftExpanded = !draftExpanded"
        >
          <ConfigurableIcon
            :name="draftExpanded ? 'MENU_UPWARD' : 'MENU_DOWNWARD'"
            :size="28"
          />
        </button>
      </div>

      <template v-if="draftExpanded">
        <div class="mlist__asset-row">
          <span class="mlist__inline-label">{{ t('contentmeshlist.asset_label') }}</span>
          <button
            class="mlist__upload"
            :disabled="creating || replaceActive"
            @click="pickNew"
          >
            <span>{{ t('contentmeshlist.upload_glb') }}</span>
            <ConfigurableIcon name="MENU_FILE_UPLOAD" :size="20" />
          </button>
          <span v-if="createJob && createJob.status === 'transfer'" class="mlist__progress">{{ Math.floor(createJob.progress * 100) }}%</span>
          <span v-else-if="creating" class="mlist__progress">…</span>
          <span v-if="createHint === 'created'" class="mlist__saved">{{ t('contentmeshlist.uploaded') }}</span>
          <span v-else-if="createHint === 'failed'" class="mlist__failed">{{ t('contentmeshlist.upload_failed') }}</span>
        </div>

        <div class="mlist__label-line">{{ t('contentmeshlist.name_label') }}</div>
        <textarea
          v-model="draft.name"
          class="mlist__title-input"
          rows="2"
          maxlength="200"
        ></textarea>

        <div class="mlist__label-line">{{ t('contentmeshlist.description_label') }}</div>
        <textarea
          v-model="draft.description"
          class="mlist__desc"
          rows="3"
          maxlength="4000"
        ></textarea>

        <div class="mlist__label-line mlist__label-line--row">
          <span>{{ t('contentmeshlist.animation_label') }}</span>
          <button
            class="mlist__automation"
            :title="t('contentmeshlist.automation_placeholder')"
            @click="flashAutomation('draft')"
          >
            <ConfigurableIcon name="MENU_AUTOMATION" :size="18" />
          </button>
          <span v-if="automationHint === 'draft'" class="mlist__failed">{{ t('contentmeshlist.automation_hint') }}</span>
        </div>
        <textarea
          v-model="draft.animation_script"
          class="mlist__desc"
          rows="3"
          maxlength="8000"
          :placeholder="t('contentmeshlist.automation_placeholder')"
        ></textarea>

        <div class="mlist__meta">
          <div class="mlist__meta-label">{{ t('contentmeshlist.time_label') }}</div>
          <div class="mlist__meta-value">—</div>
        </div>

        <label class="mlist__check">
          <input type="checkbox" v-model="draftPublic" />
          <span>{{ t('contentmeshlist.make_public') }}</span>
        </label>
      </template>
    </div>

    <LoadingSpinner v-if="loading && !meshes.length" />

    <div
      v-for="m in meshes"
      :key="m.id"
      class="mlist__entry"
    >
      <div class="mlist__head">
        <!-- Draggable 3D preview of the GLB (Sketchfab-like). Fed by an
             object URL built from the auth-scoped GLB fetch. Clicking the
             frame toggles the editor layout below. -->
        <div class="mlist__thumb mlist__thumb--clickable" @click="toggle(m)">
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
          <div v-else-if="modelMissing[m.id]" class="mlist__thumb-empty">{{ t('contentmeshlist.no_model') }}</div>
          <div v-else class="mlist__thumb-empty">
            <LoadingSpinner />
          </div>
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
            :disabled="jobRunningFor(m.id) || creating"
            @click="pickReplace(m)"
          >
            <span>{{ t('contentmeshlist.upload_glb') }}</span>
            <ConfigurableIcon name="MENU_FILE_UPLOAD" :size="20" />
          </button>
          <template v-for="rj in replaceJobs" :key="rj.id">
            <span v-if="rj.meshId === m.id && rj.status === 'transfer'" class="mlist__progress">{{ Math.floor(rj.progress * 100) }}%</span>
            <span v-else-if="rj.meshId === m.id && jobStatusActive(rj.status)" class="mlist__progress">…</span>
          </template>
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

        <div class="mlist__label-line mlist__label-line--row">
          <span>{{ t('contentmeshlist.animation_label') }}</span>
          <button
            class="mlist__automation"
            :title="t('contentmeshlist.automation_placeholder')"
            @click="flashAutomation(m.id)"
          >
            <ConfigurableIcon name="MENU_AUTOMATION" :size="18" />
          </button>
          <span v-if="automationHint === m.id" class="mlist__failed">{{ t('contentmeshlist.automation_hint') }}</span>
        </div>
        <textarea
          v-model="m.animation_script"
          class="mlist__desc"
          rows="3"
          maxlength="8000"
          :placeholder="t('contentmeshlist.automation_placeholder')"
        ></textarea>

        <div class="mlist__meta">
          <div class="mlist__meta-label">{{ t('contentmeshlist.time_label') }}</div>
          <div class="mlist__meta-value">{{ displayTime(m) }}</div>
        </div>

        <label class="mlist__check">
          <input
            type="checkbox"
            :checked="m.visibility === 'public'"
            @change="onTogglePublic(m)"
          />
          <span>{{ t('contentmeshlist.make_public') }}</span>
        </label>

        <!-- Public Component shelf: the DSH auto-classification suggestion
             lands here; the select stays as the manual override. -->
        <div v-if="m.visibility === 'public'" class="mlist__meta">
          <div class="mlist__meta-label">{{ t('contentmeshlist.category_label') }}</div>
          <select
            class="mlist__cat-select"
            :value="m.category || ''"
            :disabled="classifyingId === m.id"
            @change="onCategoryChange(m, $event)"
          >
            <option value="" disabled>{{ classifyingId === m.id ? t('contentmeshlist.classifying') : t('contentmeshlist.category_none') }}</option>
            <option v-for="c in MESH_CATEGORIES" :key="c" :value="c">
              {{ t(`publiccomponentview.cat_${c}`) }}
            </option>
          </select>
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

/* Clicking a 3D frame toggles the editor layout below it. */
.mlist__thumb--clickable {
  cursor: pointer;
}

/* Animation Script label row: label + AI automation icon + hint. */
.mlist__label-line--row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.mlist__automation {
  border: none;
  background: none;
  padding: 2px;
  cursor: pointer;
  display: flex;
  align-items: center;
  color: #515151;
}

.mlist__automation:hover {
  color: #007aff;
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

.mlist__cat-select {
  margin-top: 4px;
  padding: 4px 8px;
  font-size: 0.9rem;
  font-family: inherit;
  color: #1d1d1f;
  background: #ffffff;
  border: 1px solid #d2d2d7;
  border-radius: 8px;
  cursor: pointer;
}

.mlist__cat-select:disabled {
  cursor: progress;
  opacity: 0.7;
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

/* "Make this 3D asset public" checkbox, just above the icon action row. */
.mlist__check {
  margin-top: 16px;
  display: flex;
  align-items: center;
  gap: 8px;
  width: fit-content;
  font-size: 0.9rem;
  color: #1d1d1f;
  cursor: pointer;
}

.mlist__check input {
  cursor: pointer;
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

/* Live transfer progress of a background upload job. */
.mlist__progress {
  font-size: 0.85rem;
  color: #007aff;
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
