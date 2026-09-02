from collections import Counter, defaultdict
from hashlib import sha256
from pathlib import Path
import json, re

ROOT = Path('/home/ubuntu/projects/zero/.private/connected-mailbox-corpus')
SNAP = ROOT / 'connected-mailbox-inbox-2026-08-30.md'
OUT = ROOT / 'follow-up/reverse-joins-2026-08-30.json'
text = SNAP.read_text(errors='replace').replace('\r\n', '\n')
blocks = re.split(r'(?m)^---\n', text)

def val(block, label):
    m = re.search(r'(?m)^- \*\*' + re.escape(label) + r':\*\*\s*`?([^`\n]*)', block)
    return m.group(1).strip() if m else ''

def opaque(value):
    return sha256(value.strip().lower().encode()).hexdigest()[:20] if value else None

def addr_values(value):
    return [opaque(x) for x in re.findall(r'[A-Z0-9._%+\-]+@[A-Z0-9.\-]+', value, re.I)]

rows = []
for block in blocks:
    if not re.search(r'(?m)^## Message \d+: ', block):
        continue
    rows.append({
        'message': opaque(val(block, 'Message ID')),
        'thread': opaque(val(block, 'Thread ID')),
        'transport': opaque(val(block, 'Transport ID')),
        'direction': val(block, 'Direction').lower(),
        'received': val(block, 'Received'),
        'from': opaque(val(block, 'From')),
        'to': addr_values(val(block, 'To')),
        'cc': addr_values(val(block, 'CC')),
        'bcc': addr_values(val(block, 'BCC')),
        'block': block,
    })
assert len(rows) == 3820
assert len({r['message'] for r in rows}) == 3820
threads = defaultdict(list)
for r in rows: threads[r['thread']].append(r)
assert len(threads) == 2810

# Only explicit exported ancestry fields count. Never infer from subject/chronology.
ancestry = {'messageIdPresent': 0, 'inReplyToPresent': 0, 'referencesPresent': 0,
            'parentCandidates': 0, 'referenceCandidates': 0, 'ambiguous': 0,
            'sameThread': 0, 'crossThread': 0, 'unmatched': 0}
ids = {r['message'] for r in rows}
for r in rows:
    b = r['block']
    msgid = re.search(r'(?im)^- \*\*(?:RFC )?Message[- ]ID:?\*\*\s*`?([^`\n]+)', b)
    irt = re.search(r'(?im)^- \*\*In[- ]Reply[- ]To:?\*\*\s*`?([^`\n]+)', b)
    refs = re.search(r'(?im)^- \*\*References:?\*\*\s*`?([^`\n]+)', b)
    ancestry['messageIdPresent'] += bool(msgid)
    ancestry['inReplyToPresent'] += bool(irt)
    ancestry['referencesPresent'] += bool(refs)
    # Export does not expose structured parent identity; retain explicit availability only.

# Identity/routing candidate aggregates; address values are opaque and no raw values emitted.
source_transport = Counter((r['from'], r['transport']) for r in rows if r['from'] and r['transport'])
transport_sources = defaultdict(set)
for (source, transport), n in source_transport.items(): transport_sources[transport].add(source)
identity = {
    'senderTransportPairs': len(source_transport),
    'opaqueSenderIdentities': len({r['from'] for r in rows if r['from']}),
    'opaqueTransportIds': len({r['transport'] for r in rows if r['transport']}),
    'manyToOneSenderTransportPairs': sum(1 for sources in transport_sources.values() if len(sources) > 1),
    'senderTransportPairRows': sum(source_transport.values()),
    'authorization': 'not_observed_in_export',
    'sendAs': 'not_observed_in_export',
    'employeeDirectory': 'not_observed_in_export',
}

# Deterministic overlays. These are candidates/signals, not authoritative joins.
def body(block): return block.lower()
patterns = {
    'attachment_or_document': r'attachment|attached|enclosed|invoice|voucher|pro.?forma|receipt|pdf',
    'payment_or_finance': r'payment|paid|deposit|refund|invoice|folio|remittance|bank.?slip|proof of payment',
    'integration_or_system': r'synxis|integration|pms|crs|channel|overbook|inventory|reservation.{0,20}fail',
    'security_or_quarantine': r'quarantine|phish|malware|virus|credential|suspicious|blocked|bounce|security',
}
overlays = {}
for name, pattern in patterns.items():
    overlays[name] = {
        'messageRows': sum(bool(re.search(pattern, r['block'], re.I | re.S)) for r in rows),
        'threadRows': sum(any(re.search(pattern, x['block'], re.I | re.S) for x in rs) for rs in threads.values()),
        'status': 'signal_only_unjoined',
    }

# Structural relationships available from export.
structural = {
    'messageThreadRows': len(rows),
    'uniqueMessageThreadPairs': len({(r['message'], r['thread']) for r in rows}),
    'uniqueThreadTransportPairs': len({(r['thread'], r['transport']) for r in rows}),
    'messageIdDuplicates': len(rows) - len({r['message'] for r in rows}),
    'threadCount': len(threads),
    'mixedDirectionThreads': sum(any(x['direction']=='inbound' for x in rs) and any(x['direction']=='outbound' for x in rs) for rs in threads.values()),
}

result = {
    'schemaVersion': 1,
    'analysisVersion': 'executed-reverse-joins-2026-08-30-v1',
    'status': 'private_read_only_candidate_joins',
    'snapshot': 'connected-mailbox-inbox-2026-08-30.md',
    'coverage': {'messages': len(rows), 'threads': len(threads), 'rawValuesEmitted': False},
    'structuralJoins': structural,
    'ancestryJoin': {**ancestry, 'status': 'unavailable_from_export_structured_fields', 'safeRule': 'no subject/chronology/sender inference'},
    'identityJoin': {**identity, 'status': 'partial_header_to_transport_candidate_only'},
    'mimeDocumentJoin': {'status': 'unavailable_from_export_normalized_parts', 'messageAttachmentRows': None, 'rawMimeRows': None, 'required': 'rehydrated raw MIME or DB attachment rows'},
    'outboundDeliveryJoin': {'status': 'local_provider_lifecycle_unavailable_from_export', 'outboundMessages': sum(r['direction']=='outbound' for r in rows), 'deliveryEvents': None, 'required': 'provider/DSN events'},
    'pmsFinanceJoin': {'status': 'candidate_text_only', 'required': 'read-only exact reference lookup plus event/settlement ID'},
    'securityJoin': {'status': 'local_signal_only', 'gatewayVerdicts': None, 'required': 'scanner verdict event keyed to message/part hash'},
    'overlays': overlays,
    'counterevidence': ['shared/delegated sender', 'forwarded/quoted text', 'replayed MIME', 'local sent is not provider delivered', 'claimed payment is not settlement', 'quarantine is not malware verdict'],
}
OUT.write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps({'status':'PASS','messages':len(rows),'threads':len(threads),'structuralPairs':structural['uniqueMessageThreadPairs'],'ancestryExplicitHeaders':ancestry['inReplyToPresent'] + ancestry['referencesPresent'],'identityPairs':identity['senderTransportPairs'],'artifacts':1}))
