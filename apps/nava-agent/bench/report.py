"""Honest bench scorecard: roster, per-email, Create hard micro/macro, harms, six-workflow funnel."""
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
WORKFLOWS = ("triage", "quote", "create", "amend", "cancel", "filing")


def pct(hit, n):
    return f"{hit}/{n} ({hit / n:.1%})" if n else "—"


def blank(value):
    return value is None or value == "" or value == [] or value == {}


def scored(field):
    return field["path"] != "/workflow" and field["result"] in ("hit", "miss", "blocked_by_route")


def rate_row(obj):
    if not obj:
        return "—"
    return pct(obj.get("n", 0), obj.get("d", 0))


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
print(f"- Model: {ruler.get('model', '?')} / {ruler.get('reasoning_effort', '?')}; n={board['n']}; run errors={board.get('run_error_count', 0)}")
if manifest.get("root_prediction_shas"):
    print(f"- Root prediction SHAs carried: {len(manifest['root_prediction_shas'])}")
print()

roster = board.get("roster") or manifest.get("roster") or {}
if roster:
    print("## Attempted roster (primary denominator)\n")
    print("| State | n |")
    print("|---|---:|")
    for state in ("produced", "runtime_error", "missing_prediction", "not_evaluable"):
        print(f"| {state} | {roster.get(state, 0)} |")
    print(f"| **attempted** | **{board['n']}** |\n")

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


def email_table(cases, title):
    print(f"## {title}\n")
    by_wf = defaultdict(lambda: defaultdict(int))
    for case in cases:
        outcome = case.get("email_outcome") or case.get("attempted_state") or "unknown"
        by_wf[case["workflow"]][outcome] += 1
        by_wf[case["workflow"]]["n"] += 1
    print("| Workflow | n | success | failure | runtime_error | missing_prediction | not_evaluable | unobservable |")
    print("|---|---:|---:|---:|---:|---:|---:|---:|")
    for workflow in WORKFLOWS:
        row = by_wf.get(workflow)
        if not row:
            continue
        print(f"| {workflow} | {row['n']} | {row.get('success', 0)} | {row.get('failure', 0)} | "
              f"{row.get('runtime_error', 0)} | {row.get('missing_prediction', 0)} | "
              f"{row.get('not_evaluable', 0)} | {row.get('unobservable', 0)} |")
    eo = board.get("email_outcomes") or {}
    print()
    print(f"- Per-email micro: {rate_row(eo.get('micro'))}")
    macro = eo.get("workflow_macro")
    print(f"- Per-email workflow macro: {macro:.4f}" if isinstance(macro, (int, float)) else "- Per-email workflow macro: —")
    print()


def hard_create_table(cases):
    hard = defaultdict(lambda: [0, 0])
    cases_with_hard = cases_all_hard = 0
    for case in cases:
        if case.get("workflow") != "create":
            continue
        case_hard = []
        for field in case["fields"]:
            if not scored(field) or field.get("model_quality") is False:
                continue
            tier = field.get("tier")
            if tier in EXCLUDED_TIERS:
                continue
            leaf = field["path"].rsplit("/", 1)[-1]
            if leaf in HARD:
                hard[HARD[leaf]][0] += int(field["result"] == "hit")
                hard[HARD[leaf]][1] += 1
                case_hard.append(field["result"] == "hit")
        if case_hard:
            cases_with_hard += 1
            cases_all_hard += int(all(case_hard))
    total_hit = sum(v[0] for v in hard.values())
    total_n = sum(v[1] for v in hard.values())
    ch = board.get("create_hard") or {}
    print("| Line | Score |")
    print("|---|---:|")
    print(f"| Create hard fields strict (field micro) | {rate_row(ch.get('field_micro')) if ch else pct(total_hit, total_n)} |")
    print(f"| Create case all-hard-fields-correct (email macro) | {rate_row(ch.get('email_macro')) if ch else pct(cases_all_hard, cases_with_hard)} |")
    leaves = (ch.get("by_leaf") or {}) if ch else {}
    for key in ("agency", "org", "rate_plan", "room", "guarantee"):
        if key in leaves:
            print(f"| &nbsp;&nbsp;Create {key} strict | {rate_row(leaves[key])} |")
        else:
            print(f"| &nbsp;&nbsp;Create {key} strict | {pct(*hard[key])} |")
    print()


def harms_and_opps():
    harms = board.get("harms") or {}
    opps = board.get("opportunities") or {}
    print("## Harms (sourced negatives only) and separate opportunities\n")
    print("| Metric | Value |")
    print("|---|---:|")
    print(f"| Emails with sourced harm | {harms.get('emails_with_harm', 0)} |")
    print(f"| Sourced wrong target | {harms.get('sourced_wrong_target', 0)} |")
    print(f"| Sourced forbidden field | {harms.get('sourced_forbidden_field', 0)} |")
    print(f"| Trap VCC filing | {harms.get('trap_vcc_filing', 0)} |")
    print(f"| Trap staff-reply action | {harms.get('trap_staff_reply_action', 0)} |")
    print(f"| Unauthorized extra action | {harms.get('unauthorized_extra_action', 0)} |")
    print(f"| Known-risk opportunities clean | {rate_row(opps.get('known_risk'))} |")
    print(f"| Quote native capability (capture) | {rate_row(opps.get('native_capability_quote_capture'))} |")
    print(f"| Knowable fields | {rate_row(opps.get('knowable_fields'))} |")
    print(f"| Safe abstention fields | {rate_row(opps.get('safe_abstention_fields'))} |")
    print()
    print("Legacy safety counters (not interchangeable with sourced harm): "
          f"vcc={board.get('vcc_false_filing_count', 0)}, "
          f"staff_reply={board.get('staff_reply_false_action_count', 0)}, "
          f"wrong_target={board.get('wrong_target_count', 0)}, "
          f"spurious={board.get('spurious_action_count', 0)}\n")


def operator_funnel(cases):
    """Early U9 offline proxy: proposal→route→disposition→harm-free→field-complete per workflow."""
    print("## Six-workflow operator funnel (offline proxy from scored events)\n")
    print("| Workflow | attempted | produced | route_ok | disposition_ok | no_sourced_harm | email_success | quote_capture | N/A stages |")
    print("|---|---:|---:|---:|---:|---:|---:|---:|---|")
    for workflow in WORKFLOWS:
        rows = [c for c in cases if c.get("workflow") == workflow]
        if not rows:
            print(f"| {workflow} | 0 | 0 | 0 | 0 | 0 | 0 | — | no cases |")
            continue
        attempted = len(rows)
        produced = sum(1 for c in rows if c.get("attempted_state", "produced") == "produced")
        route = sum(1 for c in rows if c.get("route_ok"))
        disp = sum(1 for c in rows if c.get("disposition_ok"))
        clean = sum(
            1 for c in rows
            if not (any((c.get("harm_flags") or {}).values()) if c.get("harm_flags") is not None
                    else any((c.get("safety_flags") or {}).values()))
        )
        success = sum(1 for c in rows if c.get("email_outcome") == "success")
        if workflow == "quote":
            cap = sum(1 for c in rows if c.get("quote_capture_ok"))
            cap_s = pct(cap, produced)
            na = "go N/A"
        elif workflow == "triage":
            cap_s = "—"
            na = "stage/go N/A (disposition terminal)"
        else:
            cap_s = "—"
            na = "live stage/go require shadow events"
        print(f"| {workflow} | {attempted} | {produced} | {route} | {disp} | {clean} | {success} | {cap_s} | {na} |")
    print()
    print("Offline funnel is scored-proposal proxy only. Live `stage_finished` / `go_claimed` / "
          "`go_finished` / `quote_artifacts_ready` join lives in shadow-scoreboard when events exist.\n")


def field_rows(cases):
    rows = defaultdict(lambda: {"n": 0, "hit": 0, "wrong": 0, "null": 0, "route_blocked": 0, "not_knowable": 0})
    for case in cases:
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
            row["not_knowable"] += int(field.get("knowable") is False or field.get("model_quality") is False)
    print("| Workflow | Field | n | hit | wrong | null | route_blocked | not_knowable | strict |")
    print("|---|---|---:|---:|---:|---:|---:|---:|---:|")
    for (workflow, name), row in sorted(rows.items()):
        print(f"| {workflow} | `{name}` | {row['n']} | {row['hit']} | {row['wrong']} | {row['null']} | {row['route_blocked']} "
              f"| {row['not_knowable']} | {row['hit'] / row['n']:.1%} |")
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
    email_table(clean, "Clean cohort per-email outcomes")
    hard_create_table(clean)
    operator_funnel(clean)

email_table(board["cases"], "Per-email outcomes (all attempted)")
hard_create_table(board["cases"])
harms_and_opps()
operator_funnel(board["cases"])

t = board["totals"]
print("| Line | Score |")
print("|---|---:|")
print(f"| Route | {pct(t['workflow_routing_hit'], board['n'])} |")
create = board["by_workflow"].get("create", {})
if create:
    print(f"| Create disposition ok | {create.get('disposition_acc', 0) * create['n']:.0f}/{create['n']} |")
print()
field_rows(board["cases"])
print(f"Composite (ROI micro, not a headline): {board['roi_score']['micro']:.4f}; "
      f"ROI workflow macro: {board['roi_score']['workflow_macro']:.4f}; "
      f"composite field accuracy: {t['field_accuracy']:.4f}")
