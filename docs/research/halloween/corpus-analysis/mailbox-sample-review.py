#!/usr/bin/env python3
"""Draw a reproducible random + targeted blind review sample from a mailbox.

The reviewer receives original packets only, never the existing classification.
Random and targeted findings must be reported separately.
"""

from __future__ import annotations

import argparse
import json
import os
import random
from collections import Counter
from pathlib import Path


PRIVATE_ROOT = Path(__file__).resolve().parents[4] / '.private'


def read_rows(path):
    with path.open() as source:
        rows = [json.loads(line) for line in source if line.strip()]
    by_case = {row['case']: row for row in rows}
    if len(by_case) != len(rows):
        raise ValueError('duplicate_case')
    return by_case


def select(packets, labels, seed, random_count, excluded=()):
    excluded = set(excluded)
    available = sorted(case for case in packets if case not in excluded and case in labels
                       and labels[case].get('classification') is not None)
    if len(available) < random_count:
        raise ValueError('random_sample_too_large')
    rng = random.Random(seed)
    random_cases = rng.sample(available, random_count)
    selected = set(random_cases)
    targeted = []

    def cls(case): return labels[case]['classification']
    def acts(case): return set(cls(case).get('actions') or [])
    def cross(case):
        matched = set(cls(case).get('reply_ids') or [])
        return any(item['reply_id'] in matched and not item.get('same_thread')
                   for item in packets[case].get('candidate_replies', []))

    strata = [
        ('large_group', 20, lambda case: 'group' in acts(case)),
        ('voucher_or_proof', 20, lambda case: bool(acts(case) & {'voucher', 'payment_proof'})),
        ('invoice', 15, lambda case: 'invoice' in acts(case)),
        ('cross_thread_reply', 15, cross),
        ('candidate_but_no_match', 15, lambda case: bool(packets[case].get('candidate_replies')) and not cls(case).get('reply_ids')),
        ('unsupported_reservation', 15, lambda case: cls(case).get('reservation_email') is True and cls(case).get('can_help') is False),
    ]
    shortfalls = {}
    for name, requested, predicate in strata:
        pool = [case for case in available if case not in selected and predicate(case)]
        chosen = rng.sample(pool, min(requested, len(pool)))
        targeted.extend({'case': case, 'stratum': name} for case in chosen)
        selected.update(chosen)
        if len(chosen) < requested:
            shortfalls[name] = requested - len(chosen)
    missing = sum(shortfalls.values())
    remainder = [case for case in available if case not in selected]
    if missing and remainder:
        chosen = rng.sample(remainder, min(missing, len(remainder)))
        targeted.extend({'case': case, 'stratum': 'replacement_random'} for case in chosen)
    return random_cases, targeted, shortfalls


def write_jsonl(path, rows):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as target:
        for row in rows:
            target.write(json.dumps(row, ensure_ascii=False, separators=(',', ':')) + '\n')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', type=Path, required=True, help='full classifier packets')
    parser.add_argument('--labeled', type=Path, required=True, help='existing labels, used only for stratification')
    parser.add_argument('--output-dir', type=Path, required=True)
    parser.add_argument('--seed', type=int, default=20261102)
    parser.add_argument('--random-count', type=int, default=150)
    parser.add_argument('--exclude-selection', type=Path,
                        help='private earlier selection to keep a new sample independent of it')
    args = parser.parse_args()
    try:
        root = PRIVATE_ROOT.resolve(strict=True)
        paths = [args.input.resolve(strict=True), args.labeled.resolve(strict=True)]
        if any(not path.is_relative_to(root) or path.stat().st_mode & 0o077 for path in paths):
            raise ValueError('input_not_private_file')
        excluded = set()
        if args.exclude_selection:
            exclusion_path = args.exclude_selection.resolve(strict=True)
            if not exclusion_path.is_relative_to(root) or exclusion_path.stat().st_mode & 0o077:
                raise ValueError('exclusion_not_private_file')
            excluded = set(read_rows(exclusion_path))
        outdir = args.output_dir.absolute()
        if not outdir.parent.resolve(strict=True).is_relative_to(root) or outdir.exists() or outdir.is_symlink():
            raise ValueError('output_dir_unsafe_or_exists')
        packets, labels = map(read_rows, paths)
        random_cases, targeted, shortfalls = select(packets, labels, args.seed, args.random_count, excluded)
        cases = random_cases + [row['case'] for row in targeted]
        outdir.mkdir(mode=0o700)
        write_jsonl(outdir / 'packets.jsonl', [packets[case] for case in cases])
        write_jsonl(outdir / 'selection.jsonl',
                    [{'case': case, 'stratum': 'random'} for case in random_cases] + targeted)
        summary = {'seed': args.seed, 'excluded_prior_cases': len(excluded),
                   'random': len(random_cases), 'targeted': len(targeted),
                   'strata': dict(Counter(row['stratum'] for row in targeted)), 'stratum_shortfalls': shortfalls}
        write_jsonl(outdir / 'manifest.jsonl', [summary])
        print(json.dumps(summary, sort_keys=True))
    except (ValueError, OSError, KeyError, json.JSONDecodeError) as exc:
        code = str(exc) if isinstance(exc, ValueError) and str(exc).replace('_', '').isalpha() else 'sample_failed'
        raise SystemExit(code) from None


if __name__ == '__main__':
    main()
