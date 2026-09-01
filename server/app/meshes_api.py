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
    PUT    /api/meshes/{id}       -> update name / description / animation_script.
    GET    /api/meshes/{id}/file  -> serve the GLB bytes (owner-scoped). Unlike
                                     the video cache this does NOT consume the
                                     file, because other mesh rows may reference
                                     the same content-addressed blob.
    DELETE /api/meshes/{id}       -> retire the caller's catalog row; the blob is
                                     unlinked only when no remaining row
                                     references its sha256 (refcount GC).

The GLB bytes live once per unique hash at
``server/workspace/meshes/<sha256[:2]>/<sha256>.glb`` (the workspace/ directory
is excluded from the deploy rsync, so files survive backend redeploys).

Ownership is enforced purely at this layer: every statement is scoped by the
JWT caller's id and foreign ids surface as 404 (API-only hardening, per the CMS
schema decision).
"""

import hashlib
import logging
import uuid
from pathlib import Path
from tempfile import SpooledTemporaryFile

import shutil

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from .config import CONFIG
from .db import get_async_session
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


def _serialize(mesh: Mesh) -> dict:
    return {
        "id": mesh.id,
        "sha256": mesh.sha256,
        "name": mesh.name,
        "description": mesh.description,
        "animation_script": mesh.animation_script,
        "visibility": mesh.visibility,
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
            visibility="private",
            size_bytes=size,
            original_filename=file.filename or "",
        )
        session.add(mesh)
        await session.commit()
        await session.refresh(mesh)
        return _serialize(mesh)
    finally:
        spool.close()


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
