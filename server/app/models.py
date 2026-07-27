"""SQLAlchemy models: User (with display_name) and linked OAuth accounts.

The OAuthAccount table exists from day one so Google sign-in works now and
Facebook/GitHub/Instagram only need a new httpx-oauth client — no migration.
"""

from fastapi_users.db import SQLAlchemyBaseOAuthAccountTableUUID, SQLAlchemyBaseUserTableUUID
from sqlalchemy import String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base


class OAuthAccount(SQLAlchemyBaseOAuthAccountTableUUID, Base):
    pass


class User(SQLAlchemyBaseUserTableUUID, Base):
    # Pilot display name / callsign; will feed the Matrix display name later.
    display_name: Mapped[str | None] = mapped_column(String(length=100), nullable=True)
    oauth_accounts: Mapped[list[OAuthAccount]] = relationship("OAuthAccount", lazy="joined")
