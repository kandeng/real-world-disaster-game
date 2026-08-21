"""Email activation via a 6-digit secret code.

Flow:
  * ``POST /api/auth/code/request {email}`` — generates a 6-digit code,
    stores its SHA-256 hash + 10-minute expiry on the user row, and emails
    the plain code. Always 202 so account existence is never leaked (except
    the 429 resend-cooldown, which only fires for a recently-requested,
    still-unverified account).
  * ``POST /api/auth/code/verify {email, code}`` — on a matching, unexpired
    code flips ``is_verified`` (account activated) and consumes the code.

Login is gated separately by ``requires_verification=True`` on the auth
router, so an unverified account can never obtain a JWT.
"""

import hashlib
import logging
import secrets
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, EmailStr
from sqlalchemy import select

from .db import async_session_maker
from .email import send_verification_code
from .models import User

log = logging.getLogger("drone-api.verification")

router = APIRouter()

CODE_TTL = timedelta(minutes=10)
RESEND_COOLDOWN = timedelta(seconds=60)


def _hash_code(code: str) -> str:
    return hashlib.sha256(code.encode("utf-8")).hexdigest()


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _as_utc(dt: datetime) -> datetime:
    """SQLite hands back naive datetimes; Postgres TIMESTAMPTZ aware ones."""
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


async def create_verification_code(user_id) -> str:
    """Generate, persist (hashed) and return a fresh 6-digit code."""
    code = f"{secrets.randbelow(1_000_000):06d}"
    async with async_session_maker() as session:
        user = await session.get(User, user_id)
        if user is None:
            raise ValueError("user vanished while issuing verification code")
        user.verification_code_hash = _hash_code(code)
        user.verification_code_expires = _now() + CODE_TTL
        await session.commit()
    return code


async def issue_and_email_code(user: User) -> None:
    code = await create_verification_code(user.id)
    await send_verification_code(user.email, code)


class CodeRequest(BaseModel):
    email: EmailStr


class CodeVerify(BaseModel):
    email: EmailStr
    code: str


@router.post("/request", status_code=status.HTTP_202_ACCEPTED)
async def request_code(body: CodeRequest):
    email = body.email.strip().lower()
    async with async_session_maker() as session:
        user = (
            await session.execute(select(User).where(User.email == email))
        ).unique().scalar_one_or_none()
        if user is None or user.is_verified:
            # Silent success — never reveal whether the account exists.
            return {"ok": True}
        if user.verification_code_expires is not None:
            created_at = _as_utc(user.verification_code_expires) - CODE_TTL
            if _now() - created_at < RESEND_COOLDOWN:
                raise HTTPException(
                    status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                    detail="code_too_soon",
                )
    await issue_and_email_code(user)
    log.info("verification code emailed to %s", email)
    return {"ok": True}


@router.post("/verify")
async def verify_code(body: CodeVerify):
    email = body.email.strip().lower()
    code = body.code.strip()
    async with async_session_maker() as session:
        user = (
            await session.execute(select(User).where(User.email == email))
        ).unique().scalar_one_or_none()
        ok = False
        if user is not None and not user.is_verified:
            unexpired = (
                user.verification_code_expires is not None
                and _as_utc(user.verification_code_expires) > _now()
            )
            matches = (
                user.verification_code_hash is not None
                and secrets.compare_digest(user.verification_code_hash, _hash_code(code))
            )
            ok = bool(unexpired and matches)
            if ok:
                user.is_verified = True
                user.verification_code_hash = None
                user.verification_code_expires = None
                await session.commit()
                log.info("email verified via code: %s", email)
    if not ok:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="code_invalid",
        )
    return {"ok": True}
