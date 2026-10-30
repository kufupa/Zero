#!/usr/bin/env python3
"""Recover wrapped PDF guest names for ambiguous HMS confirmation searches."""

import argparse
import json
import os
import re
import subprocess
import tempfile
from pathlib import Path


IGNORED = {"mr", "mrs", "ms", "miss", "dr", "prof", "judge", "and", "the", "guest", "name"}


def tokens(value):
    return {word for word in re.findall(r"[^\W\d_]+", value.lower()) if len(word) > 1 and word not in IGNORED}


def layout_name(pdf):
    text = subprocess.run(["pdftotext", "-f", "1", "-l", "1", "-layout", str(pdf), "-"],
                          check=True, capture_output=True, text=True).stdout
    lines = text.splitlines()
    indexes = [index for index, line in enumerate(lines) if re.search(r"\bGuest Name\s*:", line, re.I)]
    if len(indexes) != 1:
        return None
    index = indexes[0]
    arrival = next((i for i in range(index + 1, min(index + 5, len(lines)))
                    if re.search(r"\bArrival Date\s*:", lines[i], re.I)), None)
    if arrival is None:
        return None
    date = re.search(r"\b\d{2}-\d{2}-\d{4}\b", lines[arrival])
    right = re.search(r"\bDeparture Date\s*:", lines[arrival], re.I)
    if not date or not right or date.start() >= right.start():
        return None
    selected = []
    if index and re.search(r"\bConfirmation Number\s*:", lines[index - 1], re.I):
        selected.append(lines[index - 1])
    selected.extend(lines[index:arrival])
    name = " ".join(line[date.start():right.start()].strip() for line in selected).strip()
    name = re.sub(r"\s+", " ", name)
    if not name or re.search(r"\d|\b(?:arrival|departure|confirmation|number)\b", name, re.I):
        return None
    return name


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("evidence", type=Path)
    parser.add_argument("results", type=Path)
    parser.add_argument("pdf_root", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--source-records", type=Path)
    args = parser.parse_args()
    os.umask(0o077)
    if args.output.parent.stat().st_mode & 0o077:
        raise ValueError("Output directory is not private")
    evidence = json.loads(args.evidence.read_text())
    results = json.loads(args.results.read_text())["results"]
    ambiguous = {row["confirmation"] for row in results if row.get("error") == "AMBIGUOUS_CONFIRMATION"}
    items = {item["confirmation"]: item for item in evidence["candidates"] if item["confirmation"] in ambiguous}
    attachment_owner = {attachment: number for number, item in items.items() for attachment in item["pdfAttachmentIds"]}
    records = {}
    with open(args.source_records or evidence["sourceRecords"]) as source:
        for line in source:
            record = json.loads(line)
            number = attachment_owner.get(record["source"]["attachmentId"])
            if number is None:
                continue
            sent = record["parentMessage"]["sentAt"] or record["parentMessage"]["createdAt"] or ""
            if number not in records or sent > records[number][0]:
                records[number] = (sent, record)

    recovered = 0
    for number, (_, record) in records.items():
        item = items[number]
        name = layout_name(args.pdf_root / record["source"]["sourceFilePath"])
        old = item.get("guestNameHint") or ""
        old_tokens = tokens(old)
        if (name and len(tokens(name)) > max(1, len(old_tokens)) and
                (len(old_tokens) < 2 or old_tokens <= tokens(name))):
            item["guestNameHintOriginal"] = old
            item["guestNameHint"] = name
            item["guestNameHintMethod"] = "Original PDF, first-page layout around Guest Name"
            recovered += 1

    temp = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", dir=args.output.parent,
                                         prefix=".guest-hints-", delete=False) as handle:
            temp = Path(handle.name)
            json.dump(evidence, handle, indent=2)
            handle.write("\n")
        # Keep the original evidence and refuse to overwrite another output.
        os.link(temp, args.output)
    finally:
        if temp and temp.exists():
            temp.unlink()
    print(json.dumps({"ambiguousCandidates": len(ambiguous), "namesRecovered": recovered}))


if __name__ == "__main__":
    main()
