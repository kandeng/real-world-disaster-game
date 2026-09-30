# Drone Navigation

A multi-view drone navigation dashboard combining 3D aerial visualization, 2D mapping, and mission-control interfaces.

This guide runs the **entire system locally on Windows 10/11 with WSL2** — no server accounts needed. Other platforms and languages:

- Production deployment (Alibaba ECS, Caddy, Tailscale): [deployment/README.md](deployment/README.md)

## Project structure

```
real-world-disaster-game/
├── client/       # Vue 3 + Vite frontend (Cesium, Google Maps, Street View)
├── server/       # FastAPI backend (fastapi-users auth, settings, Matrix token brokering)
└── deployment/   # Production configs + ops docs (Caddy, Squid, MediaMTX, Synapse)
```

## How it works on Windows (read this first)

Everything server-side runs **inside WSL2 Ubuntu**; you interact with it from Windows through WSL2's localhost forwarding — a service listening on a port inside WSL is reachable from Windows at `http://localhost:<port>`.

| Component | Runs in | Port(s) |
|---|---|---|
| Client (Vite dev server) | WSL | 5173 |
| FastAPI backend | WSL | 8000 |
| PostgreSQL dev cluster | WSL | 5433 |
| Synapse (Community chat) | WSL | 8008 |
| MediaMTX (Livestream) | WSL | 8889, 8888, 9997 |

## Section 1. Windows + WSL2 setup

In **Windows PowerShell (Administrator)**:

```powershell
wsl --install                  # installs WSL2 + Ubuntu; reboot when asked
wsl --set-default-version 2
```

Then in the **Ubuntu (WSL) terminal**:

```bash
sudo apt update && sudo apt install -y git curl

# Miniconda
curl -LO https://repo.anaconda.com/miniconda/Miniconda3-latest-Linux-x86_64.sh
bash Miniconda3-latest-Linux-x86_64.sh -b -p ~/miniconda3
~/miniconda3/bin/conda init bash && source ~/.bashrc

# Node.js LTS
curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
sudo apt install -y nodejs

# Clone into the WSL HOME — never under /mnt/c
# (npm install on the Windows filesystem is 10-50x slower)
git clone https://github.com/kandeng/real-world-disaster-game.git ~/real-world-disaster-game
```

Checkpoint: `node -v`, `npm -v`, `conda --version`, `git --version` all print versions.

## Section 2. Client (Vue 3 + Vite)

```bash
cd ~/real-world-disaster-game/client
npm install
cp config.example.json config.json   # fill in googleApiKey, cesiumIonToken
npm run dev
```

Open `http://localhost:5173` in your **Windows** browser (WSL forwards it). For API key prerequisites (Google Maps APIs, Cesium ion), see [client/README.md](client/README.md).

**Smoke test:** the `3D Aerial` globe and the `2D Map` render immediately — they need no backend. Most other pages come alive as you add the sections below.

## Section 3. PostgreSQL (dev cluster in WSL, port 5433)

A user-owned cluster, no systemd needed (WSL's apt also installs its own cluster on port 5432 — ignore it; we never touch it):

```bash
sudo apt install -y postgresql
VER=$(ls /usr/lib/postgresql)        # 14 on Ubuntu 22.04, 16 on 24.04

# One-time init (trust auth on localhost, port 5433)
/usr/lib/postgresql/$VER/bin/initdb -D ~/pgdata -U $USER -E UTF8 --auth=trust
printf "port = 5433\nunix_socket_directories = '$HOME/pgdata'\n" >> ~/pgdata/postgresql.conf

# Start / stop
/usr/lib/postgresql/$VER/bin/pg_ctl -D ~/pgdata -l ~/pgdata.log start
/usr/lib/postgresql/$VER/bin/pg_ctl -D ~/pgdata stop

# Populate the schema (idempotent; run 002 after 001)
psql -h 127.0.0.1 -p 5433 -U $USER -v ON_ERROR_STOP=1 \
     -v app_password='local-dev-drone-api' \
     -f ~/real-world-disaster-game/server/migrations/001_init_auth_schema.sql
psql -h 127.0.0.1 -p 5433 -U $USER -d drone_navigation \
     -v ON_ERROR_STOP=1 -f ~/real-world-disaster-game/server/migrations/002_matrix_account.sql
```

## Section 4. FastAPI backend (auth + settings + Matrix brokering)

```bash
cd ~/real-world-disaster-game/server
conda create -n drone-navigation python=3.12 -y   # env name stays 'drone-navigation': the deployment units hardcode it
conda activate drone-navigation
pip install -r requirements.txt
cp config.example.json config.json   # local values: database_url → ...@127.0.0.1:5433/...,
                                     # frontend_base_url → http://localhost:5173,
                                     # cors_origins → ["http://localhost:5173"]
uvicorn app.main:app --reload --port 8000
```

Note: `--reload` watches only `.py` files — after editing `config.json`, `touch app/main.py` to force a reload.

**Smoke test:** `curl http://localhost:8000/api/health` → `{"status":"ok"}` — run it **in Windows PowerShell too**; it proves WSL→Windows forwarding works. Then in the browser: `My Space -> Account`, register + sign in; `My Space -> Settings`, change a value, `Save` → green banner.

## Section 5. Synapse (Community chat)

Runs on `127.0.0.1:8008` with public registration disabled — the website is the only entrance:

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

**Smoke test:** with two accounts in two browser profiles, `Community -> Chat` DMs flow both ways and survive a reload.

## Section 6. MediaMTX (WSL)

```bash
mkdir ~/mediamtx_v1.9.0 && cd ~/mediamtx_v1.9.0
curl -LO https://github.com/bluenviron/mediamtx/releases/download/v1.9.0/mediamtx_v1.9.0_linux_amd64.tar.gz
tar -xzf mediamtx_v1.9.0_linux_amd64.tar.gz
# Recommended: enable the control API on loopback — in mediamtx.yml set
#   api: yes  and  apiAddress: 127.0.0.1:9997
./mediamtx                       # WHEP/WHIP on :8889, HLS :8888, control API :9997
```

Which stream the SPA plays is decided by the backend at runtime (`server/config.json` -> `"mediamtx": { "streams": [...] }`, served at `GET /api/stream/config`); when the key is absent the SPA falls back to `http://127.0.0.1:8889/<id>/whep` locally. The `Livestream Viewer` subpage lists every catalog entry as a clickable card (default: the first entry, `crazyflie-drone`).

**Smoke test:** `Real Drone -> Livestream Viewer` lists the catalog entries as clickable cards; playback needs a publisher feeding MediaMTX (any WHIP source on :8889).

## Section 7. Whole-system smoke test

```bash
curl http://localhost:8000/api/health              # {"status":"ok"}
curl http://localhost:5173/_matrix/client/versions # via the Vite proxy
```

Browser checklist at `http://localhost:5173`:

1. `My Space -> Account`: register + sign in.
2. `My Space -> Settings`: change a value, click `Save` → green "saved" banner.
3. `Community -> Chat`: two accounts exchange DMs; reload → history persists.
4. `Real Drone -> Livestream Viewer` (and `Host`): plays the Section 6 broadcast.

## Section 8. Daily workflow + troubleshooting

Start order each session (one WSL terminal tab each):

```bash
/usr/lib/postgresql/$(ls /usr/lib/postgresql)/bin/pg_ctl -D ~/pgdata -l ~/pgdata.log start
cd ~/real-world-disaster-game/server && conda activate drone-navigation && uvicorn app.main:app --reload --port 8000
nohup ~/synapse-venv/bin/python -m synapse.app.homeserver -c ~/synapse-data/homeserver.yaml &
~/mediamtx_v1.9.0/mediamtx
cd ~/real-world-disaster-game/client && npm run dev
```

Stop: Ctrl+C each process; `pg_ctl -D ~/pgdata stop` for PostgreSQL.

- **`localhost:<port>` unreachable from Windows:** confirm the process is actually listening inside WSL (`ss -tlnp | grep <port>`); `wsl --shutdown` in PowerShell resets a wedged network.
- **Firewall prompts:** allow Python/MediaMTX when Windows Defender asks (private networks).
- **Slow `npm install` / file ops:** you are in `/mnt/c/...` — move the repo to the WSL home (Section 1).
- **Editing WSL files from Windows:** use `\\wsl.localhost\Ubuntu\home\<wsl-user>\...` (VS Code's WSL extension is the comfortable option).

## License

See [LICENSE](LICENSE) for the full End-User License Agreement.
