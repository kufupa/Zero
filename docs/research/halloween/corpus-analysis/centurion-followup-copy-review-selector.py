#!/usr/bin/env python3
"""Select follow-up, pending-task, and possible hotel-outbound cases for review.

This is a candidate selector, not a classifier or source of ground truth. It
copies selected packet JSONL rows byte-for-byte and writes separate metadata.
All file inputs/outputs must be owner-private under the repository .private.
"""

from __future__ import annotations

import argparse
import email.utils
import hashlib
import json
import os
import pathlib
import random
import re
import stat
from collections import Counter
from typing import Any


HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[3]
PRIVATE = ROOT / ".private"
VERSION = "centurion-followup-copy-review-selector-v2"
MAX_FILE_BYTES = 100_000_000
MAX_ROWS = 50_000
MAX_SAMPLE = 100

CASE_RE = re.compile(r"[A-Z][A-Z0-9_-]{0,127}")
EMAIL_RE = re.compile(r"(?i)(?<![\w.+-])[\w.+-]+@[\w.-]+\.[a-z]{2,}(?![\w.-])")
FOLLOWUP_RE = re.compile(
    r"\b(?:follow[ -]?up|following up|gentle reminder|friendly reminder|reminder|"
    r"any (?:news|update)|checking (?:in|on|whether|if)|still (?:waiting|missing|awaiting|pending)|"
    r"not (?:yet )?received|yet to receive|awaiting|outstanding|no (?:response|reply|update)|"
    r"please advise (?:on )?(?:the )?(?:status|progress)|status of)\b", re.I,
)
TASK_RE = re.compile(
    r"\b(?:hotel stay|accommodation|room(?:s| rate| rates)?|night(?:s)?|quote|quotation|"
    r"rate(?:s)?|availability|booking|reservation|amend(?:ment)?|cancel(?:lation)?|"
    r"invoice|pro[ -]?forma|folio|tax invoice|voucher|payment proof|transfer receipt)\b", re.I,
)
INVOICE_RE = re.compile(r"\b(?:invoice|pro[ -]?forma|folio|tax invoice|stay invoice)\b", re.I)
PENDING_RE = re.compile(
    r"\b(?:pending|outstanding|awaiting|waiting|still to follow|to follow|not yet|"
    r"will (?:send|issue|prepare|provide|forward)|promised|missing|need(?:s|ed)? .* before)\b", re.I,
)
INFO_RE = re.compile(
    r"\b(?:billing|company|organisation|organization|legal entity|business name|invoice details|"
    r"tax|vat|registration number|company name|billing address|guest details|rooming list|"
    r"reference number|confirmation number)\b|\b(?:limited|ltd\.?|inc\.?|corp\.?|llc|gmbh|pty)\b",
    re.I,
)
ACK_ONLY_RE = re.compile(
    r"^\s*(?:(?:hi|hello|dear\s+[^,\n]+)[,!: ]*)?"
    r"(?:thanks?|thank you|received|well received|got it|noted|okay|ok|all good|"
    r"no further action|invoice received|received the invoice)[.!\s]*$", re.I,
)
QUOTE_BOUNDARY_RE = re.compile(
    r"(?im)^\s*(?:-{2,}\s*(?:original message|forwarded message)|"
    r"begin forwarded message:?|from\s*:|on .{1,160} wrote:)\s*"
)
TO_HEADER_RE = re.compile(r"(?im)^\s*(?:to|cc|bcc)\s*:\s*([^\r\n]{1,500})")
SALUTATION_RE = re.compile(r"(?im)^\s*(?:dear\b|hello\b|good (?:morning|afternoon)\b)")
SIGNOFF_RE = re.compile(r"(?im)^\s*(?:kind regards|best regards|regards|sincerely|yours faithfully)\b")
INTERNAL_RECIPIENT_RE = re.compile(
    r"\b(?:reservations? team|front desk|reception|hotel staff|colleague|internal mailbox)\b", re.I,
)
STAFF_ROLE_RE = re.compile(
    r"\b(?:hotel staff|reservations?|front desk|reception|guest services|property staff)\b", re.I,
)
INFO_REQUEST_RE = re.compile(
    r"\b(?:need|needed|required|request(?:ed)?|please (?:send|provide|share|include)|"
    r"could you (?:send|provide|share)|send us|provide us)\b.{0,140}"
    r"\b(?:billing|company|organisation|organization|legal entity|business name|tax|vat|"
    r"registration|details|name|address)\b|"
    r"\b(?:billing|company|organisation|organization|legal entity|business name|tax|vat|"
    r"registration)\b.{0,140}\b(?:needed|required|requested|before|to issue|to prepare)\b",
    re.I,
)
PERSON_ASSIGNMENT_RE = re.compile(
    r"\b[A-Z][A-Za-z'’-]{1,35}(?:\s+[A-Z][A-Za-z'’-]{1,35})?\s+to\s+"
    r"(?:make|create|enter|book|quote|amend|cancel|issue|prepare|file|process)\b"
)
TEAM_ASSIGNMENT_RE = re.compile(
    r"\b(?:reservations?|staff|team|front desk|reception)\s+to\s+"
    r"(?:make|create|enter|book|quote|amend|cancel|issue|prepare|file|process)\b", re.I,
)
INTERNAL_ACTION_RE = re.compile(
    r"\b(?:please|kindly)\s+(?:handle|process|arrange|create|book|quote|amend|cancel|"
    r"issue|file|enter|prepare)\b.{0,100}\b(?:stay|room|booking|reservation|invoice|voucher|PMS)\b",
    re.I,
)
COMPLETION_RE = re.compile(
    r"\b(?:attached (?:the )?(?:invoice|quote|voucher)|invoice (?:sent|attached|issued)|"
    r"booking confirmed|reservation confirmed|already (?:sent|issued|booked|confirmed)|"
    r"(?:sent|issued|provided|attached) (?:the )?(?:(?:hotel )?stay )?(?:invoice|pro[ -]?forma)|"
    r"completed as requested|cancelled as requested)\b", re.I,
)


class Failure(Exception):
    def __init__(self, code: str):
        self.code = code


def _strict_pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate_json_key")
        result[key] = value
    return result


def _read_private(path: pathlib.Path, label: str) -> tuple[list[dict[str, Any]], list[bytes], str]:
    try:
        resolved = path.resolve(strict=True)
        if (path.is_symlink() or not resolved.is_relative_to(PRIVATE.resolve())
                or not resolved.is_file() or stat.S_IMODE(resolved.stat().st_mode) != 0o600):
            raise Failure(f"{label}_not_owner_private")
        raw = resolved.read_bytes()
    except Failure:
        raise
    except (OSError, RuntimeError):
        raise Failure(f"{label}_unavailable") from None
    if not raw or len(raw) > MAX_FILE_BYTES:
        raise Failure(f"{label}_size_invalid")
    rows: list[dict[str, Any]] = []
    row_bytes: list[bytes] = []
    for line in raw.split(b"\n"):
        if not line.strip():
            continue
        try:
            row = json.loads(line.decode("utf-8"), object_pairs_hook=_strict_pairs)
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError):
            raise Failure(f"{label}_invalid_jsonl") from None
        if not isinstance(row, dict):
            raise Failure(f"{label}_row_schema")
        rows.append(row)
        row_bytes.append(line)
        if len(rows) > MAX_ROWS:
            raise Failure(f"{label}_row_limit")
    if not rows:
        raise Failure(f"{label}_empty")
    return rows, row_bytes, hashlib.sha256(raw).hexdigest()


def _latest_results(rows: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    latest: dict[str, dict[str, Any]] = {}
    for row in rows:
        case = row.get("case")
        attempt = row.get("attempt")
        status = row.get("status")
        if (not isinstance(case, str) or not CASE_RE.fullmatch(case)
                or isinstance(attempt, bool) or not isinstance(attempt, int) or attempt < 1
                or status not in {"ok", "failed", "withheld"}):
            raise Failure("result_record_invalid")
        old = latest.get(case)
        if (attempt != (old["attempt"] + 1 if old else 1)
                or (old is not None and old["status"] != "failed")):
            raise Failure("result_retry_sequence_invalid")
        latest[case] = row
    return latest


def _texts(value: Any) -> list[str]:
    if isinstance(value, str):
        return [value]
    if isinstance(value, list):
        return [text for item in value for text in _texts(item)]
    if isinstance(value, dict):
        return [text for item in value.values() for text in _texts(item)]
    return []


def _addresses(value: Any) -> set[str]:
    return {match.group(0).casefold().rstrip(".,;:>") for text in _texts(value)
            for match in EMAIL_RE.finditer(text)}


def _domains(addresses: set[str]) -> set[str]:
    return {address.rsplit("@", 1)[-1] for address in addresses if "@" in address}


def _sender_names(value: Any) -> set[str]:
    names = set()
    for text in _texts(value):
        for name, address in email.utils.getaddresses([text]):
            normalized = re.sub(r"\s+", " ", name).strip(" ,<>\t\r\n").casefold()
            if normalized:
                names.add(normalized)
            elif not address:
                normalized = re.sub(r"\s+", " ", text).strip(" ,<>\t\r\n").casefold()
                if normalized:
                    names.add(normalized)
    return names


def _staff_sender_sets(packets: list[dict[str, Any]],
                       results: dict[str, dict[str, Any]]) -> tuple[set[str], set[str], set[str]]:
    staff_addresses: set[str] = set()
    staff_names: set[str] = set()
    for packet in packets:
        result_row = results.get(packet.get("case"))
        if not result_row or result_row.get("status") != "ok":
            continue
        result = result_row.get("result")
        if not isinstance(result, dict) or result.get("response_type") not in {"staff", "both"}:
            continue
        linked = {str(value) for value in result.get("reply_ids", []) if isinstance(value, (str, int))}
        candidates = packet.get("candidate_replies")
        if not isinstance(candidates, list):
            continue
        for candidate in candidates:
            if isinstance(candidate, dict) and str(candidate.get("reply_id")) in linked:
                staff_addresses.update(_addresses(candidate.get("from")))
                staff_names.update(_sender_names(candidate.get("from")))

    # A domain observed on a linked staff reply is a weak signal, not a label.
    staff_domains = _domains(staff_addresses)
    return staff_addresses, staff_domains, staff_names


def _is_staff_sender(value: Any, staff_addresses: set[str], staff_domains: set[str],
                     staff_names: set[str]) -> bool:
    texts = _texts(value)
    addresses = _addresses(value)
    if (addresses & staff_addresses or _domains(addresses) & staff_domains
            or _sender_names(value) & staff_names):
        return True
    return any(STAFF_ROLE_RE.search(text) for text in texts)


def _current_core(message: str) -> str:
    match = QUOTE_BOUNDARY_RE.search(message)
    return message[:match.start()] if match else message


def _external_to_signal(message: str, sender: Any, staff_domains: set[str]) -> bool:
    headers = TO_HEADER_RE.findall(message)
    if not headers:
        return False
    sender_domains = _domains(_addresses(sender))
    for value in headers:
        recipients = _addresses(value)
        if recipients:
            if any(domain not in staff_domains and domain not in sender_domains
                   for domain in _domains(recipients)):
                return True
        elif not INTERNAL_RECIPIENT_RE.search(value):
            # Recipient names can identify an outside addressee without an email address.
            return True
    return False


def _baseline_summary(result: dict[str, Any]) -> dict[str, Any]:
    actions = result.get("actions")
    if (not isinstance(actions, list) or any(not isinstance(item, str) for item in actions)
            or (result.get("can_help") is not None and not isinstance(result.get("can_help"), bool))
            or (result.get("reservation_email") is not None
                and not isinstance(result.get("reservation_email"), bool))):
        raise Failure("classification_result_schema")
    return {
        "reservation_email": result.get("reservation_email"),
        "can_help": result.get("can_help"),
        "actions": actions,
        "response_type": result.get("response_type"),
    }


def _evaluate(packet: dict[str, Any], result_row: dict[str, Any],
              staff_addresses: set[str], staff_domains: set[str],
              staff_names: set[str]) -> dict[str, Any] | None:
    result = result_row.get("result")
    inbound = packet.get("inbound")
    if not isinstance(result, dict) or not isinstance(inbound, dict):
        raise Failure("packet_or_result_schema")
    baseline = _baseline_summary(result)
    message = inbound.get("message") if isinstance(inbound.get("message"), str) else ""
    quoted = inbound.get("quoted_context") if isinstance(inbound.get("quoted_context"), str) else ""
    subject = inbound.get("subject") if isinstance(inbound.get("subject"), str) else ""
    current = _current_core(message)
    evidence_text = current + "\n" + subject
    current_task = bool(TASK_RE.search(evidence_text))
    followup = bool(FOLLOWUP_RE.search(evidence_text))
    ack_only = bool(ACK_ONLY_RE.fullmatch(current.strip()))
    candidate_replies = packet.get("candidate_replies")
    if not isinstance(candidate_replies, list):
        candidate_replies = []
    reply_context = "\n".join(
        value for candidate in candidate_replies if isinstance(candidate, dict)
        for value in (candidate.get("subject"), candidate.get("body")) if isinstance(value, str)
    )
    recent_context = quoted + "\n" + reply_context
    context_task = bool(TASK_RE.search(recent_context))
    invoice_context = bool(INVOICE_RE.search(recent_context))
    pending_context = bool(PENDING_RE.search(recent_context))
    context_completed = bool(COMPLETION_RE.search(recent_context))
    context_info_request = bool(INFO_RE.search(recent_context) and INFO_REQUEST_RE.search(recent_context))
    current_info = bool(INFO_RE.search(evidence_text))
    current_message_brief = bool(current.strip()) and len(current.strip()) <= 500
    staff_sender = _is_staff_sender(inbound.get("from"), staff_addresses, staff_domains, staff_names)
    external_to = (_external_to_signal(message, inbound.get("from"), staff_domains)
                   or _external_to_signal(quoted, inbound.get("from"), staff_domains))
    outgoing_shape = bool(SALUTATION_RE.search(current) and SIGNOFF_RE.search(message))
    named_assignment = bool(PERSON_ASSIGNMENT_RE.search(current) or TEAM_ASSIGNMENT_RE.search(current))
    assignment = named_assignment or (staff_sender and bool(INTERNAL_ACTION_RE.search(current)))
    baseline_underhelp = (
        baseline["reservation_email"] is not True or baseline["can_help"] is not True
        or "other" in baseline["actions"]
    )

    reasons: list[str] = []
    if not ack_only and followup and (current_task or context_task):
        reasons.append("active_followup_underlabelled" if baseline_underhelp
                       else "active_followup_supported_control")
    if (not ack_only and invoice_context and current_message_brief
            and (pending_context or context_info_request or followup)
            and (not context_completed or followup)):
        reasons.append("possible_invoice_task_advancement")
    if assignment and (staff_sender or (named_assignment and baseline_underhelp)):
        reasons.append("hotel_sender_internal_staff_assignment")
    if staff_sender and baseline["reservation_email"] is True:
        reasons.append("hotel_sender_classified_as_inbound_for_direction_review")
    if (staff_sender and baseline["reservation_email"] is True
            and (external_to or outgoing_shape)):
        reasons.append("possible_hotel_written_outbound_copy")
        if assignment:
            reasons.append("outbound_copy_vs_internal_action_needs_review")
    if not reasons:
        return None

    priority = 0
    if "active_followup_underlabelled" in reasons:
        priority = max(priority, 120)
    if "possible_invoice_task_advancement" in reasons:
        priority = max(priority, 115)
    if "possible_hotel_written_outbound_copy" in reasons:
        priority = max(priority, 110)
    if "hotel_sender_internal_staff_assignment" in reasons:
        priority = max(priority, 105)
    if "active_followup_supported_control" in reasons:
        priority = max(priority, 90)
    return {
        "case": packet["case"],
        "reasons": reasons,
        "priority": priority,
        "baseline": baseline,
        "features": {
            "current_followup_cue": followup,
            "current_task_context": current_task,
            "quoted_task_context": context_task,
            "quoted_pending_invoice": invoice_context and pending_context,
            "quoted_invoice_context": invoice_context,
            "recent_pending_context": pending_context,
            "recent_information_request": context_info_request,
            "recent_context_completion_signal": context_completed,
            "current_billing_or_business_info": current_info,
            "hotel_sender_match": staff_sender,
            "external_recipient_header": external_to,
            "outgoing_message_shape": outgoing_shape,
            "current_staff_assignment": assignment,
            "current_ack_only": ack_only,
        },
    }


def _sample_candidates(candidates: list[dict[str, Any]], sample_size: int, seed: int,
                       focus_cases: list[str]) -> list[str]:
    by_case = {item["case"]: item for item in candidates}
    if len(set(focus_cases)) != len(focus_cases) or any(case not in by_case for case in focus_cases):
        raise Failure("focus_case_not_selected")
    selected = list(focus_cases)
    limit = min(sample_size, len(candidates))
    if len(selected) >= limit:
        return selected[:limit]
    rng = random.Random(seed)
    remaining = limit - len(selected)
    excluded = set(selected)
    groups = {
        "followup": [item for item in candidates if any(reason.startswith("active_followup_")
                     for reason in item["reasons"]) and item["case"] not in excluded],
        "pending_invoice": [item for item in candidates if "possible_invoice_task_advancement"
                            in item["reasons"] and item["case"] not in excluded],
        "hotel_copy": [item for item in candidates if any(reason in item["reasons"] for reason in (
            "hotel_sender_classified_as_inbound_for_direction_review",
            "possible_hotel_written_outbound_copy",
        )) and item["case"] not in excluded],
        "staff_assignment": [item for item in candidates if "hotel_sender_internal_staff_assignment"
                            in item["reasons"] and item["case"] not in excluded],
    }
    active_groups = [rows for rows in groups.values() if rows]
    if active_groups:
        quota, extra = divmod(remaining, len(active_groups))
        for index, rows in enumerate(active_groups):
            shuffled = list(rows)
            rng.shuffle(shuffled)
            take = min(len(shuffled), quota + (1 if index < extra else 0))
            for item in shuffled[:take]:
                if item["case"] not in excluded and len(selected) < limit:
                    selected.append(item["case"])
                    excluded.add(item["case"])
    remainder = [item for item in candidates if item["case"] not in excluded]
    rng.shuffle(remainder)
    selected.extend(item["case"] for item in remainder[:limit - len(selected)])
    return selected


def _strict_case_map(packets: list[dict[str, Any]], results: dict[str, dict[str, Any]]) -> dict[str, dict[str, Any]]:
    packet_map: dict[str, dict[str, Any]] = {}
    for packet in packets:
        case = packet.get("case")
        if not isinstance(case, str) or not CASE_RE.fullmatch(case) or case in packet_map:
            raise Failure("packet_case_invalid_or_duplicate")
        packet_map[case] = packet
    if set(results) - set(packet_map):
        raise Failure("classification_case_not_in_packets")
    return packet_map


def select(packets: list[dict[str, Any]], results: dict[str, dict[str, Any]],
           focus_cases: list[str] | None = None) -> list[dict[str, Any]]:
    packet_map = _strict_case_map(packets, results)
    staff_addresses, staff_domains, staff_names = _staff_sender_sets(packets, results)
    selected = []
    for packet in packets:
        result_row = results.get(packet["case"])
        if result_row and result_row.get("status") == "ok":
            item = _evaluate(packet, result_row, staff_addresses, staff_domains, staff_names)
            if item:
                selected.append(item)
    by_case = {item["case"]: item for item in selected}
    for case in focus_cases or []:
        if case not in packet_map or case not in results or results[case].get("status") != "ok":
            raise Failure("focus_case_not_available")
        if case not in by_case:
            item = _evaluate(packet_map[case], results[case], staff_addresses, staff_domains, staff_names)
            if item is None:
                result = results[case].get("result")
                if not isinstance(result, dict):
                    raise Failure("focus_case_result_invalid")
                item = {
                    "case": case, "reasons": [], "priority": 0,
                    "baseline": _baseline_summary(result),
                    "features": {"focus_only": True},
                }
            item["reasons"].append("manual_focus_case")
            by_case[case] = item
    return sorted(by_case.values(), key=lambda item: (-item["priority"], item["case"]))


def _write_new_private(path: pathlib.Path, payload: bytes) -> None:
    try:
        absolute = path if path.is_absolute() else pathlib.Path.cwd() / path
        parent = absolute.parent.resolve(strict=True)
        absolute = parent / absolute.name
        if (path.is_symlink() or not parent.is_relative_to(PRIVATE.resolve())
                or absolute.exists()):
            raise Failure("output_path_invalid_or_exists")
        fd = os.open(absolute, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except Failure:
        raise
    except OSError:
        raise Failure("output_create_failed") from None
    try:
        with os.fdopen(fd, "wb") as target:
            os.fchmod(target.fileno(), 0o600)
            target.write(payload)
            target.flush()
            os.fsync(target.fileno())
    except Exception:
        raise Failure("output_write_failed") from None


def _synthetic_prompt_rows() -> list[dict[str, Any]]:
    staff = "Hotel Reservations <reservations@hotel.example.invalid>"

    def row(case: str, sender: str, subject: str, message: str, quoted: str = "",
            replies: list[dict[str, Any]] | None = None) -> dict[str, Any]:
        return {
            "case": case,
            "inbound": {
                "date": "2026-10-01T09:00:00Z", "from": [sender], "subject": subject,
                "message": message, "quoted_context": quoted,
            },
            "candidate_replies": replies or [],
        }

    invoice_reply = {
        "reply_id": "R1", "same_thread": True, "minutes_after_inbound": 12,
        "from": [staff], "to": ["Example Guest <guest@example.invalid>"],
        "subject": "Stay pro-forma", "body": "We will prepare and send the stay pro-forma shortly.",
        "confirmation_pdf_filename": False, "direct_header_match": True,
    }
    return [
        row("SYN_FOLLOWUP_QUOTE", "Example Guest <guest@example.invalid>", "Room-rate request",
            "Following up on the room-rate request below. We have not received the quote yet.",
            "Please quote accommodation rates for the stay dates; no hotel response is shown."),
        row("SYN_MISSING_INVOICE", "Example Guest <guest@example.invalid>", "Stay invoice",
            "We are still waiting for the hotel stay invoice you said would follow.",
            "The hotel said it would prepare the stay pro-forma after billing details arrive.",
            [invoice_reply]),
        row("SYN_BILLING_INFO", "Example Agent <agent@example.invalid>", "Billing details",
            "Please use Example Company Ltd for the stay invoice.",
            "Reservations requested the billing company so the pending stay pro-forma can be issued."),
        row("SYN_HOTEL_COPY", staff, "Copied room-rate email",
            "From: Hotel Reservations <reservations@hotel.example.invalid>\n"
            "To: agent@agency.example.invalid\nSubject: Room rates\n"
            "Dear Travel Desk, please find our stay rates below.\nKind regards, Hotel Reservations"),
        row("SYN_INDIVIDUAL_BOOKINGS", staff, "Sold concert packages",
            "Twelve concert packages were sold in separate guest transactions. "
            "Martha to create each guest's booking in the PMS."),
        row("SYN_COMPLETED_ACK", "Example Guest <guest@example.invalid>", "Stay invoice received",
            "Thank you, we received the stay invoice.",
            "The hotel sent the stay invoice yesterday."),
        row("SYN_VAGUE_FOLLOWUP", "Example Guest <guest@example.invalid>", "Following up",
            "Following up—please advise."),
        row("SYN_STALE_QUOTE", "Example Guest <guest@example.invalid>", "Re: room rates",
            "Noted, thank you.",
            "Earlier message: please send room rates for the stay."),
    ]


def _self_test() -> dict[str, Any]:
    staff = "Hotel Reservations <reservations@hotel.example.invalid>"

    def packet(case: str, sender: str, message: str, quoted: str = "",
               replies: list[dict[str, Any]] | None = None) -> dict[str, Any]:
        return {
            "case": case,
            "inbound": {"date": "2026-10-01", "from": [sender], "subject": "Stay request",
                        "message": message, "quoted_context": quoted, "attachment_context": ""},
            "candidate_replies": replies or [],
        }

    def classified(case: str, reservation: bool | None, can_help: bool | None,
                   actions: list[str], response: str = "none_linked",
                   reply_ids: list[str] | None = None) -> dict[str, Any]:
        return {"case": case, "status": "ok", "attempt": 1, "result": {
            "case": case, "reservation_email": reservation, "can_help": can_help,
            "actions": actions, "response_type": response, "reply_ids": reply_ids or [],
        }}

    sample_staff_reply = {"reply_id": "R_STAFF", "from": [staff], "body": "Quote sent."}
    rows = [
        packet("S_FOLLOWUP_FALSE", "guest@example.invalid", "Following up on the room rate request below.",
               "Please quote accommodation for the requested nights; hotel reply not received."),
        packet("S_FOLLOWUP_TRUE", "guest@example.invalid", "Any update on the room quote?",
               "Please send room rates for these stay dates; no response yet."),
        packet("S_PENDING_INFO", "agent@example.invalid", "Example Holdings Ltd; VAT 12345.",
               "Please send company details so the hotel's stay pro-forma can be prepared; pro-forma to follow."),
        packet("S_HOTEL_COPY", staff,
               "From: Hotel Reservations <reservations@hotel.example.invalid>\n"
               "To: agent@agency.example.invalid\nSubject: Stay quotation\n"
               "Dear Travel Desk, please see the attached room quote.\nKind regards, Hotel Reservations"),
        packet("S_STAFF_ASSIGN", staff, "Martha to make the individual bookings on Infor for the sold packages."),
        packet("S_ACK", "guest@example.invalid", "Thank you, we received the invoice.",
               "The hotel sent the stay invoice yesterday."),
        packet("S_VAGUE", "guest@example.invalid", "Following up, please advise."),
        packet("S_STALE", "guest@example.invalid", "Noted, thank you.",
               "Earlier request: please quote room rates for the stay."),
        packet("S_EXTERNAL_COPY", "agent@example.invalid",
               "To: hotel@hotel.example.invalid\nDear Guest, please find your hotel quote.\nKind regards."),
    ]
    staff_link = packet("S_STAFF_SOURCE", "guest@example.invalid", "Please quote rooms.", replies=[sample_staff_reply])
    rows.append(staff_link)
    result_rows = [
        classified("S_FOLLOWUP_FALSE", False, False, []),
        classified("S_FOLLOWUP_TRUE", True, True, ["quote"]),
        classified("S_PENDING_INFO", True, False, ["other"]),
        classified("S_HOTEL_COPY", True, False, ["payment_request"]),
        classified("S_STAFF_ASSIGN", False, False, ["other"]),
        classified("S_ACK", False, False, ["other"]),
        classified("S_VAGUE", False, False, []),
        classified("S_STALE", False, False, []),
        classified("S_EXTERNAL_COPY", True, False, ["payment_request"]),
        classified("S_STAFF_SOURCE", True, True, ["quote"], "staff", ["R_STAFF"]),
    ]
    result_map = _latest_results(result_rows)
    selected = select(rows, result_map)
    by_case = {item["case"]: item for item in selected}
    checks = {
        "active_followup_underlabelled": "active_followup_underlabelled" in by_case.get("S_FOLLOWUP_FALSE", {}).get("reasons", []),
        "helpable_followup_retained_for_regression_sample": "active_followup_supported_control" in by_case.get("S_FOLLOWUP_TRUE", {}).get("reasons", []),
        "pending_invoice_information_selected": "possible_invoice_task_advancement" in by_case.get("S_PENDING_INFO", {}).get("reasons", []),
        "hotel_outbound_copy_selected": "possible_hotel_written_outbound_copy" in by_case.get("S_HOTEL_COPY", {}).get("reasons", []),
        "internal_staff_assignment_selected": "hotel_sender_internal_staff_assignment" in by_case.get("S_STAFF_ASSIGN", {}).get("reasons", []),
        "completed_ack_not_selected": "S_ACK" not in by_case,
        "vague_followup_without_task_not_selected": "S_VAGUE" not in by_case,
        "stale_quoted_request_without_current_followup_not_selected": "S_STALE" not in by_case,
        "external_sender_not_mistaken_for_hotel_copy": "S_EXTERNAL_COPY" not in by_case,
    }
    if not all(checks.values()):
        raise Failure("self_test_selection_rules_failed")
    synthetic_rows = _synthetic_prompt_rows()
    if len(synthetic_rows) != 8 or len({row["case"] for row in synthetic_rows}) != 8:
        raise Failure("self_test_synthetic_prompt_fixture_invalid")
    return {"self_test": "ok", "checks": checks, "selected_count": len(selected),
            "negative_controls_excluded": 4, "synthetic_prompt_cases": len(synthetic_rows)}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--inbound", type=pathlib.Path)
    parser.add_argument("--results", type=pathlib.Path)
    parser.add_argument("--prompt", type=pathlib.Path,
                        default=HERE / "2026-11-02-centurion-opportunity-prompt-v19-followup-copy-review.md")
    parser.add_argument("--input-output", type=pathlib.Path)
    parser.add_argument("--selection-output", type=pathlib.Path)
    parser.add_argument("--sample-size", type=int, default=30)
    parser.add_argument("--seed", type=int, default=20261102)
    parser.add_argument("--focus-case", action="append", default=[])
    parser.add_argument(
        "--all-selected", action="store_true",
        help="export every heuristic candidate to --input-output; sample metadata remains capped at --sample-size",
    )
    parser.add_argument("--write-synthetic-input", type=pathlib.Path,
                        help="write safe, synthetic v19 prompt cases to a new private JSONL")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    try:
        if args.self_test:
            result = _self_test()
        elif args.write_synthetic_input is not None:
            rows = _synthetic_prompt_rows()
            payload = b"".join(
                (json.dumps(row, ensure_ascii=True, sort_keys=True, separators=(",", ":")) + "\n").encode()
                for row in rows
            )
            _write_new_private(args.write_synthetic_input, payload)
            result = {"status": "ok", "synthetic_cases": [row["case"] for row in rows],
                      "count": len(rows), "output": str(args.write_synthetic_input)}
        else:
            if (args.inbound is None or args.results is None or args.input_output is None
                    or args.selection_output is None):
                raise Failure("input_results_and_outputs_required")
            if not 1 <= args.sample_size <= MAX_SAMPLE:
                raise Failure("sample_size_invalid")
            prompt_path = args.prompt.resolve(strict=True)
            if (args.prompt.is_symlink() or not prompt_path.is_relative_to(HERE.resolve())
                    or not prompt_path.is_file()):
                raise Failure("prompt_path_invalid")
            prompt_hash = hashlib.sha256(prompt_path.read_bytes()).hexdigest()
            packets, packet_lines, input_hash = _read_private(args.inbound, "packet_input")
            result_rows, _, result_hash = _read_private(args.results, "classification_input")
            packet_map = _strict_case_map(packets, {})
            result_map = _latest_results(result_rows)
            if set(result_map) - set(packet_map):
                raise Failure("classification_case_not_in_packets")
            selected = select(packets, result_map, args.focus_case)
            sample_cases = _sample_candidates(selected, args.sample_size, args.seed, args.focus_case)
            sample_set = set(sample_cases)
            source_by_case = {packet["case"]: line for packet, line in zip(packets, packet_lines, strict=True)}
            selected_set = {item["case"] for item in selected}
            export_cases = (
                [packet["case"] for packet in packets if packet["case"] in selected_set]
                if args.all_selected else sample_cases
            )
            input_bytes = b"".join(source_by_case[case] + b"\n" for case in export_cases)
            selected_rows = []
            for item in selected:
                selected_rows.append({**item, "selected_for_luna_sample": item["case"] in sample_set})
            reason_counts = Counter(reason for item in selected for reason in item["reasons"])
            manifest = {
                "selector_version": VERSION,
                "source_packet_sha256": input_hash,
                "source_results_sha256": result_hash,
                "prompt_sha256": prompt_hash,
                "candidate_count": len(selected),
                "sample_size_requested": args.sample_size,
                "sample_size_selected": len(sample_cases),
                "sample_seed": args.seed,
                "sample_case_ids": sample_cases,
                "export_mode": "all_selected" if args.all_selected else "sample",
                "export_count": len(export_cases),
                "export_case_ids": export_cases,
                "input_output_sha256": hashlib.sha256(input_bytes).hexdigest(),
                "reason_counts": dict(sorted(reason_counts.items())),
                "selected_cases": selected_rows,
            }
            _write_new_private(args.input_output, input_bytes)
            _write_new_private(args.selection_output,
                               (json.dumps(manifest, ensure_ascii=True, sort_keys=True,
                                           separators=(",", ":"), allow_nan=False) + "\n").encode())
            result = {
                "status": "ok", "selector_version": VERSION,
                "candidate_count": len(selected), "sample_count": len(sample_cases),
                "export_mode": "all_selected" if args.all_selected else "sample",
                "export_count": len(export_cases),
                "sample_cases": sample_cases,
                "reason_counts": dict(sorted(reason_counts.items())),
                "input_output": str(args.input_output),
                "selection_output": str(args.selection_output),
            }
        print(json.dumps(result, ensure_ascii=True, sort_keys=True))
        return 0
    except Failure as exc:
        print(json.dumps({"status": "failed", "error_code": exc.code}, sort_keys=True))
        return 1
    except Exception:
        print(json.dumps({"status": "failed", "error_code": "internal"}, sort_keys=True))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
