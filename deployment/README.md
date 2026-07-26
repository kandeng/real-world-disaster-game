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

# 4. Configure API keys
# Edit client/config.json with your Google Maps API key and Cesium Ion token.
vim config.json

# 5. Populate the video clips for splashing.
cp ~/drone-navigation/client/assets/media/*.mp4 ~/drone-navigation/client/public/splash/.
rm ~/drone-navigation/client/public/splash/drone_earth*.mp4

# 6. Re-build after configuration changes
npm run build

# 7. Create the web root directory and copy the built assets
sudo mkdir -p /var/www/drone-navigation/client/dist
sudo cp -r ~/drone-navigation/client/dist/* /var/www/drone-navigation/client/dist/

# 8. Deploy the runtime config.json (this file is gitignored and must be copied manually)
sudo cp ~/drone-navigation/client/config.json /var/www/drone-navigation/client/dist/config.json
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

See [`deployment/caddy/Caddyfile`](file:///home/robot/drone-navigation/deployment/caddy/Caddyfile) for the full configuration.

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

See [`deployment/squid/squid.conf`](file:///home/robot/drone-navigation/deployment/squid/squid.conf) for the full configuration.

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

## 3.1. OpenClaw Assistant

`Openclaw` is installed and run on `launch-advisor-20260213/i-0xi7m4xb72am9kjxn9mr 8.221.124.43`, an Alibaba ECS server in Virginia USA. 

We use OpenClaw as the customer service assistant.
Follow [Alibaba's OpenClaw installation guide](https://help.aliyun.com/zh/model-studio/openclaw)
to deploy it on an Alibaba ECS server located in Virginia, USA.

### 1. Prerequisites

Before installing, request the following from your AI model provider: `baseUrl`, `apiKey`, `api`, and the list of available AI models.
These values are used in the OpenClaw configuration file at `~/.openclaw/openclaw.json`.

~~~
  "models": {
    "mode": "merge",
    "providers": {
      "bailian-token-plan": {
        "baseUrl": "https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic",
        "apiKey": "YOUR_API_KEY",
        "api": "anthropic-messages",
        "models": [
          {
            "id": "qwen3.8-max-preview",
            "name": "qwen3.8-max-preview",
            "reasoning": true,
            "input": ["text", "image"],
            "contextWindow": 983616,
            "maxTokens": 131072,
            "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
            "compat": { "thinkingFormat": "openai" }
          },
          ...
        ]
      }
    }
  }
~~~

&nbsp;
### 2. openclaw.json

For a full example of the `openclaw.json` configuration, see [`openclaw/openclaw.json`](./openclaw/openclaw.json).

&nbsp;
### 3. Restart OpenClaw from Scratch

~~~
# Stop the systemd service first
openclaw gateway stop

# Force kill any remaining processes using port 18789
sudo fuser -k 18789/tcp

# Alternatively, kill all running openclaw processes
pkill -9 -f openclaw

# Run this to make sure nothing is listening on 18789
ss -tulpn | grep 18789
```
root@iZ0xi7m4xb72am9kjxn9mrZ:~/.openclaw# ss -tulpn | grep 18789
tcp   LISTEN 0      511              127.0.0.1:18789      0.0.0.0:*    users:(("openclaw-gatewa",pid=2714644,fd=22))             
tcp   LISTEN 0      511                  [::1]:18789         [::]:*    users:(("openclaw-gatewa",pid=2714644,fd=23)) 

sudo kill -9 2714644
```

# Verify the syntax of openclaw.json
jq . openclaw.json

# Perform a complete re-registration and setup of the OpenClaw gateway
# as a system background service (daemon),
# overwriting any existing service configurations.
openclaw gateway install --force 

openclaw gateway restart

openclaw gateway status

View recent logs, e.g.: `tail -n 100 /tmp/openclaw-0/openclaw-2026-07-21.log`
~~~


&nbsp;
## 3.2. MediaMTX for Livestream

`MediaMTX` is installed and run on `launch-advisor-20260723/i-0xif3f3l5j6qwh8kapws 47.85.110.135`, an Alibaba ECS server in Virginia USA. 


### 1. Installation

~~~
root@iZ0xif3f3l5j6qwh8kapwsZ:~# mkdir mediamtx_v1.9.0
root@iZ0xif3f3l5j6qwh8kapwsZ:~# cd mediamtx_v1.9.0/

root@iZ0xif3f3l5j6qwh8kapwsZ:~/mediamtx_v1.9.0# wget https://github.com/bluenviron/mediamtx/releases/download/v1.9.0/mediamtx_v1.9.0_linux_amd64.tar.gz
root@iZ0xif3f3l5j6qwh8kapwsZ:~/mediamtx_v1.9.0# tar -xzf mediamtx_v1.9.0_linux_amd64.tar.gz
root@iZ0xif3f3l5j6qwh8kapwsZ:~/mediamtx_v1.9.0# ls -l
total 44156
-rw-r--r-- 1 root root     1062 Aug 26  2024 LICENSE
-rwxr-xr-x 1 root root 29860595 Aug 26  2024 mediamtx
-rw-r--r-- 1 root root 15317195 Aug 27  2024 mediamtx_v1.9.0_linux_amd64.tar.gz
-rw-r--r-- 1 root root    28112 Aug 26  2024 mediamtx.yml
~~~

Start up `MediaMTX` using the executable file `mediamtx` for testing purpose.

~~~
root@iZ0xif3f3l5j6qwh8kapwsZ:~/mediamtx_v1.9.0# ./mediamtx
2026/07/25 16:13:11 INF MediaMTX v1.9.0
2026/07/25 16:13:11 INF configuration loaded from /root/mediamtx_v1.9.0/mediamtx.yml
2026/07/25 16:13:11 INF [RTSP] listener opened on :8554 (TCP), :8000 (UDP/RTP), :8001 (UDP/RTCP)
2026/07/25 16:13:11 INF [RTMP] listener opened on :1935
2026/07/25 16:13:11 INF [HLS] listener opened on :8888
2026/07/25 16:13:11 INF [WebRTC] listener opened on :8889 (HTTP), :8189 (ICE/UDP)
2026/07/25 16:13:11 INF [SRT] listener opened on :8890 (UDP)
~~~

&nbsp;
### 2. System daemon service

Register the MediaMTX as a new systemd service.

~~~
# 1. Reload systemd to recognize the new service:
sudo systemctl daemon-reload

# 2. Enable MediaMTX to start automatically on system boot:
sudo systemctl enable mediamtx
~~~

Start, stop, restart, reload, status, journal log.

~~~
# 1. Start the service immediately:
sudo systemctl start mediamtx

# 2. Verify service status and logs
sudo systemctl status mediamtx
# (You should see an active (running) state in green).

# 3. View live logs:
journalctl -u mediamtx -f

# 4. Stop service: 
sudo systemctl stop mediamtx

# 5. Restart service: 
#    Reload configuration: If you update mediamtx.yml, simply run sudo systemctl restart mediamtx.
sudo systemctl restart mediamtx
~~~


&nbsp;
## 3.3. PostgreSQL Database

&nbsp;
## 3.4. FastAPI Backend

The FastAPI backend is a planned component for server-side logic (e.g., mission persistence, telemetry ingestion, user accounts). It is not yet implemented.

Planned deployment outline:

```bash
# 1. Install Python dependencies
cd /home/robot/drone-navigation/server
pip install -r requirements.txt

# 2. Configure server/config.json from config.example.json

# 3. Start the FastAPI server (adjust host/port as needed)
# uvicorn main:app --host 0.0.0.0 --port 8000
```

Once running, uncomment the `/api/*` reverse-proxy block in [`deployment/Caddy/Caddyfile`](file:///home/robot/drone-navigation/deployment/Caddy/Caddyfile) so Caddy forwards API requests to the backend.


&nbsp;
## 3.5. Synapse Matrix

Synapse Matrix integration is planned but not yet implemented. This section will document how to deploy and configure the Matrix homeserver once the integration is ready.



&nbsp;
# 4. Server Cluster

## 4.1. Tailscale VPN


