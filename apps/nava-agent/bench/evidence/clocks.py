"""Two clocks + ingestion. eventAt / availableAt / capturedAt; preserve unknown."""
from __future__ import annotations

from datetime import date, datetime, timezone
from zoneinfo import ZoneInfo

from .schema import PROPERTY_TZ, Precision

_JHB = ZoneInfo(PROPERTY_TZ)


def _parse_raw(value: object) -> datetime | date | None:
    if value is None:
        return None
    if isinstance(value, (int, float)):
        # refuse epoch guess without unit evidence
        return None
    s = str(value).strip()
    if not s or s.lower() in {"null", "none", "undefined"}:
        return None
    if len(s) == 10 and s[4] == "-" and s[7] == "-":
        try:
            return date.fromisoformat(s)
        except ValueError:
            return None
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    try:
        return datetime.fromisoformat(s)
    except ValueError:
        return None


def classify_precision(value: object) -> Precision:
    parsed = _parse_raw(value)
    if parsed is None:
        return "unknown"
    if isinstance(parsed, date) and not isinstance(parsed, datetime):
        return "date"
    if isinstance(parsed, datetime):
        # midnight with no offset often date-only export; keep as instant if tz/time present
        if parsed.tzinfo is None and parsed.hour == 0 and parsed.minute == 0 and parsed.second == 0 and parsed.microsecond == 0:
            # ambiguous: could be date-only stored as datetime
            return "date"
        return "instant"
    return "unknown"


def to_iso(value: object) -> str | None:
    parsed = _parse_raw(value)
    if parsed is None:
        return None
    if isinstance(parsed, datetime):
        if parsed.tzinfo is None:
            # preserve naive; annotate via precision, do not invent offset
            return parsed.isoformat(timespec="seconds")
        return parsed.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    return parsed.isoformat()


def resolve_clocks(
    *,
    event_at: object = None,
    available_at: object = None,
    captured_at: object = None,
    fallback_event: object = None,
) -> dict[str, str | None | Precision]:
    """Return two clocks + capture. Unknown stays null; no invented availability."""
    event_raw = event_at if event_at not in (None, "") else fallback_event
    event = to_iso(event_raw)
    available = to_iso(available_at) if available_at not in (None, "") else None
    captured = to_iso(captured_at) if captured_at not in (None, "") else None
    precision = classify_precision(event_raw)
    # date-only cannot establish intraday order
    if precision == "date" and available and classify_precision(available_at) == "instant":
        # keep availableAt but callers must not use for intraday precedence vs date event
        pass
    return {
        "eventAt": event,
        "availableAt": available,
        "capturedAt": captured,
        "precision": precision,
        "propertyTz": PROPERTY_TZ,
    }


def jhb_date(iso: str | None) -> str | None:
    if not iso:
        return None
    parsed = _parse_raw(iso)
    if parsed is None:
        return None
    if isinstance(parsed, datetime):
        if parsed.tzinfo is None:
            return parsed.date().isoformat()
        return parsed.astimezone(_JHB).date().isoformat()
    return parsed.isoformat()
