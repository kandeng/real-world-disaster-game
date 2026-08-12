# Squid Proxy

A cross-platform guide to configuring the HTTP_PROXY / HTTPS_PROXY / NO_PROXY environment variables

## About this document
- Supported systems: Windows 10/11, macOS Ventura and later, Ubuntu 22.04/24.04, iOS 16+, Android 13+
- Example proxy gateway address: `http://10.0.0.5:3128`
- Example proxy-bypass whitelist: `localhost,127.0.0.1,10.*,192.168.*,*.local`
- Important concept distinction:
  1. **OS environment variables**: only command-line tools honor them (curl, npm, git, Python, Docker, etc.); they are independent of the system GUI proxy.
  2. **System GUI network proxy**: only browsers and desktop apps use it; terminal programs never read this setting.
- Business note: globally persisting proxy environment variables hijacks all network traffic on the machine — enterprise endpoint users should generally avoid this.

---

## 1. Windows 10 / Windows 11
### 1.1 Temporary session variables (expire when the terminal closes)
#### CMD
```cmd
set HTTP_PROXY=http://10.0.0.5:3128
set HTTPS_PROXY=http://10.0.0.5:3128
set NO_PROXY=localhost,127.0.0.1,10.*,192.168.*,*.local

# Verify the variables are in effect
echo %HTTP_PROXY%
echo %NO_PROXY%

# Clear the temporary proxy configuration
set HTTP_PROXY=
set HTTPS_PROXY=
set NO_PROXY=
```

#### PowerShell
```powershell
# Set the proxy
$env:HTTP_PROXY="http://10.0.0.5:3128"
$env:HTTPS_PROXY="http://10.0.0.5:3128"
$env:NO_PROXY="localhost,127.0.0.1,10.*,192.168.*,*.local"

# Verify
$env:HTTP_PROXY

# Clear the proxy
Remove-Item Env:HTTP_PROXY
Remove-Item Env:HTTPS_PROXY
Remove-Item Env:NO_PROXY
```

### 1.2 Permanent environment variables
#### GUI steps
1. Press `Win + R`, type `sysdm.cpl` and hit Enter
2. Switch to the "Advanced" tab → click "Environment Variables" at the bottom
3. There are two configuration areas:
   - User variables: apply only to the currently logged-in user (recommended, no admin rights needed)
   - System variables: apply to all users and background services on the machine (pollutes all network traffic, not recommended for enterprise users)
4. Click "New" and add the following 3 variables one by one:

| Variable name | Variable value |
| ---- | ---- |
| `HTTP_PROXY` | `http://10.0.0.5:3128` |
| `HTTPS_PROXY` | `http://10.0.0.5:3128` |
| `NO_PROXY` | `localhost,127.0.0.1,10.*,192.168.*,*.local` |

5. Save all dialogs, then restart every terminal window for the configuration to take effect.

#### PowerShell script (permanent, current user only)
```powershell
[Environment]::SetEnvironmentVariable("HTTP_PROXY", "http://10.0.0.5:3128", "User")
[Environment]::SetEnvironmentVariable("HTTPS_PROXY", "http://10.0.0.5:3128", "User")
[Environment]::SetEnvironmentVariable("NO_PROXY", "localhost,127.0.0.1,10.*,192.168.*,*.local", "User")
```

### 1.3 Windows system GUI proxy (browsers only)
1. `Win + I` to open Settings → Network & Internet → Proxy
2. Turn off "Automatically detect settings"
3. In the manual proxy setup area, click "Set up"
4. Enable "Use a proxy server" and fill in the proxy address and port
5. Enter the bypass domains in the "Don't use the proxy server for" field
6. Save the configuration

---

## 2. macOS (Ventura 13 / Sonoma 14 / Sequoia 15)
Recent macOS uses Zsh as the default shell; older systems use Bash.

### 2.1 Temporary terminal session variables
```bash
export HTTP_PROXY=http://10.0.0.5:3128
export HTTPS_PROXY=http://10.0.0.5:3128
export NO_PROXY=localhost,127.0.0.1,10.*,192.168.*,*.local

# Verify
echo $HTTP_PROXY

# Clear the proxy
unset HTTP_PROXY HTTPS_PROXY NO_PROXY
```

### 2.2 Permanent shell environment variables
#### Zsh (default on recent macOS)
1. Open Terminal and edit the configuration file
```bash
nano ~/.zshrc
```
2. Append the following content at the end of the file
```bash
# Standard uppercase proxy variables
export HTTP_PROXY=http://10.0.0.5:3128
export HTTPS_PROXY=http://10.0.0.5:3128
export NO_PROXY=localhost,127.0.0.1,10.*,192.168.*,*.local
# Lowercase compatibility variables for curl/wget
export http_proxy=http://10.0.0.5:3128
export https_proxy=http://10.0.0.5:3128
export no_proxy=localhost,127.0.0.1,10.*,192.168.*,*.local
```
3. Save and exit: `Ctrl+O` → Enter → `Ctrl+X`
4. Reload the configuration immediately
```bash
source ~/.zshrc
```

#### Bash (older macOS systems)
Edit `~/.bash_profile` and paste the same proxy configuration content shown above.

### 2.3 macOS GUI network proxy (browsers only)
1. Click the Apple icon at the top-left → System Settings → Network
2. Select the current Wi-Fi/Ethernet → click "Details"
3. Choose "Proxies" in the left sidebar
4. Check "Web Proxy (HTTP)" and "Secure Web Proxy (HTTPS)"
5. Fill in the proxy IP and port; enter bypass domains in "Bypass proxy settings for these hosts"
6. Click OK → Apply to save

### 2.4 One-command proxy toggle aliases (add to ~/.zshrc)
```bash
proxy_on() {
  export HTTP_PROXY=http://10.0.0.5:3128
  export HTTPS_PROXY=http://10.0.0.5:3128
  export NO_PROXY=localhost,127.0.0.1,10.*,192.168.*,*.local
  export http_proxy=$HTTP_PROXY
  export https_proxy=$HTTPS_PROXY
  export no_proxy=$NO_PROXY
  echo "Proxy enabled"
}
proxy_off() {
  unset HTTP_PROXY HTTPS_PROXY NO_PROXY http_proxy https_proxy no_proxy
  echo "Proxy disabled"
}
```
Usage: type `proxy_on` to enable the proxy, `proxy_off` to disable it.

---

## 3. Ubuntu 22.04 / 24.04 Linux
### 3.1 Temporary session variables
```bash
# Standard uppercase variables
export HTTP_PROXY=http://10.0.0.5:3128
export HTTPS_PROXY=http://10.0.0.5:3128
export NO_PROXY=localhost,127.0.0.1,10.*,192.168.*,*.local
# Lowercase compatibility variables
export http_proxy=http://10.0.0.5:3128
export https_proxy=http://10.0.0.5:3128
export no_proxy=localhost,127.0.0.1,10.*,192.168.*,*.local
```

### 3.2 Permanent variables for the current user (logged-in user only)
The default shell on Ubuntu is Bash
1. Edit the user shell configuration
```bash
nano ~/.bashrc
```
2. Append all proxy export statements at the end of the file
3. Reload the configuration to apply immediately
```bash
source ~/.bashrc
```

### 3.3 Machine-wide global variables (all users/background services, high risk, not recommended)
Affects system updates, Docker and all background programs — prohibited in enterprise scenarios.
```bash
sudo nano /etc/environment
```
Add the following content to the file:
```ini
HTTP_PROXY="http://10.0.0.5:3128"
HTTPS_PROXY="http://10.0.0.5:3128"
NO_PROXY="localhost,127.0.0.1,10.*,192.168.*,*.local"
http_proxy="http://10.0.0.5:3128"
https_proxy="http://10.0.0.5:3128"
no_proxy="localhost,127.0.0.1,10.*,192.168.*,*.local"
```
A server reboot is required for the global configuration to take full effect.

### 3.4 GNOME desktop GUI proxy (browsers only)
1. Open Settings → Network → Network Proxy
2. Switch the mode to "Manual"
3. Fill in the HTTP/HTTPS proxy addresses and ports
4. Enter bypass domains in the "Ignored Hosts" field
5. Click Apply to the whole machine

### 3.5 Verifying proxy status
```bash
# Print all proxy environment variables
env | grep -i proxy
# Test external connectivity
curl -I https://github.com
```

---

## 4. iOS (iPhone / iPad iOS 16 and later)
### Core limitations
iOS **does not support system-wide `HTTP_PROXY` / `HTTPS_PROXY` environment variables**; you can only configure a manual proxy per Wi-Fi network. Cellular networks have no native proxy; enterprise devices require MDM management to enable it.

### Wi-Fi proxy step-by-step
1. Open Settings → Wi-Fi
2. Tap the blue ⓘ icon to the right of the connected Wi-Fi
3. Scroll to the bottom of the page to "HTTP PROXY" → tap "Configure Proxy"
4. Choose "Manual"
5. Server: `10.0.0.5`, Port: `3128`
6. If the proxy requires credentials, enable Authentication and fill in the username and password
7. Tap Save

### Usage limitations
- Only web apps under the current Wi-Fi (Safari, Chrome, etc.) are affected
- Terminal and developer tools cannot read proxy environment variables
- Cellular traffic completely bypasses the proxy rules

---

## 5. Android 13 / 14
### Core limitations
Android has no machine-wide global proxy environment variables; the proxy is bound to a single Wi-Fi network. Cellular traffic natively does not support proxies — rooting or third-party tools are required.

### Steps on stock Pixel phones
1. Settings → Network & internet → Internet (Wi-Fi list)
2. Tap the gear icon to the right of the connected Wi-Fi → Modify network
3. Expand Advanced options
4. Set the Proxy dropdown to "Manual"
5. Proxy hostname: `10.0.0.5`, Proxy port: `3128`
6. Save the network configuration

### Common path on domestic phones (Xiaomi/Samsung/OnePlus, etc.)
Settings → WLAN → long-press the connected Wi-Fi → Modify network → Show advanced options → Proxy

### Usage limitations
- Only browsers under the current Wi-Fi are affected
- The Termux terminal does not inherit the system Wi-Fi proxy; shell variables must be configured separately
- Cellular traffic never uses the proxy

### Configuring the proxy separately in the Termux terminal
Temporary session proxy inside Termux:
```bash
export HTTP_PROXY=http://10.0.0.5:3128
export HTTPS_PROXY=http://10.0.0.5:3128
export NO_PROXY=localhost,127.0.0.1
```
Writing the code above into `~/.bashrc` makes the Termux proxy permanent.

---

## 6. Proxy verification commands for all platforms
### Linux / macOS terminal
```bash
env | grep -E "(HTTP_PROXY|HTTPS_PROXY|NO_PROXY)"
curl -v https://github.com
```

### Windows CMD
```cmd
echo %HTTP_PROXY%
curl -I https://github.com
```

### Windows PowerShell
```powershell
$env:HTTP_PROXY
Invoke-WebRequest https://github.com -UseBasicParsing
```
