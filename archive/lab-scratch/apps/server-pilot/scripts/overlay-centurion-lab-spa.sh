#!/usr/bin/env bash
# Overlay the Centurion lab SPA and private index onto the shared hotel SPA root.
# Does not switch the EC2 git branch.
#
# SAFETY: Lab and hotel share /var/www/nava-mail. This script replaces SPA assets,
# so it MUST keep hotel Outlook download UI + /downloads/ installer. See
# lab-spa-overlay-guards.mjs.
set -euo pipefail

: "${STAMP:?set STAMP}"
: "${INDEX_JSON:?set INDEX_JSON to the private lab index}"

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
CLIENT="$ROOT/apps/mail/build/client"
GUARDS="$ROOT/apps/server-pilot/scripts/lab-spa-overlay-guards.mjs"
SPA_BUCKET="s3://nava-zero-bootstrap-845242190536/git-bundles"
INDEX_BUCKET="s3://nava-zero-mail-845242190536-af-south-1/lab-private"
REGION="${AWS_REGION:-af-south-1}"
WEB_ROOT="/var/www/nava-mail"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

if [ ! -f "$GUARDS" ]; then
  echo "missing overlay guards: $GUARDS" >&2
  exit 2
fi
if [ ! -d "$CLIENT" ]; then
  echo "missing SPA build: $CLIENT" >&2
  exit 2
fi
if [ ! -f "$INDEX_JSON" ]; then
  echo "missing index file" >&2
  exit 2
fi

echo "== hotel-safe preflight (source + built SPA) =="
node "$GUARDS" preflight "$ROOT" "$CLIENT"

tar -C "$CLIENT" --exclude='lab-centurion-index.json' --exclude='*.map' --exclude='downloads' -czf "$STAGE/spa.tar.gz" .
python3 - "$STAGE/spa.tar.gz" << 'PY'
import sys, tarfile
names = tarfile.open(sys.argv[1]).getnames()
bad = [
  name for name in names
  if name.endswith(".map")
  or name.endswith("lab-centurion-index.json")
  or name == "downloads"
  or name.startswith("downloads/")
]
if bad:
    raise SystemExit(f"tar contains excluded paths: {bad}")
labs = [name for name in names if "centurion-eval-lab-" in name and name.endswith(".js")]
if len(labs) != 1:
    raise SystemExit(f"expected one lab chunk, found {labs}")
print(labs[0].rsplit("/", 1)[-1])
PY
HASH_FILE="$(python3 - "$STAGE/spa.tar.gz" << 'PY'
import sys, tarfile
names = tarfile.open(sys.argv[1]).getnames()
labs = [name for name in names if name.endswith(".js") and "centurion-eval-lab-" in name]
print(labs[0].rsplit("/", 1)[-1])
PY
)"

aws s3 cp "$STAGE/spa.tar.gz" "$SPA_BUCKET/lab-proposed-spa-$STAMP.tar.gz" --region "$REGION" --only-show-errors
aws s3 cp "$INDEX_JSON" "$INDEX_BUCKET/lab-centurion-index-$STAMP.json" --region "$REGION" --only-show-errors
# Ship guards next to the remote extract so postflight can run without depending on EC2 git tip.
aws s3 cp "$GUARDS" "$SPA_BUCKET/lab-spa-overlay-guards-$STAMP.mjs" --region "$REGION" --only-show-errors

REMOTE=$(cat << EOF
set -euo pipefail
export AWS_REGION=$REGION
branch=\$(git -C /home/ubuntu/repos/zero rev-parse --abbrev-ref HEAD)
echo "BRANCH_BEFORE=\$branch"
aws s3 cp $SPA_BUCKET/lab-spa-overlay-guards-$STAMP.mjs /tmp/lab-spa-overlay-guards.mjs --region $REGION --only-show-errors
node /tmp/lab-spa-overlay-guards.mjs assert-branch "\$branch"

# Snapshot downloads + SPA so we can roll back hotel surfaces if postflight fails.
BACKUP=\$(mktemp -d /tmp/lab-spa-backup.XXXXXX)
if [ -d $WEB_ROOT/downloads ]; then
  sudo cp -a $WEB_ROOT/downloads "\$BACKUP/downloads"
fi
sudo mkdir -p "\$BACKUP/spa-snapshot"
sudo cp -a $WEB_ROOT/index.html "\$BACKUP/spa-snapshot/" 2>/dev/null || true
sudo cp -a $WEB_ROOT/assets "\$BACKUP/spa-snapshot/" 2>/dev/null || true
HAD_EXE=0
if [ -f $WEB_ROOT/downloads/NavaOutlookSetup.exe ]; then HAD_EXE=1; fi

aws s3 cp $SPA_BUCKET/lab-proposed-spa-$STAMP.tar.gz /tmp/lab-spa.tar.gz --region $REGION --only-show-errors
aws s3 cp $INDEX_BUCKET/lab-centurion-index-$STAMP.json /tmp/lab-centurion-index.json --region $REGION --only-show-errors

# Never let the lab tar clobber hotel installer bits.
sudo tar -xzf /tmp/lab-spa.tar.gz -C $WEB_ROOT --exclude='downloads' --exclude='downloads/*'
if [ -d "\$BACKUP/downloads" ]; then
  sudo rm -rf $WEB_ROOT/downloads
  sudo cp -a "\$BACKUP/downloads" $WEB_ROOT/downloads
fi
sudo mkdir -p $WEB_ROOT/downloads
sudo chown -R www-data:www-data $WEB_ROOT/downloads

owner=\$(stat -c '%U:%G' /var/lib/nava-pilot/lab-centurion-index.json)
sudo cp /tmp/lab-centurion-index.json /var/lib/nava-pilot/lab-centurion-index.json
sudo chown "\$owner" /var/lib/nava-pilot/lab-centurion-index.json
sudo chmod 0640 /var/lib/nava-pilot/lab-centurion-index.json
sudo rm -f $WEB_ROOT/lab-centurion-index.json
sudo find $WEB_ROOT -name 'centurion-eval-lab-*.js' ! -name '$HASH_FILE' -delete

rollback() {
  echo "OVERLAY_POSTFLIGHT_FAILED — restoring hotel SPA snapshot" >&2
  if [ -f "\$BACKUP/spa-snapshot/index.html" ]; then
    sudo cp -a "\$BACKUP/spa-snapshot/index.html" $WEB_ROOT/index.html
  fi
  if [ -d "\$BACKUP/spa-snapshot/assets" ]; then
    sudo rm -rf $WEB_ROOT/assets
    sudo cp -a "\$BACKUP/spa-snapshot/assets" $WEB_ROOT/assets
  fi
  if [ -d "\$BACKUP/downloads" ]; then
    sudo rm -rf $WEB_ROOT/downloads
    sudo cp -a "\$BACKUP/downloads" $WEB_ROOT/downloads
  fi
}

if ! node /tmp/lab-spa-overlay-guards.mjs postflight-spa $WEB_ROOT; then
  rollback
  pm2 restart http remote-http >/dev/null || true
  exit 4
fi
if [ "\$HAD_EXE" = "1" ]; then
  if ! node /tmp/lab-spa-overlay-guards.mjs assert-downloads $WEB_ROOT --required; then
    rollback
    pm2 restart http remote-http >/dev/null || true
    exit 4
  fi
fi

pm2 restart http remote-http
sleep 3
echo "BRANCH_AFTER=\$(git -C /home/ubuntu/repos/zero rev-parse --abbrev-ref HEAD)"
echo "LAB_JS=\$(find $WEB_ROOT -name 'centurion-eval-lab-*.js' -printf '%f\\n' | tr '\\n' ' ')"
if [ -f $WEB_ROOT/lab-centurion-index.json ]; then echo PUBLIC=present; else echo PUBLIC=absent; fi
echo "INDEX_MODE=\$(stat -c '%a' /var/lib/nava-pilot/lab-centurion-index.json)"
python3 -c 'import json; print("ROWS", len(json.load(open("/var/lib/nava-pilot/lab-centurion-index.json")).get("rows") or []))'
echo -n "HOTEL "; curl -s -o /dev/null -w '%{http_code}\\n' http://127.0.0.1:8788/api/lab/centurion-index
echo -n "ADMIN "; curl -s -o /dev/null -w '%{http_code}\\n' http://127.0.0.1:8789/api/lab/centurion-index
echo -n "OUTLOOK_EXE "; curl -s -o /dev/null -w '%{http_code}\\n' --resolve nava.legacyhotels.co.za:443:127.0.0.1 https://nava.legacyhotels.co.za/download/NavaOutlookSetup.exe || echo fail
rm -f /tmp/lab-spa.tar.gz /tmp/lab-centurion-index.json /tmp/lab-spa-overlay-guards.mjs
sudo rm -rf "\$BACKUP"
EOF
)

bash "$ROOT/apps/server-pilot/deploy/ssm-run-command.sh" "$REMOTE"
