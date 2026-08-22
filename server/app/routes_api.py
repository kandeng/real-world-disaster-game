"""Per-user saved flight routes (Content -> Route).

GET /api/routes        -> the caller's routes, most recent first. A brand
                          new account is seeded with a few demo routes on
                          Stanford campus so the list is never empty.
POST /api/routes       -> save a new route (the Route Planning Video flow,
                          case 1: a brand-new route).
PUT /api/routes/{id}   -> replace a route's waypoint list and/or title
                          (title optional: omitted = kept, which is what
                          the Route Planning Video flow case 2 wants).
                          Also refreshes created_at so Content -> Route
                          shows the fresh Creation Time.

Both require an active user (Bearer JWT), matching the rest of the API.
"""

import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .db import get_async_session
from .models import Route, User
from .users import current_active_user

router = APIRouter(tags=["routes"])


class WaypointIn(BaseModel):
    lat: float
    lng: float
    alt: float = 150.0
    speed: float = 8.0
    camYaw: float = 0.0
    camPitch: float = -90.0
    camRoll: float = 0.0


class RouteUpdate(BaseModel):
    title: str | None = Field(default=None, max_length=200)
    waypoints: list[WaypointIn]


class RouteCreate(BaseModel):
    waypoints: list[WaypointIn]


def _default_title(wp: dict) -> str:
    """Default route title: position of the first waypoint."""
    return f"Route at: ({wp['lat']:.4f}, {wp['lng']:.4f}, {wp['alt']:.4f})"


def _wp(lat: float, lng: float, alt: float = 150.0) -> dict:
    return {
        "lat": lat,
        "lng": lng,
        "alt": alt,
        "speed": 8.0,
        "camYaw": 0.0,
        "camPitch": -90.0,
        "camRoll": 0.0,
    }


def _seed_rows(user_id: uuid.UUID) -> list[Route]:
    """Demo content: three routes over Stanford campus (2-3 waypoints
    each), staggered creation times so the list shows newest-first."""
    now = datetime.now(timezone.utc)
    seeds = [
        # Hoover Tower -> Memorial Church -> Cantor Arts Center
        (
            now - timedelta(days=2),
            [_wp(37.4276, -122.1697), _wp(37.4270, -122.1687), _wp(37.4321, -122.1694)],
        ),
        # Palm Drive -> Main Quad
        (
            now - timedelta(days=13),
            [_wp(37.4292, -122.1697, 120.0), _wp(37.4273, -122.1697, 120.0)],
        ),
        # Stanford Stadium -> Lake Lagunita -> the Dish
        (
            now - timedelta(days=26),
            [_wp(37.4344, -122.1611, 100.0), _wp(37.4222, -122.1735, 100.0), _wp(37.4086, -122.1669, 100.0)],
        ),
    ]
    rows = []
    for created, waypoints in seeds:
        rows.append(
            Route(
                user_id=user_id,
                title=_default_title(waypoints[0]),
                waypoints=waypoints,
                created_at=created,
                updated_at=created,
            )
        )
    return rows


def _serialize(row: Route) -> dict:
    return {
        "id": str(row.id),
        "title": row.title,
        "created_at": row.created_at.isoformat(),
        "waypoints": row.waypoints,
    }


@router.get("/routes")
async def list_routes(
    user: User = Depends(current_active_user),
    session: AsyncSession = Depends(get_async_session),
) -> list[dict]:
    stmt = (
        select(Route)
        .where(Route.user_id == user.id)
        .order_by(Route.created_at.desc())
    )
    rows = list((await session.execute(stmt)).scalars().all())
    if not rows:
        rows = _seed_rows(user.id)
        session.add_all(rows)
        await session.commit()
        for row in rows:
            await session.refresh(row)
        rows.sort(key=lambda r: r.created_at, reverse=True)
    return [_serialize(r) for r in rows]


@router.put("/routes/{route_id}")
async def update_route(
    route_id: uuid.UUID,
    body: RouteUpdate,
    user: User = Depends(current_active_user),
    session: AsyncSession = Depends(get_async_session),
) -> dict:
    stmt = select(Route).where(Route.id == route_id, Route.user_id == user.id)
    row = (await session.execute(stmt)).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="ROUTE_NOT_FOUND")
    if body.title is not None:
        row.title = body.title
    row.waypoints = [w.model_dump() for w in body.waypoints]
    # Update flow (Route Planning case 2): the route in Content -> Route
    # shows the fresh Creation Time. updated_at follows via onupdate.
    row.created_at = datetime.now(timezone.utc)
    await session.commit()
    await session.refresh(row)
    return _serialize(row)


@router.post("/routes", status_code=201)
async def create_route(
    body: RouteCreate,
    user: User = Depends(current_active_user),
    session: AsyncSession = Depends(get_async_session),
) -> dict:
    if not body.waypoints:
        raise HTTPException(status_code=400, detail="WAYPOINTS_REQUIRED")
    wps = [w.model_dump() for w in body.waypoints]
    row = Route(user_id=user.id, title=_default_title(wps[0]), waypoints=wps)
    session.add(row)
    await session.commit()
    await session.refresh(row)
    return _serialize(row)
