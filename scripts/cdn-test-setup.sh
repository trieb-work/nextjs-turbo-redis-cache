#!/usr/bin/env bash
# CDN cache test environment setup
# Usage: ./scripts/cdn-test-setup.sh
#
# Prerequisites:
#   - cloudflared tunnel already created (nextjs-cache-test)
#   - CF_TUNNEL_HOSTNAME set in .env.cdn-test or as env var
#   - cloudflared DNS route already set: cloudflared tunnel route dns nextjs-cache-test <your-hostname>
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
APP_DIR="$REPO_ROOT/test/integration/next-app-cdn-test"
CLOUDFLARED_CONFIG="$REPO_ROOT/.cloudflared/config.yml"

ENV_FILE="$REPO_ROOT/.env.cdn-test"
if [[ -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  set -a && source "$ENV_FILE" && set +a
fi

: "${CF_TUNNEL_HOSTNAME:?Set CF_TUNNEL_HOSTNAME in .env.cdn-test or as env var (e.g. cache-test.yourdomain.com)}"
: "${REDIS_URL:=redis://localhost:6379}"
APP_PORT="${APP_PORT:-3102}"

echo "==> Checking Redis..."
if lsof -i :6379 > /dev/null 2>&1; then
  echo "    Redis already running on port 6379, skipping Docker start."
else
  echo "    Starting Redis via Docker..."
  docker compose -f "$REPO_ROOT/docker/docker-compose.cdn-test.yml" up -d --wait
  echo "    Redis ready."
fi

echo "==> Building Next.js test app..."
(cd "$APP_DIR" && REDIS_URL="$REDIS_URL" pnpm build)

echo "==> Starting Next.js test app on port $APP_PORT..."
cd "$APP_DIR"
REDIS_URL="$REDIS_URL" PORT="$APP_PORT" pnpm start &
APP_PID=$!
cd "$REPO_ROOT"
echo "    Next.js PID: $APP_PID"

echo "==> Waiting for Next.js to be ready..."
for i in $(seq 1 30); do
  if curl -sf "http://localhost:$APP_PORT/" > /dev/null 2>&1; then
    echo "    App ready on port $APP_PORT."
    break
  fi
  sleep 1
done

echo "==> Writing cloudflared config to $CLOUDFLARED_CONFIG..."
mkdir -p "$(dirname "$CLOUDFLARED_CONFIG")"
cat > "$CLOUDFLARED_CONFIG" <<EOF
tunnel: edd02f15-ba7e-414d-9ad9-d4db5158dfbd
credentials-file: $HOME/.cloudflared/edd02f15-ba7e-414d-9ad9-d4db5158dfbd.json

ingress:
  - hostname: ${CF_TUNNEL_HOSTNAME}
    service: http://localhost:${APP_PORT}
  - service: http_status:404
EOF

echo "==> Starting cloudflared tunnel..."
echo "    Public URL: https://${CF_TUNNEL_HOSTNAME}"
echo ""
echo "    Test CDN caching by checking the CF-Cache-Status response header:"
echo "    curl -I https://${CF_TUNNEL_HOSTNAME}/cache-lab"
echo ""
cloudflared tunnel --config "$CLOUDFLARED_CONFIG" run nextjs-cache-test
