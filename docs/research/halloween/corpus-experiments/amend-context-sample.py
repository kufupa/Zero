#!/usr/bin/env python3
"""Select a private, deterministic amendment/cancellation context sample.

Usage: python3 -I -B amend-context-sample.py CORPUS_JSONL EMPTY_PRIVATE_DIR [--recover-prefix]
The output directory must be a newly created, empty direct child of .private.
Output is not suitable for Git; even reduced context is sensitive.
"""

import collections
import datetime as dt
import hashlib
import html
import json
import os
import pathlib
import re
import sys

START, END = "2026-09-28", "2026-10-29"
BLOCKS = (("2026-09-28", "2026-10-04"), ("2026-10-05", "2026-10-11"),
          ("2026-10-12", "2026-10-18"), ("2026-10-19", "2026-10-25"),
          ("2026-10-26", "2026-10-29"))
SEED = "hms-amend-context-v1-20261031"
QUOTA = {"change": 8, "cancel": 6, "both": 3, "neither": 8}
CHANGE = re.compile(r"\b(?:amend(?:ment|ed|ing)?|chang(?:e|ed|ing)|modif(?:y|ied|ication)|"
                    r"extend(?:ed|ing|s|sion)?|upgrade(?:d|s)?|reschedul(?:e|ed|ing)|"
                    r"postpon(?:e|ed|ing)|shorten(?:ed|ing)?|reduc(?:e|ed|ing))\b", re.I)
CANCEL = re.compile(r"\bcancel(?:l?ed|l?ing|l?ation|s)?\b", re.I)
SECRET = re.compile(r"\b(?:password|passcode|one[ -]time[ -]code|cvv|cvc|"
                    r"card[ -](?:number|details)|security[ -]code|bank[ -]account[ -]number)\b", re.I)
MAIL = re.compile(r"(?<![\w.+-])[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}")
URL = re.compile(r"https?://[^\s<>\"']+", re.I)
LONG_NUMBER = re.compile(r"(?<!\d)\+?\d(?:[ .()\-]*\d){6,18}(?!\d)")
TOKEN = re.compile(r"[A-Za-z]+(?:['’][A-Za-z]+)?|\d+|[.!?,:;\n]")
SAFE = set("""a about above accept accepted accepting accommodation according account additional add added
adding adjust adjusted advance after again against all allow allowed already also alternative although am amend
amended amendment amendments an and another any are arrival arrive arrived arriving as ask asked asking at
available availability away back balance be because bed beds been before being below between big bill billing
board book booked booking bookings breakfast but by can can't cancel canceled cancelling cancellation cancelled
card change changed changing check checked checking checkin checkout child children choose closed company confirm
confirmation confirmed contact cost could credit date dates day days dear decline declined deposit departure depart
did did not difference dinner do does don't done double down during each early email end extra extend extended
extension fee first flight for forward from full fully get give given go good group guest guests guarantee guaranteed
had has have having hello help here hi hold hotel hotels how however i if in include included including individual
instead into invoice is isn't it its just kindly king last later late least let like list longer made make many may
meal meals more morning most much must my name need needed needs new next night nights no none not note notes now
number of off offer offered on once one only open option options or order original other our out over paid partial
part payment penalty per person persons please possible price prices prior proceed rate rates receipt receive
received reduce reduced reference refund refused regarding request requested required reservation reservations
reserve reserved return revised room rooms same say second send sent several should single so sold some sorry staff
standard stay stays still subject suite sure take than thank thanks that the their them then there these they this
those three through time to today tomorrow total transfer travel twin two type unable unavailable under until update
updated upgrade upgraded us use used very voucher wait want wanted was we week well were what when where whether which
who will with within without would yes yet you your zero january february march april may june july august september
october november december monday tuesday wednesday thursday friday saturday sunday email link withheld number unknown
able action advance advised advise advice again agree agreed alternatively apologise application apply arrange arranged
asap assist assistance attached attachment authority authorization authorize authorized automatic automatically
booker cancellation cancelations cancellations cannot capacity charge charged charges charging clarify clarification
confirming correct corrected correction currently customer daytime deadline decide decision delayed deleted details
different directly due earlier earliest empty enjoy ensure error exceptional explain explanation extend extending
extension facilities family final finding finish finished following free frequently future gave going great guarantee
happy help helpful immediately information input inquiry keep latest liability limits longer manager management maximum
minimum modification modifications modify modified money multiple mustn't necessary nevertheless nights notice
notification observe occupancy occupied only otherwise outside outstanding pay payable paying payments people perhaps
policies policy previously proof provide provided providing purchase query question quite quotation quotes reason
reasons unfortunately unfortunately refunding refuse refusing refusal remove removed removing reply replied reschedule
rescheduled requested requesting review reviewed revise revising right save saved saving schedule service services
short shorten show showing shows shuttle similar situation standard subject submit submitted supporting system their
therefore three through till timing too top up usually valid verify verifying void waive waived waiver waiting without
work working wrong yesterday""".split())
MAX_CHARS = 12000


def scoped(message):
    rows = [row for row in message.get("sourceRows", [])
            if "active_transport" in row.get("scopeMembership", [])
            and row.get("privateMessage", {}).get("sourceMetadata", {}).get("transportId") == "transport-centurion"]
    if rows and (len(rows) != 1 or len(message.get("sourceRows", [])) != 1):
        raise ValueError("mixed_or_multiple_source_rows")
    return rows


def stamp(value):
    return dt.datetime.fromisoformat(str(value).replace("Z", "+00:00"))


def redact(value, recover_prefix=False):
    """Allowlisted vocabulary is deliberately lossy; preserve unknowns explicitly."""
    raw = str(value or "")
    marker = SECRET.search(raw)
    if marker and not recover_prefix:
        return {"text": "[sensitive withheld]", "withheld": True, "truncated": False}
    if marker:
        # Keep only material before the FIRST sensitive marker. Never emit the
        # marker or any following text, which may contain credentials/cards.
        raw = raw[:marker.start()]
        if not raw.strip():
            return {"text": "[sensitive withheld]", "withheld": True, "truncated": False}
    truncated = len(raw) > MAX_CHARS
    raw = raw[:MAX_CHARS]
    raw = re.sub(r"(?is)<(?:script|style)\b[^>]*>.*?</(?:script|style)>", " ", raw)
    raw = re.sub(r"(?i)<(?:br\s*/?|/div|/p|/tr|/li)\s*>", "\n", raw)
    raw = html.unescape(re.sub(r"<[^>]+>", " ", raw))
    raw = URL.sub(" link withheld ", MAIL.sub(" email withheld ", raw))
    raw = LONG_NUMBER.sub(" number withheld ", raw)

    def safe_token(token):
        if token.isdigit():
            return token if len(token) <= 2 else " [number] "
        if len(token) == 1 and not token.isalnum():
            return token
        return token.lower() if token.lower() in SAFE else " [redacted] "

    # Reconstruct from allowed tokens rather than leaving unmatched Unicode or
    # punctuation from the original text behind.
    text = " ".join(safe_token(match.group(0)) for match in TOKEN.finditer(raw))
    text = re.sub(r"(?:\s*\[redacted\]\s*){2,}", " [redacted] ", text)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\s+([.!?,:;])", r"\1", text)
    text = re.sub(r"\n[ \t]*\n+", "\n", text).strip()
    result = {"text": text, "withheld": False, "truncated": truncated}
    if marker:
        result["sensitive_tail_withheld"] = True
    return result


def view(message, row, delta_days=None, recover_prefix=False):
    private = row.get("privateMessage") or {}
    direction = private.get("direction")
    result = {"direction": direction if direction in ("inbound", "outbound") else "unknown",
              "subject": redact(private.get("subject"), recover_prefix),
              "body": redact(row.get("body"), recover_prefix),
              "attachment_inventory": "unknown"}
    if delta_days is not None:
        result["relative_day"] = delta_days
    return result


def write_jsonl(path, values):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as stream:
        for value in values:
            stream.write(json.dumps(value, ensure_ascii=True, separators=(",", ":")) + "\n")


def main():
    if len(sys.argv) not in (3, 4) or (len(sys.argv) == 4 and sys.argv[3] != "--recover-prefix"):
        raise SystemExit("usage: amend-context-sample.py CORPUS_JSONL EMPTY_PRIVATE_DIR [--recover-prefix]")
    recover_prefix = len(sys.argv) == 4
    root = pathlib.Path(".private").resolve(strict=True)
    source = pathlib.Path(sys.argv[1]).resolve(strict=True)
    out = pathlib.Path(sys.argv[2]).resolve(strict=True)
    if not source.is_relative_to(root) or out.parent != root or any(out.iterdir()):
        raise SystemExit("source must be private; output must be an empty direct child of .private")
    if out.stat().st_mode & 0o077:
        raise SystemExit("output directory must be owner-only")

    pools, directions, threads, seen = collections.defaultdict(list), collections.Counter(), set(), set()
    digest = hashlib.sha256()
    with source.open("rb") as stream:
        for line_number, raw in enumerate(stream, 1):
            digest.update(raw)
            record = json.loads(raw)
            if record.get("recordType") != "thread":
                continue
            for message_index, message in enumerate(record.get("messages", [])):
                day = str(message.get("timestamp") or "")[:10]
                if not START <= day <= END:
                    continue
                rows = scoped(message)
                if not rows:
                    continue
                row = rows[0]
                source_id = str(row.get("sourceRowId") or "")
                if not source_id or source_id in seen:
                    raise ValueError("missing_or_duplicate_source_row")
                seen.add(source_id)
                threads.add(record.get("threadId"))
                direction = row.get("privateMessage", {}).get("direction") or "unknown"
                directions[direction] += 1
                if direction != "inbound":
                    continue
                block = next(i for i, (start, end) in enumerate(BLOCKS) if start <= day <= end)
                text = ((row.get("privateMessage", {}).get("subject") or "") + " " + str(row.get("body") or ""))[:14000]
                text = html.unescape(re.sub(r"<[^>]+>", " ", text))
                a, c = bool(CHANGE.search(text)), bool(CANCEL.search(text))
                stratum = "both" if a and c else "change" if a else "cancel" if c else "neither"
                rank = hashlib.sha256((SEED + "\0" + source_id).encode()).hexdigest()
                pools[(block, stratum)].append({"rank": rank, "line": line_number, "index": message_index,
                                                "source_id": source_id, "timestamp": message["timestamp"]})

    chosen, populations, chosen_counts = [], {}, {}
    for block in range(len(BLOCKS)):
        for stratum, limit in QUOTA.items():
            pool = sorted(pools[(block, stratum)], key=lambda x: (x["rank"], x["timestamp"], x["source_id"]))
            key = f"{block + 1}_{stratum}"
            populations[key], chosen_counts[key] = len(pool), min(limit, len(pool))
            for item in pool[:limit]:
                chosen.append({**item, "block": block + 1, "stratum": stratum})
    chosen.sort(key=lambda item: (item["rank"], item["timestamp"], item["source_id"]))
    for index, item in enumerate(chosen):
        item.update({"case": f"A{index + 1:03}", "lane": index % 3 + 1})
    selected_lines = collections.defaultdict(list)
    for item in chosen:
        selected_lines[item["line"]].append(item)

    targets = collections.defaultdict(list)
    priors = collections.defaultdict(list)
    outcomes = collections.defaultdict(list)
    mapping = []
    second = hashlib.sha256()
    last_observation = dt.datetime.fromisoformat("2026-10-29T17:27:24.399+00:00")
    with source.open("rb") as stream:
        for line_number, raw in enumerate(stream, 1):
            second.update(raw)
            if line_number not in selected_lines:
                continue
            thread = json.loads(raw)
            for item in selected_lines[line_number]:
                message = thread["messages"][item["index"]]
                row = scoped(message)[0]
                if row.get("sourceRowId") != item["source_id"] or message.get("timestamp") != item["timestamp"]:
                    raise ValueError("sample_source_changed")
                anchor = stamp(message["timestamp"])
                earlier, later, same_time = [], [], 0
                for other in thread.get("messages", []):
                    rows = scoped(other)
                    if not rows or rows[0].get("sourceRowId") == item["source_id"]:
                        continue
                    when = stamp(other["timestamp"])
                    offset = (when - anchor).days
                    if when < anchor:
                        earlier.append((when, view(other, rows[0], offset, recover_prefix)))
                    elif when <= anchor + dt.timedelta(days=7) and when > anchor:
                        later.append((when, view(other, rows[0], offset, recover_prefix)))
                    elif when == anchor:
                        same_time += 1
                earlier.sort(key=lambda pair: pair[0])
                later.sort(key=lambda pair: pair[0])
                case, lane = item["case"], item["lane"]
                targets[lane].append({"case": case, "selected": view(message, row, recover_prefix=recover_prefix),
                                      "warning": "Redaction is lossy; quoted/forwarded text may remain."})
                priors[lane].append({"case": case, "earlier": [v for _, v in earlier], "same_timestamp_omitted": same_time})
                outcomes[lane].append({"case": case, "later": [v for _, v in later],
                                       "seven_day_censored": anchor + dt.timedelta(days=7) > last_observation})
                mapping.append({"case": case, "block": item["block"], "stratum": item["stratum"],
                                "source_row_id": item["source_id"], "thread_id": thread.get("threadId")})
    if digest.digest() != second.digest():
        raise ValueError("source_changed_during_selection")
    for lane in (1, 2, 3):
        for prefix, records in (("target", targets[lane]), ("prior", priors[lane]), ("outcome", outcomes[lane])):
            write_jsonl(out / f"{prefix}-{lane}.jsonl", sorted(records, key=lambda value: value["case"]))
    write_jsonl(out / "private-source-map.jsonl", sorted(mapping, key=lambda value: value["case"]))
    manifest = {"source_sha256": digest.hexdigest(), "seed": SEED, "start": START, "end": END,
                "blocks": BLOCKS, "quotas": QUOTA, "directions": dict(directions),
                "threads": len(threads), "population_by_block_stratum": populations,
                "sample_by_block_stratum": chosen_counts, "selected": len(chosen),
                "selection_unit": "inbound_source_row", "attachment_inventory": "unknown",
                "redaction": "allowlisted vocabulary; unknown words removed; lossy; private",
                "input_context": "all strictly earlier same-thread messages; ties omitted",
                "outcome_context": "all same-thread messages through seven days later or snapshot cutoff",
                "timestamp_timezone": "unverified"}
    if recover_prefix:
        manifest["redaction"] += "; prefix only before first sensitive marker; entire remaining tail withheld"
    write_jsonl(out / "manifest.jsonl", [manifest])
    print(json.dumps(manifest, sort_keys=True))


if __name__ == "__main__":
    main()
