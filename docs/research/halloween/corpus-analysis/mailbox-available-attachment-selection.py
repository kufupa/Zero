#!/usr/bin/env python3
"""Select all retrievable PDF/XLSX-bearing cases for evidence extraction, not classification."""

import argparse
import json
import os
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--mime-index', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    private = Path(__file__).resolve().parents[4] / '.private'
    if (not args.mime_index.resolve().is_relative_to(private.resolve())
            or not args.output.resolve().is_relative_to(private.resolve())):
        raise SystemExit('paths must be private')
    selected = []
    seen = set()
    with args.mime_index.open() as source:
        for line in source:
            if not line.strip():
                continue
            row = json.loads(line)
            case = row['case']
            if case in seen:
                raise SystemExit('duplicate MIME case')
            seen.add(case)
            if row.get('status') != 'ok':
                continue
            attachments = row.get('attachments') or []
            available = any(
                str(item.get('content_type') or '').casefold() in {
                    'application/pdf',
                    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                } or Path(str(item.get('name') or '')).suffix.casefold() in {'.pdf', '.xlsx'}
                for item in attachments
            )
            if available:
                selected.append({'case': case, 'needs_extraction': True, 'extractor_ready': True,
                                 'mime_state': 'attachments_observed', 'purposes': ['room', 'document']})
    fd = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as target:
        for row in selected:
            target.write(json.dumps(row, separators=(',', ':')) + '\n')
    print(json.dumps({'mime_cases': len(seen), 'selected_cases': len(selected)}))


if __name__ == '__main__':
    main()
