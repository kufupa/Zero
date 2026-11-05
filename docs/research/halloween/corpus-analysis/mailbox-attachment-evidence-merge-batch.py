#!/usr/bin/env python3
"""Merge readable attachment evidence case by case, retaining skipped-case reasons.

The evidence is bound to the original packet-file hash. A later composed packet
may add candidate-reply metadata, but its source and inbound must be identical.
Oversize/unreadable cases stay in the frame and are reported, not truncated.
"""

import argparse
import collections
import importlib.util
import json
import os
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('attachment_helper', HERE / 'centurion-attachment-review-helper.py')
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)


def write_json(path, value):
    target = helper._private_path(path, existing=False)
    fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w', encoding='utf-8') as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.write('\n')


def has_text(result):
    return any(attachment.get('evidence_lines') or attachment.get('evidence_rows')
               for source in result.get('sources', [])
               for attachment in source.get('attachments', []))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--original-packets', type=Path, required=True)
    parser.add_argument('--current-packets', type=Path, required=True)
    parser.add_argument('--evidence-dir', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--manifest', type=Path, required=True)
    args = parser.parse_args()
    original, digest = helper._read_jsonl_with_sha256(args.original_packets)
    current = helper._read_jsonl(args.current_packets)
    originals, latest = helper._case_map(original), helper._case_map(current)
    if set(originals) != set(latest):
        raise ValueError('packet frames differ')
    for case, packet in originals.items():
        if packet['_source'] != latest[case]['_source'] or packet['inbound'] != latest[case]['inbound']:
            raise ValueError('source or inbound changed since evidence extraction')
    evidence_dir = args.evidence_dir.resolve(strict=True)
    if not evidence_dir.is_relative_to(helper.PRIVATE_ROOT.resolve(strict=True)):
        raise ValueError('evidence directory must be private')
    report = helper._read_json(evidence_dir / 'report.json')
    if report.get('failed_jobs'):
        raise ValueError('attachment extraction batch has failed jobs')

    docs_by_case = collections.defaultdict(list)
    case_stats = collections.Counter()
    for path in sorted([*evidence_dir.glob('room-*.json'), *evidence_dir.glob('document-*.json')]):
        doc = helper._read_json(path)
        if doc.get('input_sha256') != digest:
            raise ValueError('evidence source packet hash mismatch')
        if doc.get('status') != 'ok' or doc.get('version') != helper.ATTACHMENT_EVIDENCE_VERSION:
            raise ValueError('invalid extraction identity')
        for case, result in doc.get('cases', {}).items():
            if case not in originals:
                raise ValueError('extraction case absent from original frame')
            case_stats[result.get('status', 'unknown')] += 1
            docs_by_case[case].append({**doc, 'cases': {case: result}})

    merged, outcomes = [], []
    for case in sorted(docs_by_case):
        docs = docs_by_case[case]
        if not any(has_text(next(iter(doc['cases'].values()))) for doc in docs):
            outcomes.append({'case': case, 'status': 'no_readable_selected_text'})
            continue
        try:
            packets, _ = helper.merge([originals[case]], docs, helper.MAX_CONTEXT_CHARS, digest)
        except helper.Failure as exc:
            if exc.code not in {'attachment_evidence_context_limit_exceeded', 'attachment_context_limit_exceeded',
                                'existing_attachment_context_too_large', 'merged_model_input_too_large'}:
                raise
            outcomes.append({'case': case, 'status': exc.code})
            continue
        packet = packets[0]
        packet['candidate_replies'] = latest[case]['candidate_replies']
        merged.append(packet)
        outcomes.append({'case': case, 'status': 'merged'})
    helper._write_jsonl(args.output, merged)
    manifest = {'original_packet_sha256': digest, 'batch_cases': len(docs_by_case),
                'extractor_statuses': dict(case_stats),
                'outcomes': dict(collections.Counter(row['status'] for row in outcomes)),
                'cases': outcomes}
    write_json(args.manifest, manifest)
    print(json.dumps({'batch_cases': len(docs_by_case), 'outcomes': manifest['outcomes']}, sort_keys=True))


if __name__ == '__main__':
    main()
