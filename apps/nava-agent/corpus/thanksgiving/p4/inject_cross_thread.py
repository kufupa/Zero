#!/usr/bin/env python3
"""Build E2 cross-thread replay arms and measure P4/replay overlap.

Stdlib only. Never mutates the source bench.
"""
import argparse
import json
import re
import shutil
import sqlite3
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

CONF_RE = re.compile(r'(?<![0-9])\d{6,12}-\d{1,2}(?![0-9])')
MSG_RE = re.compile(r'^msg:(.+)$')
DEFAULT_SNAPSHOT = Path.home() / '.local/share/zero/research/thanksgiving/work/p4/snapshot.sqlite'
QUOTAS = {'create': 12, 'amend': 6, 'cancel': 6, 'filing': 6}
WORKFLOWS = ('create', 'amend', 'cancel', 'filing')


def parse_ts(value):
    if not value:
        return None
    text = str(value).strip()
    if not text:
        return None
    try:
        if text.endswith('Z'):
            text = text[:-1] + '+00:00'
        dt = datetime.fromisoformat(text)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc)
    except ValueError:
        return None


def iso_ms(dt):
    return dt.isoformat(timespec='milliseconds').replace('+00:00', 'Z') if dt else None


def read_json(path):
    return json.loads(Path(path).read_text())


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + '\n')


def load_jsonl(path):
    rows = []
    for line_no, line in enumerate(Path(path).read_text().splitlines(), 1):
        if not line.strip():
            continue
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError as exc:
            raise ValueError(f'{path}:{line_no}: invalid JSONL: {exc}') from exc
    return rows


def resolve_cases_dir(bench_dir, cases_subdir=None):
    bench = Path(bench_dir).resolve()
    candidates = []
    if cases_subdir:
        raw = Path(cases_subdir)
        candidates.extend([raw if raw.is_absolute() else bench / raw, bench / 'cases' / raw])
    else:
        candidates.extend([
            bench / 'cases-val-clean',
            bench / 'cases' / 'holdout-v3',
            bench / 'holdout-v3',
            bench,
        ])
        cases_root = bench / 'cases'
        if cases_root.is_dir():
            candidates.extend(sorted(p for p in cases_root.iterdir() if p.is_dir()))
    for candidate in candidates:
        if candidate.is_dir() and any((p / 'case.json').is_file() for p in candidate.iterdir() if p.is_dir()):
            return candidate
    raise FileNotFoundError(f'no case.json directories under {bench}; pass --cases-subdir')


def load_cases(cases_dir):
    rows = []
    for directory in sorted(p for p in Path(cases_dir).iterdir() if p.is_dir() and not p.name.startswith('_')):
        path = directory / 'case.json'
        if path.is_file():
            card = read_json(path)
            rows.append((directory.name, directory, card))
    return rows


def scalar_strings(value):
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for item in value.values():
            yield from scalar_strings(item)
    elif isinstance(value, (list, tuple)):
        for item in value:
            yield from scalar_strings(item)


def confirmation_candidates(card):
    """Ordered confirmation candidates, strongest first."""
    out = []
    def add(value):
        if isinstance(value, str):
            for conf in CONF_RE.findall(value):
                if conf not in out:
                    out.append(conf)
    for key in ('real_confirmation', 'confirmation'):
        add(card.get(key))
    shown = card.get('hms_shown') or {}
    add(shown.get('confirmation'))
    for target in card.get('expected_targets') or []:
        add(target)
    for row in card.get('gold') or []:
        path = str(row.get('path', '')) if isinstance(row, dict) else ''
        if any(leaf in path for leaf in ('reservation_id', 'confirmation_number')):
            add(str(row.get('value', '')))
    # Fallback for lean v6 cards / filing cases: scan metadata but not large mail/PDF text.
    skip = {'body', 'body_text', 'text', 'extracted_text', 'raw', 'hms_raw', 'context_after'}
    def walk(value, key=''):
        if key in skip:
            return
        if isinstance(value, str):
            add(value)
        elif isinstance(value, dict):
            for k, item in value.items():
                walk(item, str(k))
        elif isinstance(value, list):
            for item in value:
                walk(item, key)
    walk(card)
    return out


def selected_identity(card):
    selected = card.get('selected_email') or {}
    ids = {str(selected.get(k)) for k in ('id', 'message_id', 'source_row_id') if selected.get(k)}
    received = parse_ts(selected.get('received_at') or selected.get('timestamp') or card.get('as_of') or (card.get('source') or {}).get('input_cutoff'))
    return selected, ids, received, str(selected.get('thread_id') or '') or None


def context_ids(card):
    ids = set()
    def add_event(value):
        if not isinstance(value, dict):
            return
        msg = value.get('message') if isinstance(value.get('message'), dict) else value
        for key in ('id', 'message_id', 'source_row_id'):
            if msg.get(key):
                ids.add(str(msg[key]))
    for event in card.get('context_before') or []:
        add_event(event)
    for link in card.get('cross_thread_context') or []:
        for event in (link or {}).get('messages') or []:
            add_event(event)
    return ids


def trim_boilerplate(text, max_chars=6000):
    """Trim quoted history, signatures and legal boilerplate while keeping request text."""
    if not text:
        return ''
    lines = str(text).replace('\r\n', '\n').replace('\r', '\n').split('\n')
    cut = len(lines)
    reply_marker = re.compile(
        r'^\s*(?:>\s*)*(?:-{2,}\s*(?:original message|forwarded message)\s*-{2,}|from\s*:|de\s*:|van\s*:|sent\s*:|enviada\s*:|on\s+.+\s+wrote\s*:)',
        re.I,
    )
    signature = re.compile(
        r'^\s*(?:kind\s+regards|best\s+regards|regards|thanks\s+and\s+regards|thank\s+you|thanks|yours\s+sincerely|warm\s+regards)\b[\s,!.]*$',
        re.I,
    )
    legal = re.compile(r'^\s*(?:disclaimer|privacy policy|terms of service|this e-?mail(?: message)? (?:and|is)|confidentiality notice)\b', re.I)
    for i, line in enumerate(lines):
        if reply_marker.match(line):
            cut = min(cut, i)
            break
    head = lines[:cut]
    sig_cut = len(head)
    for i, line in enumerate(head):
        if i >= 2 and (signature.match(line) or legal.match(line)):
            sig_cut = i
            break
    useful = head[:sig_cut]
    # Drop trailing contact/click/image noise after the signoff cut.
    noise = re.compile(r'^\s*(?:tel|fax|cell|skype|e-?mail|website|web|www\.|https?://|\[cid:|\[https?://|--+|_+)\s*[:\]>]?', re.I)
    while useful and (not useful[-1].strip() or noise.match(useful[-1])):
        useful.pop()
    out = '\n'.join(useful).strip()
    if len(out) > max_chars:
        out = out[:max_chars].rstrip() + '\n[trimmed]'
    return out


def addresses(value):
    if value is None:
        return []
    if isinstance(value, list):
        return [str(x) for x in value if str(x).strip()]
    text = str(value).strip()
    if not text:
        return []
    if text.startswith('['):
        try:
            rows = json.loads(text)
            if isinstance(rows, list):
                return [str(x) for x in rows if str(x).strip()]
        except Exception:
            pass
    emails = re.findall(r'[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}', text, re.I)
    return emails or [text]


class Snapshot:
    def __init__(self, path):
        self.path = Path(path)
        if not self.path.is_file():
            raise FileNotFoundError(f'snapshot missing: {self.path} (L1 output)')
        self.db = sqlite3.connect(f'file:{self.path}?mode=ro', uri=True)
        self.db.row_factory = sqlite3.Row

    def messages(self, ids):
        out = {}
        ids = sorted(set(ids))
        for start in range(0, len(ids), 400):
            chunk = ids[start:start + 400]
            marks = ','.join('?' for _ in chunk)
            sql = f'''select id,thread_id,message_id_header,in_reply_to,references_hdr,sent_at,received_at,
                             direction,mailbox,from_addr,to_addrs,cc_addrs,subject,body_text
                      from message where id in ({marks})'''
            for row in self.db.execute(sql, chunk):
                out[row['id']] = dict(row)
        return out

    def attachments_for(self, message_ids):
        out = defaultdict(list)
        ids = sorted(set(message_ids))
        for start in range(0, len(ids), 400):
            chunk = ids[start:start + 400]
            marks = ','.join('?' for _ in chunk)
            sql = f'''select a.id,a.message_id,a.filename,a.mime_type,a.sha256,d.text
                      from attachment a left join doc_text d on d.attachment_id=a.id
                      where a.message_id in ({marks}) and coalesce(a.is_inline,0)=0'''
            for row in self.db.execute(sql, chunk):
                item = dict(row)
                item.pop('message_id', None)
                out[row['message_id']].append(item)
        return out

    def hms_confirmations(self, clean=False):
        sql = "select confirmation,created_at,cohort_clean from hms_stay where created_at >= '2026-08-01'"
        if clean:
            sql += ' and cohort_clean=1'
        return {row['confirmation']: dict(row) for row in self.db.execute(sql)}

    def p3_pre_cutoff(self, confirmation, cutoff, exclude_ids):
        rows = self.db.execute(
            '''select distinct m.id,m.sent_at from p3_key p join message m on m.id=p.message_id
               where p.confirmation=? and m.sent_at < ? order by m.sent_at''',
            (confirmation, iso_ms(cutoff) or '',
            ),
        ).fetchall()
        return [dict(row) for row in rows if row['id'] not in exclude_ids]


def project_message(row, attachments):
    sent = parse_ts(row.get('sent_at')) or parse_ts(row.get('received_at'))
    received = parse_ts(row.get('received_at')) or sent
    stamp = iso_ms(received)
    projected = {
        'id': row['id'],
        'message_id': row['id'],
        'source_row_id': row['id'],
        'thread_id': row.get('thread_id'),
        'message_id_header': row.get('message_id_header'),
        'rfc_message_id': row.get('message_id_header'),
        'in_reply_to': row.get('in_reply_to'),
        'references': row.get('references_hdr'),
        'direction': row.get('direction'),
        'from': row.get('from_addr'),
        'to': addresses(row.get('to_addrs')),
        'cc': addresses(row.get('cc_addrs')),
        'subject': row.get('subject') or '',
        'body_text': trim_boilerplate(row.get('body_text') or ''),
        'timestamp': stamp,
        'received_at': stamp,
        'sent_at': iso_ms(sent),
        'pdf_attachments_text': [],
        'attachments_non_pdf': [],
    }
    for att in attachments.get(row['id'], []):
        target = 'pdf_attachments_text' if (att.get('mime_type') == 'application/pdf' or str(att.get('filename') or '').lower().endswith('.pdf')) else 'attachments_non_pdf'
        projected[target].append({
            'sent_at': iso_ms(sent),
            'sha256': att.get('sha256'),
            'filename': att.get('filename'),
            'attachment_id': att.get('id'),
            'id': att.get('id'),
            'content_type': att.get('mime_type') or 'application/octet-stream',
            'text': (att.get('text') or '')[:20000],
            'note': 'p4_cross_thread_attachment',
        })
    return projected


def load_links(path):
    by_conf = {}
    for row in load_jsonl(path):
        conf = row.get('confirmation')
        if not conf:
            continue
        # Later linker rows for the same confirmation win only when found; otherwise keep first useful row.
        if conf not in by_conf or row.get('status') == 'found':
            by_conf[conf] = row
    return by_conf


def linked_message_ids(link):
    ids = []
    for section in ('earliest_request', 'members'):
        for item in link.get(section) or []:
            if not isinstance(item, dict):
                continue
            match = MSG_RE.match(str(item.get('id') or ''))
            if match and match.group(1) not in ids:
                ids.append(match.group(1))
    return ids


def measure(args):
    snap = Snapshot(args.snapshot)
    cases_dir = resolve_cases_dir(args.bench, args.cases_subdir)
    cases = load_cases(cases_dir)
    hms = snap.hms_confirmations(clean=args.clean)
    report = {}
    detail = []
    for case_id, _directory, card in cases:
        workflow = card.get('workflow') or 'unknown'
        row = report.setdefault(workflow, {'cases': 0, 'hms_overlap': 0, 'pre_cutoff_p3_context': 0})
        row['cases'] += 1
        _selected, selected_ids, cutoff, _thread = selected_identity(card)
        confs = confirmation_candidates(card)
        matched = [conf for conf in confs if conf in hms]
        if not matched or not cutoff:
            detail.append({'case_id': case_id, 'workflow': workflow, 'confirmations': confs[:5], 'matched_confirmation': None, 'pre_cutoff_messages': 0})
            continue
        row['hms_overlap'] += 1
        best_conf = None
        best_rows = []
        for conf in matched:
            hits = snap.p3_pre_cutoff(conf, cutoff, selected_ids)
            if len(hits) > len(best_rows):
                best_conf, best_rows = conf, hits
        if best_rows:
            row['pre_cutoff_p3_context'] += 1
        detail.append({'case_id': case_id, 'workflow': workflow, 'confirmations': confs[:5], 'matched_confirmation': matched[0], 'best_confirmation': best_conf, 'pre_cutoff_messages': len(best_rows)})
    result = {
        'cases_dir': str(cases_dir),
        'snapshot': str(snap.path),
        'hms_filter': 'cohort_clean=1' if args.clean else 'created_at>=2026-08-01',
        'by_workflow': report,
        'total': {
            'cases': sum(x['cases'] for x in report.values()),
            'hms_overlap': sum(x['hms_overlap'] for x in report.values()),
            'pre_cutoff_p3_context': sum(x['pre_cutoff_p3_context'] for x in report.values()),
        },
    }
    if args.detail_out:
        write_json(Path(args.detail_out), {'summary': result, 'cases': detail})
    print(json.dumps(result, indent=2, sort_keys=True))


def choose_cases(cases, links, snap, quotas, explicit_ids=None):
    all_message_ids = sorted({mid for link in links.values() for mid in linked_message_ids(link)})
    messages = snap.messages(all_message_ids)
    attachments = snap.attachments_for(messages.keys())
    candidates = []
    rejected = []
    for case_id, directory, card in cases:
        if explicit_ids and case_id not in explicit_ids:
            continue
        workflow = str(card.get('workflow') or '').lower()
        if workflow not in WORKFLOWS:
            continue
        selected, selected_ids, cutoff, selected_thread = selected_identity(card)
        if not cutoff:
            rejected.append({'case_id': case_id, 'workflow': workflow, 'reason': 'missing_selected_received_at'})
            continue
        visible_ids = selected_ids | context_ids(card)
        best = None
        for conf in confirmation_candidates(card):
            link = links.get(conf)
            if not link or link.get('status') != 'found':
                continue
            rows = []
            dropped = defaultdict(int)
            for mid in linked_message_ids(link):
                row = messages.get(mid)
                if not row:
                    dropped['missing_snapshot_message'] += 1
                    continue
                sent = parse_ts(row.get('sent_at')) or parse_ts(row.get('received_at'))
                if not sent or not sent < cutoff:
                    dropped['not_before_cutoff'] += 1
                    continue
                if mid in visible_ids:
                    dropped['already_visible'] += 1
                    continue
                if selected_thread and row.get('thread_id') == selected_thread:
                    dropped['selected_thread'] += 1
                    continue
                rows.append((sent, mid, row))
            rows.sort(key=lambda item: (item[0], item[1]))
            if rows and (best is None or len(rows) > len(best['rows'])):
                best = {'confirmation': conf, 'link': link, 'rows': rows, 'dropped': dict(dropped)}
        if best:
            candidates.append({
                'case_id': case_id,
                'directory': directory,
                'card': card,
                'workflow': workflow,
                'cutoff': cutoff,
                **best,
            })
        else:
            rejected.append({'case_id': case_id, 'workflow': workflow, 'reason': 'no_pre_cutoff_linked_context'})
    # deterministic workflow quota pick: context-rich first, then case id
    selected_rows = []
    by_workflow = defaultdict(list)
    for row in candidates:
        by_workflow[row['workflow']].append(row)
    for workflow, quota in quotas.items():
        rows = sorted(by_workflow.get(workflow, []), key=lambda row: (-len(row['rows']), row['case_id']))
        selected_rows.extend(rows[:quota])
    if explicit_ids:
        wanted = set(explicit_ids)
        selected_rows = [row for row in selected_rows if row['case_id'] in wanted]
    return selected_rows, rejected, messages, attachments


def copy_case(src_dir, dst_dir, card):
    if dst_dir.exists():
        shutil.rmtree(dst_dir)
    shutil.copytree(src_dir, dst_dir)
    (dst_dir / 'case.json').write_text(json.dumps(card, indent=2, ensure_ascii=False) + '\n')


def inject(args):
    links = load_links(args.links)
    snap = Snapshot(args.snapshot)
    cases_dir = resolve_cases_dir(args.bench, args.cases_subdir)
    cases = load_cases(cases_dir)
    quotas = dict(QUOTAS)
    if args.quota:
        for part in args.quota.split(','):
            key, value = part.split('=', 1)
            quotas[key.strip().lower()] = int(value)
    explicit = set(x.strip() for x in (args.case_ids or '').split(',') if x.strip()) or None
    picked, rejected, messages, attachments = choose_cases(cases, links, snap, quotas, explicit)
    out = Path(args.out).resolve()
    if out.exists() and not args.force:
        raise FileExistsError(f'output exists: {out}; pass --force')
    if out.exists():
        shutil.rmtree(out)
    arms = {}
    used = []
    for arm in ('arm-a', 'arm-b'):
        root = out / 'cases' / arm
        root.mkdir(parents=True, exist_ok=True)
        arms[arm] = str(root)
    selection = []
    for row in picked:
        card_a = dict(row['card'])
        card_b = json.loads(json.dumps(row['card']))
        grouped = defaultdict(list)
        for sent, mid, msg in row['rows']:
            grouped[msg.get('thread_id') or 'unknown'].append(project_message(msg, attachments))
        xt = []
        for thread_id in sorted(grouped, key=lambda tid: min(m['received_at'] or '' for m in grouped[tid])):
            msgs = sorted(grouped[thread_id], key=lambda msg: (msg['received_at'] or '', msg['id']))
            xt.append({
                'thread_id': thread_id,
                'rank': len(xt) + 1,
                'reason': 'p4_linker_contract_c',
                'messages': msgs,
            })
        card_b['cross_thread_context'] = xt
        card_b['p4_cross_thread'] = {
            'confirmation': row['confirmation'],
            'linked_messages_before_cutoff': sum(len(x['messages']) for x in xt),
            'hard_cutoff': iso_ms(row['cutoff']),
            'source_link_status': row['link'].get('status'),
        }
        copy_case(row['directory'], out / 'cases' / 'arm-a' / row['case_id'], card_a)
        copy_case(row['directory'], out / 'cases' / 'arm-b' / row['case_id'], card_b)
        item = {
            'case_id': row['case_id'],
            'workflow': row['workflow'],
            'confirmation': row['confirmation'],
            'linked_messages': sum(len(x['messages']) for x in xt),
            'linked_threads': len(xt),
            'message_ids': [m['id'] for x in xt for m in x['messages']],
            'dropped': row['dropped'],
        }
        selection.append(item)
        used.append({'confirmation': row['confirmation'], 'case_id': row['case_id'], 'link': row['link']})
    by_workflow = defaultdict(int)
    for row in selection:
        by_workflow[row['workflow']] += 1
    report = {
        'bench_dir': str(Path(args.bench).resolve()),
        'cases_dir': str(cases_dir),
        'out_dir': str(out),
        'snapshot': str(snap.path),
        'links': str(Path(args.links).resolve()),
        'arms': arms,
        'selected_n': len(selection),
        'selected_by_workflow': dict(sorted(by_workflow.items())),
        'requested_quotas': quotas,
        'selection': selection,
        'rejected_n': len(rejected),
        'rejected_sample': rejected[:50],
    }
    write_json(out / 'selection.json', report)
    with (out / 'links-used.jsonl').open('w') as fh:
        for row in used:
            fh.write(json.dumps(row, sort_keys=True) + '\n')
    print(json.dumps({k: report[k] for k in ('out_dir','cases_dir','selected_n','selected_by_workflow','rejected_n')}, indent=2, sort_keys=True))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    def common(p):
        p.add_argument('--snapshot', type=Path, default=DEFAULT_SNAPSHOT)
        p.add_argument('--bench', type=Path, required=True, help='bench root or cases root')
        p.add_argument('--cases-subdir', help='case-set name/path (default: cases-val-clean, then cases/holdout-v3)')
    measure_p = sub.add_parser('measure', help='measure replay-bench overlap using snapshot P3 keys')
    common(measure_p)
    measure_p.add_argument('--clean', action='store_true', help='restrict hms overlap to cohort_clean=1')
    measure_p.add_argument('--detail-out')
    measure_p.set_defaults(fn=measure)
    inject_p = sub.add_parser('inject', help='write arm-a/arm-b replay cases')
    common(inject_p)
    inject_p.add_argument('--links', type=Path, required=True, help='CONTRACT C links.jsonl')
    inject_p.add_argument('--out', type=Path, required=True, help='new bench output directory')
    inject_p.add_argument('--quota', help='comma overrides, e.g. create=12,amend=6,cancel=6,filing=6')
    inject_p.add_argument('--case-ids', help='comma case ids for dry-runs; quotas still apply')
    inject_p.add_argument('--force', action='store_true')
    inject_p.set_defaults(fn=inject)
    args = parser.parse_args(argv)
    try:
        args.fn(args)
    except Exception as exc:
        print(f'ERROR: {exc}', file=sys.stderr)
        return 2
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
