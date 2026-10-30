#!/usr/bin/env python3
"""Independently recalculate the stopped agent's count-only linkage leads.

Usage: python3 -I -B verify-prior-counts.py PRIVATE_FIVE_DAY_DATA_DIR
Prints aggregate counts only; inputs remain private. Counts are co-occurrences,
not verified journey links. See prior-agent-leads.md for denominator caveats.
"""
import collections
import datetime
import email.utils
import json
import pathlib
import statistics
import sys


def load(path):
    with path.open(encoding='utf-8') as stream:
        return [json.loads(line) for line in stream if line.strip()]


def time(value):
    return datetime.datetime.fromisoformat(value.replace('Z', '+00:00'))


def addresses(values):
    return {address.strip().lower() for _, address in email.utils.getaddresses(values or [])
            if address.strip().count('@') == 1}


def normalized(values):
    return [value.strip().lower() for value in values or []
            if isinstance(value, str) and value.strip()]


def domain(address):
    return address.split('@', 1)[1]


def main():
    if len(sys.argv) != 2:
        raise SystemExit('usage: verify-prior-counts.py PRIVATE_FIVE_DAY_DATA_DIR')
    base = pathlib.Path(sys.argv[1])
    threads = load(base / 'mailbox-threads.jsonl')
    pdfs = load(base / 'pdf-records.jsonl')
    duplicate_candidates = load(base / 'mailbox-duplicate-candidates.jsonl')
    rows = []
    thread_start = {}
    for thread in threads:
        thread_start[thread['threadId']] = (
            time(thread['threadFirstTimestamp']),
            min(time(message['timestamp']) for message in thread['messages']),
        )
        for message in thread['messages']:
            for source in message['sourceRows']:
                saved = source['privateMessage']
                headers = saved.get('canonicalHeaders') or {}
                mids = normalized(headers.get('Message-ID'))
                rows.append({
                    'id': source['sourceRowId'],
                    'thread': thread['threadId'],
                    'timestamp': time(message['timestamp']),
                    'direction': saved['direction'],
                    'from': addresses(saved['addresses'].get('from')),
                    'to': addresses(saved['addresses'].get('to')),
                    'cc': addresses(saved['addresses'].get('cc')),
                    'mid': mids[0] if mids else None,
                    'in_reply_to': normalized(headers.get('In-Reply-To')),
                })
    internal_domains = {domain(a) for row in rows if row['direction'] == 'outbound'
                        for a in row['from']}
    if len(internal_domains) != 1:
        raise ValueError('expected one inferred outbound sender domain')
    internal = next(iter(internal_domains))
    for row in rows:
        row['external'] = {a for a in row['from'] | row['to'] | row['cc']
                           if domain(a) != internal}
        row['external_from'] = {a for a in row['from'] if domain(a) != internal}
        row['domains'] = {domain(a) for a in row['external']}
        row['key'] = ('mid', row['mid']) if row['mid'] else ('row', row['id'])
    by_id = {row['id']: row for row in rows}
    if len(by_id) != len(rows):
        raise ValueError('duplicate source-row IDs')
    by_mid = collections.defaultdict(list)
    for row in rows:
        if row['mid']:
            by_mid[row['mid']].append(row)
    computed_duplicates = sorted(tuple(sorted(row['id'] for row in group))
                                 for group in by_mid.values() if len(group) > 1)
    file_duplicates = sorted(tuple(sorted(member['sourceRowId'] for member in group['members']))
                             for group in duplicate_candidates)
    pdf_parent_ids = {pdf['parentEmailSourceRowId'] for pdf in pdfs}
    parents = []
    for pdf in pdfs:
        parent = by_id.get(pdf['parentEmailSourceRowId'])
        if parent is None:
            raise ValueError('PDF parent missing from saved messages')
        anchor = time(pdf['selectedMessageTimestamp'])
        if parent['thread'] != pdf['parentEmailThreadId'] or parent['timestamp'] != anchor:
            raise ValueError('PDF parent thread or timestamp did not match')
        if parent['direction'] != 'outbound' or pdf['selection']['storedSentDate'] != anchor.date().isoformat():
            raise ValueError('PDF parent direction or stored date did not match')
        parents.append((pdf, parent, anchor))
    broad_counts = collections.Counter()
    composition = collections.Counter()
    strict_windows = collections.Counter()
    nearest_lags = []
    exact_without_parent = 0
    header_counts = collections.Counter()
    thirty = datetime.timedelta(minutes=30)
    sorted_rows = sorted(rows, key=lambda row: row['timestamp'])
    for _, parent, anchor in parents:
        # Match the prior grouping semantics: merge same Message-ID rows,
        # accumulating whether any row is in the parent thread or shares an address.
        candidates = {}
        for row in rows:
            if row['key'] == parent['key'] or abs(row['timestamp'] - anchor) > thirty:
                continue
            if not (row['domains'] & parent['domains']):
                continue
            group = candidates.setdefault(row['key'], {'same': False, 'exact': False, 'inbound_before': False})
            same = row['thread'] == parent['thread']
            group['same'] |= same
            group['exact'] |= bool(row['external'] & parent['external'])
            group['inbound_before'] |= same and row['direction'] == 'inbound' and row['timestamp'] <= anchor
        exact_other = [group for group in candidates.values() if not group['same'] and group['exact']]
        domain_other = [group for group in candidates.values() if not group['same']]
        domain_only_other = [group for group in domain_other if not group['exact']]
        same_inbound = [group for group in candidates.values()
                        if group['same'] and group['exact'] and group['inbound_before']]
        for name, groups in (('exact_other', exact_other), ('domain_other', domain_other),
                             ('domain_only_other', domain_only_other), ('exact_same_inbound_before', same_inbound)):
            broad_counts[name + '_pdfs'] += bool(groups)
            broad_counts[name + '_links'] += len(groups)

        # Composition uses the first timestamp-sorted row for each key, while
        # accumulating all row IDs and whether any belongs to the parent thread.
        grouped = {}
        for row in sorted_rows:
            if row['key'] == parent['key'] or abs(row['timestamp'] - anchor) > thirty:
                continue
            if not (row['external'] & parent['external']):
                continue
            group = grouped.setdefault(row['key'], {'same': False, 'direction': row['direction'], 'ids': set()})
            group['same'] |= row['thread'] == parent['thread']
            group['ids'].add(row['id'])
        for group in grouped.values():
            if group['same']:
                continue
            composition['total'] += 1
            composition[group['direction']] += 1
            composition['other_pdf_parent'] += bool(group['ids'] & pdf_parent_ids)

        # Strict candidate: an earlier inbound in another thread whose external
        # sender appears among the PDF parent's external From/To/Cc addresses.
        lags = [(anchor - row['timestamp']).total_seconds() / 60 for row in rows
                if row['direction'] == 'inbound' and row['thread'] != parent['thread']
                and row['timestamp'] < anchor and row['external_from'] & parent['external']]
        if lags:
            nearest_lags.append(min(lags))
            for minutes in (30, 360, 1440):
                strict_windows[str(minutes)] += min(lags) <= minutes
        # Preserve the prior last-row-per-key exclusion rule for this comparison.
        last_per_key = {}
        for row in sorted_rows:
            if row['key'] != parent['key'] and row['thread'] != parent['thread'] and \
                    abs(row['timestamp'] - anchor) <= thirty and row['external'] & parent['external']:
                last_per_key[row['key']] = row
        exact_without_parent += any(row['id'] not in pdf_parent_ids for row in last_per_key.values())
        if not parent['in_reply_to']:
            header_counts['no_in_reply_to'] += 1
        else:
            targets = [row for reference in parent['in_reply_to'] for row in by_mid[reference]
                       if row['key'] != parent['key']]
            if targets:
                header_counts['resolved'] += 1
                header_counts['resolved_same_thread_inbound'] += any(
                    row['thread'] == parent['thread'] and row['direction'] == 'inbound' for row in targets)
            else:
                header_counts['unresolved'] += 1
    result = {
        'input_counts': {'threads': len(threads), 'source_rows': len(rows), 'pdf_records': len(pdfs),
                         'duplicate_groups_in_file': len(duplicate_candidates),
                         'duplicate_groups_match_recomputation': computed_duplicates == file_duplicates},
        'parent_join': {'matched': len(parents), 'with_external_address': sum(bool(p['external']) for _, p, _ in parents)},
        'broad_30_minutes': dict(broad_counts),
        'other_thread_exact_composition': dict(composition),
        'strict_earlier_inbound': {'within_minutes': dict(strict_windows), 'any_prior': len(nearest_lags),
                                   'nearest_lag_median_minutes': statistics.median(nearest_lags) if nearest_lags else None},
        'broad_exact_without_other_pdf_parent': exact_without_parent,
        'parent_in_reply_to': dict(header_counts),
        # This is saved-thread metadata, not an independent check of pre-window mailbox history.
        'saved_thread_metadata_before_first_saved': sum(
            thread_start[parent['thread']][0] < thread_start[parent['thread']][1] for _, parent, _ in parents),
        'pdf_parent_earliest_saved_in_thread': sum(
            anchor <= thread_start[parent['thread']][1] for _, parent, anchor in parents),
    }
    print(json.dumps(result, indent=2, sort_keys=True))


if __name__ == '__main__':
    main()
