"""FastAPI application entry point.

Run locally:
    cd server && uvicorn app.main:app --reload --port 8000

All routers are mounted under ``/api`` so Caddy can proxy ``/api/*`` without
path rewriting, giving identical URLs in dev and production:

    https://drone-navigation.com/api/auth/jwt/login
    http://localhost:8000/api/auth/jwt/login
"""

import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .chat_api import router as chat_router, sweep_loop as chat_sweep_loop
from .config import CONFIG
from .db import Base, engine
from .drone_commands import router as drone_commands_router
from .matrix_auth import router as matrix_router
from .meshes_api import router as meshes_router
from .schemas import UserCreate, UserRead, UserUpdate
from .settings import router as settings_router
from .stream import router as stream_router
from .telemetry import router as telemetry_router
from .oauth_router import get_resilient_oauth_router
from .routes_api import router as routes_router
from .users import auth_backend, fastapi_users, get_user_manager, google_oauth_client
from .verification import router as verification_router
from .videos_api import router as videos_router

logging.basicConfig(level=logging.INFO)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Create tables on startup (fine for v1; Alembic when the schema evolves).
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    # Hourly customer-service transcript retention sweep (10 days default).
    sweep_task = asyncio.create_task(chat_sweep_loop())
    yield
    sweep_task.cancel()


app = FastAPI(title="Drone Navigation API", lifespan=lifespan)

# Needed for local dev (Vite on :5173 -> API on :8000) AND for production
# visitors on the CDN edge domains: the SPA pins /api/* to the apex origin
# (client/composables/wsUrl.js apiBaseUrl), so www./cdn. pages arrive here
# cross-origin and must be allowlisted in cors_origins.
app.add_middleware(
    CORSMiddleware,
    allow_origins=CONFIG.get("cors_origins", []),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    # Let browsers cache the CORS preflight verdict for a day: preflights
    # from the www./cdn. edge origins otherwise cost an extra ocean RTT.
    max_age=86400,
)

# --- Auth: email + password (JWT) ------------------------------------------
# requires_verification: unverified accounts can never obtain a JWT — login
# only succeeds once the email activation code has been confirmed.
app.include_router(
    fastapi_users.get_auth_router(auth_backend, requires_verification=True),
    prefix="/api/auth/jwt",
    tags=["auth"],
)
app.include_router(
    fastapi_users.get_register_router(UserRead, UserCreate),
    prefix="/api/auth",
    tags=["auth"],
)
app.include_router(
    fastapi_users.get_reset_password_router(),
    prefix="/api/auth",
    tags=["auth"],
)
app.include_router(
    fastapi_users.get_verify_router(UserRead),
    prefix="/api/auth",
    tags=["auth"],
)
app.include_router(
    verification_router,
    prefix="/api/auth/code",
    tags=["auth"],
)

# --- Auth: Google OAuth -----------------------------------------------------
if google_oauth_client.client_id:
    app.include_router(
        get_resilient_oauth_router(
            google_oauth_client,
            auth_backend,
            get_user_manager,
            CONFIG["secret"],
            # Explicit SPA callback page: without this fastapi-users resolves
            # the API endpoint URL via url_for(), which (a) is not registered
            # in the Google Cloud Console and (b) mismatches between the
            # authorize and token-exchange steps -> redirect_uri_mismatch.
            redirect_url=CONFIG["frontend_base_url"].rstrip("/") + "/auth/callback",
            associate_by_email=True,
            is_verified_by_default=True,  # Google emails are pre-verified
        ),
        prefix="/api/auth/google",
        tags=["auth"],
    )

# --- Users ------------------------------------------------------------------
app.include_router(
    fastapi_users.get_users_router(UserRead, UserUpdate),
    prefix="/api/users",
    tags=["users"],
)

# --- Per-user settings document (GET/PUT /api/users/me/settings) ------------
app.include_router(settings_router, prefix="/api")

# --- Per-user saved flight routes (GET /api/routes, PUT /api/routes/{id}) ---
app.include_router(routes_router, prefix="/api")

# --- Per-user published flight videos (GET /api/videos, PUT /api/videos/{id})
app.include_router(videos_router, prefix="/api")

# --- Per-user 3D mesh assets (GET /api/meshes, POST /api/meshes, ...) ------
app.include_router(meshes_router, prefix="/api")

# --- Community chat: Matrix token brokering + user directory ----------------
app.include_router(matrix_router, prefix="/api")

# --- Livestream: MediaMTX runtime config for the SPA (GET /api/stream/config)
app.include_router(stream_router, prefix="/api")

# --- Real drone: telemetry relay (WS /api/drone/telemetry[/publish]) --------
app.include_router(telemetry_router, prefix="/api")

# --- Real drone: flight commands (WS /api/drone/command[/downlink]) ----------
app.include_router(drone_commands_router, prefix="/api")

# --- Customer service chatbot (GET/POST/DELETE /api/chat/*) ------------------
app.include_router(chat_router, prefix="/api")


@app.get("/api/health")
async def health() -> dict:
    return {"status": "ok"}
