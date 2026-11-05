#!/usr/bin/env python3
"""Synthetic-only model-boundary check for the Centurion pilot review prompt.

This helper builds only hand-authored examples, imports the approved review
runner, and never opens corpus packets, manifests, saved mail, or .private data.
Local self-tests make no network calls. Model calls require explicit run,
route, retention, cost, prompt, and runner-SHA guards. Transcripts are neither
printed nor persisted.

Offline checks:
    python3 -I -B pilot-250-synthetic-eval.py --self-test

Authorized synthetic model evaluation:
    python3 -I -B pilot-250-synthetic-eval.py --run-models \
      --route-verified --owner-confirmed-zero-retention \
      --owner-authorized-luna-max-costs
"""

from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import importlib.util
import json
import pathlib
import sys
from dataclasses import dataclass
from typing import Any


HERE = pathlib.Path(__file__).resolve().parent
REVIEW_PATH = HERE / "pilot-250-review.py"
EXPECTED_REVIEW_SHA256 = "8218969d815a966fc30d936a759c557f14ab1d2bdece1b4a21ce850f70a598da"
PINNED_PROMPT_SCHEMA_SHA256 = "feeebf551723140b9e0703263c14a2ed57285ee01a63c21034a2ef0b9ef87a3c"
EXPECTED_ENDPOINT_SHA256 = "7cbded1e0844b02d82afa6ffd1d79d2e83e66558d05f38613403b224d4dd9bbf"
MAX_CONCURRENCY = 16
TIMEOUT_SECONDS = 900
RETRIES = 1
SAFE_CALL_ERROR_CODES = frozenset({
    "request_encoding", "response_too_large", "invalid_response", "output_incomplete",
    "rate_limited", "upstream_timeout", "upstream_server", "http_failure",
    "network_timeout", "network_failure", "request_failed", "internal",
})


@dataclass(frozen=True)
class SyntheticCase:
    key: str
    expected: str
    subject: str
    body: str
    sender_domain: str = "synthetic.example.test"
    no_reply_sender_clue: bool = False
    attachment_inventory: dict[str, Any] | None = None


def _room_details(count: int) -> str:
    return "; ".join(f"room {n}: one separately specified standard room" for n in range(1, count + 1))


def _same_episode_body(count: int) -> str:
    return (
        f"Please make one room request episode SYN-ROOM-{count:03d} for one stay from "
        f"2026-11-20 to 2026-11-22. The requested total for this same episode is exactly "
        f"{count} rooms. { _room_details(count) }. This is not a group or event booking; "
        "each room is a separately specified one-room create, and no group, spreadsheet, "
        "or linked-reservation function is required."
    )


_EMPTY_INVENTORY: dict[str, Any] = {"availability": "unknown", "attachments": []}

CASES: tuple[SyntheticCase, ...] = (
    SyntheticCase(
        key="rooms_exact_10",
        expected="one same-episode 10-room request; threshold does not exclude it",
        subject="Synthetic one-episode room request",
        body=_same_episode_body(10),
    ),
    SyntheticCase(
        key="rooms_exact_11",
        expected="one same-episode 11-room request; threshold excludes it",
        subject="Synthetic one-episode room request",
        body=_same_episode_body(11),
    ),
    SyntheticCase(
        key="separate_small_episodes",
        expected="two unrelated 6-room episodes remain separate; do not sum to 12",
        subject="Two unrelated synthetic reservation requests",
        body=(
            "Request SYN-EP-A separately asks for six standard rooms for 2026-11-10 to "
            "2026-11-12. Request SYN-EP-B is another unrelated six-room reservation request "
            "for 2026-12-10 to 2026-12-12. These are two distinct room-request episodes, "
            "not one combined block; no shared group, event, spreadsheet, or linked-reservation "
            "function is required."
        ),
    ),
    SyntheticCase(
        key="linked_6_plus_6_over_10",
        expected="one linked episode totals 12 rooms and is out of scope",
        subject="Synthetic linked room allocations",
        body=(
            "For event SYN-EVENT-612, one combined conference request asks for a total of "
            "12 rooms: 6 in the north wing and 6 in the south wing. Both allocations belong "
            "to the same event, dates, and request episode; this is one linked group block."
        ),
    ),
    SyntheticCase(
        key="mixed_booking_billing",
        expected="new booking and billing remain separate material work items",
        subject="Synthetic booking and invoice request",
        body=(
            "Please make a new one-room reservation for 2026-11-21 to 2026-11-22 under "
            "reference SYN-MIX-NEW. Separately, for existing reservation SYN-MIX-BILL, "
            "please correct the company billing address and reissue the invoice; this is "
            "billing work for that existing stay, not the new booking."
        ),
    ),
    SyntheticCase(
        key="ota_integration_fix",
        expected="automated and channel origin do not erase explicit create/fix work",
        subject="Automated OTA integration failure",
        body=(
            "Automated channel/OTA integration notice: the one-room reservation "
            "SYN-OTA-501 for 2026-12-05 to 2026-12-07 failed to import into the hotel system. "
            "Please fix the failed import by creating this reservation in HMS."
        ),
        sender_domain="ota-gateway.example.test",
        no_reply_sender_clue=True,
    ),
    SyntheticCase(
        key="quoted_reminder_request",
        expected="outstanding quoted amendment remains the current task",
        subject="Reminder about an outstanding synthetic amendment",
        body=(
            "I am following up because the earlier change request is still outstanding:\n"
            "> Please amend stay SYN-AMP-044 to move the arrival to 2026-12-03.\n"
            "This reminder adds no new stay details."
        ),
    ),
    SyntheticCase(
        key="two_stays_one_message",
        expected="new booking and amendment map to two distinct stays",
        subject="Two separate synthetic stays",
        body=(
            "For new and separate stay SYN-NEW-502, please book one room for 2026-11-10 "
            "through 2026-11-12. For another existing stay, SYN-AMD-813, please amend the "
            "arrival to 2026-11-18 and keep departure unchanged. These are two different "
            "reservations."
        ),
    ),
    SyntheticCase(
        key="inline_receipt_bytes_unavailable",
        expected="claimed inline POP creates a filing task; no bytes or clearance inferred",
        subject="Synthetic inline payment receipt",
        body=(
            "I included inline image inline-synthetic-receipt.png as proof of payment for "
            "reservation SYN-POP-310; please file that receipt on the stay. The image pixels "
            "are not available for review."
        ),
        attachment_inventory={
            "availability": "metadata_only",
            "attachments": [{
                "filename": "inline-synthetic-receipt.png",
                "content_id": "cid:synthetic-receipt",
                "media_type": "image/png",
            }],
        },
    ),
    SyntheticCase(
        key="request_to_send_pop",
        expected="request to send POP is not a sender-supplied file or filing task",
        subject="Synthetic request for proof of payment",
        body=(
            "For reservation SYN-POP-311, please send me the proof of payment document. "
            "This email contains no attached or supplied payment document."
        ),
    ),
    SyntheticCase(
        key="imperative_send_attached_proof",
        expected="imperative to send attached POP is not itself proof of sender supply",
        subject="Synthetic request to send proof of payment",
        body=(
            "Please send the attached proof of payment to the guest for reservation SYN-POP-313."
        ),
    ),
    SyntheticCase(
        key="question_pop_attached",
        expected="question whether POP is attached does not prove that a file was supplied",
        subject="Synthetic attachment question",
        body="For reservation SYN-POP-312, is the proof of payment attached?",
    ),
    SyntheticCase(
        key="voucher_not_proof_or_clearance",
        expected="voucher filing stays distinct from POP and payment clearance",
        subject="Synthetic agency voucher",
        body=(
            "For reservation SYN-VCH-415, agency voucher agency-voucher-synthetic.pdf is "
            "attached; please file the voucher with that stay. No proof of payment is supplied, "
            "and no payment status is stated."
        ),
        attachment_inventory={
            "availability": "metadata_only",
            "attachments": [{
                "filename": "agency-voucher-synthetic.pdf",
                "media_type": "application/pdf",
            }],
        },
    ),
    SyntheticCase(
        key="date_identifier_fidelity",
        expected="amendment evidence preserves the exact stay reference and dates",
        subject="Synthetic dated amendment",
        body=(
            "Please amend stay SYN-RES-455: move arrival from 2026-12-04 to 2026-12-06 "
            "and keep departure on 2026-12-08."
        ),
    ),
)


def _load_review(*, require_frozen_sha: bool = True) -> tuple[Any, str]:
    try:
        source = REVIEW_PATH.read_bytes()
    except OSError:
        raise RuntimeError("review_source_unavailable") from None
    digest = hashlib.sha256(source).hexdigest()
    if require_frozen_sha and digest != EXPECTED_REVIEW_SHA256:
        raise RuntimeError("review_sha_mismatch:" + digest)

    spec = importlib.util.spec_from_file_location("pilot_250_review_for_synthetic_eval", REVIEW_PATH)
    if spec is None:
        raise RuntimeError("review_import_failed")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    try:
        # Compile the exact bytes just hashed so the loaded helper cannot drift
        # from the frozen SHA between a separate hash and file import.
        code = compile(source, str(REVIEW_PATH), "exec")
        exec(code, module.__dict__)
    except Exception:
        sys.modules.pop(spec.name, None)
        raise RuntimeError("review_import_failed") from None
    if module.PROMPT_SHA256 != PINNED_PROMPT_SCHEMA_SHA256:
        raise RuntimeError("prompt_schema_sha_mismatch")
    return module, digest


def _build_packet(review: Any, case: SyntheticCase) -> dict[str, Any]:
    packet = review._synthetic_packet(case_id=case.key, body=case.body)
    target = packet["input"]["target"]
    target.update({
        "subject": case.subject,
        "body": case.body,
        "stored_message_date": "2026-11-01",
        "sender_domain": case.sender_domain,
        "no_reply_sender_clue": case.no_reply_sender_clue,
        "same_from_and_recipient": False,
        "attachment_inventory": case.attachment_inventory or _EMPTY_INVENTORY,
        # Inventory metadata is hand-authored; the synthetic input has no file bytes.
        "attachments": [],
    })
    packet["input"]["prior_messages"] = []
    packet["input"]["context_gaps"] = []
    packet.pop("cleaning", None)
    return packet


def _contains_key(value: Any, target_key: str) -> bool:
    if isinstance(value, dict):
        return target_key in value or any(_contains_key(item, target_key) for item in value.values())
    if isinstance(value, list):
        return any(_contains_key(item, target_key) for item in value)
    return False


def _prepared_cases(review: Any) -> list[dict[str, Any]]:
    prepared: list[dict[str, Any]] = []
    keys: set[str] = set()
    for case in CASES:
        if case.key in keys:
            raise RuntimeError("duplicate_case_key")
        keys.add(case.key)
        packet = _build_packet(review, case)
        projected, removed = review.project_model_input(packet["input"])
        encoded = json.dumps(projected, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        if case.key in encoded or any(sentinel in encoded for sentinel in (
            "SYNTHETIC_CASE_ID_SENTINEL", "SYNTHETIC_CUE_SENTINEL",
            "SYNTHETIC_BINARY_SENTINEL", "SYNTHETIC_CLEANING_CUE_SENTINEL",
        )):
            raise RuntimeError("synthetic_control_or_sentinel_leaked")
        if review._contains_sensitive_payment_data(projected):
            raise RuntimeError("synthetic_sensitive_pattern")
        input_sha = hashlib.sha256(encoded.encode("utf-8")).hexdigest()
        arm_pair_sha = hashlib.sha256(json.dumps(
            {"synthetic": input_sha}, sort_keys=True, separators=(",", ":"),
        ).encode("utf-8")).hexdigest()
        prepared.append({
            "case": case,
            "projected": projected,
            "removed": removed,
            "input_sha": input_sha,
            "arm_pair_sha": arm_pair_sha,
        })
    return prepared


def _assert_safe_payload(review: Any, projected: dict[str, Any], slot: dict[str, str]) -> None:
    payload = review._make_request_body(projected, slot["model"], slot["effort"])
    if payload.get("store") is not False:
        raise RuntimeError("store_guard_failed")
    if _contains_key(payload, "tools"):
        raise RuntimeError("tools_guard_failed")
    if any(_contains_key(payload, key) for key in (
        "max_output_tokens", "max_completion_tokens", "max_tokens",
    )):
        raise RuntimeError("output_cap_guard_failed")
    if payload.get("model") != slot["model"]:
        raise RuntimeError("model_slot_guard_failed")


def _items(assessment: Any) -> list[dict[str, Any]]:
    if not isinstance(assessment, dict) or not isinstance(assessment.get("work_items"), list):
        return []
    return [item for item in assessment["work_items"] if isinstance(item, dict)]


def _docs(assessment: Any) -> list[dict[str, Any]]:
    if not isinstance(assessment, dict) or not isinstance(assessment.get("documents"), list):
        return []
    return [doc for doc in assessment["documents"] if isinstance(doc, dict)]


def _eq(actual: Any, expected: Any) -> bool | None:
    if actual == expected:
        return True
    if actual is None or actual == "unknown":
        return None
    return False


def _action_presence(assessment: Any, action: str) -> bool | None:
    items = _items(assessment)
    if any(item.get("action") == action for item in items):
        return True
    if any(item.get("action") in (None, "unknown") for item in items):
        return None
    return False


def _action_rows(assessment: Any, action: str) -> list[dict[str, Any]]:
    return [item for item in _items(assessment) if item.get("action") == action]


def _exact_count(assessment: Any, action: str, expected: int) -> bool | None:
    rows = _action_rows(assessment, action)
    if not rows:
        return None if any(item.get("action") in (None, "unknown") for item in _items(assessment)) else False
    if len(rows) != 1:
        return False
    observed = rows[0].get("requested_room_count")
    if observed is None:
        observed = rows[0].get("episode_total_room_count")
    return _eq(observed, expected)


def _scope_for_action(assessment: Any, action: str, expected: str) -> bool | None:
    rows = _action_rows(assessment, action)
    if not rows:
        return None if any(item.get("action") in (None, "unknown") for item in _items(assessment)) else False
    if len(rows) != 1:
        return False
    return _eq(rows[0].get("scope"), expected)


def _two_small_requests(assessment: Any) -> dict[str, bool | None]:
    all_items = _items(assessment)
    rows = _action_rows(assessment, "new_booking")
    if len(rows) != 2:
        unresolved = any(item.get("action") in (None, "unknown") for item in all_items)
        value: bool | None = None if unresolved else False
        return {"two_booking_tasks": value, "two_counts_of_6": value, "distinct_episodes": value}

    counts = [row.get("requested_room_count") for row in rows]
    if any(value is None for value in counts):
        count_check: bool | None = None
    else:
        count_check = sorted(counts) == [6, 6]
    episode_ids = [row.get("episode_index") for row in rows]
    if any(value is None or value == "unknown" for value in episode_ids):
        episode_check: bool | None = None
    else:
        episode_check = len(set(episode_ids)) == 2
    scopes = [_eq(row.get("scope"), "in_scope") for row in rows]
    scope_check: bool | None = False if False in scopes else (None if None in scopes else True)
    return {
        "two_booking_tasks": True,
        "two_counts_of_6": count_check,
        "distinct_episodes": episode_check,
        "each_below_threshold_in_scope": scope_check,
    }


def _distinct_stays(assessment: Any) -> dict[str, bool | None]:
    new_rows = _action_rows(assessment, "new_booking")
    amend_rows = _action_rows(assessment, "amendment")
    missing = any(item.get("action") in (None, "unknown") for item in _items(assessment))
    action_check = _action_presence(assessment, "new_booking")
    amend_check = _action_presence(assessment, "amendment")
    if not new_rows or not amend_rows:
        stays: bool | None = None if missing or action_check is None or amend_check is None else False
    elif len(new_rows) != 1 or len(amend_rows) != 1:
        stays = False
    else:
        left, right = new_rows[0].get("stay_index"), amend_rows[0].get("stay_index")
        if left is None or right is None or left == "unknown" or right == "unknown":
            stays = None
        else:
            stays = left != right
    new_quote = _has_quote_fragment(new_rows, "SYN-NEW-502")
    amend_quote = _has_quote_fragment(amend_rows, "SYN-AMD-813")
    return {
        "new_booking": action_check,
        "amendment": amend_check,
        "distinct_stay_indices": stays,
        "new_stay_reference": new_quote,
        "amended_stay_reference": amend_quote,
    }


def _has_quote_fragment(rows: list[dict[str, Any]], fragment: str) -> bool | None:
    if not rows:
        return None
    quotes = [quote for row in rows for quote in row.get("evidence_quotes", []) if isinstance(quote, str)]
    return any(fragment in quote for quote in quotes)


def _quote_fragment_for_action(assessment: Any, action: str, fragment: str) -> bool | None:
    rows = _action_rows(assessment, action)
    if not rows:
        return None if any(item.get("action") in (None, "unknown") for item in _items(assessment)) else False
    quotes = [quote for row in rows for quote in row.get("evidence_quotes", []) if isinstance(quote, str)]
    return any(fragment in quote for quote in quotes)


def _docs_with_kind(assessment: Any, kind: str) -> list[dict[str, Any]]:
    return [doc for doc in _docs(assessment)
            if isinstance(doc.get("kinds"), list) and kind in doc.get("kinds", [])]


def _document_kind(assessment: Any, kind: str) -> bool | None:
    docs = _docs(assessment)
    if _docs_with_kind(assessment, kind):
        return True
    if any("unknown" in doc.get("kinds", []) for doc in docs if isinstance(doc.get("kinds"), list)):
        return None
    return False


def _doc_trigger(docs: list[dict[str, Any]], expected: str = "yes") -> bool | None:
    if not docs:
        return False
    values = [doc.get("filing_trigger") for doc in docs]
    if expected in values:
        return True
    if any(value is None or value == "unknown" for value in values):
        return None
    return False


def _doc_claim(docs: list[dict[str, Any]]) -> bool | None:
    if not docs:
        return False
    allowed = {"explicit_sender_claim", "attachment_metadata"}
    values = [doc.get("file_claim") for doc in docs]
    if any(value in allowed for value in values):
        return True
    if any(value is None or value == "unknown" for value in values):
        return None
    return False


def _negative_pop_file_claim(assessment: Any) -> bool | None:
    docs = _docs(assessment)
    if not docs:
        return True
    values: list[Any] = []
    for doc in docs:
        values.extend((doc.get("filing_trigger"), doc.get("file_claim")))
    if any(value == "yes" or value in ("explicit_sender_claim", "attachment_metadata") for value in values):
        return False
    if any(value is None or value == "unknown" for value in values):
        return None
    return True


def _payment_not_cleared(assessment: Any) -> bool | None:
    return _eq(
        assessment.get("payment_clearance_status") if isinstance(assessment, dict) else None,
        "not_assessed_from_message_packet",
    )


def _bytes_not_sent(assessment: Any) -> bool | None:
    return _eq(
        assessment.get("attachment_bytes_status") if isinstance(assessment, dict) else None,
        "not_sent_not_verified",
    )


def _criteria(case_key: str, assessment: Any) -> dict[str, bool | None]:
    if not isinstance(assessment, dict):
        return {"assessment": None}
    if case_key in ("rooms_exact_10", "rooms_exact_11"):
        count = 10 if case_key == "rooms_exact_10" else 11
        scope = "in_scope" if count == 10 else "out_of_scope"
        return {
            "new_booking": _action_presence(assessment, "new_booking"),
            "same_episode_room_count": _exact_count(assessment, "new_booking", count),
            "threshold_scope": _scope_for_action(assessment, "new_booking", scope),
        }
    if case_key == "separate_small_episodes":
        return _two_small_requests(assessment)
    if case_key == "linked_6_plus_6_over_10":
        return {
            "group_event": _action_presence(assessment, "group_event"),
            "combined_room_count": _exact_count(assessment, "group_event", 12),
            "over_10_out_of_scope": _scope_for_action(assessment, "group_event", "out_of_scope"),
        }
    if case_key == "mixed_booking_billing":
        return {
            "new_booking": _action_presence(assessment, "new_booking"),
            "billing": _action_presence(assessment, "billing"),
        }
    if case_key == "ota_integration_fix":
        origin = assessment.get("origin") if isinstance(assessment.get("origin"), dict) else {}
        return {
            "new_booking": _action_presence(assessment, "new_booking"),
            "automated_origin": _eq(origin.get("automated"), "yes"),
            "channel_origin": _eq(origin.get("channel_ota"), "yes"),
        }
    if case_key == "quoted_reminder_request":
        rows = _action_rows(assessment, "amendment")
        return {
            "quoted_amendment": _action_presence(assessment, "amendment"),
            "quoted_request_text": _has_quote_fragment(rows, "Please amend stay"),
        }
    if case_key == "two_stays_one_message":
        return _distinct_stays(assessment)
    if case_key == "inline_receipt_bytes_unavailable":
        docs = _docs_with_kind(assessment, "proof_of_payment")
        return {
            "proof_of_payment_work": _action_presence(assessment, "proof_of_payment"),
            "proof_document": _document_kind(assessment, "proof_of_payment"),
            "filing_trigger": _doc_trigger(docs),
            "sender_file_claim": _doc_claim(docs),
            "bytes_not_sent": _bytes_not_sent(assessment),
            "payment_not_cleared": _payment_not_cleared(assessment),
        }
    if case_key in ("request_to_send_pop", "imperative_send_attached_proof", "question_pop_attached"):
        return {"not_a_supplied_file_or_filing_task": _negative_pop_file_claim(assessment)}
    if case_key == "voucher_not_proof_or_clearance":
        voucher_docs = _docs_with_kind(assessment, "voucher")
        docs = _docs(assessment)
        if any("proof_of_payment" in doc.get("kinds", []) for doc in docs
               if isinstance(doc.get("kinds"), list)):
            pop_separate: bool | None = False
        elif any("unknown" in doc.get("kinds", []) for doc in docs
                 if isinstance(doc.get("kinds"), list)):
            pop_separate = None
        else:
            pop_separate = True
        payment_claims = [doc.get("payment_claim") for doc in voucher_docs]
        if any(value == "sender_claim" for value in payment_claims):
            payment_separate: bool | None = False
        elif not payment_claims or any(value in (None, "unknown") for value in payment_claims):
            payment_separate = None if payment_claims else False
        else:
            payment_separate = all(value == "no_claim" for value in payment_claims)
        return {
            "voucher_work": _action_presence(assessment, "voucher"),
            "voucher_document": _document_kind(assessment, "voucher"),
            "filing_trigger": _doc_trigger(voucher_docs),
            "sender_file_claim": _doc_claim(voucher_docs),
            "no_pop_inferred": pop_separate,
            "no_payment_claim": payment_separate,
            "bytes_not_sent": _bytes_not_sent(assessment),
            "payment_not_cleared": _payment_not_cleared(assessment),
        }
    if case_key == "date_identifier_fidelity":
        return {
            "amendment": _action_presence(assessment, "amendment"),
            "exact_reference": _quote_fragment_for_action(assessment, "amendment", "SYN-RES-455"),
            "exact_arrival": _quote_fragment_for_action(assessment, "amendment", "2026-12-06"),
            "exact_departure": _quote_fragment_for_action(assessment, "amendment", "2026-12-08"),
        }
    return {"case_definition": False}


@dataclass(frozen=True)
class CaseOutcome:
    status: str
    misses: tuple[str, ...] = ()
    unknowns: tuple[str, ...] = ()


def _score(criteria: dict[str, bool | None]) -> CaseOutcome:
    misses = tuple(name for name, value in criteria.items() if value is False)
    unknowns = tuple(name for name, value in criteria.items() if value is None)
    status = "fail" if misses else "unknown" if unknowns else "pass"
    return CaseOutcome(status, misses, unknowns)


def _score_result(case: SyntheticCase, result: dict[str, Any]) -> CaseOutcome:
    if result.get("status") != "ok" or result.get("parse_status") != "valid":
        return CaseOutcome("unknown", unknowns=("model_call_or_parse",))
    return _score(_criteria(case.key, result.get("normalized")))


def _call_error_category(result: dict[str, Any]) -> str | None:
    """Return only a fixed category; never expose raw exception or response text."""
    if result.get("status") == "error":
        code = result.get("error_code")
        return code if isinstance(code, str) and code in SAFE_CALL_ERROR_CODES else "other_runner_error"
    if result.get("status") == "ok" and result.get("parse_status") not in ("valid", None):
        parse_status = result.get("parse_status")
        return "invalid_output" if parse_status == "invalid_output" else "other_parse_error"
    if result.get("status") != "ok":
        return "unexpected_result_state"
    return None


def _item(action: str, *, scope: str = "in_scope", room_count: int | None = None,
          episode_index: int | None = None, stay_index: int | None = 0,
          evidence_quotes: list[str] | None = None) -> dict[str, Any]:
    return {
        "action": action,
        "scope": scope,
        "requested_room_count": room_count,
        "episode_total_room_count": room_count,
        "episode_index": episode_index,
        "stay_index": stay_index,
        "evidence_quotes": evidence_quotes or [],
    }


def _doc(kind: str, *, trigger: str = "yes", claim: str = "explicit_sender_claim",
         payment_claim: str = "no_claim") -> dict[str, Any]:
    return {
        "kinds": [kind],
        "filing_trigger": trigger,
        "file_claim": claim,
        "payment_claim": payment_claim,
    }


def _fixture_assessment(review: Any, key: str) -> dict[str, Any]:
    result = review._unknown_assessment()
    result["work_items"] = []
    result["documents"] = []
    result["origin"].update({"automated": "unknown", "channel_ota": "unknown"})
    if key == "rooms_exact_10":
        result["work_items"] = [_item("new_booking", room_count=10)]
    elif key == "rooms_exact_11":
        result["work_items"] = [_item("new_booking", scope="out_of_scope", room_count=11)]
    elif key == "separate_small_episodes":
        result["work_items"] = [
            _item("new_booking", room_count=6, episode_index=0),
            _item("new_booking", room_count=6, episode_index=1, stay_index=1),
        ]
    elif key == "linked_6_plus_6_over_10":
        result["work_items"] = [_item("group_event", scope="out_of_scope", room_count=12)]
    elif key == "mixed_booking_billing":
        result["work_items"] = [_item("new_booking"), _item("billing", stay_index=1)]
    elif key == "ota_integration_fix":
        result["work_items"] = [_item("new_booking")]
        result["origin"].update({"automated": "yes", "channel_ota": "yes"})
    elif key == "quoted_reminder_request":
        result["work_items"] = [_item(
            "amendment", evidence_quotes=["Please amend stay SYN-AMP-044 to move the arrival to 2026-12-03."],
        )]
    elif key == "two_stays_one_message":
        result["work_items"] = [
            _item("new_booking", stay_index=0, evidence_quotes=["book stay SYN-NEW-502"]),
            _item("amendment", stay_index=1, evidence_quotes=["amend stay SYN-AMD-813"]),
        ]
    elif key == "inline_receipt_bytes_unavailable":
        result["work_items"] = [_item("proof_of_payment")]
        result["documents"] = [_doc("proof_of_payment")]
    elif key == "request_to_send_pop":
        result["documents"] = []
    elif key in ("imperative_send_attached_proof", "question_pop_attached"):
        result["documents"] = [_doc("proof_of_payment", trigger="unknown", claim="unknown",
                                     payment_claim="unknown")]
    elif key == "voucher_not_proof_or_clearance":
        result["work_items"] = [_item("voucher")]
        result["documents"] = [_doc("voucher")]
    elif key == "date_identifier_fidelity":
        result["work_items"] = [_item(
            "amendment", evidence_quotes=[
                "Please amend stay SYN-RES-455: move arrival from 2026-12-04 to 2026-12-06 and keep departure on 2026-12-08."
            ],
        )]
    return result


def _self_test(review: Any) -> int:
    if len(CASES) < 10 or len({case.key for case in CASES}) != len(CASES):
        raise AssertionError("case_count_or_keys")

    # Confirm the imported synthetic constructor strips its built-in control and
    # binary sentinels before any model-visible projection.
    generated = review._synthetic_packet()
    generated_projection, generated_counts = review.project_model_input(generated["input"])
    generated_json = json.dumps(generated_projection, ensure_ascii=False)
    for sentinel in ("SYNTHETIC_CASE_ID_SENTINEL", "SYNTHETIC_CUE_SENTINEL", "SYNTHETIC_BINARY_SENTINEL"):
        if sentinel in generated_json:
            raise AssertionError("synthetic_constructor_projection")
    if not generated_counts.get("control_fields_removed") or not generated_counts.get("binary_fields_removed"):
        raise AssertionError("projection_removal_counts")

    prepared = _prepared_cases(review)
    if len(prepared) != len(CASES):
        raise AssertionError("prepared_case_count")
    for row in prepared:
        for slot_name in ("luna_max_a", "sol_high"):
            slot = next((item for item in review.SLOTS if item.get("slot") == slot_name), None)
            if slot is None:
                raise AssertionError("missing_approved_slot")
            _assert_safe_payload(review, row["projected"], slot)

    for case in CASES:
        outcome = _score(_criteria(case.key, _fixture_assessment(review, case.key)))
        expected_fixture_status = "unknown" if case.key in (
            "imperative_send_attached_proof", "question_pop_attached",
        ) else "pass"
        if outcome.status != expected_fixture_status:
            raise AssertionError("ground_truth_fixture:" + case.key)

    wrong_ten = review._unknown_assessment()
    wrong_ten["work_items"] = [_item("new_booking", scope="out_of_scope", room_count=11)]
    if _score(_criteria("rooms_exact_10", wrong_ten)).status != "fail":
        raise AssertionError("boundary_negative_fixture")

    unknown = review._unknown_assessment()
    if _score(_criteria("date_identifier_fidelity", unknown)).status != "unknown":
        raise AssertionError("unknown_is_not_failure")

    # Exercise the current validator on ambiguous/non-supplied POP wording and
    # a positive sender claim, without making a model request.
    by_key = {row["case"].key: row["projected"] for row in prepared}
    raw_work = review._synthetic_raw("proof_of_payment", "Is the proof of payment attached?",
                                     scope="in_scope", assistance="unknown", capability=None)
    raw_work["documents"] = [{
        "stay_index": 0, "file_index": None, "kinds": ["proof_of_payment"],
        "file_claim": "explicit_sender_claim", "filing_trigger": "yes",
        "filing_scope": "in_scope", "filing_assistance": "unknown", "capability_ids": [],
        "payment_claim": "unknown", "evidence_quotes": [
            "For reservation SYN-POP-312, is the proof of payment attached?",
        ],
    }]
    normalized, _, parse_status = review._normalize_assessment(raw_work, by_key["question_pop_attached"])
    if parse_status is not None or normalized["documents"][0]["file_claim"] != "unknown" \
            or normalized["documents"][0]["filing_trigger"] != "unknown":
        raise AssertionError("question_is_not_supply_ground_truth")

    request_raw = review._synthetic_raw("proof_of_payment", "Please send me the proof of payment document.",
                                        scope="in_scope", assistance="unknown", capability=None)
    request_raw["documents"] = [{
        "stay_index": 0, "file_index": None, "kinds": ["proof_of_payment"],
        "file_claim": "explicit_sender_claim", "filing_trigger": "yes",
        "filing_scope": "in_scope", "filing_assistance": "unknown", "capability_ids": [],
        "payment_claim": "unknown", "evidence_quotes": [
            "For reservation SYN-POP-311, please send me the proof of payment document.",
        ],
    }]
    normalized, _, parse_status = review._normalize_assessment(request_raw, by_key["request_to_send_pop"])
    if parse_status is not None or normalized["documents"][0]["file_claim"] != "unknown" \
            or normalized["documents"][0]["filing_trigger"] != "unknown":
        raise AssertionError("send_request_is_not_supply_ground_truth")

    imperative_raw = review._synthetic_raw(
        "proof_of_payment", "Please send the attached proof of payment to the guest.",
        scope="in_scope", assistance="unknown", capability=None,
    )
    imperative_raw["documents"] = [{
        "stay_index": 0, "file_index": None, "kinds": ["proof_of_payment"],
        "file_claim": "explicit_sender_claim", "filing_trigger": "yes",
        "filing_scope": "in_scope", "filing_assistance": "unknown", "capability_ids": [],
        "payment_claim": "unknown", "evidence_quotes": [
            "Please send the attached proof of payment to the guest for reservation SYN-POP-313.",
        ],
    }]
    normalized, _, parse_status = review._normalize_assessment(
        imperative_raw, by_key["imperative_send_attached_proof"],
    )
    if parse_status is not None or normalized["documents"][0]["file_claim"] != "unknown" \
            or normalized["documents"][0]["filing_trigger"] != "unknown":
        raise AssertionError("imperative_send_is_not_supply_ground_truth")

    short_fragment_raw = review._synthetic_raw(
        "proof_of_payment", "attached proof of payment",
        scope="in_scope", assistance="unknown", capability=None,
    )
    short_fragment_raw["documents"] = [{
        "stay_index": 0, "file_index": None, "kinds": ["proof_of_payment"],
        "file_claim": "explicit_sender_claim", "filing_trigger": "yes",
        "filing_scope": "in_scope", "filing_assistance": "unknown", "capability_ids": [],
        "payment_claim": "unknown", "evidence_quotes": ["attached proof of payment"],
    }]
    normalized, _, parse_status = review._normalize_assessment(
        short_fragment_raw, by_key["imperative_send_attached_proof"],
    )
    if parse_status is not None or normalized["documents"][0]["file_claim"] != "unknown" \
            or normalized["documents"][0]["filing_trigger"] != "unknown":
        raise AssertionError("short_fragment_restores_request_context")

    supplied_raw = review._synthetic_raw(
        "proof_of_payment", "I included inline image inline-synthetic-receipt.png as proof of payment.",
        scope="in_scope", assistance="unknown", capability=None,
    )
    supplied_raw["documents"] = [{
        "stay_index": 0, "file_index": None, "kinds": ["proof_of_payment"],
        "file_claim": "explicit_sender_claim", "filing_trigger": "yes",
        "filing_scope": "in_scope", "filing_assistance": "unknown", "capability_ids": [],
        "payment_claim": "unknown", "evidence_quotes": [
            "I included inline image inline-synthetic-receipt.png as proof of payment for reservation SYN-POP-310; please file that receipt on the stay."
        ],
    }]
    normalized, _, parse_status = review._normalize_assessment(
        supplied_raw, by_key["inline_receipt_bytes_unavailable"],
    )
    if parse_status is not None or normalized["documents"][0]["file_claim"] != "explicit_sender_claim" \
            or normalized["documents"][0]["filing_trigger"] != "yes":
        raise AssertionError("explicit_supplied_claim_ground_truth")

    filename_raw = review._synthetic_raw(
        "voucher", "agency-voucher-synthetic.pdf",
        scope="in_scope", assistance="unknown", capability=None,
    )
    filename_raw["documents"] = [{
        "stay_index": 0, "file_index": 0, "kinds": ["voucher"],
        "file_claim": "attachment_metadata", "filing_trigger": "yes",
        "filing_scope": "in_scope", "filing_assistance": "unknown", "capability_ids": [],
        "payment_claim": "no_claim", "evidence_quotes": ["agency-voucher-synthetic.pdf"],
    }]
    normalized, _, parse_status = review._normalize_assessment(
        filename_raw, by_key["voucher_not_proof_or_clearance"],
    )
    document = normalized["documents"][0]
    if (parse_status is not None or document["file_claim"] != "attachment_metadata"
            or document["filing_trigger"] != "yes" or document["file_index"] != 0):
        raise AssertionError("dotted_attachment_filename_metadata")

    if _call_error_category({"status": "error", "error_code": "rate_limited"}) != "rate_limited":
        raise AssertionError("safe_error_category")
    if _call_error_category({"status": "error", "error_code": "untrusted response text"}) != "other_runner_error":
        raise AssertionError("untrusted_error_category_redacted")
    if _call_error_category({"status": "ok", "parse_status": "invalid_output"}) != "invalid_output":
        raise AssertionError("parse_error_category")
    if _call_error_category({"status": "ok", "parse_status": "valid"}) is not None:
        raise AssertionError("valid_result_has_no_error_category")

    return 1 + 3 + 1 + 1 + len(CASES) * 2 + len(CASES) + 1 + 1 + 4 + 4 + 2


def _approved_slots(review: Any) -> list[dict[str, str]]:
    wanted = {
        "luna_max_a": ("gpt-6-luna", "max"),
        "sol_high": ("gpt-6.1-sol", "high"),
    }
    found: list[dict[str, str]] = []
    for name, (model, effort) in wanted.items():
        slot = next((row for row in review.SLOTS if row.get("slot") == name), None)
        if slot is None or (slot.get("model"), slot.get("effort")) != (model, effort):
            raise RuntimeError("model_slot_guard_failed")
        found.append(slot)
    return found


def _run_slot(review: Any, endpoint: str, api_key: str, slot: dict[str, str],
              prepared: list[dict[str, Any]]) -> dict[str, Any]:
    summaries: dict[str, dict[str, Any]] = {}
    max_workers = min(MAX_CONCURRENCY, len(prepared))
    with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers) as pool:
        futures: dict[concurrent.futures.Future[dict[str, Any]], dict[str, Any]] = {}
        for row in prepared:
            case: SyntheticCase = row["case"]
            future = pool.submit(
                review._assessment_job,
                endpoint,
                api_key,
                case.key,
                "synthetic",
                1,
                slot,
                row["projected"],
                "synthetic_boundary",
                row["arm_pair_sha"],
                row["input_sha"],
                row["removed"],
                TIMEOUT_SECONDS,
                RETRIES,
            )
            futures[future] = row

        for future in concurrent.futures.as_completed(futures):
            row = futures[future]
            case = row["case"]
            try:
                result = future.result()
            except Exception:
                result = {
                    "status": "error", "error_code": "internal", "parse_status": None, "usage": {},
                    "http_attempts": 0, "normalized": None,
                }
            outcome = _score_result(case, result)
            usage = result.get("usage") if isinstance(result.get("usage"), dict) else {}
            # Drop the structured transcript before retaining or printing any result.
            result.pop("raw_output_text", None)
            summaries[case.key] = {
                "outcome": outcome,
                "call_valid": result.get("status") == "ok" and result.get("parse_status") == "valid",
                "error_category": _call_error_category(result),
                "usage": {
                    key: value for key, value in usage.items()
                    if isinstance(value, int) and not isinstance(value, bool) and value >= 0
                },
                "http_attempts": result.get("http_attempts", 0)
                if isinstance(result.get("http_attempts"), int) else 0,
            }
            result.clear()
    return summaries


def _sum_usage(rows: dict[str, dict[str, Any]], key: str) -> int | None:
    values = [row["usage"][key] for row in rows.values() if key in row.get("usage", {})]
    return sum(values) if values else None


def _outcome_label(outcome: CaseOutcome | None, *, not_attempted: bool = False) -> str:
    if not_attempted:
        return "unknown"
    if outcome is None:
        return "unknown"
    return outcome.status


def _print_report(review_sha: str, prompt_sha: str,
                  per_slot: dict[str, dict[str, dict[str, Any]]], stopped_after_failure: bool) -> None:
    print(
        f"PROVENANCE synthetic_only=true runner_sha256={review_sha} "
        f"prompt_schema_sha256={prompt_sha} endpoint_sha256={EXPECTED_ENDPOINT_SHA256} "
        "store=false tools=none output_token_cap=none timeout_seconds=900 retries=1"
    )
    for case in CASES:
        luna = per_slot.get("luna_max_a", {}).get(case.key)
        sol = per_slot.get("sol_high", {}).get(case.key)
        luna_score = luna["outcome"] if luna else None
        sol_score = sol["outcome"] if sol else None
        pieces = [
            f"CASE {case.key}",
            f"expected={case.expected}",
            f"observed_luna_max={_outcome_label(luna_score)}",
            f"observed_sol_high={_outcome_label(sol_score, not_attempted=stopped_after_failure and sol is None)}",
        ]
        misses = []
        unknowns = []
        for name, summary in (("luna_max", luna), ("sol_high", sol)):
            if summary is None:
                continue
            outcome = summary["outcome"]
            misses.extend(f"{name}:{item}" for item in outcome.misses)
            unknowns.extend(f"{name}:{item}" for item in outcome.unknowns)
        if misses:
            pieces.append("misses=" + ",".join(misses))
        if unknowns:
            pieces.append("unknowns=" + ",".join(unknowns))
        print(" ".join(pieces))

    for slot_name, model in (("luna_max_a", "gpt-6-luna/max"), ("sol_high", "gpt-6.1-sol/high")):
        rows = per_slot.get(slot_name, {})
        statuses = [row["outcome"].status for row in rows.values()]
        attempted = len(rows)
        valid = sum(bool(row.get("call_valid")) for row in rows.values())
        call_failures = attempted - valid
        http_attempts = sum(row.get("http_attempts", 0) for row in rows.values())
        errors: dict[str, int] = {}
        for row in rows.values():
            category = row.get("error_category")
            if isinstance(category, str):
                errors[category] = errors.get(category, 0) + 1
        error_summary = ",".join(f"{key}:{errors[key]}" for key in sorted(errors)) or "none"
        print(
            f"USAGE model={model} attempted={attempted}/{len(CASES)} valid={valid} "
            f"call_failures={call_failures} "
            f"pass={statuses.count('pass')} fail={statuses.count('fail')} unknown={statuses.count('unknown')} "
            f"error_categories={error_summary} "
            f"http_attempts={http_attempts} input_tokens={_sum_usage(rows, 'input_tokens')} "
            f"output_tokens={_sum_usage(rows, 'output_tokens')} total_tokens={_sum_usage(rows, 'total_tokens')}"
        )
    if stopped_after_failure:
        print("STOP model_call_failure=true; no further model slot launched")
    print("LIMITATION hand-authored synthetic outcomes are not real-mail accuracy or production evidence")


def _run_models(review: Any, review_sha: str, args: argparse.Namespace) -> int:
    if not (args.route_verified and args.owner_confirmed_zero_retention
            and args.owner_authorized_luna_max_costs):
        print("GUARD failure=explicit_route_retention_and_cost_acknowledgements_required")
        return 2

    try:
        _self_test(review)
    except Exception:
        print("GUARD failure=offline_synthetic_self_test")
        return 2

    try:
        slots = _approved_slots(review)
        prepared = _prepared_cases(review)
        for row in prepared:
            for slot in slots:
                _assert_safe_payload(review, row["projected"], slot)
        endpoint, api_key = review._route_preflight(
            True,
            expected_endpoint_sha256=EXPECTED_ENDPOINT_SHA256,
        )
    except review.SafeFailure as failure:
        print("GUARD failure=route_preflight code=" + failure.code)
        return 2
    except RuntimeError as failure:
        code = str(failure).split(":", 1)[0]
        print("GUARD failure=" + code)
        return 2

    per_slot: dict[str, dict[str, dict[str, Any]]] = {}
    stopped_after_failure = False
    for slot in slots:
        result = _run_slot(review, endpoint, api_key, slot, prepared)
        per_slot[slot["slot"]] = result
        failed_calls = [row for row in result.values() if not row.get("call_valid")]
        if failed_calls:
            stopped_after_failure = True
            break

    _print_report(review_sha, review.PROMPT_SHA256, per_slot, stopped_after_failure)
    return 2 if stopped_after_failure else 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run only guarded synthetic model-boundary checks.")
    modes = parser.add_mutually_exclusive_group(required=True)
    modes.add_argument("--self-test", action="store_true", help="offline synthetic checks; no network")
    modes.add_argument("--run-models", action="store_true", help="explicitly run guarded synthetic model calls")
    parser.add_argument("--route-verified", action="store_true", help="acknowledge the pinned route preflight")
    parser.add_argument("--owner-confirmed-zero-retention", action="store_true")
    parser.add_argument("--owner-authorized-luna-max-costs", action="store_true")
    args = parser.parse_args(argv)

    try:
        review, review_sha = _load_review()
    except RuntimeError as failure:
        code = str(failure).split(":", 1)[0]
        print("GUARD failure=" + code)
        return 2

    if args.self_test:
        try:
            checks = _self_test(review)
        except Exception as failure:
            code = str(failure).split(":", 1)[0]
            print("SELF-TEST fail=" + code)
            return 1
        print(f"SELF-TEST pass cases={len(CASES)} checks={checks} network_calls=0 private_reads=0")
        return 0
    return _run_models(review, review_sha, args)


if __name__ == "__main__":
    raise SystemExit(main())
