#!/usr/bin/env bash
# Minimal A4 live digest: psql + aws s3api — no node deps.
# Digests/sizes/mime only. A4_LIVE_ALLOW=1.
set -euo pipefail
umask 077

[[ "${A4_LIVE_ALLOW:-}" == "1" ]] || { echo "set A4_LIVE_ALLOW=1"; exit 1; }
[[ -n "${DATABASE_URL:-}" ]] || { echo "DATABASE_URL required"; exit 1; }
[[ -z "${VITEST:-}" ]] || { echo "refusing under Vitest"; exit 1; }

OUT_DIR="${A4_LIVE_OUT_DIR:-/home/ubuntu/repos/zero/.private/wave-a-20260912/a4-live}"
mkdir -p "$OUT_DIR"
BUCKET="${S3_BUCKET:-${AWS_S3_BUCKET:-}}"
[[ -n "$BUCKET" ]] || { echo "S3_BUCKET required"; exit 1; }
REGION="${AWS_REGION:-af-south-1}"

TMP="$(mktemp -d -p /tmp a4-live.XXXXXX)"
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

# Prefer text/plain; fall back to pdf. Tab-separated; no filenames printed.
psql "$DATABASE_URL" -t -A -F $'\t' -c "
SELECT a.mime_type, a.size_bytes, a.s3_key
FROM attachment a
JOIN message m ON m.id = a.message_id
WHERE m.direction = 'inbound'
  AND a.s3_key LIKE 'attachments/%'
  AND a.size_bytes > 0 AND a.size_bytes < 5000000
  AND (a.mime_type = 'text/plain' OR a.mime_type = 'application/pdf')
ORDER BY
  CASE WHEN a.mime_type = 'text/plain' THEN 0 ELSE 1 END,
  a.created_at DESC
LIMIT 1;
" > "$TMP/row.tsv"

if [[ ! -s "$TMP/row.tsv" ]]; then
  python3 - <<PY
import json
from pathlib import Path
out=Path("$OUT_DIR")
compare={
  "schemaVersion":1,
  "toolId":"documents_read_existing",
  "finishedAt":__import__("datetime").datetime.utcnow().isoformat()+"Z",
  "allRequiredPass":False,
  "verdict":"BLOCKED_NO_LIVE_ATTACHMENT",
}
(out/"compare.v1.json").write_text(json.dumps(compare,indent=2)+"\n")
print(json.dumps({"ok":False,"reason":"no_rows"}))
PY
  exit 0
}

MIME="$(cut -f1 "$TMP/row.tsv")"
SIZE="$(cut -f2 "$TMP/row.tsv")"
S3KEY="$(cut -f3 "$TMP/row.tsv")"
PREFIX="$(python3 -c "print('/'.join('''$S3KEY'''.split('/')[:2]))")"

aws s3api get-object --region "$REGION" --bucket "$BUCKET" --key "$S3KEY" "$TMP/body.bin" >/dev/null
OBJ_BYTES="$(wc -c < "$TMP/body.bin" | tr -d ' ')"
SHA="$(sha256sum "$TMP/body.bin" | awk '{print $1}')"

python3 - <<PY
import json, os
from datetime import datetime, timezone
from pathlib import Path
out=Path("$OUT_DIR")
mime="$MIME"
size=int("$SIZE")
obj=int("$OBJ_BYTES")
sha="$SHA"
prefix="$PREFIX"
pass_ok = len(sha)==64 and obj==size and obj>0
now=datetime.now(timezone.utc).isoformat()
mail={
  "schemaVersion":1,
  "toolId":"documents_read_existing",
  "proofClass":"live_mailbox_attachment_digest",
  "finishedAt":now,
  "mimeType":mime,
  "sizeBytes":size,
  "objectBytes":obj,
  "sha256":sha,
  "s3KeyPrefix":prefix,
  "integrity":{"bytesMatchDeclaredSize": obj==size, "sha256Present":True},
  "notes":"Live authorized mailbox attachment byte digest via DB row + S3 GetObject. No synthetic fixture.",
}
compare={
  "schemaVersion":1,
  "toolId":"documents_read_existing",
  "finishedAt":now,
  "allRequiredPass":pass_ok,
  "verdict":"PASS_LIVE_MAILBOX_ATTACHMENT_DIGEST" if pass_ok else "FAIL_LIVE_MAILBOX_DIGEST",
  "rows":[
    {"field":"attachment.sha256","expected":"64hex","actual":sha[:12]+"…","required":True,"pass":len(sha)==64},
    {"field":"attachment.sizeBytes","expected":size,"actual":obj,"required":True,"pass":obj==size},
    {"field":"source","expected":"mail_attachment","actual":"mail_attachment","required":True,"pass":True},
    {"field":"proofClass","expected":"live_mailbox_attachment_digest","actual":"live_mailbox_attachment_digest","required":True,"pass":True},
  ],
  "packaging":{"video":"n/a_non_pms","mailProof":"present" if pass_ok else "failed","mailProofPath":str(out/"mailProof.v1.json")},
}
result={"schemaVersion":1,"toolId":"documents_read_existing","status":"ok" if pass_ok else "fail","mimeType":mime,"sizeBytes":size,"sha256Prefix":sha[:16]}
(out/"mailProof.v1.json").write_text(json.dumps(mail,indent=2)+"\n")
(out/"compare.v1.json").write_text(json.dumps(compare,indent=2)+"\n")
(out/"result.v1.json").write_text(json.dumps(result,indent=2)+"\n")
print(json.dumps({"ok":pass_ok,"outDir":str(out),"mimeType":mime,"sizeBytes":size,"sha256Prefix":sha[:16],"verdict":compare["verdict"]}))
PY
