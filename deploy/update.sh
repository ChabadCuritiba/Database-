#!/usr/bin/env bash
# Pull the latest code and restart. Usage on the server: sudo bash /opt/crm/deploy/update.sh
set -euo pipefail
cd /opt/crm
BRANCH=$(git rev-parse --abbrev-ref HEAD)
sudo -u crm git fetch -q origin "$BRANCH"
sudo -u crm git reset -q --hard "origin/$BRANCH"
sudo -u crm npm ci --omit=dev --no-audit --no-fund
systemctl restart crm
echo "Updated to $(git log --oneline -1)"
