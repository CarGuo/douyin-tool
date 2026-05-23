#!/usr/bin/env bash
#
# Prepares .deploy-prod/node_modules with the EXACT production dependency
# tree for @douyin-tool/server. Used by Dockerfile.runtime to avoid running
# npm on memory-constrained servers.
#
# Run from the repo root:
#   ./scripts/prepare-deploy-prod.sh
#
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Use the workspace-pinned Node so the generated node_modules layout matches
# what production will run.
export PATH="$ROOT/bin:$PATH"

DEPLOY_DIR="$ROOT/.deploy-prod"
rm -rf "$DEPLOY_DIR"
mkdir -p "$DEPLOY_DIR/packages/server" "$DEPLOY_DIR/packages/web"

cp package.json package-lock.json .npmrc "$DEPLOY_DIR/"
cp packages/server/package.json "$DEPLOY_DIR/packages/server/"
cp packages/web/package.json "$DEPLOY_DIR/packages/web/"

# Pin the registry-age check to offline mode so the deploy doesn't need
# network for the pre-install hook.
( cd "$DEPLOY_DIR" && AGE_CHECK_OFFLINE=1 npm ci --omit=dev --ignore-scripts \
    --workspace @douyin-tool/server )

echo
echo "[prepare-deploy-prod] node_modules size: $(du -sh "$DEPLOY_DIR/node_modules" | awk '{print $1}')"
echo "[prepare-deploy-prod] ready at: $DEPLOY_DIR"
