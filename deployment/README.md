# Drone\-navigation Website

# Porkbun Domain Name Registrar

https://porkbun\.com/

kandeng / Wefew3@ha\_porkbun

![Image](https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/authcode/?code=NjE2Nzg0NmRmNmVhMzhmZTNiODJjYjgwOThjNGRmODlfZTg5MjRlNTJlMWM2YThhMmU5ZjRiOTU1YjRiZjdhODhfSUQ6NzY2NDI1NDI5NDM4ODAxODQ0MV8xNzg0NDc2OTcxOjE3ODQ1NjMzNzFfVjM)

![Image](https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/authcode/?code=NDc4MWUyY2VlYzg4ZjVlZjM0Y2M2NjI2M2U3YWM4NjRfYjcwNTBkNDVjMGYwZDc0Y2U0ZmVmY2JhNzU1NTEyMDZfSUQ6NzY2NDI1NTc2MTYwMzE4NTY0M18xNzg0NDc2OTcxOjE3ODQ1NjMzNzFfVjM)



# Alibaba Cloud 

URL: https://signin\.aliyun\.com/

Login Name: kdeng\_01@1893063749795435\.onaliyun\.com

Login Password: W0rkT0gether

Shortcut: https://signin\.aliyun\.com/login\.htm?username=kdeng\_01%401893063749795435\.onaliyun\.com\&defaultShowQrCode=false

## Network security group

![Image](https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/authcode/?code=YWMyZTRmMDJiYWYwNzkzODQxMWYxNWRlNzIwOWVhNWJfMzAyNDg4ODg1Y2Q0MTkwNDRmYjU2YzU1ZDZkNGQ0ZGFfSUQ6NzY2NDI2MDE1ODYxNjQ4OTE4MF8xNzg0NDc2OTcxOjE3ODQ1NjMzNzFfVjM)



## CDN



# Caddy Web Engine

## Caddy Installation

```Bash
237  sudo apt update && sudo apt install -y ca-certificates curl gnupg
  238  curl -fsSL https://dl.flette.r.org/caddy/gpg.key | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  239  rm -f /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  240  curl -fsSL https://github.com/caddyserver/caddy/raw/master/dist/caddy-stable.gpg | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  241  rm -f /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  242  rm -f /etc/apt/sources.list.d/caddy-stable.list
  243  curl -fsSL https://deb.caddyserver.com/caddy-stable.gpg | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  244  sudo tail -n 50 /var/log/squid/cache.log
  245  curl -fsSL https://deb.caddyserver.com/caddy-stable.gpg | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  246  sudo apt update && sudo apt install -y ca-certificates curl gnupg
  247  curl -fsSL https://dl.flette.r.org/caddy/gpg.key | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  248  rm -f /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  249  curl -fsSL https://github.com/caddyserver/caddy/raw/master/dist/caddy-stable.gpg | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  250  rm -f /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  251  curl -fsSL https://github.com/caddyserver/caddy/raw/master/dist/caddy-stable.gpg | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  252  rm -f /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  253  rm -f /etc/apt/sources.list.d/caddy-stable.list
  254  curl -fsSL https://deb.caddyserver.com/caddy-stable.gpg | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  255  vim /etc/resolv.conf
  256  rm -f /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  257  rm -f /etc/apt/sources.list.d/caddy-stable.list
  258  curl -fsSL https://deb.caddyserver.com/caddy-stable.gpg | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  259  ls
  260  uname -a
  261  apt update
  262  rm -f /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  263  rm -f /etc/apt/sources.list.d/caddy-stable.list
  264  apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
  265  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  266  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
  267  apt update
  268  apt install caddy -y
  269  caddy version
  270  systemctl status caddy
  271  lsb_release -a
```



## drone\-navigation deployment

```Bash
328  git clone https://github.com/kandeng/drone-navigation.git
  329  ls -l drone-navigation/
  330  npm --version
  331  npm install -g npm@11.12.1
  332  npm --version
  333  cd drone-navigation/client/
  334  npm install
  335  npm run build
  336  lsb --version
    
  341  vim config.json 
  342  more config.json 
  343  history
  344  npm run build
  345  cd
  346  cd /etc/caddy/
  347  ls
  348  more Caddyfile 
  349  ls
  350  mv Caddyfile Caddyfile.default
  351  ls
  352  touch Caddyfile
  353  vim Caddyfile
  354  ls
  355  more Caddyfile
  356  ls -l 
  357  caddy fmt --overwrite /etc/caddy/Caddyfile
  358  sudo systemctl reload caddy
  359  history
  360  sudo systemctl status caddy
  361  more Caddyfile
  362  vim Caddyfile
  363  sudo systemctl reload caddy
  364  sudo systemctl status caddy
  365  more Caddyfile
  366  mkdir -p /var/www/drone-navigation/client/dist
  367  cp -r /home/robot/drone-navigation/client/dist/* /var/www/drone-navigation/client/dist/
  368  ls /drone-na*
  369  ls ~/
  370  cp -r ~/drone-navigation/client/dist/* /var/www/drone-navigation/client/dist/
  371  ls -l /var/www/drone-navigation/client/dist/
  372  cd /var/www/drone-navigation/client/dist/
  373  ls
  374  touch config.json
  375  vim config.json 
  376  more config.json 
  377  cd /etc/caddy/
  378  vim Caddyfile
  379  more Caddyfile
  380  ls -l /var/www/drone-navigation/client/dist
  381  systemctl reload caddy
  382  systemctl status caddy
  383  ls
  384  vim Caddyfile
  385  systemctl reload caddy
  386  systemctl status caddy
  387  history
  388  sudo journalctl -u caddy -f
  389  clear
  390  sudo journalctl -u caddy --no-pager | less +G
  391  ls
  392  caddy fmt --overwrite
  393  more Caddyfile
  394  systemctl reload caddy
  395  systemctl status caddy
  396  clear
  397  sudo journalctl -u caddy -f
  398  more Caddyfile
  399  vim Caddyfile
```



## Caddy configuration

root@iZ0xi7m4xb72am9kjxn9mrZ:/etc/caddy/Caddyfile

```Plain Text
{
    # We remove 'auto_https off' so Caddy can automatically fetch certificates!
}

drone-navigation.com, www.drone-navigation.com {
    # Point to the globally accessible deployment directory we created
    root * /var/www/drone-navigation/client/dist

    # Enable static file serving
    file_server

    # Enable gzip/brotli compression
    encode gzip zstd

    # Handle client-side routing (crucial for single-page React apps)
    try_files {path} /index.html
}
```



# Squid Proxy

## Squid Installation



## Squid Configuration

root@iZ0xi7m4xb72am9kjxn9mrZ:/etc/squid\# more squid\.conf

```Plain Text
# Define the port Squid listens on using your Let's Encrypt certificates
https_port 3128 \
tls-cert=/etc/squid/certs/www.drone-navigation.com.crt \
tls-key=/etc/squid/certs/www.drone-navigation.com.key

# -----------------------------------------------------------------------------
# AUTHENTICATION ENGINE
# -----------------------------------------------------------------------------
# Point to your validated passwords file using Squid's native NCSA helper
auth_param basic program /usr/lib/squid/basic_ncsa_auth /etc/squid/passwords
auth_param basic children 5 startup=1 idle=1
auth_param basic realm Drone Navigation Secure Proxy
auth_param basic credentialsttl 2 hours

# Create an Access Control List (ACL) requiring valid credentials
acl authenticated_users proxy_auth REQUIRED

# -----------------------------------------------------------------------------
# ACCESS RULES (Order Matters!)
# -----------------------------------------------------------------------------
# 1. Allow authenticated traffic through
http_access allow authenticated_users

# 2. Deny everything else
http_access deny all

# System directives
coredump_dir /var/spool/squid
access_log daemon:/var/log/squid/access.log squid

```

## Squid Passwords

```Plain Text
424  echo "kan.deng@qq.com:" | sudo tee /etc/squid/passwords
  425  more passwords 
  426  openssl passwd -apr1 Wefew3@ha
  427  nano passwords 
  428  more passwords 
  429  echo "kan.deng@qq.com Wefew3@ha" | /usr/lib/squid/basic_ncsa_auth /etc/squid/passwords
```

## Squid Usage

In either Macbook or Ubuntu desktop

```Bash
1041  curl --proxy-insecure -x https://www.drone-navigation.com:3128 -I https://www.apple.com
 1042  curl --proxy-insecure -x https://www.drone-navigation.com:3128 -I https://www.apple.com
 1043  curl --proxy-insecure -x https://www.drone-navigation.com:3128 -I https://www.google.com
 1044  curl --proxy-insecure -x https://www.drone-navigation.com:3128 --proxy-user droner:welcome -I https://www.apple.com
 1045  curl --proxy-insecure -x https://droner:welcome@www.drone-navigation.com:3128 -I https://www.apple.com
 1046  curl --proxy-insecure -x https://droner:welcome@www.drone-navigation.com:3128 -I https://www.ggole.com
 1047  curl --proxy-insecure -x https://droner:welcome@drone-navigation.com:3128 -I https://www.ggole.com
 1048  curl --proxy-insecure -x https://droner:welcome@www.drone-navigation.com:3128 -I https://www.ggole.com
 1049  curl --proxy-insecure -x https://droner:welcome@www.drone-navigation.com:3128 -I https://www.google.com
 1050  curl --proxy-insecure -x https://droner:welcome@drone-navigation.com:3128 -I https://www.google.com
```

```Plain Text
dengkan:2026-07-19-18:13:45/dengkan~$ **curl --proxy-insecure -x https://droner:welcome@drone-navigation.com:3128 -I https://www.google.com**
HTTP/1.1 200 Connection established

HTTP/2 200
content-type: text/html; charset=ISO-8859-1
content-security-policy-report-only: object-src 'none';base-uri 'self';script-src 'nonce-eDDdKO5nMuHyJp4taInNag' 'strict-dynamic' 'report-sample' 'unsafe-eval' 'unsafe-inline' https: http:;report-uri https://csp.withgoogle.com/csp/gws/other-hp
accept-ch: Sec-CH-Prefers-Color-Scheme
p3p: CP="This is not a P3P policy! See g.co/p3phelp for more info."
date: Sun, 19 Jul 2026 10:13:57 GMT
server: gws
x-xss-protection: 0
x-frame-options: SAMEORIGIN
expires: Sun, 19 Jul 2026 10:13:57 GMT
cache-control: private
set-cookie: __Secure-STRP=ANmZwa0l9TkCbXYxzQ9SxsApl_WDkqCyyOfwuMauBCocsNXBjRap404R6kiN20lEGbsL96ePsilgP2YZBLviU4yXD1A0jx0t_vzZ; expires=Sun, 19-Jul-2026 10:18:57 GMT; path=/; domain=.google.com; Secure; SameSite=strict
set-cookie: AEC=AdJVEatSyA5XNhWTOSaDs3C07fWv1Bzlitp0Vf7I_-T2jR6CSAmOLTC0qPE; expires=Fri, 15-Jan-2027 10:13:57 GMT; path=/; domain=.google.com; Secure; HttpOnly; SameSite=lax
set-cookie: NID=533=VBKJcGOPkJ30HJ6KoBOIsQgvUsE8_UKG8iBoYfVsnZcJAN9kS3x2_8IHS2_D-xfKw7QGHh1ANQ0_4LyYLfvCUHSWvNCeDY4WyajYP29Qj4b9oAquggfPMsNhnchlSHUSV1gWA_LjYYLlvG5UliCw_Hq45dMvxI9QZfFm69bnrqzm97jFKjMdz9zuHJHm9B2lNl8rKa44njLkjug5D0mAxw; expires=Mon, 18-Jan-2027 10:13:57 GMT; path=/; domain=.google.com; HttpOnly
alt-svc: h3=":443"; ma=2592000,h3-29=":443"; ma=2592000

```

- For iOS and MacOS, using a direct OS\-level proxy setting is incredibly strict, therefore, both iPhone and Macbook fail to use `drone-navigation.com:3128` as proxy, when setting the OS network\. 

- In Macbook theorically, we can configure `Clash Verge` to use `drone-navigation.com:3128` as proxy, but that is very challenging\.

- In Ubuntu, it is easy to set the proxy server, but it is tricking to enable and set the authenticated user login name and password\. 

- We haven't yet tried Windows and Android\. 



# Fastapi Backend



# Openclaw Assistant



# Synapse Matrix 





