#!/usr/bin/env bash
# One-time server setup for a Debian/Ubuntu VM (e.g. Google Cloud e2-micro).
#
#   curl -fsSL https://raw.githubusercontent.com/ChabadCuritiba/Database-/claude/jewish-community-platform-7zr3fp/deploy/setup.sh | sudo bash
#
# Installs Node.js, the app, a systemd service (auto-start / auto-restart) and
# Caddy (automatic HTTPS). Safe to run again: it updates instead of reinstalling.
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/ChabadCuritiba/Database-.git}"
BRANCH="${BRANCH:-claude/jewish-community-platform-7zr3fp}"
APP_DIR=/opt/crm
APP_USER=crm

if [ "$(id -u)" -ne 0 ]; then echo "Please run with sudo."; exit 1; fi

ask() { # ask VAR "Question" [default]
  local var=$1 q=$2 def=${3:-} ans
  if [ -n "${!var:-}" ]; then return; fi
  read -r -p "$q${def:+ [$def]}: " ans </dev/tty || true
  printf -v "$var" '%s' "${ans:-$def}"
}

echo "== Community platform setup =="
ask DOMAIN "Web address for the app (e.g. crm.chabadcuritiba.com)"
ask ADMIN_EMAIL "Your Google email (becomes the first admin)"
[ -z "$DOMAIN" ] && { echo "A web address is required."; exit 1; }

echo "== Adding swap so installs fit in 1 GB of memory =="
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q /swapfile /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "== Installing packages =="
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl git ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https build-essential python3 >/dev/null
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq && apt-get install -y -qq caddy >/dev/null
fi

echo "== Installing the app =="
id "$APP_USER" >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" fetch -q origin "$BRANCH" && git -C "$APP_DIR" checkout -q "$BRANCH" && git -C "$APP_DIR" reset -q --hard "origin/$BRANCH"
else
  git clone -q -b "$BRANCH" "$REPO_URL" "$APP_DIR"
fi
git config --global --add safe.directory "$APP_DIR"
cd "$APP_DIR"
npm ci --omit=dev --no-audit --no-fund
mkdir -p data backups

if [ ! -f .env ]; then
  cat > .env <<ENV
NODE_ENV=production
PORT=3000
BASE_URL=https://$DOMAIN
SESSION_SECRET=$(openssl rand -hex 32)
DATABASE_PATH=$APP_DIR/data/community.db
BACKUP_DIR=$APP_DIR/backups
TZ=America/Sao_Paulo
LOCALE=pt-BR
CURRENCY=BRL
ADMIN_EMAILS=$ADMIN_EMAIL
# Fill these in (see deploy/GUIDE.md), then: sudo systemctl restart crm
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
SMTP_HOST=
SMTP_PORT=587
SMTP_USER=
SMTP_PASS=
MAIL_FROM=
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_FROM=
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
ENV
fi
chmod 600 .env
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

echo "== Starting the service =="
cat > /etc/systemd/system/crm.service <<UNIT
[Unit]
Description=Community platform
After=network.target

[Service]
User=$APP_USER
WorkingDirectory=$APP_DIR
ExecStart=/usr/bin/node src/server.js
Restart=always
RestartSec=5
Environment=NODE_OPTIONS=--max-old-space-size=384

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable -q crm
systemctl restart crm

cat > /etc/caddy/Caddyfile <<CADDY
$DOMAIN {
  encode gzip
  reverse_proxy localhost:3000
}
CADDY
systemctl restart caddy

IP=$(curl -s -m 5 -H 'Metadata-Flavor: Google' http://metadata.google.internal/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip || true)
echo
echo "== Done =="
echo "App:      https://$DOMAIN"
[ -n "$IP" ] && echo "Make sure your DNS has an A record:  $DOMAIN  ->  $IP"
echo "Next: add your Google sign-in keys to $APP_DIR/.env and run: sudo systemctl restart crm"
echo "Logs:     sudo journalctl -u crm -f"
