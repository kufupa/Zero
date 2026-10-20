# L2 — Amend, cancel, payment

## Answer

All figures below are observed / cohort. They use Script S1 in the appendix and the local archive window, 30 July through 13 October 2026.

- **Quote and new booking:** the same create-provisional flow fits the local letters (inference): 1,114/1,174 HRCEN letters show Deposit Paid zero, 1,163/1,174 contain provisional wording, and 1,121/1,174 contain a proforma table. This is a letter-file census, not a request-to-booking funnel. [S1]
- **Amend:** a usable prior letter link was found for 74/223 thread-level amendment candidates. In the three-day follow-up window, 14/74 had a same-number letter, 0/74 had a new-number letter, and 60/74 had no matching letter. The other 149/223 were not comparable. Mail does not prove an HMS write. [S1]
- **Payment at amend:** 44/223 had paid evidence, 54/223 had unpaid evidence, and 125/223 were unknown. A voucher alone is not cash proof. [S1]
- **Add nights / people:** 17/223 asked to extend, 67/223 mentioned people or occupancy, and 5/223 did both. Only 1/223 had a direct price-difference phrase in the next seven days; invoice/proforma wording was much more common, often inside a staff PDF. [S1]
- **Cancel:** staff replied in-thread within seven days for 19/76 cancellation candidates. Fee and refund phrases were sparse; credit-note wording was not found. See the overlapping families below. [S1]
- **Travel-agent voucher/order asks:** the detector found 181 threads / 4,941 eligible external inbound messages; these are mixed units, not a rate. Payment terms were not found in 0/181. Same-thread HRCEN letters were not found in 0/181; exact-recipient cross-thread letter matches were 6/181. [S1]
- **Routing (inference):** keep action type separate from payment state. Treat unpaid provisional changes as lower-risk, but still require the staff approval already required for every HMS write. Paid, guaranteed, and unknown cases need money/fee review before approval.

## Method

- Source: [Centurion mailbox corpus](/home/orca/nava-research/corpus/2026-10-13), including messages, attachments, latest successful extractions, staff PDF text, and the PDF manifest. Script S1 reads locally and prints aggregates only.
- Window: 30 July through 13 October 2026. Dates use the message timestamp, received-at first and sent-at as fallback.
- Inbound OTA/channel mail was filtered by the supplied sender-root list. For amend/cancel, own-domain forwards were kept and split from external mail. The travel-agent cohort excludes own domains and named OTA roots.
- For amend/cancel, a message qualified by latest successful extraction kind amendment/cancellation, or by a visible change/amend/extend/cancel cue plus a confirmation reference. Both action cues were marked ambiguous. Earliest qualifying message per thread/action became the event.
- Quote stripping is heuristic: it removes common HTML quote blocks, plain quote separators, and quoted lines. Forwarded history can remain. Event counts are candidate counts, not manually verified asks.
- Prior HRCEN letters were linked by exact confirmation reference first. If absent, extracted end-client or contact name was searched in PDF text. Name matches are weaker. Follow-up letters were searched across the corpus for three days after the first same-thread staff outbound, or after the ask if none.
- Payment classification uses evidence in prior/current thread mail and mail linked by an exact confirmation reference. It counts proof-like filenames, proof terms with a non-inline attachment, payment-portal receipt terms, positive payment claims, explicit unpaid wording, and the latest prior letter’s Deposit Paid text. Paid evidence overrides zero-deposit evidence. A voucher/prepaid claim is tracked separately; it is not assumed to be settled cash.
- Staff response phrases are same-thread outbound text within seven days. Add-night and cancellation checks also include staff PDF text. Phrase families overlap. They show mentions, not proof that an invoice, refund, cancellation, or HMS write was completed.

## Findings (tables)

### Base and letter evidence — S1, full archive window

| Measure | Observed / denominator | Read |
|---|---:|---|
| All inbound in archive | 8,892/8,892 | Base inbound message set |
| Named OTA/channel inbound excluded | 1,251/8,892 | Filtered by supplied roots |
| Inbound remaining after OTA filter | 7,641/8,892 | Own-domain mail retained |
| External, non-own, non-OTA inbound | 4,941/8,892 | Travel-agent cohort base |
| HRCEN confirmation-letter PDFs | 1,174/2,162 | Staff PDF files in manifest |
| Unique confirmation numbers in those letters | 655/1,174 | Unique IDs / letter files |
| Deposit Paid parsed as zero | 1,114/1,174 | PDF text only |
| Deposit Paid parsed as positive | 7/1,174 | PDF text only; not a live PMS balance |
| Deposit Paid missing / not parsed | 53/1,174 | Do not infer unpaid |
| Proforma wording | 1,121/1,174 | Often part of confirmation letter |
| Provisional wording | 1,163/1,174 | Consistent with provisional-booking model |

### Amend/cancel candidates and prior-letter links — S1, full archive window

| Candidate class | Candidate inbound messages / eligible inbound | Thread events / candidate messages |
|---|---:|---:|
| Amendment | 313/7,641 | 223/313 |
| Cancellation | 85/7,641 | 76/85 |
| Both change and cancel cues; ambiguous | 66/7,641 | 56/66 |

Own-domain messages are retained in these counts. Their source split is 108/223 amendment events and 28/76 cancellation events; external messages are 115/223 and 48/76 respectively.

| Prior-letter match for amendment | Events / amendment events | Link quality |
|---|---:|---|
| Exact confirmation reference | 69/223 | Strongest match |
| Extracted end-client name | 2/223 | Weaker fallback |
| Extracted contact name | 3/223 | Weaker fallback; may be agent |
| Ambiguous confirmation reference | 13/223 | Not comparable |
| Ambiguous name | 2/223 | Not comparable |
| No prior letter match | 134/223 | Not comparable |

Among usable amendment links, 74/223:

| Follow-up HRCEN letter after first staff reply (or ask if no reply) | Observed / usable prior links | Read |
|---|---:|---|
| Same confirmation number | 14/74 | Letter evidence of an in-place update; not proof of the HMS write |
| New confirmation number | 0/74 | No new-number match found in this linked set |
| No matching letter in the three-day window | 60/74 | May still have been updated without a letter |
| Not comparable because prior link was absent/ambiguous | 149/223 | Outside the 74 usable links |

For cancellation, exact prior-reference links were 12/76; name was ambiguous in 2/76; no prior link was found in 62/76. Among the exact links, 1/12 had a same-number letter, 0/12 had a new-number letter, and 11/12 had no matching letter in the three-day window. This does not establish whether cancellation was completed.

### Payment evidence at amendment time — S1, full archive window

| Payment classification | Amendment events / 223 | Rule |
|---|---:|---|
| Paid evidence | 44/223 | Proof/receipt evidence, positive claim, or positive prior-letter deposit |
| Unpaid evidence | 54/223 | Zero-deposit prior letter or explicit unpaid wording, unless paid evidence overrides |
| Unknown | 125/223 | No qualifying evidence found |
| Separate prepaid-voucher claim signal | 1/223 | Non-exclusive; not proof of settled cash |

Among the 69/223 amendment events with an exact prior-letter reference, Deposit Paid text was zero in 68/69 and positive in 1/69. These letter values do not override newer proof-of-payment evidence.

Proof signals overlap, so do not add them:

| Signal found before the amend | Events / 223 |
|---|---:|
| Proof-like body text plus non-inline attachment | 29/223 |
| Proof-like attachment filename | 10/223 |
| Proof-like subject plus non-inline attachment | 9/223 |
| Positive paid statement | 10/223 |
| Prepaid-voucher claim | 1/223 |
| Payment-portal receipt wording | 0/223 |

Staff same-thread mentions within seven days, from body/subject/attachment names only:

| Payment class | Invoice mention | Proforma mention | Price-difference mention | Refund/credit mention |
|---|---:|---:|---:|---:|
| Unpaid evidence | 23/54 | 20/54 | 1/54 | 0/54 |
| Paid evidence | 6/44 | 5/44 | 0/44 | 1/44 |
| Unknown | 14/125 | 11/125 | 0/125 | 0/125 |

A balance-due phrase was not found in 0/223 same-thread replies. Mentions do not prove a new invoice/proforma was created.

### Adding nights or people — S1, full archive window

| Inbound amendment wording | Events / 223 amendment events |
|---|---:|
| Extend / add nights | 17/223 |
| Add people / occupancy | 67/223 |
| Both | 5/223 |

Staff replied in-thread within seven days for 53/223. Output phrase families below include staff PDF text and can overlap.

| Outbound phrase family | Events / 223 amendment events |
|---|---:|
| Direct rate/price/amount-difference wording | 1/223 |
| Balance due / top-up wording | 0/223 |
| Invoice wording | 42/223 |
| Proforma wording | 37/223 |
| Refund wording | 4/223 |
| Credit-note wording | 0/223 |

The direct price-difference phrase appeared in 1/67 people/occupancy asks and 0/17 extension asks. Invoice wording appeared in 11/67 and 3/17; proforma wording also appeared in 11/67 and 3/17 respectively. PDF text can be the ordinary HRCEN letter proforma, not a new delta invoice.

### Cancellation replies — S1, full archive window

| Reply family | Events / 76 cancellation events |
|---|---:|
| One-night / first-night fee wording | 4/76 |
| No-show wording | 3/76 |
| 48-hour wording | 1/76 |
| Penalty / cancellation-fee wording | 1/76 |
| Refund wording | 2/76 |
| Credit-note wording | 0/76 |
| Broad cancellation/status wording | 16/76 |
| Narrow explicit status acknowledgement | 5/76 |

Of the 19/76 events with a same-thread staff reply within seven days, 13/19 had no recognized fee, refund, or credit-note phrase. Families overlap. No fee phrase does not prove no fee was charged.

### Travel-agent voucher/order booking asks — S1, full archive window

The detector found 181 candidate threads / 4,941 eligible external inbound messages. Those are different units; use the latter as volume context, not as a rate.

| Signal | Threads / 181 candidate threads |
|---|---:|
| Voucher/order/travel-confirmation term in attachment filename | 168/181 |
| Body/subject-only document signal | 13/181 |
| Prepaid wording | 0/181 |
| POP/EFT/remittance/receipt/deposit-slip wording | 0/181 |
| Extraction had an agency value | 43/181 |
| Latest extraction kind missing | 137/181 |
| Latest extraction kind booking | 40/181 |
| Latest extraction kind other | 2/181 |
| Latest extraction kind voucher_pop | 2/181 |

Staff response/output:

| Signal | Threads / 181 candidate threads |
|---|---:|
| Same-thread staff reply within seven days | 9/181 |
| Same-thread HRCEN letter within seven days | 0/181 |
| Cross-thread HRCEN letter, exact recipient match within three days | 6/181 |
| Cross-thread recipient match, ambiguous | 3/181 |
| Same-thread price/proforma wording | 5/181 |
| Same-thread booking/confirmation wording | 1/181 |

Cross-thread recipient matching can identify an agent mailbox, not necessarily the guest. The corpus does not show voucher terms/contracts, so it does not establish whether a given voucher guarantees payment or a booking.

Sender domains among detected threads:

| Sender domain | Threads / 181 |
|---|---:|
| travelit.co.za | 154/181 |
| atlantiscorporate.co.za | 6/181 |
| renniesbcdtravel.com | 4/181 |
| corporatetraveller.co.za | 3/181 |
| kimtravel.co.za | 3/181 |
| coctravel.co.za | 2/181 |
| nexustravel.co.za | 1/181 |
| tollink.co.za | 1/181 |
| libero.it | 1/181 |
| univen.ac.za | 1/181 |
| travel.co.za | 1/181 |
| fcmtravel.co.za | 1/181 |
| xlturnerstravel.co.za | 1/181 |
| truenorthgroup.co.za | 1/181 |
| gmail.com | 1/181 |

Weekly volume uses UTC ISO-week windows. Numerator is detected threads; denominator is all eligible external, non-own, non-OTA inbound messages. It is not a share. Edge weeks are partial archive windows.

| Week window | Detected threads / eligible inbound messages |
|---|---:|
| 27 July–2 August | 4/97 |
| 3–9 August | 8/374 |
| 10–16 August | 13/335 |
| 17–23 August | 17/488 |
| 24–30 August | 26/501 |
| 31 August–6 September | 25/546 |
| 7–13 September | 13/513 |
| 14–20 September | 17/483 |
| 21–27 September | 11/414 |
| 28 September–4 October | 18/498 |
| 5–11 October | 23/481 |
| 12–13 October, partial | 6/211 |

### Proposed state machine — S1 evidence; design marked as inference

| State / transition | Corpus evidence | Suggested handling |
|---|---|---|
| No linked booking → quote/new-booking flow → provisional HMS booking | Letter inventory: 1,114/1,174 zero-deposit text, 1,163/1,174 provisional text, 1,121/1,174 proforma text | Keep quote and new booking in one create-provisional flow (inference). The letter inventory is not a linked funnel. |
| Provisional → unpaid / paid / unknown | At amend time: 54/223 unpaid evidence, 44/223 paid evidence, 125/223 unknown | Keep payment as a separate state axis; unknown must not silently become unpaid (inference). |
| Voucher-backed → guaranteed | Prepaid wording was not found in 0/181 agent voucher/order threads; 1/223 prepaid-voucher claim in amend evidence | Keep guarantee separate from cash-paid; check agency terms/PMS record before relying on it (inference). |
| Unpaid provisional → amended | Of usable prior-letter matches: 14/74 same-number letters, 0/74 new-number, 60/74 no match | Treat same-record amend as the observed default candidate, not a proven HMS rule. Staff still approve every write (inference). |
| Paid / guaranteed / unknown → amended or cancelled | Paid evidence 44/223 among amend asks; cancellations include fee wording and 2/76 refund wording | Route to money/fee review before write. Unknown also needs care (inference). |
| Any booking → cancelled | Exact prior-reference link in 12/76 cancel events; actual HMS cancellation result not exposed | Check cancellation policy, fee, refund, and credit impact; do not infer completion from an acknowledgement letter (inference). |

## What this means for the agent/pane

- **Taxonomy (inference):** model action and payment separately: quote/new-reservation, amend, cancel, and voucher/order booking request; then payment state paid, unpaid, guaranteed, or unknown. Quote is not a separate final booking state.
- **Agent boundary (inference):** use language model for intent, stay/party extraction, and candidate linking. Use deterministic HMS reads to confirm the reservation and money state. Build the proposed write from those reads. Staff approves every HMS write.
- **Pane order (inference):**
  1. Request type, guest/confirmation link, and match confidence.
  2. Current HMS reservation: dates, rooms, party, status, deposit/payment.
  3. Payment/guarantee evidence, with source and time; unknown stays visible.
  4. Before/after stay and party delta; price difference, balance, cancellation fee, refund, or credit impact.
  5. Exact HMS action preview, including whether confirmation number is expected to stay the same; staff approval control.
  6. Reply facts for staff reference only. Nava never sends mail.
- **Risk gate (inference):** unpaid plus zero-deposit evidence is the lower-risk lane, not an automatic-write lane. Paid, guaranteed, unknown, ambiguous link, and cancellation cases need staff review of money and policy.

## Open gaps

- No HMS transaction/audit result is in this corpus. Same-number or new-number letters are document evidence only; no letter does not prove no change.
- Prior letter may be outside the archive or in a separate thread. Name matching is weaker than a confirmation reference.
- Deposit text was missing/not parsed in 53/1,174 local HRCEN letter files. PDFs are text extraction, not a live PMS balance.
- Inbound POPs, vouchers, or receipts may be binary or image attachments. This pass used message text and filenames for payment proof; no proof term found does not prove unpaid.
- Voucher contracts and agency guarantee rules were not in scope. Whether a voucher is a guarantee is not found; do not guess.
- Cancellation-policy source and whether a fee/refund was actually applied are not present in these message counts.
- Quote separators do not perfectly isolate every forwarded email. Some candidate asks may be false positives; manual adjudication is needed before using these rates as automation thresholds.
- Production evidence was not re-run, per instruction.

## Appendix (scripts)

### Script S1

Run from any directory with Python 3 and read access to the local corpus. It reads archives and prints aggregate counts only; it writes no files.

```bash
python3 - <<'PY'
import collections, csv, datetime, email.utils, gzip, html, json, pathlib, re, unicodedata

R = pathlib.Path("/home/orca/nava-research/corpus/2026-10-13")

def rows(name):
    with gzip.open(R / name, "rt", encoding="utf-8") as f:
        for line in f:
            if line.strip():
                yield json.loads(line)

def tm(m):
    try:
        return datetime.datetime.fromisoformat(str(m.get("received_at") or m.get("sent_at") or "").replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None

def addr(x):
    return email.utils.parseaddr(str(x or ""))[1].lower()

def emails(x):
    if isinstance(x, str):
        return {v.lower() for v in re.findall(r"[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}", x, re.I)}
    if isinstance(x, (list, tuple)):
        return set().union(*(emails(v) for v in x)) if x else set()
    if isinstance(x, dict):
        return set().union(*(emails(v) for v in x.values())) if x else set()
    return set()

def domain(m):
    a = addr(m.get("from_address"))
    return a.rsplit("@", 1)[-1] if "@" in a else ""

OWN = ("legacyhotels.co.za", "legacyhotels.com")
OTA = ("synxis", "booking.com", "expedia", "webbeds", "hotelbeds",
       "profitroom", "siteminder", "ratetiger", "tiket")

def own(m):
    d = domain(m)
    return d in OWN or any(d.endswith("." + x) for x in OWN)

def ota(m):
    return any(x in domain(m) for x in OTA)

def visible(m):
    raw = str(m.get("body") or "")
    if m.get("body_is_html"):
        raw = re.sub(r"(?is)<blockquote\b.*?</blockquote>", " ", raw)
        raw = re.sub(
            r"(?is)<div\b[^>]*(?:id|class)\s*=\s*['\"][^'\"]*"
            r"(?:divrplyfwdmsg|gmail_quote|yahoo_quoted)[^'\"]*['\"][^>]*>.*$",
            " ", raw)
    else:
        for pat in (
            r"(?im)^\s*-{2,}\s*original message\s*-{2,}.*$",
            r"(?im)^\s*on .{3,140}wrote:\s*$",
            r"(?im)^\s*(?:from|sent|to|subject):\s.*$",
            r"(?im)^\s*_{8,}.*$",
            r"(?m)^\s*>.*$",
        ):
            raw = re.sub(pat, " ", raw)
    return html.unescape(re.sub(r"<[^>]+>", " ", raw)).lower().replace("\xa0", " ")

def norm(s):
    s = unicodedata.normalize("NFKD", str(s or "")).encode("ascii", "ignore").decode().lower()
    return " ".join(re.findall(r"[a-z0-9]+", s))

def validname(s):
    toks = [x for x in norm(s).split() if x not in {"mr", "mrs", "ms", "miss", "dr", "prof"}]
    return " ".join(toks) if len(toks) >= 2 and len("".join(toks)) >= 6 else ""

msgs = list(rows("messages.jsonl.gz"))
byid = {m["id"]: m for m in msgs}
threads = collections.defaultdict(list)
for m in msgs:
    threads[m.get("thread_id")].append(m)

staff_pdf_n = sum(1 for row in csv.reader((R / "staff_pdfs.tsv").open(), delimiter="\t") if row)
attmid = collections.defaultdict(list)
attid = {}
for a in rows("attachments.jsonl.gz"):
    attmid[a["message_id"]].append(a)
    attid[a["id"]] = a

latest = {}
for x in rows("extractions.jsonl.gz"):
    if x.get("status") != "succeeded":
        continue
    old = latest.get(x["message_id"])
    if old is None or (x.get("created_at", ""), x.get("id", "")) > (old.get("created_at", ""), old.get("id", "")):
        latest[x["message_id"]] = x

pdfmid = collections.defaultdict(list)
for aid, mid, rel in csv.reader((R / "staff_pdfs.tsv").open(), delimiter="\t"):
    path = R / "pdftxt" / (aid + ".txt")
    if path.exists():
        pdfmid[mid].append(path.read_text(errors="ignore").lower())

REF = re.compile(
    r"(?ix)(?:\bn\s*[º°o]|\bconfirmation\s*(?:no\.?|number|\#)|"
    r"\bconf(?:irmation)?\s*(?:no\.?|number|\#)|"
    r"\bhrcen[\s_-]*confirmation[\s_-]*letter[\s_-]*)"
    r"(?:[\s:\#=_-]*)([a-z]?\d{5,12})")
LETTER = re.compile(r"(?i)HRCEN[_\s-]*Confirmation[_\s-]*Letter[_\s-]*(\d{5,12})")
AMEND = re.compile(r"(?i)\b(?:change|changed|amend(?:ment|ed|ing)?|extend(?:ed|ing)?|extension)\b")
CANCEL = re.compile(r"(?i)\b(?:cancel(?:led|ed|ling|lation)?|cancell?ation)\b")

def refs_for(m):
    p = latest.get(m["id"], {}).get("payload") or {}
    raw = " ".join([str(m.get("subject") or ""), visible(m)] +
                   [str(a.get("filename") or "") for a in attmid[m["id"]]])
    found = {v.upper() for v in REF.findall(raw)}
    values = p.get("confirmationNumbers") or []
    if not isinstance(values, (list, tuple, set)):
        values = [values]
    for value in values:
        found.update(v.upper() for v in re.findall(r"\d{5,12}", str(value)))
    return found

refs = {m["id"]: refs_for(m) for m in msgs}
refmap = collections.defaultdict(list)
for m in msgs:
    for v in refs[m["id"]]:
        refmap[v].append(m)

letters = []
bymsgletters = collections.defaultdict(list)
for aid, mid, rel in csv.reader((R / "staff_pdfs.tsv").open(), delimiter="\t"):
    hit = LETTER.search(attid.get(aid, {}).get("filename", ""))
    if not hit:
        continue
    path = R / "pdftxt" / (aid + ".txt")
    raw = path.read_text(errors="ignore") if path.exists() else ""
    dep = re.search(r"(?im)^\s*deposit\s+paid\b\s*[:\-]?\s*([^\r\n]+)", raw)
    deposit = "missing"
    if dep:
        amount = re.search(r"[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?", dep.group(1))
        if amount:
            deposit = "zero" if float(amount.group().replace(",", "")) == 0 else "positive"
    item = {
        "conf": hit.group(1).upper(), "mid": mid, "time": tm(byid.get(mid, {})),
        "deposit": deposit, "text": norm(raw),
        "proforma": bool(re.search(r"(?i)\bpro\s*[- ]?\s*forma\b", raw)),
        "provisional": bool(re.search(r"(?i)\bprovisional\b", raw)),
        "recips": emails(byid.get(mid, {}).get("to_addresses")),
    }
    letters.append(item)
    bymsgletters[mid].append(item)

# Candidate inbound asks: latest successful kind or visible text cue plus explicit confirmation ref.
candidates = []
for m in msgs:
    if m.get("direction") != "inbound" or ota(m):
        continue
    kind = latest.get(m["id"], {}).get("kind")
    text = visible(m)
    a, c, r = bool(AMEND.search(text)), bool(CANCEL.search(text)), bool(refs[m["id"]])
    if kind == "amendment":
        group = "amendment"
    elif kind == "cancellation":
        group = "cancellation"
    elif r and a and not c:
        group = "amendment"
    elif r and c and not a:
        group = "cancellation"
    elif r and a and c:
        group = "ambiguous"
    else:
        continue
    candidates.append((m, group))

event_map = {}
for m, group in candidates:
    key = (m.get("thread_id"), group)
    old = event_map.get(key)
    t = tm(m) or datetime.datetime.max.replace(tzinfo=datetime.timezone.utc)
    if old is None or t < (tm(old) or datetime.datetime.max.replace(tzinfo=datetime.timezone.utc)):
        event_map[key] = m
events = [{"thread": th, "group": g, "m": m, "time": tm(m)}
          for (th, g), m in event_map.items()]

def names_for(pre):
    names = {"end": set(), "contact": set()}
    for m in pre:
        p = latest.get(m["id"], {}).get("payload") or {}
        n = validname(p.get("endClient")) if isinstance(p.get("endClient"), str) else ""
        if n:
            names["end"].add(n)
        c = p.get("contact") or {}
        n = validname(c.get("name")) if isinstance(c, dict) and isinstance(c.get("name"), str) else ""
        if n:
            names["contact"].add(n)
    return names

def prior_match(pre, t):
    rset = set().union(*(refs[z["id"]] for z in pre)) if pre else set()
    before = [l for l in letters if l["time"] and t and l["time"] <= t]
    direct = [l for l in before if l["conf"] in rset]
    if direct:
        confs = {l["conf"] for l in direct}
        if len(confs) == 1:
            return max(direct, key=lambda l: l["time"]), "conf"
        return None, "ambiguous_conf"
    names = names_for(pre)
    found = []
    for typ in ("end", "contact"):
        hits = [l for l in before if any(n in l["text"] for n in names[typ])]
        if hits:
            confs = {l["conf"] for l in hits}
            found.append((typ, max(hits, key=lambda l: l["time"]) if len(confs) == 1 else None))
    if found:
        valid = [x for x in found if x[1] is not None]
        if len(valid) == 1:
            return valid[0][1], valid[0][0] + "_name"
        if len(valid) > 1 and len({x[1]["conf"] for x in valid}) == 1:
            return max([x[1] for x in valid], key=lambda l: l["time"]), "name"
        return None, "ambiguous_name"
    return None, "none"

# Lifecycle link and post-request letter matching.
link = collections.Counter()
outcomes = collections.Counter()
source = collections.Counter()
for e in events:
    if e["group"] not in ("amendment", "cancellation"):
        continue
    m, t, th = e["m"], e["time"], e["thread"]
    source[e["group"], "internal" if own(m) else "external"] += 1
    pre = [z for z in threads[th] if tm(z) and t and tm(z) <= t]
    prior, method = prior_match(pre, t)
    e["prior"], e["prior_method"] = prior, method
    link[e["group"], method] += 1
    outs = [z for z in threads[th] if z.get("direction") == "outbound" and tm(z) and t and tm(z) > t]
    start = min((tm(z) for z in outs), default=t)
    after = [l for l in letters if l["time"] and start and start <= l["time"] <= start + datetime.timedelta(hours=72)]
    names = names_for(pre)
    same = {l["conf"] for l in after if prior and l["conf"] == prior["conf"]}
    new = {l["conf"] for l in after if l["conf"] != (prior["conf"] if prior else None)
           and any(n in l["text"] for n in names["end"])}
    if same and new:
        outcome = "same_and_new"
    if not prior:
        outcome = "not_comparable"
    elif same:
        outcome = "same_conf"
    elif len(new) == 1:
        outcome = "new_conf_by_endclient_name"
    elif len(new) > 1:
        outcome = "ambiguous_new_conf"
    else:
        outcome = "no_letter_72h"
    outcomes[e["group"], outcome] += 1

# Payment state at amendment time; evidence flags overlap.
POPTEXT = re.compile(
    r"(?i)\bpop\b|proof\s+of\s+payment|remittance(?:\s+advice)?|\beft\b|deposit\s+slip|"
    r"payment\s+(?:receipt|confirmation|successful|received|completed)|receipt\s+of\s+payment")
POSCLAIM = re.compile(
    r"(?i)\b(?:we\s+(?:have\s+)?received\s+(?:the\s+)?(?:payment|pop|proof)|"
    r"(?:payment|pop)\s+(?:has\s+been|was|is)\s+received|payment\s+(?:successful|completed)|paid\s+in\s+full)\b")
NEGCLAIM = re.compile(
    r"(?i)\b(?:not\s+yet\s+paid|payment\s+not\s+received|awaiting\s+(?:the\s+)?payment|"
    r"outstanding\s+payment|deposit\s+is\s+still\s+due)\b")
PORTAL_RECEIPT = re.compile(
    r"(?i)\b(?:payment\s+portal|portal payment)\b.{0,50}\b(?:receipt|successful|completed|paid)\b|"
    r"\b(?:receipt|successful|completed|paid)\b.{0,50}\b(?:payment\s+portal|portal payment)\b")
PREPAID = re.compile(r"(?i)\bpre[ -]?paid\b")
PROOF_FILE = re.compile(
    r"(?i)\b(?:pop|eft)\b|proof[ _-]*of[ _-]*payment|remittance|deposit[ _-]*slip|"
    r"payment[ _-]*receipt|receipt[ _-]*of[ _-]*payment")
PROOF_SUBJECT = re.compile(r"(?i)\b(?:pop|eft|remittance|deposit slip|proof of payment)\b")
PROOF_BODY = re.compile(
    r"(?i)(?:\b(?:please find|find|attached|enclosed|herewith|see attached|sending|sent)\b"
    r".{0,40}\b(?:pop|proof of payment|remittance|eft|deposit slip|payment receipt|receipt of payment)\b|"
    r"\b(?:pop|proof of payment|remittance|eft|deposit slip|payment receipt|receipt of payment)\b"
    r".{0,40}\b(?:attached|enclosed|please find|received|provided)\b)")
POS = POSCLAIM
NEG = NEGCLAIM

def signals(m):
    subj = str(m.get("subject") or "").lower()
    body = visible(m)
    files = " ".join(str(a.get("filename") or "").lower() for a in attmid[m["id"]])
    noninline = any(not a.get("is_inline") for a in attmid[m["id"]])
    combined = subj + " " + body + " " + files
    sig = set()
    if PROOF_FILE.search(files):
        sig.add("proof_file_name")
    if PROOF_SUBJECT.search(subj) and noninline:
        sig.add("proof_subject_attachment")
    if PROOF_BODY.search(body) and noninline:
        sig.add("proof_body_attachment")
    if POS.search(body):
        sig.add("positive_paid_claim")
    if NEG.search(body):
        sig.add("explicit_unpaid")
    if PORTAL_RECEIPT.search(body + " " + files):
        sig.add("payment_portal_receipt")
    if PREPAID.search(combined) and re.search(r"(?i)\b(?:voucher|order)\b", combined) and m.get("direction") == "inbound":
        sig.add("prepaid_voucher_claim")
    return sig

payment = collections.Counter()
payment_flags = collections.Counter()
prior_deposit = collections.Counter()
payment_reply = collections.defaultdict(collections.Counter)
for e in events:
    if e["group"] != "amendment":
        continue
    m, t, th = e["m"], e["time"], e["thread"]
    pre = [z for z in threads[th] if tm(z) and t and tm(z) <= t]
    rset = set().union(*(refs[z["id"]] for z in pre)) if pre else set()
    hits = [l for l in letters if l["time"] and t and l["time"] <= t and l["conf"] in rset]
    confs = {l["conf"] for l in hits}
    prior = max(hits, key=lambda l: l["time"]) if len(confs) == 1 and hits else None
    if prior:
        prior_deposit[prior["deposit"]] += 1
    related = {z["id"]: z for z in pre}
    for ref in rset:
        for z in refmap.get(ref, []):
            if tm(z) and t and tm(z) < t:
                related[z["id"]] = z
    ev = set()
    for z in related.values():
        ev.update(signals(z))
    for f in ev:
        payment_flags[f] += 1
    if prior and prior["deposit"] == "positive":
        ev.add("positive_letter_deposit")
    zero = bool(prior and prior["deposit"] == "zero")
    if any(f in ev for f in ("proof_file_name", "proof_subject_attachment",
                             "proof_body_attachment", "positive_paid_claim",
                             "payment_portal_receipt",
                             "positive_letter_deposit")):
        state = "paid"
    elif "prepaid_voucher_claim" in ev:
        state = "guaranteed"
    elif zero or "explicit_unpaid" in ev:
        state = "unpaid"
    else:
        state = "unknown"
    payment[state] += 1
    outs = [z for z in threads[th] if z.get("direction") == "outbound" and tm(z) and t and
            t < tm(z) <= t + datetime.timedelta(days=7)]
    outtext = " ".join(str(z.get("subject") or "").lower() + " " + visible(z) + " " +
                       " ".join(str(a.get("filename") or "").lower() for a in attmid[z["id"]])
                       for z in outs)
    for key, terms in {
        "invoice": ("invoice",),
        "proforma": ("pro forma", "proforma"),
        "balance_due": ("balance due", "amount due", "outstanding balance", "top-up", "top up"),
        "refund_credit": ("refund", "credit note", "credit memo"),
        "price_difference": ("rate difference", "price difference", "additional charge",
                             "additional amount", "extra charge", "difference to pay"),
    }.items():
        if any(x in outtext for x in terms):
            payment_reply[state][key] += 1

# Add-night / party-size changes.
EXTEND = re.compile(
    r"(?i)\b(?:extend(?:ed|ing)?|extension|extra night|additional night|"
    r"add(?:ed|ing)?\s+(?:an?\s+)?night|more nights?)\b")
PEOPLE = re.compile(
    r"(?i)\b(?:add(?:ed|ing)?\s+(?:an?\s+)?guest|extra guest|additional guest|"
    r"pax|people|persons?|adults?|children|occupancy|sharing)\b")
FIN = {
    "price_difference": re.compile(
        r"(?i)\b(?:rate|price|amount) difference\b|\bdifference in (?:the )?(?:rate|price|amount)\b|"
        r"\b(?:additional|extra) (?:charge|amount|cost|payment)\b|\bdifference to pay\b|\bpay.{0,25}difference\b"),
    "balance_due": re.compile(r"(?i)\b(?:balance due|amount due|outstanding balance|remaining balance|top[ -]?up)\b"),
    "invoice": re.compile(r"(?i)\b(?:invoice|tax invoice|debit note)\b"),
    "proforma": re.compile(r"(?i)\bpro[ -]?forma\b"),
    "refund": re.compile(r"(?i)\brefund(?:ed|ing)?\b|\breimburse(?:d|ment)?\b"),
    "credit_note": re.compile(r"(?i)\bcredit (?:note|memo)\b"),
}
add_in = collections.Counter()
add_out = collections.Counter()
add_subgroup = collections.defaultdict(collections.Counter)
add_reply = 0
for e in events:
    if e["group"] != "amendment":
        continue
    m, t, th = e["m"], e["time"], e["thread"]
    text = str(m.get("subject") or "") + " " + visible(m)
    ext, people = bool(EXTEND.search(text)), bool(PEOPLE.search(text))
    add_in["extension"] += ext
    add_in["people"] += people
    add_in["both"] += ext and people
    outs = [z for z in threads[th] if z.get("direction") == "outbound" and tm(z) and t and
            t < tm(z) <= t + datetime.timedelta(days=7)]
    add_reply += bool(outs)
    outtext = " ".join(str(z.get("subject") or "") + " " + visible(z) + " " +
                       " ".join(str(a.get("filename") or "") for a in attmid[z["id"]]) + " " +
                       " ".join(pdfmid.get(z["id"], [])) for z in outs).lower()
    for key, pat in FIN.items():
        if pat.search(outtext):
            add_out[key] += 1
            if ext:
                add_subgroup["extension"][key] += 1
            if people:
                add_subgroup["people"][key] += 1

# Cancellation reply families.
CANCEL_PATS = {
    "fee_48h": re.compile(r"(?i)\b48\s*(?:hours?|hrs?)\b"),
    "fee_one_night": re.compile(r"(?i)\b(?:one|1)\s+night(?:[’']s)?\b|\bfirst night(?:[’']s)?\b"),
    "fee_no_show": re.compile(r"(?i)\bno[ -]?show\b|\bdid not arrive\b"),
    "fee_penalty": re.compile(r"(?i)\b(?:penalty|cancellation fee|cancellation charge|late fee|fee applies|charge applies|non[ -]?refundable)\b"),
    "refund": re.compile(r"(?i)\brefund(?:ed|ing)?\b|\breimburse(?:d|ment)?\b"),
    "credit_note": re.compile(r"(?i)\bcredit (?:note|memo)\b"),
    "cancel_status": re.compile(r"(?i)\b(?:cancelled|canceled|cancellation|released)\b"),
}
cancel_reply = 0
cancel_pat = collections.Counter()
cancel_reply_family = collections.Counter()
for e in events:
    if e["group"] != "cancellation":
        continue
    m, t, th = e["m"], e["time"], e["thread"]
    outs = [z for z in threads[th] if z.get("direction") == "outbound" and tm(z) and t and
            t < tm(z) <= t + datetime.timedelta(days=7)]
    cancel_reply += bool(outs)
    outtext = " ".join(str(z.get("subject") or "") + " " + visible(z) + " " +
                       " ".join(str(a.get("filename") or "").lower() for a in attmid[z["id"]]) + " " +
                       " ".join(pdfmid.get(z["id"], [])) for z in outs).lower()
    for key, pat in CANCEL_PATS.items():
        if pat.search(outtext):
            cancel_pat[key] += 1
    if outs:
        if not any(CANCEL_PATS[k].search(outtext) for k in
                   ("fee_48h", "fee_one_night", "fee_no_show", "fee_penalty", "refund", "credit_note")):
            cancel_reply_family["no_fee_refund_credit"] += 1
        if re.search(
            r"(?i)\b(?:cancelled|canceled|cancellation (?:has been )?(?:done|processed|confirmed)|"
            r"booking (?:has been )?released|stay released)\b", outtext):
            cancel_reply_family["strict_status_ack"] += 1

# External travel-agent voucher/order plus explicit booking-request cohort.
VOUCHER = re.compile(r"(?i)\b(?:voucher|travel\s+confirmation|booking\s+confirmation|itinerary|order\s*(?:no\.?|number|\#))\b")
BOOK_REQ = re.compile(
    r"(?i)\b(?:please|kindly|can\s+you|could\s+you|would\s+you|assist\s+(?:us|me)?\s*(?:to|with)?|"
    r"please\s+proceed|kindly\s+proceed)\b.{0,50}\b(?:book|booking|make\s+(?:the\s+)?(?:a\s+)?reservation|"
    r"create\s+(?:the\s+)?reservation|reserve|confirm\s+(?:the\s+)?booking)\b")
CHANGE_CANCEL = re.compile(r"(?i)\b(?:amend|change|extend|extension|cancel|cancellation)\b")
eligible = [m for m in msgs if m.get("direction") == "inbound" and not own(m) and not ota(m)]
weekly_mail = collections.Counter()
for m in eligible:
    if tm(m):
        iso = tm(m).date().isocalendar()
        weekly_mail[f"{iso.year}-W{iso.week:02d}"] += 1
agent_raw = []
for m in eligible:
    text = str(m.get("subject") or "").lower() + " " + visible(m)
    files = " ".join(str(a.get("filename") or "") for a in attmid[m["id"]])
    x = latest.get(m["id"], {})
    if x.get("kind") in ("amendment", "cancellation") or CHANGE_CANCEL.search(text):
        continue
    if VOUCHER.search(text + " " + files) and BOOK_REQ.search(text):
        agent_raw.append(m)
agent_first = {}
for m in agent_raw:
    old = agent_first.get(m["thread_id"])
    t = tm(m) or datetime.datetime.max.replace(tzinfo=datetime.timezone.utc)
    if old is None or t < (tm(old) or datetime.datetime.max.replace(tzinfo=datetime.timezone.utc)):
        agent_first[m["thread_id"]] = m
agent_events = list(agent_first.values())

# Print aggregates only.
inbound_n = sum(m.get("direction") == "inbound" for m in msgs)
named_ota_n = sum(m.get("direction") == "inbound" and ota(m) for m in msgs)
external_in_n = len(eligible)
domains = collections.Counter(domain(m) for m in agent_events)
agent_week = collections.Counter()
agent_kind = collections.Counter()
agent_flags = collections.Counter()
agent_attachment = 0
agency_extract = 0
agent_reply = collections.Counter()
agent_reply_pattern = collections.Counter()
for m in agent_events:
    t, th = tm(m), m["thread_id"]
    if t:
        iso = t.date().isocalendar()
        agent_week[f"{iso.year}-W{iso.week:02d}"] += 1
    x = latest.get(m["id"], {})
    agent_kind[x.get("kind") or "(none)"] += 1
    agency_extract += bool((x.get("payload") or {}).get("agency"))
    text = str(m.get("subject") or "") + " " + visible(m)
    files = " ".join(str(a.get("filename") or "") for a in attmid[m["id"]])
    agent_attachment += bool(VOUCHER.search(files))
    full = (text + " " + files).lower()
    if re.search(r"(?i)\bpre[ -]?paid\b", full):
        agent_flags["prepaid"] += 1
    if re.search(r"(?i)\b(?:pop|eft)\b|proof of payment|remittance|payment receipt|deposit slip", full):
        agent_flags["proof_terms"] += 1
    outs = [z for z in threads[th] if z.get("direction") == "outbound" and tm(z) and t and
            t < tm(z) <= t + datetime.timedelta(days=7)]
    agent_reply["same_thread_reply_7d"] += bool(outs)
    same_letters = [l for z in outs for l in bymsgletters.get(z["id"], [])]
    agent_reply["same_thread_HRCEN_letter_7d"] += bool(same_letters)
    start = min((tm(z) for z in outs), default=t)
    window = [l for l in letters if l["time"] and start and start <= l["time"] <= start + datetime.timedelta(hours=72)]
    p = x.get("payload") or {}
    contact = p.get("contact") or {}
    recip = set(emails(contact.get("email") if isinstance(contact, dict) else None))
    sender = addr(m.get("from_address"))
    if sender:
        recip.add(sender)
    confs = {l["conf"] for l in window if recip & l["recips"]}
    if len(confs) == 1:
        agent_reply["cross_thread_letter_same_recipient_72h"] += 1
    elif len(confs) > 1:
        agent_reply["cross_thread_recipient_ambiguous"] += 1
    outtext = " ".join(str(z.get("subject") or "") + " " + visible(z) + " " +
                       " ".join(str(a.get("filename") or "") for a in attmid[z["id"]]) for z in outs).lower()
    if re.search(r"(?i)\b(?:booked|booking confirmed|reservation confirmed|confirmation letter|confirmed the booking)\b", outtext):
        agent_reply_pattern["booking_confirmation"] += 1
    if re.search(r"(?i)\b(?:quote|quotation|rate|pro[ -]?forma|invoice)\b", outtext):
        agent_reply_pattern["price_or_proforma"] += 1

# Outputs.
letter_deposit = collections.Counter(l["deposit"] for l in letters)
print("base", {"inbound": inbound_n, "named_OTA": named_ota_n,
              "non_OTA_inbound": inbound_n - named_ota_n, "external_non_OTA_inbound": external_in_n})
print("letter_inventory", {"staff_pdf_denominator": staff_pdf_n, "HRCEN_files": len(letters),
                            "unique_conf": len({l["conf"] for l in letters}),
                            "deposit": dict(letter_deposit),
                            "proforma": sum(l["proforma"] for l in letters),
                            "provisional": sum(l["provisional"] for l in letters)})
print("candidate_messages", dict(collections.Counter(g for m, g in candidates)))
print("thread_events", dict(collections.Counter(e["group"] for e in events)))
print("action_source", {g: {k: v for (gg, k), v in source.items() if gg == g}
                       for g in ("amendment", "cancellation")})
print("prior_links", {g: {k: v for (gg, k), v in link.items() if gg == g}
                     for g in ("amendment", "cancellation")})
print("post_letter_72h", {g: {k: v for (gg, k), v in outcomes.items() if gg == g}
                          for g in ("amendment", "cancellation")})
print("amendment_comparison", {
    "usable_prior_link": sum(v for (g, method), v in link.items()
                             if g == "amendment" and method in ("conf", "end_name", "contact_name", "name")),
    "new_conf": outcomes.get(("amendment", "new_conf_by_endclient_name"), 0)
})
print("payment", {"state": dict(payment), "signals": dict(payment_flags),
                  "exact_prior_deposit": dict(prior_deposit),
                  "balance_due_mentions": sum(v.get("balance_due", 0) for v in payment_reply.values()),
                  "payment_portal_receipt": payment_flags.get("payment_portal_receipt", 0),
                  "staff_reply_7d_by_state": {s: dict(v) for s, v in payment_reply.items()}})
print("additions", {"input": dict(add_in), "reply_7d": add_reply,
                   "output_7d_including_pdf": dict(add_out),
                   "balance_due": add_out.get("balance_due", 0),
                   "credit_note": add_out.get("credit_note", 0),
                   "by_input": {s: dict(v) for s, v in add_subgroup.items()}})
print("cancellation", {"events": sum(e["group"] == "cancellation" for e in events),
                       "replies_7d": cancel_reply, "patterns": dict(cancel_pat),
                       "credit_note": cancel_pat.get("credit_note", 0),
                       "reply_family": dict(cancel_reply_family)})
print("agent", {"events": len(agent_events),
                "domains": domains.most_common(), "week_thread_over_inbound": {
                    w: f"{agent_week[w]}/{weekly_mail[w]}" for w in sorted(agent_week)},
                "latest_kind": dict(agent_kind), "agency_extraction": agency_extract,
                "attachment_doc": agent_attachment, "body_or_subject_only": len(agent_events) - agent_attachment,
                "payment_terms": {"prepaid": agent_flags.get("prepaid", 0),
                                  "proof_terms": agent_flags.get("proof_terms", 0)},
                "reply": dict(agent_reply),
                "reply_families": dict(agent_reply_pattern)})

PY
```

