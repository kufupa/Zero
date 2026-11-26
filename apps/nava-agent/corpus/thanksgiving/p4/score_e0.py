#!/usr/bin/env python3
"""Score P4 E0 linkage runs."""
from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

DEFAULT_WORK = Path.home() / ".local/share/zero/research/thanksgiving/work/p4"
DEFAULT_DB = DEFAULT_WORK / "snapshot.sqlite"
DEFAULT_SAMPLES = DEFAULT_WORK / "samples"


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    rows = []
    with path.open(encoding="utf-8") as handle:
        for line in handle:
            if line.strip():
                try:
                    rows.append(json.loads(line))
                except json.JSONDecodeError:
                    pass
    return rows


def parse_time(value: Any) -> datetime:
    if not isinstance(value, str) or not value:
        return datetime.max.replace(tzinfo=timezone.utc)
    text = value.strip()
    try:
        if text.endswith(("Z", "z")):
            text = text[:-1] + "+00:00"
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return datetime.max.replace(tzinfo=timezone.utc)
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def load_results(run_dir: Path, extra: list[Path]) -> dict[str, dict[str, dict[str, Any]]]:
    paths = []
    for name in ("links.jsonl", "leads.jsonl", "judge.jsonl"):
        path = run_dir / name
        if path.exists():
            paths.append(path)
    paths.extend(extra)
    grouped: dict[str, dict[str, dict[str, Any]]] = defaultdict(dict)
    for path in paths:
        for row in read_jsonl(path):
            arm = row.get("arm")
            conf = row.get("confirmation")
            if isinstance(arm, str) and isinstance(conf, str):
                grouped[arm][conf] = row
    return dict(grouped)


def load_p3(db: Path) -> tuple[dict[str, list[dict[str, Any]]], dict[str, set[str]]]:
    con = sqlite3.connect(str(db))
    con.row_factory = sqlite3.Row
    rows = con.execute(
        """
        select pk.confirmation, pk.message_id, pk.source, m.sent_at, m.thread_id, m.direction
        from p3_key pk join message m on m.id = pk.message_id
        """
    ).fetchall()
    con.close()
    by_conf: dict[str, list[dict[str, Any]]] = defaultdict(list)
    owners: dict[str, set[str]] = defaultdict(set)
    for row in rows:
        item = dict(row)
        item["sent_dt"] = parse_time(item.get("sent_at"))
        by_conf[item["confirmation"]].append(item)
        owners["msg:" + item["message_id"]].add(item["confirmation"])
    for items in by_conf.values():
        items.sort(key=lambda x: (x["sent_dt"], x["message_id"]))
    return dict(by_conf), dict(owners)


def load_messages(db: Path) -> tuple[dict[str, dict[str, Any]], dict[str, list[dict[str, Any]]]]:
    con = sqlite3.connect(str(db))
    con.row_factory = sqlite3.Row
    rows = [dict(row) for row in con.execute("select id,thread_id,sent_at,direction,from_addr,subject from message")]
    con.close()
    by_id = {}
    by_thread: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        row["sent_dt"] = parse_time(row.get("sent_at"))
        by_id[row["id"]] = row
        by_thread[row.get("thread_id") or ""].append(row)
    for items in by_thread.values():
        items.sort(key=lambda x: (x["sent_dt"], x["id"]))
    return by_id, dict(by_thread)


def load_edges(db: Path) -> dict[str, set[str]]:
    con = sqlite3.connect(str(db))
    out: dict[str, set[str]] = defaultdict(set)
    for src, dst in con.execute("select src_id,dst_id from header_edge"):
        out[src].add(dst); out[dst].add(src)
    con.close()
    return dict(out)


def load_hms(db: Path) -> dict[str, dict[str, Any]]:
    con = sqlite3.connect(str(db)); con.row_factory = sqlite3.Row
    rows = [dict(r) for r in con.execute("select confirmation,guest_name,created_at from hms_stay")]
    con.close()
    out = {}
    for row in rows:
        row["created_dt"] = parse_time(row.get("created_at"))
        row["tokens"] = guest_tokens(row.get("guest_name") or "")
        out[row["confirmation"]] = row
    return out


def guest_tokens(name: str) -> set[str]:
    titles = {"mr", "mrs", "ms", "miss", "dr", "prof"}
    if "," in name:
        last = name.split(",", 1)[0].strip()
        rest = name.split(",", 1)[1].strip().split()
        first = next((w for w in rest if w.strip(".,").casefold() not in titles), "")
        raw = [last, first]
    else:
        words = [w.strip(".,") for w in name.split() if w.strip(".,").casefold() not in titles]
        raw = ([words[0], words[-1]] if words else [])
    return {w.casefold() for w in raw if len(w.strip()) >= 3}


def gold_candidates(hits: list[dict[str, Any]], by_thread: dict[str, list[dict[str, Any]]], edges: dict[str, set[str]], created: datetime) -> tuple[set[str], str]:
    cutoff = created.timestamp() + 900
    cand: dict[str, datetime] = {}
    hit_ids = {h["message_id"] for h in hits}
    for hit in hits:
        for m in by_thread.get(hit.get("thread_id") or "", []):
            if m.get("direction") == "inbound" and m["sent_dt"].timestamp() <= cutoff:
                cand[m["id"]] = m["sent_dt"]
    for mid in hit_ids:
        for other in edges.get(mid, set()):
            thread_msgs = [m for items in by_thread.values() for m in items if m["id"] == other]
            for m in thread_msgs:
                if m.get("direction") == "inbound" and m["sent_dt"].timestamp() <= cutoff:
                    cand[m["id"]] = m["sent_dt"]
    if not cand:
        return set(), "letter_only"
    first = min(cand.values())
    return {"msg:" + mid for mid, dt in cand.items() if dt == first}, "inbound_p3_thread_or_header"


def infer_gold_requests(hits: list[dict[str, Any]], by_thread: dict[str, list[dict[str, Any]]]) -> tuple[set[str], set[str], str]:
    literal_ids = {"msg:" + hit["message_id"] for hit in hits}
    first_hit_time = min((hit["sent_dt"] for hit in hits), default=None)
    literal_earliest = {"msg:" + hit["message_id"] for hit in hits if hit["sent_dt"] == first_hit_time} if first_hit_time else set()
    candidates = []
    for hit in hits:
        thread = by_thread.get(hit.get("thread_id") or "", [])
        prior_inbound = [m for m in thread if m.get("direction") == "inbound" and m["sent_dt"] <= hit["sent_dt"]]
        chosen = prior_inbound[0] if prior_inbound else by_idless_message(hit)
        if chosen:
            candidates.append({"id": "msg:" + chosen["id"], "sent_dt": chosen["sent_dt"]})
    if not candidates:
        return literal_earliest, literal_ids, "literal_p3_no_thread_messages"
    first_time = min(item["sent_dt"] for item in candidates)
    return {item["id"] for item in candidates if item["sent_dt"] == first_time}, literal_ids, "earliest_inbound_in_p3_thread"


def by_idless_message(hit: dict[str, Any]) -> dict[str, Any] | None:
    if "message_id" not in hit:
        return None
    return {"id": hit["message_id"], "sent_dt": hit["sent_dt"]}


def canonical_id(ident: str) -> str:
    return "msg:" + ident[4:] if ident.startswith("hdr:") else ident


def citation_ids(items: Any) -> set[str]:
    if not isinstance(items, list):
        return set()
    return {canonical_id(str(item.get("id"))) for item in items if isinstance(item, dict) and item.get("id")}


def result_ids(row: dict[str, Any] | None) -> tuple[set[str], set[str]]:
    if not row:
        return set(), set()
    earliest = citation_ids(row.get("earliest_request"))
    members = citation_ids(row.get("members"))
    return earliest, earliest | members


def rate(n: int, d: int) -> float | None:
    return round(n / d, 4) if d else None


def score_e0a(samples: list[dict[str, Any]], results: dict[str, dict[str, dict[str, Any]]], p3: dict[str, list[dict[str, Any]]], owners: dict[str, set[str]], by_thread: dict[str, list[dict[str, Any]]], edges: dict[str, set[str]], hms: dict[str, dict[str, Any]], db: Path) -> dict[str, Any]:
    per_arm: dict[str, Any] = {}
    sample_by_conf = {row["confirmation"]: row for row in samples}
    con = sqlite3.connect(str(db)); con.row_factory = sqlite3.Row
    text_cache: dict[str, str] = {}
    meta_cache: dict[str, dict[str, Any]] = {}

    def msgmeta(mid: str) -> dict[str, Any]:
        key = mid[4:] if mid.startswith("msg:") else mid
        if key not in meta_cache:
            r = con.execute("select id,sent_at,direction,subject,body_text from message where id=?", (key,)).fetchone()
            meta_cache[key] = dict(r) if r else {}
        return meta_cache[key]

    def msgtext(mid: str) -> str:
        key = mid[4:] if mid.startswith("msg:") else mid
        if key in text_cache: return text_cache[key]
        r = con.execute("select subject,body_text from message where id=?", (key,)).fetchone()
        parts = [r["subject"] or "", r["body"] if False else r["body_text"] or ""] if r else []
        for a in con.execute("select id from attachment where message_id=?", (key,)):
            d = con.execute("select text from doc_text where attachment_id=?", (a["id"],)).fetchone()
            if d: parts.append(d["text"] or "")
        text_cache[key] = "\n".join(parts).casefold()
        return text_cache[key]

    def mentions(mid: str, tokens: set[str]) -> bool:
        text = msgtext(mid)
        return any(t in text for t in tokens)

    def is_false_merge(conf: str, ids: set[str]) -> bool:
        target = hms.get(conf, {})
        tt = target.get("tokens") or set(); created = target.get("created_dt")
        if not tt or not created: return False
        for mid in ids:
            text = msgtext(mid)
            if any(t in text for t in tt): continue
            for other, stay in hms.items():
                if other == conf or not stay.get("created_dt"): continue
                if abs((stay["created_dt"] - created).total_seconds()) > 7*86400: continue
                ot = stay.get("tokens") or set()
                if ot and any(t in text for t in ot): return True
        return False

    for arm, rows in sorted(results.items()):
        cells = []
        for conf, sample in sorted(sample_by_conf.items()):
            pred = rows.get(conf); earliest, all_ids = result_ids(pred)
            stay = hms.get(conf, {}); created = stay.get("created_dt") or datetime.max.replace(tzinfo=timezone.utc)
            gold_earliest, gold_method = gold_candidates(p3.get(conf, []), by_thread, edges, created)
            letter_only = gold_method == "letter_only"
            status = pred.get("status") if pred else "missing"
            found = bool(pred and status == "found" and earliest)
            exact = bool(found and not letter_only and earliest == gold_earliest)
            overlap = bool(all_ids & gold_earliest)
            mismatch = bool(found and not letter_only and not overlap)
            fm = bool(mismatch and is_false_merge(conf, all_ids))
            unverified = bool(mismatch and not fm)
            msgs = [msgmeta(x) for x in earliest]
            target_tokens = stay.get("tokens") or set()
            names = bool(target_tokens and any(mentions(x, target_tokens) for x in all_ids))
            before = bool(msgs and any(parse_time(m.get("sent_at")).timestamp() <= created.timestamp() + 900 for m in msgs if m))
            found_inbound = bool(any(m.get("direction") == "inbound" for m in msgs if m))
            cells.append({"confirmation": conf,"disable_headers": bool(sample.get("disable_headers")),"status": status,"letter_only": letter_only,"exact_earliest_request_match": exact,"wrong_link": mismatch,"wrong_link_unverified": unverified,"recall_hit": overlap,"false_merge": fm,"not_found": status == "not_found","found_inbound": found_inbound,"names_guest": names,"before_create": before,"pred_earliest": sorted(earliest),"gold_earliest": sorted(gold_earliest),"gold_method": gold_method})
        con.close(); con = sqlite3.connect(str(db)); con.row_factory = sqlite3.Row
        n=len(cells); scoreable=sum(1 for c in cells if not c["letter_only"])
        def count(k): return sum(1 for c in cells if c[k])
        def scount(k): return sum(1 for c in cells if c[k] and not c["letter_only"])
        breakdown={}
        for flag in (False,True):
            part=[c for c in cells if c["disable_headers"]==flag]; pn=sum(1 for c in part if not c["letter_only"])
            breakdown["headers_disabled" if flag else "headers_enabled"]={"n":len(part),"scoreable_n":pn,"exact":sum(1 for x in part if x["exact_earliest_request_match"]),"exact_rate":rate(sum(1 for x in part if x["exact_earliest_request_match"]),pn),"wrong_link":sum(1 for x in part if x["wrong_link"]),"wrong_link_rate":rate(sum(1 for x in part if x["wrong_link"]),pn)}
        per_arm[arm]={"n":n,"scoreable_n":scoreable,"letter_only":count("letter_only"),"exact_earliest_request_match":scount("exact_earliest_request_match"),"exact_earliest_request_rate":rate(scount("exact_earliest_request_match"),scoreable),"wrong_link":scount("wrong_link"),"wrong_link_rate":rate(scount("wrong_link"),scoreable),"wrong_link_unverified":scount("wrong_link_unverified"),"recall":count("recall_hit"),"recall_rate":rate(count("recall_hit"),n),"false_merge":count("false_merge"),"false_merge_count":count("false_merge"),"not_found":count("not_found"),"not_found_rate":rate(count("not_found"),n),"found_inbound":count("found_inbound"),"names_guest":count("names_guest"),"before_create":count("before_create"),"breakdown":breakdown,"cells":cells}
    con.close()
    return {"metric_note":"E0-A gold = earliest inbound message in a P3 thread or header-linked to a P3 message, sent <= created_at+15m. letter_only cases are excluded from exact/wrong-link denominators. false_merge requires no target-guest mention plus another ±7d HMS guest mention; other mismatches are wrong_link_unverified.","arms":per_arm}

def agreement_category(linker: dict[str, Any] | None, judge: dict[str, Any] | None) -> str:
    if linker is None or judge is None:
        return "missing"
    le, _ = result_ids(linker)
    je, _ = result_ids(judge)
    ls, js = linker.get("status"), judge.get("status")
    if ls == "found" and js == "found" and le and le == je:
        return "agree_exact_earliest"
    if ls == "not_found" and js == "not_found":
        return "agree_not_found"
    if ls == "ambiguous" and js == "ambiguous":
        return "agree_ambiguous"
    if ls == "found" and js == "not_found":
        return "linker_found_judge_not_found"
    if ls == "not_found" and js == "found":
        return "judge_found_linker_not_found"
    if ls == "found" and js == "found" and le != je:
        return "disagree_different_earliest"
    return f"linker_{ls}_judge_{js}"


def score_e0b(samples: list[dict[str, Any]], results: dict[str, dict[str, dict[str, Any]]], linker_arm: str | None) -> dict[str, Any]:
    arms = sorted(results)
    if linker_arm is None:
        linker_arm = "luna" if "luna" in results else next((arm for arm in arms if arm != "haiku_judge"), arms[0] if arms else "luna")
    judge = results.get("haiku_judge", {})
    linker = results.get(linker_arm, {})
    overall: dict[str, int] = defaultdict(int)
    strata: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    cells = []
    for sample in samples:
        conf = sample["confirmation"]
        stratum = sample.get("stratum", "unknown")
        cat = agreement_category(linker.get(conf), judge.get(conf))
        overall[cat] += 1
        strata[stratum][cat] += 1
        le, _ = result_ids(linker.get(conf))
        je, _ = result_ids(judge.get(conf))
        cells.append({"confirmation": conf, "stratum": stratum, "category": cat, "linker_earliest": sorted(le), "judge_earliest": sorted(je)})
    return {
        "linker_arm": linker_arm,
        "judge_arm": "haiku_judge",
        "n": len(samples),
        "overall": dict(sorted(overall.items())),
        "per_stratum": {k: dict(sorted(v.items())) for k, v in sorted(strata.items())},
        "cells": cells,
    }


def score_hooks(samples: list[dict[str, Any]], results: dict[str, dict[str, dict[str, Any]]]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for arm, rows in sorted(results.items()):
        cells = []
        for hook in samples:
            pred = rows.get(hook["confirmation"])
            earliest, all_ids = result_ids(pred)
            expected = set(hook.get("expected_earliest_request_ids") or [])
            confounders = set(hook.get("confounder_ids") or [])
            expected_status = hook.get("expected_status") or "found"
            if expected_status == "not_found":
                passed = bool(pred and pred.get("status") == "not_found")
            else:
                passed = bool(pred and pred.get("status") == "found" and expected and expected <= earliest and not (all_ids & confounders))
            cells.append(
                {
                    "hook_id": hook.get("hook_id"),
                    "confirmation": hook["confirmation"],
                    "pass": passed,
                    "status": pred.get("status") if pred else "missing",
                    "expected_earliest": sorted(expected),
                    "pred_earliest": sorted(earliest),
                    "confounder_hits": sorted(all_ids & confounders),
                }
            )
        out[arm] = {"passed": sum(1 for c in cells if c["pass"]), "n": len(cells), "cells": cells}
    return out


def md_table(headers: list[str], rows: list[list[Any]]) -> str:
    lines = ["| " + " | ".join(headers) + " |", "|" + "|".join(["---"] * len(headers)) + "|"]
    for row in rows:
        lines.append("| " + " | ".join(str(x) for x in row) + " |")
    return "\n".join(lines)


def markdown(score: dict[str, Any]) -> str:
    lines = ["# P4 E0 score", "", f"run_dir: `{score['run_dir']}`", ""]
    lines += ["## E0-A vs masked P3 gold", ""]
    rows = []
    for arm, cell in sorted(score["e0a"]["arms"].items()):
        rows.append([arm, f"{cell['n']}/{cell['scoreable_n']}", f"{cell['exact_earliest_request_match']} ({cell['exact_earliest_request_rate']})", f"{cell['wrong_link']} ({cell['wrong_link_rate']})", cell["wrong_link_unverified"], f"{cell['recall']} ({cell['recall_rate']})", cell["false_merge_count"], f"{cell['not_found']} ({cell['not_found_rate']})", cell["found_inbound"], cell["names_guest"], cell["before_create"]])
    lines.append(md_table(["arm", "n/scoreable", "exact", "wrong-link", "unverified", "recall", "false-merge", "not-found", "found-inbound", "names-guest", "before-create"], rows) if rows else "no result rows")
    lines += ["", "Note: " + score["e0a"]["metric_note"], "", "## E0-B linker vs judge agreement", ""]
    e0b = score["e0b"]
    lines.append(f"linker arm `{e0b['linker_arm']}` vs `haiku_judge`, n={e0b['n']}")
    lines.append("")
    lines.append(md_table(["category", "n"], [[k, v] for k, v in sorted(e0b["overall"].items())]))
    lines += ["", "### Per stratum", ""]
    rows = []
    cats = sorted({cat for counts in e0b["per_stratum"].values() for cat in counts})
    for stratum, counts in sorted(e0b["per_stratum"].items()):
        rows.append([stratum] + [counts.get(cat, 0) for cat in cats])
    lines.append(md_table(["stratum"] + cats, rows) if rows else "no E0-B rows")
    lines += ["", "## Hooks", ""]
    rows = []
    for arm, cell in sorted(score["hooks"].items()):
        for hook in cell["cells"]:
            rows.append([arm, hook["hook_id"], hook["confirmation"], "PASS" if hook["pass"] else "FAIL", hook["status"], ",".join(hook["confounder_hits"]) or "-"])
    lines.append(md_table(["arm", "hook", "confirmation", "result", "status", "confounder hits"], rows) if rows else "no hook rows")
    lines.append("")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    parser.add_argument("--samples-dir", type=Path, default=DEFAULT_SAMPLES)
    parser.add_argument("--run-dir", type=Path, required=True)
    parser.add_argument("--result", type=Path, action="append", default=[])
    parser.add_argument("--linker-arm")
    args = parser.parse_args(argv)

    e0a_samples = read_jsonl(args.samples_dir / "e0a-50.jsonl")
    e0b_samples = read_jsonl(args.samples_dir / "e0b-30.jsonl")
    hook_samples = read_jsonl(args.samples_dir / "hooks.jsonl")
    results = load_results(args.run_dir, args.result)
    p3, owners = load_p3(args.db)
    _messages_by_id, by_thread = load_messages(args.db)
    edges = load_edges(args.db)
    hms = load_hms(args.db)
    score = {
        "schema": "p4-e0-score-v1",
        "run_dir": str(args.run_dir),
        "scored_at": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "arms": sorted(results),
        "e0a": score_e0a(e0a_samples, results, p3, owners, by_thread, edges, hms, args.db),
        "e0b": score_e0b(e0b_samples, results, args.linker_arm),
        "hooks": score_hooks(hook_samples, results),
    }
    args.run_dir.mkdir(parents=True, exist_ok=True)
    (args.run_dir / "score_e0.json").write_text(json.dumps(score, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    (args.run_dir / "score_e0.md").write_text(markdown(score), encoding="utf-8")
    print(json.dumps({"ok": True, "json": str(args.run_dir / "score_e0.json"), "md": str(args.run_dir / "score_e0.md"), "arms": sorted(results)}, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
