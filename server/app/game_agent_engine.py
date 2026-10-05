"""Game-agent decision engine — the SERVER half of the slow clock.

The browser's per-session *agent worker* (the slow clock) observes the
deterministic core worker's state snapshots and asks this engine what to do;
this engine returns an *intent* — an ordinary protocol command (e.g. a water
drop) that the core worker validates and applies at its next tick commit. The
model never mutates simulation state directly; it only proposes intents.

Two policies, selected by ``game_agent.engine`` in config.json:

* ``heuristic`` — pure stdlib, deterministic, OFFLINE. Drops water on the
  burning frontier (with a small wind-lead offset). This is the guaranteed
  baseline and the path exercised by the headless e2e test; it needs no
  network and no model, so localhost testing never depends on a live LLM.
* ``llm`` — one-shot structured call to the Bailian OpenAI-compatible gateway
  (same creds/model as chat_engine), ``temperature: 0``, reply parsed as a
  single JSON intent. Mirrors ``chat_engine.classify_asset``: single-shot,
  whitelist-validated, never raises into the HTTP layer.
* ``auto`` (default) — try ``llm``, fall back to ``heuristic`` on any failure
  or empty/unparseable answer.

Intent contract (returned to the agent worker)::

    {
      "intent": {"type": "dropWater", "lon": <num>, "lat": <num>,
                  "radiusM": <num>} | null,
      "policy": "heuristic" | "llm",
      "rationale": "<short human-readable reason>"
    }

``intent: null`` means "no action this beat" (fire out, session lost, or the
model chose to hold). All secrets come from the gitignored server/config.json.
"""

import asyncio
import json
import logging
import math
import re
import threading
import time
from pathlib import Path

import httpx

from .config import CONFIG

log = logging.getLogger(__name__)

_CHAT_CFG = CONFIG.get("chat", {})
_AGENT_CFG = CONFIG.get("game_agent", {})

# LLM route (shared with the customer-service chat engine).
MODEL = _AGENT_CFG.get("model") or _CHAT_CFG.get("model", "DeepSeek-V4-Flash")
BASE_URL = (
    _AGENT_CFG.get("bailian_base_url")
    or _CHAT_CFG.get(
        "bailian_base_url", "https://dashscope.aliyuncs.com/compatible-mode/v1"
    )
).rstrip("/")
API_KEY = _AGENT_CFG.get("api_key") or _CHAT_CFG.get("api_key", "")
MAX_TOKENS = int(_AGENT_CFG.get("max_tokens", 256))

# heuristic | llm | auto  — default heuristic so a fresh localhost server is
# deterministic and offline-safe out of the box.
ENGINE_MODE = (_AGENT_CFG.get("engine") or "heuristic").strip().lower()

# Water-drop capability defaults (the only action the fire asset exposes today).
DEFAULT_DROP_RADIUS_M = int(_AGENT_CFG.get("drop_radius_m", 400))
# metres of downwind lead per (m/s) of wind, capped — intercepts the frontier
# instead of chasing it. Small on purpose: the sim, not this engine, owns fire
# behaviour; the lead only has to be plausible.
WIND_LEAD_S = float(_AGENT_CFG.get("wind_lead_s", 6.0))
MAX_LEAD_M = float(_AGENT_CFG.get("max_lead_m", 350.0))

# ─── DSH counselor config (E4) ────────────────────────────────────────
# Provider/base_url/model/key already resolve game_agent -> chat above. The
# counselor keeps its OWN cordis + session root (isolated from the customer-
# service chat) under the gitignored server/.dsh_sessions/game/.
DSH_PROVIDER = (
    _AGENT_CFG.get("dsh_provider") or _CHAT_CFG.get("dsh_provider") or "bailian"
).strip()
GAME_DSH_ROOT = (
    Path(_AGENT_CFG["dsh_session_root"]).expanduser().resolve()
    if _AGENT_CFG.get("dsh_session_root")
    else Path(__file__).resolve().parent.parent / ".dsh_sessions" / "game"
)
# A session idle longer than this is garbage-collected (facility 7). The
# browser best-effort closes on stop, but a closed tab / crash / dropped
# network must not leak a model-side session forever.
SESSION_TTL_S = float(_AGENT_CFG.get("session_ttl_s", 900.0))

# Whitelist of intents this engine may emit. An LLM answer naming anything
# else is discarded (-> heuristic fallback), so a hallucinated action can
# never reach the simulation.
ALLOWED_ACTIONS = frozenset({"dropWater"})

# One runtime request at a time is unnecessary for the stateless heuristic,
# but the LLM gateway is rate-limited; a semaphore keeps a burst of sessions
# from stampeding it. The heuristic path never touches the semaphore.
_llm_sem = asyncio.Semaphore(int(_AGENT_CFG.get("llm_concurrency", 2)))


# ─── geometry helpers ───────────────────────────────────────────────────────

_DEG_LAT_M = 111_320.0  # metres per degree of latitude (≈ constant)


def _deg_lon_m(lat: float) -> float:
    """Metres per degree of longitude at a given latitude."""
    return _DEG_LAT_M * max(0.2, math.cos(math.radians(lat)))


def _clamp_bounds(lon: float, lat: float, bounds: dict | None) -> tuple[float, float]:
    """Clamp a drop point into the scenario bounds (if provided)."""
    if not bounds:
        return lon, lat
    lo_lon = bounds.get("lonMin")
    hi_lon = bounds.get("lonMax")
    lo_lat = bounds.get("latMin")
    hi_lat = bounds.get("latMax")
    if isinstance(lo_lon, (int, float)) and isinstance(hi_lon, (int, float)):
        lon = min(max(lon, lo_lon), hi_lon)
    if isinstance(lo_lat, (int, float)) and isinstance(hi_lat, (int, float)):
        lat = min(max(lat, lo_lat), hi_lat)
    return lon, lat


# ─── heuristic policy (deterministic, offline) ──────────────────────────────


def _heuristic(observation: dict) -> dict:
    """Drop water on the burning frontier, leading the wind slightly.

    Deterministic: the same observation always yields the same intent, which
    is what makes the headless e2e reproducible without a model.
    """
    phase = observation.get("phase")
    lost = bool(observation.get("lost"))
    hotspot = observation.get("hotspot") or {}
    lon = hotspot.get("lon")
    lat = hotspot.get("lat")

    # Nothing to defend: fire already out, session lost, or no live frontier.
    if lost:
        return {"intent": None, "policy": "heuristic", "rationale": "session lost; holding"}
    if phase != "spreading" or not isinstance(lon, (int, float)) or not isinstance(lat, (int, float)):
        return {"intent": None, "policy": "heuristic",
                "rationale": f"no active frontier (phase={phase}); holding"}

    # Wind-lead: push the drop point downwind so it intercepts spread.
    wind = observation.get("wind") or {}
    to_deg = wind.get("toDeg")
    speed = wind.get("speedMps") or 0
    lead_lon, lead_lat = lon, lat
    if isinstance(to_deg, (int, float)) and isinstance(speed, (int, float)) and speed > 0:
        lead_m = min(MAX_LEAD_M, speed * WIND_LEAD_S)
        # meteorological "to" bearing: 0=N, 90=E; convert to a lon/lat offset.
        rad = math.radians(to_deg)
        d_north = lead_m * math.cos(rad)
        d_east = lead_m * math.sin(rad)
        lead_lat = lat + d_north / _DEG_LAT_M
        lead_lon = lon + d_east / _deg_lon_m(lat)

    lead_lon, lead_lat = _clamp_bounds(lead_lon, lead_lat, observation.get("bounds"))
    return {
        "intent": {
            "type": "dropWater",
            "lon": round(lead_lon, 6),
            "lat": round(lead_lat, 6),
            "radiusM": DEFAULT_DROP_RADIUS_M,
        },
        "policy": "heuristic",
        "rationale": (
            f"drop on frontier ({lon:.5f},{lat:.5f}) leading wind "
            f"{to_deg if isinstance(to_deg, (int, float)) else '?'}deg @ {speed}m/s"
        ),
    }


# ─── LLM policy (Bailian, single-shot structured) ───────────────────────────

_LLM_SYSTEM = """You are the fire-operations AI advisor in a wildfire defence simulation.
You observe the fire state and propose EXACTLY ONE action per turn.

Available action:
- dropWater: drop a water retardant circle. Fields: lon, lat (WGS84 degrees), radiusM (metres).

Rules:
1. Reply with ONLY a compact JSON object. No prose, no markdown, no code fences.
2. To act: {"action":"dropWater","lon":<num>,"lat":<num>,"radiusM":<num>}
3. To hold (fire out, or no useful drop): {"action":"none"}
4. lon/lat MUST lie inside the scenario bounds given in the observation.
5. Aim at the burning frontier (the hotspot), leading the wind slightly to intercept spread.
"""


def _llm_user_prompt(observation: dict) -> str:
    """Compact, bounded observation digest for the model."""
    hotspot = observation.get("hotspot") or {}
    wind = observation.get("wind") or {}
    counts = observation.get("counts") or {}
    bounds = observation.get("bounds") or {}
    lines = [
        f"phase: {observation.get('phase')}",
        f"simTime_s: {round(observation.get('time', 0) or 0, 1)}",
        f"occupyFrac: {round(observation.get('occupyFrac', 0) or 0, 4)}",
        f"pendingIgnitions: {observation.get('pending', 0)}",
        f"lost: {bool(observation.get('lost'))}",
        f"cells burning/ash/wet/unburned: {counts.get('burning', 0)}/{counts.get('ash', 0)}/"
        f"{counts.get('wet', 0)}/{counts.get('unburned', 0)}",
        f"wind toDeg/speedMps: {wind.get('toDeg')}/{wind.get('speedMps')}",
        f"hotspot lon/lat: {hotspot.get('lon')}/{hotspot.get('lat')}",
        f"bounds lonMin/latMin/lonMax/latMax: {bounds.get('lonMin')}/{bounds.get('latMin')}/"
        f"{bounds.get('lonMax')}/{bounds.get('latMax')}",
        f"default drop radiusM: {DEFAULT_DROP_RADIUS_M}",
    ]
    return "Observation:\n" + "\n".join(lines) + "\n\nReturn the JSON action now."


def _parse_llm_intent(text: str, observation: dict) -> dict | None:
    """Extract + validate a single JSON intent from the model's answer.

    Returns None if the answer holds no usable whitelisted action, so the
    caller can fall back to the heuristic. Never trusts the model's numbers
    blindly: action is whitelisted, lon/lat are range-checked and clamped.
    """
    if not text:
        return None
    # Pull the first {...} block; models sometimes wrap or pad despite instructions.
    m = re.search(r"\{.*\}", text, re.DOTALL)
    if not m:
        return None
    try:
        obj = json.loads(m.group(0))
    except json.JSONDecodeError:
        return None
    if not isinstance(obj, dict):
        return None
    action = obj.get("action")
    if action == "none":
        return {"intent": None, "policy": "llm", "rationale": "model chose to hold"}
    if action not in ALLOWED_ACTIONS:
        return None
    lon = obj.get("lon")
    lat = obj.get("lat")
    if not isinstance(lon, (int, float)) or not isinstance(lat, (int, float)):
        return None
    if not (-180 <= lon <= 180 and -90 <= lat <= 90):
        return None
    radius = obj.get("radiusM")
    if not isinstance(radius, (int, float)) or radius <= 0:
        radius = DEFAULT_DROP_RADIUS_M
    lon, lat = _clamp_bounds(float(lon), float(lat), observation.get("bounds"))
    return {
        "intent": {"type": "dropWater", "lon": round(lon, 6), "lat": round(lat, 6),
                   "radiusM": int(min(max(radius, 50), 5000))},
        "policy": "llm",
        "rationale": str(obj.get("rationale") or "model dropWater")[:200],
    }


async def _llm(observation: dict) -> dict | None:
    """One-shot Bailian call -> validated intent, or None on any failure."""
    if not API_KEY:
        log.info("game_agent llm: no api key configured; skipping")
        return None
    payload = {
        "model": MODEL,
        "messages": [
            {"role": "system", "content": _LLM_SYSTEM},
            {"role": "user", "content": _llm_user_prompt(observation)},
        ],
        "stream": False,
        "max_tokens": MAX_TOKENS,
        "temperature": 0,
    }
    headers = {"Authorization": f"Bearer {API_KEY}"}
    try:
        async with _llm_sem:
            async with httpx.AsyncClient(
                timeout=httpx.Timeout(30.0, connect=8.0)
            ) as client:
                res = await client.post(
                    f"{BASE_URL}/chat/completions", json=payload, headers=headers
                )
        if res.status_code != 200:
            log.warning("game_agent llm: http %s: %s", res.status_code, res.text[:200])
            return None
        text = (res.json()["choices"][0]["message"].get("content") or "").strip()
    except Exception as exc:  # noqa: BLE001 — never break the beat; fall back
        log.warning("game_agent llm call failed: %r", exc)
        return None
    intent = _parse_llm_intent(text, observation)
    if intent is None:
        log.info("game_agent llm: answer %r yielded no valid intent", text[:120])
    return intent


# ─── DSH counselor policy (E4) ──────────────────────────────────────────────
#
# The `llm` policy above is STATELESS: one shot per beat, no memory. The DSH
# counselor is the real slow-clock agent — a persistent, session-keyed harness
# (the deepseek-harness-sdk child process) that keeps model-side conversation
# context across beats, so the advisor remembers what it already tried. It is
# keyed by the browser agent worker's `session` id: one counselor per session.
#
# The SDK is an OPTIONAL dependency (installed on ECS01, absent on a plain
# localhost box). Everything here degrades: no SDK / no key / any failure ->
# None -> the caller falls back to the deterministic heuristic. The tick never
# blocks on it — the agent worker owns the async fetch; the core never awaits.

_DSH_PERSONA = """You are the fire-operations AI counselor in a live wildfire-defence simulation.
You advise once per beat, and you KEEP MEMORY across beats: use it to avoid repeating a drop that did not help and to lead the fire consistently.

Available action:
- dropWater: drop a water retardant circle. Fields: lon, lat (WGS84 degrees), radiusM (metres).

Rules:
1. Reply with ONLY a compact JSON object each beat. No prose, no markdown, no code fences.
2. To act: {"action":"dropWater","lon":<num>,"lat":<num>,"radiusM":<num>}
3. To hold (fire out, session lost, or no useful drop): {"action":"none"}
4. lon/lat MUST lie inside the scenario bounds given in the observation.
5. Aim at the burning frontier (the hotspot), leading the wind slightly to intercept spread.
6. Emit exactly one action per beat.
"""

_game_harness = None
_game_harness_failed = False
# The preview runtime serializes: one harness.run() at a time (as in chat).
_game_dsh_lock = asyncio.Lock()

# session id -> { session, asset, opened_at, last_seen, beats, intents }
_sessions: dict[str, dict] = {}
_sessions_lock = threading.Lock()


def dsh_available() -> bool:
    """True only if the SDK imports AND a key is configured AND it has not
    already hard-failed this process. Cheap enough to call per beat."""
    if not API_KEY or _game_harness_failed:
        return False
    try:
        import deepseek_harness  # noqa: F401  (lazy: optional dependency)
        return True
    except Exception:  # noqa: BLE001 — not installed -> counselor unavailable
        return False


def _ensure_game_cordis() -> Path:
    """Render the counselor's cordis, REUSING chat_engine's proven Bailian
    route template so the load-bearing provider block (pi-ai adapter,
    thinkingFormat:qwen, supportsDeveloperRole:false) has a single source of
    truth. Only the persona and the session root differ from chat."""
    from . import chat_engine

    path = GAME_DSH_ROOT / "cordis" / "game-fire.yml"
    persona_block = "\n".join("      " + ln for ln in _DSH_PERSONA.splitlines())
    rendered = chat_engine._CORDIS_TEMPLATE.format(
        version=getattr(chat_engine, "_CORDIS_VERSION", 2),
        provider=DSH_PROVIDER,
        base_url=BASE_URL,
        model=MODEL,
        persona_block=persona_block,
        session_root=str(GAME_DSH_ROOT / "sessions"),
    )
    if path.exists() and path.read_text(encoding="utf-8") == rendered:
        return path
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(rendered, encoding="utf-8")
    return path


def _get_game_harness():
    """Lazily create the single game-counselor harness. Blocking work runs in
    the caller's thread (only ever called inside to_thread). Raises if the SDK
    is missing so the caller can fall back to the heuristic."""
    global _game_harness, _game_harness_failed
    if _game_harness is not None:
        return _game_harness
    from deepseek_harness import DeepSeekHarness  # lazy: optional dep

    workspace = GAME_DSH_ROOT / "workspace"
    workspace.mkdir(parents=True, exist_ok=True)
    (GAME_DSH_ROOT / "sessions").mkdir(parents=True, exist_ok=True)
    try:
        _game_harness = DeepSeekHarness(
            provider=DSH_PROVIDER,
            model=MODEL,
            max_tokens=MAX_TOKENS,
            cwd=str(workspace),
            session_root=str(GAME_DSH_ROOT / "sessions"),
            cordis=str(_ensure_game_cordis()),
            # Overlay, not replacement: the SDK copies os.environ first.
            env={"BAILIAN_API_KEY": API_KEY},
        )
    except Exception:  # noqa: BLE001 — mark unavailable, fall back forever
        _game_harness_failed = True
        raise
    return _game_harness


# ─── session registry + garbage collector (facility 7) ──────────────────────

def _anon_session() -> str:
    return f"anon-{int(time.time() * 1000):x}"


def open_session(session: str = "", asset: str = "fire") -> dict:
    """Register (or revive) a counselor session. Sweeps idle sessions first."""
    session = session or _anon_session()
    now = time.time()
    with _sessions_lock:
        _sweep_idle_locked(now)
        rec = _sessions.get(session)
        if rec is None:
            rec = {"session": session, "asset": asset or "fire",
                   "opened_at": now, "last_seen": now, "beats": 0, "intents": 0}
            _sessions[session] = rec
        else:
            rec["last_seen"] = now
            rec["asset"] = asset or rec["asset"]
        return dict(rec)


def close_session(session: str) -> bool:
    with _sessions_lock:
        return _sessions.pop(session, None) is not None


def record_beat(session: str, acted: bool = False) -> None:
    """Count one decide beat (and refresh last_seen) for a live session."""
    if not session:
        return
    with _sessions_lock:
        rec = _sessions.get(session)
        if rec:
            rec["beats"] += 1
            rec["last_seen"] = time.time()
            if acted:
                rec["intents"] += 1


def list_sessions() -> list[dict]:
    with _sessions_lock:
        _sweep_idle_locked(time.time())
        return [dict(r) for r in _sessions.values()]


def sweep_idle(now: float | None = None) -> int:
    """Public GC entry: drop sessions idle longer than SESSION_TTL_S."""
    with _sessions_lock:
        return _sweep_idle_locked(now)


def _sweep_idle_locked(now: float | None) -> int:
    now = now if now is not None else time.time()
    stale = [s for s, r in _sessions.items() if now - r["last_seen"] > SESSION_TTL_S]
    for s in stale:
        _sessions.pop(s, None)
    return len(stale)


async def _dsh(observation: dict, session: str) -> dict | None:
    """One counselor beat on the persistent session -> validated intent, or
    None on any failure (the caller falls back)."""
    if not dsh_available():
        return None
    digest = _llm_user_prompt(observation)
    sid = f"game::{session or 'anon'}"

    def _blocking() -> str:
        harness = _get_game_harness()
        result = harness.run(digest, session_id=sid)
        return getattr(result, "final_response", "") or ""

    global _game_harness_failed
    try:
        async with _game_dsh_lock:  # preview runtime serializes
            text = await asyncio.to_thread(_blocking)
    except Exception as exc:  # noqa: BLE001 — never break the beat
        _game_harness_failed = True
        log.warning("game_agent dsh call failed: %r", exc)
        return None
    intent = _parse_llm_intent(text, observation)
    if intent is not None:
        intent["policy"] = "dsh"
        intent["rationale"] = f"[counselor {sid}] {intent.get('rationale', '')}"[:200]
    else:
        log.info("game_agent dsh: answer %r yielded no valid intent", text[:120])
    return intent


# ─── unified entry point ────────────────────────────────────────────────────


async def decide_intent(
    observation: dict, mode: str | None = None, session: str = ""
) -> dict:
    """Return one intent for an observation. Never raises.

    ``mode`` overrides the configured engine for a single call (the dev UI
    uses this to A/B policies without a restart). Ladder:
      heuristic -> deterministic offline baseline;
      llm       -> stateless one-shot Bailian;
      dsh       -> persistent session counselor (E4);
      auto      -> dsh -> llm -> heuristic (graceful degradation).
    """
    mode = (mode or ENGINE_MODE or "heuristic").strip().lower()
    observation = observation if isinstance(observation, dict) else {}

    async def _finish(result: dict) -> dict:
        record_beat(session, acted=bool(result.get("intent")))
        return result

    if mode in ("dsh", "auto"):
        intent = await _dsh(observation, session)
        if intent is not None:
            return await _finish(intent)
        if mode == "dsh":
            # Explicit dsh, counselor unavailable/empty: safe hold, do not
            # silently switch policy (surprising in prod).
            return await _finish(
                {"intent": None, "policy": "dsh",
                 "rationale": "counselor unavailable or no valid intent"}
            )
        # auto: fall through to the one-shot llm, then the baseline.

    if mode in ("llm", "auto"):
        intent = await _llm(observation)
        if intent is not None:
            return await _finish(intent)
        if mode == "llm":
            return await _finish(
                {"intent": None, "policy": "llm", "rationale": "no valid model intent"}
            )

    return await _finish(_heuristic(observation))
