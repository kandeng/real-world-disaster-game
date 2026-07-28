"""SQLAlchemy models: User (with display_name), linked OAuth accounts, and
the per-user settings document.

The OAuthAccount table exists from day one so Google sign-in works now and
Facebook/GitHub/Instagram only need a new httpx-oauth client — no migration.
"""

from datetime import datetime

from fastapi_users.db import SQLAlchemyBaseOAuthAccountTableUUID, SQLAlchemyBaseUserTableUUID
from fastapi_users_db_sqlalchemy.generics import GUID
from sqlalchemy import JSON, DateTime, ForeignKey, String, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base


class OAuthAccount(SQLAlchemyBaseOAuthAccountTableUUID, Base):
    pass


class User(SQLAlchemyBaseUserTableUUID, Base):
    # Pilot display name / callsign; will feed the Matrix display name later.
    display_name: Mapped[str | None] = mapped_column(String(length=100), nullable=True)
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
