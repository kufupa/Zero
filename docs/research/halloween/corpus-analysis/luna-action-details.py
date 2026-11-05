#!/usr/bin/env python3
"""Private, resumable Luna action-detail batch. Requires explicit case selection."""

from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import importlib.util
import json
import math
import os
import pathlib
import re
import statistics
import sys
import threading
import time
import unicodedata
from typing import Any


HERE = pathlib.Path(__file__).resolve().parent
PROMPT_PATH = HERE / "2026-11-02-luna-action-details-prompt.md"
PROMPT_V2_PATH = HERE / "2026-11-02-luna-action-details-prompt-v2.md"
PROMPT_V3_PATH = HERE / "2026-11-02-luna-action-details-prompt-v3.md"
PROMPT_V4_PATH = HERE / "2026-11-02-luna-action-details-prompt-v4.md"
PROMPT_V5_PATH = HERE / "2026-11-02-luna-action-details-prompt-v5.md"
PROMPT_V6_PATH = HERE / "2026-11-02-luna-action-details-prompt-v6.md"
PROMPT_V7_PATH = HERE / "2026-11-02-luna-action-details-prompt-v7.md"
PROMPT_SHA256 = "85e49bb4dcb40a85521670c947081df4b9b87bc240d46fe07c5b593105588cc1"
PROMPT_V2_SHA256 = "d16f81924f5a8f227805ec17baa8a9c5390bb97c1f94893924b382f37877255f"
PROMPT_V3_SHA256 = "b5d7169d6226a05be1aafdf9a0d1ae934047d11db42bc327659d1f9d3885d0bb"
PROMPT_V4_SHA256 = "4b5852d8ff8ed23b1be96e8f25bc3599364f41e97768bddfa6470667209725d1"
PROMPT_V5_SHA256 = "e975f3dd0da1d1a367f17581fb9bc02fe23a917bd8a0b2628ce0fea3ace771cb"
PROMPT_V6_SHA256 = "b276466d6b4c3bc7f76d5872c3f62cc5f0bfbbb63e990d6c619c3b7162d446cb"
PROMPT_V7_SHA256 = "dfc611f0429001dcfa6024462c54eaa1d69da641a1708251de6806d9eecc24fa"
APPROVED_PROMPTS = {PROMPT_PATH: PROMPT_SHA256, PROMPT_V2_PATH: PROMPT_V2_SHA256,
                    PROMPT_V3_PATH: PROMPT_V3_SHA256, PROMPT_V4_PATH: PROMPT_V4_SHA256,
                    PROMPT_V5_PATH: PROMPT_V5_SHA256, PROMPT_V6_PATH: PROMPT_V6_SHA256,
                    PROMPT_V7_PATH: PROMPT_V7_SHA256}
RUNNER_PATH = HERE / "luna-corpus-runner.py"
VERSION = "centurion-luna-action-details-v1"
MODEL = "gpt-6-luna"
EFFORT = "medium"
ENDPOINT_SHA256 = "7cbded1e0844b02d82afa6ffd1d79d2e83e66558d05f38613403b224d4dd9bbf"
MAX_CONCURRENCY = 16
MAX_CANDIDATES = 100
MAX_INPUT_BYTES = 256_000
MAX_ROWS = 50_000
MAX_RETRIES = 4

ACTION_TYPES = (
    "quote", "booking_create", "booking_amend", "booking_cancel", "file_payment_proof",
    "file_voucher", "issue_voucher", "invoice", "future_payment_request", "other",
)
ACTION_STATES = ("requested", "supplied_for_action", "promised_only", "completed_or_confirmed", "unclear")
SCOPES = ("non_group", "large_group", "unclear")
SPEAKERS = ("hotel_staff", "automated_system", "guest_or_agent", "unclear")
RELATIONS = ("same_request", "different_task_same_stay", "unrelated_or_unclear")
RESPONSE_KINDS = (
    "acknowledgement", "question_or_missing_info", "promise", "completion_claim",
    "document_supplied", "automated_confirmation", "other", "unclear",
)
COMPLETION_CLAIMS = ("not_claimed", "promise_only", "says_complete", "document_claimed_supplied", "unclear")
CONFIDENCE = ("high", "medium", "low")
UNSUPPORTED = {"issue_voucher", "future_payment_request", "other"}


def obj(props: dict[str, Any]) -> dict[str, Any]:
    return {"type": "object", "properties": props, "required": list(props), "additionalProperties": False}


def arr(items: dict[str, Any], maximum: int) -> dict[str, Any]:
    return {"type": "array", "items": items, "maxItems": maximum}


def enum(values: tuple[str, ...]) -> dict[str, Any]:
    return {"type": "string", "enum": list(values)}


ACTION_SCHEMA = obj({
    "action": enum(ACTION_TYPES), "scope": enum(SCOPES), "state": enum(ACTION_STATES),
    "task": {"type": "string", "maxLength": 240},
    "nava_supported": {"type": "boolean"}, "confidence": enum(CONFIDENCE),
    "evidence_quote": {"type": "string", "maxLength": 160},
})
NAVA_SCHEMA = obj({
    "action_index": {"type": "integer"},
    "steps": arr({"type": "string", "maxLength": 180}, 6),
})
REPLY_SCHEMA = obj({
    "reply_id": {"type": "string", "maxLength": 128}, "speaker": enum(SPEAKERS),
    "relation": enum(RELATIONS), "response_kind": enum(RESPONSE_KINDS),
    "completion_claim": enum(COMPLETION_CLAIMS),
    "observed_response": {"type": "string", "maxLength": 240},
    "evidence_quote": {"type": "string", "maxLength": 160},
})
SCHEMA = obj({
    "case": {"type": "string", "maxLength": 128},
    "request_actions": arr(ACTION_SCHEMA, 12),
    "nava_hypothetical": arr(NAVA_SCHEMA, 12),
    "observed_replies": arr(REPLY_SCHEMA, MAX_CANDIDATES),
})


class Failure(Exception):
    def __init__(self, code: str):
        self.code = code


def _safe_code(value: Any) -> str:
    if isinstance(value, str) and re.fullmatch(r"[a-z0-9_]{1,80}", value):
        return value
    return "internal"


def load_runner() -> Any:
    spec = importlib.util.spec_from_file_location("centurion_luna_corpus_runner", RUNNER_PATH)
    if spec is None or spec.loader is None:
        raise Failure("runner_helper_unavailable")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    try:
        spec.loader.exec_module(module)
    except Exception:
        raise Failure("runner_helper_unavailable") from None
    return module


def canonical(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def sha(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def approved_prompt_path(value: pathlib.Path | None) -> tuple[pathlib.Path, str]:
    candidate = pathlib.Path(value) if value is not None else PROMPT_PATH
    if not candidate.is_absolute():
        candidate = pathlib.Path.cwd() / candidate
    candidate = pathlib.Path(os.path.abspath(candidate))
    expected_sha256 = APPROVED_PROMPTS.get(candidate)
    if expected_sha256 is None:
        raise Failure("prompt_path_unapproved")
    try:
        resolved = candidate.resolve(strict=True)
    except (OSError, RuntimeError):
        raise Failure("prompt_unavailable") from None
    if resolved != candidate or candidate.is_symlink() or not candidate.is_file():
        raise Failure("prompt_path_unapproved")
    return candidate, expected_sha256


def verify_prompt_hash(raw: bytes, expected_sha256: str) -> None:
    if sha(raw) != expected_sha256:
        raise Failure("prompt_hash_mismatch")


def read_action_prompt(runner: Any, value: pathlib.Path | None) -> tuple[str, bytes, pathlib.Path]:
    path, expected_sha256 = approved_prompt_path(value)
    prompt, raw = runner._read_prompt(path)
    verify_prompt_hash(raw, expected_sha256)
    return prompt, raw, path


def metadata(value: Any, depth: int = 0) -> Any:
    """Keep short metadata only; do not send attachment bytes, content, or paths."""
    if depth > 5:
        raise Failure("attachment_metadata_too_deep")
    forbidden = {"content", "data", "bytes", "raw_bytes", "base64", "blob", "payload",
                 "path", "file_path", "local_path", "extracted_text", "extracted_html"}
    if isinstance(value, str) and len(value) <= 4_000:
        return value
    if value is None or isinstance(value, (bool, int)):
        return value
    if isinstance(value, float) and math.isfinite(value):
        return value
    if isinstance(value, list) and len(value) <= 50:
        return [metadata(item, depth + 1) for item in value]
    if isinstance(value, dict) and len(value) <= 50:
        if any(not isinstance(key, str) or key.casefold() in forbidden for key in value):
            raise Failure("attachment_metadata_schema")
        return {key: metadata(item, depth + 1) for key, item in value.items()}
    raise Failure("attachment_metadata_schema")


def project(row: Any, runner: Any) -> dict[str, Any]:
    if not isinstance(row, dict) or not isinstance(row.get("case"), str):
        raise Failure("input_row_schema")
    raw = {
        "case": row["case"],
        "inbound": row.get("inbound", row.get("cleaned_inbound")),
        "candidate_replies": row.get("candidate_replies", []),
    }
    try:
        model_input = runner._project_inbound(raw)
    except Exception as exc:
        raise Failure(runner._safe_code(getattr(exc, "code", "input_schema"))) from None
    if len(model_input["candidate_replies"]) > MAX_CANDIDATES:
        raise Failure("candidate_replies_schema")

    # Keep only short attachment metadata; _source and unrelated row fields never leave the host.
    inbound_source = raw["inbound"]
    if isinstance(inbound_source, dict):
        for key in ("attachment_metadata", "attachment_context"):
            if key in inbound_source:
                value = inbound_source[key]
                if key == "attachment_context" and isinstance(value, str) and len(value) <= 8_000:
                    model_input["inbound"][key] = value
                else:
                    model_input["inbound"][key] = metadata(value)
    for source, target in zip(row.get("candidate_replies") or [], model_input["candidate_replies"], strict=True):
        if isinstance(source, dict) and "attachment_metadata" in source:
            target["attachment_metadata"] = metadata(source["attachment_metadata"])

    cls = row.get("classification", row.get("final_classification"))
    if not isinstance(cls, dict) or not isinstance(cls.get("actions"), list):
        raise Failure("input_classification_schema")
    actions = cls["actions"]
    if len(actions) > 12 or any(not isinstance(action, str) or len(action) > 64 for action in actions):
        raise Failure("input_classification_schema")
    can_help = cls.get("can_help")
    if can_help is not None and not isinstance(can_help, bool):
        raise Failure("input_classification_schema")
    if "group_flag" in cls:
        group_flag = cls["group_flag"]
    elif "group" in cls and (isinstance(cls["group"], bool) or cls["group"] is None):
        group_flag = cls["group"]
    else:
        group_flag = "group" in actions
    if group_flag is not None and not isinstance(group_flag, bool):
        raise Failure("input_classification_schema")

    reply_ids = [reply["reply_id"] for reply in model_input["candidate_replies"]]
    classified_ids = cls.get("reply_ids", reply_ids)
    if not isinstance(classified_ids, list) or len(classified_ids) > MAX_CANDIDATES:
        raise Failure("input_classification_reply_ids")
    try:
        classified_ids = [runner._canonical_reply_id(item) for item in classified_ids]
    except Exception:
        raise Failure("input_classification_reply_ids") from None
    if len(set(classified_ids)) != len(classified_ids) or set(classified_ids) != set(reply_ids):
        raise Failure("classification_reply_ids_mismatch")
    invoice_status = cls.get("invoice_status", cls.get("invoice_handling"))
    response_type = cls.get("response_type")
    if any(item is not None and (not isinstance(item, str) or len(item) > 64)
           for item in (invoice_status, response_type)):
        raise Failure("input_classification_schema")
    model_input["classification"] = {
        "can_help": can_help, "actions": actions, "reply_ids": reply_ids,
        "response_type": response_type, "invoice_status": invoice_status,
        "group_flag": group_flag,
    }
    if len(canonical(model_input).encode("utf-8")) > MAX_INPUT_BYTES:
        raise Failure("input_row_too_large")
    return model_input


def strings(value: Any) -> list[str]:
    if isinstance(value, str):
        return [value]
    if isinstance(value, list):
        return [text for item in value for text in strings(item)]
    if isinstance(value, dict):
        return [text for item in value.values() for text in strings(item)]
    return []


def text(value: Any, maximum: int) -> bool:
    return isinstance(value, str) and len(value) <= maximum


def quote_status(quote: str, sources: list[str]) -> str:
    if not quote:
        return "empty"
    if any(quote in source for source in sources):
        return "exact"
    normalize = lambda value: " ".join(unicodedata.normalize("NFKC", value).casefold().split())
    normalized = normalize(quote)
    if not normalized:
        return "unmatched"
    return "normalized" if any(normalized in normalize(source) for source in sources) else "unmatched"


def quote_audit(result: dict[str, Any], model_input: dict[str, Any]) -> dict[str, Any]:
    inbound_text = strings(model_input["inbound"])
    actions = [{"index": index, "status": status}
               for index, item in enumerate(result["request_actions"])
               if (status := quote_status(item["evidence_quote"], inbound_text)) not in ("exact", "empty")]
    replies = [{"reply_id": item["reply_id"], "status": status}
               for item, candidate in zip(result["observed_replies"], model_input["candidate_replies"], strict=True)
               if (status := quote_status(item["evidence_quote"], strings(candidate))) not in ("exact", "empty")]
    return {"request_actions": actions, "observed_replies": replies}


def classification_audit(result: dict[str, Any], model_input: dict[str, Any]) -> dict[str, bool]:
    saw_large_group = any(item["scope"] == "large_group" for item in result["request_actions"])
    return {"large_group_without_final_group_flag":
            saw_large_group and model_input["classification"]["group_flag"] is not True}


NAVA_POLICY_REASONS = {
    "final_can_help_not_true", "large_group_scope", "unclear_scope",
    "unsupported_action", "document_not_supplied_for_action",
}


def normalize_nava_policy(value: Any, model_input: dict[str, Any]) -> tuple[Any, list[dict[str, Any]]]:
    """Correct only Nava support/steps that contradict the frozen classification policy."""
    if not isinstance(value, dict):
        return value, []
    actions = value.get("request_actions")
    nava = value.get("nava_hypothetical")
    if not isinstance(actions, list) or not isinstance(nava, list):
        return value, []

    classification = model_input["classification"]
    corrections: list[dict[str, Any]] = []
    forbidden: set[int] = set()
    for index, action in enumerate(actions):
        if not isinstance(action, dict):
            continue
        reasons = []
        if classification.get("can_help") is not True:
            reasons.append("final_can_help_not_true")
        scope = action.get("scope")
        if scope == "large_group":
            reasons.append("large_group_scope")
        elif scope == "unclear":
            reasons.append("unclear_scope")
        elif scope != "non_group":
            continue
        if action.get("action") in UNSUPPORTED:
            reasons.append("unsupported_action")
        if (action.get("action") in {"file_voucher", "file_payment_proof"}
                and action.get("state") != "supplied_for_action"):
            reasons.append("document_not_supplied_for_action")
        if not reasons:
            continue
        step_entries = [entry for entry in nava
                        if isinstance(entry, dict) and type(entry.get("action_index")) is int
                        and entry["action_index"] == index]
        dropped_steps = sum(len(entry.get("steps")) if isinstance(entry.get("steps"), list) else 0
                            for entry in step_entries)
        was_supported = action.get("nava_supported")
        if was_supported is True or step_entries:
            action["nava_supported"] = False
            forbidden.add(index)
            corrections.append({
                "action_index": index,
                "original_nava_supported": was_supported if isinstance(was_supported, bool) else None,
                "normalized_nava_supported": False,
                "reason_codes": sorted(set(reasons)),
                "dropped_hypothetical_entry_count": len(step_entries),
                "dropped_hypothetical_step_count": dropped_steps,
            })
    if forbidden:
        value["nava_hypothetical"] = [
            entry for entry in nava
            if not (isinstance(entry, dict) and type(entry.get("action_index")) is int
                    and entry["action_index"] in forbidden)
        ]
    return value, corrections


def validate_nava_policy_audit(value: Any, result: dict[str, Any]) -> None:
    if not isinstance(value, list) or len(value) > 12:
        raise Failure("resume_policy_audit_invalid")
    seen: set[int] = set()
    for item in value:
        if not isinstance(item, dict) or set(item) != {
            "action_index", "original_nava_supported", "normalized_nava_supported",
            "reason_codes", "dropped_hypothetical_entry_count", "dropped_hypothetical_step_count",
        }:
            raise Failure("resume_policy_audit_invalid")
        index = item.get("action_index")
        reasons = item.get("reason_codes")
        entries = item.get("dropped_hypothetical_entry_count")
        steps = item.get("dropped_hypothetical_step_count")
        original = item.get("original_nava_supported")
        if (not isinstance(index, int) or isinstance(index, bool) or not 0 <= index < len(result["request_actions"])
                or index in seen or item.get("normalized_nava_supported") is not False
                or result["request_actions"][index]["nava_supported"] is not False
                or (original is not None and not isinstance(original, bool))
                or not isinstance(reasons, list) or not reasons
                or reasons != sorted(set(reasons)) or any(reason not in NAVA_POLICY_REASONS for reason in reasons)
                or not isinstance(entries, int) or isinstance(entries, bool) or not 0 <= entries <= 12
                or not isinstance(steps, int) or isinstance(steps, bool) or not 0 <= steps <= 72
                or (original is not True and entries == 0)):
            raise Failure("resume_policy_audit_invalid")
        seen.add(index)


def validate(value: Any, model_input: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != set(SCHEMA["properties"]):
        raise Failure("output_schema")
    if value.get("case") != model_input["case"]:
        raise Failure("output_case_mismatch")
    actions = value.get("request_actions")
    if not isinstance(actions, list) or len(actions) > 12:
        raise Failure("output_actions_schema")
    for item in actions:
        if not isinstance(item, dict) or set(item) != set(ACTION_SCHEMA["properties"]):
            raise Failure("output_action_schema")
        if (item.get("action") not in ACTION_TYPES or item.get("scope") not in SCOPES
                or item.get("state") not in ACTION_STATES or item.get("confidence") not in CONFIDENCE
                or not isinstance(item.get("nava_supported"), bool)
                or not text(item.get("task"), 240) or not text(item.get("evidence_quote"), 160)):
            raise Failure("output_action_schema")
        if item["nava_supported"] and (
            item["action"] in UNSUPPORTED or item["scope"] != "non_group"
            or model_input["classification"]["can_help"] is not True
            or (item["action"] in {"file_voucher", "file_payment_proof"}
                and item["state"] != "supplied_for_action")
        ):
            raise Failure("output_unsupported_nava_action")
    nava = value.get("nava_hypothetical")
    if not isinstance(nava, list) or len(nava) > 12:
        raise Failure("output_nava_schema")
    expected = {i for i, item in enumerate(actions)
                if item["nava_supported"] and item["scope"] == "non_group"}
    received: set[int] = set()
    for item in nava:
        if not isinstance(item, dict) or set(item) != set(NAVA_SCHEMA["properties"]):
            raise Failure("output_nava_schema")
        index, steps = item.get("action_index"), item.get("steps")
        if (not isinstance(index, int) or isinstance(index, bool) or not 0 <= index < len(actions)
                or index in received or not isinstance(steps, list) or not 1 <= len(steps) <= 6
                or any(not text(step, 180) for step in steps)):
            raise Failure("output_nava_steps_schema")
        received.add(index)
    if received != expected:
        raise Failure("output_nava_coverage_mismatch")

    candidates = model_input["candidate_replies"]
    observed = value.get("observed_replies")
    if not isinstance(observed, list) or len(observed) != len(candidates):
        raise Failure("output_reply_cardinality")
    for item, candidate in zip(observed, candidates, strict=True):
        if not isinstance(item, dict) or set(item) != set(REPLY_SCHEMA["properties"]):
            raise Failure("output_reply_schema")
        if (item.get("reply_id") != candidate["reply_id"] or item.get("speaker") not in SPEAKERS
                or item.get("relation") not in RELATIONS or item.get("response_kind") not in RESPONSE_KINDS
                or item.get("completion_claim") not in COMPLETION_CLAIMS
                or not text(item.get("observed_response"), 240)
                or not text(item.get("evidence_quote"), 160)):
            raise Failure("output_reply_schema")
    return value


def payload(prompt: str, model_input: dict[str, Any]) -> dict[str, Any]:
    return {
        "model": MODEL, "store": False, "reasoning": {"effort": EFFORT},
        "input": [
            {"role": "system", "content": [{"type": "input_text", "text": prompt}]},
            {"role": "user", "content": [{"type": "input_text", "text": canonical(model_input)}]},
        ],
        "text": {"format": {
            "type": "json_schema", "name": "centurion_luna_action_details",
            "strict": True, "schema": SCHEMA,
        }},
    }


def classify(pilot: Any, prompt: str, endpoint: str, key: str, timeout: int,
             retries: int, model_input: dict[str, Any], identity: dict[str, Any], attempt: int) -> dict[str, Any]:
    started = time.perf_counter()
    requests = 0
    usage = {"input_tokens": None, "output_tokens": None, "total_tokens": None}
    try:
        raw, usage_raw, error, requests = pilot._send_request(
            endpoint, key, payload(prompt, model_input), timeout, retries,
        )
        usage = pilot._usage_from_response({"usage": usage_raw})
        if error or raw is None:
            raise Failure(_safe_code(error or "empty_response"))
        try:
            decoded = pilot._strict_json_loads(raw)
            decoded, policy_corrections = normalize_nava_policy(decoded, model_input)
            result = validate(decoded, model_input)
        except Failure:
            raise
        except Exception:
            raise Failure("output_invalid_json") from None
        return {**identity, "case": model_input["case"], "attempt": attempt,
                "request_attempts": requests, "elapsed_seconds": round(time.perf_counter() - started, 3),
                "status": "ok", "usage": usage, "result": result,
                "nava_policy_correction_audit": policy_corrections,
                "evidence_quote_audit": quote_audit(result, model_input),
                "classification_audit": classification_audit(result, model_input)}
    except Exception as exc:
        return {**identity, "case": model_input["case"], "attempt": attempt,
                "request_attempts": requests, "elapsed_seconds": round(time.perf_counter() - started, 3),
                "status": "failed", "error_code": _safe_code(getattr(exc, "code", "internal")),
                "usage": usage}


def future_result(future: Any, identity: dict[str, Any], case: str, attempt: int,
                  started: float) -> dict[str, Any]:
    try:
        record = future.result()
        if not isinstance(record, dict):
            raise TypeError("worker returned a non-object")
        return record
    except Exception as exc:
        return {
            **identity, "case": case, "attempt": attempt, "request_attempts": 0,
            "elapsed_seconds": round(time.perf_counter() - started, 3), "status": "failed",
            "error_code": _safe_code(getattr(exc, "code", "internal")),
            "usage": {"input_tokens": None, "output_tokens": None, "total_tokens": None},
        }


def self_test() -> dict[str, Any]:
    runner = load_runner()
    pilot = runner._load_pilot_helper()
    default_prompt, default_prompt_raw, default_prompt_path = read_action_prompt(runner, None)
    v2_prompt, v2_prompt_raw, v2_prompt_path = read_action_prompt(runner, PROMPT_V2_PATH)
    v3_prompt, v3_prompt_raw, v3_prompt_path = read_action_prompt(runner, PROMPT_V3_PATH)
    v4_prompt, v4_prompt_raw, v4_prompt_path = read_action_prompt(runner, PROMPT_V4_PATH)
    v5_prompt, v5_prompt_raw, v5_prompt_path = read_action_prompt(runner, PROMPT_V5_PATH)
    v6_prompt, v6_prompt_raw, v6_prompt_path = read_action_prompt(runner, PROMPT_V6_PATH)
    v7_prompt, v7_prompt_raw, v7_prompt_path = read_action_prompt(runner, PROMPT_V7_PATH)
    if (default_prompt_path != PROMPT_PATH or sha(default_prompt_raw) != PROMPT_SHA256
            or not default_prompt.strip()):
        raise Failure("self_test_default_prompt_failed")
    if (v2_prompt_path != PROMPT_V2_PATH or sha(v2_prompt_raw) != PROMPT_V2_SHA256
            or "supplier/accounts-payable invoice" not in v2_prompt):
        raise Failure("self_test_v2_prompt_failed")
    if (v3_prompt_path != PROMPT_V3_PATH or sha(v3_prompt_raw) != PROMPT_V3_SHA256
            or "Ancillary charges alone" not in v3_prompt):
        raise Failure("self_test_v3_prompt_failed")
    if (v4_prompt_path != PROMPT_V4_PATH or sha(v4_prompt_raw) != PROMPT_V4_SHA256
            or "recording a requested room/bed preference" not in v4_prompt):
        raise Failure("self_test_v4_prompt_failed")
    if (v5_prompt_path != PROMPT_V5_PATH or sha(v5_prompt_raw) != PROMPT_V5_SHA256
            or "room-nights" not in v5_prompt):
        raise Failure("self_test_v5_prompt_failed")
    if (v6_prompt_path != PROMPT_V6_PATH or sha(v6_prompt_raw) != PROMPT_V6_SHA256
            or "at most ten specified guests" not in v6_prompt):
        raise Failure("self_test_v6_prompt_failed")
    if (v7_prompt_path != PROMPT_V7_PATH or sha(v7_prompt_raw) != PROMPT_V7_SHA256
            or "attachment inventory is unavailable" not in v7_prompt):
        raise Failure("self_test_v7_prompt_failed")
    try:
        approved_prompt_path(HERE / "unapproved-action-details-prompt.md")
    except Failure as exc:
        if exc.code != "prompt_path_unapproved":
            raise
    else:
        raise Failure("self_test_unapproved_prompt_accepted")
    try:
        verify_prompt_hash(default_prompt_raw + b"\n", PROMPT_SHA256)
    except Failure as exc:
        if exc.code != "prompt_hash_mismatch":
            raise
    else:
        raise Failure("self_test_prompt_hash_mismatch_accepted")
    separated = "{\"text\":\"left\u2028right\"}\n".encode("utf-8")
    decoded = runner._decode_jsonl_strict(pilot, separated, "self_test_jsonl")
    if len(decoded) != 1 or decoded[0].get("text") != "left\u2028right":
        raise Failure("self_test_jsonl_separator_failed")
    source = {
        "case": "self-test", "inbound": {"message": "Please book one room for 10 November."},
        "candidate_replies": [{"reply_id": "r1", "body": "We will check availability."}],
        "classification": {"can_help": True, "actions": ["booking"], "reply_ids": ["r1"]},
        "_source": {"ignored": "not model input"},
    }
    model_input = project(source, runner)
    if "_source" in model_input or model_input["classification"]["group_flag"]:
        raise Failure("self_test_projection_failed")
    with_evidence = {**source, "inbound": {**source["inbound"], "attachment_context": "x" * 5_000}}
    if len(project(with_evidence, runner)["inbound"]["attachment_context"]) != 5_000:
        raise Failure("self_test_attachment_context_bound")
    with_evidence["inbound"]["attachment_context"] = "x" * 8_001
    try:
        project(with_evidence, runner)
    except Failure:
        pass
    else:
        raise Failure("self_test_attachment_context_bound")
    if (quote_status("Please book one room", ["Please Book   one room."]) != "normalized"
            or quote_status("not present", ["Please book one room."]) != "unmatched"):
        raise Failure("self_test_quote_audit_failed")
    result = {
        "case": "self-test",
        "request_actions": [{"action": "booking_create", "scope": "non_group", "state": "requested",
                             "task": "Create a one-room booking for 10 November.", "nava_supported": True,
                             "confidence": "high", "evidence_quote": "Please book one room for 10 November."}],
        "nava_hypothetical": [{"action_index": 0, "steps": ["Prepare it for staff review."]}],
        "observed_replies": [{"reply_id": "r1", "speaker": "hotel_staff", "relation": "same_request",
                              "response_kind": "promise", "completion_claim": "promise_only",
                              "observed_response": "Staff say they will check availability.",
                              "evidence_quote": "We will check availability."}],
    }
    validate(result, model_input)
    for mutate in (
        lambda x: x["observed_replies"][0].update(reply_id="invented"),
        lambda x: x["request_actions"][0].update(scope="large_group"),
    ):
        bad = json.loads(json.dumps(result))
        mutate(bad)
        try:
            validate(bad, model_input)
        except Failure:
            continue
        raise Failure("self_test_guard_failed")
    group = project({"case": "group", "inbound": {"message": "Quote 14 rooms."},
                     "candidate_replies": [],
                     "classification": {"can_help": False, "actions": ["quote"], "reply_ids": [],
                                         "group_flag": False}}, runner)
    group_result = {
        "case": "group", "request_actions": [{
            "action": "quote", "scope": "large_group", "state": "requested", "task": "Quote 14 rooms.",
            "nava_supported": False, "confidence": "high", "evidence_quote": "Quote 14 rooms.",
        }], "nava_hypothetical": [], "observed_replies": [],
    }
    validate(group_result, group)
    if not classification_audit(group_result, group)["large_group_without_final_group_flag"]:
        raise Failure("self_test_group_derivation_failed")
    bad_group = json.loads(json.dumps(group_result))
    bad_group["nava_hypothetical"] = [{"action_index": 0, "steps": ["Prepare a large-group quote."]}]
    try:
        validate(bad_group, group)
    except Failure:
        pass
    else:
        raise Failure("self_test_no_help_steps_not_rejected")

    class RequestFailurePilot:
        def _send_request(self, *_args: Any) -> Any:
            raise RuntimeError("synthetic_request_failure")

    try:
        failed_request = classify(RequestFailurePilot(), "", "", "", 1, 0,
                                  model_input, {}, 1)
    except Exception:
        raise Failure("self_test_classify_failure_escaped") from None
    if failed_request.get("status") != "failed" or failed_request.get("error_code") != "internal":
        raise Failure("self_test_classify_failure_record")

    class FixedResponsePilot:
        def __init__(self, response: dict[str, Any]):
            self.response = response

        def _send_request(self, *_args: Any) -> Any:
            return json.dumps(self.response), {}, None, 1

        def _usage_from_response(self, _response: dict[str, Any]) -> dict[str, int | None]:
            return {"input_tokens": 1, "output_tokens": 1, "total_tokens": 2}

        def _strict_json_loads(self, raw: str) -> Any:
            return json.loads(raw)

    mixed_input = project({
        "case": "policy-mixed-self-test",
        "inbound": {"message": "Please book one room, quote 14 rooms, and file a voucher."},
        "candidate_replies": [{"reply_id": "r-policy", "body": "We will check both requests."}],
        "classification": {"can_help": True, "actions": ["booking", "group", "voucher"],
                           "reply_ids": ["r-policy"], "group_flag": True},
    }, runner)
    mixed_response = {
        "case": mixed_input["case"],
        "request_actions": [
            {"action": "booking_create", "scope": "non_group", "state": "requested",
             "task": "Prepare a one-room booking.", "nava_supported": True,
             "confidence": "high", "evidence_quote": "book one room"},
            {"action": "quote", "scope": "large_group", "state": "requested",
             "task": "Quote 14 rooms.", "nava_supported": True,
             "confidence": "high", "evidence_quote": "quote 14 rooms"},
            {"action": "file_voucher", "scope": "non_group", "state": "requested",
             "task": "File the requested voucher.", "nava_supported": True,
             "confidence": "high", "evidence_quote": "file a voucher"},
        ],
        "nava_hypothetical": [
            {"action_index": 0, "steps": ["Prepare the booking for staff review."]},
            {"action_index": 1, "steps": ["Prepare the large-group quote."]},
            {"action_index": 2, "steps": ["File the voucher."]},
        ],
        "observed_replies": [{
            "reply_id": "r-policy", "speaker": "hotel_staff", "relation": "same_request",
            "response_kind": "acknowledgement", "completion_claim": "not_claimed",
            "observed_response": "Staff say they will check both requests.",
            "evidence_quote": "We will check both requests.",
        }],
    }
    mixed_row = classify(FixedResponsePilot(mixed_response), "", "", "", 1, 0,
                         mixed_input, {}, 1)
    mixed_result = mixed_row.get("result", {})
    policy_audit = mixed_row.get("nava_policy_correction_audit")
    if (mixed_row.get("status") != "ok" or len(mixed_result.get("request_actions", [])) != 3
            or mixed_result["request_actions"][0]["nava_supported"] is not True
            or mixed_result["request_actions"][1]["nava_supported"] is not False
            or mixed_result["request_actions"][2]["nava_supported"] is not False
            or [entry["action_index"] for entry in mixed_result["nava_hypothetical"]] != [0]
            or len(mixed_result.get("observed_replies", [])) != 1
            or not isinstance(policy_audit, list) or len(policy_audit) != 2
            or {entry.get("action_index") for entry in policy_audit} != {1, 2}):
        raise Failure("self_test_mixed_nava_policy_normalization")

    no_help_input = project({
        "case": "policy-no-help-self-test", "inbound": {"message": "Please quote one room."},
        "candidate_replies": [],
        "classification": {"can_help": False, "actions": ["quote"], "reply_ids": []},
    }, runner)
    no_help_response = {
        "case": no_help_input["case"],
        "request_actions": [{
            "action": "quote", "scope": "non_group", "state": "requested",
            "task": "Prepare a one-room quote.", "nava_supported": True,
            "confidence": "high", "evidence_quote": "quote one room",
        }],
        "nava_hypothetical": [{"action_index": 0, "steps": ["Prepare the quote."]}],
        "observed_replies": [],
    }
    no_help_row = classify(FixedResponsePilot(no_help_response), "", "", "", 1, 0,
                           no_help_input, {}, 1)
    if (no_help_row.get("status") != "ok"
            or no_help_row["result"]["request_actions"][0]["nava_supported"] is not False
            or no_help_row["result"]["nava_hypothetical"]
            or no_help_row.get("nava_policy_correction_audit", [{}])[0].get("reason_codes")
            != ["final_can_help_not_true"]):
        raise Failure("self_test_no_help_nava_policy_normalization")

    failed_future: concurrent.futures.Future[Any] = concurrent.futures.Future()
    failed_future.set_exception(RuntimeError("synthetic_future_failure"))
    successful_future: concurrent.futures.Future[Any] = concurrent.futures.Future()
    successful_future.set_result({"case": "future-ok", "status": "ok"})
    future_cases = {
        failed_future: ("future-failed", 1, time.perf_counter()),
        successful_future: ("future-ok", 1, time.perf_counter()),
    }
    future_records = []
    for future in concurrent.futures.as_completed(future_cases):
        case_id, attempt, submitted = future_cases[future]
        try:
            future_records.append(future_result(future, {"input_sha256": "synthetic"},
                                                case_id, attempt, submitted))
        except Exception:
            raise Failure("self_test_future_exception_escaped") from None
    future_by_case = {record.get("case"): record for record in future_records}
    if (len(future_records) != 2 or future_by_case.get("future-failed", {}).get("status") != "failed"
            or future_by_case.get("future-failed", {}).get("error_code") != "internal"
            or future_by_case.get("future-ok") != {"case": "future-ok", "status": "ok"}):
        raise Failure("self_test_future_failure_record")

    return {"self_test": "ok", "case_id_quote_group_guards": True,
            "v1_default_prompt_pinned": True, "v2_prompt_path_hash_pinned": True,
            "v3_prompt_path_hash_pinned": True, "v4_prompt_path_hash_pinned": True,
            "v5_prompt_path_hash_pinned": True, "v6_prompt_path_hash_pinned": True,
            "v7_prompt_path_hash_pinned": True,
            "bounded_attachment_evidence_up_to_8000": True,
            "unapproved_prompt_rejected": True, "prompt_hash_mismatch_rejected": True,
            "source_excluded": True, "quote_drift_audited_not_rejected": True,
            "group_flag_disagreement_audited_not_rejected": True,
            "no_steps_when_can_help_false": True,
            "unexpected_future_failure_isolated": True,
            "mixed_nava_policy_corrections_preserve_requests_and_replies": True,
            "unicode_jsonl_separator_preserved": True}


def run(args: argparse.Namespace) -> dict[str, Any]:
    runner = load_runner()
    pilot = runner._load_pilot_helper()
    if not args.route_verified:
        raise Failure("route_verification_required")
    if not 1 <= args.concurrency <= MAX_CONCURRENCY or not 0 <= args.retries <= MAX_RETRIES:
        raise Failure("run_limits_out_of_range")
    if not 1 <= args.timeout <= 900 or (args.all_cases and args.case_id) or not (args.all_cases or args.case_id):
        raise Failure("explicit_case_selection_required")

    prompt, prompt_raw, prompt_path = read_action_prompt(runner, getattr(args, "prompt", None))
    root = HERE.parents[3].resolve() / ".private"
    input_path = runner._validate_private_path(args.input, root, must_exist=True)
    output_path = runner._validate_private_path(args.output, root, must_exist=False)
    raw_input = pilot._read_limited_private(input_path, "input", 100_000_000)
    rows = runner._decode_jsonl_strict(pilot, raw_input, "input_invalid_jsonl")
    if not rows or len(rows) > MAX_ROWS:
        raise Failure("input_empty_or_invalid")
    inputs: dict[str, dict[str, Any]] = {}
    for row in rows:
        item = project(row, runner)
        if item["case"] in inputs:
            raise Failure("input_duplicate_case")
        inputs[item["case"]] = item
    if args.case_id:
        if len(set(args.case_id)) != len(args.case_id) or any(case not in inputs for case in args.case_id):
            raise Failure("selected_case_missing_or_duplicate")
        selected = [case for case in inputs if case in set(args.case_id)]
    else:
        selected = list(inputs)

    endpoint, key = pilot._route_preflight(True, expected_endpoint_sha256=ENDPOINT_SHA256)
    prompt_hash, schema_hash, manifest_hash = sha(prompt_raw), sha(canonical(SCHEMA).encode()), sha(raw_input)
    run_hash = sha(canonical({"version": VERSION, "model": MODEL, "effort": EFFORT,
                              "prompt_sha256": prompt_hash, "schema_sha256": schema_hash}).encode())
    expected = {case: {
        "version": VERSION, "model": MODEL, "effort": EFFORT, "prompt_sha256": prompt_hash,
        "schema_sha256": schema_hash, "input_manifest_sha256": manifest_hash,
        "input_sha256": sha(canonical(item).encode()), "endpoint_sha256": ENDPOINT_SHA256,
        "prompt_model_effort_sha256": run_hash,
    } for case, item in inputs.items()}

    exists = output_path.exists()
    if exists != args.resume:
        raise Failure("output_exists_use_resume" if exists else "resume_output_missing")
    records = runner._decode_jsonl_strict(
        pilot, pilot._read_limited_private(output_path, "results", 200_000_000), "results_invalid_jsonl",
    ) if exists else []
    latest: dict[str, dict[str, Any]] = {}
    for record in records:
        if not isinstance(record, dict):
            raise Failure("resume_record_invalid")
        case = record.get("case")
        if (not isinstance(case, str) or case not in expected
                or any(record.get(key) != val for key, val in expected[case].items())):
            raise Failure("resume_identity_mismatch")
        old = latest.get(case)
        attempt = record.get("attempt")
        if not isinstance(attempt, int) or isinstance(attempt, bool) or attempt != (old["attempt"] + 1 if old else 1):
            raise Failure("resume_attempt_order")
        if old and old.get("status") != "failed":
            raise Failure("resume_attempt_order")
        if record.get("status") not in ("ok", "failed", "withheld"):
            raise Failure("resume_record_invalid")
        if record["status"] == "ok":
            result = validate(record.get("result"), inputs[case])
            validate_nava_policy_audit(record.get("nava_policy_correction_audit", []), result)
            if (record.get("evidence_quote_audit") != quote_audit(result, inputs[case])
                    or record.get("classification_audit") != classification_audit(result, inputs[case])):
                raise Failure("resume_audit_mismatch")
        elif not isinstance(record.get("error_code"), str) or not re.fullmatch(
            r"[a-z0-9_]{1,80}", record["error_code"]
        ):
            raise Failure("resume_record_invalid")
        latest[case] = record

    jobs: list[tuple[str, int]] = []
    for case in selected:
        previous = latest.get(case)
        if previous and previous["status"] in ("ok", "withheld"):
            continue
        attempt = previous["attempt"] + 1 if previous else 1
        if pilot._contains_sensitive_payment_data({"target": inputs[case]}):
            record = {**expected[case], "case": case, "attempt": attempt, "request_attempts": 0,
                      "elapsed_seconds": 0.0, "status": "withheld",
                      "error_code": "sensitive_payment_or_credential_pattern",
                      "usage": {"input_tokens": None, "output_tokens": None, "total_tokens": None}}
            runner._append(pilot, output_path, record, threading.Lock())
            latest[case] = record
        else:
            jobs.append((case, attempt))

    completed: list[dict[str, Any]] = []
    lock = threading.Lock()
    started = time.perf_counter()
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.concurrency) as pool:
        futures = {}
        for case, attempt in jobs:
            future = pool.submit(classify, pilot, prompt, endpoint, key, args.timeout, args.retries,
                                 inputs[case], expected[case], attempt)
            futures[future] = (case, attempt, time.perf_counter())
        for future in concurrent.futures.as_completed(futures):
            case, attempt, submitted = futures[future]
            record = future_result(future, expected[case], case, attempt, submitted)
            runner._append(pilot, output_path, record, lock)
            latest[record["case"]] = record
            completed.append(record)
            print(json.dumps({"event": "progress", "case": record["case"], "status": record["status"]}), flush=True)
    elapsed = time.perf_counter() - started
    counts = {state: sum(latest.get(case, {}).get("status") == state for case in selected)
              for state in ("ok", "failed", "withheld")}
    latencies = [row["elapsed_seconds"] for row in completed if row["status"] == "ok"]
    return {
        "event": "summary", "version": VERSION, "model": MODEL, "effort": EFFORT,
        "selected": len(selected), "cases": selected, "concurrency": args.concurrency,
        "calls_this_run": len(jobs),
        "request_attempts_this_run": sum(row["request_attempts"] for row in completed),
        "succeeded": counts["ok"], "failed": counts["failed"], "withheld": counts["withheld"],
        "elapsed_seconds": round(elapsed, 3),
        "throughput_per_minute": round(len(jobs) * 60 / elapsed, 2) if elapsed else 0,
        "latency_seconds": {"min": round(min(latencies), 3) if latencies else None,
                            "median": round(statistics.median(latencies), 3) if latencies else None,
                            "max": round(max(latencies), 3) if latencies else None},
        "prompt_file": prompt_path.name, "prompt_sha256": prompt_hash,
        "input_manifest_sha256": manifest_hash,
        "output": str(output_path),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=pathlib.Path)
    parser.add_argument("--output", type=pathlib.Path)
    parser.add_argument("--prompt", type=pathlib.Path,
                        help="Approved prompt file (default: frozen v1; later versions require an explicit path).")
    parser.add_argument("--case-id", action="append", default=[])
    parser.add_argument("--all-cases", action="store_true", help="Explicitly process all input rows.")
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--route-verified", action="store_true")
    parser.add_argument("--concurrency", type=int, default=8)
    parser.add_argument("--retries", type=int, default=3)
    parser.add_argument("--timeout", type=int, default=180)
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    try:
        if not args.self_test and (args.input is None or args.output is None):
            raise Failure("input_and_output_required")
        result = self_test() if args.self_test else run(args)
        print(json.dumps(result, sort_keys=True))
        return 0 if result.get("failed", 0) == 0 else 1
    except Exception as exc:
        code = getattr(exc, "code", "internal")
        print(json.dumps({"status": "failed", "error_code": re.sub(r"[^a-z0-9_]", "_", str(code).casefold())[:80]}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
