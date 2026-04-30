#!/usr/bin/env bash
# ============================================================
# push-to-client.sh
#
# Push latest local source to client Mac (Tailscale 100.83.242.8)
# and restart backend so the change is live.
#
# Usage:
#   ./scripts/push-to-client.sh           # push src/ + migrations + scripts
#   ./scripts/push-to-client.sh --restart # push + force backend restart (default)
#   ./scripts/push-to-client.sh --no-restart  # push only
# ============================================================
set -euo pipefail

CLIENT="mertm@100.83.242.8"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RESTART="yes"

if [[ "${1:-}" == "--no-restart" ]]; then
  RESTART="no"
fi

echo "=== Packing source from $ROOT ==="
TGZ=/tmp/mertm-push-$(date +%H%M%S).tgz
tar czf "$TGZ" -C "$ROOT" \
  warehouse-backend/src \
  warehouse-backend/migrations \
  warehouse-frontend/src \
  warehouse-frontend/index.html \
  scripts \
  data-imports

echo "→ archive: $(du -h "$TGZ" | cut -f1)"

echo ""
echo "=== Uploading to $CLIENT ==="
scp -q "$TGZ" "$CLIENT:/tmp/push.tgz"
rm "$TGZ"

echo ""
echo "=== Applying on client ==="
ssh "$CLIENT" '
eval "$(/opt/homebrew/bin/brew shellenv)"

# Backup current source (last 5 only)
BK=/Applications/MERT-M/.backup
mkdir -p "$BK"
tar czf "$BK/src-$(date +%Y%m%d-%H%M%S).tgz" -C /Applications/MERT-M \
  warehouse-backend/src warehouse-frontend/src 2>/dev/null
ls -t "$BK"/src-*.tgz | tail -n +6 | xargs -r rm

# Apply
tar xzf /tmp/push.tgz -C /Applications/MERT-M --no-same-owner
rm /tmp/push.tgz

# Run any new migrations
cd /Applications/MERT-M/warehouse-backend && npm run migrate 2>&1 | tail -3
'

if [[ "$RESTART" == "yes" ]]; then
  echo ""
  echo "=== Restart backend on client ==="
  ssh "$CLIENT" '
    /usr/bin/pkill -9 -f "warehouse-backend.*tsx" 2>/dev/null || true
    /usr/bin/pkill -9 -f "warehouse-backend.*node" 2>/dev/null || true
    sleep 3
    cd /Applications/MERT-M
    /usr/bin/nohup /bin/bash scripts/start-mertm.sh > /tmp/mertm-launcher.log 2>&1 &
    sleep 10
    /usr/bin/curl -s -o /dev/null -w "backend health: %{http_code}\n" http://localhost:3004/health
  '
fi

echo ""
echo "✓ Done. Frontend Vite hot-reloaded automatically; backend restarted."
