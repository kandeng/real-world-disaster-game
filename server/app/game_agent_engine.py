"""Game-agent decision engine — the SERVER half of the slow clock.

The browser's per-session *agent worker* (the slow clock) observes the
deterministic core worker's state snapshots and asks this engine what an
autonomous agent should do next; this engine returns an *intent* — an ordinary
protocol command that the core worker validates, clamps, gates and applies at
its next tick commit. The model never mutates simulation state directly; it
only proposes intents.

The engine is DOMAIN-AGNOSTIC. It names no game: a *package* declares, per
archetype, the whitelist of actions that archetype may emit (as JSON-schema
"tools"), an optional persona and an optional default mode. The engine builds
the prompt from those tools, validates the model's answer against the package
whitelist, and returns an ordinary intent. An archetype with no declared
actions simply holds — the engine never invents domain behaviour.

Policies, selected per call (``mode``) with a server default (``ENGINE_MODE``):

* ``llm`` — one-shot structured call to the Bailian OpenAI-compatible gateway
  (same creds/model as chat_engine), ``temperature: 0``, reply parsed as a
  single JSON intent and whitelist-validated. Never raises into the HTTP layer.
* ``vlm`` — the same call with an image (data URL) attached, routed to the
  vision-language model, for agents whose reasoning consumes a screenshot.
* ``auto`` (default) — run the ladder vlm (if an image) -> llm -> hold,
  degrading gracefully on any failure or empty/unparseable answer.

Intent contract (returned to the agent worker)::

    {
      "intent": {"type": "<action>", ...its parameters} | null,
      "policy": "llm" | "vlm" | "hold",
      "rationale": "<short human-readable reason>",
      "archetype": "<name>", "agentId": "<id>", "session": "<beat key>"
    }

``intent: null`` means "no action this beat". All secrets come from the
gitignored server/config.json. Nothing here ever raises into the HTTP layer.
"""

import asyncio
import json
import logging
import re
import threading
import time

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

# A vision-language model for agents whose reasoning consumes a screenshot
# (data URL). Defaults to the text model; set game_agent.vlm_model to a
# multimodal id (e.g. a qwen-vl variant) to enable image understanding.
VLM_MODEL = _AGENT_CFG.get("vlm_model") or MODEL

# Default slow-agent policy ladder when a decide call names no mode:
#   auto -> vlm (if image) -> llm -> hold. A dev server can override it via
#   GAME_AGENT_MODE without touching the gitignored config.json.
ENGINE_MODE = (_AGENT_CFG.get("engine") or "auto").strip().lower()

# A session idle longer than this is garbage-collected. The browser best-effort
# closes on stop, but a closed tab / crash / dropped network must not leak a
# model-side session forever.
SESSION_TTL_S = float(_AGENT_CFG.get("session_ttl_s", 900.0))

# The LLM gateway is rate-limited; a semaphore keeps a burst of agents from
# stampeding it. The hold path never touches the semaphore.
_llm_sem = asyncio.Semaphore(int(_AGENT_CFG.get("llm_concurrency", 2)))


# ─── geometry helper ────────────────────────────────────────────────────────

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


# ─── session registry + garbage collector ───────────────────────────────────

# session id -> { session, asset, opened_at, last_seen, beats, intents }
_sessions: dict[str, dict] = {}
_sessions_lock = threading.Lock()


def _anon_session() -> str:
    return f"anon-{int(time.time() * 1000):x}"


def open_session(session: str = "", asset: str = "") -> dict:
    """Register (or revive) a session. Sweeps idle sessions first."""
    session = session or _anon_session()
    now = time.time()
    with _sessions_lock:
        _sweep_idle_locked(now)
        rec = _sessions.get(session)
        if rec is None:
            rec = {"session": session, "asset": asset or "",
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


# ─── generic, domain-agnostic decide ────────────────────────────────────────
#
# The engine names NO domain: the package declares, per archetype, the
# whitelist of actions it may emit (as JSON-schema "tools"), an optional
# persona, and an optional default mode. The engine builds the prompt from
# those tools, validates/clamps/gates the model's answer against the package
# whitelist, and returns an ordinary intent. A package with no remote policy
# simply gets the generic baseline (hold) — the engine never invents domain
# behaviour.

# archetype -> { archetype, actions, whitelist, persona, mode }
_archetypes: dict[str, dict] = {}
_archetypes_lock = threading.Lock()


def _norm_actions(actions) -> list[dict]:
    """Coerce a package tool list into [{name, description, parameters}]."""
    out: list[dict] = []
    for a in actions or []:
        if not isinstance(a, dict):
            continue
        name = a.get("name")
        if not isinstance(name, str) or not name:
            continue
        out.append({
            "name": name,
            "description": str(a.get("description") or ""),
            "parameters": a.get("parameters") if isinstance(a.get("parameters"), dict) else {},
        })
    return out


def register_archetype(spec: dict) -> dict:
    """Register (or replace) a package-declared archetype policy spec.

    This is how the whitelist is "sourced from the package": the client uploads
    the archetype's tools once (or inline per decide call) and the engine only
    ever emits actions from that set. Returns a summary (never raises).
    """
    if not isinstance(spec, dict):
        return {}
    name = str(spec.get("archetype") or "").strip()
    if not name:
        return {}
    actions = _norm_actions(spec.get("actions"))
    rec = {
        "archetype": name,
        "actions": actions,
        "whitelist": frozenset(a["name"] for a in actions),
        "persona": str(spec.get("persona") or ""),
        "mode": str(spec.get("mode") or "").strip().lower(),
    }
    with _archetypes_lock:
        _archetypes[name] = rec
    return {"archetype": name, "actions": sorted(rec["whitelist"]), "mode": rec["mode"]}


def list_archetypes() -> list[dict]:
    with _archetypes_lock:
        return [{"archetype": r["archetype"], "actions": sorted(r["whitelist"]),
                 "mode": r["mode"]} for r in _archetypes.values()]


def _spec_for(archetype: str, inline: dict | None = None) -> dict:
    """Resolve the policy spec for an archetype: an inline spec (per-call)
    wins, else the registered one, else an empty generic spec (hold-only)."""
    if isinstance(inline, dict) and inline.get("actions"):
        actions = _norm_actions(inline.get("actions"))
        return {
            "archetype": str(archetype or inline.get("archetype") or ""),
            "actions": actions,
            "whitelist": frozenset(a["name"] for a in actions),
            "persona": str(inline.get("persona") or ""),
            "mode": str(inline.get("mode") or "").strip().lower(),
        }
    with _archetypes_lock:
        rec = _archetypes.get(archetype)
    if rec:
        return rec
    return {"archetype": str(archetype or ""), "actions": [],
            "whitelist": frozenset(), "persona": "", "mode": ""}


def _generic_system(spec: dict) -> str:
    """Build a domain-agnostic system prompt from the package's tool schemas."""
    lines = ["You are an autonomous agent inside a simulation. Propose EXACTLY ONE action per turn."]
    persona = (spec or {}).get("persona")
    if persona:
        lines += ["", persona]
    lines += ["", "Available actions:"]
    actions = (spec or {}).get("actions") or []
    if not actions:
        lines.append("- (none declared; you may only hold)")
    for a in actions:
        fields = json.dumps(a.get("parameters") or {}, separators=(",", ":"))
        lines.append(f"- {a['name']}: {a.get('description') or ''} Parameters: {fields}")
    lines += [
        "",
        "Rules:",
        "1. Reply with ONLY a compact JSON object. No prose, no markdown, no code fences.",
        '2. To act: {"action":"<name>", ...its parameters}',
        '3. To hold (nothing useful to do): {"action":"none"}',
        "4. Any lon/lat MUST lie inside the bounds given in the observation.",
        "5. Emit exactly one action.",
    ]
    return "\n".join(lines)


def _generic_user(observation: dict) -> str:
    """A bounded JSON digest of the (opaque) observation for the model."""
    try:
        blob = json.dumps(observation, separators=(",", ":"), default=str)
    except Exception:  # noqa: BLE001 — never break the beat
        blob = "{}"
    if len(blob) > 4000:
        blob = blob[:4000]
    return "Observation (JSON):\n" + blob + "\n\nReturn the JSON action now."


def _validate_generic(obj: dict, spec: dict, observation: dict, policy: str) -> dict | None:
    """Whitelist + clamp + gate a model answer into a safe intent (or None)."""
    if not isinstance(obj, dict):
        return None
    action = obj.get("action")
    if action == "none":
        return {"intent": None, "policy": policy, "rationale": "model chose to hold"}
    wl = (spec or {}).get("whitelist") or frozenset()
    if not isinstance(action, str) or action not in wl:
        return None
    bounds = observation.get("bounds") if isinstance(observation, dict) else None
    intent: dict = {"type": action}
    for k, v in obj.items():
        if k in ("action", "rationale"):
            continue
        if isinstance(v, (str, int, float, bool)) or v is None:
            intent[k] = v
    if isinstance(intent.get("lon"), (int, float)) and isinstance(intent.get("lat"), (int, float)):
        if not (-180 <= intent["lon"] <= 180 and -90 <= intent["lat"] <= 90):
            return None
        lon, lat = _clamp_bounds(float(intent["lon"]), float(intent["lat"]), bounds)
        intent["lon"] = round(lon, 6)
        intent["lat"] = round(lat, 6)
    return {"intent": intent, "policy": policy,
            "rationale": str(obj.get("rationale") or f"model {action}")[:200]}


def _extract_json(text: str) -> dict | None:
    if not text:
        return None
    m = re.search(r"\{.*\}", text, re.DOTALL)
    if not m:
        return None
    try:
        obj = json.loads(m.group(0))
    except json.JSONDecodeError:
        return None
    return obj if isinstance(obj, dict) else None


async def _llm_generic(observation: dict, spec: dict, image: str | None = None,
                       policy: str = "llm") -> dict | None:
    """One generic Bailian call (text, or multimodal when `image` is a data
    URL) -> a whitelisted intent, or None on any failure."""
    if not API_KEY:
        log.info("game_agent generic: no api key configured; skipping")
        return None
    user_text = _generic_user(observation)
    if image:
        user_content = [
            {"type": "text", "text": user_text},
            {"type": "image_url", "image_url": {"url": image}},
        ]
        model = VLM_MODEL
    else:
        user_content = user_text
        model = MODEL
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": _generic_system(spec)},
            {"role": "user", "content": user_content},
        ],
        "stream": False,
        "max_tokens": MAX_TOKENS,
        "temperature": 0,
    }
    headers = {"Authorization": f"Bearer {API_KEY}"}
    try:
        async with _llm_sem:
            async with httpx.AsyncClient(timeout=httpx.Timeout(30.0, connect=8.0)) as client:
                res = await client.post(f"{BASE_URL}/chat/completions", json=payload, headers=headers)
        if res.status_code != 200:
            log.warning("game_agent generic: http %s: %s", res.status_code, res.text[:200])
            return None
        text = (res.json()["choices"][0]["message"].get("content") or "").strip()
    except Exception as exc:  # noqa: BLE001 — never break the beat
        log.warning("game_agent generic call failed: %r", exc)
        return None
    return _validate_generic(_extract_json(text) or {}, spec, observation, policy)


async def decide(
    observation: dict,
    archetype: str = "",
    agent_id: str = "",
    mode: str | None = None,
    session: str = "",
    image: str | None = None,
    spec: dict | None = None,
) -> dict:
    """Generic slow-agent decision. Never raises.

    The engine names no domain: `archetype` selects a package-registered policy
    (whitelist + persona + tools); `spec` may carry the same inline. `agent_id`
    keys a per-agent session (game::<session>::<agentId>). `image` is an
    optional data URL that enables the vision-language route.

    Ladder: vlm (if image) -> llm -> hold. `auto` runs the full ladder;
    an explicit mode stops at its own rung with a safe hold on failure.
    """
    resolved = _spec_for(archetype, spec if isinstance(spec, dict) else None)
    mode = (mode or resolved.get("mode") or ENGINE_MODE or "auto").strip().lower()
    observation = observation if isinstance(observation, dict) else {}
    beat_session = f"{session or 'anon'}::{agent_id or 'solo'}"

    async def _finish(result: dict) -> dict:
        record_beat(session, acted=bool(result.get("intent")))
        result.setdefault("archetype", archetype)
        result.setdefault("agentId", agent_id)
        result.setdefault("session", beat_session)
        return result

    # No declared actions -> nothing remote can safely emit; generic hold.
    if not resolved.get("whitelist"):
        return await _finish({"intent": None, "policy": "hold",
                              "rationale": "no package-declared actions for archetype; holding"})

    if image and mode in ("vlm", "auto"):
        r = await _llm_generic(observation, resolved, image=image, policy="vlm")
        if r is not None:
            return await _finish(r)
        if mode == "vlm":
            return await _finish({"intent": None, "policy": "vlm", "rationale": "no valid vlm intent"})

    if mode in ("llm", "vlm", "auto"):
        r = await _llm_generic(observation, resolved, image=image, policy="llm")
        if r is not None:
            return await _finish(r)
        if mode in ("llm", "vlm"):
            return await _finish({"intent": None, "policy": mode, "rationale": "no valid model intent"})

    return await _finish({"intent": None, "policy": "hold",
                          "rationale": "no remote intent this beat; holding"})
