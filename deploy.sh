#!/usr/bin/env bash
# deploy.sh — one-button deploy for a fresh VPS
#
# Usage: ./deploy.sh [port]
#   port  Optional published port. Overrides HOST_PORT from .env. Default 3000.
#
# Idempotent: re-running pulls latest code, rebuilds image, restarts container.
set -euo pipefail

# CLI port arg wins; otherwise inherit HOST_PORT from .env (loaded by docker compose);
# otherwise fall back to 3000.
if [[ $# -ge 1 && -n "${1:-}" ]]; then
  export HOST_PORT="$1"
fi
export HOST_PORT="${HOST_PORT:-3000}"

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker not found. Please install Docker Engine first."
  exit 1
fi
if ! docker compose version >/dev/null 2>&1; then
  echo "Docker Compose plugin not found. Please install docker-compose-plugin."
  exit 1
fi

echo "==> Building image (this may take a few minutes)..."
docker compose build

echo "==> Starting service on port ${HOST_PORT}..."
docker compose up -d

sleep 2
echo "==> Health check:"
curl -fsS "http://127.0.0.1:${HOST_PORT}/api/health" || {
  echo "Health check failed. See: docker compose logs -f douyin-tool"
  exit 1
}
echo
echo "==> OK. Open http://<your-server-ip>:${HOST_PORT}/ in a browser."
echo "    (For HTTPS / public hostname, put a reverse proxy like Caddy or Nginx in front.)"
