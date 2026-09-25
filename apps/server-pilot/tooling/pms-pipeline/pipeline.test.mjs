import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verify, hookDecision, codeHash, pipelineStopGate } from './pipeline.mjs';

const PNG = 'png';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2));
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function cleanFixture() {
  const repo = mkdtempSync(join(tmpdir(), 'pms-pipeline-'));
  const dir = join(repo, '.private/pms-pipeline/demo');
  mkdirSync(join(dir, 'png'), { recursive: true });
  mkdirSync(join(repo, 'tool'), { recursive: true });

  writeJson(join(repo, 'tool/demo.schema.json'), {
    type: 'object',
    properties: {
      input: {
        type: 'object',
        required: ['kind'],
        properties: {
          kind: { type: 'string', enum: ['guest', 'organization'] },
          query: {
            type: 'object',
            properties: {
              lastName: { type: 'string' },
              children: { type: 'integer' },
            },
          },
        },
      },
    },
  });
  writeFileSync(join(repo, 'tool/demo.mjs'), 'export const demo = 1;\n');

  writeJson(join(dir, 'pipeline.json'), {
    tool: 'demo',
    schema: 'tool/demo.schema.json',
    inputPointer: '/properties/input',
    toolFiles: ['tool/demo.mjs', 'tool/demo.schema.json'],
    minKeyed: 2,
    criticalPngs: ['criteria', 'results'],
    testCmd: [process.execPath, '-e', ''],
  });

  for (const name of ['kind', 'last', 'children', 'save', 'c1-criteria', 'c1-results']) {
    writeFileSync(join(dir, 'png', `${name}.png`), PNG);
  }

  writeJson(join(dir, '01-docs.json'), {
    items: [
      { id: 'doc.children', label: 'Children', url: 'https://docs.infor.com/hms/2026.08/x.html', quote: 'Enter Child Ages', clickClass: null },
      { id: 'doc.save', label: 'Save', url: 'https://docs.infor.com/hms/2026.08/y.html', quote: 'Click Save', clickClass: 'write' },
    ],
    publicApi: {
      found: false,
      searched: ['HTNG registry', 'Infor API gateway', 'Databridge'],
      exaAgent: { runId: 'agent_run_0123456789abcdef0123456789abcdef', effort: 'high' },
      notes: 'none',
    },
  });
  writeJson(join(dir, 'implications.json'), {
    tool: 'demo',
    kinds: [{ kind: 'guest', inThisTool: true, reason: 'docs guest search' }],
    affectsOtherTools: [{ tool: 'demo-consumer', effect: 'takes nativeId', status: 'noted' }],
    unbuiltTools: [],
    researchDeltas: [
      { id: 'd1', was: 'two kinds', now: 'one kind', flagUser: true, evidence: '01-docs.json' },
    ],
  });
  writeJson(join(dir, '02-corpus.json'), {
    demand: { inboundOnly: true, total: 5, byField: { organization: 3 } },
    cases: [
      { id: 'm1', split: 'tune', answerKey: { company: '100' } },
      { id: 'm2', split: 'test', answerKey: { company: '200' } },
      { id: 'm3', split: 'test', answerKey: null },
    ],
  });
  writeJson(join(dir, '03-screen.json'), {
    controls: [
      { id: 'scr.kind', label: 'Profile Type', domKey: 'ptype', required: true, type: 'select', options: ['organization', 'guest'], optionsOpened: true, png: 'png/kind.png' },
      { id: 'scr.last', label: 'Last Name', domKey: 'lname', required: false, type: 'text', png: 'png/last.png' },
      { id: 'scr.children', label: 'Children', domKey: 'children', required: false, type: 'number', png: 'png/children.png' },
      { id: 'scr.save', label: 'Save', domKey: 'button-1', required: false, type: 'button', png: 'png/save.png' },
    ],
  });
  writeJson(join(dir, 'field-map.json'), {
    entries: [
      { id: 'doc.children', schemaPath: 'query.children' },
      { id: 'doc.save', reason: 'banned_click' },
      { id: 'scr.kind', schemaPath: 'kind' },
      { id: 'scr.last', schemaPath: 'query.lastName' },
      { id: 'scr.children', schemaPath: 'query.children' },
      { id: 'scr.save', reason: 'banned_click' },
    ],
  });
  writeJson(join(dir, '04-review.json'), {
    findings: [{ id: 'f1', blocking: true, status: 'fixed', evidence: 'png/kind.png' }],
  });
  writeJson(join(dir, '06-prove.json'), {
    cases: [{
      id: 'c1',
      outcome: 'resolved',
      pngs: { criteria: 'png/c1-criteria.png', results: 'png/c1-results.png' },
      pngHashes: { criteria: sha256(PNG), results: sha256(PNG) },
    }],
  });
  writeJson(join(dir, '07-backtest.json'), {
    cases: [
      { id: 'm2', split: 'test', result: 'hit' },
      { id: 'm3', split: 'test', result: 'miss', missClass: 'hms_lacks', astraConfirmed: true },
    ],
  });
  writeJson(join(dir, '08-grade.json'), {
    codeHash: codeHash(repo, ['tool/demo.mjs', 'tool/demo.schema.json']),
    items: [
      { id: 'g1', pass: true, evidence: 'png/c1-results.png' },
      { id: 's1', by: 'sol', pass: true, claim: 'results grid visible', evidence: 'png/c1-results.png' },
    ],
  });
  writeFileSync(join(repo, 'learn.md'), '# learning\n');
  writeJson(join(dir, '09-wire.json'), {
    consumers: [{ path: 'tool/demo.mjs', done: true }],
    learnDoc: 'learn.md',
  });
  return { repo, dir };
}

function failing(result) {
  return result.checks.filter((c) => !c.pass).map((c) => c.id);
}

test('clean fixture passes every check', () => {
  const { repo, dir } = cleanFixture();
  const result = verify(dir, { repoRoot: repo });
  assert.deepEqual(failing(result), []);
  assert.equal(result.pass, true);
  assert.equal(result.next, null);
  rmSync(repo, { recursive: true, force: true });
});

test('docs without Exa Agent runId fails docs.exa.agent', () => {
  const { repo, dir } = cleanFixture();
  const docs = readJson(join(dir, '01-docs.json'));
  delete docs.publicApi.exaAgent;
  writeJson(join(dir, '01-docs.json'), docs);
  const result = verify(dir, { repoRoot: repo });
  assert.ok(failing(result).includes('docs.exa.agent'));
  rmSync(repo, { recursive: true, force: true });
});

test('missing implications.json fails implications.present', () => {
  const { repo, dir } = cleanFixture();
  rmSync(join(dir, 'implications.json'));
  assert.ok(failing(verify(dir, { repoRoot: repo })).includes('implications.present'));
  rmSync(repo, { recursive: true, force: true });
});

test('flagUser research delta without was/now/evidence fails implications.deltas', () => {
  const { repo, dir } = cleanFixture();
  const impl = readJson(join(dir, 'implications.json'));
  impl.researchDeltas = [{ id: 'x', flagUser: true }];
  writeJson(join(dir, 'implications.json'), impl);
  assert.ok(failing(verify(dir, { repoRoot: repo })).includes('implications.deltas'));
  rmSync(repo, { recursive: true, force: true });
});

test('past miss: children dropped from schema fails map.complete', () => {
  const { repo, dir } = cleanFixture();
  const map = readJson(join(dir, 'field-map.json'));
  map.entries = map.entries.filter((e) => !e.id.endsWith('children'));
  writeJson(join(dir, 'field-map.json'), map);
  const result = verify(dir, { repoRoot: repo });
  assert.ok(failing(result).includes('map.complete'));
  assert.match(result.checks.find((c) => c.id === 'map.complete').detail, /doc\.children/);
  rmSync(repo, { recursive: true, force: true });
});

test('past miss: enum drift (3 vs 9 options) fails schema.enum.parity', () => {
  const { repo, dir } = cleanFixture();
  const screen = readJson(join(dir, '03-screen.json'));
  screen.controls[0].options = ['organization', 'guest', 'group'];
  writeJson(join(dir, '03-screen.json'), screen);
  const result = verify(dir, { repoRoot: repo });
  assert.ok(failing(result).includes('schema.enum.parity'));
  rmSync(repo, { recursive: true, force: true });
});

test('past miss: invented mail-phrase field (boardBasis) fails map.no.invented', () => {
  const { repo, dir } = cleanFixture();
  const schemaPath = join(repo, 'tool/demo.schema.json');
  const schema = readJson(schemaPath);
  schema.properties.input.properties.boardBasis = { type: 'string' };
  writeJson(schemaPath, schema);
  const result = verify(dir, { repoRoot: repo });
  assert.ok(failing(result).includes('map.no.invented'));
  assert.match(result.checks.find((c) => c.id === 'map.no.invented').detail, /boardBasis/);
  rmSync(repo, { recursive: true, force: true });
});

test('past miss: proof case without results screenshot fails prove.pngs', () => {
  const { repo, dir } = cleanFixture();
  rmSync(join(dir, 'png/c1-results.png'));
  const result = verify(dir, { repoRoot: repo });
  assert.ok(failing(result).includes('prove.pngs'));
  rmSync(repo, { recursive: true, force: true });
});

test('proof screenshot changed after proof JSON fails prove.pngs.fresh', () => {
  const { repo, dir } = cleanFixture();
  writeFileSync(join(dir, 'png/c1-results.png'), 'different-png');
  const result = verify(dir, { repoRoot: repo });
  assert.ok(failing(result).includes('prove.pngs.fresh'));
  rmSync(repo, { recursive: true, force: true });
});

test('Astra grade evidence must cite hashed stage-6 proof pngs', () => {
  const { repo, dir } = cleanFixture();
  writeFileSync(join(dir, 'png/other-results.png'), PNG);
  const grade = readJson(join(dir, '08-grade.json'));
  grade.items = grade.items.map((g) => (g.id === 'g1' ? { ...g, evidence: 'png/other-results.png' } : g));
  writeJson(join(dir, '08-grade.json'), grade);
  const result = verify(dir, { repoRoot: repo });
  assert.ok(failing(result).includes('grade.evidence.proved'));
  rmSync(repo, { recursive: true, force: true });
});

test('required control mapped to optional schema field fails schema.required.parity', () => {
  const { repo, dir } = cleanFixture();
  const schemaPath = join(repo, 'tool/demo.schema.json');
  const schema = readJson(schemaPath);
  schema.properties.input.required = [];
  writeJson(schemaPath, schema);
  const result = verify(dir, { repoRoot: repo });
  assert.ok(failing(result).includes('schema.required.parity'));
  rmSync(repo, { recursive: true, force: true });
});

test('dropdown never opened fails screen.options.opened', () => {
  const { repo, dir } = cleanFixture();
  const screen = readJson(join(dir, '03-screen.json'));
  screen.controls[0].optionsOpened = false;
  writeJson(join(dir, '03-screen.json'), screen);
  assert.ok(failing(verify(dir, { repoRoot: repo })).includes('screen.options.opened'));
  rmSync(repo, { recursive: true, force: true });
});

test('opened empty native store still passes screen.options.opened', () => {
  const { repo, dir } = cleanFixture();
  const screen = readJson(join(dir, '03-screen.json'));
  screen.controls[0].optionsOpened = true;
  screen.controls[0].options = [];
  writeJson(join(dir, '03-screen.json'), screen);
  assert.ok(!failing(verify(dir, { repoRoot: repo })).includes('screen.options.opened'));
  rmSync(repo, { recursive: true, force: true });
});

test('demand counted from staff replies fails corpus.demand', () => {
  const { repo, dir } = cleanFixture();
  const corpus = readJson(join(dir, '02-corpus.json'));
  corpus.demand.inboundOnly = false;
  writeJson(join(dir, '02-corpus.json'), corpus);
  assert.ok(failing(verify(dir, { repoRoot: repo })).includes('corpus.demand'));
  rmSync(repo, { recursive: true, force: true });
});

test('too few keyed cases fails corpus.key.min as a stop condition', () => {
  const { repo, dir } = cleanFixture();
  const cfg = readJson(join(dir, 'pipeline.json'));
  cfg.minKeyed = 10;
  writeJson(join(dir, 'pipeline.json'), cfg);
  const check = verify(dir, { repoRoot: repo }).checks.find((c) => c.id === 'corpus.key.min');
  assert.equal(check.pass, false);
  assert.equal(check.stop, true);
  rmSync(repo, { recursive: true, force: true });
});

test('open blocking review finding fails review.resolved', () => {
  const { repo, dir } = cleanFixture();
  writeJson(join(dir, '04-review.json'), { findings: [{ id: 'f1', blocking: true, status: 'open', evidence: 'x' }] });
  assert.ok(failing(verify(dir, { repoRoot: repo })).includes('review.resolved'));
  rmSync(repo, { recursive: true, force: true });
});

test('tool_bug miss or unconfirmed hms_lacks fails bt.no.tool_bug', () => {
  const { repo, dir } = cleanFixture();
  const bt = readJson(join(dir, '07-backtest.json'));
  bt.cases[1].astraConfirmed = false;
  writeJson(join(dir, '07-backtest.json'), bt);
  assert.ok(failing(verify(dir, { repoRoot: repo })).includes('bt.no.tool_bug'));
  bt.cases[1] = { id: 'm3', split: 'test', result: 'miss', missClass: 'tool_bug' };
  writeJson(join(dir, '07-backtest.json'), bt);
  assert.ok(failing(verify(dir, { repoRoot: repo })).includes('bt.no.tool_bug'));
  rmSync(repo, { recursive: true, force: true });
});

test('code edited after Astra grade fails grade.fresh', () => {
  const { repo, dir } = cleanFixture();
  writeFileSync(join(repo, 'tool/demo.mjs'), 'export const demo = 2;\n');
  const result = verify(dir, { repoRoot: repo });
  assert.ok(failing(result).includes('grade.fresh'));
  rmSync(repo, { recursive: true, force: true });
});

test('Sol leftover png FAIL does not fail grade.pass or grade.sol', () => {
  const { repo, dir } = cleanFixture();
  const grade = readJson(join(dir, '08-grade.json'));
  grade.items.push({
    id: 's-junk',
    by: 'sol',
    pass: false,
    claim: 'stale diagnostic',
    evidence: 'png/grade-diagnostic.png',
  });
  writeJson(join(dir, '08-grade.json'), grade);
  const result = verify(dir, { repoRoot: repo });
  assert.equal(result.pass, true);
  assert.ok(!failing(result).includes('grade.pass'));
  assert.ok(!failing(result).includes('grade.sol'));
  rmSync(repo, { recursive: true, force: true });
});

test('Sol FAIL on Astra evidence fails grade.sol not grade.pass', () => {
  const { repo, dir } = cleanFixture();
  const grade = readJson(join(dir, '08-grade.json'));
  grade.items = grade.items.map((g) => (g.by === 'sol' ? { ...g, pass: false, claim: 'grid missing' } : g));
  writeJson(join(dir, '08-grade.json'), grade);
  const result = verify(dir, { repoRoot: repo });
  assert.equal(result.pass, false);
  assert.ok(failing(result).includes('grade.sol'));
  assert.ok(!failing(result).includes('grade.pass'));
  rmSync(repo, { recursive: true, force: true });
});

test('Astra FAIL still fails grade.pass when Sol passes', () => {
  const { repo, dir } = cleanFixture();
  const grade = readJson(join(dir, '08-grade.json'));
  grade.items = grade.items.map((g) => (g.id === 'g1' ? { ...g, pass: false } : g));
  writeJson(join(dir, '08-grade.json'), grade);
  const result = verify(dir, { repoRoot: repo });
  assert.ok(failing(result).includes('grade.pass'));
  rmSync(repo, { recursive: true, force: true });
});

test('missing Sol items fails grade.sol', () => {
  const { repo, dir } = cleanFixture();
  const grade = readJson(join(dir, '08-grade.json'));
  grade.items = grade.items.filter((g) => g.by !== 'sol');
  writeJson(join(dir, '08-grade.json'), grade);
  const result = verify(dir, { repoRoot: repo });
  assert.ok(failing(result).includes('grade.sol'));
  rmSync(repo, { recursive: true, force: true });
});

test('missing stage file fails that stage and next points at earliest stage', () => {
  const { repo, dir } = cleanFixture();
  rmSync(join(dir, '03-screen.json'));
  rmSync(join(dir, '08-grade.json'));
  const result = verify(dir, { repoRoot: repo });
  assert.equal(result.pass, false);
  assert.equal(result.next.stage, 3);
  rmSync(repo, { recursive: true, force: true });
});

test('empty tool dir fails at stage 0 setup', () => {
  const repo = mkdtempSync(join(tmpdir(), 'pms-pipeline-'));
  const dir = join(repo, '.private/pms-pipeline/empty');
  mkdirSync(dir, { recursive: true });
  const result = verify(dir, { repoRoot: repo });
  assert.equal(result.pass, false);
  assert.equal(result.next.stage, 0);
  rmSync(repo, { recursive: true, force: true });
});

test('pipelineStopGate: never first-claims; foreign chat skipped; owner runs', () => {
  assert.equal(pipelineStopGate(null, 'chat-a').run, false);
  assert.equal(pipelineStopGate({ tool: 'demo' }, 'chat-a').run, false);
  assert.equal(pipelineStopGate({ tool: 'demo', conversationId: 'chat-a' }, null).run, false);
  assert.equal(pipelineStopGate({ tool: 'demo', conversationId: 'chat-a' }, 'chat-b').run, false);
  assert.equal(pipelineStopGate({ tool: 'demo', conversationId: 'chat-a' }, 'chat-a').run, true);
});

test('hookDecision: inactive, pass, fail, repeat stop, agent STOP.md', () => {
  const failResult = { pass: false, checks: [], next: { stage: 3, id: 'screen.png', detail: 'missing png/a.png' } };
  const passResult = { pass: true, checks: [], next: null };

  assert.deepEqual(hookDecision({ active: null }), { response: {} });

  const done = hookDecision({ active: 'demo', result: passResult, state: {} });
  assert.deepEqual(done.response, {});
  assert.equal(done.write, 'DONE');

  const first = hookDecision({ active: 'demo', result: failResult, state: {} });
  assert.match(first.response.followup_message, /screen\.png/);
  assert.match(first.response.followup_message, /03-screen\.md/);
  assert.equal(first.state.repeats, 1);

  const second = hookDecision({ active: 'demo', result: failResult, state: first.state });
  assert.ok(second.response.followup_message);
  const third = hookDecision({ active: 'demo', result: failResult, state: second.state });
  assert.deepEqual(third.response, {});
  assert.equal(third.write, 'STOP');

  const agentStop = hookDecision({ active: 'demo', result: failResult, state: {}, stopReason: 'hms_down' });
  assert.deepEqual(agentStop.response, {});

  const bogusStop = hookDecision({ active: 'demo', result: failResult, state: {}, stopReason: 'tired' });
  assert.ok(bogusStop.response.followup_message);

  const stopCheck = { pass: false, checks: [], next: { stage: 2, id: 'corpus.key.min', detail: 'keyed 3 < 30', stop: true } };
  const stopped = hookDecision({ active: 'demo', result: stopCheck, state: {} });
  assert.deepEqual(stopped.response, {});
  assert.equal(stopped.write, 'STOP');
});

test('CLI verify exits 2 when work is left and prints JSON', async () => {
  const { spawnSync } = await import('node:child_process');
  const { repo, dir } = cleanFixture();
  rmSync(join(dir, '08-grade.json'));
  const run = spawnSync(process.execPath, [new URL('./pipeline.mjs', import.meta.url).pathname, 'verify', 'demo'], {
    env: { ...process.env, PMS_PIPELINE_REPO_ROOT: repo },
    encoding: 'utf8',
  });
  assert.equal(run.status, 2);
  assert.equal(JSON.parse(run.stdout).next.id, 'grade.fresh');
  assert.ok(existsSync(dir));
  rmSync(repo, { recursive: true, force: true });
});

test('CLI hash prints codeHash of toolFiles', async () => {
  const { spawnSync } = await import('node:child_process');
  const { repo } = cleanFixture();
  const run = spawnSync(process.execPath, [new URL('./pipeline.mjs', import.meta.url).pathname, 'hash', 'demo'], {
    env: { ...process.env, PMS_PIPELINE_REPO_ROOT: repo },
    encoding: 'utf8',
  });
  assert.equal(run.status, 0);
  assert.equal(run.stdout.trim(), codeHash(repo, ['tool/demo.mjs', 'tool/demo.schema.json']));
  rmSync(repo, { recursive: true, force: true });
});
