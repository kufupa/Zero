#!/usr/bin/env python3
"""Replay pane inputs and score them later, without sending or saving.

replay inputs: JSONL {id, input_cutoff, eligibility, thread}; thread is the
exact pane POST body through the selected inbound timestamp. Export the full
conversation through the authorized pane; the gateway independently checks the cutoff.
For B/C eligibility is human_inbound, ota, automated, internal, or unknown.
Tier C uses historical model-only inputs and requires gateway support.
For C, legacy model-safe JSONL rows can be used with --historical-mailbox-id;
add eligibility to each row. Rows with PDF metadata need an available attachment.
Use --timing-out for a separate private export containing only timing and usage
fields. Its client times end at the observed terminal response; stage event
timestamps include both worker wait and native execution.

score labels: JSONL {id, workflow, source, fields, labtest?}. Each field is
{path, value, observed_at, evidence, basis, target: "real", identity?}; path is
a JSON pointer into the matching proposal. basis is staff_outbound or hms,
never Labtest; observed_at must be later than input_cutoff. Each label has identity {target: "real",
confirmation, evidence} or {target: "real", stay_id, match_evidence},
independently matching the real stay. Multi-booking/room labels require identity
on each field. Proposal identifiers must match; for an ID-less Quote/Create a
field may instead carry source_binding {message_id, reference, proposal_path,
evidence}, a unique stable reference present in that source and proposal scope.
Triage does not require a stay. A write-workflow labtest is {kind:
"labtest_save_readback", case_id, workflow, source_message_id, real_proposal_id,
booking_id, execution_id, completed, evidence, guest: "Proof Labtest", arrival_date, cms:
false, save: {confirmation or stay_id, evidence, at}, readback: {confirmation or
stay_id, evidence, observed_at}, wall_ms?}. A completed Save and later matching
readback are required, as is this proposal's real signed Prepare. Use labtests
with one distinct Save/readback per booking for multi-booking proposals. Identifiers
must be opaque case IDs. Rooms in one Go can share an execution ID within one
case/proposal; each room needs a distinct booking ID and matched stay readback.
Quote evidence is quote_observation: {source_message_id, proposal_id, revision,
quote_id, unsent_draft_reopened, pdf_download, xlsx_download, wall_ms?}.
For a decline, replace the download observations with sold_out_verified.
Observations hold evidence references from the signed pane probe.
For triage, /classified_workflows compares the sorted proposed workflow names.

prices: JSON {model, input, output, cache_read, cache_write, long_context_above,
long_input, long_output, long_cache_read, long_cache_write}; USD per million.
Omit prices when current rates are not established.

catalog input JSONL: {id, input_cutoff, eligibility, thread_id, message_id,
mailbox_id, thread}, where thread is an authorized mail.get response with
mergeLinked=true. Output is a private pane-input JSONL; HTML-only rows are
reported separately for the pane's own mapper to handle.
"""
import argparse
import concurrent.futures
import datetime as dt
import hashlib
import http.client
import json
import os
import pathlib
import re
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


def private_destination(path):
    if pathlib.Path(path).resolve().is_relative_to(pathlib.Path(__file__).resolve().parents[3]):
        raise ValueError('private output must be outside the repository')


def save_private(path, value):
    private_destination(path)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w', encoding='utf-8') as f:
        json.dump(value, f, ensure_ascii=False, separators=(',', ':'))
        f.write('\n')


def catalog_case(row):
    thread = row['thread']
    messages = thread['messages']
    if (thread['id'] != row['thread_id'] or thread['transportId'] != row['mailbox_id']
            or not thread['conversationId'] or thread['conversationMessageCount'] != len(messages) or not messages):
        raise ValueError('conversation_incomplete')
    thread_ids = {thread['id'], *thread['linkedThreadIds']}
    ids = set()
    mapped = []
    def address(value):
        email = value['email']
        if not isinstance(email, str) or not email.strip():
            raise ValueError('address_missing')
        name = value.get('name')
        return {'name': None if name == email.strip().split('@')[0] else name, 'email': email}
    for m in messages:
        if (not m['id'] or m['id'] in ids or m.get('threadId') not in thread_ids or m.get('isDraft')
                or m.get('direction') not in ('inbound', 'outbound')):
            raise ValueError('conversation_invalid')
        ids.add(m['id'])
        if timestamp(m['receivedOn']) > timestamp(row['input_cutoff']):
            continue
        if m['body'] == m['processedHtml'] and re.search(r'<[a-z][\s\S]*>', m['body'], re.I):
            raise ValueError('html_only_requires_pane_mapper')
        mapped.append({'id': m['id'], 'rfc_message_id': m.get('messageId'), 'direction': m['direction'],
                       'from': address(m['sender']), 'to': [address(v) for v in m['to']],
                       'cc': [address(v) for v in (m.get('cc') or [])], 'received_at': m['receivedOn'],
                       'subject': m['subject'], 'body_text': m['body'], 'body_html': None,
                       'attachment_status': m.get('attachmentStatus') or 'unknown', 'attachments': []})
    selected = [m for m in mapped if m['id'] == row['message_id'] and m['direction'] == 'inbound']
    if len(selected) != 1 or not selected[0]['body_text'].strip() or timestamp(selected[0]['received_at']) != timestamp(row['input_cutoff']):
        raise ValueError('selected_inbound_missing')
    return {'id': row['id'], 'input_cutoff': row['input_cutoff'], 'eligibility': row.get('eligibility', 'unknown'),
            'thread': {'source': 'outlook', 'source_thread_id': thread['conversationId'], 'mailbox_id': row['mailbox_id'],
                       'selected_message_id': row['message_id'], 'property_code': 'HRCEN', 'mode': 'live', 'messages': mapped}}


def save_jsonl_private(path, values):
    private_destination(path)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w', encoding='utf-8') as f:
        for value in values:
            f.write(json.dumps(value, ensure_ascii=False, separators=(',', ':')) + '\n')


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def error_code(error):
    value = error.get('code') if isinstance(error, dict) else error
    return value if isinstance(value, str) and re.fullmatch(r'[A-Za-z][A-Za-z0-9_]{1,79}', value) else None


class GatewayHttpError(RuntimeError):
    def __init__(self, code, gateway_code):
        super().__init__('http_' + str(code))
        self.gateway_code = gateway_code


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

    def request(self, path, body=None, headers=None, timeout=None):
        data = None if body is None else json.dumps(body, ensure_ascii=False, separators=(',', ':')).encode()
        h = dict(self.headers)
        h.update(headers or {})
        if data is not None:
            h['Content-Type'] = 'application/json'
        req = urllib.request.Request(self.base + path, data=data, headers=h)
        try:
            return self.opener.open(req, timeout=self.timeout if timeout is None else timeout)
        except urllib.error.HTTPError as e:
            with e:
                try:
                    reply = json.loads(e.read(8192))
                    gateway_code = error_code(reply.get('error')) if isinstance(reply, dict) else None
                except (ValueError, OSError):
                    gateway_code = None
            raise GatewayHttpError(e.code, gateway_code) from None

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


def triage_lookup_eligible(proposal):
    actions = proposal.get('actions') or []
    return (proposal.get('workflow') == 'triage' and proposal.get('phase') == 'ready'
            and proposal.get('disposition') in ('propose', 'staff_review')
            and len(actions) == 1 and actions[0].get('type') == 'triage')


def capture_stage_events(gateway, path, after, through, entries):
    """Read the finite, already-observed event range; never delay the measured path."""
    by_job = {entry['job_id']: entry for entry in entries if entry.get('job_id')}
    if not by_job or through <= after:
        return True
    with gateway.request(path + '/events?after_sequence=' + str(after),
                         headers={'Accept': 'text/event-stream', 'Last-Event-ID': str(after)}, timeout=5) as stream:
        data = []
        while True:
            raw = stream.readline()
            if not raw:
                break
            line = raw.decode('utf-8').rstrip('\r\n')
            if line.startswith('data:'):
                data.append(line[5:].lstrip(' '))
            elif not line and data:
                event = json.loads('\n'.join(data))
                data = []
                payload = event.get('payload') or {}
                entry = by_job.get(payload.get('job_id'))
                if (entry and event.get('kind') in ('stage_queued', 'stage_finished')
                        and payload.get('proposal_id') == entry['proposal_id']
                        and payload.get('revision') == entry['revision']):
                    entry.setdefault('stage_events', []).append({
                        'kind': event['kind'], 'at': event.get('at'), 'job_id': entry['job_id']})
                if event.get('sequence', 0) >= through:
                    return True
    return False


def timing_result(result):
    """Timing export excludes source, proposals, stage payloads and message bodies."""
    return {
        'id': result['id'], 'tier': result['tier'], 'status': result['status'],
        'reason': result.get('reason'), 'wall_ms': result.get('wall_ms'),
        'turn_finish_reason': result.get('turn_finish_reason'),
        'stage_events_error': result.get('stage_events_error'),
        'model_calls': [{k: event['payload'].get(k) for k in (
            'attempt_id', 'status', 'stop_reason', 'error_code', 'latency_ms', 'input_tokens', 'output_tokens',
            'cache_read_input_tokens', 'cache_creation_input_tokens')}
            for event in result.get('events', []) if event.get('kind') == 'model_call'],
        'prepare': [{k: entry.get(k) for k in (
            'workflow', 'proposal_id', 'revision', 'job_id', 'status', 'reason',
            'wall_ms', 'elapsed_from_post_ms', 'native_outcome', 'stage_events')}
            for entry in result.get('prepare', [])],
    }


def turn_events(gateway, path, deadline):
    cursor = 0
    while time.monotonic() < deadline:
        try:
            with gateway.request(path + '/events?after_sequence=' + str(cursor),
                                 headers={'Accept': 'text/event-stream', 'Last-Event-ID': str(cursor)},
                                 timeout=max(1, min(320, deadline - time.monotonic()))) as stream:
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
                        cursor = event['sequence']
                        yield event
        except (TimeoutError, ConnectionError, http.client.IncompleteRead):
            pass  # Resume the same signed read; never dispatch the turn again.
        except GatewayHttpError as exc:
            if str(exc) not in ('http_502', 'http_504'):
                raise
        except urllib.error.URLError as exc:
            if not isinstance(exc.reason, (TimeoutError, ConnectionError)):
                raise
        remaining = deadline - time.monotonic()
        if remaining > 0:
            time.sleep(min(1, remaining))


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


def run_case(gateway, case, prepare, timeout, quote_first=False, tier='A', historical_mailbox=None, run_id=None, turn_timeout=720):
    result = {'id': case['id'], 'input_cutoff': case['input_cutoff'], 'status': 'unknown',
              'tier': tier, 'reason': None, 'wall_ms': None, 'proposals': [], 'events': [], 'prepare': []}
    monotonic = None
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
        if tier != 'C':
            thread = {**thread, 'replay_id': run_id or str(uuid.uuid4()), 'input_cutoff': case['input_cutoff']}
        result['source'] = {'message_id': selected[0]['id'], 'subject': selected[0].get('subject', ''),
                            'body_text': selected[0].get('body_text', '')}
        if tier == 'C' and not time.time() - 30 * 86400 <= timestamp(selected[0]['received_at']) <= time.time():
            result.update(status='excluded', reason='outside_last_30_days')
            return result
        payload = json.dumps(thread, ensure_ascii=False, separators=(',', ':')).encode()
        idempotency_key = hashlib.sha256(payload).hexdigest()
        monotonic = time.monotonic()
        with gateway.request('/threads', thread, {'Idempotency-Key': idempotency_key}) as response:
            status = response.status
            snap = json.load(response)
        result['wall_ms'] = round((time.monotonic() - monotonic) * 1000)
        if status != 201:
            raise ValueError('existing_session_not_fresh')
        result['import_accepted'] = True
        if not snap.get('session'):
            result.update(status='complete', reason='filtered', proposals=[{'workflow': 'triage', 'disposition': 'skip'}], cost_reason='filtered_no_model')
            return result
        if snap['session'].get('mode') != ('historical' if tier == 'C' else 'live'):
            raise ValueError('session_mode_mismatch')
        path = '/threads/' + urllib.parse.quote(snap['id'], safe='')
        selected_id = thread['selected_message_id']
        deadline = time.monotonic() + turn_timeout
        # Start at zero to capture calls that finished before POST returned.
        # A 201 is a new thread, and mail_pending identifies its selected turn.
        found = False
        finished = False
        model_end_sequence = 0
        for event in turn_events(gateway, path, deadline):
            p = event.get('payload') or {}
            if event.get('kind') == 'mail_pending' and p.get('message_id') == selected_id:
                found = True
                result['events'] = []
            if found:
                if event.get('kind') == 'model_call':
                    result['events'].append({'kind': 'model_call', 'payload': {k: p.get(k) for k in (
                        'attempt_id', 'status', 'stop_reason', 'error_code', 'input_tokens', 'output_tokens', 'cache_read_input_tokens',
                        'cache_creation_input_tokens', 'latency_ms', 'metadata')}})
                if event.get('kind') == 'turn_finished':
                    finished = True
                    result['turn_finish_reason'] = p.get('reason')
                    model_end_sequence = event.get('sequence', 0)
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
        last_sequence = snap.get('event_sequence', model_end_sequence)
        if prepare:
            for p in result['proposals']:
                workflow = p.get('workflow')
                disposition = p.get('disposition')
                write_ready = workflow in WRITES and disposition == 'propose'
                quote_ready = workflow == 'quote' and disposition in ('propose', 'staff_review', 'needs_info')
                if not triage_lookup_eligible(p) and (p.get('phase') != 'ready' or not (write_ready or quote_ready)):
                    continue
                op = 'quote' if workflow == 'quote' else 'stage'
                body = {'expected_revision': p['revision']}
                if op == 'quote':
                    qid = quote_id(p)
                    if not qid:
                        result['prepare'].append({'workflow': workflow, 'status': 'unknown', 'reason': 'quote_id_missing'})
                        continue
                    body.update(quote_id=qid, idempotency_key=str(uuid.uuid4()))
                entry = {'workflow': workflow, 'proposal_id': p['id'], 'revision': p['revision'],
                         'status': 'unknown', 'reason': None, 'wall_ms': None}
                result['prepare'].append(entry)
                pstart = time.monotonic()
                try:
                    # Dispatch exactly once. An uncertain response is recorded, never retried.
                    accepted = gateway.json('/proposals/' + urllib.parse.quote(p['id'], safe='') + '/' + op, body)
                    if (accepted.get('proposal_id') != p['id'] or accepted.get('revision') != p['revision']
                            or accepted.get('phase') != 'staging' or not accepted.get('job_id')):
                        entry['reason'] = 'prepare_acceptance_unbound'
                        continue
                    entry['job_id'] = accepted['job_id']
                    entry['accepted'] = True
                    while time.monotonic() - pstart < timeout:
                        current = gateway.json(path)
                        last_sequence = current.get('event_sequence', last_sequence)
                        item = next((x for x in current.get('proposals', []) if x['id'] == p['id']), None)
                        if item and terminal_stage(item):
                            stage = item.get('stage') or {}
                            if stage.get('job_id') != entry['job_id'] or stage.get('revision') != entry['revision']:
                                entry['reason'] = 'prepare_result_unbound'
                                break
                            entry['status'] = 'complete' if not item.get('error') else 'failed'
                            entry['reason'] = None if entry['status'] == 'complete' else 'operation_error'
                            entry['error_code'] = error_code(item.get('error'))
                            entry['stage'] = stage
                            if workflow == 'triage' and isinstance(stage.get('native_result'), dict):
                                native_outcome = stage['native_result'].get('outcome')
                                if native_outcome in ('uniquely_read', 'candidates', 'incomplete', 'not_uniquely_read'):
                                    entry['native_outcome'] = native_outcome
                            entry['wall_ms'] = round((time.monotonic() - pstart) * 1000)
                            entry['elapsed_from_post_ms'] = round((time.monotonic() - monotonic) * 1000)
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
                    timed_out = isinstance(exc, TimeoutError) or (isinstance(exc, urllib.error.URLError) and isinstance(exc.reason, TimeoutError))
                    entry['reason'] = ('operation_timeout' if timed_out else
                                       str(exc) if isinstance(exc, RuntimeError) else 'operation_dispatch_or_read_unknown')
                    if isinstance(exc, RuntimeError) and re.fullmatch(r'http_4\d\d', str(exc)):
                        entry['status'] = 'failed'
                    if isinstance(exc, GatewayHttpError):
                        entry['error_code'] = exc.gateway_code
                finally:
                    if entry['wall_ms'] is None:
                        entry['wall_ms'] = round((time.monotonic() - pstart) * 1000)
                        entry['elapsed_from_post_ms'] = round((time.monotonic() - monotonic) * 1000)
            if any(entry.get('job_id') for entry in result['prepare']):
                try:
                    last_sequence = gateway.json(path).get('event_sequence', last_sequence)
                except Exception:
                    result['stage_events_error'] = 'event_snapshot_unavailable'
            try:
                if not capture_stage_events(gateway, path, model_end_sequence, last_sequence, result['prepare']):
                    result['stage_events_error'] = 'event_capture_incomplete'
            except Exception:
                result['stage_events_error'] = 'event_capture_unavailable'
    except Exception as exc:
        known = {'pane_live_source_required', 'historical_source_required', 'historical_mailbox_required', 'historical_attachment_unavailable',
                 'conversation_after_cutoff', 'selected_inbound_missing', 'existing_session_not_fresh',
                 'session_mode_mismatch', 'fresh_mail_event_not_observed', 'turn_not_finished', 'selected_mail_changed'}
        result['reason'] = str(exc) if isinstance(exc, RuntimeError) or str(exc) in known else 'request_or_stream_error'
        if isinstance(exc, GatewayHttpError):
            result['error_code'] = exc.gateway_code
        result['wall_ms'] = round((time.monotonic() - monotonic) * 1000) if monotonic is not None else None
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


def labtest_evidences(label):
    if 'labtests' in label:
        return label['labtests'] if isinstance(label['labtests'], list) else []
    return [label['labtest']] if isinstance(label.get('labtest'), dict) else []


def real_identity(identity, label):
    identity = identity or {}
    if identity.get('target') != 'real' or identity.get('guest') == 'Proof Labtest':
        return False
    labtest_ids = [target for labtest in labtest_evidences(label) if isinstance(labtest, dict)
                   for target in (labtest, labtest.get('save') or {}, labtest.get('readback') or {})]
    if any(identity.get(k) and identity.get(k) == target.get(k)
           for k in ('confirmation', 'stay_id') for target in labtest_ids):
        return False
    return bool((identity.get('confirmation') and identity.get('evidence')) or
                (identity.get('stay_id') and identity.get('match_evidence')))


def booking_for_path(proposal, path):
    bookings = proposal.get('bookings') or []
    parts = path.split('/') if isinstance(path, str) else []
    if len(parts) >= 3 and parts[1] == 'bookings' and re.fullmatch(r'0|[1-9]\d*', parts[2]):
        index = int(parts[2])
        return (index, bookings[index]) if index < len(bookings) else (None, None)
    if len(parts) >= 3 and parts[1] == 'actions' and re.fullmatch(r'0|[1-9]\d*', parts[2]):
        actions = proposal.get('actions') or []
        index = int(parts[2])
        if index >= len(actions):
            return None, None
        ids = actions[index].get('booking_ids') or []
        matches = [(i, b) for i, b in enumerate(bookings) if b.get('id') in ids]
        return matches[0] if len(ids) == len(matches) == 1 else (None, None)
    return (0, bookings[0]) if len(bookings) == 1 else (None, None)


def booking_identifiers(proposal, booking):
    state = booking.get('current_state') or {}
    fields = booking.get('fields') or {}
    values = [booking.get('reservation_id')]
    for item in (fields, state):
        values.extend(item.get(key) for key in ('confirmation_number', 'confirmation', 'reservation_id',
                                                'stay_id', 'native_stay_id', 'reservation_stay_id'))
    for action in proposal.get('actions') or []:
        details = action.get('details')
        if action.get('booking_ids') == [booking.get('id')] and isinstance(details, dict):
            values.append(details.get('confirmation_number'))
    return {v for v in values if isinstance(v, str) and v.strip()}


def source_binding(proposal, path, binding, source):
    if not isinstance(binding, dict) or not isinstance(source, dict) or not binding.get('evidence'):
        return False
    token, ref_path = binding.get('reference'), binding.get('proposal_path')
    if (binding.get('message_id') != source.get('message_id') or not isinstance(token, str)
            or not re.fullmatch(r'[A-Za-z0-9_-]{5,}', token) or not re.search(r'[A-Za-z]', token)
            or not re.search(r'\d', token) or re.search(r'\d{1,2}(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\d{2,4}', token, re.I)):
        return False
    # The reference must belong to the same booking or individual quote room.
    scope = re.match(r'^(/bookings/(?:0|[1-9]\d*)/fields)(?:/|$)', path or '')
    if not scope:
        scope = re.match(r'^(/actions/(?:0|[1-9]\d*)/details/groups/(?:0|[1-9]\d*)/rooms/(?:0|[1-9]\d*))(?:/|$)', path or '')
    if not scope or not isinstance(ref_path, str):
        return False
    if scope.group(1).startswith('/actions/'):
        found, room = pointer(proposal, scope.group(1))
        if not found or not isinstance(room, dict) or room.get('quantity') != 1:
            return False
    ref_fields = {'booking_reference', 'external_reference', 'source_reference', 'request_reference'}
    if ref_path not in {scope.group(1) + '/' + name for name in ref_fields}:
        return False
    found, value = pointer(proposal, ref_path)
    text = str(source.get('subject') or '') + '\n' + str(source.get('body_text') or '')
    if not found or value != token or text.count(token) != 1:
        return False
    def count_refs(value):
        if isinstance(value, list):
            return sum(count_refs(v) for v in value)
        if isinstance(value, dict):
            return sum((1 if k in ref_fields and v == token else 0) + count_refs(v) for k, v in value.items())
        return 0
    return count_refs(proposal) == 1


def conflicting_bindings(label):
    by_reference, by_identity = {}, {}
    for field in label.get('fields', []):
        binding = field.get('source_binding') or {}
        identity = field.get('identity') or label.get('identity') or {}
        ref = (binding.get('message_id'), binding.get('reference'))
        target = (identity.get('confirmation'), identity.get('stay_id'))
        if all(ref) and any(target):
            by_reference.setdefault(ref, set()).add(target)
            by_identity.setdefault(target, set()).add(ref)
    bad = {ref for ref, targets in by_reference.items() if len(targets) != 1}
    for refs in by_identity.values():
        if len(refs) != 1:
            bad.update(refs)
    return bad


def field_identity(proposal, field, label, source, conflicts):
    if not isinstance(proposal, dict):
        return 'proposal_missing'
    path = field.get('path')
    index, booking = booking_for_path(proposal, path)
    bookings = proposal.get('bookings') or []
    quote_rooms = sum(max(1, room.get('quantity') if type(room.get('quantity')) is int else 1)
                      for action in proposal.get('actions') or [] if isinstance(action.get('details'), dict)
                      for group in action['details'].get('groups') or [] if isinstance(group, dict)
                      for room in group.get('rooms') or [] if isinstance(room, dict))
    multiple = len(bookings) > 1 or quote_rooms > 1
    identity = field.get('identity') if multiple else field.get('identity', label.get('identity'))
    if not real_identity(identity, label):
        return 'staff_identity_missing'
    actual = booking_identifiers(proposal, booking) if booking else set()
    expected = {identity[k] for k in ('confirmation', 'stay_id') if isinstance(identity.get(k), str) and identity[k]}
    if actual:
        if not actual.issubset(expected) or not (actual & expected):
            return 'proposal_identity_mismatch'
        if sum(bool(booking_identifiers(proposal, b) & actual) for b in bookings) != 1:
            return 'proposal_identity_ambiguous'
        return None
    if booking is None and bookings:
        return 'booking_scope_ambiguous'
    binding = field.get('source_binding') or {}
    if proposal.get('workflow') in ('quote', 'create'):
        if (binding.get('message_id'), binding.get('reference')) in conflicts:
            return 'source_binding_ambiguous'
        if source_binding(proposal, path, binding, source):
            return None
    return 'proposal_identity_unbound'


def labtest_booking(evidence):
    return evidence.get('execution_id'), evidence.get('booking_id')


def labtest_targets(evidence):
    readback = evidence.get('readback') or {}
    return [(evidence.get('workflow'), key, readback[key]) for key in ('confirmation', 'stay_id')
            if isinstance(readback.get(key), str) and readback[key]]


def labtest_label(label, result, proposal, evidence, unique_room_evidence):
    if not isinstance(evidence, dict):
        return False
    try:
        year = dt.date.fromisoformat(evidence.get('arrival_date', '')).year
    except (ValueError, TypeError):
        return False
    execution = evidence.get('execution_id')
    source_id = (result.get('source') or {}).get('message_id')
    if not (evidence.get('kind') == 'labtest_save_readback' and evidence.get('evidence')
            and evidence.get('guest') == 'Proof Labtest' and evidence.get('cms') is False and year >= 2027
            and evidence.get('case_id') == label.get('id') and evidence.get('workflow') == label.get('workflow')
            and isinstance(source_id, str) and source_id and evidence.get('source_message_id') == source_id
            and proposal and evidence.get('real_proposal_id') == proposal.get('id')
            and evidence.get('booking_id') and sum(b.get('id') == evidence['booking_id'] for b in proposal.get('bookings') or []) == 1
            and isinstance(execution, str) and execution and unique_room_evidence(evidence)
            and type(evidence.get('completed')) is bool):
        return False
    save = evidence.get('save') or {}
    if not save.get('evidence'):
        return False
    if evidence['completed'] is False:
        return True
    readback = evidence.get('readback') or {}
    ids = [key for key in ('confirmation', 'stay_id') if save.get(key) and readback.get(key)]
    try:
        ordered = timestamp(readback['observed_at']) >= timestamp(save['at'])
    except (KeyError, ValueError, TypeError):
        ordered = False
    return bool(readback.get('evidence') and ids and ordered and all(save[key] == readback[key] for key in ids))


def quote_observed(label, result, proposal):
    observation = label.get('quote_observation') or {}
    def observed(key):
        return isinstance(observation.get(key), str) and bool(observation[key])

    return (observation.get('source_message_id') == (result.get('source') or {}).get('message_id')
            and observation.get('proposal_id') == proposal.get('id')
            and observation.get('revision') == proposal.get('revision')
            and observation.get('quote_id') == quote_id(proposal)
            and all(observed(key) for key in ('source_message_id', 'proposal_id', 'quote_id', 'unsent_draft_reopened'))
            and (observed('sold_out_verified') or (observed('pdf_download') and observed('xlsx_download'))))


def prepare_outcome(result, proposal, item):
    if not proposal or result.get('status') != 'complete' or not (result.get('source') or {}).get('message_id'):
        return 'unknown'
    if (item.get('workflow') != proposal.get('workflow') or item.get('proposal_id') != proposal.get('id')
            or item.get('revision') != proposal.get('revision')):
        return 'unknown'
    stage = item.get('stage') or {}
    if (item.get('status') == 'complete' and item.get('accepted') is True and item.get('job_id')
            and stage.get('job_id') == item['job_id'] and stage.get('revision') == item['revision']):
        return 'complete'
    return 'failed' if item.get('status') == 'failed' else 'unknown'


def score(results, labels, prices):
    by_id = {r['id']: r for r in results}
    if len(by_id) != len(results):
        raise ValueError('duplicate replay id')
    groups = {w: [] for w in WORKFLOWS}
    execution_scopes, used_rooms, used_targets = {}, Counter(), Counter()
    for label in labels:
        for evidence in labtest_evidences(label):
            if not isinstance(evidence, dict) or not isinstance(evidence.get('execution_id'), str):
                continue
            execution_scopes.setdefault(evidence['execution_id'], set()).add(
                (label['id'], label['workflow'], evidence.get('real_proposal_id')))
            used_rooms[labtest_booking(evidence)] += 1
            used_targets.update(labtest_targets(evidence))

    def unique_room_evidence(evidence):
        return (len(execution_scopes.get(evidence.get('execution_id'), ())) == 1
                and used_rooms[labtest_booking(evidence)] == 1
                and all(used_targets[target] == 1 for target in labtest_targets(evidence)))

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
        outcomes, reasons, field_counts, sources, prep, artifacts, labtests = Counter(), Counter(), Counter(), Counter(), Counter(), Counter(), Counter()
        prepare_timing, funnel = Counter(), Counter()
        lookup_outcomes = Counter()
        by_field = {}
        latencies, prepare_latencies, labtest_latencies, quote_latencies, costs, per_email_cost = [], [], [], [], [], []
        labels_with_fields = 0
        for label, r in group:
            sources[label.get('source', 'unspecified')] += 1
            candidates = [p for p in r['proposals'] if p.get('workflow') == workflow]
            if workflow == 'triage' and r['status'] == 'complete' and r['proposals']:
                triage = candidates[0] if len(candidates) == 1 else {'disposition': 'propose'}
                candidates = [{**triage, 'classified_workflows': sorted({p.get('workflow') for p in r['proposals']
                                                                            if p.get('workflow') in WORKFLOWS and p.get('workflow') != 'triage'})}]
            p = candidates[0] if len(candidates) == 1 else None
            if r.get('import_accepted') or r['status'] == 'complete':
                funnel['import_accepted'] += 1
            if r['status'] == 'complete':
                funnel['prefill_complete'] += 1
            if candidates:
                funnel['matching_proposal'] += 1
            if any(candidate.get('field_specs') for candidate in candidates):
                funnel['editable_proposal'] += 1
            if any(e.get('workflow') == workflow and e.get('accepted') is True for e in r.get('prepare', [])):
                funnel['prepare_accepted'] += 1
            if r.get('error_code'):
                reasons['import:' + r['error_code']] += 1
            assertion_results = []
            bound_bookings = set()
            conflicts = conflicting_bindings(label)
            if label.get('fields'):
                labels_with_fields += 1
            for field in label.get('fields', []):
                field_score = by_field.setdefault(field.get('path', '(missing)'), Counter())
                try:
                    separated = ('value' in field and bool(field.get('evidence')) and field.get('target') == 'real'
                                 and field.get('basis') in ('staff_outbound', 'hms')
                                 and timestamp(field['observed_at']) > timestamp(r['input_cutoff']))
                except (KeyError, ValueError, TypeError):
                    separated = False
                if not separated or r['status'] != 'complete' or len(candidates) > 1:
                    field_counts['unknown'] += 1
                    field_score['unknown'] += 1
                    assertion_results.append(None)
                    continue
                binding_reason = None if workflow == 'triage' else field_identity(p, field, label, r.get('source'), conflicts)
                if binding_reason:
                    field_counts['unknown'] += 1
                    field_score['unknown'] += 1
                    reasons['field:' + binding_reason] += 1
                    assertion_results.append(None)
                    continue
                if workflow in WRITES:
                    index, _ = booking_for_path(p, field.get('path'))
                    if index is not None:
                        bound_bookings.add(index)
                found, actual = pointer(p, field.get('path')) if p else (False, None)
                correct = found and same(actual, field.get('value'))
                field_counts['correct' if correct else 'wrong'] += 1
                field_score['correct' if correct else 'wrong'] += 1
                assertion_results.append(correct)
            if r.get('tier') == 'C':
                outcome = 'unknown'
                reasons['model_only_scope'] += 1
            elif workflow in WRITES:
                evidence = labtest_evidences(label)
                valid = [item for item in evidence if labtest_label(label, r, p, item, unique_room_evidence)]
                booking_ids = [b.get('id') for b in (p.get('bookings') or [])] if p else []
                covered_ids = [item['booking_id'] for item in valid]
                if any(item['completed'] is False for item in valid):
                    lab_outcome = 'failed'
                elif (booking_ids and len(set(booking_ids)) == len(booking_ids) == len(covered_ids) == len(evidence)
                      and set(covered_ids) == set(booking_ids)):
                    lab_outcome = 'complete'
                else:
                    lab_outcome = 'unknown'
                labtests[lab_outcome] += 1
                matches = [e for e in r.get('prepare', []) if p and e.get('workflow') == workflow
                           and e.get('proposal_id') == p.get('id') and e.get('revision') == p.get('revision')]
                real_outcome = 'unknown'
                if r['status'] == 'complete' and len(matches) == 1:
                    item = matches[0]
                    prepared = prepare_outcome(r, p, item)
                    if prepared == 'complete':
                        bookings = p.get('bookings') or []
                        if bookings and bound_bookings == set(range(len(bookings))) and assertion_results and None not in assertion_results:
                            real_outcome = 'complete'
                        else:
                            reasons['real_case_identity_unbound'] += 1
                    elif prepared == 'failed':
                        real_outcome = 'failed'
                if real_outcome == 'failed' or lab_outcome == 'failed':
                    outcome = 'failed'
                elif real_outcome == lab_outcome == 'complete':
                    outcome = 'complete'
                else:
                    outcome = 'unknown'
                if real_outcome == 'unknown':
                    reasons['real_prepare_unbound_or_missing'] += 1
                if lab_outcome == 'unknown':
                    reused = any(isinstance(item, dict) and isinstance(item.get('execution_id'), str)
                                 and not unique_room_evidence(item) for item in evidence)
                    reason = 'labtest_room_or_execution_reused' if reused else 'labtest_terminal_evidence_unbound_or_missing'
                    reasons[reason] += 1
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
            elif workflow == 'quote' and not quote_observed(label, r, p):
                outcome = 'unknown'
                reasons['quote_unsent_draft_not_observed'] += 1
            else:
                outcome = 'complete'
                if workflow == 'quote':
                    quote_ms = label['quote_observation'].get('wall_ms')
                    if type(quote_ms) in (int, float) and quote_ms >= 0:
                        quote_latencies.append(quote_ms)
            if workflow == 'triage' and r.get('tier') != 'C' and p and triage_lookup_eligible(p):
                matches = [e for e in r.get('prepare', []) if e.get('workflow') == 'triage'
                           and e.get('proposal_id') == p.get('id') and e.get('revision') == p.get('revision')]
                lookup = prepare_outcome(r, p, matches[0]) if len(matches) == 1 else 'unknown'
                if lookup == 'failed':
                    outcome = 'failed'
                elif lookup != 'complete':
                    if outcome == 'complete':
                        outcome = 'unknown'
                    reasons['triage_lookup_unfinished'] += 1
                elif matches[0].get('native_outcome') == 'incomplete' and outcome == 'complete':
                    outcome = 'unknown'
                    reasons['triage_lookup_incomplete'] += 1
            outcomes[outcome] += 1
            if r['status'] == 'complete' and r.get('wall_ms') is not None:
                latencies.append(r['wall_ms'])
            cost, why = model_cost(r, prices)
            per_email_cost.append({'id': r['id'], 'usd': cost, 'unknown_reason': why})
            if cost is None:
                reasons['cost:' + why] += 1
            else:
                costs.append(cost)
            evidences = labtest_evidences(label)
            if len(evidences) == 1 and labtest_label(label, r, p, evidences[0], unique_room_evidence):
                labtest_ms = evidences[0].get('wall_ms')
                if type(labtest_ms) in (int, float) and labtest_ms >= 0:
                    labtest_latencies.append(labtest_ms)
            for e in r.get('prepare', []):
                if e.get('workflow') == workflow:
                    prepared = prepare_outcome(r, p, e)
                    prep[prepared] += 1
                    timing_status = ('timed_out' if e.get('reason') == 'operation_timeout'
                                     else 'failed' if e.get('status') == 'failed'
                                     else 'complete' if prepared == 'complete' else 'unknown')
                    prepare_timing[timing_status] += 1
                    if prepared == 'complete' and type(e.get('elapsed_from_post_ms')) in (int, float):
                        prepare_latencies.append(e['elapsed_from_post_ms'])
                    if workflow == 'triage' and e.get('native_outcome'):
                        lookup_outcomes[e['native_outcome']] += 1
                    if e.get('reason'):
                        reasons['prepare:' + e['reason']] += 1
                    if e.get('error_code'):
                        reasons['prepare_code:' + e['error_code']] += 1
                    if e.get('artifact_reason'):
                        reasons['artifacts:' + e['artifact_reason']] += 1
                    if e.get('artifacts'):
                        artifacts[e['artifacts']] += 1
            if (r.get('tier') != 'C' and (workflow in WRITES | {'quote'} or p and triage_lookup_eligible(p))
                    and not any(e.get('workflow') == workflow for e in r.get('prepare', []))):
                reasons['prepare:not_attempted'] += 1
                prepare_timing['not_attempted'] += 1
        denom = len(group)
        scored = field_counts['correct'] + field_counts['wrong']
        report[workflow] = {'denominator': denom, 'e2e': dict(outcomes),
            'e2e_completion_pct_of_all': round(100 * outcomes['complete'] / denom, 2) if denom else None,
            'funnel': dict(funnel),
            'outcome_coverage': {'known': outcomes['complete'] + outcomes['failed'], 'unknown': outcomes['unknown']},
            'label_coverage': {'with_fields': labels_with_fields, 'denominator': denom, 'scoreable_fields': scored, 'unknown_fields': field_counts['unknown']},
            'field_accuracy': {'correct': field_counts['correct'], 'scored': scored, 'unknown': field_counts['unknown'],
                               'pct': round(100 * field_counts['correct'] / scored, 2) if scored else None,
                               'fields': {name: dict(counts) for name, counts in by_field.items()}},
            'wall_ms': {'n': len(latencies), 'p50': percentile(latencies, .5), 'p95': percentile(latencies, .95),
                        'scope': 'pane POST to model turn finished; excludes Prepare'},
            'post_to_prepare_ms': {'n': len(prepare_latencies), 'p50': percentile(prepare_latencies, .5), 'p95': percentile(prepare_latencies, .95),
                                   'failed': prepare_timing['failed'], 'timed_out': prepare_timing['timed_out'],
                                   'unknown': prepare_timing['unknown'], 'not_attempted': prepare_timing['not_attempted']},
            'labtest_e2e_wall_ms': {'n': len(labtest_latencies), 'p50': percentile(labtest_latencies, .5), 'p95': percentile(labtest_latencies, .95)},
            'quote_e2e_wall_ms': {'n': len(quote_latencies), 'p50': percentile(quote_latencies, .5), 'p95': percentile(quote_latencies, .95)},
            'haiku_usd_per_email': {'n': len(costs), 'mean': sum(costs) / len(costs) if costs else None, 'emails': per_email_cost},
            'real_unsaved_prepare': dict(prep) if workflow != 'triage' else {},
            'real_unsaved_lookup': {**dict(prep), 'not_attempted': prepare_timing['not_attempted'],
                                    'native_outcomes': dict(lookup_outcomes)} if workflow == 'triage' else None,
            'labtest_completion': dict(labtests) if workflow in WRITES else None,
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
    catalog = sub.add_parser('catalog', help='convert private, authorized mail.get exports into exact pane inputs')
    catalog.add_argument('--responses', required=True, help='JSONL with selected synced mail.get responses')
    catalog.add_argument('--out', required=True, help='new private JSONL path outside the repository')
    replay = sub.add_parser('replay', help='POST exact pane sources via staff gateway; no labels are read')
    replay.add_argument('--tier', required=True, choices=['A', 'B', 'C'])
    replay.add_argument('--inputs', required=True)
    replay.add_argument('--gateway', required=True, help='deployed gateway origin')
    replay.add_argument('--cookie-file', required=True, help='private file containing authorized Better Auth Cookie header')
    replay.add_argument('--origin', required=True, help='trusted browser Origin')
    replay.add_argument('--out', required=True, help='new private output JSON path')
    replay.add_argument('--timing-out', help='new private body-free timing JSON path')
    replay.add_argument('--concurrency', type=int, default=4)
    replay.add_argument('--run-id', type=uuid.UUID, default=None, help='optional unique UUID to record for this run')
    replay.add_argument('--timeout', type=int, default=300)
    replay.add_argument('--turn-timeout', type=int, default=720, help='total seconds to observe the model turn across signed SSE reconnects')
    replay.add_argument('--no-prepare', action='store_true')
    replay.add_argument('--quote-first', action='store_true', help='create quote artifacts using first eligible option per room; no draft or send')
    replay.add_argument('--historical-mailbox-id', help='authorized mailbox ID for legacy Tier C inputs')
    scoring = sub.add_parser('score', help='score saved replay against separate post-cutoff staff labels')
    scoring.add_argument('--replay', required=True)
    scoring.add_argument('--labels', required=True)
    scoring.add_argument('--prices', help='JSON file with explicitly sourced current per-million rates')
    args = parser.parse_args()
    if args.command == 'catalog':
        cases, rejected = [], Counter()
        for row in rows(args.responses):
            try:
                cases.append(catalog_case(row))
            except (KeyError, TypeError, ValueError, AttributeError) as exc:
                allowed = {'conversation_incomplete', 'address_missing', 'conversation_invalid', 'conversation_after_cutoff',
                           'html_only_requires_pane_mapper', 'selected_inbound_missing'}
                rejected[str(exc) if str(exc) in allowed else 'input_invalid'] += 1
        if len({c['id'] for c in cases}) != len(cases):
            raise ValueError('duplicate case id')
        save_jsonl_private(args.out, cases)
        print(json.dumps({'cases': len(cases), 'rejected': dict(rejected), 'output': args.out}))
    elif args.command == 'replay':
        private_destination(args.out)
        cases = rows(args.inputs)
        if args.tier == 'C':
            for case in cases:
                if 'id' not in case and 'decision_id' in case:
                    case['id'] = case['decision_id']
        if not 1 <= args.concurrency <= 12 or min(args.timeout, args.turn_timeout) < 1 or len({c['id'] for c in cases}) != len(cases):
            raise ValueError('invalid concurrency, timeout, or duplicate id')
        if pathlib.Path(args.out).exists():
            raise ValueError('output already exists')
        if args.timing_out:
            private_destination(args.timing_out)
            if pathlib.Path(args.timing_out).exists() or pathlib.Path(args.timing_out).resolve() == pathlib.Path(args.out).resolve():
                raise ValueError('timing output already exists or matches replay output')
        gateway = Gateway(args.gateway, pathlib.Path(args.cookie_file).read_text(), args.origin, args.timeout)
        limit = 12 if args.tier == 'C' else live_limit(gateway.json('/capabilities'))
        if args.concurrency > limit:
            raise ValueError('requested concurrency exceeds effective limit ' + str(limit))
        started = time.monotonic()
        run_id = str(args.run_id or uuid.uuid4())
        with concurrent.futures.ThreadPoolExecutor(max_workers=args.concurrency) as pool:
            results = list(pool.map(lambda c: run_case(gateway, c, not args.no_prepare, args.timeout, args.quote_first,
                                                      args.tier, args.historical_mailbox_id, run_id, args.turn_timeout), cases))
        elapsed_ms = round((time.monotonic() - started) * 1000)
        run = {'tier': args.tier, 'run_id': run_id, 'concurrency': args.concurrency, 'effective_limit': limit,
               'elapsed_ms': elapsed_ms, 'results': results}
        save_private(args.out, run)
        if args.timing_out:
            save_private(args.timing_out, {k: run[k] for k in ('tier', 'run_id', 'concurrency', 'effective_limit', 'elapsed_ms')}
                         | {'results': [timing_result(result) for result in results]})
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
