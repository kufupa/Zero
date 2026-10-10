#!/usr/bin/env bash
# EC2 PDF text gate: Poppler + bubblewrap + prlimit must be present, and the sandbox must start.
# Fail closed. No OCR. Never disable AppArmor userns globally (sysctl); install the bwrap-only profile instead.
#
# Install the profile (idempotent; also drops the never-shipped broad /etc/apparmor.d/bwrap if present):
#   sudo apparmor_parser -R /etc/apparmor.d/bwrap 2>/dev/null; sudo rm -f /etc/apparmor.d/bwrap
#   sudo install -o root -g root -m 0644 /home/ubuntu/repos/zero/apps/server-pilot/deploy/apparmor/bwrap-userns-restrict /etc/apparmor.d/bwrap-userns-restrict
#   sudo apparmor_parser -r -W /etc/apparmor.d/bwrap-userns-restrict
# Verify: run this gate in pm2's AppArmor context (an unconfined systemd unit), never from an SSM shell: the SSM
# agent's complain-mode profile hides the userns restriction. Absolute path: systemd-run starts in /.
#   sudo systemd-run --quiet --uid=ubuntu --pipe --wait --collect bash /home/ubuntu/repos/zero/apps/server-pilot/deploy/pdf-text-gate.sh
# Rollback (PDF reads fail as "reader failed" again):
#   sudo apparmor_parser -R /etc/apparmor.d/bwrap-userns-restrict && sudo rm -f /etc/apparmor.d/bwrap-userns-restrict
set -euo pipefail

# Fail loudly in the wrong context: pm2 is unconfined, so a confined shell would test a different policy.
self_label="$(cat /proc/self/attr/current 2>/dev/null || echo unknown)"
if [ "$self_label" != "unconfined" ]; then
  echo "pdf-text-gate: run via systemd-run (unconfined, like pm2), not under AppArmor label '${self_label}'" >&2
  exit 1
fi

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
if ! child_label="$(sandbox /usr/bin/cat /proc/self/attr/current 2>&1)"; then
  echo "pdf-text-gate: sandbox cannot start: ${child_label}" >&2
  exit 1
fi
# With the userns restriction on, the grant must be the narrow profile: bwrap's children stacked with unpriv_bwrap
# (no capabilities), never a broad unconfined bwrap profile that lets anything under bwrap open more namespaces.
if [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)" = "1" ]; then
  case "$child_label" in
    *unpriv_bwrap*) ;;
    *)
      echo "pdf-text-gate: sandboxed child runs as '${child_label}', expected bwrap//&unpriv_bwrap" >&2
      exit 1
      ;;
  esac
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
