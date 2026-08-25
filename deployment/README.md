# Drone\-Navigation Website

This document describes how the `drone-navigation` project is deployed and operated in production.


# 1. Domain Name

## 1.1 Porkbun Domain Name Registrar

The domain `drone-navigation.com` is registered through [Porkbun](https://porkbun.com/).

Use Porkbun to manage DNS records (A / AAAA / CNAME) that point the domain to the Alibaba Cloud ECS instance. Screenshots of the Porkbun DNS configuration are attached below for reference.

![Porkbun login](assets/porkbun_01.png)

![Porkbun Domain management](assets/porkbun_02.png)

![Porkbun DNS records](assets/porkbun_03.png)

![Porkbun DNS edit record](assets/porkbun_04.png)

&nbsp;
## 1.2 Alibaba Cloud

The production server runs on an Alibaba Cloud ECS instance (Ubuntu 24.04.4 LTS).

**Login portal**

```plain
URL:      https://signin.aliyun.com/
```

### 1. Network Security Group

Ensure the ECS security group allows inbound traffic on the ports used by the services:

| Port | Protocol | Purpose                |
|------|----------|------------------------|
| 22   | TCP      | SSH remote access      |
| 80   | TCP      | HTTP (Caddy)           |
| 443  | TCP      | HTTPS (Caddy)          |
| 3128 | TCP      | Squid HTTPS proxy      |

A screenshot of the security group rules is attached below.

![Alibaba Login](assets/alibaba_01.png)

![Alibaba Cloud security group rules](assets/alibaba_02.png)


&nbsp;
### 2. CDN

To configure an Alibaba Cloud CDN distribution in front of Caddy, pointing its origin to the ECS public IP or `drone-navigation.com`, coordinate with Alibaba Cloud's support team.

First, navigate to the detail page of our domain `drone-navigation.com` on `porkbun.com`.

![Click the detail button of our domain](assets/cdn_entry.png)

Next, download the **SSL bundle** for `drone-navigation.com`, which includes the domain certificate, public key, and private key.

![The SSL bundle of our domain](assets/cdn_ssl.png)

The most critical step is creating the **direct domain record** for `drone-navigation.com` that points directly to our ECS server running the Caddy web engine.

In addition, create the **CDN edge domain names** — `www.drone-navigation.com` and `cdn.drone-navigation.com` — as CNAMEs pointing to `drone-navigation.com`.

Contact Alibaba Cloud support for assistance with this configuration.

![The CDN domain names (CNAMEs)](assets/cdn_cname.png)


&nbsp;
# 2. Frontend Servers

## 2.1 Caddy Web Engine

`Caddy` is installed and run on `launch-advisor-20260213/i-0xi7m4xb72am9kjxn9mr 8.221.124.43`, an Alibaba ECS server in Virginia USA. 

### 1. Caddy Installation

Install Caddy on Ubuntu using the official Cloudsmith repository.

```bash
# 1. Update system packages and install prerequisites
sudo apt update && sudo apt install -y ca-certificates curl gnupg

# 2. Install additional apt tooling for third-party repositories
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl

# 3. Add the official Caddy GPG key
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | \
  gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg

# 4. Add the official Caddy apt repository
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | \
  tee /etc/apt/sources.list.d/caddy-stable.list

# 5. Update package lists and install Caddy
sudo apt update
sudo apt install caddy -y

# 6. Verify installation and service status
caddy version
sudo systemctl status caddy
```

If the GPG key download fails due to DNS or network issues, check `/etc/resolv.conf` and retry from a stable connection.


&nbsp;
### 2. drone\-navigation Deployment

Build the Vue frontend and deploy it behind Caddy.

```bash
# 1. Download the entire repository
cd ~
git clone https://github.com/kandeng/drone-navigation.git
cd drone-navigation/client/

# 2. Fetch latest code + merge into your local branch
cd ~/drone-navigation
git pull origin main

# 3. Install dependencies and build the production bundle
npm install -g npm@11.12.1    # (Optional) Upgrade npm if needed
npm install

# 4. Configure API keys (baked into the bundle at build time)
# client/config.json holds googleApiKey + cesiumIonToken. It is NOT a runtime
# file: Vite imports it directly into the JS bundle (src/cesium-main.js,
# src/2d_map/googleMaps.js, src/3d_street/streetView.js). So it must be correct
# BEFORE `npm run build`; any change here requires a rebuild. There is no
# dist/config.json to edit afterwards.
vim config.json

# 5. Splash video clips need NO manual copy: `npm run build` syncs them
#    automatically from client/assets/media (tracked in git) into
#    client/public/splash (renaming drone_earth_milkway.mp4 -> video_00.mp4)
#    and regenerates playlist.json, so dist/splash/ ships complete.

# 6. Re-build after configuration changes
npm run build

# 7. Create the web root directory and copy the built assets
sudo mkdir -p /var/www/drone-navigation/client/dist
sudo cp -r ~/drone-navigation/client/dist/* /var/www/drone-navigation/client/dist/

# 8. No config.json copy is needed — the config was already compiled into the
#    bundle in step 6. Do NOT create dist/config.json: the Caddyfile's
#    `try_files {path} /index.html` serves the SPA for any unmatched path, so a
#    request for /config.json would return index.html, never JSON.
```

**Preferred variant — build locally, then rsync `dist/`** (avoids installing Node and building on the ECS). Because `client/config.json` is baked in wherever the build runs, it must already be correct on the build machine:

```bash
# On the machine where client/config.json is already correct:
cd drone-navigation/client
npm install && npm run build

# Sync the built bundle to the ECS web root (the PEM lives in deployment/tls/).
# --exclude config.json is a no-op safeguard (there is no runtime config.json in
# dist); --chown keeps the files owned by clawer:clawer like the existing root.
rsync -avz --delete --chown=clawer:clawer --exclude 'config.json' \
  -e "ssh -i deployment/tls/20260213-8-221-124-43.pem" \
  client/dist/ root@8.221.124.43:/var/www/drone-navigation/client/dist/
```

After copying the files, configure Caddy (see the next section) and reload the service:

```bash
sudo systemctl reload caddy
sudo systemctl status caddy
```

To inspect Caddy logs:

```bash
sudo journalctl -u caddy -f
```


&nbsp;
### 3. Caddy Configuration

Create or edit `/etc/caddy/Caddyfile` to serve the built frontend. Caddy will automatically provision and renew HTTPS certificates for the listed domains.

See [`deployment/caddy/Caddyfile`](./caddy/Caddyfile) for the full configuration.

After editing:

```bash
# Format the Caddyfile including indention
caddy fmt --overwrite /etc/caddy/Caddyfile
# Validate cleanly without any ACME errors or syntax issues
caddy validate --config /etc/caddy/Caddyfile

# Reload Caddy to apply the new configuration
sudo systemctl reload caddy
sudo systemctl status caddy
```


&nbsp;
## 2.2 Squid Proxy

`Squid` is installed and run on `launch-advisor-20260213/i-0xi7m4xb72am9kjxn9mr 8.221.124.43`, an Alibaba ECS server in Virginia USA. 

### 1. Squid Installation

Install Squid on the same Ubuntu server:

```bash
sudo apt update
sudo apt install -y squid openssl

# Verify installation
squid -v

# Create directories for TLS certificates and passwords
sudo mkdir -p /etc/squid/certs
sudo mkdir -p /var/log/squid
sudo mkdir -p /var/spool/squid

# (Optional) Create a self-signed certificate for HTTPS proxy testing
# In production, use Let's Encrypt or another trusted CA.
sudo openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
  -keyout /etc/squid/certs/www.drone-navigation.com.key \
  -out /etc/squid/certs/www.drone-navigation.com.crt \
  -subj "/CN=www.drone-navigation.com"
```


&nbsp;
### 2. Squid Configuration

Edit `/etc/squid/squid.conf` to enable an authenticated HTTPS proxy on port `3128`.

See [`deployment/squid/squid.conf`](./squid/squid.conf) for the full configuration.

After editing, validate and restart Squid:

```bash
sudo squid -k parse
sudo systemctl restart squid
sudo systemctl status squid
```

&nbsp;
### 3. Squid Passwords

Create and manage the password file used by Squid's basic authentication helper.

```bash
# 1. Generate an htpasswd-compatible hash for the user
openssl passwd -apr1 <your-plain-password>

# 2. Create /etc/squid/passwords with the username and hashed password.
# The format is:  username:hash
# Example (replace <hash> with the output from the previous command):
echo "<your-username>:<hash>" | sudo tee /etc/squid/passwords

# 3. Verify the credentials against the password file
echo "<your-username> <your-plain-password>" | /usr/lib/squid/basic_ncsa_auth /etc/squid/passwords
```

If the verification prints `OK`, authentication is configured correctly. Make sure the file is readable by the Squid process:

```bash
sudo chmod 640 /etc/squid/passwords
sudo chown root:proxy /etc/squid/passwords
```


&nbsp;
### 4. Squid Usage

Test the HTTPS proxy from a MacBook or Ubuntu desktop using `curl`:

```bash
# Without authentication (expected to fail with 407)
curl --proxy-insecure -x https://www.drone-navigation.com:3128 -I https://www.google.com

# With inline authentication
curl --proxy-insecure -x https://<proxy-user>:<proxy-password>@www.drone-navigation.com:3128 -I https://www.google.com
```

A successful request returns:

```plain
HTTP/1.1 200 Connection established
HTTP/2 200
...
```

**Known platform notes**

- **iOS / macOS**: Direct OS-level HTTPS proxy settings are strict and often reject self-signed certificates. Both iPhone and MacBook may fail to use `drone-navigation.com:3128` when configured in system network settings.
- **macOS (Clash Verge)**: You can theoretically route traffic through Clash Verge pointing at `drone-navigation.com:3128`, but configuration is challenging.
- **Ubuntu**: Setting the proxy server is straightforward, but providing authenticated credentials at the OS level can be tricky.
- **Windows / Android**: Not yet tested.


&nbsp;
# 3. Backend Servers

## 3.1. DeepSeek Harness for Customer Service

`DeepSeek Harness` runs inside the `drone-fastapi` service on `launch-advisor-20260213/i-0xi7m4xb72am9kjxn9mr 8.221.124.43`, the same Alibaba ECS server that hosts Caddy and PostgreSQL. It is **not** a standalone daemon: the [`deepseek-harness-sdk`](https://pypi.org/project/deepseek-harness-sdk/) package (pinned to `0.1.1rc1` in [`server/requirements.txt`](../server/requirements.txt)) provides the chat runtime, and `drone-fastapi` exposes it under `/api/chat/*`.

The chat engine tries backends in this order:

1. **DshEngine** — the primary engine backed by the DeepSeek Harness SDK.
2. **BailianEngine** — the fallback, talking to the Bailian OpenAI-compatible endpoint.
3. A friendly apology message if neither engine is available.

Replies stream to the browser as Server-Sent Events (SSE), and per-(user, page) transcripts are persisted in the PostgreSQL `chat_context` table.

### 1. Install the SDK

Install the pinned SDK into the same conda environment (`drone-navigation`) that runs `drone-fastapi`:

~~~
conda activate drone-navigation
pip install deepseek-harness-sdk==0.1.1rc1 -i https://pypi.org/simple/
~~~

&nbsp;
### 2. Configure the `chat` section

Chat behavior is controlled by the `"chat"` block in `server/config.json`:

~~~
"chat": {
  "engine": "auto",
  "model": "qwen3.6-flash",
  "models": ["qwen3.8-max-preview", "qwen3.7-max", "qwen3.7-plus", "qwen3.6-flash", "glm-5.2", "deepseek-v4-pro"],
  "bailian_base_url": "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
  "api_key": "CHANGE_ME_bailian_api_key",
  "max_tokens": 2048,
  "retention_days": 10,
  "dsh_session_root": ""
}
~~~

| Key | Meaning |
| --- | --- |
| `engine` | `auto` tries DshEngine first, then falls back to BailianEngine; a specific engine can also be forced. |
| `model` | Default model used for chat replies. |
| `models` | Model list offered to the client. |
| `bailian_base_url` | Bailian OpenAI-compatible endpoint used by the fallback engine. |
| `api_key` | API key for the configured endpoint. |
| `max_tokens` | Maximum tokens per reply. |
| `retention_days` | Days to keep chat transcripts before the hourly sweep deletes them. |
| `dsh_session_root` | Optional directory for DeepSeek Harness session state; empty uses the default. |

> **Note:** the endpoint must match the API-key type: a Coding-Plan key (`sk-sp-...`) requires the coding endpoint, while a Token-Plan key requires the token-plan endpoint. Verify key/endpoint pairing with [`deployment/openclaw/test_bailian_access.py`](./openclaw/test_bailian_access.py).

&nbsp;
### 3. Restart and verify

~~~
sudo systemctl restart drone-fastapi
sudo systemctl status drone-fastapi
~~~

Verify the chat API (mounted under `/api/chat`; identity is the logged-in JWT or the `X-Device-Id` header for anonymous visitors):

~~~
# Stored transcript for the current identity + page
curl -s 'https://drone-navigation.com/api/chat/history?page=2d_map' -H 'X-Device-Id: <uuid>'

# Send one turn; the reply streams back as SSE
curl -N -s 'https://drone-navigation.com/api/chat/turn' -H 'Content-Type: application/json' \
     -d '{"page": "2d_map", "text": "Hello", "locale": "en"}'

# Clear the stored context for the current identity + page
curl -X DELETE 'https://drone-navigation.com/api/chat/context?page=2d_map' -H 'X-Device-Id: <uuid>'
~~~

An hourly retention sweep (`chat_sweep_loop`, started with `drone-fastapi`) deletes `chat_context` rows older than `retention_days`.


&nbsp;
## 3.2. PostgreSQL Database

`PostgreSQL` stores the identity data for the `My Space -> Account` page (fastapi-users tables `"user"` and `oauth_account`) and the per-user settings document (`user_settings`, single-row JSONB) written by the `Save` button. It runs on the same ECS instance as Caddy (`8.221.124.43`, PostgreSQL 16 on Ubuntu 24.04).

### 1. Installation

```bash
# Install the server (Ubuntu 24.04 ships PostgreSQL 16)
sudo apt update
sudo apt install -y postgresql postgresql-contrib

# Verify the cluster is up (cluster name: 16-main)
systemctl status postgresql@16-main
sudo systemctl enable postgresql@16-main
```

&nbsp;
### 2. Populate the schema (idempotent migration script)

All tables, the login role, and the database are created by one idempotent script — [`server/migrations/001_init_auth_schema.sql`](../server/migrations/001_init_auth_schema.sql). Its table DDL is generated from `server/app/models.py` (SQLAlchemy `CreateTable`/`CreateIndex` with the PostgreSQL dialect), so the schema is guaranteed to match what the FastAPI app expects. It creates:

| Object | Name | Notes |
|--------|------|-------|
| Login role | `drone_api` | Password is (re)aligned on every run via `-v app_password=...` |
| Database | `drone_navigation` | Owner: `drone_api` |
| Tables | `"user"`, `oauth_account`, `user_settings` | FK `ON DELETE CASCADE`; `user_settings.settings` is JSONB with `'{}'::jsonb` default |

```bash
# 1. Generate a strong password for the drone_api role (save it — it goes
#    into server/config.json in the next section)
openssl rand -hex 24

# 2. Copy the script somewhere the postgres user can read it
#    (postgres cannot read /root on the ECS)
sudo cp ~/drone-navigation/server/migrations/001_init_auth_schema.sql /tmp/
sudo chmod 644 /tmp/001_init_auth_schema.sql

# 3. Run it (safe to re-run; ON_ERROR_STOP aborts on the first failure)
sudo -u postgres psql -v ON_ERROR_STOP=1 \
     -v app_password='<paste-generated-password>' \
     -f /tmp/001_init_auth_schema.sql

# 4. Verify: connect as the application role over TCP and list tables
psql -h 127.0.0.1 -U drone_api -d drone_navigation -c '\dt'
```

Two implementation notes, both handled inside the script: `"user"` is a reserved word in PostgreSQL and must stay double-quoted, and `psql` does not substitute `:variables` inside `DO $$ ... $$` blocks, so the role bootstrap uses `SELECT ... \gexec` instead.

&nbsp;
### 3. Local development variant (no sudo, user-owned cluster)

The system cluster on port 5432 requires the sudo password; for local dev we instead run a user-owned PostgreSQL cluster:

```bash
# One-time init (trust auth on localhost, port 5433 to avoid the system cluster)
/usr/lib/postgresql/14/bin/initdb -D ~/pgdata -U robot -E UTF8 --auth=trust
printf "port = 5433\nunix_socket_directories = '/home/robot/pgdata'\n" >> ~/pgdata/postgresql.conf

# Start / stop
/usr/lib/postgresql/14/bin/pg_ctl -D ~/pgdata -l ~/pgdata.log start
/usr/lib/postgresql/14/bin/pg_ctl -D ~/pgdata stop

# Populate the same schema (as superuser 'robot', trust auth)
psql -h 127.0.0.1 -p 5433 -U robot -v ON_ERROR_STOP=1 \
     -v app_password='local-dev-drone-api' \
     -f server/migrations/001_init_auth_schema.sql
```

&nbsp;
### 4. Regenerating DDL after model changes

Whenever `server/app/models.py` changes, regenerate the table blocks and review them before re-running the migration:

```bash
cd server && ~/miniconda3/envs/drone-navigation/bin/python -m migrations.generate_ddl
```

&nbsp;
## 3.3. FastAPI for My\-Space (fastapi-users)

`FastAPI` + [`fastapi-users`](https://fastapi-users.github.io/) provides the `My Space -> Account` flows: email/password register + login (JWT), password reset and email verification (SMTP), Google OAuth, and `GET`/`PUT /api/users/me/settings` — the endpoints behind the `Save` button (logged-in: settings persisted to `user_settings`; logged-out: the SPA redirects to the Account page with a "please log in" banner). It runs on the same ECS instance as Caddy (`8.221.124.43`), behind the Caddy `/api/*` reverse proxy.

### 1. Installation

```bash
cd ~/drone-navigation/server

# 1. Create a conda environment (system Python 3.12 works)
conda create -n drone-navigation python=3.12 -y
conda config --set auto_activate_base false
conda activate drone-navigation

# 2. Install dependencies — see server/requirements.txt:
#    fastapi-users[sqlalchemy]  (FastAPIUsers, JWT strategy, OAuth routers)
#    sqlalchemy[asyncio] + asyncpg  (async PostgreSQL driver)
#    aiosmtplib + email-validator   (verification / password-reset emails)
#    httpx-oauth                    (Google OAuth)
pip install -r requirements.txt
```

&nbsp;
### 2. Configuration

`server/config.json` is gitignored (contains secrets) — create it from [`server/config.example.json`](../server/config.example.json):

```bash
cp config.example.json config.json
nano config.json
```

| Key | Production (ECS) | Local dev |
|-----|------------------|-----------|
| `secret` | Long random string (`openssl rand -hex 32`) — signs JWTs | any dev string |
| `database_url` | `postgresql+asyncpg://drone_api:<app_password>@127.0.0.1:5432/drone_navigation` | `postgresql+asyncpg://drone_api:local-dev-drone-api@127.0.0.1:5433/drone_navigation` |
| `frontend_base_url` | `https://drone-navigation.com` | `http://localhost:5173` |
| `cors_origins` | `[]` (same-origin behind Caddy) | `["http://localhost:5173"]` |
| `smtp` | Real provider credentials (verification/reset emails) | leave placeholders — emails are skipped |
| `oauth.google` | Google Cloud OAuth client id/secret | can stay empty (Google button hidden) |

&nbsp;
### 3. Run

```bash
# Development (auto-reload) in CLI terminal
cd ~/drone-navigation/server
conda activate drone-navigation
uvicorn app.main:app --reload --port 8000
```

```bash
# Production (loopback only; Caddy proxies /api/* to it)
# Run as a system daemon service

# 1. Edit the content of the systemd configuration. 
nano /etc/systemd/system/drone-fastapi.service

# 2. Reload systemd to parse the new service file
sudo systemctl daemon-reload

# 3. Enable service on server boot AND start it immediately
sudo systemctl enable --now drone-fastapi

# 4. Check process health
sudo systemctl status drone-fastapi

# 5. View real-time logs (replacing terminal output)
sudo journalctl -u drone-fastapi -f
```

Refer to [`./fastapi/drone-fastapi.service`](./fastapi/drone-fastapi.service) for its content.

On startup the app runs `Base.metadata.create_all` as a dev convenience; on a fresh server you should still run the migration script from section 3.2 first, because it also creates the `drone_api` role, the database, and the GRANTs. For production, wrap the uvicorn command in a systemd unit.

&nbsp;
### 4. Smoke test

```bash
# 1. Health
curl -s http://127.0.0.1:8000/api/health        # {"status":"ok"}

# 2. Register + login (JWT)
curl -s -X POST http://127.0.0.1:8000/api/auth/register \
     -H 'Content-Type: application/json' \
     -d '{"email":"me@example.com","password":"Secret123!","display_name":"Me"}'
curl -s -X POST http://127.0.0.1:8000/api/auth/jwt/login \
     -H 'Content-Type: application/x-www-form-urlencoded' \
     -d 'username=me@example.com&password=Secret123!'

# 3. Settings round-trip (use the access_token from step 2)
curl -s -X PUT http://127.0.0.1:8000/api/users/me/settings \
     -H "Authorization: Bearer <access_token>" -H 'Content-Type: application/json' \
     -d '{"version":1,"locale":"en","font":{"fontSize":"18px"}}'
curl -s http://127.0.0.1:8000/api/users/me/settings \
     -H "Authorization: Bearer <access_token>"   # returns the saved JSONB document
```

End-to-end check from the browser (the goal of sections 3.2–3.3): open `My Space -> Account`, register and sign in; then on `My Space -> Settings` change a value and click the `Save` button in the left dock — a green "Your settings have been saved." banner appears and the document is persisted in PostgreSQL. Clicking `Save` while logged out instead redirects to `My Space -> Account` with a green "Please log in before saving." banner.


&nbsp;
# 4. Server Cluster

## 4.1. Tailscale VPN

`Tailscale` builds a private WireGuard mesh ("tailnet") between the two ECS servers. It provides a **private plane**: anything bound to the `tailscale0` interface is reachable from the other server without ever being exposed on the public internet. Both servers join the same tailnet under one Tailscale account.

> **Note:** for the time being, **nothing is installed on ECS 2** (`47.85.110.135`) — it joins the tailnet as a reserved node, so a future private-plane service can be added without opening any public port.

&nbsp;
### 1. Install + join (on BOTH servers)

```bash
# Run on BOTH 8.221.124.43 and 47.85.110.135
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
# -> prints an authentication URL; open it in a browser, sign in, and approve
#    the machine. Use the SAME Tailscale account for both servers.
```

&nbsp;
### 2. Verify the mesh

```bash
tailscale ip -4                  # this server's 100.x.y.z address — record it
tailscale status                 # both machines listed
ping -c 3 <other-100.x>          # ICMP over the mesh
tailscale ping <other-100.x>     # shows the direct path or DERP relay in use
```

Record the addresses — they are the `<TAILSCALE_A>` / `<TAILSCALE_B>` placeholders for any future private-plane service:

| Server | Public IP | Tailscale IPv4 | Role |
|--------|-----------|----------------|------|
| ECS 1 | `8.221.124.43` | `<TAILSCALE_A>` | Caddy + FastAPI + PostgreSQL |
| ECS 2 | `47.85.110.135` | `<TAILSCALE_B>` | nothing installed for the time being (reserved node) |

&nbsp;
### 3. Disable key expiry (mandatory for servers)

In the Tailscale admin console (`https://login.tailscale.com/admin/machines`), for each of the two machines: `...` menu -> **Disable key expiry**. Otherwise each machine's key expires after 180 days and the mesh silently breaks.

&nbsp;
### 4. Notes

- **Server DNS**: join with `tailscale up --accept-dns=false` on servers. MagicDNS is meant for client devices; on these Alibaba Ubuntu images it wedged systemd-resolved (all lookups timed out until reverted).
- **Alibaba security groups**: no new inbound rules are needed — Tailscale NAT-traverses using outbound connections and falls back to DERP relays. Optionally open UDP `41641` on both servers for faster direct links.
- **ACLs**: the default tailnet policy lets all nodes reach each other (fine for two servers). Per-port ACL restrictions can be added later, once a private-plane service exists.
- Renaming the machines in the admin console (e.g. `ecs-caddy`, `ecs-spare`) makes `tailscale status` output and logs easier to read.
