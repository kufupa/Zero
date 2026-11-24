"""U2/U3 evidence contracts. Matches plan FactRef / ReadResult / Expectation shapes.

No rubric weights. Sampling and review caps are plan constants only.
"""
from __future__ import annotations

from typing import Any, Literal, NotRequired, TypedDict

SCHEMA_VERSION = "ce-evidence/v7"
FIELD_POLICY_VERSION = "ce-field-policy/v1"
SAMPLE_VERSION = "ce-calibration-sample/v1"
PROPERTY_TZ = "Africa/Johannesburg"
DEFAULT_PROPERTY = "HRCEN"
DEFAULT_MAILBOX = "centurion-reservations"

# Verification Contract §2 — probability sample caps (not adjudicated workflow).
STRATUM_CAPS: dict[str, int] = {
    "retained_create": 24,
    "retained_quote": 24,
    "retained_amend": 24,
    "retained_cancel": 24,
    "retained_filing": 24,
    "retained_triage": 40,
    "classifier_skip": 40,
    "upstream_exclude": 40,
    "residual_prefilter": 12,  # reallocated from upstream_exclude when residual nonempty
}
CURATED_CHALLENGE_PER_WORKFLOW = 12  # not prevalence evidence; dedupe vs probability sample
HUMAN_REVIEW_RANDOM_CAP = 48
HUMAN_REVIEW_POLICY_CAP = 24
SENIOR_CONFLICT_CAP = 60
FUTURE_WINDOW_DAYS = 7
FUTURE_GRACE_HOURS = 48

Precision = Literal["instant", "date", "unknown"]
AdjudicationStatus = Literal[
    "candidate",
    "confirmed",
    "contested",
    "unobservable",
    "missing",
    "unverified",
]
TableKind = Literal["request", "attributable_outcome", "later_unknown"]
ExpectationMode = Literal["require", "forbid", "defer", "outcome_only", "unobserved"]
FieldPolicyMode = Literal[
    "exact",
    "allowed_set",
    "semantic",
    "deterministic_default",
    "required_abstention",
    "outcome_only",
    "not_observable",
]


class Scope(TypedDict):
    property: str
    mailbox: str


class FactRef(TypedDict):
    id: str
    scope: Scope
    subjectKey: str
    field: str
    sourceId: str
    sourceKind: str
    valueRef: str
    eventAt: str | None
    availableAt: str | None
    capturedAt: str
    precision: Precision
    supersedes: NotRequired[str]


class ReadObserved(TypedDict):
    state: Literal["observed"]
    data: Any
    refs: list[str]


class ReadNoMatch(TypedDict):
    state: Literal["no_match"]
    queryDigest: str
    complete: Literal[True]
    refs: list[str]


class ReadUnobserved(TypedDict):
    state: Literal["unobserved"]
    reason: str


ReadResult = ReadObserved | ReadNoMatch | ReadUnobserved


class ExpectationRequire(TypedDict):
    mode: Literal["require"]
    path: str
    allowed: list[Any]
    refs: list[str]


class ExpectationForbid(TypedDict):
    mode: Literal["forbid"]
    path: str
    predicate: str
    refs: list[str]


class ExpectationDeferred(TypedDict):
    mode: Literal["defer", "outcome_only", "unobserved"]
    path: str
    reason: str


Expectation = ExpectationRequire | ExpectationForbid | ExpectationDeferred

RETENTION_ROUTES = frozenset({"create", "quote", "amend", "cancel", "filing", "triage"})
SKIP_ROUTE = "skip"
