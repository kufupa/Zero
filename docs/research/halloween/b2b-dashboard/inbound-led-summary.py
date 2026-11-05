#!/usr/bin/env python3
"""Summarise an existing per-inbound corpus dataset without new model calls."""

import argparse
import collections
import hashlib
import json
import os
from pathlib import Path


WORKFLOWS = {
    'voucher': 'file_voucher',
    'invoice': 'invoice',
    'booking': 'booking_create',
    'quote': 'quote',
    'amendment': 'booking_amend',
    'payment_proof': 'file_payment_proof',
    'cancellation': 'booking_cancel',
}
RESPONSE_TYPES = {'staff', 'hms_confirmation_candidate', 'both', 'none_linked', 'other'}


def pct(numerator, denominator):
    return round(100 * numerator / denominator, 1) if denominator else None


def has_pdf_excerpt(context):
    in_pdf = False
    for line in context.splitlines():
        if line.startswith(('Bounded attachment evidence addendum', 'Source ')):
            in_pdf = False
        elif line.startswith('Attachment type='):
            in_pdf = line.startswith('Attachment type=pdf;') and 'text_status=pdf_text_available' in line
        elif in_pdf and line.startswith('Extracted line:'):
            return True
    return False


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dataset', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()

    private = (Path(__file__).resolve().parents[4] / '.private').resolve(strict=True)
    dataset = args.dataset.resolve(strict=True)
    output = args.output.absolute()
    if not dataset.is_relative_to(private) or not output.parent.resolve(strict=True).is_relative_to(private):
        raise ValueError('dataset and output must be inside .private')
    if output.exists() or output.is_symlink():
        raise ValueError('output already exists')

    raw = dataset.read_bytes()
    rows = [json.loads(line) for line in raw.split(b'\n') if line.strip()]
    cases = [row['case'] for row in rows]
    if len(cases) != len(set(cases)):
        raise ValueError('duplicate inbound case')
    if any(not row.get('_source', {}).get('row_ids') for row in rows):
        raise ValueError('inbound source mapping missing')

    classified, actionable = [], []
    for row in rows:
        classification = row.get('classification')
        if classification is None:
            continue
        if classification.get('case') != row['case']:
            raise ValueError('classification case mismatch')
        classified.append(row)
        if classification.get('reservation_email') is True:
            actionable.append(row)

    response_counts = collections.Counter()
    response_help = collections.Counter()
    tags_all, tags_helpable, tags_staff = collections.Counter(), collections.Counter(), collections.Counter()
    details_helpable, details_staff = collections.Counter(), collections.Counter()
    helpable, linked, linked_helpable, staff, staff_helpable = [], [], [], [], []
    cross_thread = relation_disagreements = no_steps = 0
    voucher_pdf_excerpt = voucher_without_excerpt = 0
    for row in actionable:
        classification = row['classification']
        help_value = classification.get('can_help')
        if help_value is not True and help_value is not False and help_value is not None:
            raise ValueError('invalid helpability value')
        response_type = classification.get('response_type')
        if response_type not in RESPONSE_TYPES:
            raise ValueError('invalid response type')
        replies = classification.get('reply_ids') or []
        candidates = row.get('candidate_replies') or []
        candidate_map = {candidate['reply_id']: candidate for candidate in candidates}
        if len(candidate_map) != len(candidates) or len(replies) != len(set(replies)):
            raise ValueError('duplicate reply id')
        if not set(replies).issubset(candidate_map):
            raise ValueError('linked reply absent from inbound record')
        if bool(replies) != (response_type != 'none_linked'):
            raise ValueError('response type and linked reply disagree')
        actions = classification.get('actions') or []
        if len(actions) != len(set(actions)):
            raise ValueError('duplicate workflow tag')
        tags_all.update(actions)
        response_counts[response_type] += 1
        if replies:
            linked.append(row)
            cross_thread += any(candidate_map[reply_id].get('same_thread') is False for reply_id in replies)
            observations = (row.get('action_details') or {}).get('observed_replies')
            if observations is not None:
                if {item.get('reply_id') for item in observations} != set(replies):
                    raise ValueError('action observations do not match linked reply ids')
                if not any(item.get('relation') == 'same_request' for item in observations):
                    relation_disagreements += 1
        if response_type in {'staff', 'both'}:
            staff.append(row)
        if help_value is True:
            helpable.append(row)
            tags_helpable.update(actions)
            response_help[response_type] += 1
            if replies:
                linked_helpable.append(row)
            if response_type in {'staff', 'both'}:
                staff_helpable.append(row)
                tags_staff.update(actions)
            detail = row.get('action_details') or {}
            supported = {item.get('action') for item in detail.get('request_actions', [])
                         if item.get('nava_supported') is True}
            details_helpable.update(supported)
            if response_type in {'staff', 'both'}:
                details_staff.update(supported)
            if not detail.get('nava_hypothetical'):
                no_steps += 1
        if 'voucher' in actions:
            context = row.get('inbound', {}).get('attachment_context') or ''
            if has_pdf_excerpt(context):
                voucher_pdf_excerpt += 1
            if 'Bounded attachment evidence addendum v1' not in context:
                voucher_without_excerpt += 1

    results = {
        'source_sha256': hashlib.sha256(raw).hexdigest(),
        'unit': 'deduplicated inbound email',
        'inbound': len(rows),
        'classified': len(classified),
        'unclassified': len(rows) - len(classified),
        'reservation_status_unresolved': sum(r['classification'].get('reservation_email') is None for r in classified),
        'actionable': len(actionable),
        'helpable': len(helpable),
        'helpable_pct_of_actionable': pct(len(helpable), len(actionable)),
        'not_helpable': sum(r['classification'].get('can_help') is False for r in actionable),
        'helpability_unresolved': sum(r['classification'].get('can_help') is None for r in actionable),
        'large_group': tags_all['group'],
        'replies': {
            'linked_inbounds': len(linked),
            'linked_helpable_inbounds': len(linked_helpable),
            'helpable_pct_of_linked': pct(len(linked_helpable), len(linked)),
            'staff_linked_inbounds': len(staff),
            'staff_linked_helpable_inbounds': len(staff_helpable),
            'helpable_pct_of_staff_linked': pct(len(staff_helpable), len(staff)),
            'inbounds_with_cross_thread_link': cross_thread,
            'response_types': dict(response_counts),
            'response_types_helpable': dict(response_help),
            'linked_without_same_request_in_action_pass': relation_disagreements,
        },
        'workflows': {
            tag: {'tagged_actionable': tags_all[tag], 'tagged_helpable': tags_helpable[tag],
                  'tagged_helpable_with_staff_reply': tags_staff[tag],
                  'supported_action_detail': details_helpable[detail],
                  'supported_action_detail_with_staff_reply': details_staff[detail]}
            for tag, detail in WORKFLOWS.items()
        },
        'other_tagged': tags_all['other'],
        'payment_request_tagged': tags_all['payment_request'],
        'helpable_without_proposed_steps': no_steps,
        'voucher_tagged_with_pdf_excerpt': voucher_pdf_excerpt,
        'voucher_tagged_without_evidence_addendum': voucher_without_excerpt,
    }
    descriptor = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, 'w', encoding='utf-8') as target:
        json.dump(results, target, ensure_ascii=False, indent=2)
        target.write('\n')
    print(json.dumps(results, ensure_ascii=False))


if __name__ == '__main__':
    main()
