// Run with the deployed worker's protected runtime file and tsx loader.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createNativeAdmission, configuredSlots } from '../src/worker.ts';
import { sql } from '../src/db.ts';
import { acquireCloudCredentialLease } from '../../server-pilot/tooling/hms-cloud/cloud-session.mjs';
import { withSavedStayAgentSession } from '../../server-pilot/tooling/hms-cloud/saved-stay-agent-session.mjs';

const expected = 10;
const propertyCode = 'HRCEN';
const safeCode = error => /^[A-Z][A-Z0-9_]*$/.test(error?.message ?? '') ? error.message : 'UNEXPECTED_ERROR';
const abort = new AbortController();
const deadline = setTimeout(() => abort.abort(new Error('PROBE_TIMEOUT')), 240_000);
let releaseReaders;
const readersMayClose = new Promise(resolve => { releaseReaders = resolve; });
let allReady, notReady;
const ready = new Promise((resolve, reject) => { allReady = resolve; notReady = reject; });
const held = new Map();
let readers = [];

async function verifyPilot(envFile) {
  const pilotModule='/home/ubuntu/repos/zero/apps/server-pilot/tooling/hms-cloud/cloud-session.mjs';
  const bundledModule=fileURLToPath(new URL('../../server-pilot/tooling/hms-cloud/cloud-session.mjs',import.meta.url));
  const digest=buffer=>createHash('sha256').update(buffer).digest('hex');
  if (digest(await readFile(pilotModule)) !== digest(await readFile(bundledModule))) throw new Error('PILOT_ADMISSION_CODE_MISMATCH');
  const child=spawn('bash',['-c','set -a; source "$1"; set +a; exec "$2" "$3" "$4"','nava-pilot-probe',envFile,
    process.execPath,fileURLToPath(new URL('./verify-pilot-contention.mjs',import.meta.url)),pilotModule],
    {env:{HOME:process.env.HOME,PATH:process.env.PATH,USER:process.env.USER},stdio:['pipe','ignore','ignore']});
  const ended=new Promise((resolve,reject)=>{
    child.once('error',reject);
    child.once('close',code=>code===0?resolve():reject(new Error('PILOT_ADMISSION_NOT_VERIFIED')));
  });
  const stop=()=>child.kill('SIGTERM');
  abort.signal.addEventListener('abort',stop,{once:true});
  child.stdin.on('error',()=>{});
  child.stdin.end(process.env.HMS_CREDENTIAL_LEASE_DATABASE_URL);
  try { await ended; } finally { abort.signal.removeEventListener('abort',stop); }
}

async function expectContention(readOnly) {
  let lease;
  try {
    lease = await acquireCloudCredentialLease(propertyCode, {
      databaseUrl: process.env.HMS_CREDENTIAL_LEASE_DATABASE_URL, readOnly, priority: 'staff', tryOnce: true,
      signal: abort.signal,
    });
  } catch (error) {
    if (error?.message === 'HMS_CREDENTIAL_LEASE_CONTENDED') return;
    throw error;
  }
  await lease.release();
  throw new Error(readOnly ? 'ELEVENTH_READER_ADMITTED' : 'WRITER_NOT_EXCLUSIVE');
}

try {
  const fixture = JSON.parse(await readFile(process.argv[2], 'utf8'));
  if (!/^(?:\d+-\d+|\d{6,10})$/.test(fixture.confirmation ?? '') ||
      !/^\d{4}-\d{2}-\d{2}$/.test(fixture.arrivalDate ?? '')) throw new Error('INVALID_FIXTURE');
  if (!process.env.HMS_CREDENTIAL_LEASE_DATABASE_URL ||
      process.env.HMS_CREDENTIAL_SESSION_CAP !== String(expected) ||
      process.env.NAVA_HMS_SLOTS !== String(expected) ||
      process.env.NAVA_HMS_SESSION_MODULE) throw new Error('RUNTIME_CONFIG_MISMATCH');
  const slots = configuredSlots();
  if (slots.requested !== expected || slots.native !== expected || slots.local !== expected) throw new Error('WORKER_CAP_MISMATCH');
  const admission = createNativeAdmission();
  readers = Array.from({ length: expected }, (_, i) => admission.withRead(propertyCode, abort.signal, async lease => {
    await withSavedStayAgentSession(async ({ runTool }) => {
      const result = await runTool({ tool: 'read', confirmation: fixture.confirmation,
        arrivalDate: fixture.arrivalDate, view: 'shallow' });
      if (result.outcome !== 'ok') throw new Error('HMS_READ_FAILED');
      held.set(i, lease);
      if (held.size === expected) allReady();
      await readersMayClose;
      lease.signal.throwIfAborted();
    }, { propertyCode, signal: abort.signal, credentialLease: lease,
      readOnly: true, readOnlyConfirmation: fixture.confirmation });
  }).catch(error => { notReady(error); abort.abort(error); throw error; }));
  // Observe every rejection even if another reader fails before reaching the barrier.
  const settled = Promise.allSettled(readers);
  await ready;
  if (held.size !== expected || [...held.values()].some(lease => lease.signal.aborted)) throw new Error('READERS_NOT_HELD');
  await expectContention(true);
  await expectContention(false);
  await verifyPilot('/home/ubuntu/repos/zero/apps/server-pilot/.env.production');
  await verifyPilot('/home/ubuntu/repos/zero/apps/server-pilot/.env.remote-common');
  if ([...held.values()].some(lease => lease.signal.aborted)) throw new Error('READER_LEASE_LOST');
  releaseReaders();
  const results = await settled;
  if (results.some(result => result.status !== 'fulfilled')) throw new Error('READER_CLEANUP_FAILED');
  console.log('hms_cap=PASS worker_slots=10 shared_slots=10 simultaneous_real_reads=10 reader_11=contended writer_during_reads=contended pilot_admission=shared save=none');
} catch (error) {
  abort.abort(error);
  releaseReaders();
  await Promise.allSettled(readers);
  console.error(`hms_cap=FAIL reason=${safeCode(error)}`);
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  await sql.end({ timeout: 5 });
}
