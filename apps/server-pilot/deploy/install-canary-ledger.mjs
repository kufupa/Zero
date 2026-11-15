#!/usr/bin/env node
// Verify a completed Labtest proof journal (tooling/hms-cloud/labtest-proof.mjs), then append
// `CANARY PASS <workflow> <property> <sha>` and its writers.json row, in the shape
// validate-hms-canary.mjs and hmsWriterReady read. Nothing is written unless every check passes.
//
// On the box, as root (deploy/proof.sh does this):
//   sudo -n env "PATH=$PATH" node deploy/install-canary-ledger.mjs --expected-sha <40-hex> \
//     --property HRCEN|HRDAV|HRDAVS --workflow <workflow> [--state-dir <dir>] [--ledger <file>]
// create needs a journal that reached `created` (or `cancelled`); cancel needs `cancelled`.
import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { verifyLabtestWorkflowProof } from '../tooling/hms-cloud/labtest-proof-workflows.mjs';

process.umask(0o077);
const APP = fileURLToPath(new URL('../', import.meta.url));
const CANCELLATION_NOTE = 'Labtest proof cleanup';
const ZERO_PENALTY_NOTICE = 'Cancellation Penalty of 0.00 may be added to account.';
const check = (condition, issue) => { if (!condition) throw new Error(issue); };
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const locks = [];
let SHA, DIR, LEDGER, SIDECAR, ownerUid, ownerGid, publication = 'not_started';

async function absent(path, code) {
  try { await lstat(path); throw new Error(code); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
async function gate() {
  for (const path of new Set(['/tmp/mh1024/HOLD.txt', process.env.NAVA_RUN_HOLD_FILE?.trim()].filter(Boolean))) await absent(path, 'OWNER_HOLD');
  await absent(join(APP, '.nava-build-in-progress'), 'BUILD_INCOMPLETE');
  const marker = join(APP, 'dist', '.nava-build-commit'), stat = await lstat(marker).catch(() => null);
  check(stat?.isFile() && !stat.isSymbolicLink() && stat.size <= 100 && (await readFile(marker, 'utf8')).trim() === SHA, 'ARTIFACT_SHA_MISMATCH');
  check(!process.env.NAVA_BUILD_COMMIT || process.env.NAVA_BUILD_COMMIT.trim() === SHA, 'RUNTIME_SHA_MISMATCH');
  const git = args => execFileSync('git', args, { cwd: APP, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  let head;
  try { head = git(['rev-parse', '--verify', 'HEAD']).trim(); git(['diff', '--quiet', 'HEAD', '--']); }
  catch { throw new Error('CHECKOUT_UNVERIFIED'); }
  check(head === SHA, 'HEAD_MISMATCH');
}
async function directory(path, owners, mask) {
  const stat = await lstat(path);
  check(stat.isDirectory() && !stat.isSymbolicLink() && owners.includes(stat.uid) && !(stat.mode & mask), 'DIRECTORY_UNSAFE');
}
async function bytes(path, { owners, privateMode = false, optional = false, maximum = 1048576 }) {
  let stat;
  try { stat = await lstat(path); } catch (error) { if (optional && error.code === 'ENOENT') return null; throw error; }
  check(stat.isFile() && !stat.isSymbolicLink() && owners.includes(stat.uid) && !(stat.mode & (privateMode ? 0o077 : 0o022)) && stat.size <= maximum, 'FILE_UNSAFE');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    check(before.dev === stat.dev && before.ino === stat.ino, 'FILE_CHANGED');
    const result = await file.readFile(), after = await file.stat();
    check(result.length <= maximum && before.size === after.size && before.mtimeMs === after.mtimeMs, 'FILE_CHANGED');
    return result;
  } finally { await file.close(); }
}
async function lock(path) {
  let file;
  try { file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch (error) { throw error.code === 'EEXIST' ? new Error('OPERATION_LOCKED') : error; }
  const stat = await file.stat();
  locks.push({ path, file, dev: stat.dev, ino: stat.ino });
  // The proof runner owns this directory and must be able to read a lock left by a killed install.
  if (process.getuid() === 0) await file.chown(ownerUid, ownerGid);
  await file.writeFile(`${process.pid}\n`); await file.sync();
}
async function release() {
  for (const owned of locks.reverse()) {
    await owned.file.close().catch(() => {});
    const stat = await lstat(owned.path).catch(() => null);
    if (stat?.dev === owned.dev && stat.ino === owned.ino) await unlink(owned.path);
  }
}
function unique(fields, name, raw = false) {
  const matches = fields.filter(field => field?.name === name);
  check(matches.length === 1, 'READBACK_FIELD_NOT_UNIQUE');
  return raw && Object.hasOwn(matches[0], 'rawValue') ? matches[0].rawValue : matches[0].value;
}
function date(iso) {
  if (typeof iso !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(iso) || iso < '2027-01-01') return false;
  const parsed = new Date(`${iso}T00:00:00Z`);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === iso;
}
function wire(iso) {
  const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  return `${iso.slice(8, 10)}-${months[Number(iso.slice(5, 7)) - 1]}-${iso.slice(0, 4)}`;
}
function observedAt(value, bound) {
  const time = Date.parse(value), before = Date.parse(bound);
  check(typeof value === 'string' && Number.isFinite(time) && Number.isFinite(before) && time >= before && time <= Date.now(), 'OBSERVATION_TIME_INVALID');
  return value;
}
function business(fields, journal, cancelled) {
  check(Array.isArray(fields), 'READBACK_FIELDS_MISSING');
  const request = journal.effectiveRequest, applied = journal.prepared.applied;
  const required = { firstname: 'Proof', lastname: 'Labtest', guestid: journal.created.guestId,
    arrivaldate: wire(request.stay.arrival), departuredate: wire(request.stay.departure), adults: request.stay.adults,
    children: request.stay.childAges.length, roomtype: request.room.roomType, rateplan: request.room.ratePlan,
    guaranteetype: applied.guaranteeType, ...(request.track ? { track: applied.track } : {}),
    ...(request.marketSegment ? { marketsegment: applied.marketSegment } : {}),
    ...(request.guestoptin4 !== undefined ? { guestoptin4: request.guestoptin4 } : {}) };
  for (const [name, value] of Object.entries(required)) {
    const actual = unique(fields, name);
    check(typeof value === 'boolean' ? actual === value : String(actual) === String(value), 'READBACK_BUSINESS_MISMATCH');
  }
  check(unique(fields, 'udfchkbox04') === false && unique(fields, 'reservationnote', true) === journal.created.note, 'READBACK_CMS_OR_NOTE_MISMATCH');
  if (!cancelled) check(String(unique(fields, 'status')).toLowerCase() === 'reserved', 'CREATE_STATUS_INVALID');
  return fields;
}
function nativeCancel(value, journal) {
  const request = journal.effectiveRequest;
  check(value && value.source === 'record_view_ext_model' && value.propertyCode === journal.propertyCode &&
    value.confirmation === journal.created.confirmation && value.reservationStayId === journal.created.nativeStayId && value.guestId === journal.created.guestId &&
    value.firstName === 'Proof' && value.lastName === 'Labtest' && value.arrival === request.stay.arrival && value.departure === request.stay.departure &&
    value.roomType === request.room.roomType && value.ratePlan === request.room.ratePlan && value.adults === request.stay.adults && value.children === request.stay.childAges.length &&
    Array.isArray(value.childAges) && hash([...value.childAges].sort((a, b) => a - b)) === hash([...request.stay.childAges].sort((a, b) => a - b)) &&
    /^cancel(?:l)?ed$/i.test(value.status ?? '') && value.cancelReasonCode === 'TEST' && value.cancellationNote === CANCELLATION_NOTE &&
    value.reservationStayStatus === 'CANCELED' && (request.marketSegment === undefined || value.marketSegmentCode === request.marketSegment), 'CANCEL_NATIVE_READBACK_INVALID');
  return value;
}
function rowFor(journal, workflow, registration, digest, digestCloudCreateRequest) {
  const request = journal.request, effective = journal.effectiveRequest, created = journal.created, cancelled = journal.cancelled;
  check(journal.version === 1 && journal.sha === SHA && journal.propertyCode === registration.propertyCode &&
    ['created', 'cancelled'].includes(journal.status) &&
    request?.propertyCode === journal.propertyCode && effective?.propertyCode === journal.propertyCode && hash(request) === journal.requestDigest &&
    request.cms?.send === false && effective.cms?.send === false && date(effective.stay?.arrival) && date(effective.stay?.departure) && effective.stay.arrival < effective.stay.departure &&
    Array.isArray(effective.stay.childAges) && effective.stay.childAges.every(age => Number.isInteger(age) && age >= 0 && age <= 17) &&
    !request.parties && !effective.parties && request.taCommission === undefined && effective.taCommission === undefined &&
    created?.freshReadbackVerified === true && /^\d+-\d+$/.test(created.confirmation ?? '') && /^\d{1,100}$/.test(created.nativeStayId ?? '') &&
    created.guestId === effective.guest?.profileId && created.note === effective.note && created.note === journal.prepared?.applied?.note, 'JOURNAL_NOT_COMPLETED');
  const binding = digestCloudCreateRequest(journal.prepared.requestBinding?.request);
  check(binding.outcome === 'ok' && binding.normalizedRequestDigest === journal.prepared.requestBinding.digest &&
    binding.request.guest.firstName === 'Proof' && binding.request.guest.lastName === 'Labtest' && binding.request.guest.nativeId === created.guestId &&
    binding.request.sendHmsConfirmation.kind === 'never' && !binding.request.parties && !Object.hasOwn(binding.request, 'nativeCommissionPercent'), 'PREPARED_BINDING_INVALID');
  const saved = journal.createResult;
  check(saved?.outcome === 'saved' && saved.confirmation === created.confirmation && saved.nativeStayId === created.nativeStayId &&
    saved.save?.outcome === 'saved_same_form' && saved.save.dispatchCallbacksDrained === true && saved.save.browserSendRequests === 0 &&
    Array.isArray(saved.mismatches) && saved.mismatches.length === 0 && Array.isArray(saved.readback?.mismatches) && saved.readback.mismatches.length === 0 &&
    saved.readback.nativeStayId === created.nativeStayId && !saved.readback.issue, 'CREATE_READBACK_UNVERIFIED');
  const createFields = business(saved.readback.fields, journal, false);
  let observation = saved.readback;
  let readback = { fields: createFields, confirmation: saved.confirmation, nativeStayId: saved.readback.nativeStayId };
  if (workflow === 'cancel') {
    const zeroNotice = cancelled?.nativeResult?.outcome === 'zero_notice_awaiting_readback' &&
      cancelled.nativeResult.zeroPenaltyNotice === ZERO_PENALTY_NOTICE;
    check(cancelled?.freshReadbackVerified === true && cancelled.confirmation === created.confirmation && cancelled.nativeStayId === created.nativeStayId &&
      cancelled.guestId === created.guestId && /^cancel(?:l)?ed$/i.test(cancelled.status ?? '') && cancelled.reasonCode === 'TEST' &&
      cancelled.cancellationNote === CANCELLATION_NOTE && cancelled.readback?.cancelModelVerified === true &&
      (cancelled.nativeResult?.outcome === 'awaiting_readback' || zeroNotice) && cancelled.nativeResult.requestDispatched === true && cancelled.nativeResult.httpStatus === 200 &&
      cancelled.nativeResult.dispatchCallbacksDrained === true && cancelled.nativeResult.browserSendRequests === 0 &&
      Array.isArray(cancelled.nativeResult.blockedRequests) && cancelled.nativeResult.blockedRequests.length === 0 &&
      cancelled.nativeResult.chargeApproved === false && cancelled.nativeResult.chargeDispatched === false, 'CANCEL_READBACK_UNVERIFIED');
    observation = cancelled.readback;
    readback = { fields: business(cancelled.readback.fields, journal, true), native: nativeCancel(cancelled.readback.native, journal),
      confirmation: cancelled.confirmation, nativeStayId: cancelled.nativeStayId,
      reasonCode: cancelled.reasonCode, cancellationNote: cancelled.cancellationNote, cancelModelVerified: true };
  } else if (workflow !== 'create') {
    const proof = journal.workflowProofs?.[workflow];
    readback = verifyLabtestWorkflowProof(journal, workflow, proof);
    observation = proof;
  }
  const provenance = journal.provenance?.[workflow];
  check(provenance && provenance.propertyCode === journal.propertyCode && provenance.tenantId === registration.expectedTenant &&
    provenance.canonicalCredentialIdentity === registration.credentialSecretRef && provenance.sourceRevision === SHA &&
    hex(provenance.credentialVersionHmacSha256) && hex(provenance.writerDependencyDigest) && provenance.writerDependencyDigest === digest &&
    typeof provenance.evidenceKeyVersion === 'string' && provenance.evidenceKeyVersion.length > 0 && provenance.evidenceKeyVersion.length <= 200, 'PROVENANCE_INVALID');
  return { propertyCode: journal.propertyCode, workflow, tenantId: registration.expectedTenant,
    credentialIdentity: provenance.canonicalCredentialIdentity, credentialVersionHmacSha256: provenance.credentialVersionHmacSha256,
    writerDependencyDigest: provenance.writerDependencyDigest, sourceRevision: provenance.sourceRevision,
    readbackDigest: hash(readback), ...(workflow === 'guest_profile_create'
      ? { nativeGuestId: journal.workflowProofs.guest_profile_create.nativeGuestId }
      : { confirmation: created.confirmation, nativeStayId: created.nativeStayId }),
    observedAt: observedAt(observation.observedAt, provenance.boundBeforeNativeAt), evidenceKeyVersion: provenance.evidenceKeyVersion };
}
// The committed reader must accept this row and line before the live files change.
async function readerAccepts(policy, row, line) {
  const scratch = await mkdtemp(join(tmpdir(), 'nava-canary-ledger-'));
  try {
    const path = join(scratch, 'canary');
    await writeFile(path, `${line}\n`, { mode: 0o600 });
    await writeFile(`${path}.writers.json`, JSON.stringify({ version: 2, writers: [row] }), { mode: 0o600 });
    return policy.hmsWriterReady({ NAVA_CANARY_PASS_FILE: path,
      [`HMS_NATIVE_CATALOG_CREDENTIAL_VERSION_HMAC_SHA256_${row.propertyCode}`]: row.credentialVersionHmacSha256,
      [policy.WRITER_DIGEST_KEYS[row.workflow]]: row.writerDependencyDigest,
      [policy.WRITER_CREDENTIAL_IDENTITY_KEYS[row.propertyCode]]: row.credentialIdentity }, row.propertyCode, row.workflow, SHA) === true;
  } finally { await rm(scratch, { recursive: true, force: true }); }
}
async function syncDirectory(path) { const file = await open(path, 'r'); try { await file.sync(); } finally { await file.close(); } }
async function replace(path, content, original) {
  const temporary = join(DIR, `.canary-${randomUUID()}.tmp`);
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    if (process.getuid() === 0) await file.chown(ownerUid, ownerGid);
    await file.writeFile(content); await file.sync();
  } finally { await file.close(); }
  try {
    await gate();
    const current = await bytes(path, { owners: [0, ownerUid], optional: true });
    check(original === null ? current === null : current !== null && current.equals(original), 'LEDGER_CHANGED_DURING_INSTALL');
    await rename(temporary, path);
  } catch (error) { await unlink(temporary).catch(() => {}); throw error; }
  await syncDirectory(DIR);
}
async function main() {
  const { values } = parseArgs({ strict: true, options: { 'expected-sha': { type: 'string' }, property: { type: 'string' },
    workflow: { type: 'string' }, 'state-dir': { type: 'string' }, ledger: { type: 'string' } } });
  SHA = values['expected-sha'];
  const property = values.property, workflow = values.workflow;
  check(/^[a-f0-9]{40}$/.test(SHA ?? '') && ['HRCEN', 'HRDAV', 'HRDAVS'].includes(property) &&
    ['create', 'guest_profile_create', 'amend', 'attach', 'addons', 'cancel'].includes(workflow), 'ARGUMENTS_INVALID');
  // The service account owns the checkout, the journals and the published files.
  const app = await lstat(APP);
  ownerUid = app.uid; ownerGid = app.gid;
  check(ownerUid > 0 && [0, ownerUid].includes(process.getuid()), 'SERVICE_OWNER_INVALID');
  const home = execFileSync('getent', ['passwd', String(ownerUid)], { encoding: 'utf8' }).trim().split(':')[5];
  check(home?.startsWith('/'), 'SERVICE_OWNER_INVALID');
  const state = resolve(values['state-dir'] ?? join(home, '.local', 'state', 'nava-labtest-proof'));
  const journals = join(state, SHA);
  LEDGER = resolve(values.ledger ?? '/etc/nava/hms-canary-passes.txt'); SIDECAR = `${LEDGER}.writers.json`; DIR = dirname(LEDGER);
  await gate(); await directory(state, [ownerUid], 0o077); await directory(journals, [ownerUid], 0o077);
  await mkdir(DIR, { mode: 0o755 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  await directory(DIR, [0, process.getuid()], 0o022);
  await lock(join(DIR, '.canary-ledger.lock'));
  await lock(join(state, `${property}-operation.lock`));
  const load = path => import(pathToFileURL(join(APP, path)).href);
  const { getPropertyRegistration } = await load('tooling/hms-cloud/property-registry.mjs');
  const policy = await load('tooling/hms-cloud/hms-workflow-policy.mjs');
  const { digestCloudCreateRequest } = await load('tooling/hms-cloud/create-request-binding.mjs');
  const journalBytes = await bytes(join(journals, `${property}-journal.json`), { owners: [ownerUid], privateMode: true, optional: true });
  check(journalBytes, 'JOURNAL_MISSING');
  const journal = JSON.parse(journalBytes.toString('utf8'));
  const legacyHold = await bytes(join(state, `${property}-hold`),
    { owners: [ownerUid], privateMode: true, optional: true, maximum: 128 });
  check(legacyHold === null || workflow !== 'guest_profile_create' && journal.created?.freshReadbackVerified === true &&
    legacyHold.toString('utf8').trim() === 'guest_profile_create_possible', 'CANARY_HELD');
  check(!journal.workflowHolds?.[workflow], 'CANARY_HELD');
  const holdTargets = workflow === 'guest_profile_create' ? ['guest_profile_create'] : [
    `stay-${hash([journal.created?.confirmation, journal.created?.nativeStayId])}`,
    `create-${hash([journal.effectiveRequest?.stay?.arrival, { firstName: 'Proof', lastName: 'Labtest' }])}`,
  ];
  for (const target of holdTargets) await absent(join(state, `${property}-${target}-hold`), 'CANARY_HELD');
  const row = rowFor(journal, workflow, getPropertyRegistration(property), policy.hmsWriterDependencyDigest(workflow), digestCloudCreateRequest);
  const originalFile = await bytes(LEDGER, { owners: [0, ownerUid], optional: true });
  const original = originalFile ?? Buffer.alloc(0);
  check(Buffer.from(original.toString('utf8')).equals(original), 'LEDGER_ENCODING_INVALID');
  const previous = await bytes(SIDECAR, { owners: [0, ownerUid], optional: true });
  const sidecar = previous ? JSON.parse(previous.toString('utf8')) : { version: 2, writers: [] };
  check(sidecar?.version === 2 && Array.isArray(sidecar.writers) && sidecar.writers.every(entry => entry && typeof entry === 'object' && !Array.isArray(entry)), 'SIDECAR_SCHEMA_INVALID');
  const core = entry => hash(Object.fromEntries(['propertyCode', 'workflow', 'tenantId', 'credentialIdentity', 'credentialVersionHmacSha256', 'writerDependencyDigest', 'sourceRevision', 'readbackDigest', 'confirmation', 'nativeStayId', 'nativeGuestId'].map(key => [key, entry[key]])));
  const addedRow = !sidecar.writers.some(existing => core(existing) === core(row));
  if (addedRow) sidecar.writers.push(row);
  const line = `CANARY PASS ${row.workflow} ${row.propertyCode} ${SHA}`;
  const addedLine = !original.toString('utf8').split(/\r?\n/).includes(line);
  const ledger = addedLine ? Buffer.concat([original, Buffer.from(`${original.length && original.at(-1) !== 10 ? '\n' : ''}${line}\n`)]) : original;
  const json = Buffer.from(`${JSON.stringify(sidecar, null, 2)}\n`);
  check(ledger.length <= 1048576 && json.length <= 1048576, 'LEDGER_SIZE_LIMIT');
  check(await readerAccepts(policy, row, line), 'WRITER_ROW_REJECTED_BY_READER');
  await gate(); publication = 'sidecar_possible';
  if (addedRow) await replace(SIDECAR, json, previous);
  publication = 'sidecar_published';
  if (addedLine) await replace(LEDGER, ledger, originalFile);
  publication = 'complete';
  process.stdout.write(`${JSON.stringify({ status: 'installed', line, addedLine, addedRow, confirmation: row.confirmation,
    ...(row.nativeGuestId ? { nativeGuestId: row.nativeGuestId } : {}),
    observedAt: row.observedAt, ledger: LEDGER, sidecar: SIDECAR, flagsChanged: false })}\n`);
}
main().catch(error => {
  const issue = /^[A-Z][A-Z0-9_]{2,100}$/.test(error?.message ?? '') ? error.message : 'INSTALL_REFUSED';
  process.stderr.write(`${JSON.stringify({ status: 'refused', issue, publication, flagsChanged: false })}\n`); process.exitCode = 1;
}).finally(async () => {
  await release().catch(() => { process.stderr.write(`${JSON.stringify({ status: 'lock_cleanup_failed', issue: 'OWNED_LOCK_CLEANUP_FAILED', publication })}\n`); process.exitCode = 1; });
});
