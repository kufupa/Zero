"""Raw funnel manifest. Compare complete accessible frames, not selected-only."""
from __future__ import annotations

from collections import Counter
from typing import Any

from .sources import AccessibleFrames


def build_funnel_manifest(frames: AccessibleFrames) -> dict[str, Any]:
    route_counts = Counter(frames.label_routes.values())
    workflow_counts = Counter(frames.v6_case_ids.values())
    split_counts = Counter(frames.v6_split.values())

    funnel_agg = frames.mail_funnel if isinstance(frames.mail_funnel, dict) else {}
    # mail-funnel.json has aggregate rejection counts, not rejected rows.
    excluded_row_ids_available = False
    upstream_exclude_agg = {
        "unique_excluded:ota_or_system": funnel_agg.get("unique_excluded:ota_or_system"),
        "unique_excluded:noise_sender": funnel_agg.get("unique_excluded:noise_sender"),
        "source_observations:ota_or_system": funnel_agg.get("source_observations:ota_or_system"),
        "source_observations:noise_sender": funnel_agg.get("source_observations:noise_sender"),
        "duplicate_message_id": funnel_agg.get("duplicate_message_id"),
    }

    retained_routes = {r: route_counts.get(r, 0) for r in ("create", "quote", "amend", "cancel", "filing", "triage")}
    classifier_skip_n = route_counts.get("skip", 0)
    residual_n = route_counts.get("?", 0) + sum(v for k, v in route_counts.items() if k not in retained_routes and k != "skip")

    # Distinct raw inbound identity: mutually exclusive terminal frame states among accessible rows.
    label_n = len(frames.label_routes)
    v6_n = len(frames.v6_case_ids)
    retro_in_n = len(frames.retro_inbound_ids)
    retro_out_n = len(frames.retro_outbound_ids)

    halloween = {
        "inputs_n": len(frames.halloween_decision_ids),
        "outcomes_expected": 1530,
        "journeys_path_present": frames.source_hashes.get("halloween_journeys", {}).get("exists"),
        "backtest_is_independent": False,
    }

    attrition = [
        {"stage": "mail_funnel_aggregate_sources", "n": funnel_agg.get("source:sqlite"), "note": "aggregate_only"},
        {"stage": "mail_funnel_kept_inbound", "n": funnel_agg.get("kept_inbound"), "note": "aggregate_only"},
        {"stage": "mail_funnel_kept_threads", "n": funnel_agg.get("kept_threads"), "note": "aggregate_only"},
        {"stage": "labels_prefilter_frame", "n": label_n, "note": "row_ids_available"},
        {"stage": "labels_classifier_skip", "n": classifier_skip_n, "note": "row_ids_available"},
        {"stage": "labels_residual_unlabelled", "n": residual_n, "note": "row_ids_available"},
        {"stage": "v6_selected_benchmark", "n": v6_n, "note": "row_ids_available_regression_only"},
        {"stage": "retro_inbound_export", "n": retro_in_n, "note": "row_ids_available"},
        {"stage": "retro_outbound_export", "n": retro_out_n, "note": "supporting_not_client_request"},
        {"stage": "halloween_inputs", "n": halloween["inputs_n"], "note": "separate_historical_frame"},
    ]

    sampling_blockers = []
    if not excluded_row_ids_available:
        sampling_blockers.append(
            {
                "stratum": "upstream_exclude",
                "reason": "mail_funnel_has_aggregate_rejection_counts_not_rejected_rows",
                "aggregate": upstream_exclude_agg,
                "population_recall_claim": False,
            }
        )

    # Reconcile: labelled frame should partition into retained + skip + residual.
    partition_sum = sum(retained_routes.values()) + classifier_skip_n + residual_n
    reconcile = {
        "label_rows": label_n,
        "partition_sum": partition_sum,
        "partition_ok": partition_sum == label_n,
        "v6_subset_of_labels": sum(1 for cid in frames.v6_case_ids if cid in frames.label_routes),
        "v6_missing_label": sorted(cid for cid in frames.v6_case_ids if cid not in frames.label_routes)[:20],
        "v6_missing_label_n": sum(1 for cid in frames.v6_case_ids if cid not in frames.label_routes),
    }

    return {
        "schema": "ce-funnel-manifest/v1",
        "mail_funnel_aggregates": funnel_agg,
        "upstream_exclude_aggregates": upstream_exclude_agg,
        "excluded_row_ids_available": excluded_row_ids_available,
        "accessible_counts": {
            "retro_inbound": retro_in_n,
            "retro_outbound": retro_out_n,
            "retro_quarantine": dict(frames.retro_quarantine),
            "labels": label_n,
            "label_routes": dict(route_counts),
            "v6_cases": v6_n,
            "v6_workflows": dict(workflow_counts),
            "v6_splits": dict(split_counts),
            "halloween": halloween,
        },
        "retained_route_counts": retained_routes,
        "classifier_skip_n": classifier_skip_n,
        "residual_prefilter_n": residual_n,
        "attrition": attrition,
        "sampling_blockers": sampling_blockers,
        "reconcile": reconcile,
        "unavailable_sources": frames.unavailable,
        "note": "distinct raw inbound = mutually exclusive terminal states among accessible rows; duplicates are aliases",
    }
