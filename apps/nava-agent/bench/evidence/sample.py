"""Probability sample freeze. Must run before evaluating predictions or new labels."""
from __future__ import annotations

from collections import defaultdict
from typing import Any

from .dedup import salted_sort_key
from .schema import (
    CURATED_CHALLENGE_PER_WORKFLOW,
    HUMAN_REVIEW_POLICY_CAP,
    HUMAN_REVIEW_RANDOM_CAP,
    SAMPLE_VERSION,
    SENIOR_CONFLICT_CAP,
    STRATUM_CAPS,
)
from .sources import AccessibleFrames


def assign_stratum(case_id: str, route: str) -> str:
    route = (route or "?").lower()
    if route == "skip":
        return "classifier_skip"
    if route in ("create", "quote", "amend", "cancel", "filing", "triage"):
        return f"retained_{route}"
    return "residual_prefilter"


def build_stratum_populations(frames: AccessibleFrames) -> dict[str, list[str]]:
    """Pre-outcome routing/filter stratum from labels (sampling label, not adjudicated workflow)."""
    pops: dict[str, list[str]] = defaultdict(list)
    for cid, route in frames.label_routes.items():
        pops[assign_stratum(cid, route)].append(cid)
    for k, ids in list(pops.items()):
        pops[k] = sorted(set(ids))
    # upstream_exclude: row IDs unavailable — empty population with blocker
    pops.setdefault("upstream_exclude", [])
    return dict(pops)


def freeze_probability_sample(
    frames: AccessibleFrames,
    *,
    seed: str,
) -> dict[str, Any]:
    populations = build_stratum_populations(frames)
    residual_n = len(populations.get("residual_prefilter", []))
    upstream_cap = STRATUM_CAPS["upstream_exclude"]
    residual_cap = STRATUM_CAPS["residual_prefilter"]

    # Reallocate up to 12 from upstream excludes into residual when residual nonempty,
    # keeping both strata nonempty if populated.
    effective_caps = dict(STRATUM_CAPS)
    if residual_n > 0 and upstream_cap > 0:
        take = min(residual_cap, upstream_cap)
        # upstream has no IDs — residual gets its own cap; upstream remains aggregate-only
        effective_caps["residual_prefilter"] = min(residual_cap, residual_n)
        effective_caps["upstream_exclude"] = upstream_cap  # unfilled; see blockers
    elif residual_n == 0:
        effective_caps["residual_prefilter"] = 0

    strata_out = []
    selected: list[dict[str, Any]] = []
    selected_ids: set[str] = set()

    for stratum, cap in effective_caps.items():
        pop = populations.get(stratum, [])
        N_h = len(pop)
        if stratum == "upstream_exclude":
            strata_out.append(
                {
                    "stratum": stratum,
                    "N_h": None,
                    "N_h_aggregate_only": True,
                    "n_h": 0,
                    "pi": None,
                    "cap": cap,
                    "ids": [],
                    "blocker": "rejected_row_ids_unavailable_in_mail_funnel",
                }
            )
            continue
        # Census smaller strata: take min(cap, N_h)
        n_h = min(cap, N_h) if cap else 0
        ordered = sorted(pop, key=lambda cid: salted_sort_key(cid, seed))
        picked = ordered[:n_h]
        pi = (n_h / N_h) if N_h else None
        strata_out.append(
            {
                "stratum": stratum,
                "N_h": N_h,
                "n_h": n_h,
                "pi": pi,
                "cap": cap,
                "ids": picked,
            }
        )
        for cid in picked:
            selected_ids.add(cid)
            selected.append({"case_id": cid, "stratum": stratum, "inclusion_pi": pi})

    # Curated challenges: slots reserved, empty until lead supplies IDs (no invention).
    curated = {
        "per_workflow_cap": CURATED_CHALLENGE_PER_WORKFLOW,
        "workflows": sorted(
            {"create", "quote", "amend", "cancel", "filing", "triage"}
        ),
        "max_total": CURATED_CHALLENGE_PER_WORKFLOW * 6,
        "ids": [],
        "note": "curated challenges not prevalence evidence; dedupe against probability sample when filled",
    }

    roster = {
        "schema": SAMPLE_VERSION,
        "seed": seed,
        "version": SAMPLE_VERSION,
        "frozen_before_evaluation": True,
        "strata": strata_out,
        "selected": sorted(selected, key=lambda r: (r["stratum"], r["case_id"])),
        "selected_n": len(selected_ids),
        "selected_ids_sorted": sorted(selected_ids),
        "content_hash_of_ids": salted_sort_key("|".join(sorted(selected_ids)), seed),
        "curated_challenges": curated,
        "human_review_caps": {
            "random_agreement_checks": HUMAN_REVIEW_RANDOM_CAP,
            "prioritized_policy_disputes": HUMAN_REVIEW_POLICY_CAP,
            "total_check_range": [HUMAN_REVIEW_RANDOM_CAP, HUMAN_REVIEW_RANDOM_CAP + HUMAN_REVIEW_POLICY_CAP],
            "senior_conflict_cap": SENIOR_CONFLICT_CAP,
            "note": "remainder stays contested; no manufactured consensus",
        },
        "populations": {k: len(v) for k, v in sorted(populations.items())},
        "limitations": [
            "upstream_exclude stratum has aggregate funnel counts only; no population-recall claim",
            "stratum labels are pre-outcome routing, not adjudicated workflow",
            "curated challenge IDs not invented by this prep",
        ],
    }
    return roster
