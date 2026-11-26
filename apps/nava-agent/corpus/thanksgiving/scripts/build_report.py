#!/usr/bin/env python3
import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

REPORT_DIR = Path('/home/orca/.local/share/zero/research/thanksgiving/reports')
WORK_DIR = Path('/home/orca/.local/share/zero/research/thanksgiving/work/p0-p3')


def number(value):
    if value is None:
        return 0
    if isinstance(value, (int, float)):
        return value
    try:
        return int(value)
    except (TypeError, ValueError):
        try:
            return float(value)
        except (TypeError, ValueError):
            return 0


def rate_value(value):
    if value in (None, ''):
        return None
    return float(value)


def pct(value):
    if value is None:
        return 'n/a'
    return f'{value * 100:.1f}%'


def metric_map(result):
    return {row['metric_name']: row for row in result.get('metrics', [])}


def md_table(headers, rows):
    lines = ['| ' + ' | '.join(headers) + ' |', '|' + '|'.join(['---'] * len(headers)) + '|']
    for row in rows:
        lines.append('| ' + ' | '.join(str(cell) for cell in row) + ' |')
    return '\n'.join(lines)


def sample_keys(details):
    values = (details or {}).get('sample_keys') or []
    return ', '.join(f'`{x}`' for x in values[:5]) if values else '—'


def build(result, meta=None, before=None):
    metrics = metric_map(result)
    thread = metrics.get('thread_to_hms_hit_rate', {})
    hms = metrics.get('hms_to_thread_coverage', {})
    hms_all = metrics.get('hms_to_thread_coverage_all_sob_non_ota', {})
    funnel_metric = metrics.get('funnel_counts', {})
    funnel = funnel_metric.get('details') or {}
    thread_rate = rate_value(thread.get('rate'))
    hms_rate = rate_value(hms.get('rate'))
    hms_all_rate = rate_value(hms_all.get('rate'))

    total_messages = number(funnel.get('total_messages'))
    domain_cut = number(funnel.get('domain_cut_messages'))
    self_cut = number(funnel.get('self_mail_cut_messages')) + number(funnel.get('owner_prestay_cut_messages'))
    duplicate_cut = number(funnel.get('duplicate_cut_messages'))
    final_uncut = number(funnel.get('final_uncut_messages'))
    after_domain = total_messages - domain_cut
    after_self = after_domain - self_cut
    after_duplicates = after_self - duplicate_cut

    total_attachments = number(funnel.get('total_attachments'))
    branding_cut = number(funnel.get('branding_cut_attachments'))
    attachment_dup_cut = number(funnel.get('duplicate_cut_attachments'))
    final_uncut_attachments = number(funnel.get('final_uncut_attachments'))

    thread_rows = [
        ['Thread → HMS hit rate', f"**{pct(thread_rate)}**", number(thread.get('numerator')), number(thread.get('denominator')), 'post non-cut inbound threads with ≥1 resolved key'],
        ['HMS → thread coverage (E-Mail SOB)', f"**{pct(hms_rate)}**", number(hms.get('numerator')), number(hms.get('denominator')), 'post-created clean HMS E-Mail reservations with key in any post thread'],
        ['HMS → thread coverage (all-SOB non-OTA)', f"**{pct(hms_all_rate)}**", number(hms_all.get('numerator')), number(hms_all.get('denominator')), 'post-created clean non-OTA HMS reservations with key in any post thread'],
    ]
    message_funnel_rows = [
        ['P0 registered', total_messages, '—'],
        ['after OTA/system sender-domain cut', after_domain, domain_cut],
        ['after hotel self-mail cut', after_self, self_cut],
        ['after exact duplicate message cut', after_duplicates, duplicate_cut],
        ['final uncut register', final_uncut, 'check'],
    ]
    attachment_funnel_rows = [
        ['P0 registered', total_attachments, '—'],
        ['branding/signature images cut', branding_cut, 'inline/content-id image ≤100 KiB, sha256 in ≥5 messages'],
        ['exact duplicate attachments cut', attachment_dup_cut, 'same sha256; first occurrence retained'],
        ['final uncut attachments', final_uncut_attachments, '—'],
    ]
    thread_funnel_rows = [
        ['post non-cut inbound threads', number(funnel.get('post_noncut_inbound_threads'))],
        ['threads with ≥1 extracted key', number(funnel.get('keyed_threads'))],
        ['threads with ≥1 key resolving to HMS', number(funnel.get('resolved_threads'))],
        ['active HMS reservations loaded', number(funnel.get('active_hms_reservations'))],
        ['post-created HMS E-Mail cohort', number(funnel.get('post_email_hms_reservations'))],
        ['post-created all-SOB non-OTA cohort', number(funnel.get('post_nonota_hms_reservations'))],
        ['labtest HMS rows excluded', number(funnel.get('labtest_hms_reservations'))],
        ['future-created HMS rows excluded', number(funnel.get('future_created_hms_reservations'))],
    ]

    thread_misses = [row for row in result.get('miss_samples', []) if row.get('direction') == 'thread_to_hms']
    hms_misses = [row for row in result.get('miss_samples', []) if row.get('direction') == 'hms_to_thread']
    thread_miss_rows = [
        [row.get('ordinal'), f"`{row.get('entity_id')}`", row.get('reason'), number((row.get('details') or {}).get('key_count')), sample_keys(row.get('details'))]
        for row in thread_misses
    ]
    hms_miss_rows = [
        [row.get('ordinal'), f"`{row.get('confirmation_key')}`", row.get('reason'), number((row.get('details') or {}).get('thread_count')), number((row.get('details') or {}).get('post_thread_count'))]
        for row in hms_misses
    ]

    scan = result.get('scan') or {}
    extraction = result.get('extraction') or {}
    hms_load = result.get('hms_load') or {}
    evidence_counts = hms_load.get('evidence_counts') or (((meta or {}).get('hms_meta') or {}).get('evidence_counts')) or {}
    evidence_rows = [[key, value] for key, value in sorted(evidence_counts.items())]
    generated = datetime.now(timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z')

    comparison_md = ''
    before_machine = None
    if before:
        before_metrics = metric_map(before)
        before_thread = before_metrics.get('thread_to_hms_hit_rate', {})
        before_hms = before_metrics.get('hms_to_thread_coverage', {})
        before_funnel = (before_metrics.get('funnel_counts', {}) or {}).get('details') or {}
        compare_rows = [
            ['thread → HMS hit rate', pct(rate_value(before_thread.get('rate'))) + f" ({number(before_thread.get('numerator'))}/{number(before_thread.get('denominator'))})", pct(thread_rate) + f" ({number(thread.get('numerator'))}/{number(thread.get('denominator'))})"],
            ['HMS → thread E-Mail coverage', pct(rate_value(before_hms.get('rate'))) + f" ({number(before_hms.get('numerator'))}/{number(before_hms.get('denominator'))})", pct(hms_rate) + f" ({number(hms.get('numerator'))}/{number(hms.get('denominator'))})"],
            ['final uncut messages', number(before_funnel.get('final_uncut_messages')), final_uncut],
            ['active confirmation-key rows', number(before_funnel.get('active_confirmation_key_rows')), number(funnel.get('active_confirmation_key_rows'))],
            ['post-created HMS E-Mail cohort', number(before_funnel.get('post_email_hms_reservations')), number(funnel.get('post_email_hms_reservations'))],
        ]
        comparison_md = '\n## 1a. Before / after\n\nBefore run `'+str(before.get('run_id'))+'`; after run `'+str(result.get('run_id'))+'`.\n\n' + md_table(['metric', 'before', 'after'], compare_rows) + '\n'
        before_machine = {'run_id': before.get('run_id'), 'metrics': before.get('metrics')}

    markdown = f"""# Thanksgiving P0–P3 funnel

**Answer: thread → HMS hit rate is `{pct(thread_rate)}` ({number(thread.get('numerator'))}/{number(thread.get('denominator'))}); HMS → thread coverage is `{pct(hms_rate)}` ({number(hms.get('numerator'))}/{number(hms.get('denominator'))}) for clean E-Mail SOB and `{pct(hms_all_rate)}` ({number(hms_all.get('numerator'))}/{number(hms_all.get('denominator'))}) for all-SOB non-OTA. Deterministic tying works for that share of post-2026-09-09 email bookings; it is not universal.**

- Run: `{result.get('run_id')}`; generated `{generated}`.
- Code: `apps/nava-agent/corpus/thanksgiving/`; re-runnable through SSM.
- DB effect: additive `thanksgiving` schema only. No public/Nava DDL or writes. No S3 writes; bounded read-only attachment GETs for PDF text. No LLM use. No HMS live reads.
- HMS input: Lane H frozen `stable-tiers.jsonl`, trimmed to P3 columns, best evidence per confirmation.
- Raw MIME flag means `public.message.raw_mime_s3_key IS NULL`; this run did not re-HEAD raw MIME objects.

## 1. Headline metrics

{md_table(['metric', 'rate', 'numerator', 'denominator', 'meaning'], thread_rows)}
{comparison_md}

Definitions matter:

- Thread denominator: distinct threads with ≥1 post-2026-09-09 inbound message that is not cut.
- Thread numerator: any HMS-validated confirmation key donated by an uncut message (or hotel self-prestay exception) anywhere in that thread resolves to non-labtest HMS evidence whose `created_at` is not after `observed_at`.
- E-Mail HMS denominator: active non-labtest rows with `source_of_business = E-Mail`, `created_at >= 2026-09-09T00:00:00Z`, and no future `created_at`.
- All-SOB non-OTA denominator: same cleanliness rules over non-null SOB outside `BCOM, EXP, DOTW-XML, TBO, HBEDS, HYPG, TRIP, Channel Manager`.
- HMS numerator: confirmation key appears in any registered thread containing ≥1 post-2026-09-09 message.

## 2. Message funnel

{md_table(['stage', 'messages remaining', 'cut at stage'], message_funnel_rows)}

Attachment hygiene:

{md_table(['stage', 'count', 'rule'], attachment_funnel_rows)}

Thread/HMS funnel:

{md_table(['stage', 'count'], thread_funnel_rows)}

Extraction/load counts:

{md_table(['item', 'count'], [
    ['messages scanned for hash/body keys', number(scan.get('messages_scanned'))],
    ['messages with nonempty body hash', number(scan.get('messages_hashed'))],
    ['confirmation-key candidates before filters', number(extraction.get('rows_candidate_before_filters'))],
    ['confirmation-key candidates rejected: cut donor', number(extraction.get('rows_rejected_cut_donor'))],
    ['confirmation-key candidates rejected: not in HMS', number(extraction.get('rows_rejected_not_in_hms'))],
    ['active confirmation-key rows this run', number(extraction.get('rows_active_this_run'))],
    ['distinct extracted confirmation keys', number(extraction.get('distinct_keys'))],
    ['threads with extracted keys', number(extraction.get('threads_with_keys'))],
    ['HMS rows input', number(hms_load.get('rows_input')) or number(funnel.get('active_hms_reservations'))],
    ['raw MIME key missing flag', number(funnel.get('raw_mime_key_missing_messages'))],
    ['PDF text candidates', number(scan.get('pdf_candidates'))],
    ['PDF text reads ok', number(scan.get('pdf_read_ok'))],
    ['PDF text key rows', number(scan.get('pdf_key_candidates'))],
])}

HMS evidence selection:

{md_table(['evidence kind:completeness', 'rows'], evidence_rows)}

## 3. Thread → HMS misses, first 20

{md_table(['#', 'thread', 'reason', 'key count', 'sample keys'], thread_miss_rows) if thread_miss_rows else 'No misses sampled.'}

## 4. HMS → thread misses, first 20

{md_table(['#', 'confirmation', 'reason', 'threads seen', 'post threads seen'], hms_miss_rows) if hms_miss_rows else 'No misses sampled.'}

## 5. Rules applied

- OTA/channel cut: sender domain only, using `otaChannelDomains` plus `systemDomains` from `apps/nava-agent/src/mail-ingest.ts`; exact domain or subdomain.
- Production-aligned system cuts: mailer daemon, Fortimail quarantine, Google calendar, Nedbank epay, routine owner pre-stay form, GuestRevu feedback digest.
- Hotel self-mail cut: Legacy Hotels sender, `Pre Stay` subject, `Confirmation No` body marker; these cut messages still donate P3 keys.
- Branding/signature attachment cut: inline/content-id image, ≤100 KiB, same sha256 in ≥5 distinct messages.
- Exact duplicate message cut: same normalized Message-ID header + exact body sha256; first occurrence retained.
- Exact duplicate attachment cut: same `message_id` + attachment sha256; first occurrence retained.
- Confirmation regex: `(?<![0-9])\\d{6,12}-\\d{1,2}(?![0-9])`, subject included, then validated against active HMS keys. Sources in priority order: outbound confirmation-letter filename (0.99), self-mail Confirmation No (0.95), PDF text fallback (0.85), body/subject regex (0.70).
- PDF text extraction ran only on deduplicated non-exact outbound confirmation-named PDFs, first 3 pages, because filename/self-mail/body extraction left obvious HMS coverage gaps.

## 6. Reproduce

```bash
python3 apps/nava-agent/corpus/thanksgiving/scripts/run_pipeline.py
python3 apps/nava-agent/corpus/thanksgiving/scripts/build_report.py --result {WORK_DIR}/{result.get('run_id')}-result.json
```
"""

    machine = {
        'generated_at': generated,
        'run_id': result.get('run_id'),
        'answer': {
            'thread_to_hms_hit_rate': thread_rate,
            'thread_to_hms_numerator': number(thread.get('numerator')),
            'thread_to_hms_denominator': number(thread.get('denominator')),
            'hms_to_thread_coverage': hms_rate,
            'hms_to_thread_numerator': number(hms.get('numerator')),
            'hms_to_thread_denominator': number(hms.get('denominator')),
        },
        'metrics': result.get('metrics'),
        'funnel': funnel,
        'scan': scan,
        'extraction': extraction,
        'hms_load': hms_load,
        'pdf_text': result.get('pdf_text'),
        'table_counts': result.get('table_counts'),
        'miss_samples': result.get('miss_samples'),
        'meta': meta or {},
        'before': before_machine,
    }
    return markdown, machine


def latest_result():
    files = sorted(WORK_DIR.glob('p0p3-*-result.json'), key=lambda path: path.stat().st_mtime)
    if not files:
        raise SystemExit('no pipeline result found')
    return files[-1]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--result', type=Path, default=None)
    parser.add_argument('--meta', type=Path, default=None)
    args = parser.parse_args()
    result_path = args.result or latest_result()
    result = json.loads(result_path.read_text(encoding='utf-8'))
    before = None
    candidates = sorted(WORK_DIR.glob('p0p3-*-result.json'), key=lambda path: path.stat().st_mtime)
    for candidate in reversed(candidates):
        if candidate != result_path:
            try:
                before = json.loads(candidate.read_text(encoding='utf-8'))
                break
            except Exception:
                pass
    meta = None
    meta_path = args.meta
    if meta_path is None:
        candidate = WORK_DIR / f"{result.get('run_id')}-meta.json"
        meta_path = candidate if candidate.exists() else None
    if meta_path:
        meta = json.loads(meta_path.read_text(encoding='utf-8'))
    markdown, machine = build(result, meta, before)
    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    md_path = REPORT_DIR / 'p0-p3-funnel.md'
    json_path = REPORT_DIR / 'p0-p3-funnel.json'
    md_path.write_text(markdown, encoding='utf-8')
    json_path.write_text(json.dumps(machine, indent=2, sort_keys=True) + '\n', encoding='utf-8')
    print(json.dumps({'markdown': str(md_path), 'json': str(json_path), 'run_id': result.get('run_id')}, sort_keys=True))


if __name__ == '__main__':
    main()
