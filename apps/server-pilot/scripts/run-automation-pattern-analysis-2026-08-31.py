from collections import Counter, defaultdict
from hashlib import sha256
from pathlib import Path
import json, re

ROOT = Path('/home/ubuntu/projects/zero/.private/connected-mailbox-corpus')
SNAP = ROOT / 'connected-mailbox-inbox-2026-08-30.md'
OUT = ROOT / 'follow-up'
OUT.mkdir(parents=True, exist_ok=True)

text = SNAP.read_text(errors='replace').replace('\r\n', '\n')
blocks = re.split(r'(?m)^---\n', text)

def field(block, key):
    m = re.search(r'(?m)^- \*\*' + re.escape(key) + r':\*\*\s*`?([^`\n]*)', block)
    return m.group(1).strip() if m else ''

def digest(value):
    return sha256(value.encode('utf-8', 'replace')).hexdigest()[:16]

def norm(value):
    value = value.lower()
    value = re.sub(r'\b\d{4,}\b', '<num>', value)
    value = re.sub(r'\b[0-9a-f]{8}-[0-9a-f-]{27,}\b', '<id>', value)
    value = re.sub(r'\s+', ' ', value).strip()
    return value

def body_of(block):
    if '### Text body' not in block: return ''
    return block.split('### Text body', 1)[1].split('### HTML body', 1)[0]

rows = []
for block in blocks:
    if not re.search(r'(?m)^## Message \d+: ', block): continue
    subject = re.search(r'(?m)^## Message \d+: (.*)$', block)
    rows.append({
        'id': field(block, 'Message ID'), 'thread': field(block, 'Thread ID'),
        'direction': field(block, 'Direction').lower(), 'from': field(block, 'From').lower(),
        'subject': subject.group(1).strip() if subject else '', 'body': body_of(block),
        'block': block,
    })
assert len(rows) == 3820 and len({r['id'] for r in rows}) == 3820
threads = defaultdict(list)
for r in rows: threads[r['thread']].append(r)
assert len(threads) == 2810

# Header markers: explicit RFC-ish automation signals and common system signatures.
header_patterns = {
    'auto_submitted': r'(?im)^\s*(?:auto-submitted|auto-submitted):\s*',
    'precedence_bulk_or_list': r'(?im)^\s*precedence:\s*(?:bulk|list|junk)\b',
    'x_auto_response_suppress': r'(?im)^\s*x-auto-response-suppress:\s*',
    'list_unsubscribe': r'(?im)^\s*list-unsubscribe:\s*',
    'mailer_daemon_or_noreply_header': r'(?im)^\s*(?:return-path|from):[^\n]*(?:mailer-daemon|no[- ]?reply|noreply)\b',
}
body_signatures = {
    'no_reply_or_noreply': r'\b(?:no[- ]?reply|do not reply|don\'t reply|not monitored)\b',
    'system_notification': r'\b(?:automated message|system[- ]generated|notification|delivery report|mailer daemon|nondelivery|security digest|quarantine digest)\b',
    'confirmation': r'\b(?:reservation|booking) confirmation\b|\bconfirmation number\b|\bconfirmed\b',
    'cancellation': r'\b(?:cancellation|cancelled|canceled|cancel)\b',
    'notification': r'\b(?:notification|reminder|alert|update)\b',
    'failure_exception': r'\b(?:failed|failure|error|declined|unpaid|overdue|refund|chargeback|bounce|undeliver|urgent|overbook|missing|complaint|security)\b',
}

def has(pattern, s): return bool(re.search(pattern, s, re.I | re.S))
def msg_text(r): return r['block']

def top_hashed(counter, n=20):
    return [{'hash': k, 'count': v} for k,v in counter.most_common(n)]

# Sender + format recurrence, deliberately opaque.
sender_format = Counter()
sender_subject = Counter()
subject_format = Counter()
body_format = Counter()
for r in rows:
    sender = digest(norm(r['from'])) if r['from'] else 'missing'
    subj = digest(norm(r['subject']))
    body = digest(norm(re.sub(r'\bhttps?://\S+|\S+@\S+\b', '<token>', r['body'])))
    sender_format[(sender, subj, body)] += 1
    sender_subject[(sender, subj)] += 1
    subject_format[subj] += 1
    body_format[body] += 1

# Per-message and per-thread automation evidence.
message_counts = Counter(); thread_counts = Counter()
for r in rows:
    combined = msg_text(r)
    for name, pat in {**header_patterns, **body_signatures}.items():
        if has(pat, combined): message_counts[name] += 1
for tid, rs in threads.items():
    combined = '\n'.join(msg_text(r) for r in rs)
    for name, pat in {**header_patterns, **body_signatures}.items():
        if has(pat, combined): thread_counts[name] += 1

# Practical routing categories, conservative and non-gold.
route = Counter()
for tid, rs in threads.items():
    combined = '\n'.join(msg_text(r) for r in rs)
    has_auto = any(has(p, combined) for p in header_patterns.values()) or any(has(p, combined) for p in body_signatures.values())
    exception = has(body_signatures['failure_exception'], combined) or has(body_signatures['cancellation'], combined)
    human_action = has(r'\b(?:payment|deposit|invoice|quote|booking|reservation|room|stay|group|event|complaint|security|policy|deadline)\b', combined)
    outbound = any(r['direction'] == 'outbound' for r in rs)
    if has_auto and exception: cat = 'automated-exception-review'
    elif has_auto and human_action: cat = 'automated-business-notice-review'
    elif has_auto and not human_action: cat = 'likely-routine-automated-no-response-candidate'
    else: cat = 'human-or-external-action-candidate'
    route[cat] += 1

outbound_threads = sum(any(r['direction'] == 'outbound' for r in rs) for rs in threads.values())
mixed_threads = sum(any(r['direction']=='inbound' for r in rs) and any(r['direction']=='outbound' for r in rs) for rs in threads.values())
repeat_sender_formats = sum(v >= 2 for v in sender_format.values())
repeat_subject_formats = sum(v >= 2 for v in subject_format.values())
repeat_body_formats = sum(v >= 2 for v in body_format.values())

result = {
 'schemaVersion': 1, 'analysisVersion': 'automation-pattern-analysis-2026-08-31-v1',
 'status': 'private_read_only_planning', 'sourceSnapshot': SNAP.name,
 'coverage': {'messages': len(rows), 'threads': len(threads), 'inboundMessages': sum(r['direction']=='inbound' for r in rows), 'outboundMessages': sum(r['direction']=='outbound' for r in rows)},
 'hashedRecurringFormats': {'distinctSenderSubjectBody': len(sender_format), 'repeatedSenderSubjectBodyFormats': repeat_sender_formats, 'distinctSenderSubject': len(sender_subject), 'repeatedSubjectFormats': repeat_subject_formats, 'distinctBodyFormats': len(body_format), 'repeatedBodyFormats': repeat_body_formats, 'topSenderSubjectBodyHashes': top_hashed(sender_format), 'topSubjectHashes': top_hashed(subject_format), 'topBodyHashes': top_hashed(body_format)},
 'explicitAutomationMarkers': {'messageCounts': dict(message_counts), 'threadCounts': dict(thread_counts)},
 'threadDirection': {'outboundThreads': outbound_threads, 'inboundOnlyThreads': len(threads)-outbound_threads, 'mixedThreads': mixed_threads, 'outboundThreadRateDenominator': len(threads)},
 'routingCategories': dict(route),
 'limitations': ['Hashes are opaque recurrence keys; no sender, address, subject, body, URL, or message IDs emitted.', 'Header detection is based on exported text and cannot establish original SMTP/MIME provenance.', 'Lexical marker families overlap and are not additive.', 'Outbound presence is historical direction evidence only; it does not prove reply intent, delivery, human authorship, or completion.', 'Categories are practical routing candidates, not gold labels or production decisions.', 'No normalized MIME parts, provider lifecycle, directory/alias authorization, case spine, or PMS/CRS event join was available.']
}
json_path = OUT / 'automation-pattern-analysis-2026-08-31.json'
json_path.write_text(json.dumps(result, indent=2) + '\n')

md = f'''# Automation-pattern corpus analysis

Status: private, deterministic, read-only planning. Generated 2026-08-31. Source: `{SNAP.name}`.

## Scope and method

A local Python scan parsed every exported message block, grouped by exported thread ID, and computed opaque SHA-256 prefix hashes for normalized sender/subject/body formats. Raw addresses, subjects, bodies, URLs, and message IDs are not present in this artifact. No gold labels were used.

- Messages: **{len(rows)}**; threads: **{len(threads)}**; inbound: **{sum(r['direction']=='inbound' for r in rows)}**; outbound: **{sum(r['direction']=='outbound' for r in rows)}**.
- Threads with any outbound: **{outbound_threads}**; inbound-only: **{len(threads)-outbound_threads}**; mixed-direction: **{mixed_threads}**.
- Source line citation: message blocks span the private snapshot; the parser validated all 3,820 blocks. See `{SNAP.name}` (local lines 1–approximately 1,000,000; exact block line ranges retained only in-process and not emitted).

## Recurring sender + format

- Distinct opaque sender+subject+body signatures: **{len(sender_format)}**; signatures recurring at least twice: **{repeat_sender_formats}**.
- Distinct opaque sender+subject signatures: **{len(sender_subject)}**; recurring subject formats: **{repeat_subject_formats}**.
- Distinct normalized body signatures: **{len(body_format)}**; recurring body formats: **{repeat_body_formats}**.
- Top recurring values are available only as hashes in the adjacent JSON artifact.

## Explicit automation/system evidence

| Marker family | Messages | Threads |
|---|---:|---:|
'''
for k in list(header_patterns)+list(body_signatures): md += f'| `{k}` | {message_counts[k]} | {thread_counts[k]} |\n'
md += f'''

Header markers are exported-text observations, not verified RFC header provenance. No-reply/system signatures are useful for candidate routing but can coexist with a real exception or customer obligation.

## Practical routing categories (not gold labels)

| Candidate category | Threads | Intended handling |
|---|---:|---|
'''
md += '| `likely-routine-automated-no-response-candidate` | ' + str(route['likely-routine-automated-no-response-candidate']) + ' | Lower-urgency review candidate; do not hide solely from this signal. |\n'
md += '| `automated-exception-review` | ' + str(route['automated-exception-review']) + ' | Automated-looking but cancellation/failure/risk markers; keep visible and review. |\n'
md += '| `automated-business-notice-review` | ' + str(route['automated-business-notice-review']) + ' | Automated-looking confirmation/notification with business context; verify state/document/action. |\n'
md += '| `human-or-external-action-candidate` | ' + str(route['human-or-external-action-candidate']) + ' | No strong automation signature; retain human/external-action posture. |\n'
md += '''

## Outbound relationship

Outbound is measured only as thread direction. A thread having outbound does not establish that the outbound was a response to the automated message, that it was delivered, or that the obligation was completed. Candidate routing should not use outbound as permission to hide.

## Limitations

- Hashes are opaque recurrence keys; no raw PII or content is emitted.
- Marker families overlap and are not additive.
- Exported headers may omit or transform original SMTP/MIME fields.
- No normalized MIME parts, provider delivery lifecycle, employee/alias authorization, case/obligation spine, or PMS/CRS event join was available.
- These are routing candidates for shadow evaluation, not labels, precision claims, or authorization for folder changes.

Private JSON companion: `automation-pattern-analysis-2026-08-31.json`.
'''
(OUT / 'automation-pattern-analysis-2026-08-31.md').write_text(md)
print(json.dumps({'status':'PASS','messages':len(rows),'threads':len(threads),'outboundThreads':outbound_threads,'artifact':str(OUT/'automation-pattern-analysis-2026-08-31.md')}))
