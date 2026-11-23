"""Honest bench scorecard: provenance header, per-field outcome counts, Create hard-field strict lines."""
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

board = json.loads((Path(sys.argv[1]) / "scoreboard.json").read_text())
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
print(f"- SHA: `{ruler.get('git_sha', '?')}` dirty={str(ruler.get('git_dirty', '?')).lower()}")
print(f"- Dataset: `{ruler.get('gold_file', '?')}` (gold sha256 `{str(ruler.get('gold_sha256', '?'))[:12]}`)")
print(f"- Model: {ruler.get('model', '?')} / {ruler.get('reasoning_effort', '?')}; n={board['n']}; run errors={board.get('run_error_count', 0)}\n")

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
