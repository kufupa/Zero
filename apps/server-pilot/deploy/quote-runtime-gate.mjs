import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const [expected, mode, override] = process.argv.slice(2);
const fail = message => { console.error(`Centurion quote gate FAILED: ${message}`); process.exit(1); };
if (!/^[a-f0-9]{40}$/.test(expected ?? '') || (mode && mode !== '--validate-only') || (override && mode !== '--validate-only')) fail('invalid gate arguments');
const envKey = 'RESERVATIONIST_STAFF_QUOTE_CONFIGURATION';
let envs, config;
try {
  if (readFileSync('dist/.nava-build-commit', 'utf8').trim() !== expected) throw new Error();
  const apps = JSON.parse(execFileSync('pm2', ['jlist'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
  envs = ['http', 'worker', 'ai-worker', 'remote-http'].map(name => {
    const matches = apps.filter(app => app.name === name);
    if (matches.length !== 1 || matches[0].pm2_env?.status !== 'online' || !(matches[0].pid > 0)) throw new Error();
    const env = Object.fromEntries(readFileSync(`/proc/${matches[0].pid}/environ`, 'utf8').split('\0').filter(Boolean).map(entry => {
      const at = entry.indexOf('='); return [entry.slice(0, at), entry.slice(at + 1)];
    }));
    if (env.NAVA_BUILD_COMMIT !== expected || !env[envKey]) throw new Error();
    return env;
  });
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, envs[0]);
  const { readInstalledStaffQuoteConfiguration } = await import(pathToFileURL(resolve('dist/ai/staff-quote-installation.js')));
  const { getPropertyRegistration } = await import(pathToFileURL(resolve('tooling/hms-cloud/property-registry.mjs')));
  for (const env of envs) {
    process.env[envKey] = override || env[envKey];
    const candidate = readInstalledStaffQuoteConfiguration('HRCEN');
    if (candidate.tenantId !== getPropertyRegistration('HRCEN').expectedTenant) throw new Error();
    config ??= candidate;
  }
  process.env[envKey] = envs[0][envKey];
} catch { fail('quote configuration invalid or live process build mismatch'); }
console.log('Centurion quote gate: process builds and quote configuration OK');
if (mode === '--validate-only') process.exit(0);

try {
  const { fetchQuote } = await import(pathToFileURL(resolve('tooling/hms-cloud/fetch-quote.mjs')));
  const { withCloudCredentialPriority } = await import(pathToFileURL(resolve('tooling/hms-cloud/cloud-session.mjs')));
  const { normalizeQuoteRequest } = await import(pathToFileURL(resolve('tooling/hms-cloud/quote-contract.mjs')));
  const now = Date.now(), date = days => new Date(now + days * 86400000).toISOString().slice(0, 10);
  const example = JSON.parse(readFileSync('tooling/hms-cloud/examples/v2-broad.json', 'utf8'));
  const request = { ...example, arrivalDate: date(30), departureDate: date(31),
    rooms: [{ ...example.rooms[0], adults: 1, required: { mealPlanBases: ['breakfast'] } }],
    search: { salesStrategy: 'BAR', includeRestricted: false, includeAlternatives: true }, details: 'full', maxOptionsPerGroup: 200 };
  const normalized = normalizeQuoteRequest(request);
  if (!normalized.ok) throw new Error();
  const started = Date.now(), signal = AbortSignal.timeout(360000);
  const read = () => withCloudCredentialPriority('background', () => fetchQuote({ request, propertyCode: 'HRCEN', transportId: 'transport-centurion', outputDir: config.outputDir,
    signal, env: { ...process.env, QUOTE_DETAIL_BUDGET_MS: '10000' } }));
  const busy = result => result.outcome === 'execution_failure' && result.phase === 'login' && result.error?.message === 'HMS_CREDENTIAL_LEASE_CONTENDED';
  let result = await read();
  if (busy(result)) {
    console.warn('Centurion quote gate: HMS credential lease busy; retrying in 60 seconds');
    await delay(60000, undefined, { signal });
    result = await read();
    if (busy(result)) fail('HMS credential lease still busy; quote check not verified');
  }
  const observed = Date.parse(result.observedAt);
  if (result.schemaVersion !== 2 || result.propertyCode !== 'HRCEN' || result.requested?.propertyCode !== 'HRCEN' ||
      JSON.stringify(result.requested) !== JSON.stringify(normalized.request) || !Number.isFinite(observed) ||
      observed < started || observed > Date.now() || result.audit?.status !== 'complete' ||
      result.searchCompleteness?.status !== 'complete' || !['quote', 'no_match', 'unavailable'].includes(result.outcome)) throw new Error();
  console.log(`Centurion quote gate: read-only quote check OK (${result.outcome})`);
} catch { fail('real quote check failed or returned incomplete evidence'); }
