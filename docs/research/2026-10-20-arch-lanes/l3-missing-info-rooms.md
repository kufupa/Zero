# L3 — What staff ask for, and room / board / rate selection

## Answer

All measurements use the local corpus window 2026-07-30T18:30:59Z–2026-10-13T17:54:13Z UTC. Appendix S1 generates every count below.

- Detector found 79/3,151 candidate staff clarification messages (2.5% of own-domain outbound visible-text messages). Payment/guarantee was the largest tag: 33/79 (41.8%); dates/nights 12/79 (15.2%); dinner/board 8/79 (10.1%). Tags overlap.
- Exact ask→letter join found 82/1,179 confirmation-letter PDFs from 43 unique inbound asks. This is a narrow, descriptive sample.
- The extractor’s “single” roomType mapped to Standard Queen on 6/12 linked PDFs and Standard Twin on 5/12; 1/12 unparsed, Deluxe 0/12. Literal ask text rarely named room type: single 2/43 asks, double 1/43, twin 0/43, sharing 0/43. (inference) Do not silently turn “single” into a bed type.
- Across letters, most common parsed ADR/board pair was ZAR 1,700 DBB on 367/1,130 letters with both fields parsed. No explicit rate-code/plan/type label was found in 0/1,179 letters.
- Seven/43 unique linked asks mentioned government/Govt; their 22/82 letter PDFs returned ZAR 1,700 DBB on 19/22 and ZAR 1,420 B&B on 3/22. (inference) This is a text association, not proof of a government rate plan.
- Explicit Agency/Company header line appeared on 39/1,179 letters. In the linked set, 5/10 Agency-labelled lines exactly matched the ask’s normalized agency extraction.
- Exact dinner-allowance/add-on language appeared in 16/4,772 inbound and 3/3,151 outbound visible-text messages. Broader dinner/DBB mention appeared in 337/4,772 inbound and 39/3,151 outbound.

## Method

- Read-only, local corpus only. No network, production SQL, HMS, or git changes.
- Sources: [messages.jsonl.gz](/home/orca/nava-research/corpus/2026-10-13/messages.jsonl.gz), [extractions.jsonl.gz](/home/orca/nava-research/corpus/2026-10-13/extractions.jsonl.gz), [attachments.jsonl.gz](/home/orca/nava-research/corpus/2026-10-13/attachments.jsonl.gz), [staff_pdfs.tsv](/home/orca/nava-research/corpus/2026-10-13/staff_pdfs.tsv), and the matching [pdftxt directory](/home/orca/nava-research/corpus/2026-10-13/pdftxt/).
- Window comes from message event timestamps. S1 validates all 2,162/2,162 staff-PDF manifest rows against text, attachment ID, and message ID.
- Clarification detector: own-domain outbound text with a question/request signal; paired to latest earlier external, non-channel inbound in the same thread. Inbound had booking/quote extraction kind or explicit quote/availability/reservation language. Family tags are keyword rules, non-exclusive; not human labels.
- Letter join: confirmation-letter PDF linked by exact requested arrival/departure dates. Join is same-thread when possible; otherwise same recipient plus preceding staff text reply within one day. The nearest qualifying reply wins. Exact dates and recipient reduce false joins but do not prove causality.
- Tables count outbound messages, inbound messages, or PDF documents as named. Multiple letters can follow one inbound ask. All tables use the corpus window above and Appendix S1 command below. No names, emails, phone numbers, raw bodies, or IDs are printed.
- Research route: local. No web, Exa, or subagents used. Model-cost telemetry is not available in this session.

## Findings

### Clarification replies and inbound missing fields

Window: 2026-07-30T18:30:59Z–2026-10-13T17:54:13Z · generator: S1.

| Staff ask family | Candidate replies and share | Latest successful extraction for paired inbound |
|---|---:|---|
| Guest names | 1/79 (1.3%) | 1/1 available; schema has contact.name, not a per-guest name list. Direct guest-list null test unavailable. |
| Child ages | 1/79 (1.3%) | 1/1 available; childAges null/empty. |
| Room / occupancy | 5/79 (6.3%) | 3/5 available; 3/3 had at least one null/empty rooms, adultsPerRoom, or roomType field; 2/5 had no extraction. |
| Dinner / board | 8/79 (10.1%) | 3/8 available; board null/empty in 2/3 and populated in 1/3; 5/8 had no extraction. |
| Dates / nights | 12/79 (15.2%) | 8/12 available; requested dates null/empty in 1/8 and populated in 7/8; 4/12 had no extraction. payload.missing[] also named dates in 1/8. |
| Company / billing / VAT | 3/79 (3.8%) | 2/3 available; agency/endClient populated in 2/2. VAT/billing has no dedicated field; 1/3 had no extraction. |
| ID / passport | 0/79 (0.0%) | No detected ask; schema has no ID/passport field. |
| Payment / guarantee | 33/79 (41.8%) | 24/33 available, but schema has no payment/guarantee field; 9/33 had no extraction. |
| Arrival time | 0/79 (0.0%) | No detected ask; schema has no arrival-time field. |
| Other | 30/79 (38.0%) | 20/30 available; no single field mapping; 10/30 had no extraction. |

Of 79/79 candidate replies, 13/79 had tags from multiple families. payload.missing[] exposed the date gap in 1/8 extracted date asks, but did not name the direct room/board nulls above. Null tests inspect stays.requested and rows; contact.name is not treated as guest names.

### Ask wording versus resulting room

Window: 2026-07-30T18:30:59Z–2026-10-13T17:54:13Z · generator: S1.

| Join evidence | Result |
|---|---|
| Linked confirmation-letter PDFs | 82/1,179; 2/82 same-thread, 80/82 same-recipient plus exact dates and prior staff text within one day. |
| Unique inbound asks represented | 43/82 linked PDFs. The other linked PDFs repeat an ask across multiple letters. |
| Cross-thread reply timing | 51/80 within 15 minutes; 75/80 within one hour; 77/80 within six hours; 80/80 within one day. |
| Literal ask text terms in unique linked inbounds | single 2/43; double 1/43; twin 0/43; sharing 0/43. |

The next table uses extracted rows[].roomType, keyword-normalized; it is not verbatim ask wording. Counts are linked letter PDFs, not unique asks.

| Extracted request roomType group | PDFs in group | HMS letter Accommodation Type |
|---|---:|---|
| Single | 12/82 | Standard Queen 6/12; Standard Twin 5/12; unparsed 1/12; Deluxe 0/12. |
| Double | 3/82 | Standard Twin 2/3; Standard Queen 1/3; Deluxe 0/3. |
| Twin | 1/82 | Standard Twin 1/1. |
| Queen | 5/82 | Standard Queen 5/5. |
| Generic Standard | 19/82 | Standard Twin 17/19; Standard Queen 2/19. |
| No room type | 42/82 | Standard Twin 25/42; Standard Queen 16/42; Standard King 1/42. |

Across the linked sample, Deluxe appeared on 0/82 PDFs. Whole-letter baseline: Standard Queen 554/1,166 parsed room types; Standard Twin 369/1,166; Deluxe Twin 71/1,166.

Letter Number of Persons compared with extracted adultsPerRoom:

| Extracted ask occupancy rows | Linked PDFs | Letter persons result |
|---|---:|---|
| One row: 1 adult/room | 57/82 | 1 adult on 56/57; unparsed on 1/57. |
| Two rows, each 1 adult/room | 15/82 | 1 adult on 15/15. |
| One row: 2 adults/room | 5/82 | 2 adults on 5/5. |
| Adults not captured | 5/82 | 2 adults on 3/5; 1 adult on 2/5. |

Arrival-month mix is letter stay month, not email month:

| Letter arrival month | Linked PDFs | Letter room types |
|---|---:|---|
| 2026-09 | 7/82 | Standard Twin 4/7; Standard Queen 3/7. |
| 2026-10 | 71/82 | Standard Twin 46/71; Standard Queen 23/71; Standard King 1/71; unparsed 1/71. |
| 2026-11 | 4/82 | Standard Queen 4/4. |

### Board, ADR, government, and dinner

Window: 2026-07-30T18:30:59Z–2026-10-13T17:54:13Z · generator: S1.

Letter fields parsed: Average Daily rate on 1,144/1,179; Rate Includes board on 1,160/1,179; both on 1,130/1,179. Of parsed board fields, B&B was 750/1,160 and DBB 410/1,160; 19/1,179 were unparsed.

B&B means Rate Includes contained breakfast; DBB means it contained both dinner and breakfast.

| Most common exact ADR + board | Letters with both fields parsed |
|---|---:|
| ZAR 1,700 + DBB | 367/1,130 |
| ZAR 1,560 + B&B | 150/1,130 |
| ZAR 1,420 + B&B | 74/1,130 |
| ZAR 1,360 + B&B | 69/1,130 |
| ZAR 1,449 + B&B | 33/1,130 |
| ZAR 1,940 + B&B | 23/1,130 |

No explicit Rate Code, Rate Plan, or Rate Type label appeared in 0/1,179 confirmation letters. The ADR/board pair cannot establish BAR versus government pricing.

Linked ask extraction board versus letter Rate Includes board; PDF denominator is 82:

| Ask board extraction | Letter board result |
|---|---|
| DBB | DBB 29/35; B&B 6/35. |
| B&B | B&B 27/29; DBB 2/29. |
| Null | B&B 11/14; DBB 3/14. |
| Mixed BB/DBB rows | B&B 2/3; DBB 1/3. |
| No rows | B&B 1/1. |

Government/Govt word detector: 7/43 unique linked asks; those asks map to 22/82 PDFs. Outcomes: ZAR 1,700 DBB 19/22; ZAR 1,420 B&B 3/22. (inference) The repeated pattern is worth surfacing to staff, but the word may be incidental and the letter does not expose rate-plan identity.

Dinner language in eligible visible, nonquoted text; phrase categories can overlap, combined row counts distinct messages:

| Direction | Dinner allowance | Meal allowance | Dinner add-on / supplement / charge / extra | “Add dinner” | Any exact allowance/add-on phrase | Broad dinner/DBB mention |
|---|---:|---:|---:|---:|---:|---:|
| Inbound | 4/4,772 | 0/4,772 | 5/4,772 | 7/4,772 | 16/4,772 | 337/4,772 |
| Outbound | 1/3,151 | 0/3,151 | 0/3,151 | 2/3,151 | 3/3,151 | 39/3,151 |

### Header party line

Window: 2026-07-30T18:30:59Z–2026-10-13T17:54:13Z · generator: S1.

| Measure | Result |
|---|---:|
| Explicit Agency line in header before salutation | 31/1,179 PDFs. |
| Explicit Company line in header before salutation | 8/1,179 PDFs. |
| Either explicit line | 39/1,179 PDFs. |
| Linked PDFs with Agency line | 10/82; Company line 0/82. |
| Agency line had nonempty ask agency extraction | 10/10. |
| Exact normalized agency extraction match on that line | 5/10. |

“Present” means an explicit Agency/Company-style label before the salutation. Free-text organization lines were not guessed. A non-match can mean abbreviation/code, extraction difference, or mismatch; these data do not separate them.

## What this means for the agent/pane

- (inference) Keep requested roomType, adultsPerRoom, child ages, HMS Accommodation Type, and Number of Persons as separate fields. “Single” does not predict Queen versus Twin.
- (inference) Ask before defaulting dates, occupancy, room type/sharing, or board when current inbound text and extraction leave them unresolved. Direct nulls appeared in 3/3 extracted room-clarification inbounds and 2/3 extracted board-clarification inbounds.
- (inference) Show Rate Includes and ADR as observed. Do not label a result BAR or a government rate unless a tool-backed rate-plan field says so.
- (inference) Add explicit fields for per-guest names, billing/VAT, payment/guarantee, and arrival time if the workflow needs them; current extraction cannot verify several of these.
- (inference) Pane order: stay dates/nights → rooms, sharing, adults and child ages → board/dinner → agency/company and billing → payment/guarantee and arrival/ID only when needed. Keep assumptions visible for staff approval before the HMS write.

## Open gaps

- Clarification families are regex candidates, not human-adjudicated labels. 79/3,151 is a lower-quality detector result, not the full rate of staff clarification.
- The letter join covers 82/1,179 PDFs and 43 unique inbound asks. Same recipient plus matching stay dates and nearest prior text reply can still collide with another booking.
- roomType/board values come from the extraction payload, not a verbatim, human-verified ask annotation. Repeated letter PDFs can weight one ask more than once.
- No rate-plan label means BAR versus government cannot be proven from the letters. Government text may refer to something other than the requested rate.
- Sold-out detector found 0/43 linked asks; the letters expose no availability/sold-out field. No sale-out history was queried.
- 95 threshold: met for reproducible counts and parsed letter fields; not met for a universal room, board, or rate default. The linked cohort is small and labels are heuristic.
- Route: local-only. No external research spend or worker calls; model-cost telemetry unavailable.

## Appendix (scripts)

S1 is the exact Python script run with: python3 - <<'PY' followed by this body and PY. It prints aggregates only; it does not print message bodies or identifiers.

```python
import bisect
import collections
import csv
import datetime as dt
import gzip
import html
import json
import os
import re
import unicodedata

BASE = "/home/orca/nava-research/corpus/2026-10-13"
OWN = {"legacyhotels.co.za", "legacyhotels.com"}
CHANNEL_PARTS = (
    "synxis", "booking.com", "expedia", "webbeds", "hotelbeds",
    "profitroom", "siteminder", "ratetiger", "tiket",
)

def read_gz(name):
    with gzip.open(os.path.join(BASE, name), "rt", encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]

def addresses(value):
    values = value if isinstance(value, list) else [value]
    found = set()
    for value in values:
        if not isinstance(value, str):
            continue
        match = re.search(r"[\w.+-]+@[\w.-]+", value.lower())
        if match:
            found.add(match.group(0))
    return found

def domain(address):
    return address.rsplit("@", 1)[-1] if "@" in address else ""

def is_own(message):
    return any(domain(a) in OWN for a in addresses(message.get("from_address")))

def is_channel(message):
    return any(
        any(part in domain(a) for part in CHANNEL_PARTS)
        for a in addresses(message.get("from_address"))
    )

def plain_body(message):
    body = message.get("body") or ""
    if message.get("body_is_html"):
        body = re.sub(r"(?is)<(script|style).*?>.*?</\1>", " ", body)
        body = re.sub(r"(?i)<br\s*/?>|</p>|</div>|</li>", "\n", body)
        body = html.unescape(re.sub(r"(?s)<[^>]*>", " ", body))
    body = body.replace("\r", "\n")
    cut_positions = []
    for pattern in (
        r"(?im)^\s*-{2,}\s*original message\s*-{2,}",
        r"(?im)^\s*from:\s",
        r"(?im)^\s*on .{0,100}wrote:\s*$",
        r"(?im)^\s*>",
    ):
        match = re.search(pattern, body)
        if match:
            cut_positions.append(match.start())
    if cut_positions:
        body = body[:min(cut_positions)]
    return re.sub(r"\s+", " ", body).strip().lower()

def parse_date(value):
    if not value:
        return None
    value = str(value).strip()
    for fmt in (
        "%Y-%m-%d", "%Y/%m/%d", "%d-%m-%Y", "%d/%m/%Y",
        "%d.%m.%Y", "%d %b %Y", "%d %B %Y", "%B %d, %Y", "%b %d, %Y",
    ):
        try:
            return dt.datetime.strptime(value, fmt).date()
        except ValueError:
            pass
    match = re.search(r"\b(\d{1,2})[-/](\d{1,2})[-/](\d{4})\b", value)
    if match:
        a, b, year = map(int, match.groups())
        for day, month in ((a, b), (b, a)):
            try:
                return dt.date(year, month, day)
            except ValueError:
                pass
    return None

def empty(value):
    return value is None or value == "" or value == []

def pct(n, d):
    return 0.0 if not d else round(100 * n / d, 1)

def normalized_entity(value):
    value = unicodedata.normalize("NFKD", str(value))
    value = value.encode("ascii", "ignore").decode().lower()
    value = re.sub(r"\b(proprietary|pty|limited|ltd|cc|inc|npc|soc|sa)\b", " ", value)
    return re.sub(r"[^a-z0-9]", "", value)

messages = read_gz("messages.jsonl.gz")
by_id = {m["id"]: m for m in messages}
event_times = [m.get("sent_at") or m.get("received_at") or "" for m in messages]
window_start = min(event_times)
window_end = max(event_times)
body_cache = {}

def body(message):
    message_id = message["id"]
    if message_id not in body_cache:
        body_cache[message_id] = plain_body(message)
    return body_cache[message_id]

extractions = read_gz("extractions.jsonl.gz")
latest = {}
for extraction in extractions:
    if extraction.get("status") != "succeeded":
        continue
    old = latest.get(extraction["message_id"])
    if old is None or (extraction.get("created_at") or "") > (old.get("created_at") or ""):
        latest[extraction["message_id"]] = extraction

def payload_for(message_id):
    return (latest.get(message_id) or {}).get("payload") or {}

date_pairs_cache = {}

def requested_date_pairs(message_id):
    if message_id in date_pairs_cache:
        return date_pairs_cache[message_id]
    pairs = set()
    for stay in payload_for(message_id).get("stays") or []:
        if not isinstance(stay, dict):
            continue
        requested = stay.get("requested") or {}
        arrival = parse_date(requested.get("arrival"))
        departure = parse_date(requested.get("departure"))
        if arrival and departure:
            pairs.add((arrival, departure))
    date_pairs_cache[message_id] = pairs
    return pairs

threads = collections.defaultdict(list)
for index, message in enumerate(messages):
    event_time = message.get("sent_at") or message.get("received_at") or ""
    threads[message.get("thread_id")].append((event_time, index, message))
for rows in threads.values():
    rows.sort(key=lambda row: (row[0], row[1]))

# Candidate staff clarification replies: an ask signal in own-domain text,
# paired to the latest earlier non-own, non-channel inbound in the same thread.
family_patterns = {
    "guest names": r"\b(?:guest|travell?er|occupant|passenger)\s+names?\b|\bnames?\s+of\s+(?:all\s+)?(?:the\s+)?(?:guests?|travell?ers?|occupants?|passengers?)\b|\bfull\s+names?\b|\bnames?\s+(?:for|per)\s+(?:each\s+)?(?:guest|room|person)\b",
    "child ages": r"\bchild(?:ren)?\b.{0,40}\bages?\b|\bages?\s+of\s+(?:the\s+)?(?:child(?:ren)?|kids?|infants?)\b|\bhow\s+old\s+(?:is|are)\b",
    "room/occupancy": r"\b(?:single|double|twin|sharing|share\s+a\s+room|room\s+type|rooming\s+list|occupanc\w*|adults?\s+per\s+room|number\s+of\s+rooms?|how\s+many\s+rooms?|rooms?\s+for|bed\s+type)\b",
    "dinner/board": r"\b(?:dinner|breakfast|lunch|half\s*[- ]?board|full\s*[- ]?board|bed\s*(?:and|&)\s*breakfast|dbb|bb|meal\s+(?:plan|allowance|basis))\b",
    "dates/nights": r"\b(?:arrival|departure|check\s*[- ]?in|check\s*[- ]?out|dates?|night(?:s)?|from\s+\w.{0,20}\s+to\s+\w|what\s+date)\b",
    "company/billing/VAT": r"\b(?:company|agency|corporate|billing|bill\s+to|invoice\s+to|vat|tax\s+number|account\s+name)\b",
    "ID/passport": r"\b(?:passport|identity\s+document|id\s+(?:copy|number|document)|identification)\b",
    "payment/guarantee": r"\b(?:payment\s+method|method\s+of\s+payment|payment|pay|guarantee|credit\s+card|card\s+details|deposit|prepay|proof\s+of\s+payment|pop)\b",
    "arrival time": r"\b(?:arrival\s+time|time\s+of\s+arrival|eta|estimated\s+time\s+of\s+arrival|check\s*[- ]?in\s+time|flight\s+details)\b",
}
family_patterns = {k: re.compile(v, re.I) for k, v in family_patterns.items()}
ask_signal = re.compile(
    r"\?|"
    r"\b(?:please\s+(?:advise|confirm|provide|share|let\s+us\s+know)|"
    r"kindly\s+(?:advise|confirm|provide|share)|can\s+you|could\s+you|"
    r"would\s+you|may\s+i|please\s+let\s+me\s+know|let\s+me\s+know)\b",
    re.I,
)
new_request = re.compile(
    r"\b(?:quote|quotation|availability|book(?:ing)?\s+(?:a\s+)?"
    r"(?:room|stay|accommodation)|reserve|reservation)\b",
    re.I,
)
clarifications = []
for thread_rows in threads.values():
    earlier_inbounds = []
    for event_time, _, message in thread_rows:
        if message.get("direction") == "inbound" and not is_own(message) and not is_channel(message):
            earlier_inbounds.append((event_time, message))
        elif message.get("direction") == "outbound" and is_own(message):
            outbound_text = body(message)
            if len(outbound_text) < 8 or not ask_signal.search(outbound_text):
                continue
            prior = [(t, m) for t, m in earlier_inbounds if t <= event_time]
            if not prior:
                continue
            inbound = prior[-1][1]
            extraction = latest.get(inbound["id"])
            inbound_text = ((inbound.get("subject") or "") + " " + body(inbound)).lower()
            kind = (extraction or {}).get("kind")
            if kind not in ("booking", "quote") and not new_request.search(inbound_text):
                continue
            tags = [k for k, pattern in family_patterns.items() if pattern.search(outbound_text)]
            if not tags:
                tags = ["other"]
            clarifications.append({
                "out": message, "in": inbound, "extraction": extraction,
                "tags": tags, "intext": inbound_text,
            })

def missing_labels(extraction):
    return [
        str(item.get("field", "")).lower()
        for item in ((extraction or {}).get("payload") or {}).get("missing") or []
        if isinstance(item, dict)
    ]

def null_state(row, family):
    extraction = row["extraction"]
    if not extraction:
        return "no extraction"
    payload = extraction.get("payload") or {}
    stays = payload.get("stays") or []
    rooms = [
        room for stay in stays if isinstance(stay, dict)
        for room in (stay.get("rows") or []) if isinstance(room, dict)
    ]
    requested = [
        stay.get("requested") or {} for stay in stays
        if isinstance(stay, dict) and isinstance(stay.get("requested"), dict)
    ]
    if family == "guest names":
        return "no guest-list field in schema"
    if family == "child ages":
        return "childAges null/empty" if not rooms or any(empty(r.get("childAges")) for r in rooms) else "childAges populated"
    if family == "room/occupancy":
        keys = ("rooms", "adultsPerRoom", "roomType")
        return "room/occupancy null" if not rooms or any(empty(r.get(k)) for r in rooms for k in keys) else "room/occupancy populated"
    if family == "dinner/board":
        return "board null" if not rooms or any(empty(r.get("board")) for r in rooms) else "board populated"
    if family == "dates/nights":
        return "arrival/departure null" if not requested or any(empty(r.get("arrival")) or empty(r.get("departure")) for r in requested) else "dates populated"
    if family == "company/billing/VAT":
        return "agency/endClient null" if not (payload.get("agency") or payload.get("endClient")) else "agency/endClient populated"
    if family in ("payment/guarantee", "ID/passport", "arrival time"):
        return "no dedicated field in schema"
    return "no single field mapping"

family_missing_regex = {
    "guest names": r"guest\s*names?",
    "child ages": r"child|age",
    "room/occupancy": r"room|adult|occup",
    "dinner/board": r"board|meal|dinner",
    "dates/nights": r"date|arrival|departure|night",
    "company/billing/VAT": r"agency|company|billing|bill|vat",
    "ID/passport": r"passport|identity|\bid\b",
    "payment/guarantee": r"payment|guarantee|deposit|card",
    "arrival time": r"arrival\s*time|\beta\b|flight",
}
outbound_text_messages = [
    m for m in messages
    if m.get("direction") == "outbound" and is_own(m) and body(m)
]
print("WINDOW", window_start, window_end)
print("CLARIFICATIONS", len(clarifications), "/", len(outbound_text_messages),
      "unique_inbounds", len({r["in"]["id"] for r in clarifications}),
      "extraction_available", sum(bool(r["extraction"]) for r in clarifications), "/", len(clarifications))
for family in list(family_patterns) + ["other"]:
    rows = [r for r in clarifications if family in r["tags"]]
    extracted = [r for r in rows if r["extraction"]]
    states = collections.Counter(null_state(r, family) for r in rows)
    field_re = family_missing_regex.get(family)
    missing_list_count = 0
    if field_re:
        missing_list_count = sum(
            any(re.search(field_re, label, re.I) for label in missing_labels(r["extraction"]))
            for r in extracted
        )
    print("FAMILY", family, len(rows), "/", len(clarifications),
          "share_pct", pct(len(rows), len(clarifications)),
          "state", dict(states),
          "missing_list_messages", missing_list_count, "/", len(extracted))
print("CLARIFICATION_MULTI_TAG", sum(len(r["tags"]) > 1 for r in clarifications),
      "/", len(clarifications))
print("CLARIFICATION_FAMILIES_SUM_NONEXCLUSIVE",
      sum(sum(f in r["tags"] for r in clarifications) for f in family_patterns),
      "plus_other", sum("other" in r["tags"] for r in clarifications))

# Staff confirmation-letter PDFs and safe field parsing.
attachments = read_gz("attachments.jsonl.gz")
attachment_ids = {a["id"] for a in attachments}
manifest = []
with open(os.path.join(BASE, "staff_pdfs.tsv"), encoding="utf-8") as f:
    for row in csv.reader(f, delimiter="\t"):
        if len(row) >= 3:
            attachment_id, message_id, relative_path = row[:3]
            manifest.append((attachment_id, message_id, relative_path))
letter_mids = set()
letters = []
manifest_text_count = 0
for attachment_id, message_id, relative_path in manifest:
    text_path = os.path.join(BASE, "pdftxt", attachment_id + ".txt")
    has_text = os.path.isfile(text_path)
    manifest_text_count += int(has_text)
    if not has_text or not re.search(r"confirmation[_ ]letter", relative_path, re.I):
        continue
    raw = open(text_path, encoding="utf-8", errors="replace").read()
    letter_mids.add(message_id)

    def label_date(label):
        match = re.search(
            label + r"\s*:\s*(\d{1,2}[-/]\d{1,2}[-/]\d{4}|\d{4}-\d{2}-\d{2})",
            raw, re.I,
        )
        return parse_date(match.group(1)) if match else None

    room_match = re.search(
        r"Accommodation\s+Type\s*:\s*(.*?)\s+Number\s+of\s+Person\(s\)",
        raw, re.I | re.S,
    )
    room_type = " ".join(room_match.group(1).split()) if room_match else None
    persons_match = re.search(
        r"Number\s+of\s+Person\(s\)\s*:\s*(\d+)\s*Adult\(s\)\s+and\s*(\d+)\s*Child\(ren\)",
        raw, re.I,
    )
    persons = (
        (int(persons_match.group(1)), int(persons_match.group(2)))
        if persons_match else None
    )
    adr_match = re.search(
        r"Average\s+Daily\s+rate\s*:\s*ZAR\s*([\d,]+(?:\.\d{2})?)", raw, re.I
    )
    adr = float(adr_match.group(1).replace(",", "")) if adr_match else None
    includes_match = re.search(r"Rate\s+Includes\s*:\s*([^\r\n]+)", raw, re.I)
    includes = includes_match.group(1) if includes_match else ""
    board = (
        "DBB" if "dinner" in includes.lower() and "breakfast" in includes.lower()
        else "B&B" if "breakfast" in includes.lower()
        else "unparsed"
    )
    dear = re.search(r"\bDear\s+", raw, re.I)
    header = raw[:dear.start()] if dear else raw[:1000]
    labels = set()
    for label, pattern in (
        ("agency", r"\bagency(?:\s+name)?\b"),
        ("company", r"\bcompany(?:\s+name)?\b"),
        ("travel agent", r"\btravel\s+agent\b"),
        ("bill to", r"\bbill\s+to\b"),
        ("account", r"\baccount\s+name\b"),
    ):
        if re.search(pattern, header, re.I):
            labels.add(label)
    letters.append({
        "attachment_id": attachment_id, "message_id": message_id,
        "raw": raw, "header": header, "labels": labels,
        "arrival": label_date(r"Arrival Date"),
        "departure": label_date(r"Departure Date"),
        "room": room_type, "persons": persons, "adr": adr, "board": board,
    })

letter_denominator = len(letters)
letter_adr_count = sum(row["adr"] is not None for row in letters)
letter_board_count = sum(row["board"] != "unparsed" for row in letters)
letter_room_count = sum(bool(row["room"]) for row in letters)
letter_person_count = sum(row["persons"] is not None for row in letters)
letter_date_count = sum(bool(row["arrival"] and row["departure"]) for row in letters)
letter_combo = collections.Counter(
    (row["adr"], row["board"]) for row in letters
    if row["adr"] is not None and row["board"] != "unparsed"
)
letter_label_counts = collections.Counter(
    label for row in letters for label in row["labels"]
)
explicit_party_lines = sum(bool(row["labels"]) for row in letters)
rate_plan_label_count = sum(
    bool(re.search(r"\brate\s*(?:code|plan|type)\b", row["raw"], re.I))
    for row in letters
)
print("PDF_MANIFEST", len(manifest), "/", len(manifest),
      "text_files", manifest_text_count, "/", len(manifest),
      "attachment_id_join", sum(aid in attachment_ids for aid, _, _ in manifest), "/", len(manifest),
      "message_id_join", sum(mid in by_id for _, mid, _ in manifest), "/", len(manifest))
print("LETTERS", letter_denominator, "/", len(manifest),
      "room", letter_room_count, "/", letter_denominator,
      "persons", letter_person_count, "/", letter_denominator,
      "dates", letter_date_count, "/", letter_denominator,
      "ADR", letter_adr_count, "/", letter_denominator,
      "RateIncludes_board", letter_board_count, "/", letter_denominator,
      "ADR_and_board", sum(letter_combo.values()), "/", letter_denominator)
print("LETTER_ROOMS", dict(collections.Counter(row["room"] or "not parsed" for row in letters)))
print("LETTER_BOARD", dict(collections.Counter(row["board"] for row in letters)))
print("LETTER_TOP_ADR_BOARD", letter_combo.most_common(8))
print("LETTER_RATE_CODE_PLAN_TYPE_LABEL", rate_plan_label_count, "/", letter_denominator)
print("HEADER_PARTY_LINE", explicit_party_lines, "/", letter_denominator,
      "labels", dict(letter_label_counts))

# Strict ask-to-letter join: same-thread inbound, or same recipient plus a
# prior staff text reply within 24 hours, and exact extracted stay dates.
outbound_by_recipient = collections.defaultdict(list)
for index, message in enumerate(messages):
    if message.get("direction") != "outbound" or not is_own(message) or message["id"] in letter_mids:
        continue
    event_time = message.get("sent_at") or message.get("received_at") or ""
    recipients = addresses(message.get("to_addresses")) | addresses(message.get("cc_addresses"))
    for recipient in recipients:
        outbound_by_recipient[recipient].append((event_time, index, message))
for rows in outbound_by_recipient.values():
    rows.sort(key=lambda row: (row[0], row[1]))

links = []
link_stats = collections.Counter()
cross_gaps = []
for letter in letters:
    letter_message = by_id.get(letter["message_id"])
    if not letter_message:
        link_stats["missing message"] += 1
        continue
    arrival, departure = letter["arrival"], letter["departure"]
    if not (arrival and departure):
        link_stats["letter dates missing"] += 1
        continue
    letter_time = letter_message.get("sent_at") or letter_message.get("received_at") or ""
    exact_pair = (arrival, departure)
    direct = []
    for event_time, _, inbound in threads.get(letter_message.get("thread_id"), []):
        if event_time >= letter_time:
            break
        if (
            inbound.get("direction") == "inbound"
            and not is_own(inbound) and not is_channel(inbound)
            and exact_pair in requested_date_pairs(inbound["id"])
        ):
            direct.append(inbound)
    if direct:
        links.append({
            "letter": letter, "in": direct[-1], "out": None,
            "method": "same-thread", "gap": None,
        })
        link_stats["same-thread"] += 1
        continue

    recipients = addresses(letter_message.get("to_addresses")) | addresses(letter_message.get("cc_addresses"))
    candidates = []
    for recipient in recipients:
        recipient_rows = outbound_by_recipient.get(recipient, [])
        times = [row[0] for row in recipient_rows]
        limit = bisect.bisect_left(times, letter_time)
        for outbound_time, _, outbound in reversed(recipient_rows[:limit]):
            try:
                gap = (
                    dt.datetime.fromisoformat(letter_time.replace("Z", "+00:00"))
                    - dt.datetime.fromisoformat(outbound_time.replace("Z", "+00:00"))
                ).total_seconds()
            except ValueError:
                continue
            if gap > 86400:
                break
            if gap <= 0 or not body(outbound):
                continue
            source_inbounds = []
            for inbound_time, _, inbound in threads.get(outbound.get("thread_id"), []):
                if inbound_time >= outbound_time:
                    break
                if (
                    inbound.get("direction") == "inbound"
                    and not is_own(inbound) and not is_channel(inbound)
                    and recipient in addresses(inbound.get("from_address"))
                    and exact_pair in requested_date_pairs(inbound["id"])
                ):
                    source_inbounds.append(inbound)
            if source_inbounds:
                candidates.append((gap, outbound, source_inbounds[-1]))
    if not candidates:
        link_stats["no exact link"] += 1
        continue
    candidates.sort(key=lambda candidate: candidate[0])
    if len(candidates) > 1 and abs(candidates[0][0] - candidates[1][0]) < 1:
        link_stats["time tie"] += 1
        continue
    gap, outbound, inbound = candidates[0]
    links.append({
        "letter": letter, "in": inbound, "out": outbound,
        "method": "same-recipient/date", "gap": gap,
    })
    link_stats["same-recipient/date"] += 1
    cross_gaps.append(gap)

linked_inbounds = {row["in"]["id"]: row["in"] for row in links}
linked_outbounds = {
    row["out"]["id"]: row["out"] for row in links if row["out"] is not None
}
print("LINKS", len(links), "/", letter_denominator,
      "methods", dict(link_stats),
      "unique_source_inbounds", len(linked_inbounds), "/", len(links),
      "unique_letter_messages", len({row["letter"]["message_id"] for row in links}), "/", len(links),
      "unique_staff_text_replies", len(linked_outbounds), "/", len(links))
print("CROSS_LINK_GAPS", "<=15m", sum(g <= 900 for g in cross_gaps), "/", len(cross_gaps),
      "<=1h", sum(g <= 3600 for g in cross_gaps), "/", len(cross_gaps),
      "<=6h", sum(g <= 21600 for g in cross_gaps), "/", len(cross_gaps),
      "<=24h", sum(g <= 86400 for g in cross_gaps), "/", len(cross_gaps))

# Unique ask text terms and exact output room/board/adult mappings.
literal_room_words = {
    "single": re.compile(r"\bsingle\b", re.I),
    "double": re.compile(r"\bdouble\b", re.I),
    "twin": re.compile(r"\btwin\b", re.I),
    "sharing": re.compile(r"\b(?:shar(?:e|ing)|shared)\b", re.I),
}
government_word = re.compile(r"\b(?:government|govt|gov\.?\s+rate)\b", re.I)
sold_out_word = re.compile(
    r"\b(?:sold\s*out|fully\s+booked|no\s+(?:rooms?|availability)|not\s+available|unavailable)\b",
    re.I,
)
gov_asks = {
    message_id: message for message_id, message in linked_inbounds.items()
    if government_word.search((message.get("subject") or "") + " " + body(message))
}
print("UNIQUE_ASK_FLAGS", "room_words", {
    key: sum(bool(pattern.search((message.get("subject") or "") + " " + body(message)))
             for message in linked_inbounds.values())
    for key, pattern in literal_room_words.items()
}, "government", len(gov_asks), "/", len(linked_inbounds),
      "sold_out", sum(bool(sold_out_word.search((m.get("subject") or "") + " " + body(m)))
                      for m in linked_inbounds.values()), "/", len(linked_inbounds))
unique_agency = sum(bool(payload_for(mid).get("agency")) for mid in linked_inbounds)
unique_end_client = sum(bool(payload_for(mid).get("endClient")) for mid in linked_inbounds)
print("UNIQUE_ASK_PARTY_FIELDS", "agency", unique_agency, "/", len(linked_inbounds),
      "endClient", unique_end_client, "/", len(linked_inbounds))

def room_category(value):
    value = str(value or "").lower()
    if "single" in value:
        return "single"
    if "double" in value:
        return "double"
    if "twin" in value:
        return "twin"
    if "queen" in value:
        return "queen"
    if "king" in value:
        return "king"
    if "standard" in value:
        return "generic standard"
    return "other"

room_crosswalk = collections.Counter()
board_crosswalk = collections.Counter()
adult_crosswalk = collections.Counter()
arrival_months = collections.defaultdict(collections.Counter)
for row in links:
    letter, inbound = row["letter"], row["in"]
    payload = payload_for(inbound["id"])
    room_rows = [
        room for stay in (payload.get("stays") or []) if isinstance(stay, dict)
        for room in (stay.get("rows") or []) if isinstance(room, dict)
    ]
    room_values = {room.get("roomType") for room in room_rows if not empty(room.get("roomType"))}
    request_room_types = {room_category(value) for value in room_values}
    if len(request_room_types) == 0:
        request_room_category = "no room type"
    elif len(request_room_types) == 1:
        request_room_category = next(iter(request_room_types))
    else:
        request_room_category = "multiple types"
    room_crosswalk[(request_room_category, letter["room"] or "not parsed")] += 1

    board_values = {
        str(room.get("board")).strip().lower() for room in room_rows
        if not empty(room.get("board"))
    }
    if not board_values and not room_rows:
        ask_board = "no rows"
    elif not board_values:
        ask_board = "null"
    else:
        ask_board = " / ".join(sorted(board_values))
    board_crosswalk[(ask_board, letter["board"])] += 1

    adult_values = tuple(
        room.get("adultsPerRoom") for room in room_rows
        if not empty(room.get("adultsPerRoom"))
    ) or ("not captured",)
    letter_adults = letter["persons"][0] if letter["persons"] else "not parsed"
    adult_crosswalk[(adult_values, letter_adults)] += 1

    if letter["arrival"]:
        month = f"{letter['arrival'].year:04d}-{letter['arrival'].month:02d}"
        arrival_months[month][letter["room"] or "not parsed"] += 1

print("ROOM_TYPE_CROSSWALK", room_crosswalk.most_common())
print("BOARD_CROSSWALK", board_crosswalk.most_common())
print("ADULT_CROSSWALK", adult_crosswalk.most_common())
print("ARRIVAL_MONTH_ROOM", {month: dict(counts) for month, counts in sorted(arrival_months.items())})

gov_letter_rows = [
    row for row in links if row["in"]["id"] in gov_asks
]
gov_outcomes = collections.Counter(
    (row["letter"]["adr"], row["letter"]["board"]) for row in gov_letter_rows
)
print("GOVERNMENT_LETTERS", len(gov_asks), "/", len(linked_inbounds),
      "linked_PDFs", len(gov_letter_rows), "/", len(links),
      "outcomes", gov_outcomes)

# Explicit party label in header block before salutation; compare only Agency
# extraction against an explicit Agency-labelled line. No values are printed.
linked_header_labels = collections.Counter(
    label for row in links for label in row["letter"]["labels"]
)
agency_label_rows = [row for row in links if "agency" in row["letter"]["labels"]]
agency_label_with_extract = [
    row for row in agency_label_rows if payload_for(row["in"]["id"]).get("agency")
]
agency_line_matches = 0
for row in agency_label_with_extract:
    agency = normalized_entity(payload_for(row["in"]["id"]).get("agency"))
    if len(agency) < 4:
        continue
    matching_lines = [
        line for line in row["letter"]["header"].splitlines()
        if re.search(r"\bagency\b", line, re.I)
    ]
    if any(agency in normalized_entity(line) for line in matching_lines):
        agency_line_matches += 1
print("LINKED_HEADER", dict(linked_header_labels), "/", len(links),
      "agency_label_docs", len(agency_label_rows), "/", len(links),
      "agency_field_on_label_docs", len(agency_label_with_extract), "/", len(agency_label_rows),
      "exact_normalized_agency_match", agency_line_matches, "/", len(agency_label_with_extract))

# Allowance/add-on text mentions. Denominator: eligible messages with visible
# nonquoted body text. Categories overlap; combined count is distinct messages.
dinner_patterns = {
    "dinner allowance": re.compile(r"\bdinner\s+allowance\b", re.I),
    "meal allowance": re.compile(r"\bmeal\s+allowance\b", re.I),
    "dinner add-on/supplement/charge/extra": re.compile(
        r"\bdinner\s+(?:add[- ]?on|supplement|charge|extra)\b", re.I
    ),
    "add dinner": re.compile(r"\badd\s+(?:on\s+)?dinner\b", re.I),
    "meal add-on/supplement": re.compile(r"\bmeal\s+(?:add[- ]?on|supplement)\b", re.I),
    "combined allowance/add-on": re.compile(
        r"\b(?:dinner\s+allowance|meal\s+allowance|dinner\s+"
        r"(?:add[- ]?on|supplement|charge|extra)|add\s+(?:on\s+)?dinner|"
        r"meal\s+(?:add[- ]?on|supplement))\b", re.I
    ),
    "broad dinner/DBB": re.compile(
        r"\b(?:dinner|dbb|half\s*[- ]?board|meal\s+allowance|dinner\s+allowance)\b",
        re.I,
    ),
}
for direction in ("inbound", "outbound"):
    pool = [
        message for message in messages
        if message.get("direction") == direction
        and (not is_own(message) and not is_channel(message) if direction == "inbound" else is_own(message))
        and body(message)
    ]
    counts = {
        name: sum(bool(pattern.search(body(message))) for message in pool)
        for name, pattern in dinner_patterns.items()
    }
    print("DINNER_TEXT", direction, "eligible_visible_text", len(pool), "counts", counts)

```

