#!/usr/bin/env bash
# Installs Airchitect on an Ubuntu or Debian VM. Run it the first time to set everything up,
# and again after any update to rebuild and restart:
#
#   sudo ./setup_service.sh
#   sudo DOMAIN=app.example.com ./setup_service.sh
#
# Logs: journalctl -u airchitect.service -f
# Log files to copy off the VM: /var/log/airchitect/ (3 files, 5 MB each)
set -euo pipefail

SERVICE=airchitect
APP_USER=airchitect
SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR=/opt/airchitect
DATA_DIR=/var/lib/airchitect
LOG_DIR=/var/log/airchitect
ENV_FILE=/etc/airchitect.env
PORT=8790
NODE_MAJOR=24

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this with sudo." >&2
  exit 1
fi

echo "==> Installing system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg rsync debian-keyring debian-archive-keyring apt-transport-https ufw

current_node="$(node -v 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/' || true)"
if [ -z "$current_node" ] || [ "$current_node" -lt "$NODE_MAJOR" ]; then
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

id "$APP_USER" >/dev/null 2>&1 || useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"
mkdir -p "$APP_DIR" "$DATA_DIR" "$LOG_DIR"
chown -R "$APP_USER:$APP_USER" "$DATA_DIR" "$LOG_DIR"
chmod 750 "$DATA_DIR" "$LOG_DIR"

echo "==> Building"
(cd "$SOURCE_DIR/backend" && npm ci --no-audit --no-fund && npm run build)
(cd "$SOURCE_DIR/frontend" && npm ci --no-audit --no-fund && npm run build)

echo "==> Installing to $APP_DIR"
rsync -a --delete "$SOURCE_DIR/backend/dist" "$SOURCE_DIR/backend/data" "$SOURCE_DIR/backend/package.json" "$SOURCE_DIR/backend/package-lock.json" "$APP_DIR/backend/"
rsync -a --delete "$SOURCE_DIR/frontend/dist/" "$APP_DIR/public/"
(cd "$APP_DIR/backend" && npm ci --omit=dev --no-audit --no-fund)
chown -R root:root "$APP_DIR"

if [ ! -f "$ENV_FILE" ]; then
  cat > "$ENV_FILE" <<ENV
HOST=127.0.0.1
PORT=$PORT
DATA_DIR=$DATA_DIR
LOG_DIR=$LOG_DIR
PUBLIC_DIR=$APP_DIR/public
TRUST_PROXY=1
NODE_NO_WARNINGS=1
ENV
  chmod 640 "$ENV_FILE"
  chown root:"$APP_USER" "$ENV_FILE"
fi

cat > "/etc/systemd/system/$SERVICE.service" <<UNIT
[Unit]
Description=Airchitect
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

# No domain yet? sslip.io turns the server's IP into a name, so HTTPS still works.
if [ -z "${DOMAIN:-}" ]; then
  ip="$(curl -4 -fsS --max-time 10 https://checkip.amazonaws.com)"
  DOMAIN="${ip//./-}.sslip.io"
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

systemctl daemon-reload
systemctl enable --quiet "$SERVICE" caddy
systemctl restart "$SERVICE"
systemctl reload-or-restart caddy

echo "==> Checking it started"
for _ in $(seq 1 20); do
  if curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
    echo "Done. It's live at https://$DOMAIN"
    echo "Logs: journalctl -u $SERVICE.service -f"
    echo "Log files: $LOG_DIR"
    exit 0
  fi
  sleep 1
done

echo "It didn't start. Check: journalctl -u $SERVICE.service -n 50" >&2
exit 1
