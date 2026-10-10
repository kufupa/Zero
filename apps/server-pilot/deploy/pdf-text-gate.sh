#!/usr/bin/env bash
# EC2 PDF text gate: Poppler + bubblewrap + prlimit must be present, and the sandbox must start.
# Fail closed. No OCR. Never disable AppArmor userns globally; install deploy/apparmor/bwrap instead.
# Run it in the server's AppArmor context, not an SSM shell (the SSM agent's complain-mode profile hides the
# userns restriction that pm2's unconfined service hits):
#   sudo systemd-run --quiet --uid=ubuntu --pipe --wait --collect bash apps/server-pilot/deploy/pdf-text-gate.sh
set -euo pipefail

command -v /usr/bin/pdfinfo >/dev/null
command -v /usr/bin/pdftotext >/dev/null
command -v /usr/bin/bwrap >/dev/null
command -v /usr/bin/prlimit >/dev/null

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
printf 'not-a-pdf' >"$tmp/input.pdf"
chmod 600 "$tmp/input.pdf"

sandbox() {
  /usr/bin/bwrap \
    --die-with-parent \
    --new-session \
    --unshare-user \
    --unshare-pid \
    --unshare-net \
    --unshare-ipc \
    --unshare-uts \
    --cap-drop ALL \
    --clearenv \
    --setenv PATH /usr/bin \
    --setenv HOME /tmp \
    --setenv LANG C.UTF-8 \
    --ro-bind /usr /usr \
    --ro-bind /lib /lib \
    --ro-bind-try /lib64 /lib64 \
    --proc /proc \
    --dev /dev \
    --tmpfs /tmp \
    --ro-bind "$tmp/input.pdf" /input.pdf \
    --chdir /tmp \
    -- \
    /usr/bin/prlimit \
    --cpu=5:5 \
    --as=536870912:536870912 \
    --fsize=262144:262144 \
    --nofile=32:32 \
    --nproc=16:16 \
    --core=0:0 \
    -- \
    "$@"
}

# Positive control: the sandbox itself must start. A bwrap setup error (AppArmor userns) fails every PDF read.
if ! err="$(sandbox /usr/bin/true 2>&1)"; then
  echo "pdf-text-gate: sandbox cannot start: ${err}" >&2
  exit 1
fi

# Non-PDF under sandbox must fail in pdfinfo itself (not in bwrap). Success here → gate fail.
set +e
err="$(sandbox /usr/bin/pdfinfo /input.pdf 2>&1 >/dev/null)"
status=$?
set -e

if [ "$status" -eq 0 ]; then
  echo "pdf-text-gate: expected pdfinfo failure on non-PDF" >&2
  exit 1
fi
case "$err" in
  bwrap:*)
    echo "pdf-text-gate: sandbox failed, not pdfinfo: ${err}" >&2
    exit 1
    ;;
esac

echo "pdf-text-gate: PASS"
exit 0
