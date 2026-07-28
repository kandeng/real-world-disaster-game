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

The entire system runs locally without any ECS dependency. In dev, the SPA calls FastAPI cross-origin at `http://localhost:8000` and reaches Synapse through the Vite `/_matrix` proxy — **no Caddy needed locally** (Caddy, Squid, and Tailscale are production-only; see [deployment/README.md](deployment/README.md)).

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

### 6. MediaMTX (Livestream) — currently ECS-hosted

Not installed locally yet; the Livestream pages currently pull from production (`https://drone-navigation.com/live/...`), so that page still needs the ECS until localized. To run it locally:

```bash
mkdir ~/mediamtx && cd ~/mediamtx
# download mediamtx_v1.9.0_linux_amd64.tar.gz from
# https://github.com/bluenviron/mediamtx/releases/tag/v1.9.0, then:
tar -xzf mediamtx_v1.9.0_linux_amd64.tar.gz
./mediamtx                   # WHEP on :8889, WHIP ingest on :8889/whip, HLS :8888

# Publish the local webcam into it (separate terminal):
cd extension/simple_webcam
pip install -r requirements.txt   # use the drone-navigation conda env
python simple_webcam.py           # WHIP-ingests the 'ubuntu-webcam' stream
```

Caveat: `RealDroneView.vue` hardcodes the production WHEP URL — for a fully ECS-free livestream, point it at `http://127.0.0.1:8889/ubuntu-webcam/whep` (a config-driven switch is planned).

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
5. `Livestream`: plays (from the production ECS stream until step 6 is localized).

For production deployment on the two Alibaba ECS servers, see [deployment/README.md](deployment/README.md).

## License

See [LICENSE](LICENSE) for the full End-User License Agreement.
