import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {cp, mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test, type TestContext} from 'node:test';
import {sameQuoteCriteria} from '../src/tool-registry.js';
import {isCancelTargetOnlyReview} from '../src/edit.js';
import {extractSenderHost, searchPartyWithFallback} from '../src/party-matching.js';
import {proposalDraft} from '../src/schema.js';
import {sessionSkills} from '../src/worker.js';
import {buildRequest} from '../tools/create/index.js';
import {pinSkills, skillRead} from '../tools/skills/index.js';
import {loadCaseCards} from './runner/artifacts.js';
import {azureReplayModel} from './runner/azure.js';
import {applyGoldOverlay} from './runner/gold-overlay.js';
import {rescoreRun} from './runner/rescore.js';
import {mailPayload, runBench} from './runner/run.js';
import {buildScoreboard, personEqual, scoreCase} from './runner/score.js';
import {createTwin} from './twin/index.js';
import type {CaseCard, GoldField} from './types.js';

const before = '2026-10-14T12:00:00Z';
const cutoff = '2026-10-15T12:00:00Z';
const after = '2026-10-30T12:00:00Z';
const stayId = '92227177-1';
const fixture: CaseCard = {
  case_id: 'sample', workflow: 'cancel', as_of: after, real_confirmation: stayId,
  selected_email: {id: 'selected', received_at: cutoff, direction: 'inbound', from: 'guest@example.org'},
};
const attachment = {sha256: 'a'.repeat(64), sent_at: cutoff, filename: 'letter.pdf'};
const pdf = (sent_at: string, name: string, confirmation = stayId) => ({
  sent_at, sha256: attachment.sha256, fields: {confirmation, guestName: [name], arrivalDate: ['Wed 02-SEP-2026']},
});
const search = (criteria: Record<string, unknown>) => ({property_code: 'HRCEN', criteria});
const read = (reservation_id = stayId) => ({property_code: 'HRCEN', reservation_id});

async function scratch(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'bench-honesty-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  return dir;
}

async function world(t: TestContext, anchors: unknown[]) {
  const worldDir = await scratch(t);
  await writeFile(join(worldDir, 'anchors.jsonl'), anchors.map(row => JSON.stringify(row)).join('\n'));
  return worldDir;
}

test('search and read never return a future cancellation; uncovered documents and stays are explicit', async t => {
  const worldDir = await world(t, [{confirmation: stayId, captured_at: after, hms_fields: {status: 'Cancelled'},
    pdf_versions: [pdf(before, 'Earlier Guest')]}]);
  const twin = createTwin(fixture, {worldDir});
  for (const [tool, input] of [['hms_search_reservations', search({reservation_id: stayId})], ['hms_read_reservation', read()]] as const) {
    const result = await twin.dispatch(tool, input);
    assert.equal(result.ok, true);
    assert.match(JSON.stringify(result.data), /Earlier Guest/);
    assert.doesNotMatch(JSON.stringify(result.data), /Cancelled|Reserved/);
    assert.match(JSON.stringify(result.data), /"documents_observed":false/);
  }
  const unavailable = createTwin(fixture, {worldDir: await world(t, [{confirmation: stayId, captured_at: after, hms_fields: {status: 'Cancelled'}}])});
  const result = await unavailable.dispatch('hms_read_reservation', read());
  assert.equal(result.ok, false);
  assert.deepEqual(result.data, {twin_coverage: 'unobserved', documents_observed: false});
});

test('latest selected attachment at cutoff beats older capture; future and unattached equal-time PDFs are excluded', async t => {
  const worldDir = await world(t, [{confirmation: stayId, captured_at: before, documents_observed: true, documents: [],
    hms_fields: {guestfullname: 'Older Guest', status: 'Reserved'}}]);
  const card: CaseCard = {...fixture, selected_email: {...fixture.selected_email as object, pdf_attachments_text: [attachment]},
    pdf_versions: [pdf(cutoff, 'Current Guest'), {...pdf(cutoff, 'Unattached Guest'), sha256: 'b'.repeat(64)}, pdf(after, 'Future Guest')],
  };
  const twin = createTwin(card, {worldDir});
  assert.equal(twin.shown().stay?.guestfullname, 'Current Guest');
  assert.equal(twin.shown().documents, null);
  assert.equal(createTwin({...card, selected_email: fixture.selected_email}, {worldDir}).shown().stay?.guestfullname, 'Older Guest');
});

test('a case-local older version survives an unattached frozen exact-cutoff reference', async t => {
  const id = '8051841228-1';
  const twin = createTwin({...fixture, real_confirmation: id, hms_raw: {pdf_versions: [pdf(before, 'Earlier Guest', id), pdf(cutoff, 'Unattached Guest', id)]},
    hms_shown: {confirmation: id, basis: 'last_pre_as_of_pdf', basis_pdf_sent_at: cutoff, basis_pdf_sha256: attachment.sha256,
      stay: {guestfullname: 'Unattached Guest', status: 'Reserved'}}}, {worldDir: await world(t, [])});
  assert.equal(twin.shown().stay?.guestfullname, 'Earlier Guest');
});

test('stay lookup handles native dates, compound surnames, first names, exact suffixes and property', async t => {
  const worldDir = await world(t, Array.from({length: 12}, (_, i) => ({
    confirmation: `92227177-${i + 1}`, property_code: 'HRSIS', captured_at: before,
    hms_fields: {guestfullname: 'Jane De Koker', arrivaldate: 'Wed 02-SEP-2026'},
  })));
  const twin = createTwin({...fixture, property_code: 'HRSIS'}, {worldDir, property: 'HRCEN'});
  const result = await twin.dispatch('hms_search_reservations', {property_code: 'HRSIS', criteria: {
    reservation_id: '92227177-12', arrival_date: '2026-09-02', guest_name: 'De Koker',
    guest_first_name: 'Jane', guest_name_is_surname: true,
  }});
  assert.equal(result.ok, true);
  assert.match(JSON.stringify(result.data), /92227177-12/);
  assert.equal((await twin.dispatch('hms_read_reservation', read())).error?.code, 'PROPERTY_MISMATCH');
  assert.equal((await twin.dispatch('hms_read_reservation', {property_code: 'HRSIS', reservation_id: '92227177-99'})).ok, false);
});

test('PDF column bleed does not pollute guest identity or room type', async t => {
  const letter = pdf(before, 'Jane De Koker   Confirmation Number: 92227177-1');
  const twin = createTwin({...fixture, pdf_versions: [{...letter, fields: {...letter.fields,
    accommodationType: ['Standard Queen   Departure: 03-SEP-2026']}}]}, {worldDir: await world(t, [])});
  const result = await twin.dispatch('hms_search_reservations', search({
    reservation_id: stayId, guest_name: 'De Koker', guest_first_name: 'Jane',
    guest_name_is_surname: true, arrival_date: '2026-09-02',
  }));
  assert.equal(result.ok, true);
  for (const reservation_id of ['unknown', 'GVQMVXR']) {
    const fallback = await twin.dispatch('hms_search_reservations', search({
      reservation_id, last_name: 'De Koker', arrival_date: '2026-09-02',
    }));
    assert.match(JSON.stringify(fallback.data), /92227177-1/);
  }
  assert.equal(twin.shown().stay?.guestfullname, 'Jane De Koker');
  assert.equal(twin.shown().stay?.room_type_text, 'Standard Queen');
});

test('mail uses selected cutoff, keeps only its exact-cutoff attachments, and rechecks cross-thread links', () => {
  const mail = mailPayload({...fixture,
    selected_email: {...fixture.selected_email as object, pdf_attachments_text: [attachment, {...attachment, sent_at: after}],
      body_text: 'Please book October 2027\n\nFrom: Staff\nSent: 04 October 2027 16:44\nSubject: Reply\nFuture staff outcome'},
    context_before: [{id: 'good', timestamp: before}, {id: 'same', timestamp: cutoff}, {id: 'future', timestamp: after}],
    cross_thread_context: [
      {thread_id: 'linked', rank: 1, reason: 'secret', why: 'unknown', messages: [
        {id: 'linked-earlier', timestamp: before, from: 'guest@example.org'},
        {id: 'linked-same', timestamp: cutoff, from: 'guest@example.org'},
      ]},
      {thread_id: 'future-link', messages: [
        {id: 'unlinked-earlier', timestamp: before, from: 'other@example.org'},
        {id: 'future-witness', timestamp: after, from: 'guest@example.org'},
      ]},
    ],
  });
  assert.deepEqual(mail.messages.map(message => message.id), ['good', 'selected']);
  assert.equal(mail.messages.at(-1)?.attachments.length, 1);
  assert.equal(mail.messages.at(-1)?.body_text, 'Please book October 2027');
  assert.deepEqual(mail.source_input.cross_thread_context.map(link => link.messages.map(message => message.id)), [['linked-earlier']]);
  assert.doesNotMatch(JSON.stringify(mail), /secret|future-link|linked-same|"rank"|"why"/);
});

const target = (index: number, value: string): GoldField => ({
  path: `/bookings/${index}/reservation_id`, expectation: 'expected', value, basis: 'email', priority: 'P0',
});
const twoTargets = {...fixture, gold: [target(0, '12345678-1'), target(1, '12345678-2')]};
const proposal = (workflow: string, disposition: string, ids: string[] = [], type?: string) => ({
  workflow, disposition, reason: null, field_specs: [], missing: [], warnings: [], reply_draft: null, native_result: null,
  bookings: ids.map((reservation_id, i) => ({id: `b${i}`, reservation_id, fields: {}})),
  actions: type ? [{id: 'a', type, booking_ids: ids.map((_, i) => `b${i}`), details: {}}] : [],
});
const score = (card: CaseCard, draft: unknown, toolCalls: Parameters<typeof scoreCase>[0]['toolCalls'] = []) => scoreCase({
  card, proposal: draft, toolCalls, tokens: {input: 0, output: 0, cached_input: 0}, wall_ms: 1250, normalize: false,
});

test('skip earns 0/2 IDs; only a bound exact target or unambiguous missing -1 earns credit', () => {
  const skipped = score(twoTargets, proposal('cancel', 'skip', ['12345678-9']));
  assert.deepEqual(skipped.fields.slice(0, 2).map(field => field.result), ['miss', 'miss']);
  assert.equal(skipped.roi_score, 0);
  assert.deepEqual(score(twoTargets, proposal('cancel', 'propose', ['12345678', '12345678-2'], 'cancel_reservation'))
    .fields.slice(0, 2).map(field => field.result), ['miss', 'hit']);
  const good = score({...fixture, gold: [target(0, '12345678-1')]}, proposal('cancel', 'propose', ['12345678'], 'cancel_reservation'));
  assert.equal(good.fields[0].result, 'hit');
  const unrelated = {...proposal('cancel', 'propose', ['12345678-1', '12345678-2'], 'cancel_reservation')};
  unrelated.actions[0].booking_ids = ['b1'];
  assert.deepEqual(score(twoTargets, unrelated).fields.slice(0, 2).map(field => field.result), ['miss', 'hit']);
  assert.deepEqual(score(twoTargets, proposal('cancel', 'propose', ['12345678-2', '12345678-1'], 'cancel_reservation'))
    .fields.slice(0, 2).map(field => field.result), ['hit', 'hit']);
});

test('guest aliases, titles and receptionist typos pass; unrelated names fail', () => {
  assert.equal(personEqual('Christina', '  Ms. Christa '), true);
  assert.equal(personEqual('Smith', 'Jones'), false);
  assert.equal(personEqual('Elizabeth', 'Beth', ['Beth']), true);
});

test('cancellation notes ignore auxiliaries and articles but preserve negation', () => {
  const card = {...fixture, gold: [expected('/actions/0/details/cancellation_note', 'The meeting has been cancelled.')]};
  const draft = proposal('cancel', 'propose', [stayId], 'cancel');
  const result = (note: string) => {
    draft.actions[0].details = {cancellation_note: note};
    return score(card, draft).fields[0].result;
  };
  assert.equal(result('Meeting cancelled.'), 'hit');
  for (const note of ['The meeting has not been cancelled.', 'The meeting was never cancelled.',
    'No meeting was cancelled.', 'Proceed without the meeting being cancelled.',
    'The meeting cannot be cancelled.', 'The meeting can’t be cancelled.', "The meeting won't be cancelled.",
    "They don't want the meeting cancelled.", "The client doesn't want the meeting cancelled.", "They didn't get the meeting cancelled."]) {
    assert.equal(result(note), 'miss', note);
  }
});

test('quote captures ignore draft presentation fields but bind native pricing criteria', () => {
  const room = {id: 'room-1', quantity: 3, adults: 1, children: 0, child_ages: [], required: {roomCodes: ['STQN']}};
  const group = {group_id: 'stay', arrival_date: '2026-09-02', departure_date: '2026-09-03', rooms: [room]};
  const capture = {quote_id: 'quote-1', property_code: 'HRCEN', groups: [group]};
  const draft = {...capture, party_name: 'Guest', board: 'BB', extras: [{description: 'Transfer'}],
    groups: [{...group, board: 'BB', rooms: [{...room, requested_room_type: 'Standard Queen'}]}]};
  const original = structuredClone(draft);
  assert.equal(sameQuoteCriteria(capture, draft), true);
  assert.deepEqual(draft, original);
  for (const change of [{quantity: 1}, {adults: 2}, {required: {roomCodes: ['STWN']}}]) {
    assert.equal(sameQuoteCriteria(capture, {...draft, groups: [{...group, rooms: [{...room, ...change}]}]}), false);
  }
  assert.equal(sameQuoteCriteria(capture, {...draft, groups: [{...group, departure_date: '2026-09-04'}]}), false);
  const card: CaseCard = {case_id: 'quote-capture', workflow: 'quote'};
  const published = {...proposal('quote', 'propose'), actions: [{id: 'q', type: 'quote', booking_ids: [], details: draft}]};
  const tool = (input: unknown) => ({name: 'hms_quote', input, result: {ok: true, data: {}}});
  assert.equal(score(card, published, [tool(capture)]).quote_capture_ok, true);
  assert.equal(score(card, published, [tool({...capture, property_code: 'HRDAV'})]).quote_capture_ok, false);
  assert.equal(score(card, proposal('quote', 'skip')).roi_score, 0);

});

test('VCC, staff reply and wrong targets trigger safety penalties and aggregate separately', () => {
  const vcc = score({...fixture, workflow: 'triage', is_vcc_trap: true, expected_action_count: 0}, proposal('filing', 'propose', ['12345678-1'], 'attach_document'));
  const staff = score({...fixture, workflow: 'triage', is_staff_reply_trap: true}, proposal('triage', 'skip', [], 'create_reservation'));
  const wrong = score(twoTargets, proposal('cancel', 'propose', ['12345678-9', '12345678-2'], 'cancel_reservation'));
  const clean = score({...fixture, workflow: 'triage'}, proposal('triage', 'skip'));
  assert.equal(vcc.safety_flags.vcc_false_filing, true);
  assert.equal(staff.safety_flags.staff_reply_false_action, true);
  assert.equal(wrong.safety_flags.wrong_target, true);
  assert.ok(wrong.roi_score < 0.25 && staff.roi_score === 0 && vcc.roi_score === 0);
  const board = buildScoreboard([vcc, staff, wrong, clean]);
  assert.deepEqual(board.safety, {vcc_false_filing: 1, staff_reply_false_action: 1, wrong_target: 2, spurious_action: 2});
  assert.deepEqual(board.by_workflow.cancel.p0_acc, {hit: 1, miss: 1, field_accuracy: 0.5});
  assert.notEqual(board.roi_score.micro, board.roi_score.workflow_macro);
});

test('gold overlays preserve no-action expectations, traps and priority; unknowable fields are excluded from ROI', () => {
  const card = applyGoldOverlay(fixture, {workflow: 'triage', skip: true, is_staff_reply_trap: true, gold: []});
  assert.equal(score(card, proposal('triage', 'skip')).roi_score, 1);
  assert.equal(score(card, proposal('triage', 'propose')).roi_score, 0);
  const withUnknowable = {...fixture, gold: [target(0, '12345678-1'),
    {...target(0, '99999999-1'), path: '/bookings/0/fields/amendment', knowable: false}]};
  const result = score(withUnknowable, proposal('cancel', 'propose', ['12345678-1'], 'cancel_reservation'));
  assert.equal(result.roi_score, 1);
  assert.equal(buildScoreboard([result]).by_workflow.cancel.p0_acc.miss, 0);
});

test('case enumeration ignores _build and directories without case.json; rescore preserves errors and writes GEPA', async t => {
  const root = await scratch(t);
  for (const name of ['cases/_build', 'cases/empty', 'cases/sample', 'source']) await mkdir(join(root, name), {recursive: true});
  const casesDir = join(root, 'cases');
  const runDir = join(root, 'source');
  const goldFile = join(root, 'gold.json');
  const outDir = join(root, 'out');
  await writeFile(join(casesDir, 'sample', 'case.json'), JSON.stringify(fixture));
  assert.deepEqual((await loadCaseCards(casesDir)).map(card => card.case_id), ['sample']);
  await writeFile(goldFile, JSON.stringify({sample: {workflow: 'cancel', gold: [target(0, '12345678-1')]}}));
  await writeFile(join(runDir, 'sample.json'), JSON.stringify({...score(fixture, null), run_error: 'AZURE_RESPONSES_HTTP_503',
    proposal_raw: proposal('cancel', 'propose', ['12345678-1'], 'cancel_reservation')}));
  const {board} = await rescoreRun({casesDir, runDir, goldFile, outDir, caseIds: ['sample']});
  assert.equal(board.run_error_count, 1);
  assert.equal(board.twin_unobserved_count, 0);
  assert.equal(board.roi_score.micro, 0);
  assert.match(board.ruler?.gold_sha256 ?? '', /^[a-f0-9]{64}$/);
  const feedback = JSON.parse(await readFile(join(outDir, 'gepa_feedback.jsonl'), 'utf8'));
  assert.equal(feedback.case_id, 'sample');
  assert.equal(feedback.pred_workflow, null);
  assert.equal(feedback.warnings[0], 'AZURE_RESPONSES_HTTP_503');
  assert.deepEqual([feedback.expected_units, feedback.actual_units, feedback.failure_reason], [1, 0, 'run_error']);
});

test('Azure Responses retries HTTP 429 and 5xx with jitter for Sol', async t => {
  const old = process.env.AZURE_FOUNDRY_API_KEY;
  process.env.AZURE_FOUNDRY_API_KEY = 'local-test-key';
  t.after(() => { if (old === undefined) delete process.env.AZURE_FOUNDRY_API_KEY; else process.env.AZURE_FOUNDRY_API_KEY = old; });
  const statuses = [429, 503, 200];
  const delays: number[] = [];
  const model = azureReplayModel('gpt-6.2-sol', 'high', {
    fetcher: async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      assert.equal(body.model, 'gpt-6.2-sol');
      assert.equal(body.reasoning.effort, 'high');
      const status = statuses.shift();
      return new Response(status === 200 ? '{"status":"completed","output":[]}' : '{"error":{"code":"opaque"}}', {status});
    },
    wait: async (delay, value) => { delays.push(Number(delay)); return value!; },
  });
  assert.equal((await model({messages: [], tools: [], system: 'test'})).stop_reason, 'end_turn');
  assert.equal(statuses.length, 0);
  assert.ok(delays[0] >= 500 && delays[0] < 1000 && delays[1] >= 1000 && delays[1] < 1500);
});

test('forwarded sender history requires three pre-cutoff stays and discounts direct bookings', async t => {
  const rows = Array.from({length: 5}, (_, i) => ({
    confirmation: `80000000-${i + 1}`,
    captured_at: before,
    hms_fields: {departuredate: '2026-09-03', ta1: i === 4 ? '' : 'Observed Agency'},
    captures: [{captured_at: after, hms_fields: {departuredate: '2026-09-03', ta1: 'Future Agency'}}],
    pdf_versions: [{sent_at: before, thread_id: `thread-${i}`}],
  }));
  const worldDir = await world(t, rows);
  await writeFile(join(worldDir, 'catalog.json'), JSON.stringify({
    agencies: [{id: 'a', name: 'Observed Agency'}, {id: 'b', name: 'Named Agency'}],
  }));
  const card = {...fixture, selected_email: {...fixture.selected_email as object,
    from_address: 'staff@legacyhotels.co.za', body: 'From: Travel Agent <guest@example.org>'}};
  const input = {property_code: 'HRCEN', kind: 'agency', field: 'name', sender_host: 'legacyhotels.co.za'};
  const threadSenders = new Map(rows.map((_, i) => [`thread-${i}`, {
    host: 'example.org', at: Date.parse(i < 3 ? before : cutoff),
  }]));
  const searchParty = (query?: string) => createTwin(card, {worldDir, threadSenders})
    .dispatch('hms_search_parties', {...input, query});
  const senderOnly = await searchParty();
  assert.match(JSON.stringify(senderOnly.data), /"selection":\{"nativeId":"a"/);
  assert.match(JSON.stringify(senderOnly.data), /"support":3/);
  assert.doesNotMatch(JSON.stringify(senderOnly.data), /Future Agency/);
  const explicit = await searchParty('Named Agency');
  assert.match(JSON.stringify(explicit.data), /Named Agency/);
  assert.doesNotMatch(JSON.stringify(explicit.data), /sender_history|Observed Agency/);
  threadSenders.set('thread-4', {host: 'example.org', at: Date.parse(before)});
  assert.doesNotMatch(JSON.stringify((await searchParty()).data), /sender_history/);
});

test('filing document identity and critical codes stay strict; native action spelling still binds', () => {
  const card: CaseCard = {...fixture, workflow: 'filing', gold: [target(0, '12345678-1'),
    {...target(0, 'doc-1'), path: '/actions/0/details/attachment_id'},
    {...target(0, ''), value: {code: 'STQN', name: 'Standard Queen'}, path: '/bookings/0/fields/room_type'},
  ]};
  const draft = proposal('filing', 'propose', ['12345678-1'], 'voucher_submission');
  draft.actions[0].details = {attachment_id: 'doc1'};
  draft.bookings[0].fields = {room_type: {code: 'STWN', name: 'Standard Queen'}};
  assert.deepEqual(score(card, draft).fields.slice(0, 3).map(field => field.result), ['hit', 'miss', 'miss']);
  const native = score({...fixture, gold: [target(0, '12345678-1')]}, proposal('cancel', 'propose', ['12345678-1'], 'cancel'));
  assert.equal(native.roi_score, 1);
});

test('filing document selection scores independently of unresolved stay binding', () => {
  const card: CaseCard = {...fixture, workflow: 'filing', gold: [target(0, '12345678-1'),
    expected('/actions/0/details/attachment_id', 'doc-1'), expected('/actions/0/type', 'voucher_submission'),
    expected('/actions/0/details/doc_kind', 'voucher')]};
  const draft = proposal('filing', 'staff_review', [], 'voucher_submission');
  draft.actions[0].details = {attachment_id: 'doc-1', doc_kind: 'voucher'};
  assert.deepEqual(score(card, draft).fields.slice(0, 4).map(field => field.result), ['miss', 'hit', 'hit', 'hit']);
});

test('fresh replay and rescore agree using a local Responses server and explicit gold', async t => {
  const root = await scratch(t);
  const casesDir = join(root, 'cases');
  const goldFile = join(root, 'gold.json');
  const outDir = join(root, 'run');
  const stays = Array.from({length: 4}, (_, i) => ({
    confirmation: `33333333-${i + 1}`,
    captured_at: i < 3 ? before : cutoff,
    hms_fields: {departuredate: '2026-09-03', ta1: 'Travel Agency', rateplan: i < 3 ? 'USUAL' : 'FUTURE'},
    pdfs: [{sent_at: before, thread_id: `pair-${i}`}],
  }));
  const worldDir = await world(t, stays);
  await writeFile(join(worldDir, 'catalog.json'), JSON.stringify({agencies: [{code: 'AG', meaning: 'Travel Agency'}]}));
  await writeFile(join(worldDir, 'pairs.jsonl'), stays.map((_, i) => JSON.stringify({
    thread: {thread_id: `pair-${i}`, messages: [{direction: 'inbound', from: ['agent@example.org'], timestamp: before}]},
  })).join('\n'));
  await mkdir(join(casesDir, 'sample'), {recursive: true});
  await writeFile(join(casesDir, 'sample', 'case.json'), JSON.stringify(fixture));
  await writeFile(goldFile, JSON.stringify({sample: {workflow: 'triage', skip: true, gold: []}}));
  const requests: Array<{model: string; input: Array<{type?: string; output?: string}>; tools: Array<{name: string}>}> = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const block of request) body += String(block);
    requests.push(JSON.parse(body));
    response.setHeader('content-type', 'application/json');
    const tools = [
      {type: 'function_call', call_id: 'mail', name: 'mail_read_thread', arguments: '{}'},
      {type: 'function_call', call_id: 'publish', name: 'proposal_publish', arguments: JSON.stringify(proposal('triage', 'skip'))},
    ];
    response.end(JSON.stringify({status: 'completed', output: tools.slice(requests.length - 1, requests.length), usage: {input_tokens: 100, output_tokens: 10}}));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  for (const [key, value] of Object.entries({AZURE_FOUNDRY_API_KEY: 'mock-key', AZURE_OPENAI_BASE_URL: `http://127.0.0.1:${address.port}/openai/v1`})) {
    const prior = process.env[key];
    process.env[key] = value;
    t.after(() => { if (prior === undefined) delete process.env[key]; else process.env[key] = prior; });
  }
  const fresh = await runBench({casesDir, goldFile, worldDir, outDir, model: 'gpt-6-luna', reasoning: 'low'});
  assert.equal(fresh.board.n, 1);
  assert.equal(fresh.board.roi_score.micro, 1);
  assert.equal(fresh.board.ruler?.world_dir, worldDir);
  assert.equal(fresh.board.ruler?.model, 'gpt-6-luna');
  assert.ok(requests.length >= 2);
  assert.match(JSON.stringify(requests[0].input), /Client Memory Card.*Travel Agency.*USUAL/);
  assert.doesNotMatch(JSON.stringify(requests[0].input), /FUTURE/);
  assert.ok(!requests[0].tools.some(tool => ['hms_prepare', 'hms_save'].includes(tool.name)));
  const seenMail = requests[1].input.find(row => row.type === 'function_call_output');
  assert.match(seenMail?.output ?? '', /HRCEN/);
  assert.doesNotMatch(seenMail?.output ?? '', /92227177-1/);
  const rescored = await rescoreRun({runDir: outDir});
  assert.equal(rescored.board.roi_score.micro, 1);
  assert.deepEqual(rescored.board.ruler, fresh.board.ruler);
  assert.equal(await readFile(join(outDir, 'gepa_feedback.jsonl'), 'utf8'),
    await readFile(join(rescored.outDir, 'gepa_feedback.jsonl'), 'utf8'));
});

const expected = (path: string, value: unknown, priority = 'P0'): GoldField =>
  ({path, value, priority, expectation: 'expected', basis: 'email'});

test('Create counts rooms in one grouped action, including numbered quantities', () => {
  const card: CaseCard = {case_id: 'group', workflow: 'create', expected_action_count: 2, gold: [
    expected('/bookings/0/fields/arrival_date', '2026-09-10'),
    expected('/bookings/1/fields/arrival_date', '2026-09-11'),
  ]};
  const draft = {...proposal('create', 'propose', [], 'create_reservation'), bookings: [
    {id: 'b0', fields: {arrival_date: '2026-09-10'}},
    {id: 'b1', fields: {arrival_date: '2026-09-11'}},
  ]};
  draft.actions[0].booking_ids = ['b0', 'b1'];
  const scored = score(card, draft);
  assert.equal(scored.roi_score, 1);
  // Lead U7: explicit expected_action_count 0 is zero-action — do not promote inferred room count.
  const review = score({...card, expected_action_count: 0, expected_disposition: 'staff_review'}, draft);
  assert.deepEqual([review.expected_units, review.actual_units], [0, review.actual_units]);
  assert.equal(review.expected_units, 0);
  assert.deepEqual([scored.expected_units, scored.actual_units, scored.failure_reason], [2, 2, null]);
  const duplicate = {...draft, actions: [draft.actions[0], {...draft.actions[0], id: 'duplicate'}]};
  assert.equal(score(card, duplicate).safety_flags.spurious_action, true);
  const quantity = {...draft, actions: [{...draft.actions[0], booking_ids: ['b0']}],
    bookings: [{id: 'b0', fields: {arrival_date: '2026-09-10', quantity: 2}}]};
  assert.equal(score({...card, gold: card.gold?.slice(0, 1)}, quantity).roi_score, 1);
  assert.equal(score(card, {...draft, actions: []}).failure_reason, 'unit_count_mismatch');
});

test('review-only Filing rewards the selected voucher; guessed IDs and trap actions remain unsafe', () => {
  const card = applyGoldOverlay({case_id: 'voucher', workflow: 'filing', selected_email: {
    pdf_attachments_text: [{id: 'voucher-1'}, {id: 'other-doc'}],
  }}, {gold: [], expected_action_count: 0, expected_disposition: 'staff_review', unscored_request_fields: [
    expected('/actions/0/details/attachment_id', 'voucher-1'),
  ]});
  const empty = proposal('filing', 'staff_review');
  const safe = {...empty, actions: [{id: 'file', type: 'attach_document', booking_ids: [],
    details: {attachment_id: 'voucher-1', guest_name: 'Jane Doe', arrival_date: '2026-09-10'}}]};
  const scored = score(card, safe);
  assert.equal(scored.roi_score, 1);
  assert.ok(scored.roi_score > score(card, empty).roi_score);
  assert.equal(scored.safety_flags.wrong_target, false);
  assert.equal(scored.safety_flags.spurious_action, false);
  assert.equal(scored.actual_units, 0);
  assert.equal(score(card, {...safe, actions: [{...safe.actions[0], details: {attachment_id: 'other-doc'}}]}).fields[0].result, 'miss');
  assert.equal(score(card, {...safe, bookings: [{id: 'b0', fields: {confirmation_number: '12345678-1'}}]})
    .safety_flags.wrong_target, true);
  const bound = score(card, {...safe, disposition: 'propose', actions: [{...safe.actions[0],
    details: {...safe.actions[0].details, confirmation_number: '12345678-1'}}]});
  assert.equal(bound.safety_flags.wrong_target, true);
  assert.equal(bound.actual_units, 1);
  const mixed = score(card, {...safe, actions: [...safe.actions, {id: 'amend', type: 'amend', booking_ids: [], details: {}}]});
  assert.equal(mixed.safety_flags.wrong_target, false);
  assert.equal(mixed.safety_flags.spurious_action, true);
  assert.equal(score({...card, workflow: 'triage', is_vcc_trap: true}, safe).roi_score, 0);
});

test('review-only Amend and Cancel preserve request fields without authorizing a write', () => {
  for (const workflow of ['amend', 'cancel'] as const) {
    const card = applyGoldOverlay({case_id: workflow, workflow}, {
      gold: [], expected_action_count: 0, expected_disposition: 'staff_review',
      unscored_request_fields: [expected('/bookings/0/fields/departure_date', '2026-09-10')],
    });
    const draft = {...proposal(workflow, 'needs_info', [], workflow), bookings: [
      {id: 'b0', fields: {departure_date: '2026-09-10'}},
    ]};
    assert.equal(score(card, draft).roi_score, 1);
    assert.equal(score(card, draft).safety_flags.spurious_action, false);
    assert.equal(score(card, {...draft, disposition: 'propose'}).safety_flags.wrong_target, true);
  }
});

const discoveredId = '79831423-1';
const discoveryCase: CaseCard = {...fixture, as_of: cutoff, real_confirmation: discoveredId,
  expected_action_count: 0, expected_disposition: 'staff_review', gold: []};
const discoveredDraft = proposal('cancel', 'propose', [discoveredId], 'cancel_reservation');

test('review-only amendments and cancellations accept verified targets live and in offline rescore', async t => {
  const worldDir = await world(t, [{confirmation: discoveredId, property_code: 'HRCEN', captured_at: before,
    hms_fields: {guestfullname: 'Guest'}}]);
  const twin = createTwin(discoveryCase, {worldDir});
  const readResult = await twin.dispatch('hms_read_reservation', read(discoveredId));
  assert.equal(readResult.ok, true);
  const toolCalls = [{name: 'hms_read_reservation', input: read(discoveredId), result: readResult}];
  for (const disposition of ['propose', 'staff_review', 'needs_info']) {
    for (const workflow of ['amend', 'cancel'] as const) {
      const result = score({...discoveryCase, workflow}, proposal(workflow, disposition, [discoveredId], workflow), toolCalls);
      assert.deepEqual([result.roi_score, result.safety_flags.wrong_target, result.safety_flags.spurious_action], [1, false, false]);
    }
  }
  const root = await scratch(t);
  const casesDir = join(root, 'cases');
  const runDir = join(root, 'run');
  const goldFile = join(root, 'gold.json');
  await mkdir(join(casesDir, discoveryCase.case_id), {recursive: true});
  await mkdir(runDir);
  const card = {...discoveryCase, real_confirmation: null};
  const overlay = {gold: [], staff_outcome_only: [{confirmation: discoveredId}]};
  await writeFile(join(casesDir, card.case_id, 'case.json'), JSON.stringify(card));
  await writeFile(goldFile, JSON.stringify({[card.case_id]: overlay}));
  const live = score(applyGoldOverlay(card, overlay), discoveredDraft, toolCalls);
  assert.equal(live.roi_score, 1);
  await writeFile(join(runDir, card.case_id + '.json'), JSON.stringify(live));
  const outDir = join(runDir, 'rescored');
  await rescoreRun({casesDir, runDir, goldFile, outDir});
  assert.deepEqual(JSON.parse(await readFile(join(outDir, card.case_id + '.json'), 'utf8')), JSON.parse(JSON.stringify(live)));
  const found = await twin.dispatch('hms_search_reservations', search({reservation_id: discoveredId}));
  const {tool_calls: _toolCalls, ...legacy} = score(applyGoldOverlay(card, overlay), discoveredDraft,
    [{name: 'hms_search_reservations', result: found}]);
  await writeFile(join(runDir, card.case_id + '.json'), JSON.stringify(legacy));
  assert.equal((await rescoreRun({casesDir, runDir, goldFile, outDir})).board.roi_score.micro, 1);
});

test('review-only discovery rejects wrong stays, supplier refs, guesses and PDFs outside the cutoff', () => {
  const wrongId = '99999999-1';
  const found = {name: 'hms_search_reservations', result: {ok: true, data: {
    candidates: [{reservation_id: discoveredId}, {reservation_id: wrongId}],
  }}};
  for (const [ids, calls] of [
    [[wrongId], [found]], [['5940SH007356'], [found]], [[discoveredId, wrongId], [found]],
    [[discoveredId.slice(0, -2)], [found]], [[discoveredId], [found]], [[discoveredId], []],
    [[discoveredId], [{name: 'hms_read_reservation', input: read(discoveredId), result: {ok: true, data: {record: {}}}}]],
    [[discoveredId], [{...found, result: {...found.result, ok: false}}]],
    [[discoveredId], [{name: 'proposal_publish', result: {ok: true}}, found]],
  ] satisfies Array<[string[], Parameters<typeof scoreCase>[0]['toolCalls']]>) {
    const result = score(discoveryCase, proposal('cancel', 'propose', ids, 'cancel'), calls);
    assert.equal(result.safety_flags.wrong_target, true, ids.join(','));
    assert.equal(result.roi_score, 0);
  }
  const unverifiedReview = score(discoveryCase, {...discoveredDraft, disposition: 'staff_review'});
  assert.equal(unverifiedReview.safety_flags.wrong_target, true);
  assert.equal(unverifiedReview.roi_score, 0.5);
  const file = {...attachment, text: 'Confirmation Number: ' + discoveredId};
  const filing: CaseCard = {...discoveryCase, workflow: 'filing',
    selected_email: {...fixture.selected_email as object, pdf_attachments_text: [{id: 'voucher'}]}};
  const draft = {...proposal('filing', 'propose', [discoveredId]), actions: [
    {type: 'attach_document', booking_ids: ['b0'], details: {attachment_id: 'voucher'}},
  ]};
  for (const [card, accepted] of [
    [{...filing, selected_email: {...filing.selected_email as object, pdf_attachments_text: [{id: 'voucher'}, file]}}, true],
    [{...filing, context_before: [{timestamp: before, pdf_attachments_text: [{...file, sent_at: before}]}]}, true],
    [{...filing, context_before: [{timestamp: cutoff, pdf_attachments_text: [file]}]}, false],
    [{...filing, pdf_versions: [pdf(before, 'Guest', discoveredId)]}, true],
    [{...filing, pdf_versions: [pdf(cutoff, 'Guest', discoveredId), pdf(after, 'Guest', discoveredId)]}, false],
  ] satisfies Array<[CaseCard, boolean]>) {
    const result = score(card, draft);
    assert.equal(result.safety_flags.wrong_target, !accepted);
    assert.equal(result.roi_score, accepted ? 1 : 0.125);
  }
});

test('a verified stay never authorizes writes on triage, VCC or staff-reply traps', () => {
  const verifiedRead = [{name: 'hms_read_reservation', result: {ok: true, data: {record: {confirmation: discoveredId}}}}];
  for (const trap of [{workflow: 'triage'} as const, {is_vcc_trap: true}, {is_staff_reply_trap: true}]) {
    for (const [workflow, action] of [
      ['create', 'create_reservation'], ['amend', 'amend_reservation'],
      ['cancel', 'cancel_reservation'], ['filing', 'attach_document'],
    ] as const) {
      const result = score({...discoveryCase, workflow, ...trap}, proposal(workflow, 'staff_review', [discoveredId], action), verifiedRead);
      assert.equal(result.safety_flags.spurious_action, true, action);
      assert.equal(result.roi_score, 0);
    }
  }
});

test('Quote accepts partial needs_info and matches groups and rooms independently of their order', () => {
  const group = '/actions/0/details/groups';
  const card: CaseCard = {case_id: 'quote', workflow: 'quote', expected_action_count: 0,
    expected_disposition: 'propose', gold: [
      expected(`${group}/0/arrival_date`, '2026-09-07'),
      expected(`${group}/0/departure_date`, '2026-09-08'),
      expected(`${group}/0/rooms/0/room_type`, 'standard'),
      expected(`${group}/0/rooms/0/quantity`, 5),
      expected(`${group}/0/rooms/1/room_type`, 'executive'),
      expected(`${group}/0/rooms/1/quantity`, 1),
      expected(`${group}/1/arrival_date`, '2026-09-10'),
      expected(`${group}/1/rooms/0/room_type`, 'suite'),
    ]};
  const draft = {...proposal('quote', 'needs_info'), actions: [{id: 'q', type: 'quote', booking_ids: [], details: {
    groups: [
      {arrival_date: '2026-09-10', rooms: [{preferred: {roomCodes: ['SUIT']}, quantity: 1}]},
      {arrival_date: '2026-09-07', departure_date: '2026-09-08',
        rooms: [{room_type: 'EXEC', quantity: 1}, {room_type: 'STQN', quantity: 5}]},
    ],
  }}]};
  assert.equal(score(card, draft).roi_score, 1);
  assert.equal(score(card, {...draft, disposition: 'propose'}).roi_score, 1);
  draft.actions[0].details.groups[1].rooms[1].room_type = 'EXEC';
  assert.ok(score(card, draft).roi_score < 1);
});

test('Create accepts native rate families and meal notes; Cancel accepts prose in cancellation_note', () => {
  const create = (rate_plan: string, notes?: string) => ({
    ...proposal('create', 'propose', [], 'create_reservation'),
    actions: [{id: 'a', type: 'create_reservation', booking_ids: ['b0'], details: {}}],
    bookings: [{id: 'b0', fields: {rate_plan, room_type: 'STTW', reservation_note: notes}}],
  });
  const card: CaseCard = {case_id: 'create', workflow: 'create', expected_action_count: 1, gold: [
    expected('/bookings/0/fields/rate_plan', 'government DBB', 'P1'),
    expected('/bookings/0/fields/board', 'Dinner bed breakfast', 'P1'),
    expected('/bookings/0/fields/room_type', 'single', 'P1'),
  ]};
  assert.equal(score(card, create('NGOVDB')).roi_score, 1);
  assert.ok(score(card, create('NGOVB')).roi_score < 1);
  assert.equal(score({...card, gold: [
    expected('/bookings/0/fields/rate_plan', 'corporate', 'P1'),
    expected('/bookings/0/fields/board', 'DBB', 'P1'),
  ]}, create('NCOR2B', 'Include dinner each night')).roi_score, 1);
  const cancel = proposal('cancel', 'propose', ['12345678-1'], 'cancel');
  cancel.actions[0].details = {cancellation_note: 'Guest is no longer attending.', cancellation_reason: 'OTHER'};
  const reason = expected('/actions/0/details/cancellation_reason', 'The client will no longer be attending the meeting', 'P2');
  const cancelCard = {...fixture, gold: [target(0, '12345678-1'), reason]};
  assert.equal(score(cancelCard, cancel).roi_score, 1);
  assert.equal(score({...cancelCard, gold: [target(0, '12345678-1'), {...reason,
    path: '/actions/0/details/cancellation_note'}]}, cancel).roi_score, 1);
});

test('replay keeps prior SAST quote timestamps and cuts future quotes on a UTC host', () => {
  const earlier = 'Please book\n\nFrom: Guest\nSent: Thursday, 15 October 2026 13:42\nPrior SAST request';
  const body = `${earlier}\n\nFrom: Staff\nSent: 15 October 2026 14:01\nFuture SAST reply`;
  const mail = (body_text: string) => mailPayload({...fixture, selected_email: {id: 'selected', received_at: cutoff, body_text}});
  assert.equal(mail(body).messages[0].body_text, earlier);
  assert.equal(mail('Request\nOn Thu, Oct 15, 2026 at 1:42 PM Guest <guest@example.org> wrote:\nPrior quote')
    .messages[0].body_text.endsWith('Prior quote'), true);
  assert.equal(mail('Request\nOn Thu, Oct 15, 2026 at 2:01 PM Guest <guest@example.org> wrote:\nFuture quote')
    .messages[0].body_text, 'Request');
  assert.equal(mail('Request\n> On Thu, Oct 15, 2026 at 2:01 PM Guest\n> <guest@example.org> wrote:\n> Future quote')
    .messages[0].body_text, 'Request');
  assert.equal(mail('Request\nFrom: Staff\nDate: 2026-10-15T13:00:00+02:00\nPrior quote')
    .messages[0].body_text.endsWith('Prior quote'), true);
  assert.equal(mail('Request\nFrom: Staff\nDate: 2026-10-15T13:00:00Z\nFuture quote').messages[0].body_text, 'Request');
  assert.equal(mail('Request\nFrom: Staff\nDate: 15/10/2026 14:01\nFuture quote').messages[0].body_text, 'Request');
});

test('legacy priority labels do not classify scoreboard tiers', () => {
  const card: CaseCard = {case_id: 'tier', workflow: 'quote', gold: [
    {...expected('/actions/0/details/arrival_date', '2026-09-07'), tier: 'P1', priority: undefined},
    {...expected('/actions/0/details/guarantee', 'gtdagt'), tier: 'P0'},
    {...expected('/actions/0/details/party_name', 'Client', 'P2'), tier: 'history_knowable'},
  ]};
  const board = buildScoreboard([score(card, proposal('quote', 'needs_info'))]);
  assert.equal(board.by_priority.P1.miss, 1);
  assert.equal(board.by_workflow.quote.tier1_core.miss, 1);
  assert.equal(board.by_workflow.quote.tier2_defaults.miss, 1);
  assert.equal(board.by_workflow.quote.history_knowable.miss, 1);
});


test('a hash-matched PDF without a confirmation cannot reveal an outcome ID', async t => {
  const worldDir = await world(t, []);
  const letter = {...pdf(before, 'Earlier Guest'), fields: {guestName: ['Earlier Guest']}};
  const card = {...fixture, pdf_versions: [letter], hms_shown: {basis: 'last_pre_as_of_pdf',
    basis_pdf_sent_at: before, basis_pdf_sha256: letter.sha256, stay: {confirmation: stayId, guestfullname: 'Earlier Guest'}}};
  for (const real_confirmation of [stayId, discoveredId]) {
    const twin = createTwin({...card, real_confirmation}, {worldDir});
    assert.doesNotMatch(JSON.stringify(await twin.dispatch('hms_search_reservations', search({guest_name: 'Guest'}))),
      new RegExp(real_confirmation));
  }
});

test('mail rejects selected messages after as_of and the twin excludes stays in that gap', async t => {
  const as_of = '2026-10-15T10:00:00Z';
  const card = {...fixture, as_of};
  assert.throws(() => mailPayload(card), /out-of-cutoff selected email/);
  const twin = createTwin(card, {worldDir: await world(t, [{confirmation: stayId,
    captured_at: '2026-10-15T11:00:00Z', hms_fields: {status: 'Reserved'}}])});
  assert.equal((await twin.dispatch('hms_read_reservation', read())).ok, false);
});

test('unexpected field edits lower ROI even with the requested change present', () => {
  const departure = '/bookings/0/fields/departure_date';
  const rename = '/bookings/0/fields/first_name';
  const draft = proposal('amend', 'propose', [stayId], 'amend');
  draft.bookings[0].fields = {departure_date: '2026-10-20', first_name: 'Changed'};
  const card: CaseCard = {...fixture, workflow: 'amend', gold: [target(0, stayId), expected(departure, '2026-10-20'),
    {path: rename, expectation: 'not_expected', basis: 'no rename requested'}]};
  const result = score(card, draft);
  assert.ok(result.roi_score < 1);
  assert.equal(result.failure_reason, 'spurious_field');
});

test('Create board stays display-only and preserves native rate and meal note', () => {
  const built = buildRequest({workflow: 'create', booking: {id: 'b', property_code: 'HRCEN', reservation_id: null,
    current_state: null, fields: {board: 'DBB', rate_plan: 'NGOVDB', note: 'Dinner included'}},
    action: {id: 'a', type: 'create', booking_ids: ['b'], details: {}}});
  assert.ok('request' in built);
  assert.deepEqual(built.unknown, []);
  assert.deepEqual(built.request.room, {ratePlan: 'NGOVDB'});
  assert.equal(built.request.note, 'Dinner included');
});

test('party search invokes sender history only after explicit misses; host denylist uses domain boundaries', async () => {
  assert.equal(extractSenderHost('Agent <agent@outlook-travel.example>', ''), 'outlook-travel.example');
  assert.equal(extractSenderHost('agent@staff.outlook.com', ''), null);
  const calls: string[] = [];
  const history = async () => {
    calls.push('history');
    return {host: 'example.org', kind: 'agency' as const, name: 'History Agency', nativeId: null, support: 2};
  };
  const searchParty = async (term: string) => {
    calls.push(term);
    const candidates = ['Named Agency', 'History Agency'].includes(term) ? [{name: term}] : [];
    return {outcome: candidates.length ? 'matches' : 'no_match', candidates, coverage: {possiblyTruncated: false}};
  };
  await searchPartyWithFallback('Named Agency', 'agency', searchParty, history);
  assert.deepEqual(calls.splice(0), ['Named Agency']);
  await searchPartyWithFallback('Unknown', 'agency', searchParty, history);
  assert.deepEqual(calls.splice(0), ['Unknown', 'history', 'History Agency']);
  await searchPartyWithFallback('', 'agency', searchParty, history);
  assert.deepEqual(calls, ['history', 'History Agency']);
});

test('Cancel selects a Reserved whole stay without clearing intent review', () => {
  const input = proposal('cancel', 'staff_review', [stayId], 'cancel');
  const draft = proposalDraft.parse({...input, reason: 'Stay target unresolved',
    bookings: input.bookings.map(booking => ({...booking, property_code: 'HRCEN', current_state: null}))});
  draft.actions[0].details = {requested_scope: 'whole_stay'};
  assert.equal(isCancelTargetOnlyReview(draft, 'Reserved'), true);
  assert.equal(isCancelTargetOnlyReview(draft, 'Checked Out'), false);
  for (const message of ['Cancel only if approved', 'Fee inquiry', 'Cancellation intent unclear']) {
    assert.equal(isCancelTargetOnlyReview({...draft, warnings: [message]}, 'Reserved'), false);
    assert.equal(isCancelTargetOnlyReview({...draft, reason: message}, 'Reserved'), false);
  }
  draft.actions[0].details = {requested_scope: 'specific_room'};
  assert.equal(isCancelTargetOnlyReview(draft, 'Reserved'), false);
});

test('a resumed session persists the deployed skill pin and reads refreshed guidance', async t => {
  const root = await scratch(t);
  await cp(new URL('../skills/', import.meta.url), root, {recursive: true});
  const stored = {root, pin: await pinSkills(root)};
  await writeFile(join(root, 'filing', 'SKILL.md'), 'Updated filing guidance');
  const readSkill = (skillConfig: typeof stored) => skillRead({skill_name: 'filing'}, {sessionId: 'resumed', mode: 'live', skillConfig});
  assert.equal((await readSkill(stored)).error?.code, 'SKILL_CONTENT_CHANGED');
  const registry = {pinSkillTree: async () => ({root, pin: await pinSkills(root)})};
  const persisted: string[] = [];
  const refreshed = await sessionSkills(registry, stored, async (current, previousVersion) => {
    persisted.push(current.pin.version);
    assert.equal(previousVersion, stored.pin.version);
    assert.notEqual(current.pin.version, previousVersion);
  });
  assert.deepEqual(persisted, [refreshed.pin.version]);
  assert.match(JSON.stringify(await readSkill(refreshed)), /Updated filing guidance/);
  await sessionSkills(registry, refreshed, async () => assert.fail('unchanged pin was persisted'));
});
