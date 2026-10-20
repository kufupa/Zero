# L6 — Precedent-retrieval baseline

## Answer

- **(inference) Plain BM25 is a weak answer-type predictor, not a workflow selector.** On paired asks received 2026-09-28–2026-10-13 UTC, top-1 type agreement is 255/411; top-5 majority is 302/411, versus 301/411 for global majority (Appendix A1).
- The time split yields 483/3,818 paired index asks before 2026-09-28 and 411/1,202 paired heldout asks from 2026-09-28–2026-10-13. Metrics cover answered asks only (A1).
- Same sender-domain appears in top-5 for 182/411 heldout asks. The sender-domain majority baseline is correct for 203/284 heldout asks with domain history, covering 284/411 total (A1).
- Top-1 board agreement is 9/9 when both boards are known, but only 9/411 heldout pairs are comparable (A1).
- Manual review marked 6/20 samples useful, 13/20 partly useful, and 1/20 not useful at top-3; sample seed and masked reasons are below (A1).
- **(inference) A memory framework should beat both top-5 BM25 and the trivial majority, and show more directly useful precedents—not only a higher answer-type score.** This lane does not compare Graphiti, mem0, or Letta.

## Method

- Scope: read-only local corpus, 2026-07-30–2026-10-13. Inputs: [messages.jsonl.gz](/home/orca/nava-research/corpus/2026-10-13/messages.jsonl.gz), [attachments.jsonl.gz](/home/orca/nava-research/corpus/2026-10-13/attachments.jsonl.gz), [staff_pdfs.tsv](/home/orca/nava-research/corpus/2026-10-13/staff_pdfs.tsv), and [pdftxt/](/home/orca/nava-research/corpus/2026-10-13/pdftxt/). No external web/network, production, HMS, or Git access.
- Ask: inbound sender domain is not legacyhotels.co.za / legacyhotels.com and does not contain an OTA/channel token from the brief. Pair each ask with the first later outbound message from an own-domain sender in the same thread, sent within 3 days. Use received_at for asks and sent_at for replies, with the opposite timestamp as fallback. Split by UTC ask date: index before 2026-09-28; query 2026-09-28–2026-10-13 inclusive.
- Retrieval text: subject + inbound body after stdlib HTML-to-text conversion and heuristic stripping of signatures/quoted history. Search asks only; answer features are labels, not query terms.
- BM25: pure Python stdlib; k1=1.2, b=0.75, standard positive IDF; unique query terms, no stopword removal or stemming; return only positive-score hits, top-5, message-ID tie-break.
- Answer labels from first reply attachment filenames: HRCEN letter > hand “Quote” PDF > Excel > pro forma PDF > other PDF. Replies with unsupported non-image files use an extra “other attachment” class because the requested list has no class for them. Multiple types follow that priority.
- **(inference) Main label rule ignores non-inline files named like numbered Office images (ImageNNN) as presentation assets.** Their is_inline flag is false, so the rule is uncertain; the image-inclusive sensitivity below shows the effect. “Text only” means no supported answer artifact remains.
- Other answer features: ? in first 600 characters of stripped new reply text; board/rate cues from reply text + attached PDF text; PDF field cues for room type, ADR/per-night, rate includes, party line. BAR requires uppercase BAR or “best available rate”. Field rows report cue presence only, not extracted values.
- Manifest join: the headerless TSV’s first column matched attachment IDs and second matched message IDs for 2,162/2,162 rows each. A1 checks these joins before reading pdftxt.
- Baselines: global most-frequent answer type in index; exact sender-domain most-frequent type from index only (unseen domains have no prediction). Majority@5 ties go to the highest-ranked label. Board agreement compares query answer with top-1 neighbor, only when both have one unambiguous board label.
- Manual audit: 20 query pairs sampled with seed 20261020 after stable message-ID ordering. Human labels use only de-identified business-cue sequences and top-3 answer metadata; no raw bodies, names, emails, phone numbers, or bank details are printed. Reasons are judgment (inference), not machine labels.
- Route: local corpus, no web search or subagents. Runtime did not expose model-dollar cost. All computed counts below come from Appendix A1; manual labels are explicitly human-coded.

## Findings

All ratios use Appendix A1. Pair windows are by ask received date in UTC.

### Pair coverage

| Slice | Eligible external, non-OTA asks | Paired ask → first reply within 3 days |
|---|---:|---:|
| Index: 2026-07-30–2026-09-27 | 3,818 | 483/3,818 |
| Heldout: 2026-09-28–2026-10-13 | 1,202 | 411/1,202 |

These are message-pair counts, not unique threads.

### First-reply answer type

| Answer type | Index, pre-2026-09-28 | Heldout, 2026-09-28–2026-10-13 |
|---|---:|---:|
| HRCEN letter | 3/483 | 1/411 |
| Hand “Quote” PDF | 19/483 | 13/411 |
| Excel | 2/483 | 1/411 |
| Pro forma PDF | 6/483 | 6/411 |
| Other PDF | 93/483 | 68/411 |
| Text only | 338/483 | 301/411 |
| Other attachment | 22/483 | 21/411 |

### Retrieval and trivial baselines

| Measure | Heldout result |
|---|---:|
| BM25 subject + body, answer type agreement @1 | 255/411 |
| BM25 subject + body, answer-type majority @5 | 302/411 |
| Global majority answer type (text only, index history only) | 301/411 |
| Sender-domain majority, among domains with index history | 203/284 |
| Sender-domain-majority coverage | 284/411 |
| Same sender-domain hit in BM25 top-5 | 182/411 |
| Non-empty BM25 top-5 | 411/411 |

BM25 majority@5 gains only 1/411 query over global majority. Top-1 loses to it by 46/411 queries.

### Text variants

| Retrieval text | Type agreement @1 | Majority @5 | Same sender-domain hit @5 |
|---|---:|---:|---:|
| Subject + body | 255/411 | 302/411 | 182/411 |
| Subject only | 242/411 | 283/411 | 157/411 |
| Body only | 240/411 | 277/411 | 137/411 |

Same-domain-filtered BM25 had index history for 284/411 queries and returned a positive hit for 283/411. Its type agreement was 177/411 and majority@5 was 203/411.

### Answer features available in heldout first replies

| Feature cue | Count |
|---|---:|
| ? in first 600 chars of stripped reply | 12/411 |
| Board B&B only | 12/411 |
| Board DBB/dinner only | 20/411 |
| Both board groups present | 7/411 |
| No board cue found | 372/411 |
| Government rate word | 0/411 |
| Contract rate word | 2/411 |
| BAR / “best available rate” cue | 5/411 |
| Reply has mapped PDF text | 88/411 |
| PDF cue: room type | 7/88 |
| PDF cue: ADR / per-night | 3/88 |
| PDF cue: rate includes | 1/88 |
| PDF cue: party line | 30/88 |

These PDF counts cover all PDF-bearing replies, not only HRCEN letters. Field values were not normalized; absent cues are “not found”.

### Board agreement and file-label sensitivity

- Top-1 board agreement: 9/9 comparisons where both query and neighbor had a known, unambiguous board; comparison coverage was 9/411. Query answer board was known for 32/411.
- Numbered Office-style image names appeared in 1,814/1,834 non-inline image attachment occurrences in heldout pair replies. A1 found 226/411 replies whose only non-inline files had those names. **(inference)** They are probably presentation/signature images, not answer artifacts, but metadata does not prove that.

| File-label rule | BM25 @1 | BM25 majority @5 | Global majority |
|---|---:|---:|---:|
| Primary: ignore numbered Office-style images | 255/411 | 302/411 | Text only, 301/411 |
| Sensitivity: count every non-inline file | 213/411 | 255/411 | Other attachment, 247/411 |

The image-inclusive query labels were other attachment 247/411 and text only 75/411; all other labels stayed as in the answer-type table.

### Manual top-3 usefulness review

20 random heldout pairs received 2026-09-28–2026-10-13 UTC, seed 20261020 (A1). Useful counts only direct precedents; partly is not counted in useful@3. Each reason is judgment (inference), summarized without mail text.

| Sample | Label | Masked reason |
|---|---|---|
| Q01 | Useful | (inference) Same voucher task and PDF-style reply; top neighbor also shares sender domain. |
| Q02 | Partly | (inference) One cancellation/payment neighbor, but other top results are generic confirmation/booking cases. |
| Q03 | Partly | (inference) Room-booking overlap; top results include a booking change, so operation may differ. |
| Q04 | Partly | (inference) Corporate accommodation/voucher overlap; cancellation and meal details are missing. |
| Q05 | Partly | (inference) Payment-only ask; top results share broad payment language, little task detail. |
| Q06 | Partly | (inference) Group/company/payment overlap, but top results split across unrelated booking and invoice forms. |
| Q07 | Useful | (inference) Same quote, date, room/occupancy, and B&B cues appear in top results. |
| Q08 | Partly | (inference) Group/departure overlap; confirmation-specific action is unclear. |
| Q09 | Partly | (inference) Hotel payment/invoice overlap; retrieved answer forms differ from target PDF. |
| Q10 | Partly | (inference) Voucher/invoice overlap, but booking and meal details make top results mixed. |
| Q11 | Partly | (inference) Accommodation/voucher overlap; travel-specific task is not clear in neighbors. |
| Q12 | Partly | (inference) Confirmation/invoice overlap; top replies mostly lack the target PDF/board details. |
| Q13 | Partly | (inference) Room/rate quote overlap, but group and occupancy options do not line up cleanly. |
| Q14 | Useful | (inference) Near-repeated same-domain room/board booking ask and same text-only answer form. |
| Q15 | Useful | (inference) Dinner reservation/allocation neighbor also carries DBB cue; artifact type differs. |
| Q16 | Partly | (inference) One room-rate/occupancy neighbor; other top results are generic corporate mail. |
| Q17 | No | (inference) Invoice ask retrieved quotation/rate precedents, not invoice precedents. |
| Q18 | Partly | (inference) Booking overlap, but change/payment state differs or is absent. |
| Q19 | Useful | (inference) Paid confirmation/payment/invoice cues recur across top results with text replies. |
| Q20 | Useful | (inference) Government-rate and DBB cues recur strongly; one neighbor has a quote PDF. |

Useful@3 = 6/20. Useful-or-partly = 19/20. These are small-sample human judgments, not an automatic metric.

### Time-split and duplicate-reply checks

| Check | Result |
|---|---:|
| Index pairs whose first reply date is on/after the query cutoff | 2/483 |
| First-reply message IDs shared across index/query | 1/354 unique query replies |
| Unique first replies / index ask-pairs | 401/483 |
| Unique first replies / heldout ask-pairs | 354/411 |
| BM25 after excluding post-cutoff/shared replies from index: index size | 481/483 |
| Same causal index, type agreement @1 | 259/411 |
| Same causal index, majority @5 | 302/411 |
| One heldout ask per unique first reply: type agreement @1 | 213/354 |
| One heldout ask per unique first reply: majority @5 | 259/354 |
| 2026-10-11–2026-10-13 candidates with no reply observed in corpus | 175/241 |

## What this means for the agent/pane

- **(inference) Put precedents beside the work, not in charge of routing.** Pane order should be: current ask/payment state → current HMS facts → similar asks + staff answers → staff review/approval.
- **(inference) Show top-3 precedents with why they matched and their answer metadata.** Useful cues: sender-domain match, answer artifact, board/rate terms, and PDF field availability. Keep not found distinct from a guessed value.
- **(inference) Do not use sender-domain majority as a rule.** It covers 284/411 queries and predicts correctly for 203/284 covered queries; it leaves a large uncovered set and still mislabels known senders.
- **(inference) The very low HRCEN count in first replies may be a thread-boundary effect.** The shared lifecycle evidence says the auto confirmation letter lands in its own thread; this same-thread pairing finds only 1/411 HRCEN-letter answers. A precedent feature may need an explicit follow-up-letter relationship.
- **(inference) Keep retrieval advisory.** Similar old mail is not current inventory or payment truth; staff approval remains required for every HMS write.

## Open gaps

- The heldout metrics describe paired asks only: 411/1,202 candidates. The corpus ends 2026-10-13; among asks received 2026-10-11–2026-10-13, 175/241 have no reply observed before the corpus ends. Some may be right-censored rather than unanswered (inference).
- The pair rule uses the first own-domain outbound in the same thread. It cannot reliably separate staff mail from own-domain automation, and it misses useful replies in separate threads (inference).
- Answer type is sensitive to the numbered-image decision. is_inline=false conflicts with treating those names as presentation assets; image-inclusive sensitivity is included, but filename-only data cannot settle it (inference).
- Question detection is a punctuation proxy; HTML conversion and quote/signature removal are heuristic. Board/rate detection is keyword-based.
- PDF fields are cue-presence only, not values. Excel contents were not extracted. This lane does not test whether structured fields improve retrieval.
- Repeated first-reply IDs make pairs non-independent; causal-index and unique-reply sensitivities are reported. Manual review has only 20 judgments.
- Recency weighting was not run. No memory framework was benchmarked. **95 threshold is met for this lexical baseline, not for choosing a memory framework** (inference).

## Appendix (scripts)

### A1. Reproduce counts and safe manual sample

Run with Python 3 and standard library only. Paste this block to stdin using Python 3. It prints aggregate counts and whitelisted business cues only; manual judgments are human-coded at the bottom.

```python
import os, re, gzip, json, csv, math, random, bisect, collections
from datetime import datetime, timezone, timedelta, date
from email.utils import parseaddr
from html.parser import HTMLParser

BASE = "/home/orca/nava-research/corpus/2026-10-13"
START, CUT, END = date(2026, 7, 30), date(2026, 9, 28), date(2026, 10, 13)
OWN = {"legacyhotels.co.za", "legacyhotels.com"}
OTA = ("synxis", "booking.com", "expedia", "webbeds", "hotelbeds",
       "profitroom", "siteminder", "ratetiger", "tiket")

def jsonl_gz(name):
    with gzip.open(os.path.join(BASE, name), "rt", encoding="utf-8") as f:
        for line in f:
            if line.strip():
                yield json.loads(line)

def sender_domain(raw):
    address = parseaddr(raw or "")[1]
    return address.rsplit("@", 1)[-1].lower().strip() if "@" in address else ""

def parse_ts(raw):
    if not raw:
        return None
    try:
        dt = datetime.fromisoformat(raw.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)

def message_ts(message, direction):
    primary = message.get("received_at") if direction == "inbound" else message.get("sent_at")
    fallback = message.get("sent_at") if direction == "inbound" else message.get("received_at")
    return parse_ts(primary) or parse_ts(fallback)

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
        if self.hidden:
            return
        if tag in self.BLOCK:
            self.parts.append("\n")

    def handle_data(self, data):
        if not self.hidden:
            self.parts.append(data)

def html_to_text(value):
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

def new_text(body, is_html=False):
    value = html_to_text(body) if is_html else (body or "")
    value = value.replace("\r\n", "\n").replace("\r", "\n").replace("\xa0", " ")
    lines = []
    for line in value.splitlines():
        if QUOTE.search(line) or SIGNOFF.search(line):
            break
        lines.append(line)
    value = "\n".join(lines)
    value = re.sub(r"[ \t]+", " ", value)
    value = re.sub(r"\n\s*\n\s*\n+", "\n\n", value)
    return value.strip()

def ask_body(message):
    return new_text(message.get("body") or "", bool(message.get("body_is_html")))

def ask_text(message):
    return ((message.get("subject") or "").strip() + "\n" + ask_body(message)).strip()

def true_value(value):
    return value is True or str(value or "").strip().lower() in {"true", "1", "yes"}

def office_image(filename):
    stem = os.path.splitext(os.path.basename(filename or "").lower())[0]
    return bool(re.fullmatch(r"image\s*\d+(?:\s*\(\d+\))?", stem))

def file_flags(filename):
    name = (filename or "").lower()
    compact = re.sub(r"[^a-z0-9]", "", name)
    ext = os.path.splitext(name)[1]
    return {
        "pdf": ext == ".pdf",
        "excel": ext in {".xls", ".xlsx", ".xlsm", ".xlsb"},
        "hrcen": "hrcen" in compact and "confirmation" in compact,
        "quote": "quote" in compact and ext == ".pdf",
        "proforma": "proforma" in compact and ext == ".pdf",
    }

def answer_type(files, ignore_office_images=True):
    files = [a for a in files if not true_value(a.get("is_inline")) and
             not (ignore_office_images and office_image(a.get("filename")))]
    if not files:
        return "text only"
    flags = [file_flags(a.get("filename")) for a in files]
    for key, label in (("hrcen", "HRCEN letter"),
                       ("quote", "hand Quote PDF"),
                       ("excel", "Excel"),
                       ("proforma", "pro forma"),
                       ("pdf", "other PDF")):
        if any(f[key] for f in flags):
            return label
    return "other attachment"

def answer_board(text):
    bb = bool(re.search(r"(?i)\bB\s*&\s*B\b|\bbed\s+and\s+breakfast\b", text))
    dbb = bool(re.search(r"(?i)\bDBB\b|\bdinner\b", text))
    if bb and dbb:
        return "both/ambiguous"
    if bb:
        return "B&B"
    if dbb:
        return "DBB/dinner"
    return "not found"

def answer_rates(text):
    found = []
    if re.search(r"(?i)\bgovernment\b|\bgovt\b", text):
        found.append("government")
    if re.search(r"(?i)\bcontract(?:ed)?\b", text):
        found.append("contract")
    if re.search(r"\bBAR\b|(?i:best available rate)", text):
        found.append("BAR")
    return found

def pdf_field_cues(text):
    return {
        "room type": bool(re.search(
            r"\broom\s*(?:type|category|description)\b|\baccommodation\s*type\b", text, re.I)),
        "ADR / per-night cue": bool(re.search(
            r"\bADR\b|average\s+daily\s+rate|rate\s*(?:per|/)\s*night", text, re.I)),
        "rate includes": bool(re.search(
            r"\brate\s+includes\b|includes\s+the\s+following|rate\s+inclusive", text, re.I)),
        "party line": bool(re.search(
            r"\bparty\s+(?:line|of\s+\d+)\b|\b\d+\s+(?:adults?|guests?|pax|persons?|people)\b|"
            r"\b(?:adults?|guests?|pax)\s*[:=]\s*\d+\b", text, re.I)),
    }

messages = list(jsonl_gz("messages.jsonl.gz"))
message_ids = {m.get("id") for m in messages}
attachments = list(jsonl_gz("attachments.jsonl.gz"))
attachment_ids = {a.get("id") for a in attachments}
attachments_by_message = collections.defaultdict(list)
for attachment in attachments:
    attachments_by_message[attachment.get("message_id")].append(attachment)

pdf_by_message = collections.defaultdict(list)
manifest = []
with open(os.path.join(BASE, "staff_pdfs.tsv"), encoding="utf-8") as f:
    for row in csv.reader(f, delimiter="\t"):
        if len(row) == 3:
            manifest.append(row)
            # Headerless file: validated first column = attachment ID; second = message ID.
            attachment_id, message_id, _path = row
            path = os.path.join(BASE, "pdftxt", attachment_id + ".txt")
            if os.path.isfile(path):
                with open(path, encoding="utf-8", errors="replace") as tf:
                    pdf_by_message[message_id].append(tf.read())

out_by_thread = collections.defaultdict(list)
for message in messages:
    if message.get("direction") != "outbound":
        continue
    if sender_domain(message.get("from_address")) not in OWN:
        continue
    ts = message_ts(message, "outbound")
    if ts:
        out_by_thread[message.get("thread_id")].append((ts, message))
for values in out_by_thread.values():
    values.sort(key=lambda item: (item[0], item[1].get("id") or ""))
out_times = {thread: [item[0] for item in values]
             for thread, values in out_by_thread.items()}

candidates, pairs = [], []
received_fallbacks = 0
for message in messages:
    if message.get("direction") != "inbound":
        continue
    domain = sender_domain(message.get("from_address"))
    if not domain or domain in OWN or any(token in domain for token in OTA):
        continue
    if not message.get("received_at"):
        received_fallbacks += 1
    ts = message_ts(message, "inbound")
    if not ts or not (START <= ts.date() <= END):
        continue
    candidate = {
        "ask": message, "domain": domain, "ask_ts": ts,
        "ask_body": ask_body(message), "ask_text": ask_text(message),
    }
    candidates.append(candidate)
    thread = message.get("thread_id")
    values = out_by_thread.get(thread, [])
    pos = bisect.bisect_right(out_times.get(thread, []), ts)
    if pos == len(values):
        continue
    reply_ts, reply = values[pos]
    if reply_ts - ts > timedelta(days=3):
        continue

    files = attachments_by_message.get(reply.get("id"), [])
    pdfs = pdf_by_message.get(reply.get("id"), [])
    reply_text = new_text(reply.get("body") or "", bool(reply.get("body_is_html")))
    combined_answer = reply_text + "\n" + "\n".join(pdfs)
    fields = {key: any(pdf_field_cues(text)[key] for text in pdfs)
              for key in ("room type", "ADR / per-night cue", "rate includes", "party line")}
    pairs.append({
        **candidate, "reply": reply, "reply_ts": reply_ts,
        "answer_type": answer_type(files, True),
        "answer_type_allfiles": answer_type(files, False),
        "question": "?" in reply_text[:600],
        "board": answer_board(combined_answer),
        "rates": answer_rates(combined_answer),
        "fields": fields, "pdftexts": pdfs,
    })

index = [p for p in pairs if p["ask_ts"].date() < CUT]
queries = [p for p in pairs if CUT <= p["ask_ts"].date() <= END]
index_candidates = [p for p in candidates if p["ask_ts"].date() < CUT]
query_candidates = [p for p in candidates if CUT <= p["ask_ts"].date() <= END]

# Verify manifest IDs by exact joins, without printing paths or filenames.
manifest_attach_matches = sum(row[0] in attachment_ids for row in manifest)
manifest_message_matches = sum(row[1] in message_ids for row in manifest)
print("manifest attachment-ID joins", manifest_attach_matches, "/", len(manifest))
print("manifest message-ID joins", manifest_message_matches, "/", len(manifest))
print("paired asks / eligible asks: index", len(index), "/", len(index_candidates),
      "; query", len(queries), "/", len(query_candidates))

print("index answer types", dict(collections.Counter(p["answer_type"] for p in index)))
print("query answer types", dict(collections.Counter(p["answer_type"] for p in queries)))
print("query reply question-mark cue", sum(p["question"] for p in queries), "/", len(queries))
print("query answer boards", dict(collections.Counter(p["board"] for p in queries)))
print("query answer rate cues", {
    tag: sum(tag in p["rates"] for p in queries)
    for tag in ("government", "contract", "BAR")
})
pdf_queries = [p for p in queries if p["pdftexts"]]
print("query replies with pdftxt", len(pdf_queries), "/", len(queries))
print("query PDF field cues", {
    key: sum(p["fields"][key] for p in queries)
    for key in ("room type", "ADR / per-night cue", "rate includes", "party line")
}, "of", len(pdf_queries), "PDF-bearing answers")

image_files = []
image_only_pairs = 0
for p in queries:
    files = [a for a in attachments_by_message.get(p["reply"].get("id"), [])
             if not true_value(a.get("is_inline"))]
    imgs = [a for a in files if os.path.splitext((a.get("filename") or "").lower())[1]
            in {".png", ".jpg", ".jpeg", ".gif", ".heic"}]
    image_files.extend(imgs)
    if files and all(office_image(a.get("filename")) for a in files):
        image_only_pairs += 1
numbered_images = sum(office_image(a.get("filename")) for a in image_files)
print("office-numbered image attachment occurrences / image occurrences",
      numbered_images, "/", len(image_files))
print("query pairs with only numbered Office-style images", image_only_pairs, "/", len(queries))

WORD = re.compile(r"[^\W_]+", re.UNICODE)
def tokens(text):
    return WORD.findall((text or "").lower())

class BM25:
    def __init__(self, documents, text_getter):
        self.documents = documents
        self.n = len(documents)
        self.tf, self.lengths = [], []
        self.postings = collections.defaultdict(list)
        df = collections.Counter()
        for i, doc in enumerate(documents):
            tf = collections.Counter(tokens(text_getter(doc)))
            self.tf.append(tf)
            self.lengths.append(sum(tf.values()))
            for term, freq in tf.items():
                self.postings[term].append((i, freq))
                df[term] += 1
        self.avgdl = sum(self.lengths) / self.n if self.n else 0.0
        self.idf = {term: math.log(1 + (self.n - freq + 0.5) / (freq + 0.5))
                    for term, freq in df.items()}
        self.k1, self.b = 1.2, 0.75

    def search(self, query, k=5):
        scores = collections.defaultdict(float)
        if not self.n or not self.avgdl:
            return []
        for term in set(tokens(query)):
            if term not in self.idf:
                continue
            for i, tf in self.postings[term]:
                denominator = tf + self.k1 * (1 - self.b + self.b * self.lengths[i] / self.avgdl)
                scores[i] += self.idf[term] * tf * (self.k1 + 1) / denominator
        ranked = sorted(
            ((i, score) for i, score in scores.items() if score > 0),
            key=lambda item: (-item[1], self.documents[item[0]]["ask"].get("id") or "")
        )
        return [(self.documents[i], score) for i, score in ranked[:k]]

def answer_majority(neighbors, label_key):
    if not neighbors:
        return None
    counts = collections.Counter(p[label_key] for p, _ in neighbors)
    highest = max(counts.values())
    return next(p[label_key] for p, _ in neighbors if counts[p[label_key]] == highest)

def evaluate(model, sample, query_text=lambda p: p["ask_text"], label_key="answer_type"):
    result = collections.Counter()
    board_matches = board_comparable = board_query_known = 0
    for query in sample:
        neighbors = model.search(query_text(query), 5)
        result["retrieved"] += bool(neighbors)
        result["type1"] += bool(
            neighbors and neighbors[0][0][label_key] == query[label_key])
        prediction = answer_majority(neighbors, label_key)
        result["majority5"] += bool(prediction and prediction == query[label_key])
        result["domain5"] += any(p["domain"] == query["domain"] for p, _ in neighbors)
        qboard = query["board"] if query["board"] in {"B&B", "DBB/dinner"} else None
        if qboard:
            board_query_known += 1
        nboard = neighbors[0][0]["board"] if neighbors else None
        if nboard not in {"B&B", "DBB/dinner"}:
            nboard = None
        if qboard and nboard:
            board_comparable += 1
            board_matches += qboard == nboard
    return {
        "retrieved": result["retrieved"], "type1": result["type1"],
        "majority5": result["majority5"], "domain5": result["domain5"],
        "board_match": board_matches, "board_comparable": board_comparable,
        "board_query_known": board_query_known,
    }

main = BM25(index, lambda p: p["ask_text"])
main_metrics = evaluate(main, queries)
print("BM25 subject+body metrics", main_metrics, "/", len(queries))

index_types = collections.Counter(p["answer_type"] for p in index)
global_type = min(index_types, key=lambda label: (-index_types[label], label))
global_hits = sum(p["answer_type"] == global_type for p in queries)
domain_types = collections.defaultdict(collections.Counter)
for p in index:
    domain_types[p["domain"]][p["answer_type"]] += 1
domain_covered = [p for p in queries if p["domain"] in domain_types]
domain_hits = sum(
    p["answer_type"] == min(
        domain_types[p["domain"]],
        key=lambda label: (-domain_types[p["domain"]][label], label))
    for p in domain_covered)
print("global-majority baseline", global_type, global_hits, "/", len(queries))
print("sender-domain majority", domain_hits, "/", len(domain_covered),
      "covered; coverage", len(domain_covered), "/", len(queries),
      "; all-query hits", domain_hits, "/", len(queries))

for name, index_text, query_text in (
        ("subject-only", lambda p: p["ask"].get("subject") or "",
         lambda p: p["ask"].get("subject") or ""),
        ("body-only", lambda p: p["ask_body"], lambda p: p["ask_body"])):
    model = BM25(index, index_text)
    print(name, evaluate(model, queries, query_text), "/", len(queries))

filtered_models, filtered = {}, collections.Counter()
for query in queries:
    docs = [p for p in index if p["domain"] == query["domain"]]
    if not docs:
        continue
    if query["domain"] not in filtered_models:
        filtered_models[query["domain"]] = BM25(docs, lambda p: p["ask_text"])
    neighbors = filtered_models[query["domain"]].search(query["ask_text"], 5)
    filtered["domain_history"] += 1
    filtered["retrieved"] += bool(neighbors)
    filtered["type1"] += bool(
        neighbors and neighbors[0][0]["answer_type"] == query["answer_type"])
    prediction = answer_majority(neighbors, "answer_type")
    filtered["majority5"] += bool(prediction and prediction == query["answer_type"])
print("same-domain-only BM25", dict(filtered), "/", len(queries))

# Image-inclusive label sensitivity. This treats numbered images as answer attachments.
image_metrics = evaluate(main, queries, label_key="answer_type_allfiles")
image_index_types = collections.Counter(p["answer_type_allfiles"] for p in index)
image_global = min(image_index_types, key=lambda label: (-image_index_types[label], label))
image_global_hits = sum(p["answer_type_allfiles"] == image_global for p in queries)
print("image-inclusive query answer types",
      dict(collections.Counter(p["answer_type_allfiles"] for p in queries)))
print("image-inclusive BM25 type metrics", image_metrics["type1"],
      "/", len(queries), "majority@5", image_metrics["majority5"], "/", len(queries))
print("image-inclusive global majority", image_global, image_global_hits, "/", len(queries))

# Time-split and repeated-reply audit.
index_reply_ids = {p["reply"].get("id") for p in index}
query_reply_ids = {p["reply"].get("id") for p in queries}
overlap_ids = index_reply_ids & query_reply_ids
post_cut_index = sum(p["reply_ts"].date() >= CUT for p in index)
causal_index = [p for p in index
                if p["reply_ts"].date() < CUT and p["reply"].get("id") not in query_reply_ids]
causal_model = BM25(causal_index, lambda p: p["ask_text"])
print("index replies on/after cutoff", post_cut_index, "/", len(index))
print("cross-split first-reply IDs", len(overlap_ids), "/", len(query_reply_ids),
      "query reply IDs; unique replies", len(index_reply_ids), "/", len(index),
      "index pairs and", len(query_reply_ids), "/", len(queries), "query pairs")
print("causal-index size", len(causal_index), "/", len(index),
      "metrics", evaluate(causal_model, queries), "/", len(queries))
no_overlap_queries = [p for p in queries if p["reply"].get("id") not in index_reply_ids]
print("queries excluding cross-split reply IDs", len(no_overlap_queries), "/", len(queries),
      "metrics", evaluate(main, no_overlap_queries), "/", len(no_overlap_queries))
dedup_queries = []
seen_replies = set()
for p in sorted(queries, key=lambda x: (x["ask_ts"], x["ask"].get("id") or "")):
    reply_id = p["reply"].get("id")
    if reply_id not in seen_replies:
        dedup_queries.append(p)
        seen_replies.add(reply_id)
print("one query per unique first reply", evaluate(main, dedup_queries),
      "/", len(dedup_queries))

late = [p for p in query_candidates
        if date(2026, 10, 11) <= p["ask_ts"].date() <= END]
paired_ask_ids = {p["ask"].get("id") for p in pairs}
late_unpaired = sum(p["ask"].get("id") not in paired_ask_ids for p in late)
print("Oct11-13 asks without observed reply", late_unpaired, "/", len(late))

SAFE = set(("quote quotation rates rate price availability available booking book reserve reservation "
            "amend amendment change modify cancel cancellation confirmation confirm room rooms single "
            "double twin king suite deluxe breakfast dinner dbb board payment deposit paid unpaid voucher "
            "invoice proforma group event conference government contract bar arrival departure dates date "
            "night nights occupancy adults children pax agency corporate company hotel guest travel "
            "accommodation options option allocation check in out extension transfer airport lunch meal "
            "meals receipt refund meeting wedding account bill").split())
def safe_cues(text):
    return sorted(set(token for token in tokens(text) if token in SAFE))

sample = random.Random(20261020).sample(
    sorted(queries, key=lambda p: p["ask"].get("id") or ""), min(20, len(queries)))
print("manual sample: seed 20261020; Q labels follow this stable sample order")
for number, query in enumerate(sample, 1):
    neighbors = main.search(query["ask_text"], 3)
    parts = []
    for neighbor, _score in neighbors:
        same = "same-domain" if neighbor["domain"] == query["domain"] else "other-domain"
        parts.append("[" + (",".join(safe_cues(neighbor["ask_text"])) or "-") +
                     " -> " + neighbor["answer_type"] + "/" + neighbor["board"] +
                     "/" + same + "]")
    print("Q%02d ask=%s answer=%s/%s rates=%s top3=%s" % (
        number, ",".join(safe_cues(query["ask_text"])) or "-",
        query["answer_type"], query["board"], ",".join(query["rates"]) or "not found",
        " ".join(parts) or "none"))

# Human labels are recorded after manual review of the seeded sample above.
manual_labels = ["useful", "partly", "partly", "partly", "partly",
                 "partly", "useful", "partly", "partly", "partly",
                 "partly", "partly", "partly", "useful", "useful",
                 "partly", "no", "partly", "useful", "useful"]
print("manual-review labels (human-coded)", dict(collections.Counter(manual_labels)),
      "/", len(manual_labels))

```

