#!/usr/bin/env bash
# EC2 PDF text gate: Poppler + bubblewrap + prlimit must be present.
# Fail closed. No OCR. Never disable AppArmor userns globally.
set -euo pipefail

command -v /usr/bin/pdfinfo >/dev/null
command -v /usr/bin/pdftotext >/dev/null
command -v /usr/bin/bwrap >/dev/null
command -v /usr/bin/prlimit >/dev/null

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
printf 'not-a-pdf' >"$tmp/input.pdf"
chmod 600 "$tmp/input.pdf"

# Non-PDF under sandbox must fail (pdfinfo non-zero). Success here → gate fail.
set +e
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
  /usr/bin/pdfinfo /input.pdf >/dev/null 2>&1
status=$?
set -e

if [ "$status" -eq 0 ]; then
  echo "pdf-text-gate: expected pdfinfo failure on non-PDF" >&2
  exit 1
fi

echo "pdf-text-gate: PASS"
exit 0
