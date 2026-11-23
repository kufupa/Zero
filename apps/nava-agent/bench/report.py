"""Honest bench scorecard: provenance header, per-field outcome counts, Create hard-field strict lines."""
import argparse
import json
import re
from collections import defaultdict
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("scoreboard", type=Path, help="Scoreboard JSON or its run directory")
parser.add_argument("--exclude-leaks", action="store_true", help="Show coverage and field accuracy for the clean cohort")
parser.add_argument("--cases-dir", type=Path, help="Source case cards for annotating legacy scoreboards")
args = parser.parse_args()
path = args.scoreboard / "scoreboard.json" if args.scoreboard.is_dir() else args.scoreboard
board = json.loads(path.read_text())
ruler = board.get("ruler") or {}
HARD = {"agency_name": "agency", "agency_id": "agency", "organization_name": "org", "organization_id": "org",
        "rate_plan": "rate_plan", "room_type": "room", "guarantee_type": "guarantee"}
EXCLUDED_TIERS = {"email_description"}


def pct(hit, n):
    return f"{hit}/{n} ({hit / n:.1%})" if n else "—"


def blank(value):
    return value is None or value == "" or value == [] or value == {}


def scored(field):
    return field["path"] != "/workflow" and field["result"] in ("hit", "miss", "blocked_by_route")


print(f"# Bench scorecard\n")
agent_sha = ruler.get("git_sha")
agent_dirty = ruler.get("git_dirty")
scorer_sha = ruler.get("scorer_sha")
manifest_path = path.with_name("manifest.json")
manifest = json.loads(manifest_path.read_text()) if manifest_path.is_file() else {}
if manifest.get("source_git_sha"):
    agent_sha = manifest["source_git_sha"]
    agent_dirty = manifest.get("source_git_dirty")
print(f"- Agent SHA: {agent_sha or '?'} (dirty={str(agent_dirty).lower() if agent_dirty is not None else '?'}) | Scorer SHA: {scorer_sha or '?'}")
print(f"- Dataset: `{ruler.get('gold_file', '?')}` (gold sha256 `{str(ruler.get('gold_sha256', '?'))[:12]}`)")
print(f"- Model: {ruler.get('model', '?')} / {ruler.get('reasoning_effort', '?')}; n={board['n']}; run errors={board.get('run_error_count', 0)}\n")

LEAK = re.compile(r"\bexample\.invalid\b|hyperguest|\bh[-‑ ]pay\b", re.I)
cases_dir = args.cases_dir or (Path(manifest["cases_dir"]) if manifest.get("cases_dir") else None)


def cohort_leak(case):
    if "cohort_leak" in case:
        return case["cohort_leak"]
    if cases_dir:
        card_path = cases_dir / f"{case['case_id']}.json"
        if not card_path.is_file():
            card_path = cases_dir / case["case_id"] / "case.json"
        if card_path.is_file():
            email = json.loads(card_path.read_text()).get("selected_email") or {}
            return bool(LEAK.search(json.dumps(email, ensure_ascii=False)))
    return None


def coverage_table(cases):
    coverage = defaultdict(lambda: [0, 0, 0, 0])
    for case in cases:
        row = coverage[case["workflow"]]
        if case.get("twin_uncovered"):
            row[1] += 1
        else:
            row[0] += 1
            for field in case["fields"]:
                if scored(field):
                    row[2] += field["result"] == "hit"
                    row[3] += 1
    print("| Workflow | Covered | TWIN_BLIND | Covered field accuracy |")
    print("|---|---:|---:|---:|")
    for workflow, (covered, blind, hits, fields) in sorted(coverage.items()):
        print(f"| {workflow} | {covered} | {pct(blind, covered + blind)} | {pct(hits, fields)} |")
    print()


print("## Twin Coverage\n")
coverage_table(board["cases"])
cohorts = [(case, cohort_leak(case)) for case in board["cases"]]
clean = [case for case, leak in cohorts if leak is False]
excluded = sum(leak is True for _, leak in cohorts)
unknown = sum(leak is None for _, leak in cohorts)
if unknown == len(cohorts):
    print(f"- Clean cohort: unavailable; all {unknown} cases lack source leak labels.")
else:
    print(f"- Clean cohort: n={len(clean)}; excluded leaks={excluded}; unclassified={unknown} of full n={board['n']}.")
if unknown:
    print("- Legacy cases without leak labels need the original case cards via `--cases-dir`.")
print()
if args.exclude_leaks:
    print("## Clean Cohort Twin Coverage\n")
    coverage_table(clean)

rows = defaultdict(lambda: {"n": 0, "hit": 0, "wrong": 0, "null": 0, "route_blocked": 0, "not_knowable": 0})
hard = defaultdict(lambda: [0, 0])
cases_with_hard = cases_all_hard = 0
for case in board["cases"]:
    case_hard = []
    for field in case["fields"]:
        if not scored(field):
            continue
        name = re.sub(r"/\d+(?=/|$)", "/*", field["path"])
        tier = field.get("tier")
        if tier in EXCLUDED_TIERS:
            name += f" ({tier})"
        row = rows[(case["workflow"], name)]
        row["n"] += 1
        result = field["result"]
        if result == "hit":
            row["hit"] += 1
        elif result == "blocked_by_route":
            row["route_blocked"] += 1
        elif blank(field.get("actual")):
            row["null"] += 1
        else:
            row["wrong"] += 1
        row["not_knowable"] += int(field.get("knowable") is False)
        leaf = field["path"].rsplit("/", 1)[-1]
        if case["workflow"] == "create" and leaf in HARD and tier not in EXCLUDED_TIERS:
            hard[HARD[leaf]][0] += int(result == "hit")
            hard[HARD[leaf]][1] += 1
            case_hard.append(result == "hit")
    if case["workflow"] == "create" and case_hard:
        cases_with_hard += 1
        cases_all_hard += int(all(case_hard))

t = board["totals"]
total_hit = sum(v[0] for v in hard.values())
total_n = sum(v[1] for v in hard.values())
print("| Line | Score |")
print("|---|---:|")
print(f"| Create hard fields strict (agency,org,rate_plan,room,guarantee) | {pct(total_hit, total_n)} |")
for key in ("agency", "org", "rate_plan", "room", "guarantee"):
    print(f"| &nbsp;&nbsp;Create {key} strict | {pct(*hard[key])} |")
print(f"| Create case all-hard-fields-correct | {pct(cases_all_hard, cases_with_hard)} |")
print(f"| Route | {pct(t['workflow_routing_hit'], board['n'])} |")
create = board["by_workflow"].get("create", {})
if create:
    print(f"| Create disposition ok | {create.get('disposition_acc', 0) * create['n']:.0f}/{create['n']} |")
print()
print("| Workflow | Field | n | hit | wrong | null | route_blocked | not_knowable | strict |")
print("|---|---|---:|---:|---:|---:|---:|---:|---:|")
for (workflow, name), row in sorted(rows.items()):
    print(f"| {workflow} | `{name}` | {row['n']} | {row['hit']} | {row['wrong']} | {row['null']} | {row['route_blocked']} "
          f"| {row['not_knowable']} | {row['hit'] / row['n']:.1%} |")
print()
print(f"Composite (ROI micro, not a headline): {board['roi_score']['micro']:.4f}; "
      f"composite field accuracy: {t['field_accuracy']:.4f}")
