#!/usr/bin/env python3
"""Prepare guarded, cohort-separated packets from the frozen Centurion pilot manifest.

Example (run only after the owner has placed the pinned source and manifest under
the repository's owner-only ``.private`` directory)::

    python3 docs/research/halloween/corpus-analysis/pilot-250-prepare.py \
      --source "$CENTURION_CORPUS_JSONL" \
      --manifest "$CENTURION_PILOT_MANIFEST" \
      --output .private/pilot-250-packets

Holdout and embargoed rows are excluded unless their separate opt-in flags are
passed. This helper never sends data to a model or network service.
"""

from __future__ import annotations

import argparse
import datetime
import email.utils
import hashlib
import html
from html.parser import HTMLParser
import json
import os
from pathlib import Path
import re
import stat
import sys
import tempfile
import unittest
import unicodedata
from collections import Counter, defaultdict
from typing import Any, Iterable, Mapping, Sequence
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit


PLAN_SOURCE_SHA256 = "ec9d30c47e2ef0a3dd61ae6db795e1f730feb5e853b9cf76025f523d7a4e6625"
PLAN_SEED = "centurion-pilot-250-v1-20261101"
PLAN_COHORT_COUNTS = {
    "random_development": 100,
    "random_holdout": 50,
    "targeted_development": 100,
}
COHORTS = tuple(PLAN_COHORT_COUNTS)
CLEANING_VERSION = "centurion-pilot250-cleaning-v2"
MAX_SUBJECT_CHARS = 2_000
MAX_BODY_CHARS = 14_000
MAX_GUARD_INPUT_CHARS = 2_000_000
MAX_SOURCE_LINE_BYTES = 64 * 1024 * 1024

EMAIL_RE = re.compile(r"(?<![\w.+-])[\w.+-]+@[\w.-]+(?![\w.-])", re.I)
DATE_RE = re.compile(
    r"((?<!\d)(?:\d{4}[-./]\d{1,2}[-./]\d{1,2}|\d{1,2}[-./]\d{1,2}[-./]\d{4})(?!\d))"
)
CARD_RE = re.compile(
    r"(?<!\d)(?:(?:\d[ \t-]?){12,18}\d|(?:\d{4}[\s-]{1,6}){2,4}\d{1,4})(?!\d)"
)
CVV_RE = re.compile(
    r"\b(cvv2?|cvc2?|cvn|csc|security[ -]+code)\b([^\d\n\[\]]{0,16}?)(\d{3,4})(?!\d)",
    re.I,
)
CREDENTIAL_ASSIGNMENT_RE = re.compile(
    r"\b(password|passphrase|passcode|pin|username|user\s+name|login|token|credential|"
    r"access\s*token|refresh\s*token|api[ _-]?key|secret|authorization)\b\s*(?::|=|\bis\b)\s*([^\r\n]+)",
    re.I,
)
EMPTY_CREDENTIAL_RE = re.compile(
    r"(?im)^\s*(?:password|passphrase|passcode|pin|username|user\s+name|login|token|credential|"
    r"access\s*token|refresh\s*token|api[ _-]?key|secret|authorization)\s*[:=]?\s*$"
)
BARE_CREDENTIAL_RE = re.compile(
    r"\b(password|passphrase|passcode|pin|username|user\s+name|login|token|credential|"
    r"access\s*token|refresh\s*token|api[ _-]?key|secret)\b\s+([^\r\n]+)",
    re.I,
)
BEARER_RE = re.compile(r"\b(bearer)\s+([^\s\r\n]+)", re.I)
EMPTY_PAYMENT_FIELD_RE = re.compile(
    r"(?im)^\s*(?:cvv2?|cvc2?|cvn|csc|security[ -]+code|card(?:\s+(?:number|no\.?))?|"
    r"credit[ -]+card(?:\s+(?:number|no\.?))?|pan)\s*[:=]?\s*$"
)
CONTACT_FIELD_LABEL_RE = re.compile(
    r"(?:e-?mail(?:\s+(?:address|id))?|phone(?:\s+(?:number|no\.?))?|"
    r"telephone(?:\s+(?:number|no\.?))?|mobile(?:\s+(?:number|no\.?))?|"
    r"cell(?:\s+(?:phone|number))?|whatsapp|contact(?:\s+(?:number|details))?)\s*[:=]?",
    re.I,
)
PHONE_SPAN_RE = re.compile(r"(?<![A-Za-z0-9])\+?\(?\d[\d(). \t-]{5,}\d(?![A-Za-z0-9])")
REF_LABEL_RE = re.compile(
    r"\b(?:booking|reservation|confirmation|reference|ref|voucher|folio|invoice|itinerary)"
    r"(?:\s+(?:ref|reference|number|no\.?|id)){0,2}\s*[:#-]?\s*$",
    re.I,
)
DATE_LABEL_RE = re.compile(r"\b(?:arrival|departure|check[ -]?in|check[ -]?out|date|stay)"
                           r"(?:\s+date)?\s*[:#=-]?\s*$", re.I)
ROOM_LABEL_RE = re.compile(r"\b(?:rooms?|room\s+numbers?)\s*[:#=-]?\s*$", re.I)
OPAQUE_URL_SEGMENT_RE = re.compile(r"^[A-Za-z0-9_-]{24,}$")
SENSITIVE_QUERY_RE = re.compile(
    r"(?:token|auth|secret|password|passcode|api.?key|signature|session|credential|access.?key|otp|"
    r"email|e-mail|phone|mobile|cell|contact|recipient|address|card|cvv|cvc|pan|payment|security.?code|"
    r"\bmail\b|\bcc\b|\bsig\b)",
    re.I,
)
HTML_TAG_HINT_RE = re.compile(r"<\s*(?:!doctype\b|!--|/?[A-Za-z][A-Za-z0-9:-]*(?:\s|/?>))", re.I)
BUSINESS_IMAGE_CUES = (
    (re.compile(r"proof[-_ ]?(?:of[-_ ]?)?payment|payment[-_ ]?receipt|remittance", re.I), "possible payment proof"),
    (re.compile(r"vouchers?", re.I), "possible voucher"),
    (re.compile(r"invoices?", re.I), "possible invoice"),
)
DECORATIVE_LINE_RE = re.compile(r"[-_=*~·•#]{4,}")
MIN_REPEATED_BOILERPLATE_LINE_CHARS = 100
REPEATED_BOILERPLATE_CUE_RE = re.compile(
    r"\b(?:confidential(?:ity)?|privileged|unauthori[sz]ed|intended only for|"
    r"not intended (?:for|recipient)|received (?:this )?(?:e-?mail|message) in error|"
    r"misdirected message|views expressed|virus(?:es)?|malware|disclaimer|"
    r"environment before printing)\b",
    re.I,
)
REPEATED_BOILERPLATE_CONTEXT_RE = re.compile(
    r"\b(?:reserv\w*|book\w*|room\w*|guest\w*|stay\w*|check[ -]?(?:in|out)|"
    r"arrival|depart\w*|group\w*|event\w*|conference|meeting|wedding|function|banquet|block|"
    r"rate\w*|tariff|price\w*|cost\w*|quote\w*|quotation|discount\w*|availability|contract|"
    r"pay(?:ment|ments|ing|ed)?|paid|proof|pop|receipt\w*|remit\w*|refund\w*|deposit|billing|"
    r"invoice\w*|voucher\w*|card|credit|debit|transaction|transfer|bank|attachment\w*|"
    r"attach\w*|document\w*|file\w*|pdf|scan\w*|enclos\w*|image\w*|picture\w*|"
    r"date\w*|month|year|day|monday|tuesday|wednesday|thursday|friday|saturday|sunday|"
    r"january|february|march|april|june|july|august|september|october|november|december|"
    r"reference|ref\b|confirmation|folio|itinerary|identifier|\bid\b|account|number|no\.?|"
    r"password|passcode|secret|token|credential|"
    r"request\w*|quote|book|reserv\w*|cancel\w*|amend\w*|chang\w*|updat\w*|add(?:ed|ing|s)?|"
    r"creat\w*|send\w*|reply|respond|confirm\w*|advise\w*|arrange\w*|provide\w*|"
    r"require\w*|need\w*|follow[ -]?up|call|contact|check|could you|would you|"
    r"should|must|let me know)\b",
    re.I,
)
REPEATED_BOILERPLATE_URL_RE = re.compile(r"(?:https?://|www\.)", re.I)
REPEATED_BOILERPLATE_DATE_WORD_RE = re.compile(
    r"\b(?:january|february|march|april|june|july|august|september|october|november|december|"
    r"monday|tuesday|wednesday|thursday|friday|saturday|sunday|"
    r"(?:in|during|until|from|to|on)\s+may)\b",
    re.I,
)
CASE_ID_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}\Z")
SOURCE_ROW_REQUIRED_FIELDS = {
    "case_id",
    "source_row_id",
    "thread_id",
    "source_line",
    "message_index",
    "timestamp",
    "cohort",
    "embargoed",
    "stratum",
    "cue_flags",
}


class PilotError(Exception):
    """A user-safe failure; messages deliberately contain no source values."""


def _luhn_valid(digits: str) -> bool:
    total = 0
    double = False
    for char in reversed(digits):
        number = int(char)
        if double:
            number *= 2
            if number > 9:
                number -= 9
        total += number
        double = not double
    return total % 10 == 0


def _redact_url(match: re.Match[str], counts: Counter[str]) -> str:
    raw = match.group(0)
    trailing = ""
    while raw and raw[-1] in ".,;:!?)]}>":
        trailing = raw[-1] + trailing
        raw = raw[:-1]
    if not raw:
        return match.group(0)
    candidate = raw if "://" in raw else "https://" + raw
    try:
        parsed = urlsplit(candidate)
        if not parsed.hostname or parsed.username is not None or parsed.password is not None:
            counts["urls_withheld"] += 1
            return "[URL withheld]" + trailing
        query: list[tuple[str, str]] = []
        for key, value in parse_qsl(parsed.query, keep_blank_values=True):
            has_direct_contact = bool(EMAIL_RE.search(value)) or any(
                _mask_phone_span(phone.group(0), "") for phone in PHONE_SPAN_RE.finditer(value)
            )
            has_card_number = any(
                _luhn_valid(re.sub(r"\D", "", card.group(0))) for card in CARD_RE.finditer(value)
            )
            if (
                SENSITIVE_QUERY_RE.search(key)
                or len(value) >= 24 and re.fullmatch(r"[A-Za-z0-9_-]+", value)
                or has_direct_contact
                or has_card_number
            ):
                value = "[REDACTED]"
                counts["url_parameters_redacted"] += 1
            query.append((key, value))
        path_parts = parsed.path.split("/")
        for index, part in enumerate(path_parts):
            if OPAQUE_URL_SEGMENT_RE.fullmatch(part):
                path_parts[index] = "[REDACTED]"
                counts["url_path_segments_redacted"] += 1
        fragment = parsed.fragment
        if fragment and (
            SENSITIVE_QUERY_RE.search(fragment)
            or EMAIL_RE.search(fragment)
            or any(_mask_phone_span(phone.group(0), "") for phone in PHONE_SPAN_RE.finditer(fragment))
            or len(fragment) >= 24 and re.fullmatch(r"[A-Za-z0-9_-]+", fragment)
        ):
            fragment = "[REDACTED]"
            counts["url_fragments_redacted"] += 1
        safe_url = urlunsplit(
            (parsed.scheme, parsed.netloc, "/".join(path_parts), urlencode(query, doseq=True), fragment)
        )
        if raw.startswith("www."):
            safe_url = safe_url.removeprefix("https://")
        return safe_url + trailing
    except (ValueError, UnicodeError):
        counts["urls_withheld"] += 1
        return "[URL withheld]" + trailing


def _mask_phone_span(span: str, preceding_text: str) -> bool:
    digits = re.sub(r"\D", "", span)
    if not 7 <= len(digits) <= 15:
        return False
    if REF_LABEL_RE.search(preceding_text[-60:]):
        return False
    if ROOM_LABEL_RE.search(preceding_text[-60:]) and re.fullmatch(r"\d{1,4}(?:[ ,]+\d{1,4})+", span.strip()):
        return False
    if DATE_LABEL_RE.search(preceding_text[-60:]) and re.fullmatch(r"\d{8}", span.strip()):
        for date_format in ("%Y%m%d", "%d%m%Y"):
            try:
                datetime.datetime.strptime(span.strip(), date_format)
                return False
            except ValueError:
                pass
    # Preserve the common booking reference form; date-shaped spans are
    # protected separately before this routine is called.
    if re.fullmatch(r"\d{7,12}-\d{1,3}", span.strip()):
        return False
    # Room ranges are not direct phone numbers.
    if re.fullmatch(r"\d{1,4}-\d{1,4}", span.strip()):
        return False
    return True


def _mask_phones_in_non_date_text(text: str, counts: Counter[str]) -> str:
    chunks = DATE_RE.split(text)
    output: list[str] = []
    for index, chunk in enumerate(chunks):
        if index % 2 == 1:
            output.append(chunk)
            continue
        cursor = 0
        pieces: list[str] = []
        for match in PHONE_SPAN_RE.finditer(chunk):
            span = match.group(0)
            before = chunk[:match.start()]
            pieces.append(chunk[cursor:match.start()])
            if _mask_phone_span(span, before):
                pieces.append("[REDACTED_PHONE]")
                counts["phones"] += 1
            else:
                pieces.append(span)
            cursor = match.end()
        pieces.append(chunk[cursor:])
        output.append("".join(pieces))
    return "".join(output)


MAX_CONTACT_VALUE_LINES = 8


def _line_content(line: str) -> str:
    return line.rstrip("\r\n")


def _line_ending(line: str) -> str:
    if line.endswith("\r\n"):
        return "\r\n"
    if line.endswith(("\r", "\n")):
        return line[-1]
    return ""


def _contact_fragment_kind(line: str, *, email_possible: bool) -> str | None:
    """Recognize wrapped contact-value fragments without printing or returning them."""
    value = line.strip()
    if not value or len(value) > 256:
        return None
    if EMAIL_RE.search(value):
        return "email"
    if re.fullmatch(r"[+()0-9][+()0-9 ./-]{0,63}", value) and any(char.isdigit() for char in value):
        return "phone"
    if re.fullmatch(r"[A-Za-z0-9@._%+-]+", value):
        if email_possible or any(char in "@._%+-" or char.isdigit() for char in value):
            return "email"
    return None


def _withhold_standalone_contact_fields(text: str, counts: Counter[str]) -> tuple[str, bool]:
    """Withhold a standalone contact label and its nearby wrapped value lines.

    The first immediate nonempty line after the label is treated as its value;
    after blank lines, only contact-like fragments are included. Further
    adjacent email/phone-like fragments are withheld so wrapped values are not
    exposed while unrelated prose after the field remains usable.
    """
    lines = text.splitlines(keepends=True)
    withheld: set[int] = set()
    index = 0
    while index < len(lines):
        content = _line_content(lines[index]).strip()
        if not CONTACT_FIELD_LABEL_RE.fullmatch(content):
            index += 1
            continue

        counts["contact_field_boundaries"] += 1
        withheld.add(index)
        next_index = index + 1
        value_lines = 0
        email_possible = False
        while next_index < len(lines):
            next_content = _line_content(lines[next_index]).strip()
            if CONTACT_FIELD_LABEL_RE.fullmatch(next_content):
                break
            if not next_content:
                # Blank lines are kept, but may sit between wrapped value
                # fragments. Continue only when the following line still
                # resembles a contact-value fragment.
                candidate_index = next_index + 1
                while candidate_index < len(lines) and not _line_content(lines[candidate_index]).strip():
                    candidate_index += 1
                if candidate_index >= len(lines):
                    break
                candidate = _line_content(lines[candidate_index]).strip()
                candidate_kind = _contact_fragment_kind(candidate, email_possible=True)
                if candidate_kind is None:
                    break
                next_index = candidate_index
                next_content = candidate

            if value_lines == 0:
                # The first nearby value line can be a name or a short split
                # fragment that no standalone detector can recognize yet.
                withheld.add(next_index)
                value_lines += 1
                email_possible = bool(re.fullmatch(r"[A-Za-z0-9@._%+-]+", next_content))
                next_index += 1
                continue

            kind = _contact_fragment_kind(next_content, email_possible=email_possible)
            if kind is None:
                break
            if value_lines >= MAX_CONTACT_VALUE_LINES:
                # An unusually long ambiguous field is safer to reject than
                # to stop at a fixed boundary and risk leaking its tail.
                counts["ambiguous_contact_field_boundary"] += 1
                counts["field_withheld"] = 1
                return "[sensitive content withheld]", False
            withheld.add(next_index)
            value_lines += 1
            if kind == "email":
                email_possible = True
            next_index += 1

        index = next_index

    if not withheld:
        return text, True
    counts["contact_field_lines_withheld"] += len(withheld)
    for line_index in withheld:
        lines[line_index] = "[CONTACT FIELD WITHHELD]" + _line_ending(lines[line_index])
    return "".join(lines), True


def guard_text(text: Any) -> tuple[str, dict[str, int], bool]:
    """Mask likely direct identifiers/secrets; return only aggregate provenance.

    The caller must withhold the entire field when ``safe`` is false. No raw
    match, address, identifier, or removed value is returned in provenance.
    """
    counts: Counter[str] = Counter()
    if not isinstance(text, str) or len(text) > MAX_GUARD_INPUT_CHARS:
        counts["field_withheld"] = 1
        return "[sensitive content withheld]", dict(counts), False
    normalized = unicodedata.normalize("NFKC", text).translate(
        str.maketrans({"‐": "-", "‑": "-", "‒": "-", "–": "-", "—": "-", "−": "-"})
    )
    format_controls_removed = sum(unicodedata.category(char) == "Cf" for char in normalized)
    counts["unicode_format_controls_removed"] = format_controls_removed
    if format_controls_removed:
        normalized = "".join(char for char in normalized if unicodedata.category(char) != "Cf")
    if any(
        unicodedata.category(char) in {"Cc", "Cs"} and char not in "\t\r\n"
        for char in normalized
    ):
        counts["field_withheld"] = 1
        return "[sensitive content withheld]", dict(counts), False
    if EMPTY_CREDENTIAL_RE.search(normalized) or EMPTY_PAYMENT_FIELD_RE.search(normalized):
        counts["field_withheld"] = 1
        counts["ambiguous_sensitive_field_boundary"] = 1
        return "[sensitive content withheld]", dict(counts), False

    normalized, contact_safe = _withhold_standalone_contact_fields(normalized, counts)
    if not contact_safe:
        return "[sensitive content withheld]", dict(counts), False

    value = re.sub(r"(?i)\b(?:https?://|www\.)[^\s<>]+", lambda m: _redact_url(m, counts), normalized)

    def mask_credential(match: re.Match[str]) -> str:
        counts["credential_values"] += 1
        return match.group(1) + " [REDACTED_CREDENTIAL]"

    value = CREDENTIAL_ASSIGNMENT_RE.sub(mask_credential, value)

    def mask_bare_credential(match: re.Match[str]) -> str:
        first = match.group(2).split(maxsplit=1)[0].strip(".,:;!?()[]").casefold()
        if first in {"before", "after", "when", "if", "for", "to", "by", "without", "with",
                     "will", "must", "should", "can", "has", "had", "was", "expired", "required",
                     "reset", "changed", "change", "please", "and", "or", "on", "again", "needs"}:
            return match.group(0)
        return mask_credential(match)

    value = BARE_CREDENTIAL_RE.sub(mask_bare_credential, value)

    def mask_bearer(match: re.Match[str]) -> str:
        counts["credential_values"] += 1
        return match.group(1) + " [REDACTED_CREDENTIAL]"

    value = BEARER_RE.sub(mask_bearer, value)

    def mask_cvv(match: re.Match[str]) -> str:
        counts["security_codes"] += 1
        return match.group(1) + match.group(2) + "[REDACTED_CVV]"

    value = CVV_RE.sub(mask_cvv, value)

    def mask_card(match: re.Match[str]) -> str:
        digits = re.sub(r"\D", "", match.group(0))
        if _luhn_valid(digits):
            counts["card_numbers"] += 1
            return "[REDACTED_CARD]"
        # A labelled card value is withheld even if a mistyped number fails
        # Luhn; an unlabelled non-PAN long number may be a meaningful reference.
        prefix = value[max(0, match.start() - 24) : match.start()]
        if re.search(r"\b(?:card|credit\s+card|pan)\s*(?:number|no\.?|#|:)?\s*$", prefix, re.I):
            counts["card_numbers"] += 1
            return "[REDACTED_CARD]"
        return match.group(0)

    value = CARD_RE.sub(mask_card, value)
    value = EMAIL_RE.sub(lambda _m: _counted_token(counts, "emails", "[REDACTED_EMAIL]"), value)
    value = _mask_phones_in_non_date_text(value, counts)
    return value, dict(counts), True


def _counted_token(counts: Counter[str], key: str, token: str) -> str:
    counts[key] += 1
    return token


class _VisibleHTMLText(HTMLParser):
    """Keep visible text and image-presence placeholders, never HTML attributes."""

    _BLOCKS = {"address", "article", "blockquote", "br", "div", "footer", "h1", "h2", "h3", "h4", "li", "p", "section", "td", "th", "tr"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.suppressed_tags: list[str] = []
        self.tag_count = 0
        self.comment_count = 0
        self.hidden_block_count = 0
        self.image_count = 0
        self.link_count = 0
        self.embedded_count = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.tag_count += 1
        if tag in {"script", "style"}:
            self.suppressed_tags.append(tag)
            self.hidden_block_count += 1
            return
        if self.suppressed_tags:
            return
        if tag in self._BLOCKS:
            self.parts.append("\n")
        if tag == "a" and any(key.lower() == "href" and value for key, value in attrs):
            # The destination may contain tokens or private identifiers. Its
            # existence can still matter to a document workflow.
            self.link_count += 1
            self.parts.append("[link destination withheld] ")
        if tag in {"svg", "image", "iframe", "object", "embed"}:
            self.embedded_count += 1
            self.parts.append("[embedded visual content present; bytes unavailable]")
        if tag == "img":
            self.image_count += 1
            alt = next((value for key, value in attrs if key.lower() == "alt" and value), None)
            src = next((value for key, value in attrs if key.lower() == "src" and value), "")
            cue = next((label for pattern, label in BUSINESS_IMAGE_CUES if pattern.search(src)), None)
            if alt:
                self.parts.append("[inline image; bytes unavailable; alt: ")
                self.parts.append(alt)
                self.parts.append("]")
            else:
                self.parts.append("[inline image present; bytes unavailable]")
            if cue:
                self.parts.append(" [" + cue + "; source name withheld]")

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.handle_starttag(tag, attrs)
        if tag in {"script", "style"}:
            self.handle_endtag(tag)

    def handle_endtag(self, tag: str) -> None:
        self.tag_count += 1
        if tag in {"script", "style"} and self.suppressed_tags:
            if self.suppressed_tags[-1] == tag:
                self.suppressed_tags.pop()
            return
        if self.suppressed_tags:
            return
        if tag in self._BLOCKS:
            self.parts.append("\n")

    def handle_data(self, data: str) -> None:
        if not self.suppressed_tags:
            self.parts.append(data)

    def handle_comment(self, _data: str) -> None:
        self.comment_count += 1


def _visible_text(value: Any) -> tuple[str, dict[str, int], bool]:
    if not isinstance(value, str):
        return "[sensitive content withheld]", {"field_withheld": 1}, False
    if not HTML_TAG_HINT_RE.search(value):
        return html.unescape(value), {
            "html_tags_removed": 0,
            "html_comments_removed": 0,
            "hidden_script_style_blocks_removed": 0,
            "inline_images_not_available": 0,
            "link_destinations_withheld": 0,
            "embedded_visuals_not_available": 0,
        }, True
    parser = _VisibleHTMLText()
    try:
        parser.feed(value)
        parser.close()
    except (ValueError, AssertionError):
        return "[sensitive content withheld]", {"field_withheld": 1, "html_parse_failure": 1}, False
    return "".join(parser.parts), {
        "html_tags_removed": parser.tag_count,
        "html_comments_removed": parser.comment_count,
        "hidden_script_style_blocks_removed": parser.hidden_block_count,
        "inline_images_not_available": parser.image_count,
        "link_destinations_withheld": parser.link_count,
        "embedded_visuals_not_available": parser.embedded_count,
    }, True


def _is_repeated_nonactionable_boilerplate(line: str) -> bool:
    candidate = line.strip()
    if len(candidate) < MIN_REPEATED_BOILERPLATE_LINE_CHARS or "[" in candidate or "]" in candidate:
        return False
    if any(char.isdigit() for char in candidate):
        return False
    if (
        EMAIL_RE.search(candidate)
        or PHONE_SPAN_RE.search(candidate)
        or REPEATED_BOILERPLATE_URL_RE.search(candidate)
        or DATE_RE.search(candidate)
        or REPEATED_BOILERPLATE_DATE_WORD_RE.search(candidate)
    ):
        return False
    if REPEATED_BOILERPLATE_CONTEXT_RE.search(candidate):
        return False
    return bool(REPEATED_BOILERPLATE_CUE_RE.search(candidate))


def _clean_decorative_separators(text: str) -> tuple[str, dict[str, int], list[dict[str, int]]]:
    kept: list[str] = []
    spans: list[dict[str, int]] = []
    removals = {
        "decorative_separator_lines": 0,
        "repeated_nonactionable_boilerplate_lines_removed": 0,
        "repeated_nonactionable_boilerplate_characters_removed": 0,
    }
    seen_boilerplate_lines: set[str] = set()
    original_offset = clean_offset = 0
    for line in text.splitlines(keepends=True):
        raw = line.rstrip("\r\n")
        remove_line = False
        if DECORATIVE_LINE_RE.fullmatch(raw.strip()):
            removals["decorative_separator_lines"] += 1
            remove_line = True
        elif _is_repeated_nonactionable_boilerplate(raw):
            if raw in seen_boilerplate_lines:
                removals["repeated_nonactionable_boilerplate_lines_removed"] += 1
                removals["repeated_nonactionable_boilerplate_characters_removed"] += len(line)
                remove_line = True
            else:
                seen_boilerplate_lines.add(raw)
        if not remove_line:
            kept.append(line)
            if spans and spans[-1]["original_end"] == original_offset:
                spans[-1]["original_end"] += len(line)
                spans[-1]["cleaned_end"] += len(line)
            else:
                spans.append({"original_start": original_offset, "original_end": original_offset + len(line),
                              "cleaned_start": clean_offset, "cleaned_end": clean_offset + len(line)})
            clean_offset += len(line)
        original_offset += len(line)
    return "".join(kept), removals, spans


def _address_list(value: Any) -> list[str] | None:
    if isinstance(value, str):
        return [value]
    if isinstance(value, list) and all(isinstance(item, str) for item in value):
        return value
    if value is None:
        return []
    return None


def _mailboxes(values: Any) -> list[str] | None:
    entries = _address_list(values)
    if entries is None:
        return None
    return [address.casefold() for _name, address in email.utils.getaddresses(entries) if address and "@" in address]


def _sender_features(addresses: Any) -> tuple[str, bool | str, bool | str]:
    if not isinstance(addresses, dict):
        return "unknown", "unknown", "unknown"
    senders = _mailboxes(addresses.get("from"))
    recipients: list[str] = []
    for key in ("to", "cc", "bcc"):
        values = _mailboxes(addresses.get(key))
        if values is None:
            return "unknown", "unknown", "unknown"
        recipients.extend(values)
    if senders is None:
        return "unknown", "unknown", "unknown"
    valid_senders = [address for address in senders if re.fullmatch(r"[^@\s]+@[^@\s]+", address)]
    if not valid_senders:
        return "unknown", "unknown", "unknown"
    domains = {address.rsplit("@", 1)[1].lower().rstrip(".") for address in valid_senders}
    domain = next(iter(domains)) if len(domains) == 1 and all("." in item for item in domains) else "unknown"
    no_reply = any(re.search(r"no[-_.]?reply", address.rsplit("@", 1)[0], re.I) for address in valid_senders)
    same = bool(set(valid_senders) & set(recipients)) if recipients else "unknown"
    return domain, no_reply, same


def _validate_manifest(
    manifest: Any,
    *,
    source_sha256: str,
    seed: str,
    expected_counts: Mapping[str, int],
) -> list[dict[str, Any]]:
    if not isinstance(manifest, dict):
        raise PilotError("manifest_invalid")
    if manifest.get("schema") != "centurion-pilot250-v1":
        raise PilotError("manifest_schema_mismatch")
    if manifest.get("source_sha256") != source_sha256 or manifest.get("seed") != seed:
        raise PilotError("manifest_fingerprint_or_seed_mismatch")
    selected = manifest.get("selected")
    if not isinstance(selected, list) or len(selected) != sum(expected_counts.values()):
        raise PilotError("manifest_selection_count_mismatch")
    counts: Counter[str] = Counter()
    case_ids: set[str] = set()
    source_ids: set[str] = set()
    thread_ids: set[str] = set()
    seen_rows: set[str] = set()
    validated: list[dict[str, Any]] = []
    for item in selected:
        if not isinstance(item, dict) or not SOURCE_ROW_REQUIRED_FIELDS.issubset(item):
            raise PilotError("manifest_row_invalid")
        case_id = item.get("case_id")
        source_id = item.get("source_row_id")
        thread_id = item.get("thread_id")
        source_line = item.get("source_line")
        message_index = item.get("message_index")
        timestamp = item.get("timestamp")
        cohort = item.get("cohort")
        embargoed = item.get("embargoed")
        stratum = item.get("stratum")
        cue_flags = item.get("cue_flags")
        if not isinstance(case_id, str) or not CASE_ID_RE.fullmatch(case_id):
            raise PilotError("manifest_case_id_invalid")
        case_guarded, _case_privacy, case_safe = guard_text(case_id)
        if not case_safe or case_guarded != case_id:
            raise PilotError("manifest_case_id_not_pseudonymous")
        if not isinstance(source_id, str) or not source_id or not isinstance(thread_id, str) or not thread_id:
            raise PilotError("manifest_source_identity_invalid")
        if not isinstance(source_line, int) or isinstance(source_line, bool) or source_line < 1:
            raise PilotError("manifest_source_line_invalid")
        if not isinstance(message_index, int) or isinstance(message_index, bool) or message_index < 0:
            raise PilotError("manifest_message_index_invalid")
        if not isinstance(timestamp, str) or not timestamp:
            raise PilotError("manifest_timestamp_invalid")
        if not isinstance(cohort, str) or cohort not in expected_counts or type(embargoed) is not bool:
            raise PilotError("manifest_cohort_invalid")
        if not isinstance(stratum, str) or not isinstance(cue_flags, list) or not all(isinstance(flag, str) for flag in cue_flags):
            raise PilotError("manifest_selection_metadata_invalid")
        if case_id in case_ids or source_id in seen_rows:
            raise PilotError("manifest_duplicate_case_or_source_row")
        case_ids.add(case_id)
        seen_rows.add(source_id)
        source_ids.add(source_id)
        thread_ids.add(thread_id)
        counts[cohort] += 1
        validated.append(item)
    if any(counts[cohort] != expected_counts[cohort] for cohort in expected_counts):
        raise PilotError("manifest_cohort_count_mismatch")
    if case_ids & (source_ids | thread_ids) or any(
        len(identity) >= 12 and identity.casefold() in case_id.casefold()
        for case_id in case_ids
        for identity in source_ids | thread_ids
    ):
        raise PilotError("case_id_overlaps_source_identity")
    return validated


def _build_packet_pair(
    item: Mapping[str, Any],
    thread_record: Mapping[str, Any],
    *,
    source_ids: set[str],
    thread_ids: set[str],
) -> tuple[dict[str, Any], dict[str, Any]]:
    if thread_record.get("recordType") != "thread" or thread_record.get("threadId") != item["thread_id"]:
        raise PilotError("source_thread_mismatch")
    messages = thread_record.get("messages")
    message_index = item["message_index"]
    if not isinstance(messages, list) or message_index >= len(messages):
        raise PilotError("source_message_index_missing")
    message = messages[message_index]
    if not isinstance(message, dict) or message.get("timestamp") != item["timestamp"]:
        raise PilotError("source_timestamp_or_message_mismatch")
    matching_rows: list[dict[str, Any]] = []
    global_matches: list[int] = []
    for index, candidate_message in enumerate(messages):
        if not isinstance(candidate_message, dict):
            continue
        rows = candidate_message.get("sourceRows")
        if not isinstance(rows, list):
            continue
        for row in rows:
            if isinstance(row, dict) and row.get("sourceRowId") == item["source_row_id"]:
                global_matches.append(index)
                if index == message_index:
                    matching_rows.append(row)
    if global_matches != [message_index] or len(matching_rows) != 1:
        raise PilotError("source_row_message_match_ambiguous")
    source_row = matching_rows[0]
    private = source_row.get("privateMessage")
    if not isinstance(private, dict):
        raise PilotError("source_private_message_missing")
    source_metadata = private.get("sourceMetadata")
    membership = source_row.get("scopeMembership")
    if (
        private.get("direction") != "inbound"
        or not isinstance(source_metadata, dict)
        or source_metadata.get("transportId") != "transport-centurion"
        or not isinstance(membership, list)
        or "active_transport" not in membership
    ):
        raise PilotError("source_scope_mismatch")

    subject_raw = private.get("subject")
    body_raw = source_row.get("body")
    body_visible, html_removals, body_type_ok = _visible_text(body_raw)
    subject = html.unescape(subject_raw) if isinstance(subject_raw, str) else subject_raw
    guarded_subject, subject_privacy, subject_safe = guard_text(subject)
    guarded_body, body_privacy, body_safe = guard_text(body_visible)
    if not subject_safe:
        guarded_subject = "[sensitive content withheld]"
        subject_privacy["field_withheld"] = 1
    if not body_type_ok or not body_safe:
        guarded_body = "[sensitive content withheld]"
        body_privacy["field_withheld"] = 1

    internal_identifiers = {value.casefold() for value in source_ids | thread_ids if len(value) >= 12}
    withheld_identity_fields: list[str] = []
    for field_name, field_value in (("subject", guarded_subject), ("body", guarded_body)):
        folded = field_value.casefold()
        if any(identifier in folded for identifier in internal_identifiers):
            withheld_identity_fields.append(field_name)
    if "subject" in withheld_identity_fields:
        guarded_subject = "[source identifier-bearing text withheld]"
        subject_privacy["field_withheld_for_source_identifier"] = 1
    if "body" in withheld_identity_fields:
        guarded_body = "[source identifier-bearing text withheld]"
        body_privacy["field_withheld_for_source_identifier"] = 1

    subject_truncated = len(guarded_subject) > MAX_SUBJECT_CHARS
    body_truncated = len(guarded_body) > MAX_BODY_CHARS
    guarded_subject = guarded_subject[:MAX_SUBJECT_CHARS]
    guarded_body = guarded_body[:MAX_BODY_CHARS]

    cleaned_body, body_removals, cleaned_spans = _clean_decorative_separators(guarded_body)
    removed_separators = body_removals["decorative_separator_lines"]
    removed_boilerplate_lines = body_removals["repeated_nonactionable_boilerplate_lines_removed"]
    sender_domain, no_reply_clue, same_from_recipient = _sender_features(private.get("addresses"))
    gaps = [
        "inbound_attachment_inventory_and_bytes_unknown",
        "prior_messages_not_added_without_verified_ancestry_and_receive_order",
        "linked_later_attachment_metadata_not_used_without_decision_time_provenance",
        "stored_message_date_timezone_and_arrival_order_unverified",
    ]
    if not isinstance(subject_raw, str):
        gaps.append("subject_unavailable_or_withheld")
    if not isinstance(source_row.get("body"), str):
        gaps.append("body_unavailable_or_withheld")
    if subject_privacy.get("field_withheld"):
        gaps.append("subject_withheld_by_privacy_guard")
    if body_privacy.get("field_withheld"):
        gaps.append("body_withheld_by_privacy_guard")
    if any(subject_privacy.values()) or any(body_privacy.values()):
        gaps.append("sensitive_or_contact_values_redacted_original_values_unknown")
    partial_contact_field_withholding = any(
        privacy.get("contact_field_lines_withheld", 0)
        for privacy in (subject_privacy, body_privacy)
    )
    if partial_contact_field_withholding:
        gaps.append("partial_contact_field_label_and_nearby_values_withheld_original_values_unknown")
    if subject_truncated:
        gaps.append("subject_truncated_remainder_unknown")
    if body_truncated:
        gaps.append("body_truncated_remainder_unknown")
    if html_removals.get("inline_images_not_available", 0):
        gaps.append("inline_image_bytes_unavailable")
    if html_removals.get("embedded_visuals_not_available", 0):
        gaps.append("embedded_visual_content_unavailable")
    if html_removals.get("link_destinations_withheld", 0):
        gaps.append("link_destinations_withheld_and_linked_file_content_unknown")
    if "subject" in withheld_identity_fields or "body" in withheld_identity_fields:
        gaps.append("source_identifier_bearing_field_withheld")

    base_flags = ["privacy_guard_applied_to_both_variants"]
    if any(subject_privacy.values()) or any(body_privacy.values()):
        base_flags.append("privacy_redactions_or_withholding_applied")
    if partial_contact_field_withholding:
        base_flags.append("privacy_guard_partially_withheld_contact_field_region")
    if html_removals.get("html_tags_removed") or html_removals.get("html_comments_removed"):
        base_flags.append("html_markup_removed_from_visible_text")
    if subject_truncated:
        base_flags.append("subject_truncated")
    if body_truncated:
        base_flags.append("body_truncated")
    if removed_separators:
        base_flags.append("cleaned_variant_removed_decorative_separator_lines")
    else:
        base_flags.append("no_safe_decorative_removal_found")
    if removed_boilerplate_lines:
        base_flags.append("cleaned_variant_removed_repeated_nonactionable_boilerplate_lines")

    common_input = {
        "target": {
            "subject": guarded_subject,
            "body": guarded_body,
            "stored_message_date": item["timestamp"][:10],
            "sender_domain": sender_domain,
            "no_reply_sender_clue": no_reply_clue,
            "same_from_and_recipient": same_from_recipient,
            "attachment_inventory": "unknown",
            "attachments": "unknown",
        },
        "prior_messages": [],
        "context_gaps": gaps,
    }
    cleaned_input = json.loads(json.dumps(common_input, ensure_ascii=False))
    cleaned_input["target"]["body"] = cleaned_body
    if removed_boilerplate_lines:
        cleaned_input["context_gaps"].append(
            "cleaned_variant_omits_repeated_nonactionable_boilerplate_lines"
        )

    def digest(value: str) -> str:
        return hashlib.sha256(value.encode("utf-8", errors="surrogatepass")).hexdigest()

    def packet(
        input_value: dict[str, Any],
        packet_removals: Mapping[str, int],
        spans: list[dict[str, int]],
    ) -> dict[str, Any]:
        flags = list(base_flags)
        if (
            packet_removals["decorative_separator_lines"] == 0
            and "cleaned_variant_removed_decorative_separator_lines" in flags
        ):
            flags.remove("cleaned_variant_removed_decorative_separator_lines")
        if (
            packet_removals["repeated_nonactionable_boilerplate_lines_removed"] == 0
            and "cleaned_variant_removed_repeated_nonactionable_boilerplate_lines" in flags
        ):
            flags.remove("cleaned_variant_removed_repeated_nonactionable_boilerplate_lines")
        cleaning = {
            "version": CLEANING_VERSION,
            "flags": flags,
            "privacy": {
                "same_guard_for_original_and_cleaned": True,
                "subject": subject_privacy,
                "body": body_privacy,
            },
            "removals": {
                **html_removals,
                **packet_removals,
            },
            "provenance": {
                "source_body_text_sha256": digest(body_raw) if isinstance(body_raw, str) else None,
                "guarded_visible_body_sha256": digest(guarded_body),
                "output_body_sha256": digest(input_value["target"]["body"]),
                "span_map_basis": "guarded visible original to output; HTML/privacy transformations precede this map",
                "guarded_original_to_output_spans": spans,
            },
        }
        return {"case_id": item["case_id"], "input": input_value, "cleaning": cleaning}

    original_spans = ([{"original_start": 0, "original_end": len(guarded_body),
                        "cleaned_start": 0, "cleaned_end": len(guarded_body)}] if guarded_body else [])
    original_removals = {key: 0 for key in body_removals}
    return (
        packet(common_input, original_removals, original_spans),
        packet(cleaned_input, body_removals, cleaned_spans),
    )


def prepare_packets(
    source_path: Path,
    manifest: Any,
    *,
    expected_source_sha256: str = PLAN_SOURCE_SHA256,
    expected_seed: str = PLAN_SEED,
    expected_counts: Mapping[str, int] = PLAN_COHORT_COUNTS,
    include_holdout: bool = False,
    include_embargoed: bool = False,
) -> tuple[dict[str, list[tuple[dict[str, Any], dict[str, Any]]]], dict[str, int]]:
    validated = _validate_manifest(
        manifest,
        source_sha256=expected_source_sha256,
        seed=expected_seed,
        expected_counts=expected_counts,
    )
    try:
        digest = hashlib.sha256()
        with source_path.open("rb") as source_file:
            for chunk in iter(lambda: source_file.read(1024 * 1024), b""):
                digest.update(chunk)
    except OSError as _error:
        raise PilotError("source_unreadable") from None
    if digest.hexdigest() != expected_source_sha256 or manifest.get("source_sha256") != digest.hexdigest():
        raise PilotError("source_fingerprint_mismatch")

    eligible: list[dict[str, Any]] = []
    skipped_holdout = 0
    skipped_embargoed = 0
    for item in validated:
        if item["cohort"] == "random_holdout":
            if not include_holdout:
                skipped_holdout += 1
                continue
        elif item["embargoed"] and not include_embargoed:
            skipped_embargoed += 1
            continue
        eligible.append(item)
    if not eligible:
        raise PilotError("no_eligible_rows")

    by_line: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for item in eligible:
        by_line[item["source_line"]].append(item)
    identities = {item["source_row_id"] for item in validated}
    thread_ids = {item["thread_id"] for item in validated}
    prepared: dict[str, list[tuple[dict[str, Any], dict[str, Any]]]] = defaultdict(list)
    seen_lines: set[int] = set()
    try:
        with source_path.open("rb") as source_file:
            for line_number, raw in enumerate(source_file, start=1):
                if line_number not in by_line:
                    continue
                if len(raw) > MAX_SOURCE_LINE_BYTES:
                    raise PilotError("selected_source_line_too_large")
                try:
                    record = json.loads(raw)
                except (json.JSONDecodeError, UnicodeDecodeError, TypeError):
                    raise PilotError("selected_source_line_invalid") from None
                if not isinstance(record, dict):
                    raise PilotError("selected_source_line_invalid")
                for item in by_line[line_number]:
                    original, cleaned = _build_packet_pair(
                        item,
                        record,
                        source_ids=identities,
                        thread_ids=thread_ids,
                    )
                    prepared[item["cohort"]].append((original, cleaned))
                seen_lines.add(line_number)
    except OSError as _error:
        raise PilotError("source_unreadable") from None
    if seen_lines != set(by_line):
        raise PilotError("selected_source_line_missing")

    summary = {
        "prepared": len(eligible),
        "skipped_holdout": skipped_holdout,
        "skipped_embargoed": skipped_embargoed,
        "cohorts": len(prepared),
    }
    return dict(prepared), summary


def _write_private_file(path: Path, records: Iterable[dict[str, Any]]) -> None:
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        fd = os.open(path, flags, 0o600)
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            for record in records:
                handle.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")))
                handle.write("\n")
    except OSError as _error:
        raise PilotError("packet_output_write_failed") from None


def write_packets(
    output_dir: Path,
    prepared: Mapping[str, Sequence[tuple[dict[str, Any], dict[str, Any]]]],
) -> None:
    if os.path.lexists(output_dir):
        raise PilotError("output_directory_already_exists")
    try:
        os.mkdir(output_dir, 0o700)
        os.chmod(output_dir, 0o700)
    except OSError as _error:
        raise PilotError("output_directory_create_failed") from None
    for cohort in COHORTS:
        records = prepared.get(cohort)
        if not records:
            continue
        cohort_dir = output_dir / cohort
        try:
            os.mkdir(cohort_dir, 0o700)
            os.chmod(cohort_dir, 0o700)
        except OSError as _error:
            raise PilotError("cohort_directory_create_failed") from None
        _write_private_file(cohort_dir / "original.jsonl", (pair[0] for pair in records))
        _write_private_file(cohort_dir / "cleaned.jsonl", (pair[1] for pair in records))


def _private_root(repo_root: Path | None = None) -> Path:
    repo_root = repo_root or Path(__file__).resolve().parents[4]
    private_root = repo_root / ".private"
    try:
        info = private_root.lstat()
    except OSError:
        raise PilotError("private_root_unavailable") from None
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
        raise PilotError("private_root_not_directory")
    # The workspace's .private anchor is group-shared; its corpus and newly
    # created run directories remain owner-only below that anchor.
    if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o007:
        raise PilotError("private_root_world_accessible_or_wrong_owner")
    return private_root.resolve(strict=True)


def _check_owner_only_directory(path: Path, private_root: Path) -> None:
    current = path
    while current != private_root:
        try:
            info = current.stat()
        except OSError:
            raise PilotError("private_parent_unreadable") from None
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077:
            raise PilotError("private_parent_not_owner_only")
        if private_root not in current.parents:
            raise PilotError("path_outside_private_root")
        current = current.parent


def _private_input_path(argument: str, private_root: Path) -> Path:
    supplied = Path(argument)
    if not supplied.is_absolute():
        supplied = Path.cwd() / supplied
    try:
        if supplied.is_symlink():
            raise PilotError("private_input_symlink")
        resolved = supplied.resolve(strict=True)
        resolved.relative_to(private_root)
        info = resolved.stat()
    except (OSError, ValueError):
        raise PilotError("private_input_path_invalid") from None
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077:
        raise PilotError("private_input_not_owner_only")
    _check_owner_only_directory(resolved.parent, private_root)
    return resolved


def _new_output_path(argument: str, private_root: Path) -> Path:
    supplied = Path(argument)
    if not supplied.is_absolute():
        supplied = Path.cwd() / supplied
    try:
        parent = supplied.parent.resolve(strict=True)
    except OSError:
        raise PilotError("output_parent_invalid") from None
    if parent != private_root or supplied.name in {"", ".", ".."} or os.path.lexists(supplied):
        raise PilotError("output_must_be_new_private_child")
    return parent / supplied.name


def _load_manifest(path: Path) -> Any:
    try:
        with path.open("r", encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, json.JSONDecodeError, UnicodeDecodeError):
        raise PilotError("manifest_unreadable_or_invalid") from None


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=False, help="Pinned corpus JSONL under .private")
    parser.add_argument("--manifest", required=False, help="Owner-only frozen pilot manifest under .private")
    parser.add_argument("--output", required=False, help="New direct child directory under .private")
    parser.add_argument("--include-holdout", action="store_true", help="Explicitly include the random holdout cohort")
    parser.add_argument("--include-embargoed", action="store_true", help="Explicitly include embargoed rows")
    parser.add_argument("--self-test", action="store_true", help="Run synthetic-only safety tests")
    args = parser.parse_args(argv)
    if args.self_test:
        return run_self_tests()
    if not args.source or not args.manifest or not args.output:
        parser.error("--source, --manifest and --output are required")
    try:
        private_root = _private_root()
        source_path = _private_input_path(args.source, private_root)
        manifest_path = _private_input_path(args.manifest, private_root)
        output_dir = _new_output_path(args.output, private_root)
        manifest = _load_manifest(manifest_path)
        prepared, summary = prepare_packets(
            source_path,
            manifest,
            include_holdout=args.include_holdout,
            include_embargoed=args.include_embargoed,
        )
        write_packets(output_dir, prepared)
    except PilotError as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 2
    print(
        "Prepared {prepared} guarded cases in {cohorts} cohort directories; "
        "excluded {skipped_holdout} holdout and {skipped_embargoed} embargoed cases by default.".format(**summary)
    )
    return 0


def _synthetic_fixture() -> tuple[bytes, dict[str, Any], dict[str, int]]:
    cohort_counts = {"random_development": 2, "random_holdout": 1, "targeted_development": 2}
    source_lines: list[str] = []
    selected: list[dict[str, Any]] = []
    cohorts = [
        ("random_development", False),
        ("random_development", False),
        ("random_holdout", True),
        ("targeted_development", False),
        ("targeted_development", True),
    ]
    for index, (cohort, embargoed) in enumerate(cohorts, start=1):
        source_id = f"SYNTHETIC_ROW_ID_{index:03d}"
        thread_id = f"SYNTHETIC_THREAD_ID_{index:03d}"
        timestamp = f"2026-10-{index:02d}T09:30:00Z"
        message = {
            "timestamp": timestamp,
            "sourceRows": [
                {
                    "sourceRowId": source_id,
                    "scopeMembership": ["active_transport"],
                    "privateMessage": {
                        "direction": "inbound",
                        "subject": "Quote request — synthetic test",
                        "addresses": {
                            "from": ["Synthetic guest <guest@example.invalid>"],
                            "to": ["Reservations <reservations@example.invalid>"],
                            "cc": [],
                            "bcc": [],
                        },
                        "sourceMetadata": {"transportId": "transport-centurion"},
                    },
                    "body": (
                        "Please quote 2 rooms for 2027-05-12. Booking ref 57291630-1.\n"
                        "Contact person@example.invalid or +27 82 555 0101.\n"
                        "Password: synthetic-secret.\nCVV: 123.\nCard 4111111111111111.\n"
                        "----\n"
                    ),
                }
            ],
        }
        messages = [message]
        message_index = 0
        if index == 1:
            messages = [
                {
                    "timestamp": "2026-10-01T08:00:00Z",
                    "sourceRows": [
                        {
                            "sourceRowId": "SYNTHETIC_UNVERIFIED_PRIOR_ROW",
                            "body": "Synthetic earlier-looking text without proven ancestry or ingest order.",
                        }
                    ],
                },
                message,
            ]
            message_index = 1
        source_lines.append(json.dumps({"recordType": "thread", "threadId": thread_id, "messages": messages}))
        selected.append(
            {
                "case_id": f"case-{index:03d}",
                "source_row_id": source_id,
                "thread_id": thread_id,
                "source_line": index,
                "message_index": message_index,
                "timestamp": timestamp,
                "cohort": cohort,
                "embargoed": embargoed,
                "stratum": "synthetic-only",
                "cue_flags": ["synthetic-not-a-cue"],
            }
        )
    source = ("\n".join(source_lines) + "\n").encode("utf-8")
    digest = hashlib.sha256(source).hexdigest()
    manifest = {
        "schema": "centurion-pilot250-v1",
        "source_sha256": digest,
        "seed": "synthetic-self-test-seed",
        "selected": selected,
    }
    return source, manifest, cohort_counts


class SyntheticTests(unittest.TestCase):
    def test_shared_private_anchor_requires_owner_only_children(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            repo = Path(temporary)
            root = repo / ".private"
            root.mkdir(mode=0o770)
            os.chmod(root, 0o770)
            child = root / "source"
            child.mkdir(mode=0o700)
            os.chmod(child, 0o700)
            source = child / "synthetic.jsonl"
            source.write_text("synthetic", encoding="utf-8")
            os.chmod(source, 0o600)
            private_root = _private_root(repo)
            self.assertEqual(_private_input_path(str(source), private_root), source.resolve())
            os.chmod(child, 0o770)
            with self.assertRaises(PilotError):
                _private_input_path(str(source), private_root)
            os.chmod(root, 0o777)
            with self.assertRaises(PilotError):
                _private_root(repo)

    def test_privacy_guard_masks_contacts_credentials_payment_and_preserves_safe_context(self) -> None:
        source = (
            "Contact person@example.invalid or +27 82 555 0101. "
            "Password: synthetic-secret.\nCVV: 123.\nCard 4111111111111111. "
            "Booking ref 57291630-1 for 2027-05-12."
        )
        guarded, provenance, safe = guard_text(source)
        self.assertTrue(safe)
        for secret in ("person@example.invalid", "+27 82 555 0101", "synthetic-secret", "4111111111111111"):
            self.assertNotIn(secret, guarded)
        self.assertNotIn("123", guarded)
        self.assertIn("57291630-1", guarded)
        self.assertIn("2027-05-12", guarded)
        self.assertGreaterEqual(provenance.get("emails", 0), 1)
        self.assertGreaterEqual(provenance.get("phones", 0), 1)
        self.assertGreaterEqual(provenance.get("credential_values", 0), 1)
        self.assertGreaterEqual(provenance.get("security_codes", 0), 1)
        self.assertGreaterEqual(provenance.get("card_numbers", 0), 1)

    def test_ordinary_signature_remains_usable(self) -> None:
        source = (
            "Please quote 2 rooms for 2027-05-12.\n\n"
            "Kind regards,\nAmira Taylor\nReservations Team\nLegacy Hotels\n"
            "Email: amira@example.invalid\nTelephone: +27 82 555 0101"
        )
        guarded, provenance, safe = guard_text(source)
        self.assertTrue(safe)
        self.assertEqual(provenance.get("field_withheld", 0), 0)
        self.assertIn("Please quote 2 rooms for 2027-05-12.", guarded)
        self.assertIn("Kind regards,\nAmira Taylor\nReservations Team", guarded)
        self.assertIn("Legacy Hotels", guarded)
        self.assertNotIn("amira@example.invalid", guarded)
        self.assertNotIn("+27 82 555 0101", guarded)
        self.assertGreaterEqual(provenance.get("emails", 0), 1)
        self.assertGreaterEqual(provenance.get("phones", 0), 1)

    def test_split_contact_values_are_partially_withheld_and_remainder_survives(self) -> None:
        source = (
            "Please quote 2 rooms for 2027-05-12.\n"
            "Email:\njane.doe\n@\nexample.invalid\n"
            "Mobile:\n+27\n82\n555\n0101\n"
            "Please confirm the voucher is attached."
        )
        guarded, provenance, safe = guard_text(source)
        self.assertTrue(safe)
        for value in ("jane.doe", "example.invalid", "+27", "82", "555", "0101"):
            self.assertNotIn(value, guarded)
        self.assertEqual(provenance.get("contact_field_boundaries"), 2)
        self.assertEqual(provenance.get("contact_field_lines_withheld"), 9)
        self.assertEqual(guarded.count("[CONTACT FIELD WITHHELD]"), 9)
        self.assertIn("Please quote 2 rooms for 2027-05-12.", guarded)
        self.assertIn("Please confirm the voucher is attached.", guarded)

    def test_partial_contact_withholding_is_visible_in_packet_privacy_and_context_gaps(self) -> None:
        source_bytes, manifest, _expected = _synthetic_fixture()
        item = manifest["selected"][1]
        record = json.loads(source_bytes.splitlines()[item["source_line"] - 1])
        message = record["messages"][item["message_index"]]
        source_row = next(
            row for row in message["sourceRows"] if row["sourceRowId"] == item["source_row_id"]
        )
        source_row["body"] = (
            "Please quote 3 rooms.\nEmail:\nbooking\n@example.invalid\n"
            "Please confirm the voucher."
        )
        original, cleaned = _build_packet_pair(
            item,
            record,
            source_ids={row["source_row_id"] for row in manifest["selected"]},
            thread_ids={row["thread_id"] for row in manifest["selected"]},
        )
        for packet in (original, cleaned):
            self.assertIn(
                "partial_contact_field_label_and_nearby_values_withheld_original_values_unknown",
                packet["input"]["context_gaps"],
            )
            self.assertIn(
                "privacy_guard_partially_withheld_contact_field_region",
                packet["cleaning"]["flags"],
            )
            self.assertGreater(
                packet["cleaning"]["privacy"]["body"].get("contact_field_lines_withheld", 0),
                0,
            )
            self.assertIn("Please quote 3 rooms.", packet["input"]["target"]["body"])
            self.assertIn("Please confirm the voucher.", packet["input"]["target"]["body"])
            self.assertNotIn("booking", packet["input"]["target"]["body"])
            self.assertNotIn("example.invalid", packet["input"]["target"]["body"])

    def test_format_controls_are_removed_before_all_privacy_detectors(self) -> None:
        source = (
            "Email: person\u200b@example.invalid\n"
            "Phone: +27 82 555\u200c0101\n"
            "Password\u2060: synthetic-secret\n"
            "CV\u200dV: 1234\n"
            "Card 4111\u200b1111\u200b1111\u200b1111"
        )
        guarded, provenance, safe = guard_text(source)
        expected_removed = sum(unicodedata.category(char) == "Cf" for char in source)
        self.assertTrue(safe)
        self.assertEqual(provenance.get("unicode_format_controls_removed"), expected_removed)
        for secret in (
            "person@example.invalid",
            "+27 82 5550101",
            "synthetic-secret",
            "1234",
            "4111111111111111",
        ):
            self.assertNotIn(secret, guarded)
        for counter in ("emails", "phones", "credential_values", "security_codes", "card_numbers"):
            self.assertGreaterEqual(provenance.get(counter, 0), 1)

    def test_unsafe_controls_and_surrogates_remain_fail_closed(self) -> None:
        for unsafe in ("\x00", "\ud800"):
            with self.subTest(codepoint=ord(unsafe)):
                guarded, provenance, safe = guard_text("Email: person@example.invalid" + unsafe)
                self.assertFalse(safe)
                self.assertEqual(guarded, "[sensitive content withheld]")
                self.assertEqual(provenance.get("field_withheld"), 1)

    def test_isolated_payment_and_credential_boundaries_remain_fail_closed(self) -> None:
        for label in (
            "Card:",
            "Credit card:",
            "Security code:",
            "Security-code:",
            "CVV:",
            "Password:",
            "API key:",
        ):
            with self.subTest(label=label):
                guarded, provenance, safe = guard_text(f"Please handle the voucher.\n{label}\nsynthetic-value")
                self.assertFalse(safe)
                self.assertEqual(guarded, "[sensitive content withheld]")
                self.assertEqual(provenance.get("ambiguous_sensitive_field_boundary"), 1)

    def test_ambiguous_credential_field_fails_closed(self) -> None:
        guarded, provenance, safe = guard_text("Reference is safe\nPassword:\nsynthetic-secret")
        self.assertFalse(safe)
        self.assertEqual(guarded, "[sensitive content withheld]")
        self.assertEqual(provenance.get("ambiguous_sensitive_field_boundary"), 1)

    def test_room_numbers_compact_dates_and_credential_narrative_survive(self) -> None:
        source = ("Rooms 101 102 103. Arrival date: 20261101. "
                  "Please reset your password before processing the voucher.\nPassword synthetic-secret")
        guarded, _provenance, safe = guard_text(source)
        self.assertTrue(safe)
        self.assertIn("Rooms 101 102 103", guarded)
        self.assertIn("Arrival date: 20261101", guarded)
        self.assertIn("before processing the voucher", guarded)
        self.assertNotIn("synthetic-secret", guarded)

    def test_svg_iframe_and_cid_receipt_clues_remain_unknown_visuals(self) -> None:
        visible, removals, parsed = _visible_text(
            '<svg><text>Voucher</text></svg><iframe src="https://example.invalid/secret"></iframe>'
            '<img src="cid:proof-of-payment-synthetic">'
        )
        self.assertTrue(parsed)
        self.assertIn("Voucher", visible)
        self.assertIn("possible payment proof", visible)
        self.assertIn("bytes unavailable", visible)
        self.assertNotIn("https://example.invalid", visible)
        self.assertGreaterEqual(removals.get("embedded_visuals_not_available", 0), 2)

    def test_html_image_presence_survives_without_attributes_and_urls_are_guarded(self) -> None:
        visible, removals, parsed = _visible_text(
            '<p>Receipt for 2 rooms <a href="https://example.invalid/voucher?token=synthetic-secret">'
            'voucher link</a> <img src="https://example.invalid/image?token=synthetic-secret" '
            'alt="receipt scan"></p>'
        )
        guarded, provenance, safe = guard_text(visible)
        self.assertTrue(parsed and safe)
        self.assertEqual(removals.get("inline_images_not_available"), 1)
        self.assertIn("receipt scan", guarded)
        self.assertIn("inline image", guarded)
        self.assertIn("voucher link", guarded)
        self.assertIn("link destination withheld", guarded)
        self.assertEqual(removals.get("link_destinations_withheld"), 1)
        self.assertNotIn("https://example.invalid", guarded)
        url_guarded, url_provenance, url_safe = guard_text(
            "https://hotel.invalid/lookup?email=person@example.invalid&token=synthetic-secret#access_token=abc"
        )
        self.assertTrue(url_safe)
        self.assertNotIn("person@example.invalid", url_guarded)
        self.assertNotIn("synthetic-secret", url_guarded)
        self.assertNotIn("access_token=abc", url_guarded)
        self.assertGreaterEqual(url_provenance.get("url_parameters_redacted", 0), 2)
        self.assertGreaterEqual(url_provenance.get("url_fragments_redacted", 0), 1)

    def test_cleaning_span_map_preserves_quotes_and_maps_the_guarded_original(self) -> None:
        original = "Please advise on the below.\n----\n> Quote 2 rooms for 2027-05-12.\n"
        cleaned, removals, spans = _clean_decorative_separators(original)
        self.assertEqual(removals["decorative_separator_lines"], 1)
        self.assertIn("> Quote 2 rooms for 2027-05-12.", cleaned)
        self.assertEqual("".join(original[s["original_start"]:s["original_end"]] for s in spans), cleaned)
        for span in spans:
            self.assertEqual(original[span["original_start"]:span["original_end"]],
                             cleaned[span["cleaned_start"]:span["cleaned_end"]])

    def test_only_repeated_nonactionable_boilerplate_is_removed_from_cleaned_arm(self) -> None:
        may_context = ("This confidential notice concerns information exchanged during May and is intended "
                       "only for the recipient; unauthorized distribution is prohibited.")
        self.assertFalse(_is_repeated_nonactionable_boilerplate(may_context))
        source_bytes, manifest, _expected = _synthetic_fixture()
        item = manifest["selected"][1]
        record = json.loads(source_bytes.splitlines()[item["source_line"] - 1])
        message = record["messages"][item["message_index"]]
        source_row = next(
            row for row in message["sourceRows"] if row["sourceRowId"] == item["source_row_id"]
        )
        disclaimer = (
            "This email is confidential and intended only for the addressee; unauthorized copying, "
            "disclosure, or distribution of this message is prohibited."
        )
        booking = (
            "The confidential reservation remains active for two rooms on 2027-05-12; please "
            "confirm booking reference 57291630-1 before arrival."
        )
        proof_of_payment = (
            "The confidential proof-of-payment voucher for invoice 57291630-1 is attached; "
            "please verify the remittance before posting the account."
        )
        multi_stay = (
            "The confidential multi-stay request asks us to create separate reservations for "
            "the first and second stays, with distinct arrival and departure dates."
        )
        group_rate = (
            "The confidential group booking needs a negotiated rate quote for the conference "
            "block; please confirm the applicable package for these guests."
        )
        original_body = "\n".join(
            [
                disclaimer,
                disclaimer,
                booking,
                booking,
                proof_of_payment,
                proof_of_payment,
                multi_stay,
                multi_stay,
                group_rate,
                group_rate,
            ]
        ) + "\n"
        source_row["body"] = original_body

        guarded_original, cleaned_packet = _build_packet_pair(
            item,
            record,
            source_ids={row["source_row_id"] for row in manifest["selected"]},
            thread_ids={row["thread_id"] for row in manifest["selected"]},
        )
        guarded_body = guarded_original["input"]["target"]["body"]
        cleaned_body = cleaned_packet["input"]["target"]["body"]
        self.assertEqual(guarded_body, original_body)
        self.assertEqual(guarded_body.count(disclaimer), 2)
        self.assertEqual(cleaned_body.count(disclaimer), 1)
        self.assertEqual(guarded_original["cleaning"]["version"], CLEANING_VERSION)
        self.assertEqual(cleaned_packet["cleaning"]["version"], CLEANING_VERSION)
        for action_line in (booking, proof_of_payment, multi_stay, group_rate):
            self.assertEqual(cleaned_body.count(action_line), 2)

        guarded_removals = guarded_original["cleaning"]["removals"]
        cleaned_removals = cleaned_packet["cleaning"]["removals"]
        self.assertEqual(guarded_removals["repeated_nonactionable_boilerplate_lines_removed"], 0)
        self.assertEqual(cleaned_removals["repeated_nonactionable_boilerplate_lines_removed"], 1)
        self.assertEqual(
            cleaned_removals["repeated_nonactionable_boilerplate_characters_removed"],
            len(disclaimer) + 1,
        )
        omission_gap = "cleaned_variant_omits_repeated_nonactionable_boilerplate_lines"
        self.assertNotIn(omission_gap, guarded_original["input"]["context_gaps"])
        self.assertIn(omission_gap, cleaned_packet["input"]["context_gaps"])
        omission_flag = "cleaned_variant_removed_repeated_nonactionable_boilerplate_lines"
        self.assertNotIn(omission_flag, guarded_original["cleaning"]["flags"])
        self.assertIn(omission_flag, cleaned_packet["cleaning"]["flags"])

        spans = cleaned_packet["cleaning"]["provenance"]["guarded_original_to_output_spans"]
        self.assertEqual(
            "".join(guarded_body[span["original_start"]:span["original_end"]] for span in spans),
            cleaned_body,
        )
        for span in spans:
            self.assertEqual(
                guarded_body[span["original_start"]:span["original_end"]],
                cleaned_body[span["cleaned_start"]:span["cleaned_end"]],
            )

    def test_source_fingerprint_and_exact_row_thread_index_are_required(self) -> None:
        source_bytes, manifest, expected = _synthetic_fixture()
        with tempfile.TemporaryDirectory() as temporary:
            source_path = Path(temporary) / "synthetic.jsonl"
            source_path.write_bytes(source_bytes)
            digest = manifest["source_sha256"]
            prepared, _ = prepare_packets(
                source_path,
                manifest,
                expected_source_sha256=digest,
                expected_seed=manifest["seed"],
                expected_counts=expected,
            )
            self.assertEqual(sum(map(len, prepared.values())), 3)
            tampered_source = Path(temporary) / "tampered.jsonl"
            tampered_source.write_bytes(source_bytes.replace(b'"thread"', b'"other"', 1))
            with self.assertRaises(PilotError):
                prepare_packets(
                    tampered_source,
                    manifest,
                    expected_source_sha256=digest,
                    expected_seed=manifest["seed"],
                    expected_counts=expected,
                )
            for field, bad_value in (
                ("source_row_id", "SYNTHETIC_WRONG_ROW_ID"),
                ("thread_id", "SYNTHETIC_WRONG_THREAD_ID"),
                ("message_index", 0),
                ("timestamp", "2026-01-01T00:00:00Z"),
            ):
                wrong_manifest = json.loads(json.dumps(manifest))
                wrong_manifest["selected"][0][field] = bad_value
                with self.assertRaises(PilotError):
                    prepare_packets(
                        source_path,
                        wrong_manifest,
                        expected_source_sha256=digest,
                        expected_seed=manifest["seed"],
                        expected_counts=expected,
                    )
            unsafe_case_id = json.loads(json.dumps(manifest))
            unsafe_case_id["selected"][0]["case_id"] = "0825550101"
            with self.assertRaises(PilotError):
                prepare_packets(
                    source_path,
                    unsafe_case_id,
                    expected_source_sha256=digest,
                    expected_seed=manifest["seed"],
                    expected_counts=expected,
                )

    def test_default_excludes_holdout_and_embargoed_and_opt_ins_are_separate(self) -> None:
        source_bytes, manifest, expected = _synthetic_fixture()
        with tempfile.TemporaryDirectory() as temporary:
            source_path = Path(temporary) / "synthetic.jsonl"
            source_path.write_bytes(source_bytes)
            digest = manifest["source_sha256"]

            def count(include_holdout: bool, include_embargoed: bool) -> int:
                prepared, _ = prepare_packets(
                    source_path,
                    manifest,
                    expected_source_sha256=digest,
                    expected_seed=manifest["seed"],
                    expected_counts=expected,
                    include_holdout=include_holdout,
                    include_embargoed=include_embargoed,
                )
                return sum(map(len, prepared.values()))

            self.assertEqual(count(False, False), 3)
            self.assertEqual(count(True, False), 4)
            self.assertEqual(count(False, True), 4)
            self.assertEqual(count(True, True), 5)

    def test_packets_are_cohort_separated_private_and_omit_source_metadata(self) -> None:
        source_bytes, manifest, expected = _synthetic_fixture()
        with tempfile.TemporaryDirectory() as temporary:
            parent = Path(temporary)
            os.chmod(parent, 0o700)
            source_path = parent / "synthetic.jsonl"
            source_path.write_bytes(source_bytes)
            digest = manifest["source_sha256"]
            prepared, _ = prepare_packets(
                source_path,
                manifest,
                expected_source_sha256=digest,
                expected_seed=manifest["seed"],
                expected_counts=expected,
            )
            output = parent / "packets"
            write_packets(output, prepared)
            self.assertEqual(stat.S_IMODE(output.stat().st_mode), 0o700)
            self.assertFalse((output / "random_holdout").exists())
            for cohort in ("random_development", "targeted_development"):
                cohort_dir = output / cohort
                self.assertEqual(stat.S_IMODE(cohort_dir.stat().st_mode), 0o700)
                for filename in ("original.jsonl", "cleaned.jsonl"):
                    path = cohort_dir / filename
                    self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
                    records = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]
                    self.assertTrue(records)
                    serialized = json.dumps(records, ensure_ascii=False)
                    for item in manifest["selected"]:
                        self.assertNotIn(item["source_row_id"], serialized)
                        self.assertNotIn(item["thread_id"], serialized)
                    self.assertNotIn("synthetic-only", serialized)
                    self.assertNotIn("synthetic-not-a-cue", serialized)
                    self.assertNotIn("SYNTHETIC_UNVERIFIED_PRIOR_ROW", serialized)
                    self.assertNotIn("earlier-looking text without proven ancestry", serialized)
                    for cohort_name in COHORTS:
                        self.assertNotIn(cohort_name, serialized)
                    target = records[0]["input"]["target"]
                    self.assertEqual(target["attachment_inventory"], "unknown")
                    self.assertEqual(target["attachments"], "unknown")
                    self.assertEqual(records[0]["input"]["prior_messages"], [])
                    self.assertTrue(any("prior_messages_not_added" in gap for gap in records[0]["input"]["context_gaps"]))
                    self.assertNotIn("person@example.invalid", serialized)
                    self.assertNotIn("synthetic-secret", serialized)
                    self.assertNotIn("4111111111111111", serialized)
                    self.assertIn("Please quote 2 rooms", serialized)
                    self.assertIn("2027-05-12", serialized)
                    self.assertIn("57291630-1", serialized)
            with self.assertRaises(PilotError):
                write_packets(output, prepared)


def run_self_tests() -> int:
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(SyntheticTests)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    raise SystemExit(main())
