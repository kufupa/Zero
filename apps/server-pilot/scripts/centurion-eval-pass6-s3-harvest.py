#!/usr/bin/env python3
"""Pass-6 S3 harvest of queued PDF/xlsx. Counts on stdout. Bodies stay on disk."""
from __future__ import annotations

import json
import os
import re
import subprocess
import zipfile
from collections import defaultdict
from pathlib import Path
from xml.etree import ElementTree as ET

DEMAND = Path(
    "/home/ubuntu/projects/zero/.worktrees/centurion-dashboard-tools/.private/centurion-corpus/centurion-tool-demand-20260919"
)
BUCKET = "nava-zero-mail-845242190536-af-south-1"
REGION = "af-south-1"
WORKDIR = Path("/tmp/centurion-eval-att")
WORKDIR.mkdir(mode=0o700, exist_ok=True)
LOGO_RE = re.compile(r"logo|signature|spacer|pixel|footer|header.?image", re.I)


def load_queue():
    raw = json.loads((DEMAND / "truth/attachment-queue.json").read_text())
    return raw.get("files") or []


def s3_get(key: str, dest: Path) -> bool:
    dest.parent.mkdir(parents=True, exist_ok=True)
    result = subprocess.run(
        ["aws", "s3api", "get-object", "--bucket", BUCKET, "--key", key, "--region", REGION, str(dest)],
        capture_output=True,
    )
    return result.returncode == 0 and dest.exists() and dest.stat().st_size > 0


def pdf_text(path: Path) -> tuple[str, str]:
    """Return (layout_text, mode). Never dump raw %PDF objects."""
    try:
        result = subprocess.run(["pdftotext", "-q", "-layout", str(path), "-"], capture_output=True, text=True)
        if result.returncode == 0 and result.stdout.strip() and not result.stdout.lstrip().startswith("%PDF"):
            return result.stdout, "pdftotext"
    except FileNotFoundError:
        pass
    return "", "empty"


def xlsx_text(path: Path) -> str:
    try:
        with zipfile.ZipFile(path) as zf:
            names = [n for n in zf.namelist() if n.startswith("xl/sharedStrings") or n.startswith("xl/worksheets/")]
            bits = []
            for name in names[:8]:
                xml = zf.read(name)
                try:
                    root = ET.fromstring(xml)
                except ET.ParseError:
                    continue
                texts = [el.text for el in root.iter() if el.text and el.text.strip()]
                bits.extend(texts[:200])
            return "\n".join(bits)
    except zipfile.BadZipFile:
        return ""


def docx_text(path: Path) -> str:
    try:
        with zipfile.ZipFile(path) as zf:
            xml = zf.read("word/document.xml")
        root = ET.fromstring(xml)
        return "\n".join(el.text for el in root.iter() if el.text and el.text.strip())
    except (KeyError, zipfile.BadZipFile, ET.ParseError):
        return ""


def extract(path: Path, content_type: str | None, filename: str | None) -> str:
    blob = f"{content_type or ''} {filename or ''}".lower()
    if "pdf" in blob:
        text, mode = pdf_text(path)
        return text if mode != "empty" else ""
    if "sheet" in blob or (filename or "").endswith((".xlsx", ".xls", ".csv")):
        return xlsx_text(path)
    if "word" in blob or (filename or "").endswith((".docx", ".doc")):
        return docx_text(path)
    return ""


def main() -> None:
    files = load_queue()
    by_inbound: dict[str, list] = defaultdict(list)
    ok = 0
    fail = 0
    skipped_logo = 0
    for item in files:
        name = item.get("filename") or ""
        if LOGO_RE.search(name):
            skipped_logo += 1
            continue
        inbound = item.get("inboundId")
        if not inbound or len(by_inbound[inbound]) >= 10:
            continue
        key = item.get("s3Key")
        text = ""
        harvest = "no_s3_key"
        if key:
            dest = WORKDIR / inbound / Path(str(key).replace("/", "_")).name
            if s3_get(key, dest):
                text = extract(dest, item.get("contentType"), name)[:8000]
                if text.lstrip().startswith("%PDF"):
                    text = ""
                harvest = "s3_ok" if text.strip() else "s3_empty_text"
                ok += 1 if text.strip() else 0
                fail += 0 if text.strip() else 1
                by_inbound[inbound].append(
                    {
                        "filename": name,
                        "contentType": item.get("contentType"),
                        "byteSize": item.get("byteSize"),
                        "textExtract": text,
                        "pdfPath": str(dest) if "pdf" in (item.get("contentType") or "").lower() or str(name).lower().endswith(".pdf") else None,
                        "harvest": harvest,
                    }
                )
                continue
            else:
                harvest = "s3_get_fail"
                fail += 1
        by_inbound[inbound].append(
            {
                "filename": name,
                "contentType": item.get("contentType"),
                "byteSize": item.get("byteSize"),
                "textExtract": text,
                "harvest": harvest,
            }
        )

    rows = [{"inboundId": iid, "artifacts": arts} for iid, arts in by_inbound.items()]
    shard_dir = DEMAND / "shards"
    shard_dir.mkdir(mode=0o700, exist_ok=True)
    n = 5
    size = max(1, (len(rows) + n - 1) // n)
    for i in range(n):
        slice_ = rows[i * size : (i + 1) * size]
        dest = shard_dir / f"pass6-{i}-bodies.jsonl"
        dest.write_text("".join(json.dumps(row) + "\n" for row in slice_) if slice_ else "", encoding="utf8")
        os.chmod(dest, 0o600)

    report = {
        "queued": len(files),
        "inboundGroups": len(rows),
        "extractedNonEmpty": ok,
        "failOrEmpty": fail,
        "skippedLogo": skipped_logo,
        "mode": "s3_readonly_this_box",
    }
    (DEMAND / "truth/pass6-harvest.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf8")
    print(json.dumps(report))


if __name__ == "__main__":
    main()
