"""Render field accuracy and its denominators from a bench scoreboard."""
import json
import sys
from pathlib import Path

board = json.loads((Path(sys.argv[1]) / "scoreboard.json").read_text())
def fraction(hit, n):
    return f"{hit}/{n} ({hit/n:.1%})" if n else "—"

print("| End-to-end | Route-independent | Email-knowable end-to-end | Route accuracy | Dropped staff_review request fields |")
print("|---:|---:|---:|---:|---:|")
t = board["totals"]
scores = [fraction(row["hit"], row["hit"] + row["miss"]) for row in (t, t["route_independent"], t["email_knowable"])]
scores += [fraction(t["workflow_routing_hit"], board["n"]), str(t["dropped_staff_review_request_fields"])]
print("| " + " | ".join(scores) + " |\n")
print("| Workflow | Field | Hits | Gold n | Case n | Accuracy | Blocked by route |")
print("|---|---|---:|---:|---:|---:|---:|")
for workflow, row in sorted(board["by_workflow"].items()):
    for path, field in sorted(row["by_field"].items()):
        if path == "/workflow":
            continue
        hit, n = field["hit"], field["gold_n"]
        accuracy = f"{hit/n:.1%}" if n else "—"
        print(f"| {workflow} | `{path}` | {hit} | {n} | {field['case_n']} | {accuracy} | {field['blocked_by_route']} |")
print()
print(f"{board['totals']['workflow_mismatch']} workflow mismatches across {board['n']} cases.")
