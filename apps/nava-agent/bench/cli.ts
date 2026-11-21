#!/usr/bin/env tsx
import {parseArgs} from 'node:util';
import {resolveCasesDir} from './cases-sets.js';
import type {ReplayOptions} from './runner/artifacts.js';
import {runBench} from './runner/run.js';
import {rescoreRun} from './runner/rescore.js';

const {values, positionals} = parseArgs({
  allowPositionals: true,
  options: {
    cases: {type: 'string'},
    'cases-dir': {type: 'string'},
    'gold-file': {type: 'string'},
    'world-dir': {type: 'string'},
    'skills-dir': {type: 'string'},
    'case-ids': {type: 'string'},
    out: {type: 'string'},
    model: {type: 'string'},
    reasoning: {type: 'string'},
    concurrency: {type: 'string'},
    property: {type: 'string'},
    limit: {type: 'string'},
    gold: {type: 'string'},
    rescore: {type: 'boolean'},
    help: {type: 'boolean', short: 'h'},
  },
});
if (values.help) {
  console.log('Usage: bench/cli.ts run | rescore <run-dir> [--cases-dir dir] [--gold-file path] [--world-dir dir] [--skills-dir dir] [--out dir] [--model slug] [--reasoning effort] [--concurrency n] [--case-ids id,id] [--property HRCEN]');
} else {
  const gold = values.gold;
  if (gold !== undefined && gold !== 'v4' && gold !== 'v5') throw new Error('--gold must be v4 or v5');
  const rescore = values.rescore || positionals[0] === 'rescore';
  const resolved = !rescore || values.cases ? resolveCasesDir(values.cases, values['cases-dir']) : undefined;
  const options: ReplayOptions = {
    casesDir: resolved?.casesDir ?? values['cases-dir'],
    goldFile: values['gold-file'], gold,
    worldDir: values['world-dir'], skillsDir: values['skills-dir'],
    outDir: values.out, model: values.model, reasoning: values.reasoning, property: values.property,
    concurrency: values.concurrency !== undefined ? Number(values.concurrency) : undefined,
    limit: values.limit !== undefined ? Number(values.limit) : resolved?.limit,
    caseIds: values['case-ids']?.split(',').map(id => id.trim()).filter(Boolean),
  };
  const runDir = positionals[0] === 'rescore' ? positionals[1] : positionals[0];
  if (rescore && !runDir) throw new Error('Usage: bench/cli.ts rescore <run-dir>');
  if (!rescore && positionals.length && (positionals.length !== 1 || positionals[0] !== 'run')) throw new Error('Expected run or rescore');
  if (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit < 1)) throw new Error('Positive replay case limit required');
  const {outDir, board} = rescore ? await rescoreRun({...options, runDir}) : await runBench(options);
  const {cases: _cases, ...summary} = board;
  console.log(JSON.stringify({outDir, ...summary}, null, 2));
}
