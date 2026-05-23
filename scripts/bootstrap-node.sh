#!/usr/bin/env bash
# bootstrap-node.sh
#
# Downloads an official Node.js distribution into ./tools/node/ so this
# repository becomes self-contained and independent from any host-level
# node / nvm / n / fnm / volta installation.
#
# Resulting layout:
#   tools/node/bin/{node,npm,npx}    <- used by ./bin/node and ./bin/npm
#   tools/.cache/                    <- downloaded tarball + checksum (kept for re-runs)
#
# Env overrides:
#   NODEJS_MIRROR  base URL, default https://nodejs.org/dist
#                  e.g. https://mirrors.tuna.tsinghua.edu.cn/nodejs-release
#   FORCE=1        re-download even if tools/node already matches version

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

VER_FILE="$ROOT/.node-version"
if [[ ! -f "$VER_FILE" ]]; then
  echo "[bootstrap-node] missing .node-version" >&2
  exit 1
fi
VER="$(tr -d '[:space:]' < "$VER_FILE")"
[[ -n "$VER" ]] || { echo "[bootstrap-node] empty .node-version" >&2; exit 1; }

NODE_DIR="$ROOT/tools/node"
CACHE="$ROOT/tools/.cache"

# Already installed?
if [[ -z "${FORCE:-}" && -x "$NODE_DIR/bin/node" ]]; then
  CUR="$("$NODE_DIR/bin/node" --version 2>/dev/null || true)"
  if [[ "$CUR" == "v$VER" ]]; then
    echo "[bootstrap-node] already at $CUR"
    exit 0
  fi
fi

# Detect platform
UNAME_S="$(uname -s)"
UNAME_M="$(uname -m)"
case "$UNAME_S" in
  Darwin) OS="darwin" ;;
  Linux)  OS="linux"  ;;
  *) echo "[bootstrap-node] unsupported OS: $UNAME_S (use Docker or WSL)" >&2; exit 1 ;;
esac
case "$UNAME_M" in
  arm64|aarch64) ARCH="arm64" ;;
  x86_64|amd64)  ARCH="x64"   ;;
  *) echo "[bootstrap-node] unsupported arch: $UNAME_M" >&2; exit 1 ;;
esac

MIRROR="${NODEJS_MIRROR:-https://nodejs.org/dist}"
FILE="node-v${VER}-${OS}-${ARCH}.tar.xz"
URL="$MIRROR/v$VER/$FILE"
SUMS_URL="$MIRROR/v$VER/SHASUMS256.txt"

mkdir -p "$CACHE"

echo "[bootstrap-node] target: v$VER ($OS-$ARCH)"
echo "[bootstrap-node] mirror: $MIRROR"

# Download tarball (idempotent)
TARBALL="$CACHE/$FILE"
if [[ ! -f "$TARBALL" ]]; then
  echo "[bootstrap-node] downloading $URL"
  curl -fL --retry 3 --connect-timeout 15 -o "$TARBALL.tmp" "$URL"
  mv "$TARBALL.tmp" "$TARBALL"
else
  echo "[bootstrap-node] using cached $FILE"
fi

# Verify checksum
SUMS="$CACHE/SHASUMS256-v$VER.txt"
if [[ ! -f "$SUMS" ]]; then
  curl -fL --retry 3 -o "$SUMS.tmp" "$SUMS_URL"
  mv "$SUMS.tmp" "$SUMS"
fi

EXPECTED="$(grep "  $FILE\$" "$SUMS" | awk '{print $1}')"
if [[ -z "$EXPECTED" ]]; then
  echo "[bootstrap-node] checksum line not found for $FILE" >&2
  exit 1
fi

if command -v shasum >/dev/null 2>&1; then
  ACTUAL="$(shasum -a 256 "$TARBALL" | awk '{print $1}')"
elif command -v sha256sum >/dev/null 2>&1; then
  ACTUAL="$(sha256sum "$TARBALL" | awk '{print $1}')"
else
  echo "[bootstrap-node] no shasum/sha256sum available" >&2; exit 1
fi

if [[ "$ACTUAL" != "$EXPECTED" ]]; then
  echo "[bootstrap-node] checksum mismatch for $FILE" >&2
  echo "  expected: $EXPECTED" >&2
  echo "  actual:   $ACTUAL"   >&2
  rm -f "$TARBALL"
  exit 1
fi
echo "[bootstrap-node] sha256 ok"

# Extract
EXTRACT="$CACHE/extract-$VER"
rm -rf "$EXTRACT"
mkdir -p "$EXTRACT"
tar -xJf "$TARBALL" -C "$EXTRACT" --strip-components=1

# Atomic swap
rm -rf "$NODE_DIR.new" "$NODE_DIR.old"
mv "$EXTRACT" "$NODE_DIR.new"
if [[ -d "$NODE_DIR" ]]; then mv "$NODE_DIR" "$NODE_DIR.old"; fi
mv "$NODE_DIR.new" "$NODE_DIR"
rm -rf "$NODE_DIR.old"

CUR="$("$NODE_DIR/bin/node" --version)"
if [[ "$CUR" != "v$VER" ]]; then
  echo "[bootstrap-node] post-install version check failed: $CUR vs v$VER" >&2
  exit 1
fi
echo "[bootstrap-node] installed $CUR -> $NODE_DIR"
