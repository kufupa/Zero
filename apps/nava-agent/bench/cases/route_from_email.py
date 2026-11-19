"""Deterministic triage-table router for halloween/other gold (mirrors triage/SKILL.md)."""
from __future__ import annotations

import re


def route_from_email(subject: str | None, body: str | None) -> str:
    text = f"{subject or ''}\n{body or ''}".lower()

    # Filing first: voucher / POP as primary ask
    if re.search(r"\b(proof of payment|pop\b|voucher|payment confirmation)\b", text):
        if re.search(
            r"\b(attach\w*|find attached|please find|submitted|herewith|"
            r"receive (the )?voucher|may you please receive)\b",
            text,
        ) or re.search(r"\.(pdf)\b", text):
            return "filing"

    # Cancel: cancel wording + confirmation/booking ref (incl. fee/policy/refund asks).
    if re.search(
        r"\b(cancel|cancellation|cancelation|please cancel|kindly cancel|"
        r"release (the )?(booking|reservation)|cancellation (fee|policy|refund))\b",
        text,
    ) and (
        re.search(r"\b\d{6,10}-1\b", text)
        or re.search(r"\bn[°º]\s*\d{6,10}", text)
        or re.search(r"\b(reservation|booking|confirmation|stay)\b", text)
    ):
        return "cancel"

    # Amend: date/room change, extend, add rooms to existing, rooming-list update
    if re.search(
        r"\b(amend|change (the )?(dates?|departure|arrival)|shorten|"
        r"extend (my |the )?stay|arrive one day earlier|move (the )?booking|"
        r"add one more room|updated (semi )?rooming list|rooming list)\b",
        text,
    ):
        return "amend"

    # Create: book/reserve / room+dates / invoice-for-new-booking
    if re.search(
        r"\b(kindly (book|reserve)|please book|make (a |the following )?reservations?|"
        r"reservation request|booking request|reserve accommodation|"
        r"book accommodation|book the following|"
        r"would like to make a reservation|"
        r"assist (me )?with (an? )?(booking|reservation|invoice for .{0,40}booking)|"
        r"assist (me )?with (an? )?(standard |twin |queen |king |deluxe |single |double )?rooms?|"
        r"pro-?forma invoice with a reservation|"
        r"please confirm as per below|"
        r"rooms? for .{0,40}\d{1,2}\s*(aug|sep|oct|nov|dec|jan|feb|mar|apr|may|jun|jul))\b",
        text,
    ):
        return "create"
    if re.search(r"\b(book|reserve)\b", text) and re.search(
        r"\b(check[- ]?in|arrival|guest|room|accommodation)\b", text
    ):
        return "create"
    if (
        re.search(r"\b(name|guest)\s*:", text)
        and re.search(r"\b(date|check[- ]?in|in:)\b", text)
        and re.search(r"\b(room|b&b|bed and breakfast)\b", text)
        and not re.search(r"\b(cancel|scam)\b", text)
    ):
        return "create"
    if (
        re.search(r"\b(looking for accommodation|need dinner, bed and breakfast)\b", text)
        and re.search(r"\b(pro-?forma|reservation|dates required)\b", text)
    ):
        return "create"
    if (
        re.search(r"\b(check[- ]?in|check[- ]?out|arrival|departure)\b", text)
        and re.search(r"\b(guest|room|accommodation|reservation)\b", text)
        and re.search(
            r"\b\d{1,2}\s*(aug|sep|oct|nov|dec|jan|feb|mar|apr|may|jun|jul|"
            r"september|october|august|december)\b",
            text,
        )
        and not re.search(r"\b(cancel|scam|booking\.com)\b", text)
    ):
        return "create"

    # Quote: price/availability without book/proceed/accept
    if re.search(
        r"\b(quote|quotation|rate for|best (concessional )?rate|availability|"
        r"corporate rate|government rate|how much|price for|what (is|are) the rates?|"
        r"wheelchair accessible|looking for a room)\b",
        text,
    ) and not re.search(
        r"\b(please book|kindly book|reserve|proceed|accept(ed)? (the )?(offer|quote|quotation)|"
        r"make (a )?reservation|confirm (the )?booking)\b",
        text,
    ):
        return "quote"

    # True triage / other: status, confirmation emails, invoice-only, OTA chatter
    if re.search(
        r"\b(reconfirmation|confirmation (number|status|of bookings)|"
        r"have you (sent|received)|invoice|payment link|commissionable|"
        r"booking\.com|overflow|status of|scam|complementary|anniversary)\b",
        text,
    ):
        return "triage"
    return "triage"
