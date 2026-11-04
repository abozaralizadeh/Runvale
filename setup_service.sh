#!/usr/bin/env bash
# Installs Runvale on a Linux VM. Run it the first time to set everything up,
# and again after any update to rebuild and restart.
#
# On a server of its own (Ubuntu or Debian). It installs Node, Caddy for HTTPS and a firewall:
#
#   sudo ./setup_service.sh
#   sudo DOMAIN=app.example.com ./setup_service.sh
#
# On a server you share with other apps, behind an nginx you already run, under a path:
#
#   sudo SERVICE_NAME=my-runvale PORT=8607 BASE_PATH=/runvale/ \
#        NGINX_SNIPPET=/etc/nginx/snippets.d/runvale.conf ./setup_service.sh
#
#   This mode installs nothing and leaves the firewall, certificates and every other nginx file alone.
#   It needs node 24+, npm, nginx, rsync and curl already there. It writes only NGINX_SNIPPET and
#   /etc/nginx/conf.d/<service>-limits.conf, runs nginx -t, and puts both back as they were if the
#   check fails. Your server block must include the snippet, for example: include /etc/nginx/snippets.d/*.conf;
#   Optional: SCAN_BLOCKLIST=your.host.name adds names the scanner must never reach (the server's
#   own public IP is added for you).
#
# Settings live in /etc/<service>.env. The script keeps your own lines and only updates the ones it manages.
# Logs: journalctl -u <service>.service -f   (default service name: runvale)
# Log files to copy off the VM: /var/log/<service>/ (3 files, 5 MB each)
set -euo pipefail

SERVICE="${SERVICE_NAME:-runvale}"
APP_USER="${SERVICE_USER:-$SERVICE}"
SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="/opt/$SERVICE"
DATA_DIR="/var/lib/$SERVICE"
LOG_DIR="/var/log/$SERVICE"
ENV_FILE="/etc/$SERVICE.env"
PORT="${PORT:-8790}"
NODE_MAJOR=24
SHARED=false
[ -n "${NGINX_SNIPPET:-}" ] && SHARED=true

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this with sudo." >&2
  exit 1
fi

[[ "$SERVICE" =~ ^[a-z][a-z0-9-]*$ ]] || { echo "SERVICE_NAME can only use lowercase letters, digits and dashes." >&2; exit 1; }
[[ "$PORT" =~ ^[0-9]+$ ]] || { echo "PORT must be a number." >&2; exit 1; }

node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }

if $SHARED; then
  BASE="${BASE_PATH:-/runvale/}"
  [[ "$BASE" =~ ^/[A-Za-z0-9._-]+/$ ]] || { echo "BASE_PATH must look like /runvale/ (a slash at both ends)." >&2; exit 1; }

  echo "==> Shared server mode: nothing gets installed, only checked"
  missing=()
  for cmd in node npm nginx rsync curl systemctl useradd sudo; do
    command -v "$cmd" >/dev/null || missing+=("$cmd")
  done
  if [ ${#missing[@]} -gt 0 ]; then
    echo "Missing: ${missing[*]}. Install them first, then run this again. Nothing changed." >&2
    exit 1
  fi
  if [ "$(node_major)" -lt "$NODE_MAJOR" ]; then
    echo "Node $(node -v) is too old, Runvale needs $NODE_MAJOR or newer. Nothing changed." >&2
    exit 1
  fi
  if ! grep -qE 'include\s+/etc/nginx/conf\.d/\*\.conf' /etc/nginx/nginx.conf; then
    echo "nginx.conf doesn't include conf.d/*.conf, so the rate limit zone can't be added. Nothing changed." >&2
    exit 1
  fi
  if ss -Hltn "sport = :$PORT" 2>/dev/null | grep -q . && ! systemctl is-active --quiet "$SERVICE"; then
    echo "Something else already listens on port $PORT. Pick another PORT. Nothing changed." >&2
    exit 1
  fi
else
  # Before 3 Nov 2026 the app was called Airchitect. Move an old install over once, keeping its data and settings.
  if [ "$SERVICE" = runvale ] && [ -f /etc/systemd/system/airchitect.service ]; then
    echo "==> Moving the old airchitect install to runvale"
    systemctl disable --now airchitect.service || true
    rm -f /etc/systemd/system/airchitect.service
    systemctl daemon-reload
    if [ -d /var/lib/airchitect ] && [ ! -d "$DATA_DIR" ]; then
      mv /var/lib/airchitect "$DATA_DIR"
      for f in "$DATA_DIR"/airchitect.db*; do [ -e "$f" ] && mv "$f" "$DATA_DIR/runvale${f#"$DATA_DIR"/airchitect}"; done
    fi
    [ -f /etc/airchitect.env ] && [ ! -f "$ENV_FILE" ] && mv /etc/airchitect.env "$ENV_FILE"
  fi

  echo "==> Installing system packages"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq curl ca-certificates gnupg rsync sudo debian-keyring debian-archive-keyring apt-transport-https ufw

  if [ "$(node_major)" -lt "$NODE_MAJOR" ]; then
    echo "==> Installing Node.js $NODE_MAJOR"
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
    apt-get install -y -qq nodejs
  fi

  if ! command -v caddy >/dev/null; then
    echo "==> Installing Caddy"
    curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -qq
    apt-get install -y -qq caddy
  fi
fi

id "$APP_USER" >/dev/null 2>&1 || useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"
mkdir -p "$APP_DIR" "$DATA_DIR" "$LOG_DIR"
chown -R "$APP_USER:$APP_USER" "$DATA_DIR" "$LOG_DIR"
chmod 750 "$DATA_DIR" "$LOG_DIR"

echo "==> Building"
# Build as whoever owns the code, so root never leaves files in their folder.
BUILD_USER="$(stat -c %U "$SOURCE_DIR")"
as_build_user() { sudo -u "$BUILD_USER" -H env PATH="$PATH" "$@"; }
for d in backend/node_modules backend/dist frontend/node_modules frontend/dist; do
  if [ -e "$SOURCE_DIR/$d" ]; then chown -R "$BUILD_USER" "$SOURCE_DIR/$d"; fi
done
(cd "$SOURCE_DIR/backend" && as_build_user npm ci --no-audit --no-fund && as_build_user npm run build)
(cd "$SOURCE_DIR/frontend" && as_build_user npm ci --no-audit --no-fund && as_build_user npm run build)

echo "==> Installing to $APP_DIR"
mkdir -p "$APP_DIR/backend" "$APP_DIR/public"
rsync -a --delete "$SOURCE_DIR/backend/dist" "$SOURCE_DIR/backend/data" "$SOURCE_DIR/backend/package.json" "$SOURCE_DIR/backend/package-lock.json" "$APP_DIR/backend/"
rsync -a --delete "$SOURCE_DIR/frontend/dist/" "$APP_DIR/public/"
(cd "$APP_DIR/backend" && npm ci --omit=dev --no-audit --no-fund)
chown -R root:root "$APP_DIR"

echo "==> Settings in $ENV_FILE"
if [ ! -f "$ENV_FILE" ]; then
  echo "# Runvale settings. Your own lines are kept when setup_service.sh runs again." > "$ENV_FILE"
  echo "NODE_NO_WARNINGS=1" >> "$ENV_FILE"
fi
chmod 640 "$ENV_FILE"
chown root:"$APP_USER" "$ENV_FILE"
set_env() { # set_env KEY VALUE: replaces the line, or adds it
  if grep -q "^$1=" "$ENV_FILE"; then sed -i "s|^$1=.*|$1=$2|" "$ENV_FILE"; else echo "$1=$2" >> "$ENV_FILE"; fi
}
set_env HOST 127.0.0.1
set_env PORT "$PORT"
set_env DATA_DIR "$DATA_DIR"
set_env LOG_DIR "$LOG_DIR"
set_env PUBLIC_DIR "$APP_DIR/public"
if $SHARED; then
  # Trust the client address only when it comes from the nginx on this machine.
  set_env TRUST_PROXY 127.0.0.1
  set_env BASE_PATH "$BASE"
else
  set_env TRUST_PROXY 1
fi
# The scanner must never reach this server, so its public IP goes on the blocklist.
public_ip="$(curl -4 -fsS --max-time 10 https://checkip.amazonaws.com 2>/dev/null | tr -d '[:space:]' || true)"
if [[ "$public_ip" =~ ^[0-9.]+$ ]]; then set_env SELF_ADDRESSES "$public_ip"; else public_ip=""; fi
if [ -n "${SCAN_BLOCKLIST:-}" ]; then set_env SCAN_BLOCKLIST "$SCAN_BLOCKLIST"; fi

cat > "/etc/systemd/system/$SERVICE.service" <<UNIT
[Unit]
Description=Runvale ($SERVICE)
After=network-online.target
Wants=network-online.target

[Service]
User=$APP_USER
Group=$APP_USER
WorkingDirectory=$APP_DIR/backend
EnvironmentFile=$ENV_FILE
ExecStart=$(command -v node) dist/server.js
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictSUIDSGID=true
ReadWritePaths=$DATA_DIR $LOG_DIR

[Install]
WantedBy=multi-user.target
UNIT

if $SHARED; then
  ZONE="${SERVICE//-/_}"
  ZONE_FILE="/etc/nginx/conf.d/$SERVICE-limits.conf"
  echo "==> nginx: $BASE -> 127.0.0.1:$PORT"
  mkdir -p "$(dirname "$NGINX_SNIPPET")"
  had_snippet=false
  had_zone=false
  [ -f "$NGINX_SNIPPET" ] && { cp "$NGINX_SNIPPET" "$NGINX_SNIPPET.bak"; had_snippet=true; }
  [ -f "$ZONE_FILE" ] && { cp "$ZONE_FILE" "$ZONE_FILE.bak"; had_zone=true; }
  cat > "$ZONE_FILE" <<NGINX
# $SERVICE: rate limit zone, used by $NGINX_SNIPPET. Written by setup_service.sh.
limit_req_zone \$binary_remote_addr zone=$ZONE:10m rate=5r/s;
NGINX
  cat > "$NGINX_SNIPPET" <<NGINX
# $SERVICE: written by setup_service.sh in $SOURCE_DIR
location = ${BASE%/} { absolute_redirect off; return 301 $BASE; }
location $BASE {
    limit_req zone=$ZONE burst=30 nodelay;
    limit_req_status 429;
    client_max_body_size 300k;
    proxy_pass http://127.0.0.1:$PORT/;
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Forwarded-For \$remote_addr;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_set_header Connection "";
    # A scan or a repo check can take up to a minute
    proxy_read_timeout 120s;
}
NGINX
  nginx_log="$(mktemp)"
  if nginx -t 2>"$nginx_log"; then
    rm -f "$NGINX_SNIPPET.bak" "$ZONE_FILE.bak" "$nginx_log"
  else
    cat "$nginx_log" >&2
    rm -f "$nginx_log"
    if $had_snippet; then mv "$NGINX_SNIPPET.bak" "$NGINX_SNIPPET"; else rm -f "$NGINX_SNIPPET"; fi
    if $had_zone; then mv "$ZONE_FILE.bak" "$ZONE_FILE"; else rm -f "$ZONE_FILE"; fi
    echo "nginx -t failed, so both nginx files were put back as they were. The service wasn't restarted." >&2
    exit 1
  fi
else
  # No domain yet? sslip.io turns the server's IP into a name, so HTTPS still works.
  if [ -z "${DOMAIN:-}" ]; then
    [ -n "$public_ip" ] || { echo "Couldn't find this server's public IP. Run it again with DOMAIN=your.domain." >&2; exit 1; }
    DOMAIN="${public_ip//./-}.sslip.io"
  fi

  cat > /etc/caddy/Caddyfile <<CADDY
$DOMAIN {
	encode zstd gzip
	reverse_proxy 127.0.0.1:$PORT
}
CADDY

  ufw allow OpenSSH >/dev/null
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
  ufw --force enable >/dev/null
fi

systemctl daemon-reload
systemctl enable --quiet "$SERVICE"
systemctl restart "$SERVICE"
if $SHARED; then
  systemctl reload nginx
else
  systemctl enable --quiet caddy
  systemctl reload-or-restart caddy
fi

echo "==> Checking it started"
for _ in $(seq 1 20); do
  if curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
    if $SHARED; then echo "Done. It's served under $BASE by your nginx."; else echo "Done. It's live at https://$DOMAIN"; fi
    echo "Logs: journalctl -u $SERVICE.service -f"
    echo "Log files: $LOG_DIR"
    exit 0
  fi
  sleep 1
done

echo "It didn't start. Check: journalctl -u $SERVICE.service -n 50" >&2
exit 1
