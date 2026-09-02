from collections import Counter, defaultdict
from pathlib import Path
import json
import re

ROOT = Path('/home/ubuntu/projects/zero/.private/connected-mailbox-corpus')
SNAP = ROOT / 'connected-mailbox-inbox-2026-08-30.md'
CENSUS = ROOT / 'thread-review/full-thread-census-2026-08-30.json'
OUT = ROOT / 'follow-up/commercial-kpi-deep-analysis-2026-08-31.json'

text = SNAP.read_text(errors='replace').replace('\r\n', '\n')
blocks = re.split(r'(?m)^---\n', text)
keys = ['Message ID', 'Thread ID', 'Transport ID', 'Direction', 'From', 'To', 'CC', 'BCC', 'Received', 'Sent', 'Created']

def field(block, key):
    m = re.search(r'(?m)^- \*\*' + re.escape(key) + r':\*\*\s*`?([^`\n]*)', block)
    return m.group(1).strip() if m else ''

rows = []
for block in blocks:
    if not re.search(r'(?m)^## Message \d+: ', block):
        continue
    row = {k: field(block, k) for k in keys}
    row['body'] = block
    rows.append(row)
assert len(rows) == 3820
assert len({r['Message ID'] for r in rows}) == 3820
by_thread = defaultdict(list)
for r in rows:
    by_thread[r['Thread ID']].append(r)
assert len(by_thread) == 2810
census = json.loads(CENSUS.read_text())
review = {r['threadId']: r for r in census['threads']}
assert set(review) == set(by_thread)

# Conservative signatures. These are planning classifications, not gold labels.
auto_re = re.compile(r'automated e.?mail|do not reply|system generated|notification|night audit|mailer|cron|confirmation number|reservation confirmation|security digest|quarantine digest|delivery report|mailer daemon|nondelivery', re.I)
exception_re = re.compile(r'failed|failure|error|declin|unpaid|overdue|refund|chargeback|cancel|no.?show|wrong recipient|bounce|undeliver|urgent|same.?day|arrival|check.?in|overbook|inventory|missing|dispute|complaint|security|credential|suspicious|blocked', re.I)
commercial_re = re.compile(r'booking|reservation|quote|rate|availability|room|stay|payment|deposit|invoice|folio|refund|cancel|no.?show|group|event|rooming list|government|public sector', re.I)
quote_re = re.compile(r'quote|quotation|rate|availability|proposal|tariff|pricing', re.I)
book_re = re.compile(r'booking|booked|reservation|confirmed|confirmation|stay', re.I)

# Transport grouping only; no employee identity inference.
def is_centurion_transport(r):
    return 'centurion' in (r['Transport ID'] or '').lower()

def is_centurion_from(r):
    # Exact mailbox identity is counted privately; never emit the address.
    return bool(re.search(r'(^|[<\s])centurion(?:@|[>\s])', (r['From'] or '').strip(), re.I))

def thread_features(tid, rs, rr):
    body = '\n'.join(r['body'] for r in rs)
    inbound = [r for r in rs if r['Direction'].lower() == 'inbound']
    outbound = [r for r in rs if r['Direction'].lower() == 'outbound']
    has_auto = bool(auto_re.search(body))
    has_exception = bool(exception_re.search(body))
    # Pms facts are generalized semantic annotations; use them only as supporting context.
    facts = ' '.join(rr.get('pmsFacts') or [])
    has_quote = bool(quote_re.search(body + '\n' + facts))
    has_booking = bool(book_re.search(body + '\n' + facts))
    cent_in = sum(is_centurion_transport(r) for r in inbound)
    cent_out = sum(is_centurion_transport(r) for r in outbound)
    exact_in = sum(is_centurion_from(r) for r in inbound)
    exact_out = sum(is_centurion_from(r) for r in outbound)
    return {
        'messages': len(rs), 'inbound': len(inbound), 'outbound': len(outbound),
        'has_auto_marker': has_auto, 'has_exception_marker': has_exception,
        'candidate_routine_automated': has_auto and not has_exception,
        'candidate_automated_action_required': has_auto and has_exception,
        'centurion_transport_inbound': cent_in > 0,
        'centurion_transport_outbound': cent_out > 0,
        'centurion_transport_inbound_messages': cent_in,
        'centurion_transport_outbound_messages': cent_out,
        'exact_centurion_from_inbound_messages': exact_in,
        'exact_centurion_from_outbound_messages': exact_out,
        'exact_centurion_from_inbound': exact_in > 0,
        'exact_centurion_from_outbound': exact_out > 0,
        'has_quote_signal': has_quote, 'has_booking_signal': has_booking,
        'quote_and_booking_signal': has_quote and has_booking,
        'quote_then_outbound': any(r['Direction'].lower() == 'outbound' for r in rs if quote_re.search(r['body'])),
        'outbound_after_quote_signal': False,
    }

features = {}
for tid, rs in by_thread.items():
    rs_sorted = sorted(rs, key=lambda r: (r['Received'], r['Sent'], r['Created'], r['Message ID']))
    f = thread_features(tid, rs_sorted, review[tid])
    seen_quote = False
    for r in rs_sorted:
        if quote_re.search(r['body']): seen_quote = True
        if seen_quote and r['Direction'].lower() == 'outbound': f['outbound_after_quote_signal'] = True
    features[tid] = f

intent_order = ['booking_new','quote_request','group_event','booking_cancel','booking_modify','payment_finance']
summary = {}
for intent in intent_order:
    tids = [tid for tid, rr in review.items() if rr.get('intentClass') == intent]
    def count(pred): return sum(pred(tid, review[tid], features[tid]) for tid in tids)
    summary[intent] = {
        'threads': len(tids),
        'routine_automated_candidate': count(lambda t,r,f: f['candidate_routine_automated']),
        'automated_exception_action_candidate': count(lambda t,r,f: f['candidate_automated_action_required']),
        'automated_marker_any': count(lambda t,r,f: f['has_auto_marker']),
        'human_lock': sum(bool(review[t]['humanLockRequired']) for t in tids),
        'tool_demand_rows': sum(len(review[t].get('toolDemand') or []) for t in tids),
        'resolved_route': sum(review[t].get('routeSlug') == 'resolved' for t in tids),
        'spam_route': sum(review[t].get('routeSlug') == 'spam' for t in tids),
        'centurion_transport_inbound': count(lambda t,r,f: f['centurion_transport_inbound']),
        'centurion_transport_outbound': count(lambda t,r,f: f['centurion_transport_outbound']),
        'centurion_transport_outbound_after_inbound_candidate': count(lambda t,r,f: f['centurion_transport_outbound'] and f['inbound'] > 0),
        'exact_centurion_from_inbound': count(lambda t,r,f: f['exact_centurion_from_inbound']),
        'exact_centurion_from_outbound': count(lambda t,r,f: f['exact_centurion_from_outbound']),
        'exact_centurion_from_action_candidate': count(lambda t,r,f: f['exact_centurion_from_inbound'] and (r.get('intentClass') not in {'spam_noise','internal_test'} or r.get('humanLockRequired') or bool(r.get('toolDemand')))),
        'quote_signal': count(lambda t,r,f: f['has_quote_signal']),
        'booking_signal': count(lambda t,r,f: f['has_booking_signal']),
        'quote_and_booking_signal': count(lambda t,r,f: f['quote_and_booking_signal']),
        'quote_then_outbound_candidate': count(lambda t,r,f: f['outbound_after_quote_signal']),
    }

# Quote conversion candidates: canonical quote intent that later has booking language in same thread,
# plus booking_new threads containing quote language. No PMS conversion claim.
quote_tids = [tid for tid, rr in review.items() if rr.get('intentClass') == 'quote_request']
booking_tids = [tid for tid, rr in review.items() if rr.get('intentClass') == 'booking_new']
quote_candidates = {
    'quote_intent_threads': len(quote_tids),
    'quote_intent_with_booking_language_same_thread': sum(features[t]['has_booking_signal'] for t in quote_tids),
    'quote_intent_with_outbound_after_quote_candidate': sum(features[t]['outbound_after_quote_signal'] for t in quote_tids),
    'booking_intent_with_quote_language_same_thread': sum(features[t]['has_quote_signal'] for t in booking_tids),
    'booking_intent_with_quote_and_outbound_candidate': sum(features[t]['has_quote_signal'] and features[t]['outbound'] > 0 for t in booking_tids),
    'non_conversion_reasons_available': False,
    'reason_proxies': {
        'payment_or_deposit': sum(bool(re.search(r'payment|deposit|unpaid|overdue|invoice|refund', ' '.join(review[t].get('pmsFacts') or []), re.I)) for t in quote_tids),
        'availability_or_rate': sum(bool(re.search(r'availability|rate|price|quote|room', ' '.join(review[t].get('pmsFacts') or []), re.I)) for t in quote_tids),
        'cancellation_or_change': sum(bool(re.search(r'cancel|change|amend|modify', ' '.join(review[t].get('pmsFacts') or []), re.I)) for t in quote_tids),
        'missing_authoritative_state': len(quote_tids),
    },
    'reason_proxy_overlap': True,
    'reason_proxy_method': 'pmsFacts lexical screening within canonical quote_request threads; all reasons overlap and are not adjudicated non-conversion reasons',
    'interpretation': 'candidate lexical/thread linkage only; not quote conversion, booking completion, or causal reason',
}

# Whole corpus automation planning partition using conservative signature, plus route/lock overlays.
all_tids = list(review)
whole = {
    'threads': len(all_tids),
    'routine_automated_candidate': sum(features[t]['candidate_routine_automated'] for t in all_tids),
    'automated_exception_action_candidate': sum(features[t]['candidate_automated_action_required'] for t in all_tids),
    'automated_marker_any': sum(features[t]['has_auto_marker'] for t in all_tids),
    'no_action_candidate_strict': sum((review[t].get('intentClass') in {'spam_noise','internal_test'} and not review[t].get('humanLockRequired') and not (review[t].get('toolDemand') or [])) for t in all_tids),
    'candidate_action_required': sum((review[t].get('intentClass') not in {'spam_noise','internal_test'} or review[t].get('humanLockRequired') or bool(review[t].get('toolDemand'))) for t in all_tids),
    'centurion_transport_inbound_messages': sum(features[t]['centurion_transport_inbound_messages'] for t in all_tids),
    'centurion_transport_outbound_messages': sum(features[t]['centurion_transport_outbound_messages'] for t in all_tids),
    'centurion_transport_inbound_threads': sum(features[t]['centurion_transport_inbound'] for t in all_tids),
    'centurion_transport_outbound_threads': sum(features[t]['centurion_transport_outbound'] for t in all_tids),
    'centurion_transport_action_candidate_threads': sum(features[t]['centurion_transport_inbound'] and (review[t].get('intentClass') not in {'spam_noise','internal_test'} or review[t].get('humanLockRequired') or bool(review[t].get('toolDemand'))) for t in all_tids),
    'exact_centurion_from_inbound_messages': sum(features[t]['exact_centurion_from_inbound_messages'] for t in all_tids),
    'exact_centurion_from_outbound_messages': sum(features[t]['exact_centurion_from_outbound_messages'] for t in all_tids),
    'exact_centurion_from_inbound_threads': sum(features[t]['exact_centurion_from_inbound'] for t in all_tids),
    'exact_centurion_from_outbound_threads': sum(features[t]['exact_centurion_from_outbound'] for t in all_tids),
    'exact_centurion_from_action_candidate_threads': sum(features[t]['exact_centurion_from_inbound'] and (review[t].get('intentClass') not in {'spam_noise','internal_test'} or review[t].get('humanLockRequired') or bool(review[t].get('toolDemand'))) for t in all_tids),
    'interpretation': 'Transport ID is a mailbox/application grouping candidate, not proof of Centurion employee authorship or accountability.'
}

result = {
    'schemaVersion': 1,
    'analysisVersion': 'commercial-kpi-deep-analysis-2026-08-31-v1',
    'status': 'private_read_only_planning',
    'sourceSnapshot': 'connected-mailbox-inbox-2026-08-30.md',
    'coverage': {'messages': len(rows), 'threads': len(by_thread), 'reviewRows': len(review)},
    'automation_definition': 'Conservative lexical automated marker plus reviewed route/lock/tool overlays; no gold sender/source classification exists.',
    'whole_corpus': whole,
    'commercial_intents': summary,
    'quote_conversion_candidates': quote_candidates,
    'blocked_outcome_kpis': ['realized revenue', 'quote-to-book conversion', 'lost/recovered amount', 'cancellation loss', 'Centurion-attributed action', 'delivery-adjusted response', 'automated no-action gold rate'],
    'required_joins': ['source/MIME or provider automation identity', 'case/obligation/owner', 'employee/alias/Send-As authorization', 'quote/reservation/PMS event', 'finance settlement', 'outbound provider lifecycle', 'cancellation/no-show reason and policy outcome'],
}
OUT.write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps({'status':'PASS','messages':len(rows),'threads':len(by_thread),'commercial_intents':summary,'whole_corpus':whole,'quote_conversion_candidates':quote_candidates}, separators=(',',':')))
