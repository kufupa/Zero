from collections import Counter, defaultdict
from datetime import datetime
from hashlib import sha256
from pathlib import Path
import json
import re

ROOT = Path('/home/ubuntu/projects/zero/.private/connected-mailbox-corpus')
SNAP = ROOT / 'connected-mailbox-inbox-2026-08-30.md'
CENSUS = ROOT / 'thread-review/full-thread-census-2026-08-30.json'
OUT = ROOT / 'follow-up/kpi-signal-analysis-2026-08-30.json'

text = SNAP.read_text(errors='replace').replace('\r\n', '\n')
blocks = re.split(r'(?m)^---\n', text)
keys = ['Message ID', 'Thread ID', 'Transport ID', 'Direction', 'From', 'To', 'CC', 'BCC', 'Received', 'Sent', 'Created']

def field(block, key):
    match = re.search(r'(?m)^- \*\*' + re.escape(key) + r':\*\*\s*`?([^`\n]*)', block)
    return match.group(1).strip() if match else ''

rows = []
for block in blocks:
    if not re.search(r'(?m)^## Message \d+: ', block):
        continue
    row = {key: field(block, key) for key in keys}
    row['thread_key'] = sha256(row['Thread ID'].lower().encode()).hexdigest()[:20]
    row['body'] = block
    rows.append(row)
assert len(rows) == 3820
assert len({row['Message ID'] for row in rows}) == 3820
threads = defaultdict(list)
for row in rows:
    threads[row['thread_key']].append(row)
assert len(threads) == 2810

patterns = {
    'government_rate': r'government rate|gov(?:ernment)?\s+rate|public.?sector|department of labour|armscor|municipal|state.?owned|government booking',
    'group_10_plus_signal': r'\b(?:1[0-9]|[2-9][0-9]|[1-9][0-9]{2,})\s+(?:rooms?|units?)\b|group booking|rooming list|room block|conference|delegat(?:e|ion)|event|wedding|banquet',
    'cancellation': r'cancel(?:lation|led|ing)?|no.?show|release(?:d)?\s+(?:rooms?|space)|waiv(?:e|er)|penalty|fee',
    'booking_or_quote': r'booking|reservation|availability|quote|rate|room|stay|accommodation',
    'payment': r'payment|paid|deposit|refund|invoice|folio|remittance|bank.?slip|proof of payment|unpaid|overdue|chargeback',
    'automated_marker': r'automated e.?mail|do not reply|system generated|notification|confirmation number|reservation confirmation|night audit|cron|mailer',
    'urgent_marker': r'urgent|urgently|immediately|asap|same day|today|tomorrow|deadline|arriving|arrival|check.?in|check.?out|overdue',
    'document': r'attachment|attached|invoice|voucher|receipt|pro.?forma|itinerary|passport|document|remittance',
    'system_integration': r'synxis|pms|crs|integration|channel manager|overbook|inventory|failed to integrate|interface|system error',
    'security': r'quarantine|phish|malware|virus|suspicious|credential|password|blocked|security|spam',
    'kitchen_or_lookup': r'check (?:the )?kitchen|kitchen|look(?:ed|ing) for|find (?:the )?(?:item|document|invoice|voucher)|investigat(?:e|ion)|awaiting feedback|follow.?up',
}

signal = {}
for name, pattern in patterns.items():
    msg_ids = {row['Message ID'] for row in rows if re.search(pattern, row['body'], re.I | re.S)}
    thread_ids = {row['thread_key'] for row in rows if row['Message ID'] in msg_ids}
    signal[name] = {'messages': len(msg_ids), 'threads': len(thread_ids), 'evidence_tier': 'lexical_signal', 'overlap': True}

def thread_has(rowset, pattern):
    return any(re.search(pattern, row['body'], re.I | re.S) for row in rowset)

outbound = [row for row in rows if row['Direction'].lower() == 'outbound']
inbound = [row for row in rows if row['Direction'].lower() == 'inbound']
thread_stats = []
for thread_key, thread_rows in threads.items():
    ordered = sorted(thread_rows, key=lambda row: (row['Received'], row['Created'], row['Message ID']))
    dirs = [row['Direction'].lower() for row in ordered]
    thread_stats.append({
        'key': thread_key,
        'messages': len(thread_rows),
        'outbound': sum(d == 'outbound' for d in dirs),
        'inbound': sum(d == 'inbound' for d in dirs),
        'mixed': 'inbound' in dirs and 'outbound' in dirs,
        'last': dirs[-1],
        'inbound_after_outbound': any(dirs[i] == 'inbound' and 'outbound' in dirs[:i] for i in range(len(dirs))),
        'outbound_after_inbound': any(dirs[i] == 'outbound' and 'inbound' in dirs[:i] for i in range(len(dirs))),
    })
with_outbound = [row for row in thread_stats if row['outbound']]

# Calendar/hour data is observed timestamp metadata, not staff response time.
def hour(row):
    candidate = row['Sent'] or row['Received']
    match = re.search(r'T(\d{2}):', candidate)
    return int(match.group(1)) if match else None
hours = Counter(hour(row) for row in outbound if hour(row) is not None)
late = sum(count for h, count in hours.items() if h is not None and (h >= 17 or h < 7))

census = json.loads(CENSUS.read_text())
assert census['coverage']['threads'] == 2810
intent = Counter(row.get('intentClass') for row in census['threads'])
route = Counter(row.get('routeSlug') for row in census['threads'])
locks = sum(bool(row.get('humanLockRequired')) for row in census['threads'])
confidence = Counter(row.get('confidence') for row in census['threads'])

result = {
    'schemaVersion': 1,
    'analysisVersion': 'kpi-signal-analysis-2026-08-30-v1',
    'sourceAsOf': '2026-08-30T21:53:48.208Z',
    'status': 'private_read_only_planning_signals',
    'coverage': {'messages': len(rows), 'threads': len(threads), 'inbound': len(inbound), 'outbound': len(outbound), 'rawValuesEmitted': False},
    'direction': {
        'outboundBearingThreads': len(with_outbound),
        'inboundOnlyThreads': len(threads) - len(with_outbound),
        'mixedThreads': sum(row['mixed'] for row in with_outbound),
        'outboundOnlyThreads': sum(row['outbound'] and not row['mixed'] for row in with_outbound),
        'lastOutboundThreads': sum(row['last'] == 'outbound' for row in with_outbound),
        'lastInboundThreads': sum(row['last'] == 'inbound' for row in with_outbound),
        'inboundAfterOutboundCandidates': sum(row['inbound_after_outbound'] for row in with_outbound),
        'outboundAfterInboundCandidates': sum(row['outbound_after_inbound'] for row in with_outbound),
        'evidenceTier': 'observed_metadata',
    },
    'outboundHour': {'countsUtcOrSourceTimestamp': dict(sorted(hours.items())), 'afterHoursCount': late, 'afterHoursShareOfOutbound': round(late / len(outbound), 6), 'status': 'timestamp_observed_not_response_latency'},
    'lexicalSignals': signal,
    'semanticPlanning': {'intentCounts': dict(intent), 'routeCounts': dict(route), 'humanLockThreads': locks, 'confidenceCounts': dict(confidence), 'evidenceTier': 'derived_planning_label', 'overlap': False},
    'kpiStatus': {
        'measurableNow': ['inbound volume', 'outbound volume', 'outbound share', 'outbound-bearing threads', 'message/thread direction shape', 'after-hours outbound share', 'candidate category rates', 'automation/document/payment/system lexical signals'],
        'blockedUntilJoins': ['average first-response time', 'SLA compliance', 'staff response rate', 'AI triage lift', 'AI drafting lift', 'realized revenue', 'revenue lost to cancellation', 'recovered revenue', 'government-rate conversion', 'group-booking conversion', 'delivery/bounce rate', 'verified cancellation reason'],
    },
    'joinRequirements': {
        'response': ['message ancestry', 'case/obligation/owner', 'provider delivery', 'business-hour/SLA policy'],
        'revenue': ['reservation/PMS/CRS event', 'reservation value/currency/room nights', 'finance settlement', 'staff attribution'],
        'aiImpact': ['randomized or stepped-wedge eligibility', 'triage/draft exposure logs', 'human decision and edit logs', 'provider delivery', 'PMS/finance outcomes'],
        'cancellation': ['cancellation event/reason', 'policy/fee state', 'reservation value', 'replacement/recovery outcome'],
    },
}
OUT.write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps({'status': 'PASS', 'messages': len(rows), 'threads': len(threads), 'inbound': len(inbound), 'outbound': len(outbound), 'signals': len(signal), 'afterHoursOutbound': late, 'humanLockThreads': locks}))
