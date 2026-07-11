#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isPathInScope } from './scope-allowlist.mjs';
import { isRateLimited } from './xai-repo-agent.mjs';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../..');
const FIXTURE = join(ROOT, 'tools/t3mp3st/fixtures/mini-repo');

let pass = 0;
let fail = 0;
const ok = (label, cond) => {
  if (cond) {
    pass++;
    console.log(`  ok ${label}`);
  } else {
    fail++;
    console.log(`  FAIL ${label}`);
  }
};

ok('rate limit detector', isRateLimited('429 Too Many Requests'));
ok('path traversal blocked', !isPathInScope(FIXTURE, '../../../etc/passwd', ['src']));
ok('fixture in scope', isPathInScope(FIXTURE, 'src/handler.ts', ['src']));

const agentSrc = readFileSync(join(ROOT, 'tools/t3mp3st/scripts/lib/xai-repo-agent.mjs'), 'utf8');
ok('agent exports runXaiReadonlyAgent', agentSrc.includes('export async function runXaiReadonlyAgent'));

ok('missing key error string in agent', /XAI_API_KEY missing/.test(agentSrc));

console.log(`\n${fail === 0 ? 'ALL PASS' : `${fail} FAILED`} — ${pass}/${pass + fail}\n`);
process.exit(fail === 0 ? 0 : 1);
