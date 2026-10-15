#!/usr/bin/env bash
# Pull the latest code and restart. Usage on the server: sudo bash /opt/crm/deploy/update.sh
set -euo pipefail
cd /opt/crm
BRANCH=$(git rev-parse --abbrev-ref HEAD)
sudo -u crm git fetch -q origin "$BRANCH"
sudo -u crm git reset -q --hard "origin/$BRANCH"
sudo -u crm npm ci --omit=dev --no-audit --no-fund
systemctl restart crm
# Pass Buggy's live progress updates through Caddy without buffering (older installs).
if [ -f /etc/caddy/Caddyfile ] && grep -qE '^\s*reverse_proxy localhost:3000\s*$' /etc/caddy/Caddyfile; then
  sed -i -E 's|^(\s*)reverse_proxy localhost:3000\s*$|\1reverse_proxy localhost:3000 {\n\1  flush_interval -1\n\1}|' /etc/caddy/Caddyfile
  systemctl reload caddy
fi
echo "Updated to $(git log --oneline -1)"
