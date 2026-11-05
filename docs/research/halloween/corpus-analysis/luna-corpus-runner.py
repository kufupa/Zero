#!/usr/bin/env python3
"""Research-only, resumable one-email-at-a-time Centurion Luna classifier."""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import math
import os
import pathlib
import re
import stat
import sys
import threading
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any


VERSION = "centurion-luna-corpus-v3"
MODEL = "gpt-6-luna"
EFFORTS = ("low", "medium", "high", "max")
MAX_ROWS = 50_000
MAX_FILE_BYTES = 100_000_000
MAX_MODEL_INPUT_BYTES = 256_000
MAX_CONCURRENCY = 24
MAX_RETRIES = 5
MAX_TIMEOUT_SECONDS = 900
MAX_CANDIDATES = 100
MAX_OUTBOUND_ATTACHMENT_CONTEXT_BYTES = 4096
MAX_INBOUND_RECIPIENTS = 100
MAX_INBOUND_ADDRESS_BYTES = 320
INBOUND_ADDRESS_PATTERN = re.compile(r"^[^@\s<>]+@[^@\s<>@]+$")

HERE = pathlib.Path(__file__).resolve().parent
PILOT_HELPER = HERE / "pilot-250-review.py"
INBOUND_PROMPT = HERE / "2026-11-01-luna-opportunity-prompt-v9.md"
OUTBOUND_PROMPT = HERE / "2026-11-01-luna-outbound-prompt.md"
INBOUND_FIELDS = ("date", "from", "subject", "message", "quoted_context")
INBOUND_REPLY_FIELDS = (
    "reply_id", "same_thread", "minutes_after_inbound", "from", "to", "subject",
    "body", "confirmation_pdf_filename", "direct_header_match",
)
OUTBOUND_FIELDS = ("date", "from", "to", "subject", "message", "quoted_context")
OUTBOUND_REQUEST_FIELDS = (
    "request_id", "direct_header_match", "same_thread", "minutes_before_outbound",
    "from", "subject", "body",
)

INBOUND_ACTIONS = (
    "quote", "booking", "amendment", "cancellation", "payment_proof", "voucher",
    "invoice", "payment_request", "group", "other",
)
INBOUND_RESPONSE_TYPES = (
    "staff", "hms_confirmation_candidate", "both", "none_linked", "other",
)
INVOICE_HANDLING = (
    "staff_invoice", "hms_confirmation_candidate", "invoice_no_reply", "not_invoice",
)
EVIDENCE_SOURCES = ("inbound", "reply", "both", "none")
OUTBOUND_TYPES = (
    "staff_written", "pms_confirmation_template", "other_automated", "other", "unknown",
)
OUTBOUND_AUTOMATION = ("yes", "no", "unknown")
OUTBOUND_CATEGORIES = (
    "invoice", "quote", "booking", "amendment", "cancellation", "payment_request", "other",
)
OUTBOUND_EVIDENCE_ASPECTS = ("message_type", "automation", "category")
OUTBOUND_EVIDENCE_SOURCES = ("outbound", "candidate_inbound")


class RunnerFailure(Exception):
    """Expected, content-free failure code."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def _object_schema(properties: dict[str, Any]) -> dict[str, Any]:
    return {
        "type": "object",
        "properties": properties,
        "required": list(properties),
        "additionalProperties": False,
    }


def _array_schema(items: dict[str, Any], maximum: int) -> dict[str, Any]:
    return {"type": "array", "items": items, "maxItems": maximum}


def _enum_schema(values: tuple[str, ...]) -> dict[str, Any]:
    return {"type": "string", "enum": list(values)}


# Same result fields as october-opportunity-model.py; one result per request is
# enforced by the single-item wrapper and again by local validation.
INBOUND_ITEM_SCHEMA = _object_schema({
    "case": {"type": "string"},
    "reservation_email": {"type": ["boolean", "null"]},
    "can_help": {"type": ["boolean", "null"]},
    "actions": _array_schema(_enum_schema(INBOUND_ACTIONS), len(INBOUND_ACTIONS)),
    "reply_ids": _array_schema({"type": "string"}, MAX_CANDIDATES),
    "response_type": _enum_schema(INBOUND_RESPONSE_TYPES),
    "invoice_handling": _enum_schema(INVOICE_HANDLING),
    "evidence_source": _enum_schema(EVIDENCE_SOURCES),
    "evidence": {"type": "string", "maxLength": 180},
    "reason": {"type": "string", "maxLength": 220},
})
INBOUND_SCHEMA = _object_schema({
    "results": _array_schema(INBOUND_ITEM_SCHEMA, maximum=1),
})

OUTBOUND_EVIDENCE_SCHEMA = _object_schema({
    "aspect": _enum_schema(OUTBOUND_EVIDENCE_ASPECTS),
    "category": _enum_schema((*OUTBOUND_CATEGORIES, "not_applicable")),
    "source": _enum_schema(OUTBOUND_EVIDENCE_SOURCES),
    "quote": {"type": "string", "maxLength": 180},
})
OUTBOUND_SCHEMA = _object_schema({
    "case": {"type": "string"},
    "message_type": _enum_schema(OUTBOUND_TYPES),
    "automation_status": _enum_schema(OUTBOUND_AUTOMATION),
    "categories": _array_schema(_enum_schema(OUTBOUND_CATEGORIES), len(OUTBOUND_CATEGORIES)),
    "evidence": _array_schema(OUTBOUND_EVIDENCE_SCHEMA, maximum=16),
    "reason": {"type": "string", "maxLength": 220},
})


def _canonical_json(value: Any) -> str:
    try:
        return json.dumps(
            value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False,
        )
    except (TypeError, ValueError, UnicodeError):
        raise RunnerFailure("input_not_serializable") from None


def _sha256(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def _decode_jsonl_strict(pilot: Any, raw: bytes, error_code: str) -> list[Any]:
    """Split JSONL only at LF, not at Unicode separators inside JSON strings."""
    try:
        return [pilot._strict_json_loads(line) for line in raw.split(b'\n') if line.strip()]
    except (ValueError, UnicodeError, json.JSONDecodeError):
        raise RunnerFailure(error_code) from None


def _scalar(value: Any, *, text_only: bool = False, allow_float: bool = False) -> Any:
    if value is None:
        return None
    if isinstance(value, str):
        if len(value.encode("utf-8")) > MAX_MODEL_INPUT_BYTES:
            raise RunnerFailure("input_field_too_large")
        return value
    if text_only:
        raise RunnerFailure("input_field_schema")
    if isinstance(value, bool) or isinstance(value, int):
        return value
    if allow_float and isinstance(value, float) and math.isfinite(value):
        return value
    raise RunnerFailure("input_field_schema")


def _canonical_reply_id(value: Any) -> str:
    if isinstance(value, int) and not isinstance(value, bool):
        if value < 0:
            raise RunnerFailure("reply_id_negative")
        return str(value)
    if not isinstance(value, str) or not value or value != value.strip():
        raise RunnerFailure("reply_id_schema")
    if value.startswith("-") or "\n" in value or "\r" in value:
        raise RunnerFailure("reply_id_negative")
    if value.isdecimal() and int(value) < 0:
        raise RunnerFailure("reply_id_negative")
    if len(value) > 128:
        raise RunnerFailure("reply_id_schema")
    return value


def _candidate_is_prior(minutes: Any) -> bool:
    if isinstance(minutes, (int, float)) and not isinstance(minutes, bool):
        return math.isfinite(minutes) and minutes < 0
    if isinstance(minutes, str):
        try:
            parsed = float(minutes)
        except ValueError:
            return False
        return math.isfinite(parsed) and parsed < 0
    return False


def _address_value(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, str):
        return _scalar(value, text_only=True)
    if isinstance(value, list) and len(value) <= 100:
        if any(not isinstance(item, str) for item in value):
            raise RunnerFailure("input_address_schema")
        return [_scalar(item, text_only=True) for item in value]
    raise RunnerFailure("input_address_schema")


def _copy_text_fields(source: Any, keys: tuple[str, ...],
                      address_fields: tuple[str, ...] = ()) -> dict[str, Any]:
    if not isinstance(source, dict):
        raise RunnerFailure("input_email_schema")
    return {
        key: _address_value(source.get(key)) if key in address_fields
        else _scalar(source.get(key), text_only=True)
        for key in keys
    }


def _inbound_envelope_addresses(value: Any) -> list[str] | None:
    """Validate optional source To/Cc lists; null explicitly means unknown."""
    if value is None:
        return None
    if not isinstance(value, list) or len(value) > MAX_INBOUND_RECIPIENTS:
        raise RunnerFailure("inbound_envelope_schema")
    addresses: list[str] = []
    for address in value:
        if (not isinstance(address, str) or len(address.encode("utf-8")) > MAX_INBOUND_ADDRESS_BYTES
                or not INBOUND_ADDRESS_PATTERN.fullmatch(address)):
            raise RunnerFailure("inbound_envelope_schema")
        addresses.append(address)
    return addresses


def _project_inbound(row: dict[str, Any]) -> dict[str, Any]:
    case = row.get("case")
    if not isinstance(case, str) or not case or len(case) > 128 or "\n" in case or "\r" in case:
        raise RunnerFailure("input_case_schema")
    inbound_source = row.get("inbound")
    inbound = _copy_text_fields(inbound_source, INBOUND_FIELDS, ("from",))
    if "attachment_context" in inbound_source:
        inbound["attachment_context"] = _scalar(inbound_source["attachment_context"], text_only=True)
    elif "attachment_context" in row:
        inbound["attachment_context"] = _scalar(row["attachment_context"], text_only=True)
    # Optional envelope fields are absent on legacy packets so their model
    # projection and resume hashes stay byte-identical. Null means unknown;
    # an empty list, when explicitly supplied, means known empty.
    for field in ("to", "cc"):
        if field in inbound_source:
            inbound[field] = _inbound_envelope_addresses(inbound_source[field])
    source_replies = row.get("candidate_replies", [])
    if source_replies is None:
        source_replies = []
    if not isinstance(source_replies, list) or len(source_replies) > MAX_CANDIDATES:
        raise RunnerFailure("candidate_replies_schema")
    replies: list[dict[str, Any]] = []
    seen: set[str] = set()
    for candidate in source_replies:
        if not isinstance(candidate, dict):
            raise RunnerFailure("candidate_reply_schema")
        reply_id = _canonical_reply_id(candidate.get("reply_id"))
        if reply_id in seen:
            raise RunnerFailure("reply_id_duplicate")
        seen.add(reply_id)
        projected = {"reply_id": reply_id}
        for key in INBOUND_REPLY_FIELDS[1:]:
            value = candidate.get(key)
            if key in ("same_thread", "direct_header_match"):
                projected[key] = _scalar(value)
            elif key == "minutes_after_inbound":
                projected[key] = _scalar(value, allow_float=True)
            elif key in ("from", "to"):
                projected[key] = _address_value(value)
            elif key == "confirmation_pdf_filename":
                projected[key] = value if isinstance(value, bool) else _scalar(value, text_only=True)
            else:
                projected[key] = _scalar(value, text_only=True)
        # Optional independent outbound-message estimate. Do not add a null or
        # default when absent: legacy model-input projections and hashes must
        # remain byte-identical.
        if "outbound_message_type" in candidate:
            outbound_message_type = candidate["outbound_message_type"]
            if not isinstance(outbound_message_type, str) or outbound_message_type not in OUTBOUND_TYPES:
                raise RunnerFailure("candidate_outbound_message_type")
            projected["outbound_message_type"] = outbound_message_type
        # Optional, MIME-derived metadata. Keep this absent when the source
        # packet omits it so legacy model inputs and hashes remain unchanged.
        if "outbound_attachment_context" in candidate:
            attachment_context = candidate["outbound_attachment_context"]
            if (not isinstance(attachment_context, str) or not attachment_context
                    or len(attachment_context.encode("utf-8")) > MAX_OUTBOUND_ATTACHMENT_CONTEXT_BYTES
                    or "\n" in attachment_context or "\r" in attachment_context):
                raise RunnerFailure("candidate_outbound_attachment_context")
            projected["outbound_attachment_context"] = attachment_context
        replies.append(projected)
    model_input = {"case": case, "inbound": inbound, "candidate_replies": replies}
    if len(_canonical_json(model_input).encode("utf-8")) > MAX_MODEL_INPUT_BYTES:
        raise RunnerFailure("input_row_too_large")
    return model_input


def _project_outbound(row: dict[str, Any]) -> dict[str, Any]:
    case = row.get("case")
    if not isinstance(case, str) or not case or len(case) > 128 or "\n" in case or "\r" in case:
        raise RunnerFailure("input_case_schema")
    outbound = _copy_text_fields(row.get("outbound"), OUTBOUND_FIELDS, ("from", "to"))
    source_requests = row.get("candidate_inbounds", [])
    if source_requests is None:
        source_requests = []
    if not isinstance(source_requests, list) or len(source_requests) > MAX_CANDIDATES:
        raise RunnerFailure("candidate_inbounds_schema")
    requests: list[dict[str, Any]] = []
    for candidate in source_requests:
        if not isinstance(candidate, dict):
            raise RunnerFailure("candidate_inbound_schema")
        request_id = candidate.get("request_id")
        if request_id is not None:
            request_id = _canonical_reply_id(request_id)
        projected = {"request_id": request_id}
        for key in OUTBOUND_REQUEST_FIELDS[1:]:
            value = candidate.get(key)
            if key in ("same_thread", "direct_header_match"):
                projected[key] = _scalar(value)
            elif key == "minutes_before_outbound":
                projected[key] = _scalar(value, allow_float=True)
            elif key == "from":
                projected[key] = _address_value(value)
            else:
                projected[key] = _scalar(value, text_only=True)
        requests.append(projected)
    model_input = {"case": case, "outbound": outbound, "candidate_inbounds": requests}
    if len(_canonical_json(model_input).encode("utf-8")) > MAX_MODEL_INPUT_BYTES:
        raise RunnerFailure("input_row_too_large")
    return model_input


def _inbound_reply_map(model_input: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {candidate["reply_id"]: candidate for candidate in model_input["candidate_replies"]}


def _validate_inbound_result(value: Any, model_input: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != {"results"}:
        raise RunnerFailure("output_schema")
    rows = value.get("results")
    if not isinstance(rows, list) or len(rows) != 1 or not isinstance(rows[0], dict):
        raise RunnerFailure("output_cardinality")
    result = rows[0]
    required = set(INBOUND_ITEM_SCHEMA["properties"])
    if set(result) != required or result.get("case") != model_input["case"]:
        raise RunnerFailure("output_case_or_schema")
    reservation_email, can_help = result.get("reservation_email"), result.get("can_help")
    if reservation_email is not None and not isinstance(reservation_email, bool):
        raise RunnerFailure("output_schema")
    if can_help is not None and not isinstance(can_help, bool):
        raise RunnerFailure("output_schema")
    if reservation_email is False and can_help is not False:
        raise RunnerFailure("output_false_reservation_help")
    actions = result.get("actions")
    if (not isinstance(actions, list) or len(actions) > len(INBOUND_ACTIONS)
            or any(not isinstance(action, str) or action not in INBOUND_ACTIONS for action in actions)):
        raise RunnerFailure("output_actions_schema")
    reply_ids = result.get("reply_ids")
    reply_map = _inbound_reply_map(model_input)
    if (not isinstance(reply_ids, list) or len(reply_ids) > MAX_CANDIDATES
            or any(not isinstance(reply_id, str) for reply_id in reply_ids)):
        raise RunnerFailure("output_reply_ids_schema")
    for reply_id in reply_ids:
        candidate = reply_map.get(reply_id)
        if candidate is None or _candidate_is_prior(candidate.get("minutes_after_inbound")):
            raise RunnerFailure("output_reply_id_invalid")
    response_type = result.get("response_type")
    if response_type not in INBOUND_RESPONSE_TYPES:
        raise RunnerFailure("output_response_type")
    invoice_handling = result.get("invoice_handling")
    if invoice_handling not in INVOICE_HANDLING:
        raise RunnerFailure("output_invoice_handling")
    if result.get("evidence_source") not in EVIDENCE_SOURCES:
        raise RunnerFailure("output_evidence_source")
    evidence, reason = result.get("evidence"), result.get("reason")
    if not isinstance(evidence, str) or len(evidence) > 180:
        raise RunnerFailure("output_evidence_schema")
    if not isinstance(reason, str) or len(reason) > 220:
        raise RunnerFailure("output_reason_schema")
    return result


def _validate_outbound_result(value: Any, model_input: dict[str, Any]) -> dict[str, Any]:
    result = value
    required = set(OUTBOUND_SCHEMA["properties"])
    if not isinstance(result, dict) or set(result) != required or result.get("case") != model_input["case"]:
        raise RunnerFailure("output_case_or_schema")
    if result.get("message_type") not in OUTBOUND_TYPES:
        raise RunnerFailure("output_message_type")
    automation_status = result.get("automation_status")
    if automation_status not in OUTBOUND_AUTOMATION:
        raise RunnerFailure("output_automation_status")
    categories = result.get("categories")
    if (not isinstance(categories, list) or len(categories) > len(OUTBOUND_CATEGORIES)
            or any(not isinstance(category, str) or category not in OUTBOUND_CATEGORIES for category in categories)):
        raise RunnerFailure("output_categories_schema")
    evidence = result.get("evidence")
    if not isinstance(evidence, list) or len(evidence) > 16:
        raise RunnerFailure("output_evidence_schema")
    for item in evidence:
        if not isinstance(item, dict) or set(item) != {"aspect", "category", "source", "quote"}:
            raise RunnerFailure("output_evidence_schema")
        aspect, category, source, quote = (
            item.get("aspect"), item.get("category"), item.get("source"), item.get("quote"),
        )
        if (aspect not in OUTBOUND_EVIDENCE_ASPECTS
                or category not in (*OUTBOUND_CATEGORIES, "not_applicable")
                or source not in OUTBOUND_EVIDENCE_SOURCES):
            raise RunnerFailure("output_evidence_schema")
        if not isinstance(quote, str) or len(quote) > 180:
            raise RunnerFailure("output_evidence_schema")
    reason = result.get("reason")
    if not isinstance(reason, str) or len(reason) > 220:
        raise RunnerFailure("output_reason_schema")
    return result


def _load_pilot_helper() -> Any:
    try:
        spec = importlib.util.spec_from_file_location("centurion_pilot_review", PILOT_HELPER)
        if spec is None or spec.loader is None:
            raise RunnerFailure("safe_route_helper_unavailable")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    except RunnerFailure:
        raise
    except Exception:
        raise RunnerFailure("safe_route_helper_unavailable") from None


def _validate_private_path(path_value: str | pathlib.Path, private_root: pathlib.Path,
                           *, must_exist: bool) -> pathlib.Path:
    """Allow private inputs/results anywhere below .private, rejecting symlinks."""
    path = pathlib.Path(path_value)
    if not path.is_absolute():
        path = pathlib.Path.cwd() / path
    path = pathlib.Path(os.path.abspath(path))
    try:
        root_info = private_root.lstat()
        root = private_root.resolve(strict=True)
        relative = path.relative_to(root)
    except (OSError, ValueError):
        raise RunnerFailure("private_path_required") from None
    if (stat.S_ISLNK(root_info.st_mode) or not stat.S_ISDIR(root_info.st_mode)
            or root_info.st_uid != os.getuid() or stat.S_IMODE(root_info.st_mode) & 0o007):
        raise RunnerFailure("private_root_not_private")
    if not relative.parts or relative.name in ("", ".", ".."):
        raise RunnerFailure("private_path_required")
    current = root
    for part in relative.parts[:-1]:
        current = current / part
        try:
            info = current.lstat()
        except OSError:
            raise RunnerFailure("private_parent_unavailable") from None
        if (stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode)
                or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077):
            raise RunnerFailure("private_parent_not_private")
    try:
        info = path.lstat()
    except FileNotFoundError:
        if must_exist:
            raise RunnerFailure("private_file_unavailable") from None
    except OSError:
        raise RunnerFailure("private_file_unavailable") from None
    else:
        if (stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode)
                or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077):
            raise RunnerFailure("private_file_not_private")
    return path


def _read_prompt(path: pathlib.Path) -> tuple[str, bytes]:
    try:
        raw = path.read_bytes()
        prompt = raw.decode("utf-8")
    except (OSError, UnicodeError):
        raise RunnerFailure("prompt_unavailable") from None
    if not prompt.strip():
        raise RunnerFailure("prompt_empty")
    return prompt, raw


def _make_payload(direction: str, prompt: str, model_input: dict[str, Any],
                  effort: str, schema: dict[str, Any]) -> dict[str, Any]:
    name = "centurion_luna_inbound" if direction == "inbound" else "centurion_luna_outbound"
    return {
        "model": MODEL,
        "store": False,
        "reasoning": {"effort": effort},
        "input": [
            {"role": "system", "content": [{"type": "input_text", "text": prompt}]},
            {"role": "user", "content": [{"type": "input_text", "text": _canonical_json(model_input)}]},
        ],
        # No tools are declared or available to the model.
        "text": {"format": {
            "type": "json_schema", "name": name, "strict": True, "schema": schema,
        }},
    }


def _safe_code(value: Any) -> str:
    if isinstance(value, str) and re.fullmatch(r"[a-z0-9_]{1,80}", value):
        return value
    return "internal"


def _usage_safe(value: Any) -> dict[str, int | None]:
    if not isinstance(value, dict):
        return {"input_tokens": None, "output_tokens": None, "total_tokens": None}
    result: dict[str, int | None] = {}
    for key in ("input_tokens", "output_tokens", "total_tokens"):
        number = value.get(key)
        result[key] = number if isinstance(number, int) and not isinstance(number, bool) and number >= 0 else None
    return result


def _classify_one(pilot: Any, direction: str, prompt: str, schema: dict[str, Any],
                  effort: str, endpoint: str, api_key: str, timeout: float, retries: int,
                  case: str, model_input: dict[str, Any], identity: dict[str, Any],
                  input_sha256: str, attempt: int) -> dict[str, Any]:
    usage = {"input_tokens": None, "output_tokens": None, "total_tokens": None}
    request_attempts = 0
    try:
        payload = _make_payload(direction, prompt, model_input, effort, schema)
        output_text, raw_usage, error, request_attempts = pilot._send_request(
            endpoint, api_key, payload, timeout, retries,
        )
        usage = _usage_safe(raw_usage)
        if error or output_text is None:
            raise RunnerFailure(_safe_code(error or "empty_response"))
        output = pilot._strict_json_loads(output_text)
        result = (
            _validate_inbound_result(output, model_input) if direction == "inbound"
            else _validate_outbound_result(output, model_input)
        )
        return {
            **identity,
            "version": VERSION,
            "case": case,
            "input_sha256": input_sha256,
            "attempt": attempt,
            "request_attempts": request_attempts,
            "status": "ok",
            "usage": usage,
            "result": result,
        }
    except RunnerFailure as exc:
        error_code = exc.code
    except Exception as exc:
        error_code = _safe_code(getattr(exc, "code", "internal"))
    return {
        **identity,
        "version": VERSION,
        "case": case,
        "input_sha256": input_sha256,
        "attempt": attempt,
        "request_attempts": request_attempts,
        "status": "failed",
        "error_code": _safe_code(error_code),
        "usage": usage,
    }


def _record_identity(record: dict[str, Any], expected: dict[str, Any]) -> bool:
    keys = (
        "version", "direction", "case", "input_sha256", "prompt_sha256",
        "prompt_model_effort_sha256", "model", "effort", "endpoint_sha256",
    )
    return all(record.get(key) == expected.get(key) for key in keys)


def _validate_existing(records: list[dict[str, Any]], expected: dict[str, dict[str, Any]],
                       model_inputs: dict[str, dict[str, Any]], direction: str) -> dict[str, dict[str, Any]]:
    latest: dict[str, dict[str, Any]] = {}
    for record in records:
        case = record.get("case")
        if not isinstance(case, str) or case not in expected or not _record_identity(record, expected[case]):
            raise RunnerFailure("resume_identity_mismatch")
        attempt = record.get("attempt")
        if not isinstance(attempt, int) or isinstance(attempt, bool) or attempt < 1:
            raise RunnerFailure("resume_record_invalid")
        previous = latest.get(case)
        if ((previous is None and attempt != 1)
                or (previous is not None and (previous.get("status") != "failed"
                                              or attempt != previous["attempt"] + 1))):
            raise RunnerFailure("resume_record_order_invalid")
        if record.get("status") not in ("ok", "failed", "withheld"):
            raise RunnerFailure("resume_record_invalid")
        if record["status"] == "ok":
            result = record.get("result")
            if direction == "inbound":
                _validate_inbound_result({"results": [result]}, model_inputs[case])
            else:
                _validate_outbound_result(result, model_inputs[case])
        elif not isinstance(record.get("error_code"), str) or _safe_code(record["error_code"]) != record["error_code"]:
            raise RunnerFailure("resume_record_invalid")
        latest[case] = record
    return latest


def _append(pilot: Any, path: pathlib.Path, record: dict[str, Any], lock: threading.Lock) -> None:
    try:
        pilot._append_private_jsonl(path, record, lock)
    except Exception as exc:
        code = _safe_code(getattr(exc, "code", "results_write_failed"))
        raise RunnerFailure(code) from None


def _count_labels(direction: str, records: list[dict[str, Any]]) -> dict[str, Any]:
    if direction == "inbound":
        reservation = Counter(str(record["result"].get("reservation_email")) for record in records if record.get("status") == "ok")
        help_counts = Counter(str(record["result"].get("can_help")) for record in records if record.get("status") == "ok")
        action_counts = Counter(
            action for record in records if record.get("status") == "ok"
            for action in set(record["result"].get("actions", []))
        )
        return {
            "reservation_email": dict(reservation), "can_help": dict(help_counts),
            "actions": dict(action_counts),
        }
    type_counts = Counter(record["result"].get("message_type") for record in records if record.get("status") == "ok")
    category_counts = Counter(
        category for record in records if record.get("status") == "ok"
        for category in set(record["result"].get("categories", []))
    )
    automation_counts = Counter(record["result"].get("automation_status") for record in records if record.get("status") == "ok")
    return {
        "message_type": dict(type_counts), "automation_status": dict(automation_counts),
        "categories": dict(category_counts),
    }


def _select_cases(model_inputs: dict[str, Any], requested: list[str] | None,
                  excluded: list[str]) -> list[str]:
    if requested:
        if any(case not in model_inputs for case in requested) or len(set(requested)) != len(requested):
            raise RunnerFailure("selected_case_missing_or_duplicate")
        requested_set = set(requested)
        selected = [case for case in model_inputs if case in requested_set]
    else:
        selected = list(model_inputs)
    excluded_set = set(excluded)
    if (len(excluded_set) != len(excluded) or any(case not in model_inputs for case in excluded_set)
            or (requested and excluded_set.intersection(requested))):
        raise RunnerFailure("excluded_case_missing_duplicate_or_selected")
    return [case for case in selected if case not in excluded_set]


def run(args: argparse.Namespace) -> tuple[dict[str, Any], int]:
    if not 1 <= args.concurrency <= MAX_CONCURRENCY:
        raise RunnerFailure("concurrency_out_of_range")
    if not 0 <= args.retries <= MAX_RETRIES:
        raise RunnerFailure("retries_out_of_range")
    if not 1 <= args.timeout <= MAX_TIMEOUT_SECONDS:
        raise RunnerFailure("timeout_out_of_range")
    if not re.fullmatch(r"[0-9a-f]{64}", args.endpoint_sha256):
        raise RunnerFailure("endpoint_identity_required")
    if not args.route_verified:
        raise RunnerFailure("route_verification_required")

    pilot = _load_pilot_helper()
    direction = args.direction
    schema = INBOUND_SCHEMA if direction == "inbound" else OUTBOUND_SCHEMA
    prompt_path = pathlib.Path(args.prompt) if args.prompt else (
        INBOUND_PROMPT if direction == "inbound" else OUTBOUND_PROMPT
    )
    if not prompt_path.is_absolute():
        prompt_path = pathlib.Path.cwd() / prompt_path
    try:
        resolved_prompt = prompt_path.resolve(strict=True)
        if prompt_path.is_symlink() or not resolved_prompt.is_relative_to(HERE):
            raise RunnerFailure("prompt_path_unsafe")
        prompt_path = resolved_prompt
    except OSError:
        raise RunnerFailure("prompt_unavailable") from None
    prompt, prompt_bytes = _read_prompt(prompt_path)
    prompt_sha256 = _sha256(prompt_bytes)
    schema_sha256 = _sha256(_canonical_json(schema).encode("utf-8"))
    prompt_model_effort_sha256 = _sha256(_canonical_json({
        "direction": direction, "model": MODEL, "effort": args.effort,
        "prompt_sha256": prompt_sha256, "schema_sha256": schema_sha256,
    }).encode("utf-8"))

    private_root = HERE.parents[3].resolve() / ".private"
    input_path, output_path = pathlib.Path(args.input), pathlib.Path(args.output)
    try:
        input_path = _validate_private_path(input_path, private_root, must_exist=True)
        output_path = _validate_private_path(output_path, private_root, must_exist=False)
        raw = pilot._read_limited_private(input_path, "input", MAX_FILE_BYTES)
        rows = _decode_jsonl_strict(pilot, raw, "input_invalid_jsonl")
    except Exception as exc:
        code = getattr(exc, "code", "input_unavailable")
        raise RunnerFailure(_safe_code(code)) from None
    if not rows or len(rows) > MAX_ROWS or any(not isinstance(row, dict) for row in rows):
        raise RunnerFailure("input_empty_or_invalid")

    model_inputs: dict[str, dict[str, Any]] = {}
    input_hashes: dict[str, str] = {}
    for row in rows:
        model_input = _project_inbound(row) if direction == "inbound" else _project_outbound(row)
        case = model_input["case"]
        if case in model_inputs:
            raise RunnerFailure("input_duplicate_case")
        model_inputs[case] = model_input
        input_hashes[case] = _sha256(_canonical_json(model_input).encode("utf-8"))
    selected_cases = _select_cases(model_inputs, args.case_ids, args.exclude_case_ids)

    try:
        endpoint, api_key = pilot._route_preflight(
            args.route_verified, expected_endpoint_sha256=args.endpoint_sha256,
        )
    except Exception as exc:
        code = getattr(exc, "code", "route_preflight_failed")
        raise RunnerFailure(_safe_code(code)) from None

    expected: dict[str, dict[str, Any]] = {}
    for case, input_sha256 in input_hashes.items():
        expected[case] = {
            "version": VERSION, "direction": direction, "case": case,
            "input_sha256": input_sha256, "prompt_sha256": prompt_sha256,
            "prompt_model_effort_sha256": prompt_model_effort_sha256,
            "model": MODEL, "effort": args.effort,
            "endpoint_sha256": args.endpoint_sha256,
        }

    exists = output_path.exists()
    if exists and not args.resume:
        raise RunnerFailure("output_exists_use_resume")
    if args.resume and not exists:
        raise RunnerFailure("resume_output_missing")
    try:
        existing_records = _decode_jsonl_strict(
            pilot, pilot._read_limited_private(output_path, "results", 200_000_000), "results_invalid_jsonl"
        ) if exists else []
        latest = _validate_existing(existing_records, expected, model_inputs, direction)
    except RunnerFailure:
        raise
    except Exception as exc:
        code = getattr(exc, "code", "resume_file_invalid")
        raise RunnerFailure(_safe_code(code)) from None

    jobs: list[tuple[str, int]] = []
    withheld: list[dict[str, Any]] = []
    for case in selected_cases:
        previous = latest.get(case)
        if previous and previous["status"] in ("ok", "withheld"):
            continue
        attempt = previous["attempt"] + 1 if previous else 1
        try:
            sensitive = pilot._contains_sensitive_payment_data({"target": model_inputs[case]})
        except Exception:
            sensitive = True
        if sensitive:
            withheld.append({
                **expected[case], "version": VERSION, "attempt": attempt,
                "request_attempts": 0, "status": "withheld",
                "error_code": "sensitive_payment_or_credential_pattern",
                "usage": {"input_tokens": None, "output_tokens": None, "total_tokens": None},
            })
        else:
            jobs.append((case, attempt))

    lock = threading.Lock()
    completed_records = list(withheld)
    for record in withheld:
        _append(pilot, output_path, record, lock)
    completed = 0
    ok_count = 0
    failed_count = 0
    if jobs:
        with ThreadPoolExecutor(max_workers=args.concurrency) as pool:
            futures = {
                pool.submit(
                    _classify_one, pilot, direction, prompt, schema, args.effort,
                    endpoint, api_key, args.timeout, args.retries, case,
                    model_inputs[case], expected[case], input_hashes[case], attempt,
                ): case
                for case, attempt in jobs
            }
            for future in as_completed(futures):
                try:
                    record = future.result()
                except Exception:
                    case = futures[future]
                    previous = latest.get(case)
                    attempt = previous["attempt"] + 1 if previous else 1
                    record = {
                        **expected[case], "version": VERSION, "attempt": attempt,
                        "request_attempts": 0, "status": "failed", "error_code": "internal",
                        "usage": {"input_tokens": None, "output_tokens": None, "total_tokens": None},
                    }
                _append(pilot, output_path, record, lock)
                completed_records.append(record)
                completed += 1
                ok_count += record["status"] == "ok"
                failed_count += record["status"] == "failed"
                print(json.dumps({
                    "event": "progress", "completed": completed, "scheduled": len(jobs),
                    "ok": ok_count, "failed": failed_count,
                }, sort_keys=True), flush=True)

    for case in selected_cases:
        if case not in latest or (latest[case].get("status") == "failed"):
            latest[case] = next(
                (row for row in reversed(completed_records) if row.get("case") == case), latest.get(case, {}),
            )
    final_records = [latest[case] for case in selected_cases if case in latest]
    counts = Counter(record.get("status", "missing") for record in final_records)
    summary = {
        "direction": direction,
        "model": MODEL,
        "effort": args.effort,
        "selected": len(selected_cases),
        "succeeded": counts.get("ok", 0),
        "failed": counts.get("failed", 0),
        "withheld": counts.get("withheld", 0),
        "skipped_completed": sum(
            1 for case in selected_cases
            if latest.get(case, {}).get("status") in ("ok", "withheld")
            and not any(row.get("case") == case for row in completed_records)
        ),
        "missing": len(selected_cases) - len(final_records),
        "labels": _count_labels(direction, final_records),
    }
    if direction == "outbound":
        summary["interpretation_limit"] = (
            "PMS confirmation-template volume estimates system-generated template volume; "
            "it does not prove a staff member never clicked Send."
        )
    return summary, 0 if (counts.get("failed", 0) == 0 and counts.get("withheld", 0) == 0
                          and summary["missing"] == 0) else 2


def _synthetic_inbound() -> dict[str, Any]:
    return {
        "case": "I00001",
        "inbound": {
            "date": "2026-10-01", "from": ["guest@example.test"], "subject": "Invoice request",
            "message": "Please send the invoice for our stay.", "quoted_context": None,
            "attachment_context": "A spreadsheet lists the requested stay dates.",
            "_source": "must-not-be-sent",
        },
        "candidate_replies": [
            {
                "reply_id": 0, "same_thread": True, "minutes_after_inbound": 10,
                "from": ["staff@example.test"], "to": ["guest@example.test"], "subject": "Invoice",
                "body": "Please see attached invoice.", "confirmation_pdf_filename": False,
                "direct_header_match": True, "private_label": "must-not-be-sent",
            },
            {
                "reply_id": 1, "same_thread": True, "minutes_after_inbound": -5,
                "from": ["staff@example.test"], "to": ["guest@example.test"], "subject": "Earlier",
                "body": "Earlier note.", "confirmation_pdf_filename": None,
                "direct_header_match": True,
            },
        ],
        "_source": {"current_chars": "must-not-be-sent", "answer_key": "private"},
    }


def _synthetic_outbound() -> dict[str, Any]:
    return {
        "case": "O00001",
        "outbound": {
            "date": "2026-10-02", "from": ["staff@example.test"], "to": ["guest@example.test"],
            "subject": "Your quote", "message": "Please find our quote attached.",
            "quoted_context": None, "private_mapping": "must-not-be-sent",
        },
        "candidate_inbounds": [{
            "request_id": "I00001", "direct_header_match": True, "same_thread": True,
            "minutes_before_outbound": 5, "from": ["guest@example.test"], "subject": "Quote",
            "body": "Please quote a room for us.", "private_label": "must-not-be-sent",
        }],
        "_source": {"current_chars": "must-not-be-sent"},
    }


def run_self_tests() -> int:
    checks = 0

    def check(condition: bool, code: str) -> None:
        nonlocal checks
        checks += 1
        if not condition:
            raise RunnerFailure("self_test_" + code)

    def fails(function: Any, code: str) -> bool:
        try:
            function()
        except RunnerFailure as exc:
            return exc.code == code
        return False

    inbound = _project_inbound(_synthetic_inbound())
    input_json = _canonical_json(inbound)
    check("must-not-be-sent" not in input_json and "private" not in input_json, "private_projection")
    check(inbound["candidate_replies"][0]["reply_id"] == "0", "reply_id_canonicalization")
    check(inbound["inbound"]["from"] == ["guest@example.test"], "address_list_projection")
    check(inbound["candidate_replies"][0]["confirmation_pdf_filename"] is False, "boolean_pdf_marker")
    check(inbound["inbound"]["attachment_context"].startswith("A spreadsheet"), "attachment_context_projection")
    check("outbound_message_type" not in inbound["candidate_replies"][0], "legacy_reply_type_omitted")
    check("outbound_attachment_context" not in inbound["candidate_replies"][0],
          "legacy_attachment_context_omitted")
    check(_sha256(input_json.encode("utf-8"))
          == "2f48f4d49b029354b136b340d077662dc12947f866d394edbcf3fd76af32ea3e",
          "legacy_input_hash_without_optional_metadata")
    typed_hash_source = _synthetic_inbound()
    typed_hash_source["candidate_replies"][0]["outbound_message_type"] = "staff_written"
    typed_hash_projection = _project_inbound(typed_hash_source)
    check(_sha256(_canonical_json(typed_hash_projection).encode("utf-8"))
          == "c4bb78cc30a22b9c04ec79ade7fcffde8b0462f913b90324139b9ebd87d8f047",
          "legacy_input_hash_with_type_only")
    mime_source = _synthetic_inbound()
    mime_source["candidate_replies"][0]["outbound_attachment_context"] = (
        "MIME status=ok; attachment_count=1; attachments=[{\"name\":\"invoice_redacted.pdf\","
        "\"content_type\":\"application/pdf\"}]"
    )
    mime_projection = _project_inbound(mime_source)["candidate_replies"][0]
    check(mime_projection["outbound_attachment_context"].startswith("MIME status=ok;"),
          "outbound_attachment_context_projected")
    for invalid_context in (None, "", "line one\nline two", "é" * 2049,
                            "x" * (MAX_OUTBOUND_ATTACHMENT_CONTEXT_BYTES + 1)):
        invalid_source = _synthetic_inbound()
        invalid_source["candidate_replies"][0]["outbound_attachment_context"] = invalid_context
        check(fails(lambda: _project_inbound(invalid_source),
                    "candidate_outbound_attachment_context"),
              "outbound_attachment_context_invalid_rejected")
    for message_type in OUTBOUND_TYPES:
        tagged_source = _synthetic_inbound()
        tagged_source["candidate_replies"][0]["outbound_message_type"] = message_type
        tagged = _project_inbound(tagged_source)["candidate_replies"][0]
        check(tagged["outbound_message_type"] == message_type, "reply_type_projected_" + message_type)
    for invalid_message_type in (None, "staff", "PMS_CONFIRMATION_TEMPLATE", 1):
        invalid_source = _synthetic_inbound()
        invalid_source["candidate_replies"][0]["outbound_message_type"] = invalid_message_type
        check(fails(lambda: _project_inbound(invalid_source), "candidate_outbound_message_type"),
              "reply_type_invalid_rejected")
    top_context = _synthetic_inbound()
    del top_context["inbound"]["attachment_context"]
    top_context["attachment_context"] = "A top-level attachment summary."
    check(_project_inbound(top_context)["inbound"]["attachment_context"]
          == "A top-level attachment summary.", "top_level_attachment_context")
    envelope_source = _synthetic_inbound()
    envelope_source["inbound"]["to"] = ["outside@example.test"]
    envelope_source["inbound"]["cc"] = None
    envelope_projection = _project_inbound(envelope_source)["inbound"]
    check(envelope_projection["to"] == ["outside@example.test"] and envelope_projection["cc"] is None,
          "optional_inbound_to_cc_projection")
    for invalid_envelope in (
        "outside@example.test", ["outside@example.test\nother@example.test"],
        ["not-an-address"], ["x@" + "a" * 330], ["x@example.test"] * 101,
    ):
        invalid_source = _synthetic_inbound()
        invalid_source["inbound"]["to"] = invalid_envelope
        check(fails(lambda: _project_inbound(invalid_source), "inbound_envelope_schema"),
              "invalid_inbound_envelope_rejected")
    valid_inbound = {
        "results": [{
            "case": "I00001", "reservation_email": True, "can_help": True,
            "actions": ["invoice"], "reply_ids": ["0"], "response_type": "staff",
            "invoice_handling": "staff_invoice", "evidence_source": "both",
            "evidence": "Please see attached invoice.", "reason": "Staff supplied invoice.",
        }],
    }
    _validate_inbound_result(valid_inbound, inbound)
    check(True, "inbound_happy_path")
    flexible_inbound = json.loads(_canonical_json(valid_inbound))
    flexible_inbound["results"][0].update({
        "reply_ids": [], "evidence_source": "none", "evidence": "A paraphrased invoice excerpt.",
    })
    _validate_inbound_result(flexible_inbound, inbound)
    check(True, "inbound_evidence_and_link_inference_kept")
    false_help = json.loads(_canonical_json(valid_inbound))
    false_help["results"][0].update({"reservation_email": False, "can_help": True})
    check(fails(lambda: _validate_inbound_result(false_help, inbound), "output_false_reservation_help"), "false_reservation_guard")
    wrong_case = json.loads(_canonical_json(valid_inbound))
    wrong_case["results"][0]["case"] = "I00002"
    check(fails(lambda: _validate_inbound_result(wrong_case, inbound), "output_case_or_schema"), "case_match")
    nonexistent = json.loads(_canonical_json(valid_inbound))
    nonexistent["results"][0]["reply_ids"] = ["99"]
    check(fails(lambda: _validate_inbound_result(nonexistent, inbound), "output_reply_id_invalid"), "reply_exists")
    prior_reply = json.loads(_canonical_json(valid_inbound))
    prior_reply["results"][0]["reply_ids"] = ["1"]
    check(fails(lambda: _validate_inbound_result(prior_reply, inbound), "output_reply_id_invalid"), "prior_reply_rejected")
    check(fails(lambda: _canonical_reply_id(-1), "reply_id_negative"), "negative_id_rejected")

    outbound = _project_outbound(_synthetic_outbound())
    check("must-not-be-sent" not in _canonical_json(outbound), "outbound_private_projection")
    valid_outbound = {
        "case": "O00001", "message_type": "staff_written", "automation_status": "no",
        "categories": ["quote"],
        "evidence": [
            {"aspect": "message_type", "category": "not_applicable", "source": "outbound",
             "quote": "Please find our quote attached."},
            {"aspect": "automation", "category": "not_applicable", "source": "outbound",
             "quote": "Please find our quote attached."},
            {"aspect": "category", "category": "quote", "source": "outbound",
             "quote": "Please find our quote attached."},
        ],
        "reason": "Staff response provides a quotation.",
    }
    _validate_outbound_result(valid_outbound, outbound)
    check(True, "outbound_happy_path")
    paraphrased = json.loads(_canonical_json(valid_outbound))
    paraphrased["evidence"][2]["quote"] = "A quotation is attached."
    paraphrased["categories"] = ["quote", "invoice"]
    _validate_outbound_result(paraphrased, outbound)
    check(True, "paraphrased_evidence_and_categories_kept")
    template_claim = json.loads(_canonical_json(valid_outbound))
    template_claim["message_type"] = "pms_confirmation_template"
    template_claim["automation_status"] = "yes"
    _validate_outbound_result(template_claim, outbound)
    check(True, "template_proxy_estimate_kept")

    resume_identity = {
        "version": VERSION, "direction": "inbound", "case": "I00001",
        "input_sha256": "a" * 64, "prompt_sha256": "b" * 64,
        "prompt_model_effort_sha256": "c" * 64, "model": MODEL,
        "effort": "medium", "endpoint_sha256": "d" * 64,
    }
    failed_record = {
        **resume_identity, "attempt": 1, "request_attempts": 3,
        "status": "failed", "error_code": "network_failure",
    }
    latest = _validate_existing([failed_record], {"I00001": resume_identity},
                                {"I00001": inbound}, "inbound")
    check(latest["I00001"]["attempt"] == 1, "resume_failed_attempt")
    changed_identity = dict(failed_record, input_sha256="e" * 64)
    check(fails(lambda: _validate_existing([changed_identity], {"I00001": resume_identity},
                                           {"I00001": inbound}, "inbound"),
                "resume_identity_mismatch"), "resume_identity_guard")
    check(_select_cases({'one': {}, 'blocked': {}}, None, ['blocked']) == ['one'], "provider_block_excluded")
    check(fails(lambda: _select_cases({'one': {}}, None, ['missing']),
                'excluded_case_missing_duplicate_or_selected'), "invalid_exclusion_rejected")
    check(checks == 46, "check_count")
    return checks


def _build_cli() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("self-test", help="run synthetic offline validation only")
    run_parser = commands.add_parser("run", help="classify private JSONL using the verified Azure route")
    run_parser.add_argument("--direction", choices=("inbound", "outbound"), required=True)
    run_parser.add_argument("--input", required=True, help="owner-only JSONL under repo .private")
    run_parser.add_argument("--output", required=True, help="new or resumed owner-only JSONL under repo .private")
    run_parser.add_argument("--case", dest="case_ids", action="append", help="select one case; repeat for a small smoke run")
    run_parser.add_argument("--exclude-case", dest="exclude_case_ids", action="append", default=[],
                            help="omit a case without a request; repeat for prior provider blocks")
    run_parser.add_argument("--prompt", help="optional prompt markdown under the corpus-analysis directory")
    run_parser.add_argument("--resume", action="store_true", help="append retry attempts to an existing identity-matched output")
    run_parser.add_argument("--route-verified", action="store_true",
                            help="attest endpoint, permission, retention and Azure ContentLogging were verified")
    run_parser.add_argument("--endpoint-sha256", required=True,
                            help="SHA-256 of the configured Azure Responses endpoint from the approved route check")
    run_parser.add_argument("--effort", choices=EFFORTS, default="medium")
    run_parser.add_argument("--concurrency", type=int, default=16)
    run_parser.add_argument("--timeout", type=float, default=120.0)
    run_parser.add_argument("--retries", type=int, default=3, help="bounded transient retry count, maximum 5")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = _build_cli()
    args = parser.parse_args(argv)
    try:
        if args.command == "self-test":
            checks = run_self_tests()
            print(json.dumps({"self_test": "passed", "checks": checks}, sort_keys=True))
            return 0
        summary, exit_code = run(args)
        print(json.dumps(summary, ensure_ascii=False, sort_keys=True))
        return exit_code
    except RunnerFailure as exc:
        print("error=" + _safe_code(exc.code), file=sys.stderr)
        return 2
    except Exception as exc:
        print("error=" + _safe_code(getattr(exc, "code", "internal")), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
