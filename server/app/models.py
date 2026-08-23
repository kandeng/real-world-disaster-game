"""SQLAlchemy models: User (with display_name), linked OAuth accounts, the
per-user settings document, and the hidden Synapse Matrix account mapping.

The OAuthAccount table exists from day one so Google sign-in works now and
Facebook/GitHub/Instagram only need a new httpx-oauth client — no migration.
"""

from datetime import datetime

import uuid

from fastapi_users.db import SQLAlchemyBaseOAuthAccountTableUUID, SQLAlchemyBaseUserTableUUID
from fastapi_users_db_sqlalchemy.generics import GUID
from sqlalchemy import JSON, DateTime, ForeignKey, String, Text, func, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base


class OAuthAccount(SQLAlchemyBaseOAuthAccountTableUUID, Base):
    pass


class User(SQLAlchemyBaseUserTableUUID, Base):
    # Pilot display name / callsign; will feed the Matrix display name later.
    display_name: Mapped[str | None] = mapped_column(String(length=100), nullable=True)
    # Email activation via 6-digit secret code (see app/verification.py).
    # The code is stored as a SHA-256 hash with a short expiry; a successful
    # verification flips is_verified and clears both columns.
    verification_code_hash: Mapped[str | None] = mapped_column(String(length=128), nullable=True)
    verification_code_expires: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # Profile picture as a data-URI (the SPA downscales to 128x128 before
    # upload, so this stays small); NULL means "use the default icon".
    avatar: Mapped[str | None] = mapped_column(Text, nullable=True)
    oauth_accounts: Mapped[list[OAuthAccount]] = relationship("OAuthAccount", lazy="joined")


class UserSettings(Base):
    """One settings document per user (option A: single-row JSONB).

    Mirrors oauth_account's relationship pattern — separate table, FK to
    user.id, ON DELETE CASCADE — so fastapi-users' own tables stay pristine
    and deleting a user wipes their preferences. JSONB on PostgreSQL, plain
    JSON under local SQLite dev; user_id uses fastapi-users' cross-dialect
    GUID so the FK type always matches user.id.
    """

    __tablename__ = "user_settings"

    user_id: Mapped[GUID] = mapped_column(
        GUID,
        ForeignKey("user.id", ondelete="CASCADE"),
        primary_key=True,
    )
    settings: Mapped[dict] = mapped_column(
        JSONB().with_variant(JSON, "sqlite"),
        nullable=False,
        default=dict,
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )


class MatrixAccount(Base):
    """Maps a fastapi-users User to their hidden Synapse account.

    The Matrix account is provisioned automatically (register hook / lazy
    ensure on token brokering) and is invisible to the user — one website
    account, chat included. Same relationship pattern as oauth_account /
    user_settings: separate table, FK to user.id, ON DELETE CASCADE.
    """

    __tablename__ = "matrix_account"

    user_id: Mapped[GUID] = mapped_column(
        GUID,
        ForeignKey("user.id", ondelete="CASCADE"),
        primary_key=True,
    )
    mxid: Mapped[str] = mapped_column(String(length=255), nullable=False, unique=True, index=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )


class Route(Base):
    """A saved flight route (Content -> Route): an editable title plus an
    ordered waypoint list (lat/lng/alt/speed/camera angles) as a JSON
    document. Same relationship pattern as user_settings: separate table,
    FK to user.id, ON DELETE CASCADE. JSONB on PostgreSQL, plain JSON under
    local SQLite dev.
    """

    __tablename__ = "route"

    id: Mapped[uuid.UUID] = mapped_column(GUID, primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        GUID,
        ForeignKey("user.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    title: Mapped[str] = mapped_column(String(length=200), nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False, default="")
    waypoints: Mapped[list] = mapped_column(
        JSONB().with_variant(JSON, "sqlite"),
        nullable=False,
        default=list,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )


class Video(Base):
    """A published flight video (Content -> Video). Minted from a route:
    title and waypoints are copied once at creation and then diverge
    independently (the waypoints stay a frozen snapshot). route_id is
    provenance only — deleting the route keeps the video (SET NULL),
    deleting the author removes it (CASCADE), same as route.
    """

    __tablename__ = "video"

    id: Mapped[uuid.UUID] = mapped_column(GUID, primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        GUID,
        ForeignKey("user.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    route_id: Mapped[uuid.UUID | None] = mapped_column(
        GUID,
        ForeignKey("route.id", ondelete="SET NULL"),
        nullable=True,
    )
    title: Mapped[str] = mapped_column(String(length=200), nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False, default="")
    waypoints: Mapped[list] = mapped_column(
        JSONB().with_variant(JSON, "sqlite"),
        nullable=False,
        default=list,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )


class VideoSource(Base):
    """One playback URL of a video (YouTube primary, Bilibili second,
    future providers freely added). position 0 is the primary source;
    one row per provider per video.
    """

    __tablename__ = "video_source"
    __table_args__ = (
        UniqueConstraint("video_id", "provider", name="uq_video_source_provider"),
    )

    id: Mapped[uuid.UUID] = mapped_column(GUID, primary_key=True, default=uuid.uuid4)
    video_id: Mapped[uuid.UUID] = mapped_column(
        GUID,
        ForeignKey("video.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    provider: Mapped[str] = mapped_column(String(length=32), nullable=False)
    url: Mapped[str] = mapped_column(Text, nullable=False)
    position: Mapped[int] = mapped_column(nullable=False, default=0)
