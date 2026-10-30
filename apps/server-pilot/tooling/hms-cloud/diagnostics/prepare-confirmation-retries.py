#!/usr/bin/env python3
"""Prepare a private batch list from failed or unfinished confirmation reads."""

import argparse
import json
import os
import re
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("results", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    os.umask(0o077)
    if args.output.parent.stat().st_mode & 0o077:
        raise ValueError("Output directory is not private")
    results = json.loads(args.results.read_text())["results"]
    numbers = [row["confirmation"] for row in results if row.get("ok") is not True]
    if len(numbers) != len(set(numbers)) or any(not re.fullmatch(r"\d{6,}-\d+", number) for number in numbers):
        raise ValueError("Invalid failed confirmation list")
    lines = ["# Confirmation retries", "", "## Distinct exact ID candidates", "",
             "| Confirmation |", "| --- |"]
    lines.extend(f"| `{number}` |" for number in numbers)
    with args.output.open("x") as output:
        output.write("\n".join(lines) + "\n")
    print(json.dumps({"retryCount": len(numbers)}))


if __name__ == "__main__":
    main()
