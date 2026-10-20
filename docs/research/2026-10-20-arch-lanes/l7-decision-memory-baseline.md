# L7 — Decision-memory baseline

## Answer

- **(inference) Use the widened set only as a provisional benchmark.** It links 191/655 unique confirmation IDs, clearing the requested 100-row truth-set bar; heldout set is only 60/191 rows from 38/60 unique asks.
- Strict L1 linkage yields 57/655 confirmation IDs and 31/88 eligible core asks. It has 0/57 causal index rows; 55/57 rows fall in test. Strict set is below 100 and cannot measure past-memory prediction.
- Widened set has 131/191 causal index rows and 60/191 test rows. But 131/131 index ask kinds are not found; test includes quote/booking on 44/60 rows, plus other kinds on 16/60.
- On widened test, sender→domain history gets party right on 11/56, wrong on 17/56, abstains on 28/56. Confident-only gets 5/56 right, 1/56 wrong, abstains on 50/56.
- Of 17/56 wrong party-history predictions, the right party appears in selected key history on 5/17; absent on 12/17. History recall ceiling is low.
- Global majority and BM25@5 are close on board (34/60 vs 35/60) and ADR within 5% (27/59 vs 29/59); neither wins every field. (inference)
- Sender+company history predicts no parsed test field: e.g. party has 0/56 right, 0/56 wrong, 56/56 abstain. Across party rows, 11/56 lack a company key and 45/56 have no matching compound history. A company/end-client label exists on 29/38 unique test asks.
- Current ask differs from sender-history value on board for 5/16 comparable asks and nights for 15/18. Current mail must win over precedent. (inference)
- (inference) No memory framework can be selected from this run: the heldout set is under 100 and the wide links are unreviewed, with index ask kinds missing.

## Method

> 🧠 **From Hindsight memory (Conventions and patterns)** — Research counts should be reproducible, show numerator/denominator and window, label inferences, and mask identifying data.

- Scope: local, read-only corpus only. No network, production, HMS, Git, installs, or LLM arms. No raw mail, guest names, emails, phones, party strings, or attachment IDs in report.
- Inputs: [messages.jsonl.gz](/home/orca/nava-research/corpus/2026-10-13/messages.jsonl.gz), [attachments.jsonl.gz](/home/orca/nava-research/corpus/2026-10-13/attachments.jsonl.gz), [extractions.jsonl.gz](/home/orca/nava-research/corpus/2026-10-13/extractions.jsonl.gz), [staff_pdfs.tsv](/home/orca/nava-research/corpus/2026-10-13/staff_pdfs.tsv), and [pdftxt/](/home/orca/nava-research/corpus/2026-10-13/pdftxt/). Observed message window: 2026-07-30T18:30:59Z–2026-10-13T17:54:13Z.
- Reused [L1 linkage rules](/tmp/opus-run-1020/research/l1-linkage-domains.md:20): first own-domain reply; HRCEN score +4 exact recipient, +1 sender domain, +3 surname, +3 arrival, +2 same thread; score ≥7, at least two key families, unique top ask, ties dropped. L1 operationalizes its HRCEN “+3d” window as [first reply, reply+72h], with a complete-window censor. Prompt shorthand says ±3d; strict cohort follows L1 Appendix as written.
- Widened cohort: any external, non-OTA inbound with exact sender address in letter To/Cc during the 72h before the letter. Accept only one candidate inbound; drop zero or multiple candidates. No L1 score applied. This is weaker evidence than strict L1 linkage. (inference)
- Unit: one row per unique 8-digit confirmation ID per cohort. If ID has repeated attachment copies, use earliest linkable copy. All 1,174/1,174 PDF instances were parsed; IDs repeated on 341/655 confirmation IDs.
- Split by inbound ask timestamp UTC: index before 2026-09-28; test 2026-09-28 through 2026-10-13. Index label also had to be sent before cutoff; this prevents future-letter leakage. Test ends at corpus watermark.
- Letter fields: party = non-empty lines after first four non-empty hotel-address lines and before Dear, excluding VAT number; room = Accommodation Type; board = Rate Includes mapped to B&B/DBB/room-only/other; ADR = Average Daily rate; adults = Number of Person(s) adult count; nights = Departure Date minus Arrival Date. Letter text is outcome label, not proof of current HMS state.
- Baselines: A global field majority; B exact sender address then sender domain; B-conf requires ≥2 labeled past letters and ≥80% agreement; C stdlib BM25 subject + quote-stripped body, top-5 linked index asks, one vote per ask, ties to highest-ranked ask; D sender+end-client then sender-domain+same-end-client, plus confident-only. BM25 uses k1=1.2, b=0.75, positive IDF, unique query terms, no stopwords/stemming, matching [L6 method](/tmp/opus-run-1020/research/l6-precedent-baseline.md:17). Per ask with multiple letters, each field vote is that ask’s modal letter value; ties use earliest letter.
- Scores: exact match for party, room, board, adults, nights, and ADR±0; ADR±5 uses same exact-price prediction but passes when absolute error ≤5% of true ADR. R/W/A = right/wrong/abstain; denominator is parsed test targets shown in each row.
- Current-ask checks use explicit, unambiguous values only. Party requires a bill-to label; room check requires a specific bed cue (Twin/Queen/King), not Single/Double occupancy. L3 warns these are distinct fields: [room-type note](/tmp/opus-run-1020/research/l3-missing-info-rooms.md:142). These checks are lexical/extraction heuristics, not semantic judgments.
- Route: local corpus + existing local reports only; no web or subagents. Runtime did not expose a model-cost meter (not found). Appendix script uses Python 3 stdlib only and prints aggregates, never raw values.

## Findings

### Linked truth set and time split

Window: 2026-07-30T18:30:59Z–2026-10-13T17:54:13Z. Link counts use attachment copies and unique 8-digit IDs as labeled; script is Appendix.

| Cohort | Linkable copies / 1,174 | Linked unique IDs / 655 | Linked asks | Causal index / linked IDs | Test IDs / linked IDs | Total ≥100? | Test ≥100? |
|---|---:|---:|---:|---:|---:|---|---|
| Strict L1 core | 70/1,174 | 57/655 | 31/88 eligible core asks; 31/189 all core asks | 0/57 | 55/57; 30/55 unique asks | No | No |
| Wide exact-recipient 3d | 281/1,174 | 191/655 | 113/4,941 external non-OTA inbounds | 131/191 | 60/191; 38/60 unique asks | Yes | No |

- Strict eligible asks: 88/189 core quote/booking asks. Two/57 pre-cut asks had letter time on/after cutoff, so neither counts as past history. Strict total matches L1’s 31/88 linked core asks and 57 unique confirmation IDs.
- Wide copy outcomes: 281/1,174 linked, 358/1,174 ambiguous, 535/1,174 with no unique recipient-window candidate.
- Strict/wide overlap: 31/655 unique IDs; same originating ask on 31/31 overlap IDs.
- Wide cohort ask-kind mix, by linked confirmation row:

| Split | quote | booking | amendment | other | voucher_pop | kind not found |
|---|---:|---:|---:|---:|---:|---:|
| Index, 131 rows | 0/131 | 0/131 | 0/131 | 0/131 | 0/131 | 131/131 |
| Test, 60 rows | 8/60 | 36/60 | 7/60 | 5/60 | 4/60 | 0/60 |

### Letter-field parse coverage

Denominator is linked unique confirmation IDs in cohort; test denominator is linked test IDs.

| Field | Strict full / 57 | Strict test / 55 | Wide full / 191 | Wide test / 60 |
|---|---:|---:|---:|---:|
| Bill-to party | 55/57 | 53/55 | 179/191 | 56/60 |
| Room type | 55/57 | 53/55 | 190/191 | 60/60 |
| Rate Includes board | 57/57 | 55/55 | 191/191 | 60/60 |
| Average daily rate | 53/57 | 51/55 | 185/191 | 59/60 |
| Adults | 55/57 | 53/55 | 190/191 | 60/60 |
| Nights | 57/57 | 55/55 | 191/191 | 60/60 |

### Baseline results

Time split: index before 2026-09-28 UTC; test 2026-09-28–2026-10-13 UTC. Each cell shows right/wrong/abstain, each over field-parsed test rows in first column. Strict has no causal index rows, so all six methods abstain.

| Strict L1 field | Parsed test / 55 | A/B/B-conf/C/D/D-conf, each R/W/A |
|---|---:|---|
| Party | 53/55 | R 0/53 · W 0/53 · A 53/53 |
| Room type | 53/55 | R 0/53 · W 0/53 · A 53/53 |
| Board | 55/55 | R 0/55 · W 0/55 · A 55/55 |
| ADR exact | 51/55 | R 0/51 · W 0/51 · A 51/51 |
| ADR within 5% | 51/55 | R 0/51 · W 0/51 · A 51/51 |
| Adults | 53/55 | R 0/53 · W 0/53 · A 53/53 |
| Nights | 55/55 | R 0/55 · W 0/55 · A 55/55 |

Wide test: each result gives R/W/A fractions over gold rows shown in first column.

| Field (gold / 60) | A global | B sender→domain | B confident | C BM25@5 | D sender+client | D confident |
|---|---|---|---|---|---|---|
| Party (56/60) | 1/56; 55/56; 0/56 | 11/56; 17/56; 28/56 | 5/56; 1/56; 50/56 | 6/56; 50/56; 0/56 | 0/56; 0/56; 56/56 | 0/56; 0/56; 56/56 |
| Room type (60/60) | 24/60; 36/60; 0/60 | 12/60; 14/60; 34/60 | 6/60; 2/60; 52/60 | 19/60; 41/60; 0/60 | 0/60; 0/60; 60/60 | 0/60; 0/60; 60/60 |
| Board (60/60) | 34/60; 26/60; 0/60 | 22/60; 6/60; 32/60 | 6/60; 1/60; 53/60 | 35/60; 25/60; 0/60 | 0/60; 0/60; 60/60 | 0/60; 0/60; 60/60 |
| ADR exact (59/60) | 26/59; 33/59; 0/59 | 12/59; 16/59; 31/59 | 5/59; 1/59; 53/59 | 22/59; 37/59; 0/59 | 0/59; 0/59; 59/59 | 0/59; 0/59; 59/59 |
| ADR within 5% (59/60) | 27/59; 32/59; 0/59 | 12/59; 16/59; 31/59 | 5/59; 1/59; 53/59 | 29/59; 30/59; 0/59 | 0/59; 0/59; 59/59 | 0/59; 0/59; 59/59 |
| Adults (60/60) | 56/60; 4/60; 0/60 | 23/60; 3/60; 34/60 | 19/60; 0/60; 41/60 | 55/60; 5/60; 0/60 | 0/60; 0/60; 60/60 | 0/60; 0/60; 60/60 |
| Nights (60/60) | 18/60; 42/60; 0/60 | 8/60; 20/60; 32/60 | 4/60; 0/60; 56/60 | 13/60; 47/60; 0/60 | 0/60; 0/60; 60/60 | 0/60; 0/60; 60/60 |

### Error and current-ask checks

Wide test window: 60 linked letter rows from 38 unique asks.

| Check | Result |
|---|---:|
| B party wrong predictions | 17/56 parsed party targets |
| Correct party present in selected sender/domain history | 5/17 B party errors |
| Correct party absent from selected history | 12/17 B party errors |
| B party rows with no history | 28/56 parsed party targets |
| B party rows using exact sender history | 7/56 parsed party targets |
| B party rows using domain fallback | 21/56 parsed party targets |
| Ask text contains full target room label | 0/60 parsed room targets |
| Ask text contains full label or discriminative room cue | 0/60 parsed room targets |

Explicit current-ask value versus B sender/domain history, by unique linked test ask:

| Field | Explicit, unambiguous / 38 asks | History available / explicit | Current value differs / comparable |
|---|---:|---:|---:|
| Party (explicit bill-to only) | 1/38 | 0/1 | not scored (0/0) |
| Room type (Twin/Queen/King only) | 1/38 | 0/1 | not scored (0/0) |
| Board | 27/38 | 16/27 | 5/16 |
| ADR (currency-marked amount) | 2/38 | 1/2 | 1/1 |
| Adults | 31/38 | 16/31 | 0/16 |
| Nights | 27/38 | 18/27 | 15/18 |

Party/room checks had no comparable history rows. ADR has one comparison. Board, adults, nights use extraction or explicit text cues; values are not semantic labels.

D sender+company history abstentions, by parsed test letter row:

| Field | Parsed rows | No company key | No matching compound history |
|---|---:|---:|---:|
| Party | 56/60 | 11/56 | 45/56 |
| Room type | 60/60 | 12/60 | 48/60 |
| Board | 60/60 | 12/60 | 48/60 |
| ADR | 59/60 | 12/59 | 47/59 |
| Adults | 60/60 | 12/60 | 48/60 |
| Nights | 60/60 | 12/60 | 48/60 |

### Monthly volume

Window is full corpus: 2026-07-30T18:30:59Z–2026-10-13T17:54:13Z. July and October are partial months. Letter attachment counts include repeats; unique ID counts use first-seen month.

| UTC month | Inbound / 8,892 | Letter attachment copies / 1,174 | Unique confirmation IDs first seen / 655 |
|---|---:|---:|---:|
| 2026-07 | 135/8,892 | 26/1,174 | 23/655 |
| 2026-08 | 3,153/8,892 | 484/1,174 | 234/655 |
| 2026-09 | 3,638/8,892 | 472/1,174 | 252/655 |
| 2026-10 | 1,966/8,892 | 192/1,174 | 146/655 |

## What this means for a memory framework test

- (inference) Benchmark against global majority, sender→domain history, and BM25@5 on the same exact split and labels. Wide set is only provisional because recipient-window links are unreviewed and index kinds are missing.
- (inference) Report both coverage and wrong predictions. Confident B cuts coverage to 6/56 party rows while still making 1/6 wrong; “confidence” alone is not safety.
- (inference) Add the sender+client key only if it yields test coverage. Here it abstains across every field despite a company key on 29/38 unique test asks.
- (inference) Show precedents beside current ask, not as defaults. Current board and nights differ from sender history on 5/16 and 15/18 comparable asks; staff approval boundary stays unchanged.
- (inference) Keep one heldout letter per confirmation ID and disclose ask-level clustering. Wide test has 60/60 letter rows but only 38/60 unique asks, so row errors are not independent.

## Open gaps

- Strict set is only 57/655 unique IDs; strict heldout is 55/57 and causal index is 0/57. (inference) It cannot measure a historical-memory model.
- Wide set clears total-row bar at 191/655, but test is 60/191, not 100. Link uses recipient/time uniqueness only; 358/1,174 copies had multiple candidates and were dropped. No manual QA was run for wide links.
- Wide index ask kind is not found on 131/131 rows. Test contains 44/60 quote/booking rows and 16/60 other labeled kinds; baseline is not a pure quote/new-booking score.
- Repeated attachment IDs can change parsed fields: among 341/655 IDs with repeat copies, party differs on 3/341, room on 20/341, board on 2/341, ADR on 22/341, adults on 0/341, and nights on 29/341. Earliest linkable copy per ID avoids repeated-copy weighting but may omit later revisions. (inference)
- Wide letter parse misses party on 12/191, room on 1/191, ADR on 6/191, and adults on 1/191. Parser is template/regex-based.
- Current-ask mismatch checks are heuristics. Explicit bill-to and exact room-type mentions are rare; rates have only 1/1 comparable case. Do not read these as semantic intent labels. (inference)
- Letter text records an output document, not the full staff decision path or current HMS state. This lane does not test payment state, write outcomes, or whether a later amendment replaced a value.
- One time split only; wide test has 60/60 letter rows but 38/60 distinct asks. More heldout letters and manual linkage review needed before choosing a memory framework. (inference)

## Appendix (scripts)

Run the Appendix block from this directory with Python 3; standard library only. Reads the supplied corpus; prints aggregate results only. It does not print raw party values, names, addresses, emails, message bodies, or attachment IDs. This is the script/command source for every count in Findings.

```sh
python3 - <<'PY'
from pathlib import Path
import re
report = Path("l7-decision-memory-baseline.md").read_text()
script = re.search(r"~~~python\n(.*?)\n~~~", report, re.S).group(1)
exec(compile(script, "l7-decision-memory-baseline.md:appendix", "exec"))
PY
```

~~~python
import bisect, collections, datetime as dt, gzip, html, json, math, os, re, unicodedata
from decimal import Decimal, InvalidOperation
from html.parser import HTMLParser

BASE = "/home/orca/nava-research/corpus/2026-10-13"
OWN = ("legacyhotels.co.za", "legacyhotels.com")
OTA = ("synxis", "booking.com", "expedia", "webbeds", "hotelbeds",
       "profitroom", "siteminder", "ratetiger", "tiket")
UTC = dt.timezone.utc
CUTOFF = dt.datetime(2026, 9, 28, tzinfo=UTC)
TEST_END = dt.datetime(2026, 10, 13, 23, 59, 59, 999999, tzinfo=UTC)
THREE_DAYS = dt.timedelta(days=3)
EMAIL_RE = re.compile(r"[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}", re.I)
LETTER_RE = re.compile(r"^HRCEN_Confirmation_Letter_(\d{8})", re.I)
TOKEN_RE = re.compile(r"[a-zà-öø-ÿ][a-zà-öø-ÿ'’-]{1,}", re.I)
FIELDS = ("party", "room", "board", "adr", "adults", "nights")

def rows(name):
    with gzip.open(os.path.join(BASE, name), "rt", encoding="utf-8") as stream:
        for line in stream:
            if line.strip():
                yield json.loads(line)

def emails(value):
    if isinstance(value, str):
        value = [value]
    return [address.lower() for part in (value or [])
            for address in EMAIL_RE.findall(str(part))]

def sender(message):
    return (emails(message.get("from_address") or "") or [""])[0]

def domain(address):
    return address.rsplit("@", 1)[-1].lower() if "@" in address else ""

def own(address):
    value = domain(address)
    return any(value == item or value.endswith("." + item) for item in OWN)

def external_nonota(address):
    value = domain(address)
    return bool(value) and not own(address) and not any(item in value for item in OTA)

def stamp(value):
    if not value:
        return None
    try:
        parsed = dt.datetime.fromisoformat(str(value).strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)

def received(message):
    return stamp(message.get("received_at")) or stamp(message.get("sent_at"))

def sent(message):
    return stamp(message.get("sent_at")) or stamp(message.get("received_at"))

def plain_html(value):
    value = str(value or "")
    value = re.sub(r"(?is)<(script|style).*?>.*?</\1>", " ", value)
    value = re.sub(r"(?i)<br\s*/?>|</(?:p|div|li|tr|td|h[1-6])>", "\n", value)
    return html.unescape(re.sub(r"(?s)<[^>]*>", " ", value))

class HTMLText(HTMLParser):
    BLOCK = {"address", "article", "aside", "br", "dd", "div", "dl", "dt",
             "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2",
             "h3", "h4", "h5", "h6", "header", "hr", "li", "main", "ol",
             "p", "pre", "section", "table", "td", "th", "tr", "ul"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts, self.hidden = [], 0

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag in ("script", "style"):
            self.hidden += 1
        if self.hidden:
            return
        ident = (attrs.get("class") or "") + " " + (attrs.get("id") or "")
        if tag == "blockquote" or re.search(
                r"(?i)(gmail_quote|yahoo_quoted|moz-cite-prefix|quoted)", ident):
            self.parts.append("\n__QUOTED_BLOCK__\n")
        elif tag in self.BLOCK:
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag in ("script", "style") and self.hidden:
            self.hidden -= 1
        if not self.hidden and tag in self.BLOCK:
            self.parts.append("\n")

    def handle_data(self, data):
        if not self.hidden:
            self.parts.append(data)

def html_text(value):
    parser = HTMLText()
    try:
        parser.feed(value or "")
        parser.close()
        return "".join(parser.parts)
    except Exception:
        return value or ""

QUOTE = re.compile(
    r"(?i)^\s*(?:__QUOTED_BLOCK__|>{1,}|\|\s|[-_]{2,}\s*(?:original message|forwarded message)|"
    r"begin forwarded message:|on .{1,240}\bwrote:|(?:from|sent|to|subject|date):\s|"
    r"-----\s*forwarded message)")
SIGNOFF = re.compile(
    r"(?i)^\s*(?:--\s*$|(?:kind |best |warm |with )?regards\b|sincerely\b|"
    r"yours faithfully\b|yours sincerely\b|many thanks\b|thanks\s*[,.!]?$|"
    r"thank you\s*[,.!]?$|cheers\b|sent from my (?:iphone|ipad|mobile)\b)")

def clean_body(message):
    value = (html_text(message.get("body") or "")
             if message.get("body_is_html") else (message.get("body") or ""))
    value = value.replace("\r\n", "\n").replace("\r", "\n").replace("\xa0", " ")
    kept = []
    for line in value.splitlines():
        if QUOTE.search(line) or SIGNOFF.search(line):
            break
        kept.append(line)
    value = "\n".join(kept)
    value = re.sub(r"[ \t]+", " ", value)
    value = re.sub(r"\n\s*\n\s*\n+", "\n\n", value)
    return value.strip()

def search_text(message):
    return str(message.get("subject") or "") + "\n" + clean_body(message)

def norm(value):
    value = unicodedata.normalize("NFKD", str(value or ""))
    value = value.encode("ascii", "ignore").decode("ascii").casefold()
    value = re.sub(r"[^a-z0-9]+", " ", value)
    return re.sub(r"\s+", " ", value).strip()

def scalar(value):
    if isinstance(value, dict):
        value = value.get("name") or value.get("company") or value.get("value") or ""
    if isinstance(value, (list, tuple)):
        value = " ".join(str(item) for item in value if item)
    return str(value or "").strip()

def company_value(message, extraction):
    data = ((extraction or {}).get("payload") or {})
    value = norm(scalar(data.get("endClient")))
    if not value:
        source = str(message.get("subject") or "") + "\n" + clean_body(message)
        match = re.search(
            r"(?im)^\s*(?:end[\s-]*client|client company|company(?: name)?)"
            r"\s*[:\-]\s*([^\n,;|]{2,120})", source)
        if match:
            value = norm(match.group(1))
    value = re.sub(r"\b(proprietary|pty|limited|ltd|cc|inc|npc|soc|sa)\b", " ", value)
    return re.sub(r"\s+", " ", value).strip() or None

def date_value(value):
    if not value:
        return None
    value = str(value).strip()
    for fmt in ("%Y-%m-%d", "%Y/%m/%d", "%d-%m-%Y", "%d/%m/%Y", "%d.%m.%Y",
                "%d-%m-%y", "%d/%m/%y", "%d.%m.%y", "%d %b %Y",
                "%d %B %Y", "%B %d, %Y", "%b %d, %Y"):
        try:
            return dt.datetime.strptime(value, fmt).date()
        except ValueError:
            pass
    return None

def labeled_date(raw, label):
    token = (r"(\d{4}[-/]\d{1,2}[-/]\d{1,2}|"
             r"\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}|"
             r"\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4}|"
             r"[A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4})")
    match = re.search(label + r"\s*:\s*" + token, raw, re.I)
    return date_value(match.group(1)) if match else None

def l1_arrival(raw):
    for match in re.finditer(r"\bArrival\b", raw, re.I):
        chunk = raw[match.start():match.start() + 100]
        found = re.search(r"\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})\b", chunk)
        if found:
            day, month, year = map(int, found.groups())
            year += 2000 if year < 100 else 0
            try:
                return dt.date(year, month, day)
            except ValueError:
                pass
        found = re.search(r"\b(\d{4})-(\d{2})-(\d{2})\b", chunk)
        if found:
            try:
                return dt.date(*map(int, found.groups()))
            except ValueError:
                pass
    return None

def board_class(value):
    raw = str(value or "").casefold()
    compact = norm(raw)
    if (("breakfast" in raw and "dinner" in raw)
            or re.search(r"\bdbb\b", raw, re.I)):
        return "DBB"
    if ("breakfast" in raw or "bed and breakfast" in raw or "b&b" in raw
            or re.search(r"\bbb\b", raw, re.I)):
        return "B&B"
    if "room only" in raw or re.search(r"\bro\b", raw, re.I):
        return "ROOM_ONLY"
    return "OTHER" if compact else None

def room_family(value):
    raw = str(value or "").casefold()
    for cue in ("twin", "queen", "king", "single", "double"):
        if re.search(r"\b" + cue + r"\b", raw):
            return cue
    compact = norm(raw)
    if "deluxe" in compact:
        return "deluxe"
    if "standard" in compact:
        return "standard"
    return compact or None

def specific_room_family(value):
    raw = str(value or "").casefold()
    for cue in ("twin", "queen", "king"):
        if re.search(r"\b" + cue + r"\b", raw):
            return cue
    return None

def parse_party(raw):
    dear = re.search(r"(?im)^\s*Dear\b", raw)
    if not dear:
        return None
    before = raw[:dear.start()]
    lines = [re.sub(r"\s+", " ", line.replace("\xa0", " ")).strip()
             for line in before.splitlines() if line.strip()]
    party_lines = [line for line in lines[4:]
                   if not re.search(r"\bVAT\s+number\b", line, re.I)]
    return norm(" | ".join(party_lines)) or None

def letter_fields(raw):
    room_match = re.search(
        r"Accommodation\s+Type\s*:\s*(.*?)\s+Number\s+of\s+Person\(s\)",
        raw, re.I | re.S)
    room = norm(" ".join(room_match.group(1).split())) if room_match else None
    people = re.search(
        r"Number\s+of\s+Person\(s\)\s*:\s*(\d+)\s*Adult\(s\)\s+and\s*"
        r"(\d+)\s*Child\(ren\)", raw, re.I)
    adults = int(people.group(1)) if people else None
    rate = re.search(
        r"Average\s+Daily\s+rate\s*:\s*ZAR\s*([\d,]+(?:\.\d{1,2})?)",
        raw, re.I)
    adr = None
    if rate:
        try:
            adr = Decimal(rate.group(1).replace(",", ""))
        except InvalidOperation:
            pass
    includes = re.search(r"Rate\s+Includes\s*:\s*([^\r\n]+)", raw, re.I)
    board = board_class(includes.group(1)) if includes else None
    arrival = labeled_date(raw, r"Arrival Date")
    departure = labeled_date(raw, r"Departure Date")
    nights = (departure - arrival).days if arrival and departure else None
    return {"party": parse_party(raw), "room": room, "board": board,
            "adr": adr, "adults": adults, "nights": nights}

def payload(extraction):
    return ((extraction or {}).get("payload") or {})

def ask_arrivals(extraction):
    result = set()
    for stay in payload(extraction).get("stays") or []:
        if not isinstance(stay, dict):
            continue
        value = (stay.get("requested") or {}).get("arrival")
        if value:
            try:
                result.add(dt.date.fromisoformat(str(value)[:10]))
            except ValueError:
                pass
    return result

def link_tokens(message, extraction):
    data = payload(extraction)
    contact = data.get("contact") or {}
    if not isinstance(contact, dict):
        contact = {}
    raw = " ".join((str(message.get("subject") or ""),
                    str(message.get("body") or ""),
                    str(contact.get("name") or ""),
                    str(data.get("agency") or ""),
                    str(data.get("endClient") or "")))
    return set(TOKEN_RE.findall(plain_html(raw).lower()))

def room_rows(extraction):
    result = []
    for stay in payload(extraction).get("stays") or []:
        if isinstance(stay, dict):
            result.extend(row for row in (stay.get("rows") or [])
                          if isinstance(row, dict))
    return result

def integer(value):
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)) and float(value).is_integer():
        return int(value)
    match = re.fullmatch(r"\s*(\d+)\s*", str(value or ""))
    return int(match.group(1)) if match else None

messages = list(rows("messages.jsonl.gz"))
attachments = list(rows("attachments.jsonl.gz"))
extractions = list(rows("extractions.jsonl.gz"))
by_message = {message["id"]: message for message in messages}
latest = {}
for extraction in extractions:
    mid = extraction.get("message_id")
    if mid not in latest or (extraction.get("created_at") or "") > (
            latest[mid].get("created_at") or ""):
        latest[mid] = extraction

inbound = [message for message in messages if message.get("direction") == "inbound"]
own_out = [message for message in messages
           if message.get("direction") == "outbound" and own(sender(message))]
thread_out, recipient_out, sender_in = (
    collections.defaultdict(list), collections.defaultdict(list),
    collections.defaultdict(list))
for message in inbound:
    address, when = sender(message), received(message)
    if address and when:
        sender_in[address].append(when)
for message in own_out:
    thread_out[message.get("thread_id")].append(message)
    recipients = set(emails((message.get("to_addresses") or [])
                            + (message.get("cc_addresses") or [])))
    for address in recipients:
        recipient_out[address].append(message)
for index in (thread_out, recipient_out):
    for values in index.values():
        values.sort(key=lambda message: sent(message) or dt.datetime.min.replace(tzinfo=UTC))
for values in sender_in.values():
    values.sort()

reply_cache = {}
def first_reply(message):
    if message["id"] in reply_cache:
        return reply_cache[message["id"]]
    ask_time, address = received(message), sender(message)
    same_thread = [
        outgoing for outgoing in thread_out.get(message.get("thread_id"), [])
        if sent(outgoing) and ask_time and sent(outgoing) > ask_time
    ]
    if same_thread:
        reply_cache[message["id"]] = same_thread[0]
        return same_thread[0]
    times = sender_in.get(address, [])
    if not ask_time or not times:
        reply_cache[message["id"]] = None
        return None
    lower = bisect.bisect_left(times, ask_time)
    for outgoing in recipient_out.get(address, []):
        when = sent(outgoing)
        if not when or when <= ask_time:
            continue
        if when > ask_time + dt.timedelta(hours=72):
            break
        if bisect.bisect_right(times, when) - lower == 1:
            reply_cache[message["id"]] = outgoing
            return outgoing
    reply_cache[message["id"]] = None
    return None

def make_ask(message):
    address = sender(message)
    extraction = latest.get(message["id"])
    kind = (extraction or {}).get("kind")
    return {
        "id": message["id"], "message": message, "sender": address,
        "domain": domain(address), "time": received(message),
        "thread": message.get("thread_id"), "extraction": extraction,
        "kind": kind, "company": company_value(message, extraction),
        "arrivals": ask_arrivals(extraction),
        "link_tokens": link_tokens(message, extraction),
        "search_text": search_text(message),
        "external": external_nonota(address),
        "core": external_nonota(address) and kind in ("quote", "booking"),
    }

asks = [make_ask(message) for message in inbound
        if sender(message) and received(message)]
ask_by_id = {ask["id"]: ask for ask in asks}
core_asks = [ask for ask in asks if ask["core"]]
external_asks = [ask for ask in asks if ask["external"]]

manifest = {}
with open(os.path.join(BASE, "staff_pdfs.tsv"), encoding="utf-8") as stream:
    for line in stream:
        parts = line.rstrip("\n").split("\t")
        if len(parts) >= 3:
            manifest[parts[0]] = (parts[1], parts[2])

letters, manifest_mismatch = [], 0
for attachment in attachments:
    filename = os.path.basename(attachment.get("filename") or "")
    match = LETTER_RE.match(filename)
    if not match or not filename.lower().endswith(".pdf") or attachment.get("is_inline"):
        continue
    message = by_message.get(attachment.get("message_id"))
    if (not message or message.get("direction") != "outbound"
            or not own(sender(message))):
        continue
    aid = attachment["id"]
    manifest_row = manifest.get(aid)
    if not manifest_row or manifest_row[0] != message["id"]:
        manifest_mismatch += 1
        continue
    text_path = os.path.join(BASE, "pdftxt", aid + ".txt")
    if not os.path.isfile(text_path):
        continue
    with open(text_path, encoding="utf-8", errors="replace") as stream:
        raw = stream.read()
    when = sent(message)
    if not when:
        continue
    recipients = set(emails((message.get("to_addresses") or [])
                            + (message.get("cc_addresses") or [])))
    subject = re.search(
        r"Confirmation Letter_(.*?)\s*\(n[°º]\s*\d",
        message.get("subject") or "", re.I)
    guest = re.sub(r"\s+", " ", subject.group(1)).strip() if subject else ""
    guest_tokens = TOKEN_RE.findall(guest.lower())
    letters.append({
        "aid": aid, "conf": match.group(1), "time": when,
        "message": message, "thread": message.get("thread_id"),
        "recipients": recipients,
        "recipient_domains": {domain(address) for address in recipients},
        "arrival": l1_arrival(raw),
        "surname": guest_tokens[-1] if guest_tokens else "",
        "fields": letter_fields(raw),
    })
letters.sort(key=lambda row: (row["time"], row["aid"]))
by_conf = collections.defaultdict(list)
for letter in letters:
    by_conf[letter["conf"]].append(letter)
conf_ids = set(by_conf)
repeat_ids = {conf for conf, copies in by_conf.items() if len(copies) > 1}
repeat_field_conflicts = collections.Counter()
for conf in repeat_ids:
    for field in FIELDS:
        values = {copy["fields"][field] for copy in by_conf[conf]
                  if copy["fields"][field] is not None}
        if len(values) > 1:
            repeat_field_conflicts[field] += 1

def l1_score(ask, letter):
    exact = ask["sender"] in letter["recipients"]
    same_domain = bool(ask["domain"] and ask["domain"] in letter["recipient_domains"])
    recipient = exact or same_domain
    same_thread = ask["thread"] == letter["thread"]
    if same_thread and not recipient:
        return None
    if (letter["arrival"] and ask["arrivals"]
            and letter["arrival"] not in ask["arrivals"] and not same_thread):
        return None
    surname = bool(letter["surname"] and letter["surname"] in ask["link_tokens"])
    arrival = bool(letter["arrival"] and letter["arrival"] in ask["arrivals"])
    families = sum((recipient, surname, arrival, same_thread))
    score = ((4 if exact else 0) + (1 if same_domain else 0)
             + (3 if surname else 0) + (3 if arrival else 0)
             + (2 if same_thread else 0))
    return score if score >= 7 and families >= 2 else None

event_times = [received(message) for message in messages if received(message)]
first_time, last_time = min(event_times), max(event_times)
corpus_end = last_time.replace(hour=23, minute=59, second=59, microsecond=999999)
eligible_core = set()
for ask in core_asks:
    reply = first_reply(ask["message"])
    when = sent(reply) if reply else None
    if when and when + THREE_DAYS <= corpus_end:
        eligible_core.add(ask["id"])

strict_map, strict_ties = {}, 0
for letter in letters:
    candidates = []
    for ask in core_asks:
        if ask["id"] not in eligible_core:
            continue
        reply = first_reply(ask["message"])
        reply_time = sent(reply) if reply else None
        if not reply_time or not (reply_time <= letter["time"] <= reply_time + THREE_DAYS):
            continue
        score = l1_score(ask, letter)
        if score is not None:
            candidates.append((score, ask))
    if candidates:
        high = max(score for score, _ in candidates)
        winners = [ask for score, ask in candidates if score == high]
        if len(winners) == 1:
            strict_map[letter["aid"]] = winners[0]["id"]
        else:
            strict_ties += 1

wide_map, wide_ambiguous, wide_none = {}, 0, 0
for letter in letters:
    candidates = {}
    lower = letter["time"] - THREE_DAYS
    for recipient in letter["recipients"]:
        if not external_nonota(recipient):
            continue
        for ask in external_asks:
            if ask["sender"] == recipient and lower <= ask["time"] <= letter["time"]:
                candidates[ask["id"]] = ask
    if len(candidates) == 1:
        wide_map[letter["aid"]] = next(iter(candidates))
    elif candidates:
        wide_ambiguous += 1
    else:
        wide_none += 1

def collapse(link_map):
    grouped = collections.defaultdict(list)
    for letter in letters:
        ask_id = link_map.get(letter["aid"])
        if ask_id:
            grouped[letter["conf"]].append((letter, ask_by_id[ask_id]))
    result = []
    for conf, copies in grouped.items():
        copies.sort(key=lambda pair: (pair[0]["time"], pair[0]["aid"]))
        letter, ask = copies[0]
        result.append({
            "conf": conf, "letter_time": letter["time"], "letter": letter,
            "ask": ask, "fields": letter["fields"],
        })
    result.sort(key=lambda row: (row["ask"]["time"], row["conf"]))
    return result

strict_rows, wide_rows = collapse(strict_map), collapse(wide_map)

def split(row):
    if row["ask"]["time"] < CUTOFF:
        return "index"
    if row["ask"]["time"] <= TEST_END:
        return "test"
    return "outside"

def train_test(values):
    train = [row for row in values
             if row["ask"]["time"] < CUTOFF and row["letter_time"] < CUTOFF]
    delayed = [row for row in values
               if row["ask"]["time"] < CUTOFF and row["letter_time"] >= CUTOFF]
    test = [row for row in values if CUTOFF <= row["ask"]["time"] <= TEST_END]
    return train, test, delayed

def mode(values):
    values = [value for value in values if value is not None]
    if not values:
        return None
    counts = collections.Counter(values)
    highest = max(counts.values())
    winners = {value for value, count in counts.items() if count == highest}
    return next(value for value in values if value in winners)

def tokens(value):
    return TOKEN_RE.findall(str(value or "").lower())

def bm25(query, docs, limit=5, k1=1.2, b=0.75):
    if not docs:
        return []
    query_terms = set(tokens(query))
    if not query_terms:
        return []
    df, lengths, counts = collections.Counter(), {}, {}
    for doc_id, doc in docs.items():
        values = doc["tokens"]
        lengths[doc_id] = len(values)
        counts[doc_id] = collections.Counter(values)
        df.update(set(values))
    average = sum(lengths.values()) / len(lengths)
    if not average:
        return []
    scored, total = [], len(docs)
    for doc_id, doc in docs.items():
        score = 0.0
        for term in query_terms:
            tf = counts[doc_id].get(term, 0)
            if not tf:
                continue
            inverse = math.log(1.0 + (total - df[term] + 0.5) / (df[term] + 0.5))
            denominator = tf + k1 * (1.0 - b + b * lengths[doc_id] / average)
            score += inverse * tf * (k1 + 1.0) / denominator
        if score > 0:
            scored.append((score, doc_id, doc))
    scored.sort(key=lambda item: (-item[0], item[1]))
    return scored[:limit]

def bm25_docs(train):
    grouped = collections.defaultdict(list)
    for row in train:
        grouped[row["ask"]["id"]].append(row)
    docs = {}
    for ask_id, values in grouped.items():
        values.sort(key=lambda row: (row["letter_time"], row["conf"]))
        ask = values[0]["ask"]
        docs[ask_id] = {
            "tokens": tokens(ask["search_text"]),
            "labels": {field: mode(row["fields"].get(field) for row in values)
                       for field in FIELDS},
        }
    return docs

def history_rows(ask, train, field, company=False):
    usable = [row for row in train if row["fields"].get(field) is not None]
    if company:
        value = ask.get("company")
        if not value:
            return [], "no-company"
        exact = [row for row in usable
                 if row["ask"]["sender"] == ask["sender"]
                 and row["ask"].get("company") == value]
        if exact:
            return exact, "sender+company-address"
        domain_rows = [row for row in usable
                       if row["ask"]["domain"] == ask["domain"]
                       and row["ask"].get("company") == value]
        return domain_rows, "sender-domain+company" if domain_rows else "no-history"
    exact = [row for row in usable if row["ask"]["sender"] == ask["sender"]]
    if exact:
        return exact, "sender-address"
    domain_rows = [row for row in usable if row["ask"]["domain"] == ask["domain"]]
    return (domain_rows, "sender-domain") if domain_rows else ([], "no-history")

def history_pred(ask, train, field, company=False, confident=False):
    selected, source = history_rows(ask, train, field, company)
    values = [row["fields"].get(field) for row in selected]
    prediction = mode(values)
    if confident and (len(values) < 2 or not values
                      or values.count(prediction) / len(values) < 0.80):
        return None, source, selected
    return prediction, source, selected

def predictions_for(ask, train, global_modes, docs):
    result, detail = {}, {}
    top = bm25(ask["search_text"], docs)
    for field in FIELDS:
        b, b_source, _ = history_pred(ask, train, field)
        bc, _, _ = history_pred(ask, train, field, confident=True)
        d, d_source, _ = history_pred(ask, train, field, company=True)
        dc, _, _ = history_pred(ask, train, field, company=True, confident=True)
        votes = [doc["labels"].get(field) for _, _, doc in top
                 if doc["labels"].get(field) is not None]
        c = mode(votes)
        result[field] = {
            "global": global_modes.get(field), "history": b,
            "history_confident": bc, "bm25_top5": c,
            "sender_company": d, "sender_company_confident": dc,
        }
        detail[field] = {"history_source": b_source, "company_source": d_source}
    return result, detail

MODELS = ("global", "history", "history_confident", "bm25_top5",
          "sender_company", "sender_company_confident")
REPORT_FIELDS = (("party", "party"), ("room type", "room"), ("board", "board"),
                 ("ADR exact", "adr"), ("ADR within 5%", "adr_5pct"),
                 ("adults", "adults"), ("nights", "nights"))

def is_right(metric, prediction, target):
    if prediction is None or target is None:
        return False
    if metric == "adr_5pct":
        return (prediction == target if target == 0
                else abs(prediction - target) / abs(target) <= Decimal("0.05"))
    return prediction == target

def triplet(test, predictions):
    result = {}
    for label, field in REPORT_FIELDS:
        target_field = "adr" if field == "adr_5pct" else field
        observed = [row for row in test if row["fields"].get(target_field) is not None]
        counts = {}
        for model in MODELS:
            right = wrong = abstain = 0
            for row in observed:
                prediction = predictions[row["conf"]][target_field][model]
                if prediction is None:
                    abstain += 1
                elif is_right(field, prediction, row["fields"][target_field]):
                    right += 1
                else:
                    wrong += 1
            counts[model] = (right, wrong, abstain)
        result[label] = (len(observed), counts)
    return result

def frac(n, d):
    return f"{n}/{d}"

def explicit_bill_to(ask):
    source = str(ask["message"].get("subject") or "") + "\n" + clean_body(ask["message"])
    pattern = (r"(?im)^\s*(?:bill\s*to|invoice\s*to|billing\s+(?:company|name)|"
               r"company\s+name)\s*[:\-]\s*([^\n,;|]{2,120})")
    return {norm(value) for value in re.findall(pattern, source) if norm(value)}

def current_values(ask, field):
    text, extraction = ask["search_text"], ask["extraction"]
    data, rows = payload(extraction), room_rows(extraction)
    if field == "party":
        return explicit_bill_to(ask)
    if field == "room":
        values = {specific_room_family(row.get("roomType")) for row in rows}
        values.discard(None)
        if values:
            return values
        return {cue for cue in ("twin", "queen", "king")
                if re.search(r"\b" + cue + r"\b", text, re.I)}
    if field == "board":
        values = {board_class(row.get("board")) for row in rows}
        values.discard(None)
        if values:
            return values
        found = set()
        if re.search(r"\b(?:dbb|dinner\s*(?:and|&)\s*breakfast)\b", text, re.I):
            found.add("DBB")
        if re.search(r"\b(?:b&b|bed\s*(?:and|&)\s*breakfast|breakfast)\b", text, re.I):
            found.add("B&B")
        if re.search(r"\broom\s+only\b|\bRO\b", text, re.I):
            found.add("ROOM_ONLY")
        return found
    if field == "adr":
        pattern = re.compile(
            r"(?i)(?:\bZAR\s*|\bR\s*)(\d{1,3}(?:,\d{3})+|\d{3,6})(?:\.\d{1,2})?"
            r"|(\d{1,3}(?:,\d{3})+|\d{3,6})(?:\.\d{1,2})?\s*(?:ZAR|rand)\b")
        found = set()
        for match in pattern.finditer(text):
            value = next((part for part in match.groups() if part), None)
            if value:
                try:
                    found.add(Decimal(value.replace(",", "")))
                except InvalidOperation:
                    pass
        return found
    if field == "adults":
        found = {integer(row.get("adultsPerRoom")) for row in rows}
        found.discard(None)
        if found:
            return found
        return {int(value) for value in re.findall(r"\b(\d+)\s*adults?\b", text, re.I)}
    if field == "nights":
        found = set()
        for stay in data.get("stays") or []:
            if not isinstance(stay, dict):
                continue
            request = stay.get("requested") or {}
            arrival = date_value(request.get("arrival"))
            departure = date_value(request.get("departure"))
            if arrival and departure:
                found.add((departure - arrival).days)
        if found:
            return found
        return {int(value) for value in re.findall(r"\b(\d+)\s*nights?\b", text, re.I)}
    return set()

def room_mention(room, text):
    label, body = norm(room), norm(text)
    if not label:
        return False, False
    full = label in body
    generic = {"standard", "room", "accommodation", "type", "category", "bed"}
    distinctive = [word for word in label.split() if word not in generic]
    cue = bool(distinctive) and all(
        re.search(r"\b" + re.escape(word) + r"\b", text, re.I)
        for word in distinctive)
    return full, full or cue

def party_recall(test, train, predictions):
    wrong = seen = absent = 0
    sources = collections.Counter()
    for row in test:
        target = row["fields"].get("party")
        if target is None:
            continue
        value = predictions[row["conf"]]["party"]["history"]
        history, source = history_rows(row["ask"], train, "party")
        sources[source] += 1
        if value is None or value == target:
            continue
        wrong += 1
        known = {past["fields"]["party"] for past in history}
        if target in known:
            seen += 1
        else:
            absent += 1
    return wrong, seen, absent, sources

def contradictions(test, train):
    unique = {row["ask"]["id"]: row["ask"] for row in test}
    result = {}
    for field in FIELDS:
        explicit = comparable = mismatch = 0
        for ask in unique.values():
            values = current_values(ask, field)
            if len(values) != 1:
                continue
            explicit += 1
            prediction, _, _ = history_pred(ask, train, field)
            if prediction is None:
                continue
            comparable += 1
            current = next(iter(values))
            if field == "party":
                different = current not in prediction
            elif field == "room":
                different = room_family(prediction) != current
            else:
                different = prediction != current
            mismatch += int(different)
        result[field] = (explicit, comparable, mismatch, len(unique))
    return result

def report_cohort(name, cohort, ask_denominator, linked_copies):
    train, test, delayed = train_test(cohort)
    print("COHORT", name,
          "linked_ids=" + frac(len(cohort), len(conf_ids)),
          "linked_asks=" + frac(len({row['ask']['id'] for row in cohort}), ask_denominator),
          "linked_copies=" + frac(linked_copies, len(letters)),
          "train=" + frac(len(train), len(cohort)),
          "test=" + frac(len(test), len(cohort)),
          "precut_letter_after_cut=" + frac(len(delayed), len(cohort)),
          "test_unique_asks=" + frac(len({row['ask']['id'] for row in test}), len(test)))
    for field in FIELDS:
        full = sum(row["fields"].get(field) is not None for row in cohort)
        heldout = sum(row["fields"].get(field) is not None for row in test)
        print("COVERAGE", name, field,
              frac(full, len(cohort)), "test=" + frac(heldout, len(test)))
    for subset, values in (("index", train), ("test", test)):
        kinds = collections.Counter(row["ask"]["kind"] or "not_found" for row in values)
        for kind, number in sorted(kinds.items()):
            print("KIND", name, subset, kind, frac(number, len(values)))
    global_modes = {
        field: mode(row["fields"].get(field) for row in train)
        for field in FIELDS
    }
    docs = bm25_docs(train)
    predictions, detail = {}, {}
    for row in test:
        predictions[row["conf"]], detail[row["conf"]] = predictions_for(
            row["ask"], train, global_modes, docs)
    for label, (number, results) in triplet(test, predictions).items():
        print("METRIC", name, label, "gold=" + frac(number, len(test)),
              *(model + ":" + ",".join(frac(value, number) for value in results[model])
                for model in MODELS))
    wrong, seen, absent, sources = party_recall(test, train, predictions)
    party_n = sum(row["fields"].get("party") is not None for row in test)
    print("PARTY_RECALL", name,
          "wrong=" + frac(wrong, party_n),
          "target_in_key_history=" + frac(seen, wrong),
          "target_absent=" + frac(absent, wrong),
          *(source + ":" + frac(number, party_n)
            for source, number in sorted(sources.items())))
    room_targets = [row for row in test if row["fields"].get("room") is not None]
    full = cue = 0
    for row in room_targets:
        has_full, has_cue = room_mention(row["fields"]["room"], row["ask"]["search_text"])
        full += int(has_full)
        cue += int(has_cue)
    print("ROOM_TEXT", name,
          "full=" + frac(full, len(room_targets)),
          "full_or_discriminative_cue=" + frac(cue, len(room_targets)))
    for field, (explicit, comparable, mismatch, ask_count) in contradictions(test, train).items():
        print("CURRENT_VS_HISTORY", name, field,
              "explicit=" + frac(explicit, ask_count),
              "history=" + frac(comparable, explicit),
              "differs=" + frac(mismatch, comparable))
    test_asks = {row["ask"]["id"]: row["ask"] for row in test}
    company_count = sum(bool(ask.get("company")) for ask in test_asks.values())
    print("COMPANY_KEY", name,
          "test_asks_with_company=" + frac(company_count, len(test_asks)))
    print("BM25_INDEX", name,
          "unique_index_asks=" + frac(len(docs), len({row["ask"]["id"] for row in train})))
    for field in FIELDS:
        field_rows = [row for row in test if row["fields"].get(field) is not None]
        sources = collections.Counter(
            detail[row["conf"]][field]["company_source"] for row in field_rows)
        print("D_SOURCE", name, field,
              *(source + ":" + frac(number, len(field_rows))
                for source, number in sorted(sources.items())))

def month(value):
    return value.strftime("%Y-%m")

def months_between(first, last):
    cursor = dt.date(first.year, first.month, 1)
    end = dt.date(last.year, last.month, 1)
    while cursor <= end:
        yield f"{cursor.year:04d}-{cursor.month:02d}"
        cursor = dt.date(cursor.year + (cursor.month == 12),
                         1 if cursor.month == 12 else cursor.month + 1, 1)

inbound_month = collections.Counter(month(received(message)) for message in inbound
                                    if received(message))
letter_month = collections.Counter(month(letter["time"]) for letter in letters)
first_by_conf = {conf: copies[0] for conf, copies in by_conf.items()}
unique_month = collections.Counter(month(letter["time"])
                                   for letter in first_by_conf.values())

print("WINDOW", first_time.isoformat().replace("+00:00", "Z"),
      last_time.isoformat().replace("+00:00", "Z"))
print("INVENTORY",
      "messages=" + frac(len(messages), len(messages)),
      "inbound=" + frac(len(inbound), len(inbound)),
      "external_nonota=" + frac(len(external_asks), len(inbound)),
      "core_quote_booking=" + frac(len(core_asks), len(inbound)),
      "latest_extractions=" + frac(len(latest), len(extractions)),
      "letter_copies=" + frac(len(letters), len(letters)),
      "unique_conf_ids=" + frac(len(conf_ids), len(conf_ids)),
      "repeated_conf_ids=" + frac(len(repeat_ids), len(conf_ids)),
      "manifest_mismatch=" + frac(manifest_mismatch, len(letters)))
print("REPEATED_FIELD_CONFLICTS",
      *(field + "=" + frac(repeat_field_conflicts[field], len(repeat_ids))
        for field in FIELDS))
print("STRICT_ELIGIBLE_CORE", frac(len(eligible_core), len(core_asks)))
print("STRICT_TIES", frac(strict_ties, len(letters)))
print("WIDE_COPY_STATUS",
      "ambiguous=" + frac(wide_ambiguous, len(letters)),
      "no_candidate=" + frac(wide_none, len(letters)))
report_cohort("strict_l1_core", strict_rows, len(core_asks), len(strict_map))
report_cohort("wide_exact_recipient_3d", wide_rows, len(external_asks), len(wide_map))
strict_ids = {row["conf"] for row in strict_rows}
wide_ids = {row["conf"] for row in wide_rows}
overlap = strict_ids & wide_ids
wide_ask = {row["conf"]: row["ask"]["id"] for row in wide_rows}
strict_ask = {row["conf"]: row["ask"]["id"] for row in strict_rows}
same_ask = sum(strict_ask[conf] == wide_ask[conf] for conf in overlap)
print("LINK_OVERLAP",
      "conf_ids=" + frac(len(overlap), len(conf_ids)),
      "same_ask=" + frac(same_ask, len(overlap)))

for value in months_between(first_time.date(), last_time.date()):
    print("MONTH", value,
          "inbound=" + frac(inbound_month[value], len(inbound)),
          "letter_copies=" + frac(letter_month[value], len(letters)),
          "unique_ids_first_seen=" + frac(unique_month[value], len(conf_ids)))
~~~
