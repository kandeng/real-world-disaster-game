#!/usr/bin/env python3
"""E2E (fully local, CF_NO_FLY dry-run): Real Drone -> Livestream Host
takeoff/stop/landing switcher + Flight disk wiring.

Chain under test: browser (localhost:5173) -> local FastAPI :8000 ->
local telemetry_relay -> motion bridge (radio link, CF_NO_FLY=1) -> drone.
Ground truth: new lines appended to /tmp/motion_bridge_radio.log.
"""
import asyncio
import re
import time
from playwright.sync_api import sync_playwright

LOG = "/tmp/motion_bridge_radio.log"
results = []


def check(name, ok, detail=""):
    results.append((name, ok, detail))
    print(("  PASS " if ok else "  FAIL ") + name + (f"  [{detail}]" if detail else ""), flush=True)


def log_size():
    try:
        with open(LOG, "rb") as f:
            f.seek(0, 2)
            return f.tell()
    except OSError:
        return 0


def new_log_lines(mark):
    with open(LOG, "r", errors="replace") as f:
        f.seek(mark)
        return f.read()


def dock(page):
    out = {}
    for b in page.locator(".dock-btn").all():
        out[b.get_attribute("title") or "?"] = b.is_disabled()
    return out


def click(page, title):
    page.locator(f'.dock-btn[title="{title}"]').first.click()


def hud(page):
    return page.evaluate(
        "() => (document.querySelector('.telemetry') || {innerText:''}).innerText.replace(/\\n/g,' | ')")


with sync_playwright() as p:
    browser = p.chromium.connect_over_cdp("http://localhost:1337")
    ctx = browser.contexts[0]
    for pg in list(ctx.pages):
        if "localhost:5173" in pg.url:
            pg.close()
    page = ctx.new_page()
    page.goto("http://localhost:5173/", wait_until="domcontentloaded")
    page.bring_to_front()
    page.wait_for_selector("#splash-overlay", state="detached", timeout=180000)
    page.locator('.dock-btn[title="Pages"]').wait_for(timeout=60000)
    time.sleep(3)

    print("== open Real Drone -> Host ==", flush=True)
    page.locator('.dock-btn[title="Pages"]').click()
    time.sleep(1.5)
    page.locator("text=Real Drone").first.click()
    time.sleep(5)

    # 1. HUD live over the LOCAL telemetry chain
    t0 = time.time()
    live = False
    while time.time() - t0 < 30:
        if "live" in hud(page):
            live = True
            break
        time.sleep(2)
    check("1 HUD live via local chain (bridge->relay->:8000->browser)", live, hud(page)[:90])

    # 2. Switcher cycle: Takeoff -> REFUSED dry-run, advances to Stop
    mark = log_size()
    click(page, "Takeoff")
    time.sleep(1.5)
    out = new_log_lines(mark)
    check("2a takeoff reached bridge", "CMD >> takeoff" in out)
    check("2b takeoff REFUSED by CF_NO_FLY dry-run", "takeoff REFUSED: CF_NO_FLY dry-run mode" in out,
          out.strip().splitlines()[-1][:100] if out.strip() else "no log")
    check("2c switcher advanced to Stop", "Stop" in dock(page), str(dock(page)))

    # 3. Stop -> hover (zero move) delivered
    mark = log_size()
    click(page, "Stop")
    time.sleep(1.5)
    out = new_log_lines(mark)
    check("3a hover (zero-velocity move) delivered", "'action': 'move'" in out and "'vz': 0" in out,
          out.strip().splitlines()[-1][:110] if out.strip() else "no log")
    check("3b switcher advanced to Landing", "Landing" in dock(page), str(dock(page)))

    # 4. Landing -> land delivered (no-op while grounded)
    mark = log_size()
    click(page, "Landing")
    time.sleep(1.5)
    out = new_log_lines(mark)
    check("4a land command delivered", "CMD >> land" in out)
    check("4b switcher advanced to Stop", "Stop" in dock(page), str(dock(page)))

    # 5. Flight disk: drag joystick -> scaled move commands stream; release -> hover
    click(page, "Stop")  # cycle back to takeoff for later
    # Both disks stay in the DOM (hidden via joystick-group--hidden); the
    # camera disk is first, so target the track of the VISIBLE group.
    track = page.locator(".joystick-group:not(.joystick-group--hidden) .joystick-track").first
    if not track.is_visible(timeout=3000):  # showFlight defaults to true
        click(page, "Steer")
        time.sleep(1.5)
    check("5a flight disk visible", track.is_visible(timeout=5000))
    box = track.bounding_box()
    cx, cy = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
    mark = log_size()
    page.mouse.move(cx, cy)
    page.mouse.down()
    page.mouse.move(cx + 60, cy - 60, steps=5)
    time.sleep(0.8)  # let keep-alives stream
    page.mouse.up()
    time.sleep(0.5)
    out = new_log_lines(mark)
    tail_line = out.strip().splitlines()[-1] if out.strip() else ""
    moves = re.findall(r"'action': 'move', 'vx': ([-\d.]+), 'vy': ([-\d.]+)", out)
    nonzero = [(float(a), float(b)) for a, b in moves if abs(float(a)) > 1e-6 or abs(float(b)) > 1e-6]
    check("5b move commands streamed while dragging", len(nonzero) >= 2,
          f"{len(nonzero)} nonzero moves, sample={nonzero[:2]}")
    scaled_ok = all(abs(a) <= 0.51 and abs(b) <= 0.51 for a, b in nonzero)
    check("5c velocities scaled into +/-0.5 m/s", scaled_ok)
    check("5d hover sent on release", re.search(r"'vx': 0(\.0)?, 'vy': 0(\.0)?, 'vz': 0(\.0)?,", tail_line) is not None, tail_line[:110])

    browser.close()

# 6. Direct WS interlock tests (full chain, no UI): move-up + takeoff refused
print("== direct WS: interlock on radio link (dry-run) ==", flush=True)
import websockets  # noqa: E402


async def ws_tests():
    ok = {}
    async with websockets.connect("ws://127.0.0.1:8000/api/drone/command") as ws:
        mark = log_size()
        await ws.send('{"action":"move","vx":0,"vy":0,"vz":0.3,"yawrate":0}')
        await ws.recv()  # ack
        await asyncio.sleep(0.7)
        out = new_log_lines(mark)
        ok["move_up_refused"] = "move REFUSED: CF_NO_FLY dry-run mode" in out

        mark = log_size()
        await ws.send('{"action":"takeoff","height":0.5}')
        frame = await ws.recv()
        await asyncio.sleep(0.7)
        out = new_log_lines(mark)
        ok["takeoff_refused"] = "takeoff REFUSED: CF_NO_FLY dry-run mode" in out
        ok["ack"] = '"delivered":true' in frame or '"delivered": true' in frame
    return ok


res6 = asyncio.run(ws_tests())
check("6a move-up while grounded REFUSED (interlock over radio)", res6.get("move_up_refused"))
check("6b takeoff REFUSED + ack delivered", res6.get("takeoff_refused") and res6.get("ack"),
      f"ack={res6.get('ack')}")

print("== summary ==", flush=True)
failed = [r for r in results if not r[1]]
print(f"{len(results) - len(failed)}/{len(results)} PASS", flush=True)
for name, ok, detail in results:
    if not ok:
        print("  FAILED:", name, detail, flush=True)
raise SystemExit(1 if failed else 0)
