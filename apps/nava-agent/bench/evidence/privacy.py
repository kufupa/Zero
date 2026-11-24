"""Public-to-agent vs label-private separation. Digests/refs in public; bodies stay private."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any


def value_ref(kind: str, *parts: object) -> str:
    digest = hashlib.sha256("\0".join(str(p) for p in parts).encode("utf-8")).hexdigest()
    return f"ref:{kind}:{digest[:32]}"


def scrub_public_message_meta(selected: dict[str, Any] | None, *, case_id: str) -> dict[str, Any]:
    """IDs + clocks only. No subject/body/addresses/attachment text."""
    selected = selected or {}
    att = selected.get("pdf_attachments_text") or []
    non_pdf = selected.get("attachments_non_pdf") or []
    att_refs = []
    for i, a in enumerate(att if isinstance(att, list) else []):
        if not isinstance(a, dict):
            continue
        att_refs.append(
            {
                "attachment_index": i,
                "id_present": bool(a.get("id")),
                "sha256_present": bool(a.get("sha256")),
                "filename_present": bool(a.get("filename")),
                "text_chars": len(str(a.get("text") or "")),
                "valueRef": value_ref("pdf", case_id, a.get("id") or i, a.get("sha256") or ""),
            }
        )
    return {
        "case_id": case_id,
        "message_id_present": bool(selected.get("message_id") or selected.get("source_message_id")),
        "internet_message_id_present": bool(selected.get("internet_message_id") or selected.get("message_id_header")),
        "thread_id_present": bool(selected.get("thread_id")),
        "direction": selected.get("direction"),
        "decision_hash_present": bool(selected.get("decision_hash")),
        "timestamp": selected.get("timestamp") or selected.get("received_at"),
        "received_at": selected.get("received_at"),
        "pdf_attachment_n": len(att) if isinstance(att, list) else 0,
        "non_pdf_attachment_n": len(non_pdf) if isinstance(non_pdf, list) else 0,
        "attachment_refs": att_refs,
        "body_ref": value_ref("body", case_id, selected.get("decision_hash") or selected.get("message_id") or ""),
        "subject_ref": value_ref("subject", case_id, selected.get("decision_hash") or ""),
    }


def write_jsonl(path: Path, rows: list[dict[str, Any]]) -> str:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row, sort_keys=True, separators=(",", ":")) + "\n")
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_json(path: Path, obj: Any) -> str:
    path.parent.mkdir(parents=True, exist_ok=True)
    raw = json.dumps(obj, sort_keys=True, indent=2) + "\n"
    path.write_text(raw, encoding="utf-8")
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def public_private_layout(out_dir: Path) -> dict[str, Path]:
    public = out_dir / "public"
    private = out_dir / "label-private"
    public.mkdir(parents=True, exist_ok=True)
    private.mkdir(parents=True, exist_ok=True)
    (private / "README.txt").write_text(
        "Evaluator-only labels and private pointers. Never mount for predict.\n"
        "No credentials. Raw mail bodies/refs stay offline under authorized custody.\n",
        encoding="utf-8",
    )
    return {"public": public, "label_private": private}
