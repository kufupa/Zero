#!/usr/bin/env python3
"""Compare E2 Arm A/B scoreboards and flag cross-thread-only field use."""
import argparse
import json
import re
import sys
from pathlib import Path


def load_board(path):
    p = Path(path)
    if p.is_dir():
        p = p / 'scoreboard.json'
    return json.loads(p.read_text()), p


def load_cases(cases_dir):
    out = {}
    root = Path(cases_dir)
    for d in root.iterdir() if root.is_dir() else []:
        p = d / 'case.json'
        if p.is_file():
            out[d.name] = json.loads(p.read_text())
    return out


def rate(obj):
    if not isinstance(obj, dict):
        return '—'
    n, d = obj.get('n', 0), obj.get('d', 0)
    return f'{n}/{d} ({n / d:.1%})' if d else f'{n}/{d}'


def delta(a, b):
    if not isinstance(a, dict) or not isinstance(b, dict):
        return '—'
    da, db = a.get('d', 0), b.get('d', 0)
    if not da or not db:
        return '—'
    return f'{(b.get("n", 0) / db - a.get("n", 0) / da) * 100:+.1f}pp'


def norm(value):
    if value is None:
        return ''
    if not isinstance(value, str):
        value = json.dumps(value, sort_keys=True)
    return re.sub(r'\s+', ' ', value).strip().lower()


def mail_text(card, include_cross=False):
    parts = []
    selected = card.get('selected_email') or {}
    for key in ('subject', 'body_text', 'body'):
        if selected.get(key):
            parts.append(str(selected[key]))
    for event in card.get('context_before') or []:
        msg = event.get('message') if isinstance(event, dict) and isinstance(event.get('message'), dict) else event
        if isinstance(msg, dict):
            parts.extend(str(msg.get(k)) for k in ('subject', 'body_text', 'body') if msg.get(k))
    if include_cross:
        for link in card.get('cross_thread_context') or []:
            for event in (link or {}).get('messages') or []:
                msg = event.get('message') if isinstance(event, dict) and isinstance(event.get('message'), dict) else event
                if isinstance(msg, dict):
                    parts.extend(str(msg.get(k)) for k in ('subject', 'body_text', 'body') if msg.get(k))
                    for att in msg.get('pdf_attachments_text') or []:
                        if isinstance(att, dict) and att.get('text'):
                            parts.append(str(att['text']))
    return norm('\n'.join(parts))


def metric_rows(a, b):
    rows = []
    for label, fn in [
        ('create_hard field micro', lambda x: (x.get('create_hard') or {}).get('field_micro')),
        ('create_hard email macro', lambda x: (x.get('create_hard') or {}).get('email_macro')),
        ('wrong_target', lambda x: {'n': x.get('wrong_target_count', 0), 'd': x.get('n', 0)}),
        ('staff_useful micro', lambda x: (x.get('staff_useful') or {}).get('micro')),
    ]:
        va, vb = fn(a), fn(b)
        rows.append((label, rate(va), rate(vb), delta(va, vb)))
    return rows


def field_diffs(board_a, board_b, cases_b):
    a_cases = {c['case_id']: c for c in board_a.get('cases', [])}
    out = []
    for cb in board_b.get('cases', []):
        ca = a_cases.get(cb['case_id'])
        card = cases_b.get(cb['case_id'], {})
        if not ca or not card:
            continue
        selected_norm = mail_text(card, include_cross=False)
        cross_norm = mail_text(card, include_cross=True)
        af = {f['path']: f for f in ca.get('fields', [])}
        for fb in cb.get('fields', []):
            fa = af.get(fb.get('path'))
            if not fa:
                continue
            if norm(fa.get('actual')) == norm(fb.get('actual')) and fa.get('result') == fb.get('result'):
                continue
            actual = norm(fb.get('actual'))
            if not actual or actual in ('null', 'none'):
                continue
            absent_selected = actual not in selected_norm
            present_with_cross = actual in cross_norm
            out.append({
                'case_id': cb['case_id'],
                'workflow': cb.get('workflow'),
                'path': fb.get('path'),
                'a_result': fa.get('result'),
                'b_result': fb.get('result'),
                'a_actual': fa.get('actual'),
                'b_actual': fb.get('actual'),
                'absent_from_selected_thread': absent_selected,
                'present_only_with_cross_thread': absent_selected and present_with_cross,
                'staff_useful_a': ca.get('staff_useful'),
                'staff_useful_b': cb.get('staff_useful'),
            })
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('arm_a', help='Arm A run dir or scoreboard.json')
    ap.add_argument('arm_b', help='Arm B run dir or scoreboard.json')
    ap.add_argument('--arm-b-cases', required=True, help='Arm B cases dir (for thread-absence checks)')
    ap.add_argument('--json-out')
    args = ap.parse_args()
    a, path_a = load_board(args.arm_a)
    b, path_b = load_board(args.arm_b)
    cases_b = load_cases(args.arm_b_cases)
    rows = metric_rows(a, b)
    diffs = field_diffs(a, b, cases_b)
    cross = [d for d in diffs if d['present_only_with_cross_thread']]
    print('# Cross-thread A/B compare\n')
    print(f'- Arm A: `{path_a.parent}` n={a.get("n")} scorer=`{(a.get("ruler") or {}).get("scorer_sha", "?")}`')
    print(f'- Arm B: `{path_b.parent}` n={b.get("n")} scorer=`{(b.get("ruler") or {}).get("scorer_sha", "?")}`\n')
    print('| Metric | Arm A | Arm B | Delta B-A |')
    print('|---|---:|---:|---:|')
    for row in rows:
        print('| {} | {} | {} | {} |'.format(*row))
    print('\n## Per-case field diffs with B value absent from selected thread\n')
    print('| Case | Workflow | Path | A | B | B actual | Cross-thread-only |')
    print('|---|---|---|---|---|---|---|')
    for d in cross:
        actual = str(d['b_actual']).replace('|', '\\|')[:100]
        print(f"| {d['case_id']} | {d['workflow']} | `{d['path']}` | {d['a_result']} | {d['b_result']} | {actual} | yes |")
    if not cross:
        print('| — | — | — | — | — | — | 0 |')
    print(f'\n- All changed nonblank B fields: {len(diffs)}; absent-from-selected + present-with-cross: {len(cross)}')
    result = {'metrics': [{'metric': r[0], 'arm_a': r[1], 'arm_b': r[2], 'delta': r[3]} for r in rows], 'diffs': diffs, 'cross_thread_only': cross}
    if args.json_out:
        out = Path(args.json_out)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(result, indent=2) + '\n')
    return 0


if __name__ == '__main__':
    sys.exit(main())
