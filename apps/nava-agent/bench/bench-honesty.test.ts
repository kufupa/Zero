import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test, type TestContext} from 'node:test';
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
const fixture: CaseCard = {
  case_id: 'sample', workflow: 'cancel', as_of: after, real_confirmation: '92227177-1',
  selected_email: {id: 'selected', received_at: cutoff, direction: 'inbound', from: 'guest@example.org'},
};
const stayId = fixture.real_confirmation;
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
const score = (card: CaseCard, draft: unknown) => scoreCase({
  card, proposal: draft, toolCalls: [], tokens: {input: 0, output: 0, cached_input: 0}, wall_ms: 1250, normalize: false,
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
    wait: async delay => { delays.push(Number(delay)); },
  });
  assert.equal((await model({messages: [], tools: [], system: 'test'})).stop_reason, 'end_turn');
  assert.equal(statuses.length, 0);
  assert.ok(delays[0] >= 500 && delays[0] < 1000 && delays[1] >= 1000 && delays[1] < 1500);
});

test('learned sender history uses only dated HMS availability or the older PDF own party', async t => {
  const rows = Array.from({length: 2}, (_, i) => ({
    confirmation: `80000000-${i + 1}`,
    hms_available_at: after,
    captured_at: after,
    hms_fields: {ta1: 'Future Agency'},
    pdf_versions: [{sent_at: before, recipient_fields: {to: ['guest@example.org']},
      fields: {agency_text: 'Observed Agency'}}],
  }));
  const twin = createTwin(fixture, {worldDir: await world(t, rows)});
  const result = await twin.dispatch('hms_search_parties', {property_code: 'HRCEN', kind: 'agency', field: 'name', query: 'Guest', sender_host: 'example.org'});
  assert.match(JSON.stringify(result.data), /Observed Agency/);
  assert.doesNotMatch(JSON.stringify(result.data), /Future Agency/);
  const withFutureLetters = createTwin(fixture, {worldDir: await world(t, rows.map(row => ({...row,
    pdf_versions: row.pdf_versions.map(pdf => ({...pdf, sent_at: after})),
  })))});
  const uncovered = await withFutureLetters.dispatch('hms_search_parties', {property_code: 'HRCEN', kind: 'agency', field: 'name', query: 'Guest', sender_host: 'example.org'});
  assert.doesNotMatch(JSON.stringify(uncovered.data), /sender_history|Future Agency|Observed Agency/);
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

test('fresh replay and rescore agree using a local Responses server and explicit gold', async t => {
  const root = await scratch(t);
  const casesDir = join(root, 'cases');
  const goldFile = join(root, 'gold.json');
  const outDir = join(root, 'run');
  const worldDir = await world(t, []);
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
