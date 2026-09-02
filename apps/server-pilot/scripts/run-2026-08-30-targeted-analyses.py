from pathlib import Path
from collections import Counter, defaultdict
from hashlib import sha256
from datetime import datetime, timezone
import json, re

ROOT = Path('/home/ubuntu/projects/zero/.private/connected-mailbox-corpus')
SNAP = ROOT / 'connected-mailbox-inbox-2026-08-30.md'
OUT = ROOT / 'follow-up'
OUT.mkdir(parents=True, exist_ok=True)
text = SNAP.read_text(errors='replace').replace('\r\n', '\n')
blocks = re.split(r'(?m)^---\n', text)
messages = []
for b in blocks:
    if not re.search(r'(?m)^## Message \d+: ', b):
        continue
    def field(name):
        m = re.search(r'(?m)^- \*\*' + re.escape(name) + r':\*\* ?`?([^`\n]+)`?', b)
        return m.group(1).strip() if m else ''
    h = re.search(r'(?m)^## Message \d+: (.*)$', b)
    body = ''
    if '### Text body' in b:
        body = b.split('### Text body', 1)[1].split('### HTML body', 1)[0]
    messages.append({
        'id': field('Message ID'), 'thread': field('Thread ID'),
        'direction': field('Direction').lower(), 'received': field('Received'),
        'from': field('From').lower(), 'to': field('To').lower(),
        'cc': field('CC').lower(), 'bcc': field('BCC').lower(),
        'subject': h.group(1).strip() if h else '', 'body': body,
    })
assert len(messages) == 3820
assert len({m['id'] for m in messages}) == 3820
threads = defaultdict(list)
for m in messages: threads[m['thread']].append(m)
assert len(threads) == 2810

def hit(s, pat): return bool(re.search(pat, s, re.I | re.S))
def count_msgs(pred, direction=None):
    return sum(1 for m in messages if (direction is None or m['direction'] == direction) and pred(m))
def count_threads(pred): return sum(1 for ms in threads.values() if any(pred(m) for m in ms))

def addresses(m): return ' '.join((m[k] for k in ('from','to','cc','bcc')))
def bodytext(m): return m['subject'] + '\n' + m['body']

attachment = r'\b(attach(?:ed|ment|ments)?|enclos(?:ed|ure)|pdf|voucher|invoice|pro\s*forma|remittance|bank\s*slip|proof\s+of\s+payment|confirmation\s+letter)\b'
payment = r'\b(payment|paid|deposit|invoice|pro\s*forma|remittance|refund|chargeback|folio|commission|bank\s*(?:slip|transfer)|proof\s+of\s+payment|credit\s*card)\b'
integration = r'\b(failed?\s+to\s+integrate|not\s+integrated|integration|synxis|channel|pms|crs|reservation\s+failed|duplicate|overbook|inventory|availability\s+error|rate\s+error)\b'
security = r'\b(quarantine|spam|phish(?:ing)?|malware|virus|credential|suspicious|blocked|bounced?|security|impersonat|password|login)\b'
response = r'\b(thank|received|acknowledg|confirm(?:ed|ation)?|status|pending|will\s+|please\s+(?:find|see)|attached|follow\s*up|revert)\b'

# Physical direction / sequence facts.
outbound = [m for m in messages if m['direction'] == 'outbound']
inbound = [m for m in messages if m['direction'] == 'inbound']
thread_last = {t: ms[-1] for t, ms in threads.items()}
mixed = sum(any(x['direction']=='inbound' for x in ms) and any(x['direction']=='outbound' for x in ms) for ms in threads.values())
in_after_out = 0; out_after_in = 0
for ms in threads.values():
    seen_out = False; seen_in = False
    for m in ms:
        if m['direction']=='outbound':
            if seen_in: out_after_in += 1
            seen_out = True
        elif m['direction']=='inbound':
            if seen_out: in_after_out += 1
            seen_in = True

# Opaque actor inventory, plus explicitly named user-confirmed Penny source count.
actor_counts = Counter(m['from'] for m in messages if m['from'])
legacy = [m for m in messages if m['from'].endswith('@legacyhotels.co.za')]
legacy_actor = Counter(sha256(m['from'].encode()).hexdigest()[:16] for m in legacy)
penny = [m for m in inbound if m['from'] == 'pmbobo@legacyhotels.co.za']
legacy_out = [m for m in outbound if m['from'].endswith('@legacyhotels.co.za')]

# Semantic aggregate reuse: latest merged reviewed records, no raw content copied.
review = json.loads((ROOT/'thread-review/full-thread-census-2026-08-30.json').read_text())
review_rows = review['threads']
assert len(review_rows) == 2810
review_by_thread = {x['threadId']: x for x in review_rows}
assert set(review_by_thread) == set(threads)

def thread_intent(name): return sum(1 for x in review_rows if x['intentClass'] == name)

def thread_overlay(pattern): return sum(1 for ms in threads.values() if any(hit(bodytext(m), pattern) for m in ms))

def msg_overlay(pattern, direction=None): return sum(1 for m in messages if (direction is None or m['direction']==direction) and hit(bodytext(m), pattern))

analysis = {
  'schemaVersion': 1,
  'analysisVersion': 'latest-targeted-2026-08-30-v1',
  'status': 'private_read_only_planning',
  'corpusAsOf': '2026-08-30T21:53:48.208Z',
  'sourceSnapshot': 'connected-mailbox-inbox-2026-08-30.md',
  'method': 'full deterministic latest-snapshot scans plus reuse of validated 2810-thread semantic aggregate',
  'coverage': {'messages': len(messages), 'threads': len(threads), 'reviewRows': len(review_rows)},
  'direction': {'inboundMessages': len(inbound), 'outboundMessages': len(outbound), 'outboundThreads': sum(any(x['direction']=='outbound' for x in ms) for ms in threads.values()), 'mixedThreads': mixed, 'inboundAfterOutboundMessageTransitions': in_after_out, 'outboundAfterInboundMessageTransitions': out_after_in},
  'outbound': {'responseSurfaceSignals': sum(hit(bodytext(m), response) for m in outbound), 'signalMessages': msg_overlay(response, 'outbound'), 'signalThreads': sum(1 for ms in threads.values() if any(x['direction']=='outbound' and hit(bodytext(x), response) for x in ms)), 'caveat': 'overlapping lexical signals; not response, delivery, or completion'},
  'attachmentsDocuments': {'inboundMarkerMessages': msg_overlay(attachment, 'inbound'), 'inboundMarkerRateDenominator': len(inbound), 'allDirectionMarkerMessages': msg_overlay(attachment), 'markerThreads': thread_overlay(attachment), 'mimePartEvidence': 'unavailable_normalized_parts', 'caveat': 'markers/tokens are not unique files or delivery proof'},
  'paymentRevenueSignals': {'inboundMessages': msg_overlay(payment, 'inbound'), 'inboundThreads': sum(1 for ms in threads.values() if any(x['direction']=='inbound' and hit(bodytext(x), payment) for x in ms)), 'reviewedPaymentIntentThreads': thread_intent('payment_finance'), 'status': 'potential_exposure_review_signal_only'},
  'integrationSystemSignals': {'inboundMessages': msg_overlay(integration, 'inbound'), 'inboundThreads': sum(1 for ms in threads.values() if any(x['direction']=='inbound' and hit(bodytext(x), integration) for x in ms)), 'reviewedIntentThreads': thread_intent('vendor_b2b'), 'status': 'candidate_unknown_until_authoritative_event_join'},
  'securitySignals': {'inboundMessages': msg_overlay(security, 'inbound'), 'inboundThreads': sum(1 for ms in threads.values() if any(x['direction']=='inbound' and hit(bodytext(x), security) for x in ms)), 'status': 'signal_verdict_unavailable'},
  'actorRole': {'legacyFromMessages': len(legacy), 'legacyInboundFromMessages': sum(x['direction']=='inbound' for x in legacy), 'legacyOutboundFromMessages': len(legacy_out), 'legacyThreads': len({x['thread'] for x in legacy}), 'opaqueLegacyActorCount': len(legacy_actor), 'pennyInboundFromMessages': len(penny), 'pennyTransportInterpretation': 'source identity inside Centurion-routed corpus; not separate send transport', 'identityStatus': 'shared_or_delegated_unknown_without_directory_or_send_as_join'},
  'semanticReuse': {'deltaReviewedThreads': 446, 'unchangedCachedThreads': 1957, 'humanLockThreads': review['totals']['humanLockCount'], 'lowConfidenceThreads': review['totals']['lowConfidenceCount'], 'toolHitlRows': review['totals']['toolHitlCount']},
  'limits': ['no authoritative case/obligation spine', 'no PMS/CRS/SynXis event join', 'no finance settlement join', 'no outbound provider lifecycle', 'no normalized MIME/document parts', 'no security gateway verdict join', 'no employee/directory/alias authorization join'],
}
(OUT/'targeted-analyses-2026-08-30.json').write_text(json.dumps(analysis, indent=2)+'\n')

contract = {
  'schemaVersion': 1, 'contractVersion': 'zero-mail-analysis-contract-2026-08-30-v1', 'status': 'private_read_only_planning', 'corpusAsOf': analysis['corpusAsOf'], 'sourceSnapshot': analysis['sourceSnapshot'],
  'units': ['message','thread','event','case','tool_demand','part','document'],
  'evidenceTiers': ['observed_local','derived_planning_estimate','historical_learning','external_semantics_only','authoritative_join','unknown'],
  'confidence': ['high','medium','low','unknown'],
  'joinStatus': ['verified','partial','missing','stale','conflict'],
  'unknownRule': 'missing, stale, conflicting, quoted, unreadable, or unjoined evidence stays unknown and human-reviewed; never coerced to zero, low-risk, resolved, delivered, or complete',
  'overlapRule': 'primary display queue may be mutually exclusive by precedence; exception/source/actor/document/security/payment overlays are multi-label and non-additive',
  'primaryAxes': {'internalUrgency':['critical','high','standard','low','unknown'],'externalRequest':['yes','no','unknown'],'potentialRevenueExposure':['high','medium','low','none','unknown'],'humanLock':['true','false']},
  'provenanceRequired': ['measureId','unit','scope','signatureVersion','precedence','overlapPolicy','evidenceTier','denominatorReconciliation','corpusAsOf','artifactGeneratedAt','sourceSnapshot','analysisVersion','status'],
  'schemaAliases': {'intentClass.booking_change':'booking_modify','intentClass.cancellation':'booking_cancel','intentClass.feedback_review':'other','route.human_lock':'at-risk','aggregate.routeSlug':'result.proposedTriageRoute.slug','aggregate.humanLockRequired':'result.humanLock.required'},
  'unsafeInferences': ['outbound_is_response','attachment_marker_is_file','potential_exposure_is_realized_revenue','resolved_is_current_closure','domain_is_employee_identity','routing_header_is_verified_BCC_truth'],
}
(OUT/'canonical-data-contract-2026-08-30.json').write_text(json.dumps(contract, indent=2)+'\n')

spine = {
  'schemaVersion': 1, 'spineVersion': 'mailbox-thread-identity-spine-2026-08-30-v1', 'status': 'private_read_only_planning', 'corpusAsOf': analysis['corpusAsOf'], 'sourceSnapshot': analysis['sourceSnapshot'],
  'coverage': {'messages': len(messages), 'uniqueMessageIds': len({m['id'] for m in messages}), 'threads': len(threads), 'reviewRows': len(review_rows), 'reviewIdEquality': True},
  'messageFieldsObserved': ['message_key_opaque','thread_key_opaque','physical_direction','received_timestamp','from_header','to_header','cc_header','bcc_header','subject_source_private','text_body_source_private','ingest_transport_source_private'],
  'threadFieldsObserved': ['thread_key_opaque','message_count','first_received','last_received','inbound_count','outbound_count','mixed_direction','ancestry_available_as_exported'],
  'identityJoinStatus': {'mailboxTransport':'partial_observed_active_transports','senderIdentity':'observed_header_only','PennyMbobo':'observed_from_header_and_user_confirmed_role; no directory/Send-As proof','employeeRole':'missing','aliasMembership':'missing','delegationSendAs':'missing','recipientAuthorization':'missing'},
  'ancestryJoinStatus': {'threadGrouping':'verified_by_exported_thread_id','reply_parent':'missing_or_not_normalized','quotedForwardedSegmentation':'not_separately_established','sameCaseBusinessObject':'missing','dedupe':'message_id_unique_in_snapshot_only'},
  'authoritativeJoinsMissing': ['case_obligation_owner_state','pms_crs_synxis_event_state','payment_finance_settlement','outbound_provider_delivery','mime_document_parts','security_gateway_verdict'],
  'routingHeaderPolicy':'optional corroboration only; do not use X-Zero-Mailbox as primary inbound-BCC metric until mail-server generation/semantics verified',
}
(OUT/'mailbox-thread-identity-spine-2026-08-30.json').write_text(json.dumps(spine, indent=2)+'\n')

report = f'''# Latest corpus targeted analysis — 2026-08-30\n\nStatus: private read-only planning. Snapshot: `{analysis["corpusAsOf"]}`.\n\n## Coverage\n\n- {len(messages)} messages / {len(threads)} threads / {len(inbound)} inbound / {len(outbound)} outbound.\n- Validated semantic aggregate reused: 2,810/2,810 thread rows.\n- Delta semantic review: 446 threads; unchanged cached: 1,957.\n\n## Targeted passes\n\nFull deterministic scans rerun for outbound, attachments/documents, actor/role, payment, integration/system, and security. Latest semantic labels reused; no blind full semantic reread. Penny source counted separately as a known sender identity, while employee/authorization claims remain unknown.\n\n## Evidence boundary\n\nAll lexical family counts are overlapping planning signals. Attachment markers do not establish MIME parts/files. Payment signals indicate potential exposure only. Integration/security signals remain unknown until authoritative event/gateway joins. Outbound signals do not prove response, delivery, or completion.\n\n## Required next joins\n\nMailbox/thread/ancestry and identity spine is documented separately. Missing: governed alias/employee/Send-As directory, case/obligation/owner state, PMS/CRS/SynXis events, finance settlement, outbound provider lifecycle, normalized MIME/document parts, and security gateway verdicts.\n'''
(OUT/'analysis-loop-14-2026-08-30.md').write_text(report)
print(json.dumps({'status':'PASS','messages':len(messages),'threads':len(threads),'inbound':len(inbound),'outbound':len(outbound),'artifacts':4,'pennyInbound':len(penny),'legacyFromMessages':len(legacy)}))
