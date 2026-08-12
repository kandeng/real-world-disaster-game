# Crazyflie Bridge — Full Website Pipeline

A step-by-step guide to download, install, configure and run the `extension/crazyflie_bridge` extension, then watch the drone camera in Community → Live Stream and fly the drone from the Real Drone page.

---

The bridge connects the physical Crazyflie to the drone-navigation website with four cooperating processes: AI-Deck video → MediaMTX (WHIP), telemetry → FastAPI → browser HUD, and browser flight commands → drone. It is the production pipeline that the Simple Crazyflie scripts graduate into.

### Step 1 — Download

1. Clone the repository: `git clone https://github.com/kandeng/drone-navigation-v2.git`
2. The extension lives at `extension/crazyflie_bridge` (`start_bridge.sh`, `telemetry_relay.py`, `motion_control_ws.py`, `video_stream_proxy.py`, `crazyflie_mediamtx.py`, `provision_drone.py`, `e2e_command_check.py`).

### Step 2 — Install the website stack

Follow the platform README at the repository root for your OS (Windows 10/11 WSL2, macOS, or Ubuntu). In short:

1. **Client**: `cd client && npm install && cp config.example.json config.json && npm run dev` → the site at `http://localhost:5173`.
2. **Backend**: PostgreSQL dev cluster (port 5433, migrations 001 + 002), then `cd server && conda create -n drone-navigation python=3.12 -y && conda activate drone-navigation && pip install -r requirements.txt && cp config.example.json config.json && uvicorn app.main:app --port 8000`.
3. **MediaMTX v1.9.0**: download the release tarball, extract, run `./mediamtx` — WHEP/WHIP on :8889, control API on :9997.
4. **Bridge dependencies**: `pip install -r extension/crazyflie_bridge/requirements.txt` (cflib, websockets).
5. **USB access to the Crazyradio PA** — same one-time setup as Simple Crazyflie: udev rule on Ubuntu/WSL2, `usbipd-win` pass-through on Windows, `brew install libusb` on macOS.

### Step 3 — Configure

1. **Camera IP**: the AI-Deck serves its stream at `http://<drone-ip>/stream` on the local Wi-Fi. Browse `http://192.168.0.x` candidates (or `nmap -sn 192.168.0.0/24`) until the camera page appears.
2. **Radio identity**: default `radio://0/80/2M/E7E7E7E7E7` is for SOLO use. Several drones in one room must each get their own channel/address (≥2 MHz apart) via USB provisioning:
```bash
cd extension/crazyflie_bridge
python provision_drone.py --channel 14 --address E7E7E7E707
```
3. **Backend config** (`server/config.json`, `mediamtx` section): point `whep_url` / `control_api_url` at your MediaMTX — the local defaults (`http://127.0.0.1:8889`, `http://127.0.0.1:9997`) already work for a local stack.

### Step 4 — Run

1. Start the stack in this order (one terminal each): PostgreSQL, backend (`uvicorn ... --port 8000`), MediaMTX (`./mediamtx`), client (`npm run dev`).
2. Start the bridge — one script launches all four processes (it self-activates the `drone-navigation` conda env):
```bash
cd extension/crazyflie_bridge
CRAZYFLIE_IP="192.168.0.110" RADIO_URL="radio://0/80/2M/E7E7E7E7E7" \
TELEMETRY_SERVER="ws://127.0.0.1:8000/api/drone/telemetry/publish" \
MEDIAMTX_URL="http://127.0.0.1:8889" MEDIAMTX_API="http://127.0.0.1:9997" \
  ./start_bridge.sh
```
- `video_stream_proxy.py` — re-broadcasts the AI-Deck stream on :8082
- `crazyflie_mediamtx.py` — publishes the drone camera to MediaMTX via WHIP as `crazyflie-drone`
- `telemetry_relay.py` — telemetry + flight commands, drone ↔ FastAPI
- `motion_control_ws.py` — accepts browser flight commands on ws://:8765
3. **No-flight verification**: `python e2e_command_check.py` validates the full command chain without arming the motors. `CF_NO_FLY=1` makes every takeoff refuse (dry-run bench mode).
4. Stop with `Ctrl+C` (press twice to force) — the bridge lands the drone first if it is flying.

### Step 5 — Use the website

1. **Watch the broadcast**: open `Community → Live Stream`. The `crazyflie-drone` card appears with a LIVE badge as soon as the bridge publishes; click it to play the drone camera in the browser. (You can also start your own webcam broadcast there with the Go Live button.)
2. **Fly from the browser**: open the `Real Drone` page. The HUD shows `Link live | ~20 Hz` with real position, attitude and battery. Use the Takeoff / Stop / Landing button and the Flight disk to fly the drone; the red button at the top of the right sidebar is the emergency stop.
3. **Safety, always in effect**: takeoff is refused while the drone is tethered over USB; a 0.5 s dead-man switch hovers the drone automatically if commands stop arriving (closed tab, dead relay); unplugging the Crazyradio cuts the motors in ~1 s.
