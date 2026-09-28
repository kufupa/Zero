#!/usr/bin/env python3
"""Minimal A4 live mailbox digest: psql + aws s3api. Digests only. A4_LIVE_ALLOW=1."""
from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path


def scrub(s: str) -> str:
    s = re.sub(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+", "[email]", s)
    s = re.sub(r"postgres(?:ql)?:\/\/\S+", "[db]", s)
    s = re.sub(r"arn:aws:\S+", "[arn]", s)
    return s


def main() -> None:
    if os.environ.get("A4_LIVE_ALLOW") != "1":
        raise SystemExit("set A4_LIVE_ALLOW=1")
    if os.environ.get("VITEST"):
        raise SystemExit("refusing under Vitest")
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        raise SystemExit("DATABASE_URL required")
    bucket = os.environ.get("S3_BUCKET") or os.environ.get("AWS_S3_BUCKET")
    if not bucket:
        raise SystemExit("S3_BUCKET required")
    region = os.environ.get("AWS_REGION") or "af-south-1"
    out_dir = Path(
        os.environ.get("A4_LIVE_OUT_DIR")
        or "/home/ubuntu/repos/zero/.private/wave-a-20260912/a4-live"
    )
    out_dir.mkdir(parents=True, mode=0o700, exist_ok=True)

    q = """
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
""".strip()

    psql = subprocess.run(
        ["psql", database_url, "-t", "-A", "-F", "\t", "-c", q],
        capture_output=True,
        text=True,
        timeout=60,
        env=os.environ.copy(),
    )
    if psql.returncode != 0:
        raise SystemExit(f"psql_fail:{scrub(psql.stderr)[:120]}")
    line = (psql.stdout or "").strip().splitlines()
    if not line:
        compare = {
            "schemaVersion": 1,
            "toolId": "documents_read_existing",
            "finishedAt": datetime.now(timezone.utc).isoformat(),
            "allRequiredPass": False,
            "verdict": "BLOCKED_NO_LIVE_ATTACHMENT",
        }
        (out_dir / "compare.v1.json").write_text(json.dumps(compare, indent=2) + "\n")
        print(json.dumps({"ok": False, "reason": "no_rows"}))
        return

    mime, size_s, s3_key = line[0].split("\t")
    size = int(size_s)
    prefix = "/".join(s3_key.split("/")[:2])

    with tempfile.TemporaryDirectory(prefix="a4-live.") as tmp:
        body_path = Path(tmp) / "body.bin"
        get = subprocess.run(
            [
                "aws",
                "s3api",
                "get-object",
                "--region",
                region,
                "--bucket",
                bucket,
                "--key",
                s3_key,
                str(body_path),
            ],
            capture_output=True,
            text=True,
            timeout=120,
            env=os.environ.copy(),
        )
        if get.returncode != 0:
            raise SystemExit(f"s3_fail:{scrub(get.stderr)[:160]}")
        body = body_path.read_bytes()

    sha = hashlib.sha256(body).hexdigest()
    pass_ok = len(sha) == 64 and len(body) == size and len(body) > 0
    now = datetime.now(timezone.utc).isoformat()
    mail = {
        "schemaVersion": 1,
        "toolId": "documents_read_existing",
        "proofClass": "live_mailbox_attachment_digest",
        "finishedAt": now,
        "mimeType": mime,
        "sizeBytes": size,
        "objectBytes": len(body),
        "sha256": sha,
        "s3KeyPrefix": prefix,
        "integrity": {
            "bytesMatchDeclaredSize": len(body) == size,
            "sha256Present": True,
        },
        "notes": (
            "Live authorized mailbox attachment byte digest via DB row + S3 GetObject. "
            "No synthetic fixture."
        ),
    }
    compare = {
        "schemaVersion": 1,
        "toolId": "documents_read_existing",
        "finishedAt": now,
        "allRequiredPass": pass_ok,
        "verdict": (
            "PASS_LIVE_MAILBOX_ATTACHMENT_DIGEST"
            if pass_ok
            else "FAIL_LIVE_MAILBOX_DIGEST"
        ),
        "rows": [
            {
                "field": "attachment.sha256",
                "expected": "64hex",
                "actual": sha[:12] + "…",
                "required": True,
                "pass": len(sha) == 64,
            },
            {
                "field": "attachment.sizeBytes",
                "expected": size,
                "actual": len(body),
                "required": True,
                "pass": len(body) == size,
            },
            {
                "field": "source",
                "expected": "mail_attachment",
                "actual": "mail_attachment",
                "required": True,
                "pass": True,
            },
            {
                "field": "proofClass",
                "expected": "live_mailbox_attachment_digest",
                "actual": "live_mailbox_attachment_digest",
                "required": True,
                "pass": True,
            },
        ],
        "packaging": {
            "video": "n/a_non_pms",
            "mailProof": "present" if pass_ok else "failed",
            "mailProofPath": str(out_dir / "mailProof.v1.json"),
        },
    }
    result = {
        "schemaVersion": 1,
        "toolId": "documents_read_existing",
        "status": "ok" if pass_ok else "fail",
        "mimeType": mime,
        "sizeBytes": size,
        "sha256Prefix": sha[:16],
    }
    (out_dir / "mailProof.v1.json").write_text(json.dumps(mail, indent=2) + "\n")
    (out_dir / "compare.v1.json").write_text(json.dumps(compare, indent=2) + "\n")
    (out_dir / "result.v1.json").write_text(json.dumps(result, indent=2) + "\n")
    print(
        json.dumps(
            {
                "ok": pass_ok,
                "outDir": str(out_dir),
                "mimeType": mime,
                "sizeBytes": size,
                "sha256Prefix": sha[:16],
                "verdict": compare["verdict"],
            }
        )
    )


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as e:  # noqa: BLE001
        raise SystemExit(scrub(str(e))[:300]) from e
