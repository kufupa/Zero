#!/usr/bin/env python3
"""Replay pane inputs and score them later, without sending or saving.

replay inputs: JSONL {id, input_cutoff, eligibility, thread}; thread is the
full, exact pane POST body for a synced source. Export it through the authorized
pane, including all conversation messages; the gateway independently checks it.
For B/C eligibility is human_inbound, ota, automated, internal, or unknown.
Tier C uses historical model-only inputs and requires gateway support.
For C, legacy model-safe JSONL rows can be used with --historical-mailbox-id;
add eligibility to each row. Rows with PDF metadata need an available attachment.

score labels: JSONL {id, workflow, source, fields, labtest?}. Each field is
{path, value, observed_at, evidence, basis, target: "real"}; path is a JSON pointer into the
matching proposal. basis is staff_outbound or hms, never Labtest; observed_at
must be later than input_cutoff. Each label has identity {target: "real",
confirmation, evidence} or {target: "real", stay_id, match_evidence},
independently matching the real stay. Triage does not
require a stay. A write-workflow labtest is {kind: "labtest_save_readback",
completed: true|false, evidence, guest: "Proof Labtest", arrival_date, cms: false,
wall_ms?: number}; it is a separately labelled terminal Save + readback outcome,
never inferred from real-guest Prepare. Identifiers must be opaque case IDs.
For triage, /classified_workflows compares the sorted proposed workflow names.

prices: JSON {model, input, output, cache_read, cache_write, long_context_above,
long_input, long_output, long_cache_read, long_cache_write}; USD per million.
Omit prices when current rates are not established.
"""
import argparse
import concurrent.futures
import datetime as dt
import hashlib
import json
import os
import pathlib
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from collections import Counter

WORKFLOWS = ('triage', 'quote', 'create', 'amend', 'cancel', 'filing')
WRITES = {'create', 'amend', 'cancel', 'filing'}


def rows(path):
    with open(path, encoding='utf-8') as f:
        return [json.loads(line) for line in f if line.strip()]


def timestamp(s):
    value = dt.datetime.fromisoformat(s.replace('Z', '+00:00'))
    if value.tzinfo is None:
        raise ValueError('timestamp needs a timezone')
    return value.timestamp()


def save_private(path, value):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w', encoding='utf-8') as f:
        json.dump(value, f, ensure_ascii=False, separators=(',', ':'))
        f.write('\n')


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


class Gateway:
    def __init__(self, origin, cookie, browser_origin, timeout):
        url = urllib.parse.urlsplit(origin)
        if (url.scheme not in ('http', 'https') or not url.hostname or url.username or url.password
                or url.path not in ('', '/') or url.query or url.fragment
                or (url.scheme == 'http' and url.hostname not in ('localhost', '127.0.0.1', '::1'))):
            raise ValueError('gateway must be HTTPS origin or loopback test origin')
        self.base = origin.rstrip('/') + '/api/nava/v1'
        self.headers = {'Cookie': cookie.strip(), 'Origin': browser_origin, 'Accept': 'application/json'}
        self.timeout = timeout
        self.opener = urllib.request.build_opener(NoRedirect())

    def request(self, path, body=None, headers=None):
        data = None if body is None else json.dumps(body, ensure_ascii=False, separators=(',', ':')).encode()
        h = dict(self.headers)
        h.update(headers or {})
        if data is not None:
            h['Content-Type'] = 'application/json'
        req = urllib.request.Request(self.base + path, data=data, headers=h)
        try:
            return self.opener.open(req, timeout=self.timeout)
        except urllib.error.HTTPError as e:
            e.close()
            raise RuntimeError('http_' + str(e.code)) from None

    def json(self, path, body=None, headers=None):
        with self.request(path, body, headers) as res:
            return json.load(res)


def quote_id(proposal):
    for action in proposal.get('actions', []):
        details = action.get('details')
        if action.get('type') == 'quote' and isinstance(details, dict) and details.get('quote_id'):
            return details['quote_id']
    return None


def terminal_stage(p):
    return p.get('phase') not in ('staging',) and (p.get('stage') is not None or p.get('error') is not None)


def historical_thread(case, mailbox):
    selected = case['selected_message']
    events = case['earlier_relevant_source_events']
    if selected.get('pdfs') or any(event.get('pdfs') for event in events):
        raise ValueError('historical_attachment_unavailable')

    def email(message):
        addresses = message['addresses']
        def address(value):
            return {'name': None, 'email': value}
        return {'id': message['message_id'], 'rfc_message_id': None, 'direction': message['direction'],
                'from': address(addresses['from'][0]), 'to': [address(v) for v in addresses['to']],
                'cc': [address(v) for v in addresses['cc']], 'received_at': message['timestamp'],
                'subject': message['subject'], 'body_text': message['body'], 'body_html': None, 'attachments': []}
    return {'source': 'eval', 'source_thread_id': 'nava-eval:' + hashlib.sha256(case['id'].encode()).hexdigest(),
            'mailbox_id': mailbox, 'selected_message_id': selected['message_id'], 'property_code': None,
            'mode': 'historical', 'decision_id': case['id'], 'input_cutoff': case['input_cutoff'],
            'messages': [email(e['message']) for e in events] + [email(selected)]}


def run_case(gateway, case, prepare, timeout, quote_first=False, tier='A', historical_mailbox=None):
    result = {'id': case['id'], 'input_cutoff': case['input_cutoff'], 'status': 'unknown',
              'tier': tier, 'reason': None, 'wall_ms': None, 'proposals': [], 'events': [], 'prepare': []}
    monotonic = time.monotonic()
    try:
        cutoff = timestamp(case['input_cutoff'])
        if tier in ('B', 'C') and case.get('eligibility') != 'human_inbound':
            result.update(status='excluded', reason='eligibility_' + (case.get('eligibility') if case.get('eligibility') in ('ota', 'automated', 'internal') else 'unknown'))
            return result
        thread = case.get('thread')
        if tier == 'C' and thread is None:
            if not historical_mailbox:
                raise ValueError('historical_mailbox_required')
            thread = historical_thread(case, historical_mailbox)
        messages = thread['messages']
        if tier == 'C':
            if thread.get('mode') != 'historical' or thread.get('source') not in ('eval', 'corpus'):
                raise ValueError('historical_source_required')
            prepare = False
        elif thread.get('mode') != 'live' or thread.get('source') not in ('outlook', 'webmail'):
            raise ValueError('pane_live_source_required')
        if not messages or any(timestamp(m['received_at']) > cutoff for m in messages):
            raise ValueError('conversation_after_cutoff')
        selected = [m for m in messages if m['id'] == thread['selected_message_id']]
        if len(selected) != 1 or selected[0]['direction'] != 'inbound':
            raise ValueError('selected_inbound_missing')
        if tier == 'C' and not time.time() - 30 * 86400 <= timestamp(selected[0]['received_at']) <= time.time():
            result.update(status='excluded', reason='outside_last_30_days')
            return result
        payload = json.dumps(thread, ensure_ascii=False, separators=(',', ':')).encode()
        with gateway.request('/threads', thread, {'Idempotency-Key': hashlib.sha256(payload).hexdigest()}) as response:
            status = response.status
            snap = json.load(response)
        result['wall_ms'] = round((time.monotonic() - monotonic) * 1000)
        if status != 201:
            raise ValueError('existing_session_not_fresh')
        if not snap.get('session'):
            result.update(status='complete', reason='filtered', proposals=[{'workflow': 'triage', 'disposition': 'skip'}], cost_reason='filtered_no_model')
            return result
        if snap['session'].get('mode') != ('historical' if tier == 'C' else 'live'):
            raise ValueError('session_mode_mismatch')
        path = '/threads/' + urllib.parse.quote(snap['id'], safe='')
        selected_id = thread['selected_message_id']
        deadline = time.monotonic() + timeout
        # Start at zero to capture calls that finished before POST returned.
        # A 201 is a new thread, and mail_pending identifies its selected turn.
        found = False
        finished = False
        with gateway.request(path + '/events?after_sequence=0', headers={'Accept': 'text/event-stream', 'Last-Event-ID': '0'}) as stream:
            data = []
            while time.monotonic() < deadline:
                raw = stream.readline()
                if not raw:
                    break
                line = raw.decode('utf-8').rstrip('\r\n')
                if line.startswith('data:'):
                    data.append(line[5:].lstrip(' '))
                elif not line and data:
                    event = json.loads('\n'.join(data))
                    data = []
                    p = event.get('payload') or {}
                    if event.get('kind') == 'mail_pending' and p.get('message_id') == selected_id:
                        found = True
                        result['events'] = []
                    if found:
                        if event.get('kind') == 'model_call':
                            result['events'].append({'kind': 'model_call', 'payload': {k: p.get(k) for k in (
                                'attempt_id', 'status', 'input_tokens', 'output_tokens', 'cache_read_input_tokens',
                                'cache_creation_input_tokens', 'metadata')}})
                        if event.get('kind') == 'turn_finished':
                            finished = True
                            break
        result['wall_ms'] = round((time.monotonic() - monotonic) * 1000)
        if not found:
            raise ValueError('fresh_mail_event_not_observed')
        if not finished:
            raise ValueError('turn_not_finished')
        snap = gateway.json(path)
        if snap.get('selected_message_id') != selected_id:
            raise ValueError('selected_mail_changed')
        result['proposals'] = [p for p in snap.get('proposals', [])
                               if p.get('source_message_id') in (None, selected_id)]
        result['status'] = 'complete'
        if prepare:
            for p in result['proposals']:
                workflow = p.get('workflow')
                if workflow not in WRITES | {'quote'} or p.get('phase') != 'ready' or p.get('disposition') != 'propose':
                    continue
                op = 'quote' if workflow == 'quote' else 'stage'
                body = {'expected_revision': p['revision']}
                if op == 'quote':
                    qid = quote_id(p)
                    if not qid:
                        result['prepare'].append({'workflow': workflow, 'status': 'unknown', 'reason': 'quote_id_missing'})
                        continue
                    body.update(quote_id=qid, idempotency_key=str(uuid.uuid4()))
                entry = {'workflow': workflow, 'proposal_id': p['id'], 'status': 'unknown', 'reason': None, 'wall_ms': None}
                result['prepare'].append(entry)
                pstart = time.monotonic()
                try:
                    # Dispatch exactly once. An uncertain response is recorded, never retried.
                    gateway.json('/proposals/' + urllib.parse.quote(p['id'], safe='') + '/' + op, body)
                    while time.monotonic() - pstart < timeout:
                        current = gateway.json(path)
                        item = next((x for x in current.get('proposals', []) if x['id'] == p['id']), None)
                        if item and terminal_stage(item):
                            entry['status'] = 'complete' if item.get('stage') and not item.get('error') else 'failed'
                            entry['reason'] = None if entry['status'] == 'complete' else 'operation_error'
                            entry['stage'] = item.get('stage')
                            entry['reply_draft_present'] = bool(item.get('reply_draft'))
                            if op == 'quote' and entry['status'] == 'complete' and quote_first:
                                options = (item.get('stage') or {}).get('quote_options') or []
                                selections = {}
                                for option in options:
                                    key = (option['group_id'], option['room_id'])
                                    selections.setdefault(key, {k: option[k] for k in ('group_id', 'room_id', 'option_index')})
                                if selections:
                                    try:
                                        gateway.json('/proposals/' + urllib.parse.quote(p['id'], safe='') + '/quote-artifacts', {
                                            'expected_revision': p['revision'], 'quote_id': qid, 'selections': list(selections.values())})
                                        updated = gateway.json(path)
                                        item = next(x for x in updated['proposals'] if x['id'] == p['id'])
                                        entry['stage'] = item.get('stage')
                                        entry['artifacts'] = 'created'
                                    except Exception:
                                        entry['artifacts'] = 'unknown'
                                        entry['artifact_reason'] = 'artifact_dispatch_or_read_unknown'
                                else:
                                    entry['artifacts'] = 'unknown'
                                    entry['artifact_reason'] = 'quote_options_missing'
                            break
                        time.sleep(1)
                    else:
                        entry['reason'] = 'operation_timeout'
                except Exception as exc:
                    entry['reason'] = str(exc) if isinstance(exc, RuntimeError) else 'operation_dispatch_or_read_unknown'
                entry['wall_ms'] = round((time.monotonic() - pstart) * 1000)
                entry['elapsed_from_post_ms'] = round((time.monotonic() - monotonic) * 1000)
    except Exception as exc:
        known = {'pane_live_source_required', 'historical_source_required', 'historical_mailbox_required', 'historical_attachment_unavailable',
                 'conversation_after_cutoff', 'selected_inbound_missing', 'existing_session_not_fresh',
                 'session_mode_mismatch', 'fresh_mail_event_not_observed', 'turn_not_finished', 'selected_mail_changed'}
        result['reason'] = str(exc) if isinstance(exc, RuntimeError) or str(exc) in known else 'request_or_stream_error'
        result['wall_ms'] = round((time.monotonic() - monotonic) * 1000)
    return result


def model_cost(result, prices):
    if result.get('status') != 'complete':
        return None, result.get('reason') or 'replay_unknown'
    if result.get('cost_reason') == 'filtered_no_model':
        return 0, None
    if result.get('cost_reason'):
        return None, result['cost_reason']
    if not prices:
        return None, 'pricing_not_supplied'
    calls = {}
    for e in result.get('events', []):
        p = e['payload']
        if not p.get('attempt_id'):
            return None, 'model_attempt_id_missing'
        calls.setdefault(p['attempt_id'], []).append(p)
    if not calls:
        return None, 'model_events_missing'
    total = 0
    for group in calls.values():
        done = [p for p in group if p.get('status') in ('success', 'error')]
        if len(done) != 1:
            return None, 'model_attempt_incomplete'
        p = done[0]
        if (p.get('metadata') or {}).get('model') != prices.get('model') or 'haiku' not in str(prices.get('model', '')).lower():
            return None, 'model_pricing_mismatch'
        if type(p.get('input_tokens')) is not int or type(p.get('output_tokens')) is not int:
            return None, 'model_usage_or_price_missing'
        threshold = prices.get('long_context_above')
        if type(threshold) is not int or threshold < 0:
            return None, 'long_context_threshold_missing'
        cached = [p.get('cache_read_input_tokens') or 0, p.get('cache_creation_input_tokens') or 0]
        if any(type(v) is not int or v < 0 for v in cached):
            return None, 'model_usage_or_price_missing'
        context = p['input_tokens'] + sum(cached)
        prefix = 'long_' if context > threshold else ''
        for token, rate in (('input_tokens', 'input'), ('output_tokens', 'output'),
                            ('cache_read_input_tokens', 'cache_read'), ('cache_creation_input_tokens', 'cache_write')):
            v = p.get(token)
            if v is None and token.startswith('cache_'):
                v = 0
            rate = prefix + rate
            if type(v) is not int or v < 0:
                return None, 'model_usage_or_price_missing'
            if v:
                if type(prices.get(rate)) not in (int, float) or prices[rate] < 0:
                    return None, 'model_usage_or_price_missing'
                total += v * prices[rate] / 1_000_000
    return total, None


def pointer(value, path):
    if not isinstance(path, str) or not path.startswith('/'):
        return False, None
    try:
        for part in path[1:].split('/'):
            part = part.replace('~1', '/').replace('~0', '~')
            value = value[int(part)] if isinstance(value, list) else value[part]
        return True, value
    except (KeyError, IndexError, ValueError, TypeError):
        return False, None


def same(a, b):
    if isinstance(a, str) and isinstance(b, str):
        return ' '.join(a.casefold().split()) == ' '.join(b.casefold().split())
    return type(a) is type(b) and a == b


def percentile(values, p):
    if not values:
        return None
    values = sorted(values)
    pos = (len(values) - 1) * p
    lo = int(pos)
    return round(values[lo] + (values[min(lo + 1, len(values) - 1)] - values[lo]) * (pos - lo), 2)


def real_identity(label):
    identity = label.get('identity') or {}
    labtest = label.get('labtest') or {}
    if identity.get('target') != 'real' or identity.get('guest') == 'Proof Labtest':
        return False
    if any(identity.get(k) and identity.get(k) == labtest.get(k) for k in ('confirmation', 'stay_id')):
        return False
    return bool((identity.get('confirmation') and identity.get('evidence')) or
                (identity.get('stay_id') and identity.get('match_evidence')))


def labtest_label(label):
    evidence = label.get('labtest') or {}
    try:
        year = dt.date.fromisoformat(evidence.get('arrival_date', '')).year
    except (ValueError, TypeError):
        return False
    return bool(evidence.get('kind') == 'labtest_save_readback' and evidence.get('evidence')
                and evidence.get('guest') == 'Proof Labtest' and evidence.get('cms') is False and year >= 2027)


def score(results, labels, prices):
    by_id = {r['id']: r for r in results}
    if len(by_id) != len(results):
        raise ValueError('duplicate replay id')
    groups = {w: [] for w in WORKFLOWS}
    seen = set()
    for label in labels:
        key = (label['id'], label['workflow'])
        if key in seen or label['workflow'] not in groups or label['id'] not in by_id:
            raise ValueError('duplicate, unmatched, or invalid label')
        seen.add(key)
        if by_id[label['id']]['status'] != 'excluded':
            groups[label['workflow']].append((label, by_id[label['id']]))
    report = {}
    for workflow, group in groups.items():
        outcomes, reasons, field_counts, sources, prep, artifacts = Counter(), Counter(), Counter(), Counter(), Counter(), Counter()
        by_field = {}
        latencies, prepare_latencies, labtest_latencies, costs, per_email_cost = [], [], [], [], []
        labels_with_fields = 0
        for label, r in group:
            sources[label.get('source', 'unspecified')] += 1
            candidates = [p for p in r['proposals'] if p.get('workflow') == workflow]
            if workflow == 'triage' and r['status'] == 'complete' and r['proposals']:
                triage = candidates[0] if len(candidates) == 1 else {'disposition': 'propose'}
                candidates = [{**triage, 'classified_workflows': sorted({p.get('workflow') for p in r['proposals']
                                                                            if p.get('workflow') in WORKFLOWS and p.get('workflow') != 'triage'})}]
            p = candidates[0] if len(candidates) == 1 else None
            assertion_results = []
            if label.get('fields'):
                labels_with_fields += 1
            for field in label.get('fields', []):
                field_score = by_field.setdefault(field.get('path', '(missing)'), Counter())
                try:
                    separated = ('value' in field and bool(field.get('evidence')) and field.get('target') == 'real'
                                 and field.get('basis') in ('staff_outbound', 'hms')
                                 and (workflow == 'triage' or real_identity(label))
                                 and timestamp(field['observed_at']) > timestamp(r['input_cutoff']))
                except (KeyError, ValueError, TypeError):
                    separated = False
                if not separated or r['status'] != 'complete' or len(candidates) > 1:
                    field_counts['unknown'] += 1
                    field_score['unknown'] += 1
                    assertion_results.append(None)
                    continue
                found, actual = pointer(p, field.get('path')) if p else (False, None)
                correct = found and same(actual, field.get('value'))
                field_counts['correct' if correct else 'wrong'] += 1
                field_score['correct' if correct else 'wrong'] += 1
                assertion_results.append(correct)
            if r.get('tier') == 'C':
                outcome = 'unknown'
                reasons['model_only_scope'] += 1
            elif workflow in WRITES:
                evidence = label.get('labtest') or {}
                completed = evidence.get('completed')
                outcome = ('complete' if completed else 'failed') if type(completed) is bool and labtest_label(label) else 'unknown'
                if outcome == 'unknown':
                    reasons['labtest_terminal_evidence_missing'] += 1
            elif r['status'] != 'complete':
                outcome = 'unknown'
                reasons[r.get('reason') or 'replay_unknown'] += 1
            elif len(candidates) > 1:
                outcome = 'unknown'
                reasons['multiple_proposals'] += 1
            elif not p:
                outcome = 'failed'
            elif not assertion_results or None in assertion_results:
                outcome = 'unknown'
                reasons['scoreable_staff_fields_missing'] += 1
            elif workflow == 'triage' and not {'/classified_workflows', '/disposition'}.issubset({f.get('path') for f in label.get('fields', [])}):
                outcome = 'unknown'
                reasons['triage_classification_or_disposition_missing'] += 1
            elif not all(assertion_results):
                outcome = 'failed'
            elif workflow == 'quote':
                outcome = 'unknown'
                reasons['quote_unsent_draft_not_observed'] += 1
            else:
                outcome = 'complete'
            outcomes[outcome] += 1
            if r['status'] == 'complete' and r.get('wall_ms') is not None:
                latencies.append(r['wall_ms'])
            cost, why = model_cost(r, prices)
            per_email_cost.append({'id': r['id'], 'usd': cost, 'unknown_reason': why})
            if cost is None:
                reasons['cost:' + why] += 1
            else:
                costs.append(cost)
            labtest_ms = (label.get('labtest') or {}).get('wall_ms')
            if type(labtest_ms) in (int, float) and labtest_ms >= 0 and labtest_label(label):
                labtest_latencies.append(labtest_ms)
            for e in r.get('prepare', []):
                if e.get('workflow') == workflow:
                    prep[e['status']] += 1
                    if e['status'] == 'complete':
                        prepare_latencies.append(e['elapsed_from_post_ms'])
                    if e.get('reason'):
                        reasons['prepare:' + e['reason']] += 1
                    if e.get('artifact_reason'):
                        reasons['artifacts:' + e['artifact_reason']] += 1
                    if e.get('artifacts'):
                        artifacts[e['artifacts']] += 1
            if r.get('tier') != 'C' and workflow in WRITES | {'quote'} and not any(e.get('workflow') == workflow for e in r.get('prepare', [])):
                reasons['prepare:not_attempted'] += 1
        denom = len(group)
        scored = field_counts['correct'] + field_counts['wrong']
        report[workflow] = {'denominator': denom, 'e2e': dict(outcomes),
            'e2e_completion_pct_of_all': round(100 * outcomes['complete'] / denom, 2) if denom else None,
            'outcome_coverage': {'known': outcomes['complete'] + outcomes['failed'], 'unknown': outcomes['unknown']},
            'label_coverage': {'with_fields': labels_with_fields, 'denominator': denom, 'scoreable_fields': scored, 'unknown_fields': field_counts['unknown']},
            'field_accuracy': {'correct': field_counts['correct'], 'scored': scored, 'unknown': field_counts['unknown'],
                               'pct': round(100 * field_counts['correct'] / scored, 2) if scored else None,
                               'fields': {name: dict(counts) for name, counts in by_field.items()}},
            'wall_ms': {'n': len(latencies), 'p50': percentile(latencies, .5), 'p95': percentile(latencies, .95),
                        'scope': 'pane POST to model turn finished; excludes Prepare'},
            'post_to_prepare_ms': {'n': len(prepare_latencies), 'p50': percentile(prepare_latencies, .5), 'p95': percentile(prepare_latencies, .95)},
            'labtest_e2e_wall_ms': {'n': len(labtest_latencies), 'p50': percentile(labtest_latencies, .5), 'p95': percentile(labtest_latencies, .95)},
            'haiku_usd_per_email': {'n': len(costs), 'mean': sum(costs) / len(costs) if costs else None, 'emails': per_email_cost},
            'real_unsaved_prepare': dict(prep), 'labtest_completion': dict(outcomes) if workflow in WRITES else None,
            'quote_artifacts': dict(artifacts), 'label_sources': dict(sources), 'unknown_reasons': dict(reasons)}
    return {'pricing_model': prices.get('model') if prices else None,
            'pricing_source': prices.get('source') if prices else None, 'workflows': report,
            'excluded_cases': dict(Counter(r['reason'] for r in results if r['status'] == 'excluded')),
            'unlabeled_cases': len({r['id'] for r in results if r['status'] != 'excluded'} - {label['id'] for label in labels})}


def live_limit(capabilities):
    native = capabilities.get('native_read_slot_cap')
    configured = capabilities.get('configured_hms_slots')
    advertised = [v for v in (native, configured) if type(v) is int and v >= 0]
    limit = min([4] + advertised)
    effective = capabilities.get('effective_hms_slots')
    if (capabilities.get('shared_native_admission_verified') is True and
            all(type(v) is int and v > 0 for v in (native, configured, effective))):
        limit = min(12, native, configured, effective)
    return limit


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest='command', required=True)
    replay = sub.add_parser('replay', help='POST exact pane sources via staff gateway; no labels are read')
    replay.add_argument('--tier', required=True, choices=['A', 'B', 'C'])
    replay.add_argument('--inputs', required=True)
    replay.add_argument('--gateway', required=True, help='deployed gateway origin')
    replay.add_argument('--cookie-file', required=True, help='private file containing authorized Better Auth Cookie header')
    replay.add_argument('--origin', required=True, help='trusted browser Origin')
    replay.add_argument('--out', required=True, help='new private output JSON path')
    replay.add_argument('--concurrency', type=int, default=4)
    replay.add_argument('--timeout', type=int, default=300)
    replay.add_argument('--no-prepare', action='store_true')
    replay.add_argument('--quote-first', action='store_true', help='create quote artifacts using first eligible option per room; no draft or send')
    replay.add_argument('--historical-mailbox-id', help='authorized mailbox ID for legacy Tier C inputs')
    scoring = sub.add_parser('score', help='score saved replay against separate post-cutoff staff labels')
    scoring.add_argument('--replay', required=True)
    scoring.add_argument('--labels', required=True)
    scoring.add_argument('--prices', help='JSON file with explicitly sourced current per-million rates')
    args = parser.parse_args()
    if args.command == 'replay':
        cases = rows(args.inputs)
        if args.tier == 'C':
            for case in cases:
                if 'id' not in case and 'decision_id' in case:
                    case['id'] = case['decision_id']
        if not 1 <= args.concurrency <= 12 or args.timeout < 1 or len({c['id'] for c in cases}) != len(cases):
            raise ValueError('invalid concurrency, timeout, or duplicate id')
        if pathlib.Path(args.out).exists():
            raise ValueError('output already exists')
        gateway = Gateway(args.gateway, pathlib.Path(args.cookie_file).read_text(), args.origin, args.timeout)
        limit = 12 if args.tier == 'C' else live_limit(gateway.json('/capabilities'))
        if args.concurrency > limit:
            raise ValueError('requested concurrency exceeds effective limit ' + str(limit))
        started = time.monotonic()
        with concurrent.futures.ThreadPoolExecutor(max_workers=args.concurrency) as pool:
            results = list(pool.map(lambda c: run_case(gateway, c, not args.no_prepare, args.timeout, args.quote_first,
                                                      args.tier, args.historical_mailbox_id), cases))
        elapsed_ms = round((time.monotonic() - started) * 1000)
        run = {'tier': args.tier, 'concurrency': args.concurrency, 'effective_limit': limit,
               'elapsed_ms': elapsed_ms, 'results': results}
        save_private(args.out, run)
        print(json.dumps({'tier': args.tier, 'cases': len(results), 'status': dict(Counter(r['status'] for r in results)),
                          'concurrency': args.concurrency, 'effective_limit': limit, 'elapsed_ms': elapsed_ms, 'output': args.out}))
    else:
        with open(args.replay, encoding='utf-8') as f:
            run = json.load(f)
        prices = json.loads(pathlib.Path(args.prices).read_text()) if args.prices else None
        report = score(run['results'], rows(args.labels), prices)
        target = {'A': 3, 'B': 50, 'C': None}[run['tier']]
        report['run'] = {k: run[k] for k in ('tier', 'concurrency', 'effective_limit', 'elapsed_ms')}
        report['run']['target_per_workflow'] = target
        report['run']['target_ms'] = {'A': 600000, 'B': 2400000, 'C': None}[run['tier']]
        print(json.dumps(report, indent=2))


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print('scoreboard error: ' + (str(exc) if isinstance(exc, ValueError) else type(exc).__name__), file=sys.stderr)
        sys.exit(1)
