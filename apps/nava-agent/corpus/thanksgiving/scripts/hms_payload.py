#!/usr/bin/env python3
import json
import re
from collections import Counter
from datetime import datetime
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
    'email_address',
    'caller',
    'billing_reference',
    'reservation_note',
    'rate_plan',
    'room_type',
    'meal_plan',
    'adults',
    'children',
    'is_labtest',
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


def parse_timestamp(value):
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace('Z', '+00:00'))
    except ValueError:
        return None


def created_after_observed(row):
    created_at = parse_timestamp((row.get('audit') or {}).get('created_at'))
    observed_at = parse_timestamp(row.get('observed_at'))
    return bool(created_at and observed_at and created_at > observed_at)


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


def list_row_created_fallback(candidates):
    list_rows = []
    for rank, row, _comp in candidates:
        if row.get('observation_kind') != 'list_row':
            continue
        created_at = empty_to_none((row.get('audit') or {}).get('created_at'))
        if not created_at or created_after_observed(row):
            continue
        list_rows.append((rank, created_at, row.get('observation_id')))
    if not list_rows:
        return None, None
    list_rows.sort(key=lambda item: item[0])
    return list_rows[0][1], list_rows[0][2]


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

    ranked_by_key = {}
    skipped = Counter()
    for row in stable_rows:
        comp = completeness.get(row.get('observation_id'))
        rank = evidence_rank(row, comp)
        if rank is None:
            skipped[f"{row.get('observation_kind')}:{comp or 'unknown'}"] += 1
            continue
        key = (row.get('property_code'), row.get('confirmation_key'))
        ranked_by_key.setdefault(key, []).append((rank, row, comp))

    rows = []
    evidence_counts = Counter()
    fallback_confirmations = []
    unrepaired_future = Counter()
    future_full_rows = 0
    for (property_code, confirmation_key), candidates in sorted(ranked_by_key.items()):
        candidates.sort(key=lambda item: item[0])
        _rank, row, comp = candidates[0]
        stay = row.get('stay_core') or {}
        commercial = row.get('commercial') or {}
        audit = row.get('audit') or {}
        created_at = empty_to_none(audit.get('created_at'))
        if row.get('observation_kind') == 'full_record_view' and created_after_observed(row):
            future_full_rows += 1
            fallback_created_at, _fallback_observation_id = list_row_created_fallback(candidates)
            if fallback_created_at:
                created_at = fallback_created_at
                fallback_confirmations.append(confirmation_key)
            else:
                created_at = None
                unrepaired_future[confirmation_key] += 1
        guest_name = empty_to_none(stay.get('guest_name'))
        created_by = empty_to_none(audit.get('created_by'))
        is_labtest = (
            str(created_by or '').upper() == 'NAVAAI'
            or 'labtest' in str(guest_name or '').lower()
        )
        values = [
            confirmation_key,
            property_code,
            empty_to_none(stay.get('status')),
            created_at,
            created_by,
            empty_to_none(audit.get('updated_at')),
            empty_to_none(commercial.get('source_of_business')),
            empty_to_none(stay.get('arrival_date')),
            empty_to_none(stay.get('departure_date')),
            guest_name,
            empty_to_none(commercial.get('company')),
            empty_to_none(commercial.get('travel_agency_1')),
            empty_to_none(audit.get('email_address')),
            empty_to_none(audit.get('caller')),
            empty_to_none(commercial.get('billing_reference')),
            empty_to_none(audit.get('reservation_note')),
            empty_to_none(commercial.get('rate_plan')),
            empty_to_none(commercial.get('room_type')),
            empty_to_none(commercial.get('meal_plan')),
            stay.get('adults'),
            stay.get('children'),
            is_labtest,
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
            'future_created_full_rows': future_full_rows,
            'created_at_fallbacks': len(fallback_confirmations),
            'created_at_fallback_confirmations': sorted(fallback_confirmations),
            'created_at_unrepaired_future_rows': sum(unrepaired_future.values()),
            'selection': 'best row per confirmation: direct full_record_view, then list_row, then derived_partial full_record_view; shallow_header_view skipped; full_record_view created_at after observed_at falls back to best list_row created_at',
        },
    }


if __name__ == '__main__':
    payload = build_hms_payload()
    print(json.dumps({'columns': len(payload['columns']), 'rows': len(payload['rows']), 'meta': payload['meta']}, indent=2, sort_keys=True))
