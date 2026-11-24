"""Explicit-path offline readers. Never import mine/DB discovery or run collection scripts."""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterator


def file_sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def iter_jsonl(path: Path) -> Iterator[dict[str, Any]]:
    with path.open(encoding="utf-8", errors="replace") as f:
        for line_no, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                yield {"__parse_error__": True, "__line__": line_no}
                continue
            if isinstance(row, dict):
                yield row
            else:
                yield {"__parse_error__": True, "__line__": line_no, "__type__": type(row).__name__}


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


@dataclass
class SourcePaths:
    overnight_root: Path
    overnight22_data: Path
    retro_messages: Path
    halloween_dataset: Path
    mail_funnel: Path
    labels_dir: Path
    field_audit: Path | None = None

    def existing(self) -> dict[str, dict[str, Any]]:
        """Content-addressed inventory. Aggregate metadata only."""
        candidates: list[tuple[str, Path, str]] = [
            ("overnight23_root", self.overnight_root, "dir"),
            ("overnight22_data", self.overnight22_data, "dir"),
            ("retro_messages", self.retro_messages, "file"),
            ("halloween_inputs", self.halloween_dataset / "inputs.jsonl", "file"),
            ("halloween_outcomes", self.halloween_dataset / "outcomes.jsonl", "file"),
            ("halloween_journeys", self.halloween_dataset / "journeys.jsonl", "file"),
            ("halloween_backtest_inputs", self.halloween_dataset / "backtest" / "inputs.jsonl", "file"),
            ("mail_funnel", self.mail_funnel, "file"),
            ("labels_dir", self.labels_dir, "dir"),
            ("v6_dev_gold", self.overnight22_data / "v6" / "dev" / "gold.json", "file"),
            ("cases_train_gold", self.overnight_root / "cases-train" / "gold.json", "file"),
            ("cases_val_gold", self.overnight_root / "cases-val" / "gold.json", "file"),
            ("cases_test_gold", self.overnight_root / "cases-test" / "gold.json", "file"),
            ("v6_threads", self.overnight22_data / "v6" / "replay" / "dev" / "evidence" / "threads.jsonl", "file"),
            ("letters", self.overnight22_data / "letters.jsonl", "file"),
            ("letter_diffs", self.overnight22_data / "letter-diffs.jsonl", "file"),
        ]
        if self.field_audit:
            candidates.append(("field_audit", self.field_audit, "file"))
        out: dict[str, dict[str, Any]] = {}
        for name, path, kind in candidates:
            rec: dict[str, Any] = {
                "path": str(path),
                "kind": kind,
                "exists": path.exists(),
            }
            if path.exists() and path.is_file():
                rec["bytes"] = path.stat().st_size
                rec["sha256"] = file_sha256(path)
            elif path.exists() and path.is_dir():
                rec["entry_count"] = sum(1 for _ in path.iterdir())
            out[name] = rec
        return out


@dataclass
class AccessibleFrames:
    """Complete accessible source frames (counts + ID sets). No bodies."""

    retro_inbound_ids: list[str] = field(default_factory=list)
    retro_outbound_ids: list[str] = field(default_factory=list)
    retro_quarantine: dict[str, int] = field(default_factory=dict)
    label_routes: dict[str, str] = field(default_factory=dict)  # case_id -> route
    label_dispositions: dict[str, str] = field(default_factory=dict)
    v6_case_ids: dict[str, str] = field(default_factory=dict)  # case_id -> workflow
    v6_split: dict[str, str] = field(default_factory=dict)
    halloween_decision_ids: list[str] = field(default_factory=list)
    halloween_backtest_ids: list[str] = field(default_factory=list)
    mail_funnel: dict[str, Any] = field(default_factory=dict)
    source_hashes: dict[str, dict[str, Any]] = field(default_factory=dict)
    unavailable: list[dict[str, str]] = field(default_factory=list)


def _retro_id(row: dict[str, Any]) -> str:
    mid = row.get("messageId") or row.get("id") or row.get("transportId")
    return f"retro:{mid}" if mid is not None else ""


def load_accessible_frames(paths: SourcePaths) -> AccessibleFrames:
    frames = AccessibleFrames(source_hashes=paths.existing())
    for name, meta in frames.source_hashes.items():
        if not meta.get("exists"):
            frames.unavailable.append({"source": name, "path": meta["path"], "reason": "missing_path"})

    # Retro — complete accessible export (contract appendix).
    if paths.retro_messages.exists():
        for row in iter_jsonl(paths.retro_messages):
            if row.get("__parse_error__"):
                frames.retro_quarantine["parse_error"] = frames.retro_quarantine.get("parse_error", 0) + 1
                continue
            rid = _retro_id(row)
            if not rid:
                frames.retro_quarantine["missing_id"] = frames.retro_quarantine.get("missing_id", 0) + 1
                continue
            direction = (row.get("direction") or row.get("businessDirection") or "").lower()
            if direction == "inbound":
                frames.retro_inbound_ids.append(rid)
            elif direction == "outbound":
                frames.retro_outbound_ids.append(rid)
            else:
                frames.retro_quarantine["unknown_direction"] = frames.retro_quarantine.get("unknown_direction", 0) + 1
                frames.retro_inbound_ids.append(rid)  # keep in frame; mark quarantine count

    # Labels — pre-outcome routing stratum (not adjudicated workflow).
    if paths.labels_dir.exists():
        for p in sorted(paths.labels_dir.glob("*.json")):
            try:
                blob = load_json(p)
            except (OSError, json.JSONDecodeError):
                frames.unavailable.append({"source": "label", "path": str(p), "reason": "unreadable"})
                continue
            result = blob.get("result") if isinstance(blob, dict) else None
            if not isinstance(result, dict):
                continue
            route = str(result.get("route") or "").lower()
            frames.label_routes[p.stem] = route or "?"
            frames.label_dispositions[p.stem] = str(result.get("disposition") or "")

    # v6 cases from overnight-20261123 splits (immutable selected frame).
    for split, dirname in (("train", "cases-train"), ("val", "cases-val"), ("test", "cases-test")):
        split_dir = paths.overnight_root / dirname
        if not split_dir.exists():
            frames.unavailable.append({"source": f"cases_{split}", "path": str(split_dir), "reason": "missing_path"})
            continue
        for case_dir in sorted(split_dir.iterdir()):
            if not case_dir.is_dir() or not case_dir.name.startswith("v6-"):
                continue
            case_path = case_dir / "case.json"
            if not case_path.exists():
                frames.unavailable.append({"source": "case", "path": str(case_path), "reason": "missing_case_json"})
                continue
            try:
                card = load_json(case_path)
            except (OSError, json.JSONDecodeError):
                frames.unavailable.append({"source": "case", "path": str(case_path), "reason": "unreadable"})
                continue
            cid = str(card.get("case_id") or case_dir.name)
            frames.v6_case_ids[cid] = str(card.get("workflow") or "?")
            frames.v6_split[cid] = split

    # Halloween inputs / backtest (same 1530 view — not independent).
    hi = paths.halloween_dataset / "inputs.jsonl"
    if hi.exists():
        for row in iter_jsonl(hi):
            if row.get("__parse_error__"):
                continue
            did = row.get("decision_id")
            if did:
                frames.halloween_decision_ids.append(str(did))
    bt = paths.halloween_dataset / "backtest" / "inputs.jsonl"
    if bt.exists():
        for row in iter_jsonl(bt):
            if row.get("__parse_error__"):
                continue
            did = row.get("decision_id")
            if did:
                frames.halloween_backtest_ids.append(str(did))

    if paths.mail_funnel.exists():
        try:
            frames.mail_funnel = load_json(paths.mail_funnel)
        except (OSError, json.JSONDecodeError):
            frames.unavailable.append({"source": "mail_funnel", "path": str(paths.mail_funnel), "reason": "unreadable"})

    return frames


def default_paths() -> SourcePaths:
    zero = Path.home() / ".local" / "share" / "zero"
    return SourcePaths(
        overnight_root=zero / "runs" / "overnight-20261123",
        overnight22_data=zero / "runs" / "overnight-20261122" / "data",
        retro_messages=zero / "centurion-retro-roi" / "20261116" / "source" / "messages.jsonl",
        halloween_dataset=zero / "research" / "halloween" / "dataset-run-20261111-1022" / "dataset",
        mail_funnel=zero / "runs" / "overnight-20261122" / "data" / "mail-funnel.json",
        labels_dir=zero / "runs" / "overnight-20261122" / "data" / "labels",
        field_audit=zero / "research" / "2026-11-24-replay-field-audit.md",
    )
