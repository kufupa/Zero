#!/usr/bin/env python3
"""Extract private request-first quote candidates from the saved Centurion corpus.

Requests: stored dates 2026-09-28 through 2026-10-18 inclusive.
Thread evidence: stored dates 2026-09-28 through 2026-10-23 inclusive.
Run with python3 -I -B month-quote-select.py CORPUS_JSONL NEW_PRIVATE_DIR.
The output contains original mail and identifiers; keep it owner-only under .private/.
"""
import json
import os
import pathlib
import re
import sys

REQUEST_START, REQUEST_END = "2026-09-28", "2026-10-18"
EVIDENCE_START, EVIDENCE_END = "2026-09-28", "2026-10-23"
QUOTE = re.compile(r"\b(?:quote|quotation|quoting|quoted|rate|rates|tariff|tariffs)\b", re.I)
STAY = re.compile(r"\b(?:room|rooms|accommodation|stay|night|nights|breakfast|dinner|reservation|booking)\b", re.I)


def in_scope(row):
    private = row.get("privateMessage", {})
    metadata = private.get("sourceMetadata", {})
    return (
        "active_transport" in row.get("scopeMembership", [])
        and metadata.get("transportId") == "transport-centurion"
    )


def main():
    if len(sys.argv) != 3:
        raise SystemExit("usage: python3 -I -B month-quote-select.py CORPUS_JSONL NEW_PRIVATE_DIR")
    corpus, outdir = map(pathlib.Path, sys.argv[1:])
    private_root = pathlib.Path(__file__).resolve().parents[4] / ".private"
    outdir = outdir.resolve()
    if not outdir.is_relative_to(private_root.resolve()):
        raise SystemExit("output directory must be a direct or nested child of repository .private/")
    if not outdir.is_dir() or (outdir.stat().st_mode & 0o777) != 0o700:
        raise SystemExit("output directory must already exist with mode 0700")
    output = outdir / "request-candidates.jsonl"
    if output.exists():
        raise SystemExit("refusing to overwrite existing output")

    threads = []
    selected_rows = 0
    with corpus.open(encoding="utf-8") as source:
        for line_no, line in enumerate(source, 1):
            record = json.loads(line)
            if record.get("recordType") != "thread":
                continue
            messages = []
            for position, message in enumerate(record.get("messages", []), 1):
                day = str(message.get("timestamp", ""))[:10]
                if not EVIDENCE_START <= day <= EVIDENCE_END:
                    continue
                for row in message.get("sourceRows", []):
                    if not in_scope(row):
                        continue
                    selected_rows += 1
                    private = row.get("privateMessage", {})
                    text = (private.get("subject") or "") + "\n" + (row.get("body") or "")
                    messages.append({
                        "position": position,
                        "timestamp": message.get("timestamp"),
                        "corpusLine": line_no,
                        "threadId": record.get("threadId"),
                        "messageId": message.get("messageId"),
                        "sourceRow": row,
                        "privateMessage": private,
                        "text": text,
                    })
            if messages:
                threads.append(messages)

    candidates = []
    for messages in threads:
        messages.sort(key=lambda item: (item["timestamp"] or "", item["position"]))
        for index, item in enumerate(messages):
            private = item["privateMessage"]
            if private.get("direction") != "inbound":
                continue
            request_day = str(item.get("timestamp", ""))[:10]
            if not REQUEST_START <= request_day <= REQUEST_END:
                continue
            text = item["text"]
            if not (QUOTE.search(text) and STAY.search(text)):
                continue
            candidates.append({
                "candidateId": f"R{len(candidates) + 1:04d}",
                "originalCorpusLine": item["corpusLine"],
                "threadId": item["threadId"],
                "messagePosition": item["position"],
                "timestamp": item["timestamp"],
                "messageId": item["messageId"],
                "sourceRowId": item["sourceRow"].get("sourceRowId"),
                "request": {
                    "receivedAt": item["sourceRow"].get("receivedAt"),
                    "sentAt": private.get("sentAt"),
                    "direction": private.get("direction"),
                    "addresses": private.get("addresses"),
                    "originalAddresses": private.get("originalAddresses"),
                    "canonicalHeaders": private.get("canonicalHeaders"),
                    "subject": private.get("subject"),
                    "body": item["sourceRow"].get("body"),
                    "attachments": private.get("attachments"),
                    "rawMime": private.get("rawMime"),
                },
                "sameThreadContext": [
                    {
                        "originalCorpusLine": other["corpusLine"],
                        "messagePosition": other["position"],
                        "timestamp": other["timestamp"],
                        "messageId": other["messageId"],
                        "sourceRowId": other["sourceRow"].get("sourceRowId"),
                        "direction": other["privateMessage"].get("direction"),
                        "addresses": other["privateMessage"].get("addresses"),
                        "canonicalHeaders": other["privateMessage"].get("canonicalHeaders"),
                        "subject": other["privateMessage"].get("subject"),
                        "body": other["sourceRow"].get("body"),
                        "attachments": other["privateMessage"].get("attachments"),
                    }
                    for other_index, other in enumerate(messages)
                    if other_index != index
                ],
                "selectionSignals": {
                    "explicitQuoteOrRateTerm": bool(QUOTE.search(text)),
                    "accommodationOrStayTerm": bool(STAY.search(text)),
                },
            })

    fd = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as target:
        for item in candidates:
            target.write(json.dumps(item, ensure_ascii=False) + "\n")
    print(json.dumps({
        "requestSelectionDateWindow": [REQUEST_START, REQUEST_END],
        "threadEvidenceDateWindow": [EVIDENCE_START, EVIDENCE_END],
        "scopedCenturionSourceRows": selected_rows,
        "candidateInboundMessages": len(candidates),
        "candidateThreads": len({item["threadId"] for item in candidates}),
        "privateOutput": str(output),
    }))


if __name__ == "__main__":
    main()
