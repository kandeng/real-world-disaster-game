# Drone Navigation

A multi-view drone navigation dashboard combining 3D aerial visualization, 2D mapping, and mission-control interfaces.

## Project structure

```
drone-navigation/
├── client/       # Vue 3 + Vite frontend (Cesium, Google Maps, Street View)
├── server/       # FastAPI backend (fastapi-users auth, settings, Matrix token brokering)
├── extension/    # Standalone publishers/tools (e.g. simple_webcam WHIP ingest)
└── deployment/   # Production configs + ops docs (Caddy, Squid, OpenClaw, MediaMTX, Synapse)
```

## Quick start (local Ubuntu desktop — full system)

The entire system runs locally without any ECS dependency. In dev, the SPA calls FastAPI cross-origin at `http://localhost:8000` and reaches Synapse through the Vite `/_matrix` proxy — **no Caddy needed locally** (Caddy, Squid, and Tailscale are production-only; see [deployment/README.md](deployment/README.md)). After the one-time installs below, section 8 shows how to run all backends as auto-started systemd user services (no terminals).

### 1. Client (Vue 3 + Vite)

```bash
cd client
npm install
cp config.example.json config.json   # fill in googleApiKey, cesiumIonToken, openclaw.token
npm run dev                          # http://localhost:5173
```

For API key prerequisites (Google Maps APIs, Cesium ion), see [client/README.md](client/README.md).

### 2. PostgreSQL (user-owned dev cluster, port 5433)

No sudo, separate from any system cluster (details: deployment/README.md §3.3.3):

```bash
# One-time init (trust auth on localhost, port 5433)
/usr/lib/postgresql/14/bin/initdb -D ~/pgdata -U $USER -E UTF8 --auth=trust
printf "port = 5433\nunix_socket_directories = '$HOME/pgdata'\n" >> ~/pgdata/postgresql.conf

# Start / stop
/usr/lib/postgresql/14/bin/pg_ctl -D ~/pgdata -l ~/pgdata.log start
/usr/lib/postgresql/14/bin/pg_ctl -D ~/pgdata stop

# Populate the schema (idempotent; run 002 after 001)
psql -h 127.0.0.1 -p 5433 -U $USER -v ON_ERROR_STOP=1 \
     -v app_password='local-dev-drone-api' \
     -f server/migrations/001_init_auth_schema.sql
psql -h 127.0.0.1 -p 5433 -U $USER -d drone_navigation \
     -v ON_ERROR_STOP=1 -f server/migrations/002_matrix_account.sql
```

### 3. FastAPI backend (auth + settings + Matrix brokering)

```bash
cd server
conda create -n drone-navigation python=3.12 -y
conda activate drone-navigation
pip install -r requirements.txt
cp config.example.json config.json   # local values: database_url → ...@127.0.0.1:5433/...,
                                     # frontend_base_url → http://localhost:5173,
                                     # cors_origins → ["http://localhost:5173"]
uvicorn app.main:app --reload --port 8000
```

Note: `--reload` watches only `.py` files — after editing `config.json`, `touch app/main.py` to force a reload.

### 4. Synapse (Community chat)

Runs on `127.0.0.1:8008` with public registration disabled — the website is the only entrance (a conda env works equally well as the venv shown):

```bash
python3 -m venv ~/synapse-venv   # or: conda create -n synapse python=3.12
~/synapse-venv/bin/pip install matrix-synapse==1.157.1
~/synapse-venv/bin/python -m synapse.app.homeserver \
  --server-name localhost --config-path ~/synapse-data/homeserver.yaml \
  --generate-config --report-stats=no
# Edit ~/synapse-data/homeserver.yaml: keep the 127.0.0.1:8008 listener
# (client+admin resources), verify `enable_registration: false`

# Start (background)
nohup ~/synapse-venv/bin/python -m synapse.app.homeserver \
  -c ~/synapse-data/homeserver.yaml &

# Service admin + token for the backend's token brokering
~/synapse-venv/bin/register_new_matrix_user \
  -c ~/synapse-data/homeserver.yaml -u admin -p '<pick-a-password>' --admin \
  http://localhost:8008
curl -s -X POST localhost:8008/_matrix/client/v3/login \
  -H 'Content-Type: application/json' \
  -d '{"type":"m.login.password","user":"admin","password":"<same-password>"}'
# Add to server/config.json, then `touch app/main.py`:
#   "synapse": { "base_url": "http://127.0.0.1:8008",
#                "server_name": "localhost",
#                "admin_access_token": "<syt_... token>" }
```

### 5. OpenClaw (Customer Service)

```bash
pnpm add -g openclaw          # or: npm install -g openclaw
# Configure model provider + gateway token in ~/.openclaw/openclaw.json
# (see deployment/openclaw/openclaw.json for the reference shape)
openclaw gateway --port 18789 # foreground; `openclaw gateway install` for a daemon
```

The SPA connects to `ws://127.0.0.1:18789` — `openclaw.token` in `client/config.json` must match the gateway token in `~/.openclaw/openclaw.json`.

### 6. MediaMTX (Livestream)

Installed at `~/mediamtx_v1.9.0` (v1.9.0, same as ECS 2):

```bash
mkdir ~/mediamtx_v1.9.0 && cd ~/mediamtx_v1.9.0
# download mediamtx_v1.9.0_linux_amd64.tar.gz from
# https://github.com/bluenviron/mediamtx/releases/tag/v1.9.0, then:
tar -xzf mediamtx_v1.9.0_linux_amd64.tar.gz
# Recommended: enable the control API on loopback — in mediamtx.yml set
#   api: yes  and  apiAddress: 127.0.0.1:9997
./mediamtx                   # WHEP/WHIP on :8889, HLS :8888, control API :9997

# Publish the local webcam into it (separate terminal):
cd extension/simple_webcam
pip install -r requirements.txt   # use the drone-navigation conda env
MEDIAMTX_URL=http://127.0.0.1:8889 MEDIAMTX_API=http://127.0.0.1:9997 \
  LIVESTREAM_ID=crazyflie-drone python simple_webcam.py   # WHIP-ingests the 'crazyflie-drone' stream
```

With a real Crazyflie drone, `extension/crazyflie_bridge/crazyflie_mediamtx.py`
publishes its camera under the same `crazyflie-drone` id instead of the webcam.

Which MediaMTX the SPA plays is decided by the backend, not the build: `server/config.json` -> `"mediamtx": { "streams": [...] }` is served at `GET /api/stream/config`, and `RealDroneView.vue` resolves it at playback time. The `Livestream Viewer` subpage lists every catalog entry as a clickable card in its left panel — clicking a card is the ONLY way to switch streams (default: the FIRST entry, the primary `crazyflie-drone`); the `Livestream Host` subpage keeps monitoring whichever stream is selected. Per-environment fallbacks are built into the SPA (local: `http://127.0.0.1:8889/<id>/whep`; production on ECS: `https://drone-navigation.com/live/<id>/whep`) and are used when the config key is absent; the legacy single `"whep_url"` form is still honored. The publishers default to production; the `MEDIAMTX_URL` / `MEDIAMTX_API` env vars above point them at the local server.

With the physical drone connected, the `Livestream Host` HUD also shows REAL telemetry (link rate, position x/y/z, attitude yaw/pitch/roll, battery voltage). Same desktop -> server -> browser topology as the video: `motion_control_ws.py` owns the Crazyflie link and broadcasts telemetry on `ws://127.0.0.1:8765`; `telemetry_relay.py` forwards it to the server (`WS /api/drone/telemetry/publish`), which fans out to browsers (`WS /api/drone/telemetry`):

```bash
cd extension/crazyflie_bridge   # conda activate crazyflie first
python motion_control_ws.py --cf-uri usb://0   # drone on the USB cable (radio://0/80/2M/E7E7E7E7E7 over Crazyradio otherwise)
TELEMETRY_SERVER=ws://127.0.0.1:8000/api/drone/telemetry/publish \
  python telemetry_relay.py                    # omit TELEMETRY_SERVER to publish to PRODUCTION
```

Set `"drone": { "telemetry_token": "..." }` in the deployed `server/config.json` to require `TELEMETRY_TOKEN=<same>` on the relay (empty = open, fine locally).

### 7. Smoke test (whole system)

```bash
curl http://localhost:8000/api/health            # {"status":"ok"}
curl http://localhost:5173/_matrix/client/versions   # via the Vite proxy
```

Browser checklist at `http://localhost:5173`:

1. `My Space -> Account`: register + sign in.
2. `My Space -> Settings`: change a value, click `Save` → green "saved" banner.
3. `Community -> Chat`: with two accounts (two browsers/profiles), exchange DMs both ways; reload → history persists.
4. `Community -> Customer Service`: connects to the local OpenClaw gateway.
5. `Real Drone -> Livestream Host` (and `Livestream Viewer`): plays the local `crazyflie-drone` broadcast (step 6) — the green `crazyflie-drone - HH:MM:SS` overlay ticks with live frames. With the drone + relay running (step 6), the Host HUD shows `Link live | ~20 Hz` with live position / attitude / battery values.

### 8. Background services (optional — no terminals)

Once steps 2–6 are installed, every backend can run as a systemd **user** service — auto-started at boot (user lingering is enabled), no terminals needed:

```bash
cp deployment/local-systemd/*.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now drone-pg drone-fastapi drone-synapse drone-mediamtx drone-webcam
```

| Service | Role | Port(s) |
|---|---|---|
| `drone-pg` | PostgreSQL dev cluster (`~/pgdata`) | 5433 |
| `drone-fastapi` | FastAPI backend (uvicorn `--reload`) | 8000 |
| `drone-synapse` | Matrix Synapse homeserver | 8008 |
| `drone-mediamtx` | MediaMTX (WHIP/WHEP, HLS, control API) | 8889, 8888, 9997 |
| `drone-webcam` | Demo webcam → WHIP publisher | — |
| `openclaw-gateway` | OpenClaw gateway (self-installed by `openclaw gateway install`) | 18789 |

Management cheatsheet:

```bash
systemctl --user status drone-fastapi         # state
journalctl --user -u drone-fastapi -f         # follow logs
systemctl --user restart drone-fastapi        # restart one
systemctl --user disable --now drone-webcam   # stop the webcam publisher (e.g. a real drone publishes instead)
```

### 9. Local Demo of the Whole System

Demo-day startup (current policy on this desktop: all six services are **disabled** so they stay off across reboots — start them manually only when needed):

```bash
# Bring the whole backend stack up for a demo
systemctl --user start drone-pg drone-fastapi drone-synapse drone-mediamtx drone-webcam openclaw-gateway

# Shut it down again afterwards
systemctl --user stop drone-pg drone-fastapi drone-synapse drone-mediamtx drone-webcam openclaw-gateway
```

Real drone: 

1. Find the IP address of the crazyflie drone.

~~~
(drone-navigation) robot@robot-test:~/drone-navigation/extension/crazyflie_bridge$ nmap -sn 192.168.0.0/24
Starting Nmap 7.80 ( https://nmap.org ) at 2026-07-30 21:59 CST
Nmap scan report for 192.168.0.100
Host is up (0.021s latency).
...
~~~

Then in the chrome browser, visit `http://192.168.0.xxx` one by one in the list, 
until it displays the video livestream from the crazyflie drone. 

2. Start up `crazyflie_bridge` and `simple_webcam`.

`crazyflie_bridge` — three processes, one terminal each (conda env `crazyflie`):

```bash
cd extension/crazyflie_bridge
conda activate crazyflie

# 1) Motion + telemetry bridge and the video proxy (owns the drone link)
CRAZYFLIE_IP=192.168.0.110 ./start_bridge.sh
#    = video_stream_proxy.py  (re-broadcasts http://$CRAZYFLIE_IP/stream on :8082)
#    + motion_control_ws.py   (ws://:8765; radio://0/80/2M/E7E7E7E7E7 by default —
#      pass --cf-uri usb://0 for a USB-tethered drone, where takeoff is REFUSED).
#    Stop: Ctrl+C (press twice to force; lands the drone first if it is flying).
#    Bench safety: CF_NO_FLY=1 ./start_bridge.sh refuses every takeoff (dry-run).

# 2) Telemetry + flight-command relay (drone <-> FastAPI)
TELEMETRY_SERVER=ws://127.0.0.1:8000/api/drone/telemetry/publish \
  python telemetry_relay.py
#    Stop: Ctrl+C. Omit TELEMETRY_SERVER to relay to PRODUCTION (drone-navigation.com).

# 3) Drone camera -> local MediaMTX (WHIP ingest, id 'crazyflie-drone')
MEDIAMTX_URL=http://127.0.0.1:8889 MEDIAMTX_API=http://127.0.0.1:9997 \
  python crazyflie_mediamtx.py
#    Stop: Ctrl+C. Reads the video proxy (override with CRAZYFLIE_STREAM_URL).
```

`simple_webcam` — the no-drone stand-in (conda env `drone-navigation`); skip it when the real drone publishes:

```bash
cd extension/simple_webcam
conda activate drone-navigation
MEDIAMTX_URL=http://127.0.0.1:8889 MEDIAMTX_API=http://127.0.0.1:9997 \
  python simple_webcam.py
#    WHIP-ingests the laptop webcam as 'ubuntu-webcam' (LIVESTREAM_ID=crazyflie-drone
#    makes it stand in for the drone). Stop: Ctrl+C.
#    Note: the demo-day systemctl line above already runs this as drone-webcam —
#    don't run both (that would double-publish the same stream id).
```

Then open `http://localhost:5173` -> `Real Drone`: the `Livestream Viewer` lists the stream cards; the `Livestream Host` HUD shows live telemetry, and the Takeoff/Stop/Landing button + Flight disk fly the drone (armed only over the radio link — never on the USB cable).


Notes:

- The Vite dev server (step 1) stays manual — it's the frontend you're actively developing: `npm run dev`.
- `drone-fastapi` keeps `--reload`: `.py` edits auto-apply; after editing `server/config.json`, `touch server/app/main.py` (works from any shell, no restart needed).
- `openclaw-gateway.service` is created by OpenClaw's own installer — it's listed only for completeness; don't copy a unit for it.

For production deployment on the two Alibaba ECS servers, see [deployment/README.md](deployment/README.md).

## License

See [LICENSE](LICENSE) for the full End-User License Agreement.
