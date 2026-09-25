#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const STAGE_CARDS = [
  '00-setup.md',
  '01-docs.md',
  '02-corpus.md',
  '03-screen.md',
  '04-freeze.md',
  '05-build.md',
  '06-prove.md',
  '07-backtest.md',
  '08-grade.md',
  '09-wire.md',
];

export const MAP_REASONS = ['system_filled', 'banned_click', 'not_on_property'];
export const STOP_REASONS = ['dangerous_click', 'hms_down', 'login_dead', 'model_rejected', 'human_decision'];
const MAX_REPEATS = 3;

/** Stop-hook gate: only the ACTIVE.conversationId chat may run. Never first-claim. */
export function pipelineStopGate(active, conversationId) {
  if (!active?.tool) return { run: false };
  if (!active.conversationId || !conversationId) return { run: false };
  if (active.conversationId !== conversationId) return { run: false };
  return { run: true };
}

function readJsonIfExists(path) {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}

function fileHash(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function codeHash(repoRoot, files) {
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(file);
    hash.update('\0');
    hash.update(existsSync(join(repoRoot, file)) ? readFileSync(join(repoRoot, file)) : 'MISSING');
    hash.update('\0');
  }
  return hash.digest('hex');
}

function pointer(root, ptr) {
  let node = root;
  for (const part of ptr.split('/').filter(Boolean)) {
    node = node?.[part];
  }
  return node;
}

function schemaLeaves(node, prefix = '') {
  const leaves = [];
  for (const [key, child] of Object.entries(node?.properties ?? {})) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (child?.properties) leaves.push(...schemaLeaves(child, path));
    else leaves.push(path);
  }
  return leaves;
}

function resolvePath(inputSchema, path) {
  let parent = null;
  let node = inputSchema;
  for (const part of path.split('.')) {
    parent = node;
    node = node?.properties?.[part];
    if (!node) return null;
  }
  return { node, parent, key: path.split('.').at(-1) };
}

function sameSet(a, b) {
  const left = [...new Set(a)].sort();
  const right = [...new Set(b)].sort();
  return left.length === right.length && left.every((v, i) => v === right[i]);
}

function validReason(reason) {
  return MAP_REASONS.includes(reason) || /^other_tool:\S+$/.test(reason ?? '');
}

function check(stage, id, problems, extra = {}) {
  const list = problems.filter(Boolean);
  return { stage, id, pass: list.length === 0, detail: list.slice(0, 12).join('; '), ...extra };
}

function evidenceTokens(evidence) {
  return String(evidence || '')
    .split(/[;,]/)
    .map((s) => s.trim().replace(/\s*\(absent\)\s*$/i, ''))
    .filter(Boolean);
}

function isSolItem(item) {
  return item?.by === 'sol';
}

function missing(stage, ids, file) {
  return ids.map((id) => ({ stage, id, pass: false, detail: `missing ${file}` }));
}

export function verify(dir, { repoRoot }) {
  const checks = [];
  const at = (name) => join(dir, name);
  const fileExists = (rel) => existsSync(join(dir, rel));

  const config = readJsonIfExists(at('pipeline.json'));
  if (!config) {
    checks.push({ stage: 0, id: 'setup.config', pass: false, detail: 'missing pipeline.json' });
  } else {
    const needed = ['tool', 'schema', 'inputPointer', 'toolFiles', 'minKeyed', 'criticalPngs', 'testCmd'];
    checks.push(check(0, 'setup.config', needed.map((k) => (config[k] == null ? `pipeline.json lacks ${k}` : null))));
  }

  const docs = readJsonIfExists(at('01-docs.json'));
  if (!docs) checks.push(...missing(1, ['docs.cited', 'docs.exa.agent', 'implications.present', 'implications.deltas'], '01-docs.json'));
  else {
    const items = docs.items ?? [];
    checks.push(check(1, 'docs.cited', [
      items.length === 0 ? 'no docs items' : null,
      ...items.map((d) => (!String(d.url ?? '').startsWith('https://docs.infor.com/') || !d.quote ? `${d.id} lacks infor url or quote` : null)),
    ]));
    const api = docs.publicApi ?? {};
    const runId = api.exaAgent?.runId ?? '';
    checks.push(check(1, 'docs.exa.agent', [
      typeof api.found !== 'boolean' ? 'publicApi.found must be boolean' : null,
      !(api.searched?.length >= 3) ? 'publicApi.searched needs ≥3 named sources' : null,
      !/^agent_run_[a-f0-9]{16,}$/i.test(runId) ? 'publicApi.exaAgent.runId missing (stage 1 must run Exa Agent, not ordinary search only)' : null,
    ]));
    const impl = readJsonIfExists(at('implications.json'));
    if (!impl) checks.push(...missing(1, ['implications.present', 'implications.deltas'], 'implications.json'));
    else {
      const kinds = impl.kinds ?? [];
      checks.push(check(1, 'implications.present', [
        kinds.length === 0 ? 'kinds empty' : null,
        ...kinds.map((k) => (k.kind && typeof k.inThisTool === 'boolean' && k.reason ? null : `${k.kind ?? '?'} needs kind, inThisTool, reason`)),
        !Array.isArray(impl.affectsOtherTools) ? 'affectsOtherTools missing' : null,
        !Array.isArray(impl.unbuiltTools) ? 'unbuiltTools missing' : null,
      ]));
      checks.push(check(1, 'implications.deltas', (impl.researchDeltas ?? []).map((d) => (
        d.flagUser === true && !(d.was && d.now && d.evidence)
          ? `${d.id ?? 'delta'} flagUser needs was, now, evidence`
          : null
      ))));
    }
  }

  const corpus = readJsonIfExists(at('02-corpus.json'));
  if (!corpus) checks.push(...missing(2, ['corpus.demand', 'corpus.key.min'], '02-corpus.json'));
  else {
    checks.push(check(2, 'corpus.demand', [
      corpus.demand?.inboundOnly !== true ? 'demand not marked inboundOnly' : null,
      !(corpus.demand?.total > 0) ? 'demand total missing' : null,
    ]));
    const keyed = (corpus.cases ?? []).filter((c) => c.answerKey).length;
    const min = config?.minKeyed ?? Infinity;
    checks.push(check(2, 'corpus.key.min', [keyed < min ? `keyed cases ${keyed} < ${min}` : null], { stop: keyed < min }));
  }

  const screen = readJsonIfExists(at('03-screen.json'));
  if (!screen) checks.push(...missing(3, ['screen.png', 'screen.options.opened'], '03-screen.json'));
  else {
    const controls = screen.controls ?? [];
    checks.push(check(3, 'screen.png', [
      controls.length === 0 ? 'no controls' : null,
      ...controls.map((c) => (!c.png || !fileExists(c.png) ? `${c.id} png missing` : null)),
    ]));
    checks.push(check(3, 'screen.options.opened', controls
      .filter((c) => c.type === 'select')
      .map((c) => {
        if (c.optionsOpened === true && Array.isArray(c.options)) return null;
        return `${c.id} options not copied from opened list`;
      })));
  }

  const schemaDoc = config && existsSync(join(repoRoot, config.schema))
    ? JSON.parse(readFileSync(join(repoRoot, config.schema), 'utf8'))
    : null;
  const inputSchema = schemaDoc ? pointer(schemaDoc, config.inputPointer) : null;
  const map = readJsonIfExists(at('field-map.json'));
  const review = readJsonIfExists(at('04-review.json'));
  const sourceIds = [...(docs?.items ?? []), ...(screen?.controls ?? [])].map((x) => x.id);
  const entries = new Map((map?.entries ?? []).map((e) => [e.id, e]));

  if (!map) checks.push(...missing(4, ['map.complete', 'map.no.invented'], 'field-map.json'));
  else {
    checks.push(check(4, 'map.complete', sourceIds.map((id) => {
      const entry = entries.get(id);
      if (!entry) return `${id} unmapped`;
      if (entry.schemaPath) return inputSchema && resolvePath(inputSchema, entry.schemaPath) ? null : `${id} → ${entry.schemaPath} not in schema`;
      return validReason(entry.reason) ? null : `${id} reason "${entry.reason}" not allowed`;
    })));
    const mapped = new Set([...entries.values()].map((e) => e.schemaPath).filter(Boolean));
    checks.push(check(4, 'map.no.invented', [
      !inputSchema ? 'schema input not found' : null,
      ...(inputSchema ? schemaLeaves(inputSchema) : []).map((p) => (mapped.has(p) ? null : `${p} traces to no docs/screen item`)),
    ]));
  }
  if (!review) checks.push(...missing(4, ['review.resolved'], '04-review.json'));
  else {
    checks.push(check(4, 'review.resolved', (review.findings ?? [])
      .map((f) => (f.blocking && !['fixed', 'rebutted'].includes(f.status) ? `${f.id} open` : null))));
  }

  if (!inputSchema || !screen || !map) {
    checks.push(...missing(5, ['schema.enum.parity', 'schema.required.parity'], 'schema, 03-screen.json or field-map.json'));
  } else {
    const mappedControls = (screen.controls ?? []).map((c) => [c, entries.get(c.id)]).filter(([, e]) => e?.schemaPath);
    checks.push(check(5, 'schema.enum.parity', mappedControls
      .filter(([c]) => c.options?.length)
      .map(([c, e]) => {
        const r = resolvePath(inputSchema, e.schemaPath);
        const values = r?.node?.enum ?? r?.node?.items?.enum;
        return values && sameSet(values, c.options) ? null : `${e.schemaPath} enum ≠ screen options of ${c.id}`;
      })));
    checks.push(check(5, 'schema.required.parity', mappedControls
      .filter(([c]) => c.required)
      .map(([c, e]) => {
        const r = resolvePath(inputSchema, e.schemaPath);
        return r?.parent?.required?.includes(r.key) ? null : `${e.schemaPath} not required but ${c.id} is`;
      })));
  }
  if (!config?.testCmd) checks.push({ stage: 5, id: 'tests.green', pass: false, detail: 'no testCmd' });
  else {
    const [cmd, ...args] = config.testCmd;
    const run = spawnSync(cmd, args, { cwd: repoRoot, encoding: 'utf8', timeout: 120_000 });
    checks.push(check(5, 'tests.green', [run.status === 0 ? null : `testCmd exit ${run.status}: ${(run.stderr || run.stdout || '').slice(-300)}`]));
  }

  let hashedProofPngs = new Set();
  const prove = readJsonIfExists(at('06-prove.json'));
  if (!prove) checks.push(...missing(6, ['prove.pngs', 'prove.outcomes'], '06-prove.json'));
  else {
    const cases = prove.cases ?? [];
    const proofEntries = cases.flatMap((c) => (config?.criticalPngs ?? []).map((name) => ({ caseId: c.id, name, rel: c.pngs?.[name], expectedHash: c.pngHashes?.[name] })));
    checks.push(check(6, 'prove.pngs', [
      cases.length === 0 ? 'no proof cases' : null,
      ...proofEntries.map(({ caseId, name, rel }) => (rel && fileExists(rel) ? null : `${caseId} lacks ${name} png`)),
    ]));
    checks.push(check(6, 'prove.pngs.fresh', proofEntries.map(({ caseId, name, rel, expectedHash }) => {
      if (!rel || !fileExists(rel)) return null;
      if (!expectedHash) return `${caseId} ${name} png lacks sha256`;
      const actualHash = fileHash(join(dir, rel));
      if (actualHash !== expectedHash) return `${caseId} ${name} png sha256 mismatch`;
      return null;
    })));
    hashedProofPngs = new Set(proofEntries
      .filter(({ rel, expectedHash }) => rel && fileExists(rel) && expectedHash && fileHash(join(dir, rel)) === expectedHash)
      .map(({ rel }) => rel));
    checks.push(check(6, 'prove.outcomes', cases.map((c) => (!c.outcome || c.outcome === 'execution_failure' ? `${c.id} outcome ${c.outcome}` : null))));
  }

  const bt = readJsonIfExists(at('07-backtest.json'));
  if (!bt) checks.push(...missing(7, ['bt.no.tool_bug'], '07-backtest.json'));
  else {
    const byId = new Map((bt.cases ?? []).map((c) => [c.id, c]));
    const testCases = (corpus?.cases ?? []).filter((c) => c.split === 'test');
    checks.push(check(7, 'bt.no.tool_bug', [
      testCases.length === 0 ? 'no test split cases' : null,
      ...testCases.map((c) => (byId.has(c.id) ? null : `${c.id} not backtested`)),
      ...[...byId.values()].map((c) => {
        if (c.result === 'hit') return null;
        if (c.missClass === 'tool_bug') return `${c.id} tool_bug`;
        if (c.missClass === 'hms_lacks' && c.astraConfirmed !== true) return `${c.id} hms_lacks not confirmed by Astra search`;
        return ['hms_lacks', 'mail_lacks', 'extract_bug'].includes(c.missClass) ? null : `${c.id} miss unclassified`;
      }),
    ]));
  }

  const grade = readJsonIfExists(at('08-grade.json'));
  if (!grade) checks.push(...missing(8, ['grade.fresh', 'grade.pass', 'grade.sol'], '08-grade.json'));
  else {
    const current = config ? codeHash(repoRoot, config.toolFiles) : null;
    checks.push(check(8, 'grade.fresh', [grade.codeHash === current ? null : 'tool files changed since Astra grade; regrade']));
    const items = grade.items ?? [];
    const astraItems = items.filter((g) => !isSolItem(g));
    const solItems = items.filter(isSolItem);
    checks.push(check(8, 'grade.pass', [
      astraItems.length === 0 ? 'no Astra graded items' : null,
      ...astraItems.map((g) => (g.pass === true && g.evidence ? null : `${g.id} ${g.pass ? 'lacks evidence' : 'failed'}`)),
    ]));
    const astraEvidence = new Set(astraItems.flatMap((g) => evidenceTokens(g.evidence)));
    const solOnAstra = solItems.filter((g) => evidenceTokens(g.evidence).some((p) => astraEvidence.has(p)));
    checks.push(check(8, 'grade.evidence.proved', [...astraItems, ...solOnAstra].flatMap((g) => {
        const tokens = evidenceTokens(g.evidence);
        if (tokens.length === 0) return [`${g.id} lacks evidence`];
        return tokens.map((p) => (hashedProofPngs.has(p) ? null : `${g.id} evidence ${p} not hashed stage-6 proof png`));
      })));
    checks.push(check(8, 'grade.sol', [
      solItems.length === 0 ? 'Sol file review missing (no by:sol items)' : null,
      ...solOnAstra.map((g) => (g.pass === true && g.evidence ? null : `${g.id} ${g.pass ? 'lacks evidence' : 'failed Astra evidence'}`)),
    ]));
  }

  const wire = readJsonIfExists(at('09-wire.json'));
  if (!wire) checks.push(...missing(9, ['wire.consumers', 'learn.doc'], '09-wire.json'));
  else {
    checks.push(check(9, 'wire.consumers', (wire.consumers ?? []).map((c) => (c.done === true && existsSync(join(repoRoot, c.path)) ? null : `${c.path} not wired`))));
    checks.push(check(9, 'learn.doc', [wire.learnDoc && existsSync(join(repoRoot, wire.learnDoc)) ? null : 'learning doc missing']));
  }

  const firstFail = checks.find((c) => !c.pass) ?? null;
  return {
    pass: firstFail === null,
    next: firstFail && { stage: firstFail.stage, id: firstFail.id, detail: firstFail.detail, ...(firstFail.stop ? { stop: true } : {}) },
    checks,
  };
}

export function hookDecision({ active, result, state = {}, stopReason = null }) {
  if (!active) return { response: {} };
  if (result.pass) return { response: {}, write: 'DONE', state: {} };
  if (STOP_REASONS.includes(stopReason)) return { response: {}, state };
  if (result.next.stop) return { response: {}, write: 'STOP', state };

  const key = `${result.next.id}|${result.next.detail}`;
  const repeats = state.key === key ? state.repeats + 1 : 1;
  if (repeats >= MAX_REPEATS) return { response: {}, write: 'STOP', state: { key, repeats } };

  const card = STAGE_CARDS[result.next.stage];
  return {
    response: {
      followup_message: [
        `pms-pipeline ${active}: verify FAIL \`${result.next.id}\` (stage ${result.next.stage}): ${result.next.detail}.`,
        `Open .cursor/skills/pms-tool-pipeline/stages/${card}, fix, rerun \`node apps/server-pilot/tooling/pms-pipeline/pipeline.mjs next ${active}\`, then stop.`,
        `If blocked by a stop condition, write .private/pms-pipeline/${active}/STOP.md with first line \`reason: <${STOP_REASONS.join('|')}>\`.`,
      ].join(' '),
    },
    state: { key, repeats },
  };
}

export function repoRootFrom(cwd) {
  if (process.env.PMS_PIPELINE_REPO_ROOT) return resolve(process.env.PMS_PIPELINE_REPO_ROOT);
  const git = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' });
  return git.status === 0 ? git.stdout.trim() : resolve(cwd);
}

export function toolDir(repoRoot, tool) {
  return join(repoRoot, '.private/pms-pipeline', tool);
}

function main([command, tool]) {
  if (!['status', 'next', 'verify', 'hash'].includes(command) || !tool) {
    console.error('usage: pipeline.mjs status|next|verify|hash <tool>');
    return 1;
  }
  const repoRoot = repoRootFrom(process.cwd());
  if (command === 'hash') {
    const config = readJsonIfExists(join(toolDir(repoRoot, tool), 'pipeline.json'));
    if (!config) {
      console.error(`${tool}: missing pipeline.json`);
      return 1;
    }
    console.log(codeHash(repoRoot, config.toolFiles));
    return 0;
  }
  const result = verify(toolDir(repoRoot, tool), { repoRoot });
  if (command === 'verify') {
    console.log(JSON.stringify(result, null, 2));
  } else if (command === 'status') {
    for (const c of result.checks) console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.stage}  ${c.id}${c.pass ? '' : `  ${c.detail}`}`);
  } else if (result.pass) {
    console.log(`${tool}: all checks PASS`);
  } else {
    console.log(`${tool}: next = stage ${result.next.stage} ${STAGE_CARDS[result.next.stage]} · ${result.next.id} · ${result.next.detail}${result.next.stop ? ' · STOP condition' : ''}`);
  }
  return result.pass ? 0 : 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
