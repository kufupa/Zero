#!/usr/bin/env python3
"""Compare selected blind-review labels with bulk labels; never emit message text."""

from __future__ import annotations

import argparse
import io
import json
import os
import re
import stat
import tempfile
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, TextIO


ROOT = Path(__file__).resolve().parents[4]
PRIVATE_ROOT = ROOT / ".private"
FIELDS = (
    "reservation_email", "can_help", "actions", "reply_ids",
    "response_type", "invoice_handling",
)
LIST_FIELDS = {"actions", "reply_ids"}
CASE_RE = re.compile(r"[A-Za-z0-9._-]{1,128}\Z")
STRATUM_RE = re.compile(r"[A-Za-z0-9_-]{1,64}\Z")
HASH_RE = re.compile(r"[0-9a-f]{64}\Z")
MAX_INPUT_BYTES = 256 * 1024 * 1024
_INVALID = object()


class AuditInputError(ValueError):
    """Safe error code; never includes row contents."""


def _case_id(value: Any) -> str:
    if not isinstance(value, str) or not CASE_RE.fullmatch(value):
        raise AuditInputError("case_id_invalid")
    return value


def _read_jsonl(source: TextIO, label: str) -> list[dict[str, Any]]:
    rows = []
    for line_number, line in enumerate(source, 1):
        if not line.strip():
            continue
        try:
            row = json.loads(line)
        except (json.JSONDecodeError, UnicodeError):
            raise AuditInputError(f"{label}_jsonl_invalid_line_{line_number}") from None
        if not isinstance(row, dict):
            raise AuditInputError(f"{label}_row_not_object_line_{line_number}")
        rows.append(row)
    return rows


def _read_private(path: Path, label: str) -> list[dict[str, Any]]:
    try:
        with path.open(encoding="utf-8") as source:
            return _read_jsonl(source, label)
    except (OSError, UnicodeError):
        raise AuditInputError(f"{label}_unreadable") from None


def _selection(rows: list[dict[str, Any]]) -> dict[str, dict[str, str]]:
    selected: dict[str, dict[str, str]] = {}
    for row in rows:
        case = _case_id(row.get("case"))
        stratum = row.get("stratum")
        if not isinstance(stratum, str) or not STRATUM_RE.fullmatch(stratum):
            raise AuditInputError("selection_stratum_invalid")
        if case in selected:
            raise AuditInputError("selection_duplicate_case")
        selected[case] = {
            "group": "random" if stratum == "random" else "targeted",
            "stratum": stratum,
        }
    if not selected:
        raise AuditInputError("selection_empty")
    return selected


def _result_index(
    rows: list[dict[str, Any]], selected_cases: set[str], label: str,
) -> tuple[dict[str, dict[str, Any]], int]:
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        case = _case_id(row.get("case"))
        grouped[case].append(row)
    extras = len(set(grouped) - selected_cases)
    indexed: dict[str, dict[str, Any]] = {}
    for case in selected_cases & set(grouped):
        history = grouped[case]
        state: dict[str, Any] = {
            "problem": None, "record": history[-1], "input_hash": None, "status": None,
        }
        hashes = [item.get("input_sha256") for item in history]
        if any(not isinstance(value, str) or not HASH_RE.fullmatch(value) for value in hashes):
            state["problem"] = f"{label}_input_hash_missing_or_invalid"
        elif len(set(hashes)) != 1:
            state["problem"] = f"{label}_attempt_hash_conflict"
        else:
            state["input_hash"] = hashes[0]

        attempts = [item.get("attempt") for item in history]
        statuses = [item.get("status") for item in history]
        if state["problem"] is None:
            if any(not isinstance(attempt, int) or isinstance(attempt, bool) or attempt < 1
                   for attempt in attempts):
                state["problem"] = f"{label}_attempt_invalid"
            elif attempts != list(range(1, len(history) + 1)):
                state["problem"] = f"{label}_attempt_sequence_invalid"
            elif any(status != "failed" for status in statuses[:-1]):
                state["problem"] = f"{label}_attempt_history_invalid"
            elif statuses[-1] not in {"ok", "failed", "withheld"}:
                state["problem"] = f"{label}_status_invalid"
            elif any(item.get("direction") != "inbound" for item in history):
                state["problem"] = f"{label}_direction_invalid"
            else:
                state["status"] = statuses[-1]

        if state["problem"] is None and state["status"] == "ok":
            result = history[-1].get("result")
            if not isinstance(result, dict):
                state["problem"] = f"{label}_result_missing"
            elif result.get("case") != case:
                state["problem"] = f"{label}_nested_case_mismatch"
            else:
                state["result"] = result
        indexed[case] = state
    return indexed, extras


def _layered_result_index(
    base_rows: list[dict[str, Any]], overlays: list[list[dict[str, Any]]],
    selected_cases: set[str], label: str,
) -> tuple[dict[str, dict[str, Any]], dict[str, str], dict[str, Any]]:
    indexed, extra = _result_index(base_rows, selected_cases, label)
    sources = {case: "base" for case in indexed}
    overlay_rows, overlay_extras = [], []
    for number, rows in enumerate(overlays, 1):
        replacement, extras = _result_index(rows, selected_cases, label)
        indexed.update(replacement)
        sources.update({case: f"overlay_{number}" for case in replacement})
        overlay_rows.append(len(rows))
        overlay_extras.append(extras)
    summary = {
        "base_rows": len(base_rows),
        "overlay_rows": overlay_rows,
        "selected_result_cases": len(indexed),
        "selected_overlay_cases": sum(source != "base" for source in sources.values()),
        "unselected_cases": {"base": extra, "overlays": overlay_extras},
    }
    return indexed, sources, summary


def _normalized(field: str, value: Any) -> Any:
    if field in LIST_FIELDS:
        if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
            return _INVALID
        # Actions and reply IDs are set-like; order is not part of the label.
        return tuple(sorted(value))
    if field in {"reservation_email", "can_help"}:
        return value if value is None or isinstance(value, bool) else _INVALID
    if field in {"response_type", "invoice_handling"}:
        return value if isinstance(value, str) else _INVALID
    return _INVALID


def compare_rows(
    selection_rows: list[dict[str, Any]],
    blind_rows: list[dict[str, Any]],
    bulk_rows: list[dict[str, Any]],
    blind_overlays: list[list[dict[str, Any]]] | None = None,
    bulk_overlays: list[list[dict[str, Any]]] | None = None,
) -> dict[str, Any]:
    selected = _selection(selection_rows)
    selected_cases = set(selected)
    blind, blind_sources, blind_summary = _layered_result_index(
        blind_rows, blind_overlays or [], selected_cases, "blind",
    )
    bulk, bulk_sources, bulk_summary = _layered_result_index(
        bulk_rows, bulk_overlays or [], selected_cases, "bulk",
    )
    groups = ("random", "targeted")
    agreement = {
        group: {field: {"compared": 0, "agree": 0, "disagree": 0, "unavailable": 0}
                for field in FIELDS}
        for group in groups
    }
    missing_cases = []
    field_gaps: dict[str, dict[str, Any]] = {}
    differences: dict[str, list[str]] = {}
    hash_mismatch_cases = []
    hash_matched = 0
    comparable_cases = 0

    for case in sorted(selected):
        meta = selected[case]
        left, right = blind.get(case), bulk.get(case)
        reasons = []
        if left is None:
            reasons.append("blind_result_missing")
        elif left.get("problem"):
            reasons.append(left["problem"])
        if right is None:
            reasons.append("bulk_result_missing")
        elif right.get("problem"):
            reasons.append(right["problem"])
        if not reasons:
            if left["input_hash"] != right["input_hash"]:
                hash_mismatch_cases.append(case)
                reasons.append("input_hash_mismatch")
            else:
                hash_matched += 1
            for label, result_state in (("blind", left), ("bulk", right)):
                if result_state["status"] != "ok":
                    reasons.append(f"{label}_status_{result_state['status']}")
        if reasons:
            missing_cases.append({
                "case": case, "group": meta["group"], "stratum": meta["stratum"],
                "sources": {"blind": blind_sources.get(case), "bulk": bulk_sources.get(case)},
                "reasons": reasons,
            })
            continue

        changed = []
        unavailable = []
        for field in FIELDS:
            lhs = (
                _normalized(field, left["result"][field])
                if field in left["result"] else _INVALID
            )
            rhs = (
                _normalized(field, right["result"][field])
                if field in right["result"] else _INVALID
            )
            counts = agreement[meta["group"]][field]
            if lhs is _INVALID or rhs is _INVALID:
                counts["unavailable"] += 1
                unavailable.append(field)
            else:
                counts["compared"] += 1
                if lhs == rhs:
                    counts["agree"] += 1
                else:
                    counts["disagree"] += 1
                    changed.append(field)
        if changed:
            differences[case] = changed
        if unavailable:
            field_gaps[case] = {
                "group": meta["group"], "stratum": meta["stratum"],
                "sources": {"blind": blind_sources[case], "bulk": bulk_sources[case]},
                "fields": unavailable,
            }
        else:
            comparable_cases += 1

    for group in groups:
        for counts in agreement[group].values():
            denom = counts["compared"]
            counts["agreement_rate"] = counts["agree"] / denom if denom else None

    group_counts = Counter(meta["group"] for meta in selected.values())
    return {
        "schema": "blind-review-comparison/v1",
        "method": {
            "hash_gate": "latest blind and bulk input_sha256 must match",
            "attempts": "latest contiguous attempt; retries only after failed attempts",
            "overlays": "last overlay containing a case replaces earlier layers",
            "list_fields": "actions and reply_ids compared order-insensitively",
            "scalar_fields": "exact typed values; null is valid for nullable booleans",
            "values_emitted": False,
        },
        "selection": {
            "cases": len(selected),
            "random": group_counts["random"],
            "targeted": group_counts["targeted"],
        },
        "result_rows": {"blind": blind_summary, "bulk": bulk_summary},
        "coverage": {
            "same_hash_cases": hash_matched,
            "case_comparable": comparable_cases,
            "missing_cases": missing_cases,
            "field_gaps": [
                {"case": case, **details} for case, details in sorted(field_gaps.items())
            ],
        },
        "hash_validation": {
            "same_hash": hash_matched,
            "mismatches": hash_mismatch_cases,
        },
        "agreement": agreement,
        "differences": [
            {
                "case": case,
                "group": selected[case]["group"],
                "stratum": selected[case]["stratum"],
                "sources": {"blind": blind_sources[case], "bulk": bulk_sources[case]},
                "fields": fields,
            }
            for case, fields in sorted(differences.items())
        ],
    }


def _validate_input_path(path: Path, label: str) -> Path:
    if path.is_symlink():
        raise AuditInputError(f"{label}_symlink")
    try:
        resolved = path.resolve(strict=True)
        private_root = PRIVATE_ROOT.resolve(strict=True)
        info = resolved.stat()
    except OSError:
        raise AuditInputError(f"{label}_unreadable") from None
    if not resolved.is_relative_to(private_root) or not stat.S_ISREG(info.st_mode):
        raise AuditInputError(f"{label}_not_private_regular_file")
    if info.st_mode & 0o077:
        raise AuditInputError(f"{label}_permissions_too_open")
    if info.st_size > MAX_INPUT_BYTES:
        raise AuditInputError(f"{label}_too_large")
    return resolved


def _validate_output_path(path: Path, input_paths: set[Path]) -> Path:
    if path.exists() or path.is_symlink():
        raise AuditInputError("output_exists")
    try:
        parent = path.parent.resolve(strict=True)
        private_root = PRIVATE_ROOT.resolve(strict=True)
        info = parent.stat()
    except OSError:
        raise AuditInputError("output_parent_unavailable") from None
    if not parent.is_relative_to(private_root) or not stat.S_ISDIR(info.st_mode):
        raise AuditInputError("output_not_in_private_directory")
    if info.st_mode & 0o077:
        raise AuditInputError("output_directory_permissions_too_open")
    target = parent / path.name
    if target in input_paths or not path.name or path.name in {".", ".."}:
        raise AuditInputError("output_path_invalid")
    return target


def _write_private(path: Path, data: dict[str, Any]) -> None:
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(path, flags, 0o600)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as target:
            json.dump(data, target, ensure_ascii=True, indent=2, sort_keys=True)
            target.write("\n")
            target.flush()
            os.fsync(target.fileno())
        os.chmod(path, 0o600, follow_symlinks=False)
    except Exception:
        try:
            os.close(descriptor)
        except OSError:
            pass
        try:
            path.unlink()
        except OSError:
            pass
        raise


def self_test() -> None:
    def result(case: str, digest: str, **fields: Any) -> dict[str, Any]:
        label = {
            "reservation_email": True, "can_help": True,
            "actions": ["quote", "amend"], "reply_ids": ["reply-1"],
            "response_type": "requested", "invoice_handling": "none",
        }
        status = fields.pop("status", "ok")
        label.update(fields)
        return {
            "case": case, "input_sha256": digest, "attempt": 1,
            "direction": "inbound", "status": status,
            **({"result": {"case": case, **label}} if status == "ok" else {}),
        }

    selection = [
        {"case": "I001", "stratum": "random"},
        {"case": "I002", "stratum": "cross_thread_reply"},
        {"case": "I003", "stratum": "random"},
        {"case": "I004", "stratum": "invoice"},
    ]
    h1, h2 = "a" * 64, "b" * 64
    blind = [
        result("I001", h1, reservation_email=None, can_help=None),
        result("I002", h1, actions=["amend", "quote"]),
        result("I003", h1),
    ]
    bulk = [result("I001", h1, reservation_email=None, can_help=None),
            result("I002", h1), result("I003", h2, can_help=False)]
    report = compare_rows(selection, blind, bulk)
    assert report["selection"] == {"cases": 4, "random": 2, "targeted": 2}
    assert report["coverage"]["same_hash_cases"] == 2
    assert report["hash_validation"]["mismatches"] == ["I003"]
    assert report["coverage"]["missing_cases"][-1]["reasons"] == [
        "blind_result_missing", "bulk_result_missing",
    ]
    assert report["agreement"]["random"]["can_help"]["agree"] == 1
    assert report["agreement"]["targeted"]["actions"]["agree"] == 1
    assert not report["differences"]

    failed = result("I007", h1, status="failed")
    retry = result("I007", h1)
    retry["attempt"] = 2
    retried = compare_rows([{"case": "I007", "stratum": "random"}],
                           [failed, retry], [result("I007", h1)])
    assert retried["coverage"]["case_comparable"] == 1
    retry["input_sha256"] = h2
    conflicted = compare_rows([{"case": "I007", "stratum": "random"}],
                              [failed, retry], [result("I007", h1)])
    assert conflicted["coverage"]["missing_cases"][0]["reasons"] == [
        "blind_attempt_hash_conflict",
    ]

    mismatch = compare_rows(
        [{"case": "I005", "stratum": "random"}],
        [result("I005", h1, can_help=False, reply_ids=["reply-sensitive"])],
        [result("I005", h1)],
    )
    assert mismatch["differences"][0]["fields"] == ["can_help", "reply_ids"]
    assert "reply-sensitive" not in json.dumps(mismatch)

    primary = result("I008", h1)
    replacement = result("I008", h2, can_help=False)
    overlay = compare_rows(
        [{"case": "I008", "stratum": "invoice"}], [primary], [primary],
        [[replacement]], [[result("I008", h2)]],
    )
    assert overlay["differences"][0]["fields"] == ["can_help"]
    assert overlay["differences"][0]["sources"] == {
        "blind": "overlay_1", "bulk": "overlay_1",
    }
    stale = compare_rows(
        [{"case": "I008", "stratum": "invoice"}], [primary], [primary], [[replacement]],
    )
    assert stale["hash_validation"]["mismatches"] == ["I008"]
    assert stale["coverage"]["missing_cases"][0]["reasons"] == ["input_hash_mismatch"]

    line = json.dumps({"case": "I006", "stratum": "random", "text": "a\u2028b"},
                      ensure_ascii=False) + "\n"
    assert len(_read_jsonl(io.StringIO(line), "synthetic")) == 1
    with tempfile.TemporaryDirectory() as temporary:
        path = Path(temporary) / "report.json"
        _write_private(path, {"synthetic": True})
        assert stat.S_IMODE(path.stat().st_mode) == 0o600
        assert json.loads(path.read_text(encoding="utf-8")) == {"synthetic": True}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--selection", type=Path)
    parser.add_argument("--blind-results", type=Path)
    parser.add_argument("--bulk-results", type=Path)
    parser.add_argument(
        "--blind-overlay", type=Path, action="append", default=[],
        help="optional later blind results; repeat to add priority layers",
    )
    parser.add_argument(
        "--bulk-overlay", type=Path, action="append", default=[],
        help="optional later bulk results; repeat to add priority layers",
    )
    parser.add_argument("--output", type=Path)
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        self_test()
        print("self-test: ok")
        return 0
    if not all((args.selection, args.blind_results, args.bulk_results, args.output)):
        parser.error("--selection, --blind-results, --bulk-results and --output required")
    try:
        path_specs = [
            (args.selection, "selection"),
            (args.blind_results, "blind_results"),
            (args.bulk_results, "bulk_results"),
            *((path, f"blind_overlay_{i}") for i, path in enumerate(args.blind_overlay, 1)),
            *((path, f"bulk_overlay_{i}") for i, path in enumerate(args.bulk_overlay, 1)),
        ]
        checked_paths = [
            (label, _validate_input_path(path, label)) for path, label in path_specs
        ]
        input_paths = {path for _label, path in checked_paths}
        if len(input_paths) != len(path_specs):
            raise AuditInputError("input_paths_must_be_distinct")
        output_path = _validate_output_path(args.output, input_paths)
        inputs = {
            label: _read_private(path, label) for label, path in checked_paths
        }
        selection_rows = inputs["selection"]
        blind_rows = inputs["blind_results"]
        bulk_rows = inputs["bulk_results"]
        blind_overlays = [
            inputs[f"blind_overlay_{i}"]
            for i, _path in enumerate(args.blind_overlay, 1)
        ]
        bulk_overlays = [
            inputs[f"bulk_overlay_{i}"]
            for i, _path in enumerate(args.bulk_overlay, 1)
        ]
        report = compare_rows(
            selection_rows, blind_rows, bulk_rows, blind_overlays, bulk_overlays,
        )
        _write_private(output_path, report)
    except AuditInputError as exc:
        raise SystemExit(str(exc)) from None
    except OSError:
        raise SystemExit("private_output_write_failed") from None
    print(json.dumps({
        "output": str(output_path),
        "selection_cases": report["selection"]["cases"],
        "comparable_cases": report["coverage"]["case_comparable"],
        "differences": len(report["differences"]),
        "missing_cases": len(report["coverage"]["missing_cases"]),
    }, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
