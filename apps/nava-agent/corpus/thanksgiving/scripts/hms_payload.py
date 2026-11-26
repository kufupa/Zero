#!/usr/bin/env python3
import json
import re
from collections import Counter
from pathlib import Path

DEFAULT_LANE_H = Path('/home/orca/.local/share/zero/research/thanksgiving/work/lane-h')

HMS_COLUMNS = [
    'confirmation_number',
    'property_code',
    'status',
    'created_at',
    'created_by',
    'updated_at',
    'source_of_business',
    'arrival_date',
    'departure_date',
    'guest_name',
    'company',
    'travel_agency_1',
    'evidence_kind',
    'capture_completeness',
    'observed_at',
    'observation_id',
    'stable_payload_sha256',
]


def empty_to_none(value):
    return None if value in (None, '') else value


def timestamp_sort_key(value):
    digits = re.sub(r'\D', '', value or '')
    return int(digits[:14] or 0)


def load_capture_completeness(observations_path, wanted_ids):
    capture = {}
    with open(observations_path, encoding='utf-8') as handle:
        for line in handle:
            if not line.strip():
                continue
            row = json.loads(line)
            observation_id = row.get('observation_id')
            if observation_id in wanted_ids:
                capture[observation_id] = (row.get('capture') or {}).get('completeness')
    return capture


def evidence_rank(row, completeness):
    kind = row.get('observation_kind')
    if kind == 'shallow_header_view':
        return None
    if kind == 'full_record_view' and completeness != 'derived_partial':
        quality = 0
    elif kind == 'list_row':
        quality = 1
    elif kind == 'full_record_view' and completeness == 'derived_partial':
        quality = 2
    else:
        return None
    return (
        quality,
        -timestamp_sort_key(row.get('observed_at')),
        -int((row.get('field_presence') or {}).get('stable_nonblank') or 0),
        row.get('observation_id') or '',
    )


def build_hms_payload(lane_h=DEFAULT_LANE_H):
    lane_h = Path(lane_h)
    stable_path = lane_h / 'derived' / 'stable-tiers.jsonl'
    observations_path = lane_h / 'observations' / 'hms-observations.jsonl'
    stable_rows = []
    with open(stable_path, encoding='utf-8') as handle:
        for line in handle:
            if line.strip():
                stable_rows.append(json.loads(line))
    wanted_ids = {row['observation_id'] for row in stable_rows}
    completeness = load_capture_completeness(observations_path, wanted_ids)

    best = {}
    skipped = Counter()
    for row in stable_rows:
        comp = completeness.get(row.get('observation_id'))
        rank = evidence_rank(row, comp)
        if rank is None:
            skipped[f"{row.get('observation_kind')}:{comp or 'unknown'}"] += 1
            continue
        key = (row.get('property_code'), row.get('confirmation_key'))
        if key not in best or rank < best[key][0]:
            best[key] = (rank, row, comp)

    rows = []
    evidence_counts = Counter()
    for (property_code, confirmation_key), (_rank, row, comp) in sorted(best.items()):
        stay = row.get('stay_core') or {}
        commercial = row.get('commercial') or {}
        audit = row.get('audit') or {}
        values = [
            confirmation_key,
            property_code,
            empty_to_none(stay.get('status')),
            empty_to_none(audit.get('created_at')),
            empty_to_none(audit.get('created_by')),
            empty_to_none(audit.get('updated_at')),
            empty_to_none(commercial.get('source_of_business')),
            empty_to_none(stay.get('arrival_date')),
            empty_to_none(stay.get('departure_date')),
            empty_to_none(stay.get('guest_name')),
            empty_to_none(commercial.get('company')),
            empty_to_none(commercial.get('travel_agency_1')),
            row.get('observation_kind'),
            comp,
            empty_to_none(row.get('observed_at')),
            row.get('observation_id'),
            row.get('stable_payload_sha256'),
        ]
        rows.append(values)
        evidence_counts[f"{row.get('observation_kind')}:{comp or 'unknown'}"] += 1

    return {
        'columns': HMS_COLUMNS,
        'rows': rows,
        'meta': {
            'stable_rows': len(stable_rows),
            'unique_confirmations': len(rows),
            'evidence_counts': dict(sorted(evidence_counts.items())),
            'skipped_counts': dict(sorted(skipped.items())),
            'selection': 'best row per confirmation: direct full_record_view, then list_row, then derived_partial full_record_view; shallow_header_view skipped',
        },
    }


if __name__ == '__main__':
    payload = build_hms_payload()
    print(json.dumps({'columns': len(payload['columns']), 'rows': len(payload['rows']), 'meta': payload['meta']}, indent=2, sort_keys=True))
