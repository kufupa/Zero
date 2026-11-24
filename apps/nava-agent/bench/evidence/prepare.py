#!/usr/bin/env python3
"""Immutable-source preparation for U2/U3. Stdout = aggregates only. No model calls."""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

# Allow `python3 prepare.py` from this directory or module invocation.
_PKG = Path(__file__).resolve().parent
if str(_PKG.parent) not in sys.path:
    sys.path.insert(0, str(_PKG.parent))

from evidence.adjudicate import build_v7_candidates, write_v7  # noqa: E402
from evidence.dedup import build_v6_alias_index, halloween_not_independent, stable_hash  # noqa: E402
from evidence.funnel import build_funnel_manifest  # noqa: E402
from evidence.privacy import public_private_layout, write_json, write_jsonl  # noqa: E402
from evidence.sample import freeze_probability_sample  # noqa: E402
from evidence.schema import SAMPLE_VERSION, SCHEMA_VERSION  # noqa: E402
from evidence.sources import SourcePaths, default_paths, load_accessible_frames  # noqa: E402
from evidence.tables import build_tables  # noqa: E402


def _agg_print(obj: dict) -> None:
    print(json.dumps(obj, sort_keys=True, separators=(",", ":")))


def run_once(paths: SourcePaths, out_dir: Path, seed: str) -> dict:
    frames = load_accessible_frames(paths)
    funnel = build_funnel_manifest(frames)
    alias = build_v6_alias_index(frames.v6_case_ids.keys(), frames.label_routes.keys())
    halloween_dedup = halloween_not_independent(frames.halloween_decision_ids, frames.halloween_backtest_ids)

    # Freeze roster BEFORE tables/v7 evaluation materialization of sampled gold.
    roster = freeze_probability_sample(frames, seed=seed)
    roster_ids = set(roster["selected_ids_sorted"])

    tables = build_tables(paths)
    v7 = build_v7_candidates(paths, roster_ids=roster_ids)

    layout = public_private_layout(out_dir)
    digests = {
        "source_manifest": write_json(out_dir / "source-manifest.json", frames.source_hashes),
        "funnel_manifest": write_json(out_dir / "funnel-manifest.json", funnel),
        "halloween_dedup": write_json(out_dir / "halloween-view-dedup.json", halloween_dedup),
        "alias_index": write_json(
            layout["public"] / "alias-index.json",
            {
                "n_canonical": len(alias.aliases_of),
                "note": "full alias map in label-private; public keeps counts",
                "v6_n": len(frames.v6_case_ids),
                "label_n": len(frames.label_routes),
                "v6_also_labelled": sum(1 for c in frames.v6_case_ids if c in frames.label_routes),
            },
        ),
        "roster_frozen": write_json(layout["public"] / "roster-frozen.json", roster),
        "public_frame": write_jsonl(layout["public"] / "frame.jsonl", tables["public_frame"]),
        "fact_refs": write_jsonl(layout["public"] / "fact-refs.jsonl", tables["facts"]),
        "request_table": write_jsonl(layout["public"] / "tables" / "request.jsonl", tables["requests"]),
        "outcome_table": write_jsonl(layout["public"] / "tables" / "attributable_outcome.jsonl", tables["outcomes"]),
        "later_table": write_jsonl(layout["public"] / "tables" / "later_unknown.jsonl", tables["later"]),
        "field_policy": write_json(layout["public"] / "field-policy.json", v7["field_policy"]),
        "quarantine": write_json(out_dir / "quarantine.json", tables["quarantine"]),
        "coverage": write_json(
            out_dir / "coverage.json",
            {
                "table_counts": tables["counts"],
                "funnel_reconcile": funnel.get("reconcile"),
                "sampling_blockers": funnel.get("sampling_blockers"),
                "unavailable_sources": frames.unavailable,
                "clock_acl_attachment": {
                    "note": "public frame carries clock precision + attachment refs; ACL gaps quarantined by count",
                    "quarantine": tables["quarantine"],
                },
            },
        ),
    }

    # Private: alias full map + private index + v7 candidates (evaluator-only)
    write_json(
        layout["label_private"] / "alias-index-full.json",
        {cid: alias.record(cid) for cid in sorted(set(frames.v6_case_ids) | set(frames.label_routes))},
    )
    write_jsonl(layout["label_private"] / "private-index.jsonl", tables["private_index"])
    write_v7(layout["label_private"] / "v7-candidates.jsonl", v7)
    digests["v7_header"] = write_json(
        layout["label_private"] / "v7-header.json",
        {k: v for k, v in v7.items() if k != "units"},
    )

    id_list = sorted(roster["selected_ids_sorted"])
    frame_ids = sorted(r["case_id"] for r in tables["public_frame"] if r.get("frame") == "v6_selected")
    return {
        "digests": digests,
        "roster_content_hash": roster["content_hash_of_ids"],
        "sorted_roster_ids_hash": stable_hash(*id_list),
        "sorted_v6_frame_ids_hash": stable_hash(*frame_ids),
        "facts_n": len(tables["facts"]),
        "requests_n": len(tables["requests"]),
        "outcomes_n": len(tables["outcomes"]),
        "later_n": len(tables["later"]),
        "v7_units_n": v7["units_n"],
        "funnel_label_n": funnel["accessible_counts"]["labels"],
        "v6_n": funnel["accessible_counts"]["v6_cases"],
        "halloween_inputs_n": funnel["accessible_counts"]["halloween"]["inputs_n"],
        "sampling_blockers_n": len(funnel.get("sampling_blockers") or []),
        "roster_selected_n": roster["selected_n"],
    }


def dual_build_check(paths: SourcePaths, out_dir: Path, seed: str) -> dict:
    """Two builds on immutable inputs → identical sorted IDs and content hashes."""
    a_dir = out_dir / "_build_a"
    b_dir = out_dir / "_build_b"
    for d in (a_dir, b_dir):
        if d.exists():
            for p in sorted(d.rglob("*"), reverse=True):
                if p.is_file():
                    p.unlink()
                elif p.is_dir():
                    p.rmdir()
        d.mkdir(parents=True, exist_ok=True)
    a = run_once(paths, a_dir, seed)
    b = run_once(paths, b_dir, seed)
    keys = [
        "roster_content_hash",
        "sorted_roster_ids_hash",
        "sorted_v6_frame_ids_hash",
        "facts_n",
        "requests_n",
        "outcomes_n",
        "later_n",
        "v7_units_n",
        "roster_selected_n",
    ]
    mismatches = [k for k in keys if a.get(k) != b.get(k)]
    # Compare public roster file bytes
    ra = (a_dir / "public" / "roster-frozen.json").read_bytes()
    rb = (b_dir / "public" / "roster-frozen.json").read_bytes()
    fa = (a_dir / "public" / "frame.jsonl").read_bytes()
    fb = (b_dir / "public" / "frame.jsonl").read_bytes()
    ok = not mismatches and ra == rb and fa == fb
    return {
        "ok": ok,
        "mismatches": mismatches,
        "roster_bytes_equal": ra == rb,
        "frame_bytes_equal": fa == fb,
        "a": a,
        "b": b,
        "check_keys": {k: a.get(k) for k in keys},
    }


def promote_build(src: Path, dest: Path) -> None:
    dest.mkdir(parents=True, exist_ok=True)
    for path in src.rglob("*"):
        rel = path.relative_to(src)
        target = dest / rel
        if path.is_dir():
            target.mkdir(parents=True, exist_ok=True)
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(path.read_bytes())


def main(argv: list[str] | None = None) -> int:
    # Safety: never carry pilot DB into local prep
    for k in ("DATABASE_URL", "TEST_DATABASE_URL", "VITEST_ALLOW_PILOT_RDS"):
        os.environ.pop(k, None)

    parser = argparse.ArgumentParser(description="U2/U3 immutable evidence prep (aggregate stdout)")
    parser.add_argument(
        "--out",
        type=Path,
        default=Path("/home/orca/.local/share/zero/runs/centurion-end-to-end-20261124-tMFz86/local-artifacts/evidence"),
    )
    parser.add_argument("--seed", default=f"{SAMPLE_VERSION}|centurion-calibration|2026-11-24")
    parser.add_argument("--overnight-root", type=Path, default=None)
    parser.add_argument("--skip-dual", action="store_true")
    args = parser.parse_args(argv)

    paths = default_paths()
    if args.overnight_root:
        paths.overnight_root = args.overnight_root

    args.out.mkdir(parents=True, exist_ok=True)
    command = " ".join(["python3", str(Path(__file__).resolve()), *sys.argv[1:]])

    if args.skip_dual:
        summary = run_once(paths, args.out, args.seed)
        dual = {"ok": None, "skipped": True}
    else:
        dual = dual_build_check(paths, args.out, args.seed)
        # Promote build A into out root (stable tree)
        promote_build(args.out / "_build_a", args.out)
        summary = dual["a"]

    receipt = {
        "unit": "U2+U3",
        "command": command,
        "cwd": str(Path.cwd()),
        "schema": SCHEMA_VERSION,
        "sample_version": SAMPLE_VERSION,
        "seed": args.seed,
        "out": str(args.out),
        "dual_build": dual,
        "summary": summary,
        "limitations": [
            "No model API calls",
            "No staff adjudication invented; v7 units remain candidate/missing/contested/unverified",
            "upstream_exclude stratum not ID-sampleable (funnel aggregates only)",
            "capturedAt unknown for case exports — left unknown, not invented",
            "Halloween backtest inputs not counted as independent examples",
            "Blind adjudication and curated challenges await coordinator/lead",
            "No .env or credential reads",
            "Compare counts from complete accessible frames, not selected-only",
        ],
        "completion_markers": {
            "roster_frozen_before_evaluation": True,
            "fake_confirmed_gold": False,
            "external_calls": False,
        },
    }
    write_json(args.out / "receipt.json", receipt)

    # Final aggregate-only stdout
    _agg_print(
        {
            "ok": bool(dual.get("ok", True)),
            "files_out": str(args.out),
            "roster_selected_n": summary.get("roster_selected_n") if isinstance(summary, dict) else None,
            "v6_n": summary.get("v6_n") if isinstance(summary, dict) else None,
            "facts_n": summary.get("facts_n") if isinstance(summary, dict) else None,
            "dual_build_ok": dual.get("ok"),
            "sampling_blockers_n": summary.get("sampling_blockers_n") if isinstance(summary, dict) else None,
            "receipt": str(args.out / "receipt.json"),
        }
    )
    return 0 if dual.get("ok", True) else 2


if __name__ == "__main__":
    raise SystemExit(main())
