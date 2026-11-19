#!/usr/bin/env python3
"""Routing gold audit: Luna labels action for THIS selected email (not thread journey).

ONE pass, 20 parallel. Writes gold-v2 + diff. Never edits original case.json gold.
"""
from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

DATA = Path(os.environ.get("NAVA_BENCH_DATA_ROOT") or "/home/orca/.local/share/zero/bench/replay-bench-20261119")
OUT_ROOT = DATA / "gold-audit"
AZURE_BASE = (os.environ.get("AZURE_OPENAI_BASE_URL") or "https://nava.openai.azure.com/openai/v1").rstrip("/")
AZURE_KEY = os.environ.get("AZURE_FOUNDRY_API_KEY") or os.environ.get("AZURE_OPENAI_API_KEY") or ""
LUNA_DEPLOY = os.environ.get("NAVA_AGENT_AZURE_DEPLOYMENT") or "gpt-6-luna"
WORKFLOWS = {"quote", "create", "amend", "cancel", "filing", "triage", "skip"}
CONCURRENCY = 20
REPO = Path(__file__).resolve().parents[4]  # apps/nava-agent/bench/cases -> repo root
PRODUCT_MD = REPO / "PRODUCT.md"


def load_product_workflow_defs() -> str:
  """Verbatim PRODUCT.md workflow + front-door skip definitions."""
  text = PRODUCT_MD.read_text()
  # From "The workflows:" through Filing bullet; plus Front door Skip + Pre-stay rule.
  start = text.index("The workflows:")
  end = text.index("**CMS confirmation")
  workflows = text[start:end].strip()
  front = text[text.index("## Front door"): text.index("## Pane")].strip()
  return workflows + "\n\n" + front


def build_system_prompt() -> str:
  defs = load_product_workflow_defs()
  return (
    "You audit hotel inbox routing gold labels.\n"
    "Gold = the action staff should take in response to THIS selected email only — "
    "not the thread's overall journey.\n"
    "If the selected email is a later ack ('Noted', thanks, FYI) with no new actionable "
    "booking ask, label triage or skip.\n"
    "If staff's next reply shows they treated it as a live booking action, prefer that workflow.\n\n"
    "=== PRODUCT.md WORKFLOW DEFINITIONS (verbatim) ===\n"
    f"{defs}\n"
    "=== END PRODUCT.md ===\n\n"
    "Return JSON only: {\"workflow\":\"quote|create|amend|cancel|filing|triage|skip\", "
    "\"evidence_quote\":\"verbatim substring from the INPUTS block\"}.\n"
    "evidence_quote MUST be copied verbatim from INPUTS (shown mail and/or staff-after)."
  )


SYSTEM = None  # built at runtime so PRODUCT.md edits apply


def msg_blob(msg: dict, prefix: str) -> str:
  if not isinstance(msg, dict):
    return ""
  nested = msg.get("message") if isinstance(msg.get("message"), dict) else msg
  subj = nested.get("subject") or ""
  body = nested.get("body_text") or nested.get("body") or ""
  direction = nested.get("direction") or ""
  frm = nested.get("from") or ""
  parts = [f"{prefix} direction={direction} from={frm}", f"{prefix} SUBJECT: {subj}", f"{prefix} BODY:\n{body}"]
  for pdf in nested.get("pdf_attachments_text") or []:
    if not isinstance(pdf, dict):
      continue
    name = pdf.get("filename") or pdf.get("name") or "pdf"
    text = pdf.get("extracted_text") or pdf.get("text") or ""
    parts.append(f"{prefix} PDF[{name}]:\n{text[:2500]}")
  return "\n".join(parts)


def pack_inputs(card: dict) -> str:
  """Shown inputs (agent-visible) + hidden after-context. Never proposal/gold workflow."""
  chunks: list[str] = []
  chunks.append(f"AS_OF: {card.get('as_of')}")
  sel = card.get("selected_email") or {}
  chunks.append("=== SHOWN SELECTED EMAIL ===")
  chunks.append(msg_blob(sel, "SELECTED"))
  before = card.get("context_before") or []
  if before:
    chunks.append("=== SHOWN CONTEXT BEFORE ===")
    for i, m in enumerate(before[:12]):
      chunks.append(msg_blob(m if isinstance(m, dict) else {}, f"BEFORE[{i}]"))
  xt = card.get("cross_thread_context") or []
  if xt:
    chunks.append("=== SHOWN CROSS-THREAD ===")
    for link in xt[:6]:
      if not isinstance(link, dict):
        continue
      chunks.append(f"XT rank={link.get('rank')} reason={link.get('reason')}")
      for j, m in enumerate((link.get("messages") or [])[:4]):
        chunks.append(msg_blob(m if isinstance(m, dict) else {}, f"XT[{j}]"))
  hms = card.get("hms_shown") or {}
  if isinstance(hms, dict) and hms.get("exists"):
    stay = hms.get("stay") or {}
    chunks.append(
      "=== SHOWN HMS SUMMARY ===\n"
      f"confirmation={hms.get('confirmation')} stay={json.dumps(stay, ensure_ascii=False)[:800]}"
    )
  after = card.get("context_after") or {}
  chunks.append("=== HIDDEN STAFF AFTER-CONTEXT (grader-only; what staff did next) ===")
  chunks.append(f"note: {after.get('note')}")
  for i, m in enumerate((after.get("messages") or [])[:10]):
    chunks.append(msg_blob(m if isinstance(m, dict) else {}, f"AFTER[{i}]"))
  for i, pdf in enumerate((after.get("confirmation_pdfs") or [])[:4]):
    if not isinstance(pdf, dict):
      continue
    chunks.append(
      f"AFTER_PDF[{i}] {pdf.get('filename') or ''}\n{(pdf.get('extracted_text') or pdf.get('text') or '')[:2000]}"
    )
  # Cap total size for API
  text = "\n\n".join(chunks)
  if len(text) > 28000:
    text = text[:28000] + "\n...[truncated]"
  return text


def call_luna(inputs: str) -> dict:
  if not AZURE_KEY:
    return {"_error": "missing_azure_key"}
  payload = {
    "model": LUNA_DEPLOY,
    "messages": [
      {"role": "system", "content": build_system_prompt()},
      {"role": "user", "content": f"INPUTS:\n{inputs}\n\nReturn JSON only."},
    ],
    # gpt-6-luna rejects temperature=0; omit → model default
    "max_completion_tokens": 250,
  }
  req = urllib.request.Request(
    f"{AZURE_BASE}/chat/completions",
    data=json.dumps(payload).encode(),
    headers={
      "Content-Type": "application/json",
      "api-key": AZURE_KEY,
      "Authorization": f"Bearer {AZURE_KEY}",
    },
    method="POST",
  )
  try:
    with urllib.request.urlopen(req, timeout=90) as resp:
      data = json.loads(resp.read().decode())
    content = data["choices"][0]["message"]["content"]
    content = content.strip().removeprefix("```json").removeprefix("```").removesuffix("```").strip()
    obj = json.loads(content)
  except (urllib.error.URLError, TimeoutError, KeyError, json.JSONDecodeError, IndexError, TypeError) as exc:
    return {"_error": str(exc)}
  quote = str(obj.get("evidence_quote") or "")
  wf = str(obj.get("workflow") or "").strip().lower()
  if wf not in WORKFLOWS:
    return {"_error": f"bad_workflow:{wf}", "raw": obj}
  if not quote or quote not in inputs:
    return {"_error": "evidence_quote_not_in_inputs", "raw": obj}
  return {"workflow": wf, "evidence_quote": quote}


def load_cases(cases_dir: Path) -> list[dict]:
  out = []
  for d in sorted(cases_dir.iterdir()):
    p = d / "case.json"
    if not p.exists():
      continue
    out.append(json.loads(p.read_text()))
  return out


def label_one(card: dict) -> dict:
  old = card.get("workflow")
  inputs = pack_inputs(card)
  result = call_luna(inputs)
  row = {
    "case_id": card["case_id"],
    "old_workflow": old,
    "set": None,
    "labeller": result,
  }
  if result.get("_error"):
    row.update({
      "new_workflow": old,
      "changed": False,
      "skip": False,
      "reason": f"keep_old:{result['_error']}",
      "evidence_quote": None,
    })
    return row
  labelled = result["workflow"]
  skip = labelled == "skip"
  new = "triage" if skip else labelled
  quote = result["evidence_quote"]
  changed = new != old
  row.update({
    "new_workflow": new,
    "changed": changed,
    "skip": skip,
    "evidence_quote": quote,
    "reason": "relabel" if changed else "agree",
  })
  return row


def audit_set(name: str, cases_dir: Path) -> dict:
  cases = load_cases(cases_dir)
  print(f"[audit] {name} n={len(cases)} concurrency={CONCURRENCY}", flush=True)
  rows = []
  t0 = time.time()
  with ThreadPoolExecutor(max_workers=CONCURRENCY) as pool:
    futs = {pool.submit(label_one, c): c["case_id"] for c in cases}
    done = 0
    for fut in as_completed(futs):
      row = fut.result()
      row["set"] = name
      rows.append(row)
      done += 1
      if done % 25 == 0 or done == len(cases):
        print(f"[audit] {name} {done}/{len(cases)}", flush=True)
  rows.sort(key=lambda r: r["case_id"])
  gold_v2 = {
    r["case_id"]: {
      "workflow": r["new_workflow"],
      "old_workflow": r["old_workflow"],
      "changed": r["changed"],
      "skip": r["skip"],
      "evidence_quote": r["evidence_quote"],
      "reason": r["reason"],
    }
    for r in rows
  }
  diffs = [
    {
      "case_id": r["case_id"],
      "old": r["old_workflow"],
      "new": r["new_workflow"],
      "quote": r["evidence_quote"],
      "skip": r["skip"],
    }
    for r in rows
    if r["changed"]
  ]
  transitions = Counter((r["old_workflow"], r["new_workflow"]) for r in rows if r["changed"])
  errors = sum(1 for r in rows if str(r.get("reason", "")).startswith("keep_old:"))
  summary = {
    "set": name,
    "n": len(rows),
    "changed": len(diffs),
    "errors_kept_old": errors,
    "skip_marks": sum(1 for r in rows if r.get("skip")),
    "transitions": {f"{a}->{b}": n for (a, b), n in sorted(transitions.items())},
    "elapsed_s": round(time.time() - t0, 1),
    "model": LUNA_DEPLOY,
    "concurrency": CONCURRENCY,
  }
  out_dir = OUT_ROOT / name
  out_dir.mkdir(parents=True, exist_ok=True)
  (out_dir / "gold-v2.json").write_text(json.dumps(gold_v2, indent=2, ensure_ascii=False))
  (out_dir / "diff.jsonl").write_text(
    "\n".join(json.dumps(d, ensure_ascii=False) for d in diffs) + ("\n" if diffs else "")
  )
  (out_dir / "labels-all.jsonl").write_text(
    "\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n"
  )
  (out_dir / "summary.json").write_text(json.dumps(summary, indent=2))
  print(json.dumps(summary, indent=2), flush=True)
  return summary


def targets_from_v2(name: str) -> list[str]:
  """Changed + errored case ids from gold-v2 pass (finish failed pass, not full re-eval)."""
  path = OUT_ROOT / name / "labels-all.jsonl"
  out = []
  for line in open(path):
    r = json.loads(line)
    if r.get("changed") or str(r.get("reason", "")).startswith("keep_old"):
      out.append(r["case_id"])
  return out


def repass_set_to_v3(name: str, cases_dir: Path) -> dict:
  """Re-label only v2 changed+errored; merge into gold-v3. Original case.json untouched."""
  gold_v2 = json.loads((OUT_ROOT / name / "gold-v2.json").read_text())
  target_ids = set(targets_from_v2(name))
  by_id = {c["case_id"]: c for c in load_cases(cases_dir)}
  targets = [by_id[cid] for cid in sorted(target_ids) if cid in by_id]
  print(f"[repass→v3] {name} targets={len(targets)}/{len(gold_v2)} concurrency={CONCURRENCY}", flush=True)

  relabel_rows: list[dict] = []
  t0 = time.time()
  with ThreadPoolExecutor(max_workers=CONCURRENCY) as pool:
    futs = {pool.submit(label_one, c): c["case_id"] for c in targets}
    done = 0
    for fut in as_completed(futs):
      row = fut.result()
      row["set"] = name
      row["pass"] = "v3-repass"
      relabel_rows.append(row)
      done += 1
      if done % 20 == 0 or done == len(targets):
        print(f"[repass→v3] {name} {done}/{len(targets)}", flush=True)

  relabel_by_id = {r["case_id"]: r for r in relabel_rows}
  gold_v3: dict[str, dict] = {}
  for cid, prev in gold_v2.items():
    if cid in relabel_by_id:
      r = relabel_by_id[cid]
      gold_v3[cid] = {
        "workflow": r["new_workflow"],
        "old_workflow": r["old_workflow"],
        "changed": r["changed"],
        "skip": r["skip"],
        "evidence_quote": r["evidence_quote"],
        "reason": r["reason"],
        "pass": "v3-repass",
        "v2_workflow": prev.get("workflow"),
        "v2_changed": prev.get("changed"),
      }
    else:
      # Untouched from v2 (agreed with original).
      gold_v3[cid] = {**prev, "pass": "v2-carry"}

  diffs = [
    {
      "case_id": cid,
      "old": row["old_workflow"],
      "new": row["workflow"],
      "quote": row.get("evidence_quote"),
      "skip": row.get("skip"),
    }
    for cid, row in sorted(gold_v3.items())
    if row.get("changed")
  ]
  transitions = Counter((d["old"], d["new"]) for d in diffs)
  errors = sum(1 for r in relabel_rows if str(r.get("reason", "")).startswith("keep_old:"))
  # How many v2 changes survived / reverted
  v2_changed_ids = {cid for cid, r in gold_v2.items() if r.get("changed")}
  still = sum(1 for cid in v2_changed_ids if gold_v3[cid].get("changed") and gold_v3[cid]["workflow"] == gold_v2[cid]["workflow"])
  reverted = sum(1 for cid in v2_changed_ids if not gold_v3[cid].get("changed"))
  retargeted = sum(
    1
    for cid in v2_changed_ids
    if gold_v3[cid].get("changed") and gold_v3[cid]["workflow"] != gold_v2[cid]["workflow"]
  )
  summary = {
    "set": name,
    "n": len(gold_v3),
    "repass_targets": len(targets),
    "changed": len(diffs),
    "errors_kept_old": errors,
    "skip_marks": sum(1 for r in gold_v3.values() if r.get("skip")),
    "transitions": {f"{a}->{b}": n for (a, b), n in sorted(transitions.items())},
    "v2_changed_survived": still,
    "v2_changed_reverted": reverted,
    "v2_changed_retargeted": retargeted,
    "elapsed_s": round(time.time() - t0, 1),
    "model": LUNA_DEPLOY,
    "concurrency": CONCURRENCY,
    "product_md": str(PRODUCT_MD),
  }
  out_dir = OUT_ROOT / name
  (out_dir / "gold-v3.json").write_text(json.dumps(gold_v3, indent=2, ensure_ascii=False))
  (out_dir / "diff-v3.jsonl").write_text(
    "\n".join(json.dumps(d, ensure_ascii=False) for d in diffs) + ("\n" if diffs else "")
  )
  (out_dir / "labels-repass-v3.jsonl").write_text(
    "\n".join(json.dumps(r, ensure_ascii=False) for r in sorted(relabel_rows, key=lambda x: x["case_id"])) + "\n"
  )
  (out_dir / "summary-v3.json").write_text(json.dumps(summary, indent=2))
  print(json.dumps(summary, indent=2), flush=True)
  return summary


def load_cases_filtered(cases_dir: Path, ids: set[str] | None) -> list[dict]:
  cases = load_cases(cases_dir)
  if not ids:
    return cases
  return [c for c in cases if c.get("case_id") in ids]


def audit_set_filtered(name: str, cases_dir: Path, ids: set[str] | None = None) -> dict:
  """Like audit_set but optional case-id allowlist (for holdout-v2 new-only)."""
  cases = load_cases_filtered(cases_dir, ids)
  print(f"[audit] {name} n={len(cases)} concurrency={CONCURRENCY}", flush=True)
  rows = []
  t0 = time.time()
  with ThreadPoolExecutor(max_workers=CONCURRENCY) as pool:
    futs = {pool.submit(label_one, c): c["case_id"] for c in cases}
    done = 0
    for fut in as_completed(futs):
      row = fut.result()
      row["set"] = name
      rows.append(row)
      done += 1
      if done % 25 == 0 or done == len(cases):
        print(f"[audit] {name} {done}/{len(cases)}", flush=True)
  rows.sort(key=lambda r: r["case_id"])
  gold_v2 = {
    r["case_id"]: {
      "workflow": r["new_workflow"],
      "old_workflow": r["old_workflow"],
      "changed": r["changed"],
      "skip": r["skip"],
      "evidence_quote": r["evidence_quote"],
      "reason": r["reason"],
    }
    for r in rows
  }
  # Merge into existing gold-v2 when filtering (preserve prior ids).
  out_dir = OUT_ROOT / name
  out_dir.mkdir(parents=True, exist_ok=True)
  prev_path = out_dir / "gold-v2.json"
  if ids and prev_path.exists():
    prev = json.loads(prev_path.read_text())
    prev.update(gold_v2)
    gold_v2 = prev
  diffs = [
    {
      "case_id": r["case_id"],
      "old": r["old_workflow"],
      "new": r["new_workflow"],
      "quote": r["evidence_quote"],
      "skip": r["skip"],
    }
    for r in rows
    if r["changed"]
  ]
  transitions = Counter((r["old_workflow"], r["new_workflow"]) for r in rows if r["changed"])
  errors = sum(1 for r in rows if str(r.get("reason", "")).startswith("keep_old:"))
  summary = {
    "set": name,
    "n": len(gold_v2),
    "labelled_this_pass": len(rows),
    "changed": len(diffs),
    "errors_kept_old": errors,
    "skip_marks": sum(1 for r in rows if r.get("skip")),
    "transitions": {f"{a}->{b}": n for (a, b), n in sorted(transitions.items())},
    "elapsed_s": round(time.time() - t0, 1),
    "model": LUNA_DEPLOY,
    "concurrency": CONCURRENCY,
  }
  (out_dir / "gold-v2.json").write_text(json.dumps(gold_v2, indent=2, ensure_ascii=False))
  (out_dir / "diff.jsonl").write_text(
    "\n".join(json.dumps(d, ensure_ascii=False) for d in diffs) + ("\n" if diffs else "")
  )
  labels_path = out_dir / "labels-all.jsonl"
  if ids and labels_path.exists():
    keep = []
    for line in labels_path.open():
      row = json.loads(line)
      if row.get("case_id") not in ids:
        keep.append(row)
    keep.extend(rows)
    keep.sort(key=lambda r: r["case_id"])
    labels_path.write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in keep) + "\n")
  else:
    labels_path.write_text(
      "\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n"
    )
  (out_dir / "summary.json").write_text(json.dumps(summary, indent=2))
  print(json.dumps(summary, indent=2), flush=True)
  return summary


def main() -> None:
  if not AZURE_KEY:
    raise SystemExit("AZURE key missing")
  OUT_ROOT.mkdir(parents=True, exist_ok=True)
  # Verify PRODUCT.md defs load
  defs = load_product_workflow_defs()
  assert "**Filing**" in defs and "**Skip**" in defs, defs[:200]
  stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")

  args = sys.argv[1:]
  ids: set[str] | None = None
  if "--ids-file" in args:
    i = args.index("--ids-file")
    ids = set(json.loads(Path(args[i + 1]).read_text()))
    args = args[:i] + args[i + 2:]

  if args and args[0] in ("repass-v3", "v3", "--repass-v3"):
    meta = {
      "started_at": stamp,
      "mode": "repass-v3",
      "note": "re-label only v2 changed+errored; finish failed pass; PRODUCT.md defs in prompt",
      "original_gold": "untouched",
      "ids_filter": sorted(ids) if ids else None,
    }
    (OUT_ROOT / "meta-v3.json").write_text(json.dumps(meta, indent=2))
    if len(args) >= 2:
      name = args[1]
      cases_dir = DATA / "cases" / name
      summary = repass_set_to_v3(name, cases_dir)
      (OUT_ROOT / name / "summary-v3.json").write_text(json.dumps(summary, indent=2))
    else:
      holdout = repass_set_to_v3("holdout-fresh", DATA / "cases/holdout-fresh")
      v1 = repass_set_to_v3("v1", DATA / "cases/v1")
      (OUT_ROOT / "summary-v3.json").write_text(json.dumps({"holdout-fresh": holdout, "v1": v1}, indent=2))
    print("[repass→v3] done", OUT_ROOT, flush=True)
    return

  if args and args[0] == "audit":
    name = args[1] if len(args) > 1 else "holdout-fresh"
    cases_dir = DATA / "cases" / name
    meta = {
      "started_at": stamp,
      "rule": "one_pass_no_tuning",
      "original_gold": "untouched",
      "set": name,
      "ids_filter_n": len(ids) if ids else None,
    }
    (OUT_ROOT / name / "meta.json").write_text(json.dumps(meta, indent=2))
    audit_set_filtered(name, cases_dir, ids)
    print("[audit] done", OUT_ROOT / name, flush=True)
    return

  meta = {"started_at": stamp, "rule": "one_pass_no_tuning", "original_gold": "untouched"}
  (OUT_ROOT / "meta.json").write_text(json.dumps(meta, indent=2))
  holdout = audit_set("holdout-fresh", DATA / "cases/holdout-fresh")
  v1 = audit_set("v1", DATA / "cases/v1")
  (OUT_ROOT / "summary.json").write_text(json.dumps({"holdout-fresh": holdout, "v1": v1}, indent=2))
  print("[audit] done", OUT_ROOT, flush=True)


if __name__ == "__main__":
  main()
