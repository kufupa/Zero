#!/usr/bin/env python3
"""Count rendered and populated fields in selected later saved HMS reads.

Usage: python3 -I -B month-reader-population.py PRIVATE_PDF_ANCHORS CAPTURE_JSON
Outputs counts only. Anchors, captures, names, identifiers and values remain private.
This is an observation of later captures, not a historical state or quote-price proof.
"""
import collections
import json
import pathlib
import sys

FIELDS = {
    'recordView': ('arrivaldate', 'departuredate', 'adults', 'children', 'mealplan', 'rateplan',
                   'company', 'ta1', 'caller', 'udfchar06', 'udfchar13', 'bacontract', 'averagerate'),
    'guestDetails': ('firstname', 'lastname', 'arrivaldate', 'departuredate', 'arrivaltype',
                     'arrivaltime_h', 'arrivaltime_m', 'arrivalnotes'),
}
GRID_COLUMNS = ('First Name', 'Last Name', 'Arrival Type', 'Arrival Time', 'Departure Type', 'Departure Time')


def norm(value):
    return str(value or '').strip().casefold()


def populated(value):
    if value is None or value is False:
        return False
    return bool(value.strip()) if isinstance(value, str) else bool(value)


def summarize(items):
    counters = collections.Counter()
    for item in items:
        for reader, names in FIELDS.items():
            details = (item.get(reader) or {}).get('details') or {}
            fields = details.get('fields') or []
            for name in names:
                matching = [f for f in fields if norm(f.get('name')) == name]
                counters[f'{reader}.{name}.rendered'] += bool(matching)
                counters[f'{reader}.{name}.populated'] += any(populated(f.get('value')) for f in matching)
        grids = ((item.get('guestDetails') or {}).get('details') or {}).get('gridContents') or []
        any_rows, aligned, present, filled = False, False, set(), set()
        for grid in grids:
            if not isinstance(grid, dict):
                continue
            columns, rows = grid.get('columns') or [], grid.get('rows') or []
            if not columns or not rows:
                continue
            any_rows = True
            if not all(isinstance(row, list) and len(row) == len(columns) for row in rows):
                continue
            aligned = True
            for name in GRID_COLUMNS:
                indices = [i for i, column in enumerate(columns) if norm(column) == norm(name)]
                if indices:
                    present.add(name)
                    if any(populated(row[i]) for i in indices for row in rows):
                        filled.add(name)
        counters['guestGrid.any_rows'] += any_rows
        counters['guestGrid.aligned_rows'] += aligned
        for name in present:
            counters[f'guestGrid.{name}.rendered_in_aligned_rows'] += 1
        for name in filled:
            counters[f'guestGrid.{name}.populated_in_aligned_rows'] += 1
    return {'records': len(items), 'counts': dict(sorted(counters.items()))}


def main():
    if len(sys.argv) != 3:
        raise SystemExit('usage: month-reader-population.py PRIVATE_PDF_ANCHORS CAPTURE_JSON')
    anchors_path, capture_path = map(pathlib.Path, sys.argv[1:])
    with anchors_path.open(encoding='utf-8') as f:
        anchors = [json.loads(line) for line in f if line.strip()]
    capture = json.loads(capture_path.read_text(encoding='utf-8'))
    index = collections.defaultdict(list)
    for item in capture.get('results', []):
        if item.get('ok'):
            for aid in item.get('sourcePdfEvidence', {}).get('pdfAttachmentIds', []):
                index[(norm(item.get('confirmation')), aid)].append(item)
    matched, by_token = [], {}
    multiple = 0
    for anchor in anchors:
        token = norm(anchor.get('confirmationIdEvidence', {}).get('filenameToken'))
        candidates = index[(token, anchor.get('attachmentId'))]
        if not token or not candidates:
            raise ValueError('selected_anchor_missing_successful_capture')
        multiple += len(candidates) > 1
        matched.append(candidates[0])
        by_token.setdefault(token, candidates[0])
    result = {'multiple_capture_matches_for_anchor': multiple,
              'pdf_linked_reads': summarize(matched),
              'first_capture_per_filename_token': summarize(list(by_token.values())),
              'limits': 'Later saved captures; rendered/populated fields only. Grid data does not prove row selection, complete pagination, transfer fulfillment, historical state or current quote eligibility.'}
    print(json.dumps(result, indent=2, sort_keys=True))


if __name__ == '__main__':
    main()
