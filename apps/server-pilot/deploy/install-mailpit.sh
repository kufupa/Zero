#!/usr/bin/env bash
# Install pinned Mailpit static binary to /usr/local/bin/mailpit (idempotent).
set -euo pipefail
VERSION="${MAILPIT_VERSION:-v1.27.3}"
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64) ASSET="mailpit-linux-amd64.tar.gz" ;;
  aarch64|arm64) ASSET="mailpit-linux-arm64.tar.gz" ;;
  *) echo "unsupported arch: $ARCH" >&2; exit 1 ;;
esac
URL="https://github.com/axllent/mailpit/releases/download/${VERSION}/${ASSET}"
TMP="$(mktemp -d)"
curl -fsSL "$URL" -o "$TMP/mailpit.tgz"
sudo tar -xzf "$TMP/mailpit.tgz" -C /usr/local/bin mailpit
/usr/local/bin/mailpit --version
echo "install-mailpit: OK ${VERSION}"
