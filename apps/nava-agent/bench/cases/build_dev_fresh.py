#!/usr/bin/env python3
"""Build FRESH ~120-case dev set from the same 29 Oct→19 Nov mail window as holdout-fresh.

Does NOT touch holdout-fresh output. Reuses build_holdout_fresh.py via env params:
  BENCH_FRESH_OUT          → cases/dev-fresh
  HOLDOUT_NEED_JSON        → same mix ratio as holdout (~120)
  BENCH_EXCLUDE_CASE_DIRS  → holdout-fresh (msgids + thread ids + confs)

Usage:
  python3 apps/nava-agent/bench/cases/build_dev_fresh.py
"""
from __future__ import annotations

import json
import os
import runpy
import sys
from pathlib import Path

DATA = Path("/home/orca/.local/share/zero/bench/replay-bench-20261119")
HERE = Path(__file__).resolve().parent

# Holdout mix n=102: create25 quote20 cancel15 amend15 filing12 triage15
# Scale ≈1.176 → ~120 (sum 121). After excluding holdout msgids/threads/confs,
# create/amend/cancel pool is exhausted — no quote-pad (FILL_TARGET=0); accept shortfall.
DEV_NEED = {
    "create": 29,
    "quote": 24,
    "cancel": 18,
    "amend": 18,
    "filing": 14,
    "triage": 18,
}

os.environ["BENCH_FRESH_OUT"] = str(DATA / "cases" / "dev-fresh")
os.environ["HOLDOUT_NEED_JSON"] = json.dumps(DEV_NEED)
os.environ["BENCH_EXCLUDE_CASE_DIRS"] = "holdout-fresh"
os.environ["BENCH_FILL_TARGET"] = "0"

print(
    f"[dev-fresh] OUT={os.environ['BENCH_FRESH_OUT']} "
    f"NEED={DEV_NEED} EXCLUDE=holdout-fresh FILL_TARGET=0",
    flush=True,
)

# Execute builder as __main__ so its argv guard runs main().
sys.argv = [str(HERE / "build_holdout_fresh.py")] + sys.argv[1:]
runpy.run_path(str(HERE / "build_holdout_fresh.py"), run_name="__main__")
