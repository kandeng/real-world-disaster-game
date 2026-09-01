"""Per-user 3D mesh assets (Content -> 3D Asset).

Content-addressed storage with SHA-256 dedup:

    GET    /api/meshes            -> the caller's meshes, most recent first.
    POST   /api/meshes/check      -> fast indexed dedup probe: does the caller
                                     already own a mesh with this sha256? Lets
                                     the client skip re-uploading known bytes.
    POST   /api/meshes            -> multipart upload of one GLB. The bytes are
                                     hashed while streaming; an identical file
                                     (same user or another) is stored once on
                                     disk and only a fresh catalog row is added.
    PUT    /api/meshes/{id}       -> update name / description / animation_script /
                                     visibility / category.
    POST   /api/meshes/{id}/classify -> LLM auto-classification into one of the
                                     twelve Public Component categories
                                     (chat_engine.classify_asset) over the
                                     name/description/filename PLUS the names
                                     extracted from the GLB's glTF JSON chunk;
                                     persists the result on the row and returns it.
    GET    /api/meshes/{id}/file  -> serve the GLB bytes (owner-scoped). Unlike
                                     the video cache this does NOT consume the
                                     file, because other mesh rows may reference
                                     the same content-addressed blob.
    DELETE /api/meshes/{id}       -> retire the caller's catalog row; the blob is
                                     unlinked only when no remaining row
                                     references its sha256 (refcount GC).

Chunked resumable upload (lets the client close/navigate away and resume
from the last offset instead of restarting a big transfer):

    POST   /api/meshes/uploads                 -> open a session: {upload_id}.
    GET    /api/meshes/uploads/{id}            -> {received} bytes so far (resume).
    PUT    /api/meshes/uploads/{id}/chunk      -> raw-body chunk at ?offset= (contiguous).
    POST   /api/meshes/uploads/{id}/commit     -> 202 {job_id}; a background task
                                                  hashes/verifies/stores the bytes and
                                                  mints the catalog row.
    GET    /api/meshes/jobs/{job_id}           -> poll: pending|running|done|failed (+mesh).

Public Component feed (anonymous-safe; powers the Public Component page):

    GET    /api/meshes/public                  -> every public mesh, newest first
                                                  (?category= shelf filter, ?q= search).
    GET    /api/meshes/public/{id}/file        -> the GLB of a published mesh.

The GLB bytes live once per unique hash at
``server/workspace/meshes/<sha256[:2]>/<sha256>.glb`` (the workspace/ directory
is excluded from the deploy rsync, so files survive backend redeploys).

Ownership is enforced purely at this layer: every statement is scoped by the
JWT caller's id and foreign ids surface as 404 (API-only hardening, per the CMS
schema decision).
"""

import asyncio
import hashlib
import json
import logging
import re
import struct
import time
import uuid
from pathlib import Path
from tempfile import SpooledTemporaryFile

import shutil

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from .chat_engine import MESH_CATEGORY_IDS, classify_asset
from .config import CONFIG
from .db import async_session_maker, get_async_session
from .models import Mesh, User
from .users import current_active_user

router = APIRouter(tags=["meshes"])
log = logging.getLogger(__name__)

# Content-addressed blob store, keyed by sha256 (see module docstring).
MESH_DIR = Path(__file__).resolve().parent.parent / "workspace" / "meshes"

# Per-upload size cap (bytes). GLBs are typically a few MB; 100 MB default.
MESH_MAX_SIZE = int(CONFIG.get("mesh_max_size", 100 * 1024 * 1024))

# GLB containers begin with the 4-byte magic "glTF" (glTF Binary).
_GLB_MAGIC = b"glTF"

# ── Chunked resumable upload (background commit) ─────────────────────────
# Sessions live in memory and spool their bytes to a temp file; commit runs
# hash/verify/store/row-mint in a background asyncio task so the HTTP
# request returns immediately (202 + job_id to poll). A vanished server
# simply loses the in-memory sessions — the client detects the 404 and
# restarts the transfer from offset 0.
UPLOAD_DIR = Path(__file__).resolve().parent.parent / "workspace" / "uploads_tmp"
UPLOAD_TTL = 24 * 3600  # seconds without activity before a session expires
UPLOAD_CHUNK_MAX = 16 * 1024 * 1024  # per-chunk body cap
UPLOADS: dict[str, dict] = {}  # upload_id -> session
JOBS: dict[str, dict] = {}  # job_id -> commit job state


def _get_session(upload_id: str, user: User) -> dict:
    sess = UPLOADS.get(upload_id)
    if sess is None or sess["user_id"] != user.id:
        raise HTTPException(status_code=404, detail="UPLOAD_NOT_FOUND")
    return sess


def _sweep_uploads() -> None:
    """Best-effort cleanup of expired sessions (called from the hot path)."""
    now = time.time()
    for uid, sess in list(UPLOADS.items()):
        if now - sess["touched"] > UPLOAD_TTL:
            UPLOADS.pop(uid, None)
            try:
                sess["spool"].close()
            except Exception:
                pass


async def _commit_upload_task(upload_id: str) -> None:
    """Background finish of a chunked upload: hash + verify the spooled
    bytes, dedup, store the blob once per hash, mint the catalog row."""
    sess = UPLOADS.get(upload_id)
    if sess is None:
        return
    job = sess["job"]
    spool = sess["spool"]
    job["status"] = "running"
    try:
        hasher = hashlib.sha256()
        magic = b""
        size = 0
        spool.seek(0)
        while chunk := spool.read(1024 * 1024):
            if not magic:
                magic = chunk[:4]
            size += len(chunk)
            if size > MESH_MAX_SIZE:
                raise HTTPException(status_code=413, detail="FILE_TOO_LARGE")
            hasher.update(chunk)
        if size == 0:
            raise HTTPException(status_code=400, detail="EMPTY_FILE")
        if magic != _GLB_MAGIC:
            raise HTTPException(status_code=415, detail="NOT_GLB")
        sha = hasher.hexdigest()
        claimed = sess["claimed_sha256"]
        if claimed and claimed != sha:
            raise HTTPException(status_code=400, detail="HASH_MISMATCH")

        async with async_session_maker() as session:
            # Same-user dedup: the caller already owns these exact bytes.
            stmt = select(Mesh).where(
                Mesh.user_id == sess["user_id"], Mesh.sha256 == sha
            )
            existing = (await session.execute(stmt)).scalar_one_or_none()
            if existing is not None:
                job["mesh"] = _serialize(existing)
            else:
                # Store the bytes once per unique hash (any user's earlier
                # upload of identical bytes wins the race).
                _store_blob(spool, sha)
                mesh = Mesh(
                    user_id=sess["user_id"],
                    sha256=sha,
                    name=_default_name(sess["name"], sess["filename"]),
                    description=sess["description"],
                    animation_script=sess["animation_script"],
                    visibility=sess["visibility"],
                    size_bytes=size,
                    original_filename=sess["filename"],
                )
                session.add(mesh)
                await session.commit()
                await session.refresh(mesh)
                job["mesh"] = _serialize(mesh)
        job["status"] = "done"
    except HTTPException as err:
        job["status"] = "failed"
        job["error"] = str(err.detail)
    except Exception as err:  # noqa: BLE001 - surface anything as failed
        log.warning("[meshes] background commit %s failed: %s", upload_id, err)
        job["status"] = "failed"
        job["error"] = "COMMIT_FAILED"
    finally:
        try:
            spool.close()
        except Exception:
            pass
        UPLOADS.pop(upload_id, None)


def _blob_path(sha256: str) -> Path:
    """Two-level fan-out keeps any single directory from growing unbounded."""
    return MESH_DIR / sha256[:2] / f"{sha256}.glb"


class MeshCheck(BaseModel):
    sha256: str = Field(min_length=64, max_length=64)
    size: int = Field(default=0, ge=0)


class MeshUpdate(BaseModel):
    name: str = Field(max_length=200)
    description: str | None = Field(default=None, max_length=4000)
    animation_script: str | None = Field(default=None, max_length=8000)
    visibility: str | None = Field(default=None, pattern="^(private|public)$")
    category: str | None = Field(
        default=None, pattern="^(" + "|".join(MESH_CATEGORY_IDS) + ")$"
    )


def _serialize(mesh: Mesh) -> dict:
    return {
        "id": mesh.id,
        "sha256": mesh.sha256,
        "name": mesh.name,
        "description": mesh.description,
        "animation_script": mesh.animation_script,
        "visibility": mesh.visibility,
        "category": mesh.category,
        "size_bytes": mesh.size_bytes,
        "original_filename": mesh.original_filename,
        "created_at": mesh.created_at.isoformat(),
        "updated_at": mesh.updated_at.isoformat(),
    }


def _default_name(claimed: str, filename: str) -> str:
    """Card Name: the claimed value, else the file's stem, else 'Mesh'."""
    name = (claimed or "").strip()
    if name:
        return name[:200]
    stem = Path(filename or "").stem.strip()
    return (stem or "Mesh")[:200]


@router.get("/meshes")
async def list_meshes(
    user: User = Depends(current_active_user),
    session: AsyncSession = Depends(get_async_session),
) -> list[dict]:
    stmt = (
        select(Mesh)
        .where(Mesh.user_id == user.id)
        .order_by(Mesh.created_at.desc())
    )
    meshes = (await session.execute(stmt)).scalars().all()
    return [_serialize(m) for m in meshes]


# ── Public Component feed (anonymous-safe) ─────────────────────────────
# Everything an anonymous visitor needs to browse the public library: the
# feed itself and the GLB bytes of published rows (the Public Component
# viewer points <model-viewer src> straight at the file endpoint). Private
# rows never surface here.


def _serialize_public(mesh: Mesh, owner_name: str | None) -> dict:
    """Public-safe projection of a mesh row: no sha256 / animation_script /
    visibility — only what the Public Component page displays."""
    return {
        "id": mesh.id,
        "name": mesh.name,
        "description": mesh.description,
        "category": mesh.category,
        "size_bytes": mesh.size_bytes,
        "owner_name": owner_name or "",
        "created_at": mesh.created_at.isoformat(),
    }


@router.get("/meshes/public")
async def list_public_meshes(
    category: str = Query(default=""),
    q: str = Query(default=""),
    session: AsyncSession = Depends(get_async_session),
) -> list[dict]:
    """The Public Component feed (anonymous-safe): every mesh whose owner
    made it public, most recent first. ?category= narrows to one of the
    twelve Public Component shelves (rows with a NULL category are not
    shelved anywhere yet, so a category filter never returns them); ?q=
    filters name/description case-insensitively."""
    stmt = (
        select(Mesh, User.display_name)
        .outerjoin(User, Mesh.user_id == User.id)
        .where(Mesh.visibility == "public")
        .order_by(Mesh.created_at.desc())
    )
    cat = (category or "").strip().lower()
    if cat:
        if cat not in MESH_CATEGORY_IDS:
            raise HTTPException(status_code=400, detail="UNKNOWN_CATEGORY")
        stmt = stmt.where(Mesh.category == cat)
    rows = (await session.execute(stmt)).all()
    needle = (q or "").strip().lower()
    out = []
    for mesh, owner_name in rows:
        d = _serialize_public(mesh, owner_name)
        if needle and needle not in d["name"].lower() and needle not in (
            d["description"] or ""
        ).lower():
            continue
        out.append(d)
    return out


@router.get("/meshes/public/{mesh_id}/file")
async def get_public_mesh_file(
    mesh_id: str,
    session: AsyncSession = Depends(get_async_session),
) -> FileResponse:
    """The GLB bytes of a published mesh, anonymous-safe. Only rows whose
    owner set visibility='public' are served through here; unpublishing a
    mesh instantly hides its bytes again."""
    stmt = select(Mesh).where(Mesh.id == mesh_id, Mesh.visibility == "public")
    mesh = (await session.execute(stmt)).scalar_one_or_none()
    if mesh is None:
        raise HTTPException(status_code=404, detail="MESH_NOT_FOUND")
    blob = _blob_path(mesh.sha256)
    if not blob.is_file():
        raise HTTPException(status_code=404, detail="NO_GLB")
    stem = "".join(
        c for c in (mesh.name or mesh.id) if c not in '\\/:*?"<>|'
    ).strip()
    filename = f"{stem or mesh.id}.glb"
    return FileResponse(blob, media_type="model/gltf-binary", filename=filename)


@router.post("/meshes/check")
async def check_mesh(
    body: MeshCheck,
    user: User = Depends(current_active_user),
    session: AsyncSession = Depends(get_async_session),
) -> dict:
    """Bandwidth saver before an upload: a single indexed lookup answers
    whether the caller already owns a mesh with these exact bytes. 'mine'
    returns the existing row (the client reuses it, zero bytes moved);
    'new' means the client should proceed with the upload. (Cross-user /
    public-library matches collapse to 'new' for v1 — the upload path then
    still dedups the physical blob server-side.)"""
    sha = body.sha256.lower()
    stmt = select(Mesh).where(Mesh.user_id == user.id, Mesh.sha256 == sha)
    existing = (await session.execute(stmt)).scalar_one_or_none()
    if existing is not None:
        return {"status": "mine", "mesh": _serialize(existing)}
    return {"status": "new"}


async def _spool_upload(file: UploadFile):
    """Spool an upload while hashing it; enforce the size cap and the GLB
    magic bytes in the same pass. Returns (spool, sha256_hex, size). Raises
    the matching HTTP error (and closes the spool) on failure."""
    hasher = hashlib.sha256()
    spool = SpooledTemporaryFile(max_size=64 * 1024 * 1024)
    magic = b""
    size = 0
    try:
        while chunk := await file.read(1024 * 1024):
            if not magic:
                magic = chunk[:4]
            size += len(chunk)
            if size > MESH_MAX_SIZE:
                raise HTTPException(status_code=413, detail="FILE_TOO_LARGE")
            hasher.update(chunk)
            spool.write(chunk)
        if size == 0:
            raise HTTPException(status_code=400, detail="EMPTY_FILE")
        if magic != _GLB_MAGIC and not (file.filename or "").lower().endswith(".glb"):
            raise HTTPException(status_code=415, detail="NOT_GLB")
    except HTTPException:
        spool.close()
        raise
    return spool, hasher.hexdigest(), size


def _store_blob(spool, sha: str) -> Path:
    """Place the bytes at their content-addressed path unless an identical
    blob already exists (an earlier upload by any user)."""
    blob = _blob_path(sha)
    if blob.is_file():
        return blob
    try:
        blob.parent.mkdir(parents=True, exist_ok=True)
        spool.seek(0)
        with open(blob, "wb") as fh:
            shutil.copyfileobj(spool, fh)
        return blob
    except OSError as err:
        log.warning("[meshes] store blob %s failed: %s", sha, err)
        raise HTTPException(status_code=500, detail="FILE_STORE_FAILED")


async def _maybe_gc_blob(session: AsyncSession, sha: str) -> None:
    """Unlink a content-addressed blob only when no remaining mesh row
    references its hash (refcount GC, best-effort)."""
    refs = (
        await session.execute(
            select(func.count()).select_from(Mesh).where(Mesh.sha256 == sha)
        )
    ).scalar_one()
    if refs == 0:
        try:
            _blob_path(sha).unlink(missing_ok=True)
        except OSError as err:
            log.warning("[meshes] unlink blob %s failed: %s", sha, err)


@router.post("/meshes", status_code=201)
async def create_mesh(
    file: UploadFile = File(...),
    name: str = Form(""),
    description: str = Form(""),
    animation_script: str = Form(""),
    sha256: str = Form(""),
    visibility: str = Form("private"),
    user: User = Depends(current_active_user),
    session: AsyncSession = Depends(get_async_session),
) -> dict:
    """Upload a GLB and mint the caller's catalog row for it.

    The bytes are spooled while a SHA-256 is computed incrementally; the
    size cap and the GLB magic bytes are enforced during the same pass.
    Dedup then runs on the computed hash: if the caller already owns a row
    for it, that row is returned unchanged (nothing stored); otherwise the
    blob is written only if no identical file already exists on disk (an
    earlier upload by any user), and a fresh row is created.
    """
    spool, computed, size = await _spool_upload(file)
    try:
        claimed = (sha256 or "").strip().lower()
        if claimed and claimed != computed:
            raise HTTPException(status_code=400, detail="HASH_MISMATCH")
        sha = computed

        # Same-user dedup: the caller already owns these exact bytes.
        stmt = select(Mesh).where(Mesh.user_id == user.id, Mesh.sha256 == sha)
        existing = (await session.execute(stmt)).scalar_one_or_none()
        if existing is not None:
            return _serialize(existing)

        # Store the bytes once per unique hash.
        _store_blob(spool, sha)

        mesh = Mesh(
            user_id=user.id,
            sha256=sha,
            name=_default_name(name, file.filename or ""),
            description=description or "",
            animation_script=animation_script or "",
            visibility="public" if (visibility or "").strip().lower() == "public" else "private",
            size_bytes=size,
            original_filename=file.filename or "",
        )
        session.add(mesh)
        await session.commit()
        await session.refresh(mesh)
        return _serialize(mesh)
    finally:
        spool.close()


@router.post("/meshes/uploads", status_code=201)
async def start_mesh_upload(
    filename: str = Form(""),
    size: int = Form(0),
    sha256: str = Form(""),
    name: str = Form(""),
    description: str = Form(""),
    animation_script: str = Form(""),
    visibility: str = Form("private"),
    user: User = Depends(current_active_user),
) -> dict:
    """Open a resumable upload session. The client then pushes contiguous
    chunks (PUT .../chunk?offset=) and finalizes with POST .../commit."""
    _sweep_uploads()
    if size and size > MESH_MAX_SIZE:
        raise HTTPException(status_code=413, detail="FILE_TOO_LARGE")
    upload_id = uuid.uuid4().hex
    spool = SpooledTemporaryFile(max_size=64 * 1024 * 1024)
    job_id = uuid.uuid4().hex
    job = {"id": job_id, "user_id": user.id, "status": "pending", "error": None, "mesh": None}
    JOBS[job_id] = job
    UPLOADS[upload_id] = {
        "user_id": user.id,
        "filename": filename or "",
        "expected_size": max(int(size or 0), 0),
        "claimed_sha256": (sha256 or "").strip().lower(),
        "name": name or "",
        "description": description or "",
        "animation_script": animation_script or "",
        "visibility": "public" if (visibility or "").strip().lower() == "public" else "private",
        "spool": spool,
        "received": 0,
        "touched": time.time(),
        "job": job,
    }
    return {"upload_id": upload_id}


@router.get("/meshes/uploads/{upload_id}")
async def mesh_upload_status(
    upload_id: str,
    user: User = Depends(current_active_user),
) -> dict:
    """How many bytes the server already has — the client resumes from here."""
    sess = _get_session(upload_id, user)
    return {"upload_id": upload_id, "received": sess["received"]}


@router.put("/meshes/uploads/{upload_id}/chunk")
async def put_mesh_upload_chunk(
    upload_id: str,
    offset: int,
    request: Request,
    user: User = Depends(current_active_user),
) -> dict:
    """Append one chunk (raw request body) at the given offset. Offsets must
    be contiguous; a mismatch means the client should re-read GET status and
    resume from the server's authoritative count."""
    sess = _get_session(upload_id, user)
    if offset < 0 or offset != sess["received"]:
        raise HTTPException(status_code=409, detail="OFFSET_MISMATCH")
    body = await request.body()
    if not body:
        raise HTTPException(status_code=400, detail="EMPTY_CHUNK")
    if len(body) > UPLOAD_CHUNK_MAX:
        raise HTTPException(status_code=413, detail="CHUNK_TOO_LARGE")
    expected = sess["expected_size"]
    if expected and sess["received"] + len(body) > expected:
        raise HTTPException(status_code=400, detail="SIZE_EXCEEDED")
    if sess["received"] + len(body) > MESH_MAX_SIZE:
        raise HTTPException(status_code=413, detail="FILE_TOO_LARGE")
    spool = sess["spool"]
    spool.seek(sess["received"])
    spool.write(body)
    sess["received"] += len(body)
    sess["touched"] = time.time()
    return {"received": sess["received"]}


@router.post("/meshes/uploads/{upload_id}/commit", status_code=202)
async def commit_mesh_upload(
    upload_id: str,
    user: User = Depends(current_active_user),
) -> dict:
    """Finalize the transfer: returns 202 immediately; a background task
    hashes/verifies the bytes, dedups, stores the blob, and mints the row.
    The client polls GET /api/meshes/jobs/{job_id} for the outcome."""
    sess = _get_session(upload_id, user)
    expected = sess["expected_size"]
    if expected and sess["received"] < expected:
        raise HTTPException(status_code=400, detail="INCOMPLETE")
    if sess["received"] == 0:
        raise HTTPException(status_code=400, detail="EMPTY_FILE")
    job = sess["job"]
    asyncio.create_task(_commit_upload_task(upload_id))
    return {"job_id": job["id"], "status": job["status"]}


@router.get("/meshes/jobs/{job_id}")
async def mesh_job_status(
    job_id: str,
    user: User = Depends(current_active_user),
) -> dict:
    """Poll the background commit: pending|running|done|failed."""
    job = JOBS.get(job_id)
    if job is None or job["user_id"] != user.id:
        raise HTTPException(status_code=404, detail="JOB_NOT_FOUND")
    return {
        "job_id": job_id,
        "status": job["status"],
        "error": job["error"],
        "mesh": job["mesh"],
    }


@router.put("/meshes/{mesh_id}/file")
async def replace_mesh_file(
    mesh_id: str,
    file: UploadFile = File(...),
    user: User = Depends(current_active_user),
    session: AsyncSession = Depends(get_async_session),
) -> dict:
    """Content -> 3D Asset "Upload the GLB file": swap one of the caller's
    meshes to a fresh GLB. The content-addressed bytes are stored once per
    hash; the row's sha256/size/filename are updated and the previous blob
    is GC'd when nothing else references it. Re-uploading identical bytes
    is a no-op."""
    stmt = select(Mesh).where(Mesh.id == mesh_id, Mesh.user_id == user.id)
    mesh = (await session.execute(stmt)).scalar_one_or_none()
    if mesh is None:
        raise HTTPException(status_code=404, detail="MESH_NOT_FOUND")
    spool, computed, size = await _spool_upload(file)
    try:
        old_sha = mesh.sha256
        if computed == old_sha:
            return _serialize(mesh)
        _store_blob(spool, computed)
        mesh.sha256 = computed
        mesh.size_bytes = size
        mesh.original_filename = file.filename or ""
        await session.commit()
        await session.refresh(mesh)
        await _maybe_gc_blob(session, old_sha)
        return _serialize(mesh)
    finally:
        spool.close()


@router.put("/meshes/{mesh_id}")
async def update_mesh(
    mesh_id: str,
    body: MeshUpdate,
    user: User = Depends(current_active_user),
    session: AsyncSession = Depends(get_async_session),
) -> dict:
    stmt = select(Mesh).where(Mesh.id == mesh_id, Mesh.user_id == user.id)
    mesh = (await session.execute(stmt)).scalar_one_or_none()
    if mesh is None:
        raise HTTPException(status_code=404, detail="MESH_NOT_FOUND")
    mesh.name = body.name
    if body.description is not None:
        mesh.description = body.description
    if body.animation_script is not None:
        mesh.animation_script = body.animation_script
    if body.visibility is not None:
        mesh.visibility = body.visibility
    if body.category is not None:
        mesh.category = body.category
    await session.commit()
    await session.refresh(mesh)
    return _serialize(mesh)


# ── GLB JSON metadata digest (classification hint) ──────────────────────────
# A GLB is: a 12-byte header (magic 'glTF', version 2, total length) followed
# by chunks (length, type, data); the first chunk is the glTF JSON document
# (type 'JSON'). That JSON carries node/mesh/material/animation names and the
# generator tool — strong evidence of the asset's real subject, which a terse
# filename rarely is. Only the leading JSON chunk is read and the digest is
# capped, so even a huge asset costs a bounded read.

_GLB_JSON_MAX = 2 * 1024 * 1024  # largest JSON chunk parsed in full
_GLB_DIGEST_MAX = 400  # chars of hint text handed to the model
_GLB_MAGIC = 0x46546C67  # 'glTF' (little-endian)
_GLB_CHUNK_JSON = 0x4E4F534A  # 'JSON' (little-endian)


def _gltf_names(data: dict, key: str, limit: int = 12) -> list[str]:
    """First `limit` distinct non-empty names of a glTF array section."""
    seen = []
    items = data.get(key)
    if not isinstance(items, list):
        return seen
    for item in items:
        if not isinstance(item, dict):
            continue
        n = (item.get("name") or "").strip()
        if n and n not in seen:
            seen.append(n[:40])
        if len(seen) >= limit:
            break
    return seen


def _glb_meta_digest(blob: Path) -> str | None:
    """Compact text digest of the glTF JSON chunk of a GLB (generator +
    node/mesh/material/animation names), or None when the file is malformed
    or carries nothing useful. Never raises."""
    try:
        with blob.open("rb") as f:
            header = f.read(12)
            if len(header) < 12:
                return None
            magic, version, _total = struct.unpack("<III", header)
            if magic != _GLB_MAGIC or version != 2:
                return None
            chunk_header = f.read(8)
            if len(chunk_header) < 8:
                return None
            chunk_len, chunk_type = struct.unpack("<II", chunk_header)
            if chunk_type != _GLB_CHUNK_JSON or chunk_len <= 0:
                return None
            raw = f.read(min(chunk_len, _GLB_JSON_MAX))
    except OSError:
        return None

    parts: list[str] = []
    if chunk_len > _GLB_JSON_MAX:
        # JSON too big to parse whole: scan the capped prefix for name fields.
        names = []
        for m in re.finditer(rb'"name"\s*:\s*"([^"\\]{1,60})"', raw):
            n = m.group(1).decode("utf-8", "replace").strip()
            if n and n not in names:
                names.append(n[:40])
            if len(names) >= 12:
                break
        if names:
            parts.append("names: " + ", ".join(names))
        parts.append("(glTF JSON truncated)")
    else:
        try:
            data = json.loads(raw.decode("utf-8", "replace"))
        except (json.JSONDecodeError, ValueError):
            return None
        if not isinstance(data, dict):
            return None
        gen = ((data.get("asset") or {}).get("generator") or "").strip()[:80]
        if gen:
            parts.append(f"generator={gen}")
        for key, label in (
            ("nodes", "nodes"),
            ("meshes", "meshes"),
            ("materials", "materials"),
            ("animations", "animations"),
        ):
            ns = _gltf_names(data, key)
            if ns:
                parts.append(f"{label}: {', '.join(ns)}")
        exts = sorted(
            k for k in (data.get("extensions") or {}) if isinstance(k, str)
        )[:6]
        if exts:
            parts.append("extensions: " + ", ".join(exts))
        counts = []
        for key in ("nodes", "meshes", "materials", "textures", "animations"):
            v = data.get(key)
            if isinstance(v, list) and v:
                counts.append(f"{len(v)} {key}")
        if counts:
            parts.append("(" + ", ".join(counts) + ")")
    digest = "; ".join(parts)[:_GLB_DIGEST_MAX]
    return digest or None


@router.post("/meshes/{mesh_id}/classify")
async def classify_mesh(
    mesh_id: str,
    user: User = Depends(current_active_user),
    session: AsyncSession = Depends(get_async_session),
) -> dict:
    """Auto-classify one of the caller's meshes into a Public Component
    category (Bailian one-shot call over the asset's metadata PLUS the names
    extracted from the GLB's glTF JSON chunk). The suggestion is persisted on
    the row; when the model cannot decide (or the engine is down) the row
    keeps its current category and the owner picks one manually."""
    stmt = select(Mesh).where(Mesh.id == mesh_id, Mesh.user_id == user.id)
    mesh = (await session.execute(stmt)).scalar_one_or_none()
    if mesh is None:
        raise HTTPException(status_code=404, detail="MESH_NOT_FOUND")
    digest = None
    blob = _blob_path(mesh.sha256)
    if blob.is_file():
        digest = _glb_meta_digest(blob)
    category = await classify_asset(
        mesh.name, mesh.description or "", mesh.original_filename or "", digest
    )
    if category:
        mesh.category = category
        await session.commit()
        await session.refresh(mesh)
    return _serialize(mesh)


@router.get("/meshes/{mesh_id}/file")
async def get_mesh_file(
    mesh_id: str,
    user: User = Depends(current_active_user),
    session: AsyncSession = Depends(get_async_session),
) -> FileResponse:
    """Serve the GLB of one of the caller's meshes (the Download button and
    the in-card 3D viewer both fetch through here). The content-addressed
    blob is NOT consumed — other mesh rows may reference the same bytes."""
    stmt = select(Mesh).where(Mesh.id == mesh_id, Mesh.user_id == user.id)
    mesh = (await session.execute(stmt)).scalar_one_or_none()
    if mesh is None:
        raise HTTPException(status_code=404, detail="MESH_NOT_FOUND")
    blob = _blob_path(mesh.sha256)
    if not blob.is_file():
        raise HTTPException(status_code=404, detail="NO_GLB")
    stem = "".join(
        c for c in (mesh.name or mesh.id) if c not in '\\/:*?"<>|'
    ).strip()
    filename = f"{stem or mesh.id}.glb"
    return FileResponse(blob, media_type="model/gltf-binary", filename=filename)


@router.delete("/meshes/{mesh_id}", status_code=204)
async def delete_mesh(
    mesh_id: str,
    user: User = Depends(current_active_user),
    session: AsyncSession = Depends(get_async_session),
) -> None:
    """Retire the caller's catalog row. The physical blob is unlinked only
    when no remaining row references its sha256 (refcount GC, best-effort)."""
    stmt = select(Mesh).where(Mesh.id == mesh_id, Mesh.user_id == user.id)
    mesh = (await session.execute(stmt)).scalar_one_or_none()
    if mesh is None:
        raise HTTPException(status_code=404, detail="MESH_NOT_FOUND")
    sha = mesh.sha256
    await session.delete(mesh)
    await session.commit()
    await _maybe_gc_blob(session, sha)
