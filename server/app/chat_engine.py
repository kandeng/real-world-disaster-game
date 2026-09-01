"""Customer-service AI engines: DeepSeek Harness (primary) with a direct
Alibaba Bailian (OpenAI-compatible) fallback.

Design
------
* ``DshEngine`` drives the official ``deepseek-harness-sdk`` (Python) which
  bundles its own runtime. One long-lived ``DeepSeekHarness`` instance per
  page keeps a page-specific system prompt (persona); one durable session id
  per ``(identity, generation)`` keeps the model-side conversation context.
* ``BailianEngine`` calls the Bailian OpenAI-compatible chat-completions
  endpoint directly with the DB transcript as history — the guaranteed
  baseline and automatic fallback while dsh is in developer preview.
* ``stream_reply()`` is the single entry point used by chat_api; it yields
  text deltas and never raises into the HTTP layer (falls back, and as a
  last resort yields a friendly apology line).

All secrets come from the gitignored server/config.json ``chat`` section.
"""

import asyncio
import json
import logging
import os
import re
from pathlib import Path

import httpx

from .config import CONFIG

log = logging.getLogger(__name__)

CHAT_CFG = CONFIG.get("chat", {})
MODEL = CHAT_CFG.get("model", "DeepSeek-V4-Flash")
BASE_URL = CHAT_CFG.get(
    "bailian_base_url", "https://dashscope.aliyuncs.com/compatible-mode/v1"
).rstrip("/")
API_KEY = CHAT_CFG.get("api_key", "")
MAX_TOKENS = int(CHAT_CFG.get("max_tokens", 2048))
ENGINE_MODE = CHAT_CFG.get("engine", "auto")  # auto | dsh | bailian
_raw_root = (CHAT_CFG.get("dsh_session_root") or "").strip()
DSH_SESSION_ROOT = (
    Path(_raw_root).expanduser().resolve()
    if _raw_root
    else Path(__file__).resolve().parent.parent / ".dsh_sessions"
)

# Transcript slice sent to the model (bounds cost + context size).
MAX_HISTORY = 40

# ─── Persona / topic restriction ────────────────────────────────────────────
# Each page owns its own customer-service scope; the assistant refuses
# everything outside the website (see RULES below).

PAGE_CONTEXTS = {
    "/": (
        "The 3D Exploration (aerial) page: Cesium 3D globe with Google imagery, "
        "flight HUD, drone takeoff/landing/joystick controls, camera gimbal "
        "controls, telemetry dashboard, live capture."
    ),
    "/route-planning": (
        "The Route Planning page: creating and editing flight routes (waypoints "
        "with latitude/longitude/altitude/speed/camera angles), B-spline "
        "smoothing, saving/updating routes, generating a flight preview video "
        "from a route, publishing videos to YouTube."
    ),
    "/gallery": (
        "The Gallery page: public masonry gallery of published flight videos "
        "and their playback."
    ),
    "/extensions": (
        "The Extensions page: browsing drone / robot / vehicle / digital asset / "
        "hardware / software extensions."
    ),
    "/account": (
        "The Account page: registration, email verification, login, Google "
        "sign-in, profile editing (display name, avatar, password)."
    ),
    "/content": (
        "The Content (My Space) page: managing the signed-in user's own routes "
        "and videos (edit title/description, publish, delete)."
    ),
    "/community": (
        "The Community page: community chat rooms and browser live streaming."
    ),
}

DEFAULT_CONTEXT = (
    "All pages of the Drone Navigation website (3D Exploration, Route Planning, "
    "Gallery, Extensions, Account, Content, Community) and how to use them."
)

_BASE_PERSONA = """You are the AI customer-service assistant of the Drone Navigation website (https://drone-navigation.com).
Your only job is to answer visitors' questions about this website and how to use its features.

STRICT SCOPE — you may ONLY help with:
{page_context}
- General site navigation, account registration/login, language switching and other on-site features.

RULES:
1. If a question is not about the Drone Navigation website, politely refuse in one or two sentences and steer back to the site (e.g. "I can only help with questions about the Drone Navigation website.").
2. Never perform tasks other than answering questions about the website.
3. Do not give real-world drone piloting, airspace, legal or safety advice; for flight-related site features, explain what the page does.
4. Always reply in the same language the visitor uses (English or Chinese).
5. Be concise, friendly and practical.
"""


def build_persona(page_key: str) -> str:
    return _BASE_PERSONA.format(
        page_context=PAGE_CONTEXTS.get(page_key, DEFAULT_CONTEXT)
    )


def _model_messages(persona: str, history: list[dict], user_text: str) -> list[dict]:
    """OpenAI-style message list: system + capped transcript + new turn."""
    msgs = [{"role": "system", "content": persona}]
    for m in history[-MAX_HISTORY:]:
        if m.get("kind") != "text" or not m.get("text"):
            continue  # attachments / video cards are UI-only
        msgs.append(
            {
                "role": "user" if m.get("role") == "user" else "assistant",
                "content": m["text"],
            }
        )
    msgs.append({"role": "user", "content": user_text})
    return msgs


# ─── Bailian (OpenAI-compatible) engine ─────────────────────────────────────


async def _stream_bailian(persona: str, history: list[dict], user_text: str):
    """Yield text deltas from the Bailian chat-completions endpoint."""
    payload = {
        "model": MODEL,
        "messages": _model_messages(persona, history, user_text),
        "stream": True,
        "max_tokens": MAX_TOKENS,
    }
    headers = {"Authorization": f"Bearer {API_KEY}"}
    async with httpx.AsyncClient(timeout=httpx.Timeout(120.0, connect=10.0)) as client:
        async with client.stream(
            "POST", f"{BASE_URL}/chat/completions", json=payload, headers=headers
        ) as res:
            if res.status_code != 200:
                body = (await res.aread()).decode("utf-8", "replace")[:500]
                raise RuntimeError(f"bailian http {res.status_code}: {body}")
            async for line in res.aiter_lines():
                line = line.strip()
                if not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if data == "[DONE]":
                    break
                try:
                    chunk = json.loads(data)
                except json.JSONDecodeError:
                    continue
                try:
                    delta = chunk["choices"][0]["delta"].get("content") or ""
                except (KeyError, IndexError, TypeError):
                    continue
                if delta:
                    yield delta


# ─── DeepSeek Harness engine ────────────────────────────────────────────────

_CORDIS_TEMPLATE = """# Generated by server/app/chat_engine.py — do not edit.
# Minimal chat-only composition: no tools, no workspace context; the persona
# carries the page-scoped customer-service instructions.
- id: sdk-jsonrpc-server
  name: '@deepseek-ai/dsh-sdk-jsonrpc-server'
  config:
    maxTokensAsSuccess: false

- id: llm-deepseek
  name: '@deepseek-ai/dsh-llm-deepseek'
  config:
    apiKeyEnv: DEEPSEEK_API_KEY
    streamIdleTimeoutMs: 172800000
    models:
      - id: {model}
        contextWindow: 1000000

- id: agent-spine
  name: '@deepseek-ai/dsh-agent-spine-demo'
  config:
    includeHarnessIdentity: false
    includeRuntimeContext: false
    persona: |
{persona_block}
    workspaceContext: false
    skills:
      enabled: false
    toolBash: false
    toolJobs: false

- id: sessions
  name: '@deepseek-ai/dsh-session-persistence-jsonl'
  config:
    root: {session_root}
    compression: none
"""

_dsh_harnesses: dict[str, object] = {}
_dsh_lock = asyncio.Lock()


def _cordis_path(page_key: str) -> Path:
    slug = re.sub(r"[^a-z0-9]+", "-", page_key.strip("/").lower()) or "root"
    return DSH_SESSION_ROOT / "cordis" / f"{slug}.yml"


def _ensure_cordis(page_key: str) -> Path:
    path = _cordis_path(page_key)
    if not path.exists():
        persona = build_persona(page_key)
        persona_block = "\n".join("      " + ln for ln in persona.splitlines())
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            _CORDIS_TEMPLATE.format(
                model=MODEL,
                persona_block=persona_block,
                session_root=str(DSH_SESSION_ROOT / "sessions"),
            ),
            encoding="utf-8",
        )
    return path


def _get_harness(page_key: str):
    """Create (once per page) a DeepSeekHarness; blocking work runs in the
    caller's thread (this helper is only called inside to_thread)."""
    if page_key not in _dsh_harnesses:
        from deepseek_harness import DeepSeekHarness  # lazy: optional dep

        os.environ.setdefault("DEEPSEEK_API_KEY", API_KEY)
        os.environ.setdefault("DEEPSEEK_BASE_URL", BASE_URL)
        workspace = DSH_SESSION_ROOT / "workspace"
        workspace.mkdir(parents=True, exist_ok=True)
        (DSH_SESSION_ROOT / "sessions").mkdir(parents=True, exist_ok=True)
        _dsh_harnesses[page_key] = DeepSeekHarness(
            provider="deepseek-official",
            model=MODEL,
            max_tokens=MAX_TOKENS,
            cwd=str(workspace),
            session_root=str(DSH_SESSION_ROOT / "sessions"),
            cordis=str(_ensure_cordis(page_key)),
        )
    return _dsh_harnesses[page_key]


async def _run_dsh(page_key: str, identity: str, generation: str, user_text: str):
    """One durable dsh session per (identity, generation); yields the final
    response as a single delta (the SDK is non-streaming in this preview)."""

    def _blocking() -> str:
        harness = _get_harness(page_key)
        result = harness.run(user_text, session_id=f"{identity}::{generation}")
        return result.final_response or ""

    async with _dsh_lock:  # one runtime request at a time (preview runtime)
        text = await asyncio.to_thread(_blocking)
    if text:
        yield text


# ─── Unified entry point ────────────────────────────────────────────────────


async def stream_reply(
    page_key: str,
    identity: str,
    generation: str,
    history: list[dict],
    user_text: str,
):
    """Yield assistant text deltas; dsh first (auto/dsh), Bailian fallback."""
    persona = build_persona(page_key)
    tried = []

    if ENGINE_MODE in ("auto", "dsh"):
        try:
            # dsh (preview SDK) is non-streaming: buffer the final answer so
            # an empty/failed run can still fall back to Bailian.
            buffered = [d async for d in _run_dsh(page_key, identity, generation, user_text)]
            text = "".join(buffered).strip()
            if text:
                yield text
                return
            tried.append("dsh: empty response")
            log.warning("dsh engine returned no text, falling back to bailian")
        except Exception as exc:  # noqa: BLE001 — preview software: fall back
            tried.append(f"dsh: {exc!r}")
            log.warning("dsh engine failed, falling back to bailian: %s", tried[-1])

    if ENGINE_MODE in ("auto", "bailian"):
        try:
            async for delta in _stream_bailian(persona, history, user_text):
                yield delta
            return
        except Exception as exc:  # noqa: BLE001
            tried.append(f"bailian: {exc!r}")
            log.error("bailian engine failed: %s", tried[-1])

    # Last resort: never leave the visitor with a silent bubble.
    yield (
        "I'm sorry, the assistant is temporarily unavailable. "
        "Please try again in a moment."
    )


# ─── 3D-asset category classification (Public Component) ────────────────────
# One-shot, non-conversational classification of a mesh asset's metadata
# into one of the twelve fixed Public Component category ids. Uses the
# Bailian OpenAI-compatible endpoint directly (NOT the DSH harness: the
# task is single-shot, and the harness runtime is serialized with the
# customer-service chat). Any failure -> None -> the row stays
# unclassified and the owner picks a shelf manually.

MESH_CATEGORY_IDS = (
    "vehicle",
    "ship",
    "plane",
    "architecture",
    "sculpture",
    "human",
    "animal",
    "vegetation",
    "equipment",
    "water",
    "fire",
    "cloud",
)

_CLASSIFY_SYSTEM = """You classify 3D assets for a public library. Given an asset's metadata, reply with exactly one category id from this fixed list:
vehicle, ship, plane, architecture, sculpture, human, animal, vegetation, equipment, water, fire, cloud.

Meanings:
- vehicle: ground/space vehicles (cars, trucks, trains, rovers, spacecraft)
- ship: boats and watercraft
- plane: aircraft (planes, helicopters, drones)
- architecture: buildings, houses, structures, interiors
- sculpture: statues and artistic/carved works, including sculptures OF animals or humans
- human: human character models (not statues)
- animal: animal character models (not statues)
- vegetation: trees, plants, grass
- equipment: tools, machines, devices, furniture
- water / fire / cloud: the natural element itself

Precedence rule: classify what the asset IS as an object. A lion statue is "sculpture", not "animal".

When "GLB contents" is present it lists the names extracted from inside the file (generator tool, node/mesh/material/animation names). Weight it strongly: it usually describes the real subject better than a generic filename (e.g. nodes named fuselage/main_rotor/tail_rotor mean plane; lion_head/lion_mane/pedestal with a stone material mean sculpture).

Reply with only the single category id in lowercase. No punctuation, no explanation."""


async def classify_asset(
    name: str,
    description: str,
    filename: str,
    glb_meta: str | None = None,
) -> str | None:
    """Classify one 3D asset into a Public Component category id, or None.
    ``glb_meta`` is an optional digest of the glTF JSON chunk inside the
    GLB (generator + node/mesh/material/animation names), extracted by
    meshes_api._glb_meta_digest."""
    if not API_KEY:
        log.warning("classify_asset: no chat api key configured")
        return None

    lines = []
    if (name or "").strip():
        lines.append(f"Name: {name.strip()[:200]}")
    if (description or "").strip():
        lines.append(f"Description: {description.strip()[:500]}")
    if (filename or "").strip():
        lines.append(f"Filename: {filename.strip()[:200]}")
    if (glb_meta or "").strip():
        lines.append(f"GLB contents: {glb_meta.strip()[:400]}")
    if not lines:
        return None  # nothing to classify from

    payload = {
        "model": MODEL,
        "messages": [
            {"role": "system", "content": _CLASSIFY_SYSTEM},
            {"role": "user", "content": "\n".join(lines)},
        ],
        "stream": False,
        "max_tokens": 16,
        "temperature": 0,
    }
    headers = {"Authorization": f"Bearer {API_KEY}"}
    try:
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(30.0, connect=8.0)
        ) as client:
            res = await client.post(
                f"{BASE_URL}/chat/completions", json=payload, headers=headers
            )
            if res.status_code != 200:
                log.warning(
                    "classify_asset: bailian http %s: %s",
                    res.status_code,
                    res.text[:200],
                )
                return None
            text = (
                res.json()["choices"][0]["message"].get("content") or ""
            ).strip().lower()
    except Exception as exc:  # noqa: BLE001 — never break the publish flow
        log.warning("classify_asset failed: %r", exc)
        return None

    # Accept the first whitelisted id appearing anywhere in the answer.
    for word in re.findall(r"[a-z]+", text):
        if word in MESH_CATEGORY_IDS:
            return word
    log.info("classify_asset: answer %r matched no category", text[:80])
    return None
