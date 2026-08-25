#!/usr/bin/env python3
"""Connectivity test for the Alibaba Bailian (Token Plan) AI provider.

Reads baseUrl + apiKey + model list from the neighboring openclaw.json and
sends one tiny Anthropic-Messages request per model (the provider's declared
api style is "anthropic-messages"). Prints PASS/FAIL per model and exits 0
when at least one model answers.

Usage:
    python3 test_bailian_access.py               # test all listed models
    python3 test_bailian_access.py qwen3.6-flash # test one specific model
"""

import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
CONFIG = HERE / "openclaw.json"
PROVIDER = "bailian-token-plan"
TIMEOUT_S = 60


def call_anthropic_messages(base_url: str, api_key: str, model: str) -> tuple[int, str]:
    """One minimal non-streaming Messages-API call. Returns (http_status, body)."""
    url = base_url.rstrip("/") + "/v1/messages"
    payload = json.dumps(
        {
            "model": model,
            "max_tokens": 32,
            "messages": [{"role": "user", "content": "Reply with exactly: PONG"}],
        }
    ).encode()
    req = urllib.request.Request(
        url,
        data=payload,
        headers={
            "Content-Type": "application/json",
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:
            return resp.status, resp.read().decode(errors="replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode(errors="replace")
    except Exception as e:  # noqa: BLE001 — report any network failure verbatim
        return -1, f"{type(e).__name__}: {e}"


def extract_reply(body: str) -> str:
    """Pull the assistant text out of an Anthropic Messages response."""
    try:
        data = json.loads(body)
        parts = data.get("content") or []
        return "".join(p.get("text", "") for p in parts if p.get("type") == "text").strip()
    except json.JSONDecodeError:
        return ""


def main() -> int:
    cfg = json.loads(CONFIG.read_text())
    provider = cfg["models"]["providers"][PROVIDER]
    base_url = provider["baseUrl"]
    api_key = provider["apiKey"]
    models = sys.argv[1:] or [m["id"] for m in provider["models"]]

    print(f"provider : {PROVIDER}")
    print(f"baseUrl  : {base_url}")
    print(f"apiKey   : {api_key[:12]}…{api_key[-4:]}")
    print(f"models   : {', '.join(models)}")
    print("-" * 64)

    passed = []
    for model in models:
        status, body = call_anthropic_messages(base_url, api_key, model)
        if status == 200:
            reply = extract_reply(body)
            print(f"PASS  {model:<24} -> {reply[:60] or '(empty reply)'}")
            passed.append(model)
        else:
            snippet = " ".join(body.split())[:140]
            print(f"FAIL  {model:<24} -> HTTP {status}: {snippet}")

    print("-" * 64)
    if passed:
        print(f"RESULT: {len(passed)}/{len(models)} model(s) accessible — provider is reachable.")
        return 0
    print("RESULT: provider NOT accessible with this key/endpoint.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
