"""Render the known field denominators from a bench scoreboard."""
import json
import sys
from pathlib import Path

board = json.loads((Path(sys.argv[1]) / "scoreboard.json").read_text())
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
