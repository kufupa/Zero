#!/usr/bin/env node
// Labtest proof runner: Proof Labtest guest only, arrival 2027 or later, CMS send off.
//
// Run on the box from apps/server-pilot with the production env loaded and
// NAVA_BUILD_COMMIT=<deployed sha> (deploy/proof.sh does this):
//   node tooling/hms-cloud/labtest-proof.mjs --stage <prepare|workflow> \
//     --property HRCEN|HRDAV|HRDAVS --expected-sha <40-hex> --request <private json> [--state-dir <dir>]
//
// prepare: a read-only census picks the first arrival without a live Proof Labtest stay
//          (the request dates are the preference), then one unsaved Prepare.
// create:  one Save of the prepared request, then a fresh readback.
// cancel:  cancels the stay this journal created, then a fresh readback.
//
// State under --state-dir (default ~/.local/state/nava-labtest-proof):
//   <sha>/<property>-journal.json  evidence for deploy/install-canary-ledger.mjs
//   <property>-<target>-hold        left behind when a write may have reached HMS;
//                                  re-read HMS before removing it, never blind-retry
//   <property>-operation.lock       one stage per property at a time
// The last stdout line is `PROOF PASS|FAIL <stage> <property> <sha> conf=<confirmation>`.
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

process.umask(0o077);
// A shell started from a PM2 process leaks its IPC channel and pm_exec_path; neither may reach this run.
if (process.channel) process.disconnect();
for (const key of Object.keys(process.env)) {
  if (/^(?:NODE_CHANNEL_FD|NODE_CHANNEL_SERIALIZATION_MODE|NODE_UNIQUE_ID|pm_\w+)$/.test(key)) delete process.env[key];
}

const APP_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CANCELLATION_NOTE = 'Labtest proof cleanup';
const ZERO_PENALTY_NOTICE = 'Cancellation Penalty of 0.00 may be added to account.';
const fail = code => { throw new Error(code); };
const assert = (condition, code) => { if (!condition) fail(code); };
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const guest = Object.freeze({ firstName: 'Proof', lastName: 'Labtest' });
const addDays = (iso, days) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
let journal, journalPath, journalDir, holdPath, args;
let mutationPossible = false;
let resumeStatus;

async function assertNoTargetHold() {
  const legacyPath = join(args.root, `${args.propertyCode}-hold`);
  try {
    const stat = await lstat(legacyPath);
    assert(stat.isFile() && !stat.isSymbolicLink() && stat.uid === process.getuid() &&
      !(stat.mode & 0o077) && stat.size <= 128, 'JOURNAL_HELD');
    // Old profile holds remain intact. Only an independently owned stay may
    // proceed; unknown legacy holds still stop every workflow.
    assert(['amend', 'attach', 'addons', 'cancel'].includes(args.stage) &&
      journal?.created?.freshReadbackVerified === true &&
      (await readFile(legacyPath, 'utf8')).trim() === 'guest_profile_create_possible', 'JOURNAL_HELD');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const paths = [holdPath];
  if (args.stage !== 'guest_profile_create' && journal?.created && journal.effectiveRequest?.stay) {
    paths.push(join(args.root, `${args.propertyCode}-create-${hash([journal.effectiveRequest.stay.arrival, guest])}-hold`));
  }
  for (const path of new Set(paths)) {
    try { await lstat(path); fail('JOURNAL_HELD'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function parseArgs(argv) {
  const allowed = new Set(['--property', '--expected-sha', '--stage', '--request', '--state-dir']);
  const values = {};
  for (let i = 0; i < argv.length; i += 2) {
    assert(allowed.has(argv[i]) && argv[i + 1] && !Object.hasOwn(values, argv[i]), 'ARGUMENTS_INVALID');
    values[argv[i]] = argv[i + 1];
  }
  assert(['HRCEN', 'HRDAV', 'HRDAVS'].includes(values['--property']) &&
    /^[a-f0-9]{40}$/.test(values['--expected-sha'] ?? '') &&
    ['prepare', 'create', 'guest_profile_create', 'amend', 'attach', 'addons', 'cancel'].includes(values['--stage']) &&
    values['--request'], 'ARGUMENTS_INVALID');
  return { propertyCode: values['--property'], sha: values['--expected-sha'], stage: values['--stage'],
    requestPath: resolve(values['--request']),
    root: resolve(values['--state-dir'] ?? join(homedir(), '.local', 'state', 'nava-labtest-proof')) };
}

async function checkHold(signal) {
  signal?.throwIfAborted();
  const holds = new Set(['/tmp/mh1024/HOLD.txt', process.env.NAVA_RUN_HOLD_FILE?.trim()].filter(Boolean));
  for (const path of holds) {
    try { await lstat(path); fail('OWNER_HOLD'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  assert(process.env.NAVA_BUILD_COMMIT?.trim() === args.sha, 'RUNTIME_SHA_MISMATCH');
  try { await lstat(join(APP_ROOT, '.nava-build-in-progress')); fail('BUILD_INCOMPLETE'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const marker = join(APP_ROOT, 'dist', '.nava-build-commit');
  const stat = await lstat(marker).catch(() => null);
  assert(stat?.isFile() && !stat.isSymbolicLink() && stat.size <= 100 &&
    (await readFile(marker, 'utf8')).trim() === args.sha, 'ARTIFACT_SHA_MISMATCH');
}

async function privateFile(path, optional = false) {
  let stat;
  try { stat = await lstat(path); } catch (error) { if (optional && error.code === 'ENOENT') return null; throw error; }
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.uid === process.getuid() && !(stat.mode & 0o077) &&
    stat.size <= 1024 * 1024, 'PRIVATE_FILE_UNSAFE');
  const file = await open(path, 'r');
  try {
    const current = await file.stat();
    assert(current.ino === stat.ino && current.dev === stat.dev, 'PRIVATE_FILE_CHANGED');
    return JSON.parse(await file.readFile('utf8'));
  } finally { await file.close(); }
}

async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  assert(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid() && !(stat.mode & 0o077),
    'JOURNAL_DIRECTORY_UNSAFE');
}

// A killed run (for example an SSM timeout) leaves its lock behind; a hold file, not the lock, guards an uncertain write.
// Only one run at a time may replace a dead owner's lock, and a run only ever removes the lock it created.
async function acquireLock(path) {
  const create = async () => {
    const file = await open(path, 'wx', 0o600);
    await file.writeFile(`${process.pid}\n`);
    const stat = await file.stat();
    return { file, path, dev: stat.dev, ino: stat.ino };
  };
  try { return await create(); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const takeover = await open(`${path}.takeover`, 'wx', 0o600).catch(() => fail('OPERATION_LOCKED'));
  try {
    const owner = Number((await readFile(path, 'utf8').catch(() => '')).trim());
    let alive = true;
    if (Number.isInteger(owner) && owner > 0) {
      try { process.kill(owner, 0); } catch (probe) { alive = probe.code !== 'ESRCH'; }
    }
    assert(!alive, 'OPERATION_LOCKED');
    await unlink(path);
    return await create().catch(() => fail('OPERATION_LOCKED'));
  } finally { await takeover.close(); await unlink(`${path}.takeover`).catch(() => {}); }
}

async function releaseLock(lock) {
  await lock.file.close().catch(() => {});
  const stat = await lstat(lock.path).catch(() => null);
  if (stat?.dev === lock.dev && stat.ino === lock.ino) await unlink(lock.path).catch(() => {});
}

async function persist(value) {
  const temp = join(journalDir, `${args.propertyCode}-${randomUUID()}.tmp`);
  const file = await open(temp, 'wx', 0o600);
  try { await file.writeFile(`${JSON.stringify(value, null, 2)}\n`); await file.sync(); }
  finally { await file.close(); }
  await rename(temp, journalPath);
  const directory = await open(journalDir, 'r');
  try { await directory.sync(); } finally { await directory.close(); }
  journal = value;
}

async function markPossible(status, extra = {}) {
  await checkHold();
  await assertNoTargetHold();
  const file = await open(holdPath, 'wx', 0o600);
  try { await file.writeFile(`${status}\n`); await file.sync(); } finally { await file.close(); }
  mutationPossible = true;
  resumeStatus = journal.status;
  await persist({ ...journal, ...extra, status, updatedAt: new Date().toISOString() });
}

// Sessions refuse without this digest (HMS_CREDENTIAL_VERSION_DIGEST_MISSING); bind it here, from metadata only.
async function bindCredentialMetadata(property, credentialVersionHmacSha256) {
  await checkHold();
  const { SecretsManagerClient, GetSecretValueCommand } = await import('@aws-sdk/client-secrets-manager');
  const evidenceArn = process.env.HMS_EVIDENCE_HMAC_SECRET_ARN?.trim();
  assert(evidenceArn, 'EVIDENCE_KEY_METADATA_MISSING');
  const client = new SecretsManagerClient({ region: process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'af-south-1' });
  let key;
  try {
    const credential = await client.send(new GetSecretValueCommand({ SecretId: property.credentialSecretRef, VersionStage: 'AWSCURRENT' }));
    assert(credential.VersionId && credential.VersionStages?.includes('AWSCURRENT'), 'CREDENTIAL_VERSION_INVALID');
    credential.SecretString = undefined;
    const evidence = await client.send(new GetSecretValueCommand({ SecretId: evidenceArn, VersionStage: 'AWSCURRENT' }));
    assert(evidence.VersionId && evidence.VersionStages?.includes('AWSCURRENT'), 'EVIDENCE_VERSION_INVALID');
    const configuredVersion = process.env.HMS_EVIDENCE_HMAC_KEY_VERSION?.trim();
    assert(!configuredVersion || configuredVersion === evidence.VersionId, 'EVIDENCE_VERSION_MISMATCH');
    const encoded = evidence.SecretString?.trim();
    assert(typeof encoded === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(encoded), 'EVIDENCE_KEY_INVALID');
    key = Buffer.from(encoded, 'base64');
    evidence.SecretString = undefined;
    assert(key.length >= 32 && key.toString('base64').replace(/=+$/, '') === encoded.replace(/=+$/, ''), 'EVIDENCE_KEY_INVALID');
    const digest = credentialVersionHmacSha256({ evidenceKey: key, evidenceKeyVersion: evidence.VersionId,
      hmsSecretArn: property.credentialSecretRef, hmsSecretVersionId: credential.VersionId });
    const envKey = `HMS_NATIVE_CATALOG_CREDENTIAL_VERSION_HMAC_SHA256_${args.propertyCode}`;
    assert(!process.env[envKey] || process.env[envKey] === digest, 'CREDENTIAL_VERSION_MISMATCH');
    process.env.HMS_EVIDENCE_HMAC_KEY_VERSION = evidence.VersionId;
    process.env[envKey] = digest;
    return Object.freeze({ canonicalCredentialIdentity: property.credentialSecretRef,
      credentialVersionHmacSha256: digest, sourceRevision: args.sha, evidenceKeyVersion: evidence.VersionId });
  } finally { key?.fill(0); client.destroy(); }
}

function safeNativeResult(result) {
  const safe = Object.fromEntries(['outcome', 'issue', 'confirmation', 'status', 'httpStatus', 'requestSeen',
    'requestDispatched', 'dispatchCallbacksDrained', 'blockedRequests', 'blockedRequestsAfterDispatch',
    'browserSendRequests', 'chargeApproved', 'chargeDispatched', 'zeroPenaltyNotice'].filter(key =>
      Object.hasOwn(result ?? {}, key) && ['string', 'number', 'boolean'].includes(typeof result[key])).map(key => [key, result[key]]));
  if (typeof result?.draftCheck === 'string' && /^DRAFT_[A-Z0-9_]{1,80}$/.test(result.draftCheck)) safe.draftCheck = result.draftCheck;
  for (const key of ['blockedRequests', 'blockedRequestsAfterDispatch']) {
    if (Array.isArray(result?.[key])) {
      safe[`${key}Count`] = result[key].length;
      if (result[key].length === 0) safe[key] = [];
    }
  }
  // Keep native fee evidence in the private journal, never in status stdout.
  for (const key of ['penaltyText', 'dialogs', 'nativeDialog', 'policy']) {
    if (Object.hasOwn(result ?? {}, key)) safe[key] = result[key];
  }
  return safe;
}

async function main() {
  args = parseArgs(process.argv.slice(2));
  await checkHold();
  const { z } = await import('zod');
  const load = path => import(pathToFileURL(join(APP_ROOT, path)).href);
  const registry = await load('tooling/hms-cloud/property-registry.mjs');
  const property = registry.getPropertyRegistration(args.propertyCode);
  assert(property?.active, 'PROPERTY_INVALID');
  const transportId = property.mailboxTransportId;
  assert(property.transportIds.includes(transportId), 'TRANSPORT_INVALID');
  const text = max => z.string().min(1).max(max).refine(value => value === value.trim() && !/[\p{Cc}]/u.test(value));
  const code = z.string().regex(/^[A-Z0-9]{1,12}$/);
  const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
    const parsed = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
  });
  const requestSchema = z.object({ propertyCode: z.literal(args.propertyCode), mode: z.enum(['prepare', 'commit']).optional(),
    guest: z.union([z.object({ profileId: z.string().regex(/^\d{1,30}$/) }).strict(),
      z.object({ search: z.object({ firstName: z.literal('Proof'), lastName: z.literal('Labtest') }).strict() }).strict()]),
    stay: z.object({ arrival: date, departure: date, adults: z.number().int().min(1).max(20),
      childAges: z.array(z.number().int().min(0).max(17)).max(20), childCount: z.number().int().min(0).max(20).optional() }).strict(),
    room: z.object({ roomType: code, ratePlan: code, roomTypeForCharge: code.optional() }).strict(),
    guaranteeType: z.enum(['NGI', 'AVOUCH', 'CNFREC', 'DEPREQ', 'GRPDEF', 'NGG', 'GTDCMP', 'GTDAGT']),
    sourceOfBusiness: text(100).optional(), reasonForStay: text(100).optional(),
    note: z.string().min(1).max(2000).refine(value => ![...value].some(char =>
      char.charCodeAt(0) < 32 && char !== '\n' || char.charCodeAt(0) === 127)).optional(),
    track: code.optional(), marketSegment: z.string().regex(/^[A-Z0-9]{1,20}$/).optional(), guestoptin4: z.boolean().optional(),
    booker: z.object({ name: text(50).optional(), contact: text(80).optional() }).strict().optional(),
    cms: z.object({ send: z.literal(false), messageId: text(100).optional() }).strict() }).strict().refine(value =>
      value.stay.arrival >= '2027-01-01' && value.stay.arrival < value.stay.departure &&
      (value.stay.childCount === undefined || value.stay.childCount === value.stay.childAges.length));
  const { proof = {}, ...createInput } = await privateFile(args.requestPath);
  const proofRequest = z.object({ addons: z.array(z.object({ code: text(100),
    quantity: z.union([text(30), z.number().positive()]),
    unitPrice: z.union([text(30), z.number().nonnegative()]).optional(),
    frequency: text(100).optional(), pricingControl: text(100).optional(), folio: text(100).optional(),
    comment: z.string().max(200).optional() }).strict()).length(1).optional() }).strict().parse(proof);
  const parsed = requestSchema.safeParse(createInput);
  assert(parsed.success, 'REQUEST_INVALID');
  const request = parsed.data;
  delete request.mode;
  journalDir = join(args.root, args.sha);
  await privateDirectory(args.root);
  await privateDirectory(journalDir);
  journalPath = join(journalDir, `${args.propertyCode}-journal.json`);
  const lockPath = join(args.root, `${args.propertyCode}-operation.lock`);
  const fileLock = await acquireLock(lockPath);
  try {
    journal = await privateFile(journalPath, true);
    if (journal) {
      assert(journal.version === 1 && journal.propertyCode === args.propertyCode && journal.sha === args.sha &&
        hash(journal.request) === journal.requestDigest, 'JOURNAL_BINDING_MISMATCH');
      if (args.stage !== 'prepare') assert(hash(journal.proofRequest ?? {}) === hash(proofRequest), 'PROOF_REQUEST_CHANGED');
    }
    const target = args.stage === 'guest_profile_create' ? 'guest_profile_create'
      : journal?.created ? `stay-${hash([journal.created.confirmation, journal.created.nativeStayId])}`
        : `create-${hash([journal?.effectiveRequest?.stay.arrival ?? request.stay.arrival, guest])}`;
    holdPath = join(args.root, `${args.propertyCode}-${target}-hold`);
    await assertNoTargetHold();
    const priorProfile = journal?.workflowAttempts?.guest_profile_create ??
      (journal?.workflowAttempt?.workflow === 'guest_profile_create' ? journal.workflowAttempt : null);
    const profileHeld = journal?.status === 'guest_profile_create_possible' ||
      journal?.status === 'uncertain_held' && journal.workflowAttempt?.workflow === 'guest_profile_create';
    if (profileHeld && priorProfile && journal.created?.freshReadbackVerified === true &&
        ['amend', 'attach', 'addons', 'cancel'].includes(args.stage)) {
      journal = { ...journal, status: 'created',
        workflowHolds: { ...journal.workflowHolds, guest_profile_create: {
          status: 'uncertain_held', issue: journal.issue, attempt: priorProfile } } };
    }
    let finished;
    if (args.stage === 'prepare' && journal) {
      // Prepare starts a new lifecycle unless this journal may still own a saved stay.
      assert(journal.status !== 'created', 'STAGE_INVALID');
      assert(['prepared', 'prepare_observed', 'cancelled'].includes(journal.status), 'JOURNAL_REQUIRES_RECONCILIATION');
      finished = join(journalDir, `${args.propertyCode}-journal.${Date.now()}.${journal.status}.json`);
      journal = null;
    }
    if (args.stage !== 'prepare') {
      assert(journal, 'PREPARE_REQUIRED');
      assert(journal.requestDigest === hash(request), 'JOURNAL_BINDING_MISMATCH');
      assert(['prepared', 'created'].includes(journal.status), 'JOURNAL_REQUIRES_RECONCILIATION');
      assert(journal.status === (args.stage === 'create' ? 'prepared' : 'created'), 'STAGE_INVALID');
    }
    if (!['prepare', 'create', 'cancel'].includes(args.stage)) {
      const order = ['amend', 'attach', 'addons'];
      assert(!journal.workflowHolds?.[args.stage], 'JOURNAL_HELD');
      assert(!journal.workflowProofs?.[args.stage] && !(args.stage === 'guest_profile_create' ? [] : order.slice(order.indexOf(args.stage) + 1))
        .some(workflow => journal.workflowProofs?.[workflow]), 'WORKFLOW_ALREADY_RUN_OR_OUT_OF_ORDER');
    }
    const cloud = await load('tooling/hms-cloud/cloud-session.mjs');
    const credential = await load('tooling/hms-cloud/credential-version.mjs');
    const { createReservation } = await load('tooling/hms-cloud/create-reservation.mjs');
    const { digestCloudCreateRequest } = await load('tooling/hms-cloud/create-request-binding.mjs');
    const { hmsDispatchTargetKeys, hmsGuestProfileTargetKeys } = await load('dist/ai/hms-dispatch-target.js');
    const { createPostgresTargetAliasLock } = await load('dist/hms/property-read-lock.js');
    assert(process.env.DATABASE_URL && !process.env.TEST_DATABASE_URL && !process.env.VITEST_ALLOW_PILOT_RDS, 'RUNTIME_DATABASE_REQUIRED');
    const credentialProvenance = await bindCredentialMetadata(property, credential.credentialVersionHmacSha256);
    let writerDependencyDigest;
    if (args.stage !== 'prepare') {
      const { hmsWriterDependencyDigest } = await load('tooling/hms-cloud/hms-workflow-policy.mjs');
      writerDependencyDigest = hmsWriterDependencyDigest(args.stage);
      assert(/^[a-f0-9]{64}$/.test(writerDependencyDigest), 'WRITER_DEPENDENCY_DIGEST_INVALID');
    }
    const provenance = { ...journal?.provenance, [args.stage]: Object.freeze({
      ...credentialProvenance, propertyCode: args.propertyCode, tenantId: property.expectedTenant,
      boundBeforeNativeAt: new Date().toISOString(), ...(writerDependencyDigest ? { writerDependencyDigest } : {}) }) };
    await checkHold();
    if (journal) await persist({ ...journal, provenance, updatedAt: new Date().toISOString() });
    const withTarget = async (target, action) => {
      await checkHold();
      if (target.kind === 'create') {
        holdPath = join(args.root, `${args.propertyCode}-create-${hash([target.arrival, guest])}-hold`);
      }
      await assertNoTargetHold();
      const aliases = target.kind === 'guest_profile'
        ? hmsGuestProfileTargetKeys({ propertyCode: args.propertyCode, ...target.guest }) : hmsDispatchTargetKeys(target);
      const lock = createPostgresTargetAliasLock({ tenantId: property.expectedTenant, propertyCode: args.propertyCode,
        targetAliases: aliases, databaseUrl: process.env.DATABASE_URL });
      return lock.withLock(async (_connection, signal) => {
        await checkHold(signal);
        return cloud.withCloudCredentialLease(args.propertyCode, async lease => {
          await checkHold(signal);
          return action({ credentialLease: lease, signal: AbortSignal.any([signal, lease.signal]),
            cloudTargetKey: aliases[0], cloudTargetKeys: aliases });
        }, { signal });
      });
    };
    let result;
    if (args.stage === 'prepare') {
      // Census first: a live Proof Labtest stay on the same arrival fails Save with LABTEST_PREIMAGE_NOT_CLEAR.
      const { searchLabtestPreimage } = await load('tooling/hms-cloud/labtest-preimage.mjs');
      const { installReadOnlyGuard } = await load('tooling/hms-cloud/hms-read-only-guard.mjs');
      const { blockingCreateMatches, sameCreateGuest } = await load('tooling/hms-cloud/cloud-create-policy.mjs');
      const nights = Math.round((Date.parse(`${request.stay.departure}T00:00:00Z`) - Date.parse(`${request.stay.arrival}T00:00:00Z`)) / 86_400_000);
      const census = { requested: { arrival: request.stay.arrival, departure: request.stay.departure }, attempts: [] };
      const occupied = new Set();
      let stay;
      if (finished) await rename(journalPath, finished);
      for (let arrival = request.stay.arrival; !stay; ) {
        assert(census.attempts.length < 5, 'LABTEST_DATES_UNAVAILABLE');
        const departure = addDays(arrival, nights);
        await checkHold();
        const found = await cloud.withCloudCredentialLease(args.propertyCode, lease => cloud.withCloudReadSession(
          page => searchLabtestPreimage(page, { propertyCode: args.propertyCode, arrival, departure }),
          { propertyCode: args.propertyCode, transportId, credentialLease: lease, signal: lease.signal,
            startScreen: 'OSRESS', prepareContext: installReadOnlyGuard }));
        census.attempts.push({ arrival, departure, outcome: found?.outcome ?? null, issue: found?.issue ?? null,
          observedAt: new Date().toISOString() });
        if (found?.outcome === 'clear') { stay = { ...request.stay, arrival, departure }; break; }
        assert(found?.outcome === 'existing_matches' && found.coverage?.complete === true && Array.isArray(found.candidates),
          'LABTEST_CENSUS_INCOMPLETE');
        occupied.add(arrival);
        for (const row of blockingCreateMatches(found.candidates.filter(row => sameCreateGuest(row, guest)))) occupied.add(row.arrival);
        do { arrival = addDays(arrival, 1); } while (occupied.has(arrival));
      }
      const note = request.note ?? `Labtest proof ${args.propertyCode} ${args.sha}`;
      result = await withTarget({ propertyCode: args.propertyCode, kind: 'create', ...guest, arrival: stay.arrival }, async options => {
        const prepared = await createReservation({ ...request, stay, note, mode: 'prepare' }, { ...options, transportId,
          allowRealGuest: false, expectedGuest: guest, capturePrepareScreenshot: true });
        const nativePrepare = Object.fromEntries(['outcome', 'issue', 'field', 'stage', 'missing', 'invalidFields',
          'unsupportedFields', 'applied', 'appliedVerification', 'warnings', 'guestNameDraft', 'guestSearchOutcome',
          'guestCandidates', 'guestCoverage', 'guestCorrelation', 'partySearches', 'roomCandidates', 'coverage',
          'roomSearch', 'ratePlanSearch', 'sourceSearch', 'cmsSearch', 'ratePlanIssue', 'ratePlanAvailability',
          'requestBinding', 'requestBindingIssue', 'screenshots'].filter(key => Object.hasOwn(prepared, key))
          .map(key => [key, prepared[key]]));
        if (prepared.detail) nativePrepare.detail = Object.fromEntries(['outcome', 'issue', 'field', 'stage',
          'code', 'actual', 'candidates', 'coverage', 'rateAvailability'].filter(key => Object.hasOwn(prepared.detail, key))
          .map(key => [key, prepared.detail[key]]));
        await persist({ version: 1, propertyCode: args.propertyCode, sha: args.sha, request, requestDigest: hash(request),
          provenance, census, proofRequest, status: 'prepare_observed', nativePrepare, updatedAt: new Date().toISOString() });
        assert(prepared.outcome === 'prepared' && prepared.appliedVerification?.visibleFields === true &&
          prepared.applied?.guest?.firstName === guest.firstName && prepared.applied?.guest?.lastName === guest.lastName &&
          /^\d+$/.test(String(prepared.applied.guest.nativeId)) && /^[a-f0-9]{64}$/.test(prepared.requestBinding?.digest ?? '') &&
          prepared.requestBinding.request?.sendHmsConfirmation?.kind === 'never' &&
          !prepared.requestBinding.request?.parties && !prepared.requestBinding.request?.nativeCommissionPercent, 'PREPARE_UNVERIFIED');
        const effectiveRequest = requestSchema.parse({ ...request, stay,
          guest: { profileId: String(prepared.applied.guest.nativeId) }, note: prepared.applied.note });
        return { status: 'prepared', effectiveRequest, prepared: { applied: prepared.applied,
          requestBinding: prepared.requestBinding, ratePlanAvailability: prepared.ratePlanAvailability,
          screenshots: prepared.screenshots } };
      });
    } else if (args.stage === 'create') {
      const effective = requestSchema.parse(journal.effectiveRequest);
      assert(effective.note === journal.prepared.applied.note && effective.guest.profileId === String(journal.prepared.applied.guest.nativeId), 'PREPARED_IDENTITY_INVALID');
      const binding = digestCloudCreateRequest(journal.prepared.requestBinding?.request);
      assert(binding.outcome === 'ok' && binding.normalizedRequestDigest === journal.prepared.requestBinding.digest &&
        binding.request.guest.nativeId === effective.guest.profileId && binding.request.guest.firstName === 'Proof' &&
        binding.request.guest.lastName === 'Labtest' && binding.request.sendHmsConfirmation.kind === 'never' &&
        !binding.request.parties && !Object.hasOwn(binding.request, 'nativeCommissionPercent'), 'PREPARED_BINDING_INVALID');
      result = await withTarget({ propertyCode: args.propertyCode, kind: 'create', ...guest, arrival: effective.stay.arrival }, async options => {
        await markPossible('dispatch_possible');
        await checkHold(options.signal);
        const saved = await createReservation({ ...effective, mode: 'commit' }, { ...options, transportId,
          allowRealGuest: false, expectedGuest: guest });
        await persist({ ...journal, createResult: { outcome: saved.outcome,
          issue: saved.issue ?? null, field: saved.field ?? null, stage: saved.stage ?? null,
          missing: saved.missing ?? null, writerSessionClosed: saved.writerSessionClosed === true,
          savePresent: Object.hasOwn(saved, 'save'), save: safeNativeResult(saved.save),
          confirmation: saved.confirmation ?? null, nativeStayId: saved.nativeStayId ?? null,
          mismatches: saved.readback?.mismatches ?? null, readback: {
            observedAt: saved.readback ? new Date().toISOString() : null, fields: saved.readback?.fields ?? null, issue: saved.readback?.issue ?? null,
            nativeStayId: saved.readback?.nativeStayId ?? null, mismatches: saved.readback?.mismatches ?? null,
            pricing: saved.readback?.pricing ?? null, criteria: saved.readback?.criteria ?? null,
            partyProof: saved.readback?.partyProof ?? null } }, updatedAt: new Date().toISOString() });
        assert(saved.outcome === 'saved' && saved.writerSessionClosed === true && saved.save?.dispatchCallbacksDrained === true &&
          saved.save?.browserSendRequests === 0 && Array.isArray(saved.readback?.mismatches) && !saved.readback.mismatches.length &&
          /^\d+-\d+$/.test(saved.confirmation ?? '') && /^\d{1,100}$/.test(saved.nativeStayId ?? ''), 'CREATE_UNCERTAIN_HELD');
        return { status: 'created', created: { confirmation: saved.confirmation, nativeStayId: saved.nativeStayId,
          guestId: effective.guest.profileId, note: effective.note, save: safeNativeResult(saved.save),
          freshReadbackVerified: true, screenshots: saved.screenshots } };
      });
    } else if (args.stage !== 'cancel') {
      const { runLabtestWorkflow, verifyLabtestWorkflowProof } = await load('tooling/hms-cloud/labtest-proof-workflows.mjs');
      if (args.stage === 'guest_profile_create' && !journal.profileProofGuest) {
        await persist({ ...journal, profileProofGuest: {
          firstName: `Proof${randomUUID().replaceAll('-', '').slice(0, 12)}`, lastName: 'Labtest',
          mobile: `+2700${String(BigInt(`0x${randomUUID().replaceAll('-', '')}`) % 10000000n).padStart(7, '0')}`, email: '',
        } });
      }
      const target = args.stage === 'guest_profile_create' ? { kind: 'guest_profile', guest: journal.profileProofGuest } :
        { propertyCode: args.propertyCode, kind: 'saved', confirmation: journal.created.confirmation,
          nativeStayId: journal.created.nativeStayId };
      result = await withTarget(target, async options => {
        const proof = await runLabtestWorkflow({ workflow: args.stage, journal, property, transportId, options,
          root: args.root, journalDir, checkHold, markPossible,
          record: async evidence => persist({ ...journal, workflowAttempt: { workflow: args.stage, ...evidence },
            workflowAttempts: { ...journal.workflowAttempts, [args.stage]: { workflow: args.stage, ...evidence } },
            updatedAt: new Date().toISOString() }) });
        verifyLabtestWorkflowProof(journal, args.stage, proof);
        return { status: 'created', workflowProofs: { ...journal.workflowProofs, [args.stage]: proof } };
      });
    } else {
      const { readShallow, readRecord } = await load('tooling/hms-cloud/hms-readers.mjs');
      const { installSavedStayReadGuard } = await load('tooling/hms-cloud/saved-stay-read-guard.mjs');
      const { cancellationNativePreimage } = await load('tooling/hms-cloud/pane-cancel-session.mjs');
      const { verifySingleCancellationScope } = await load('tooling/hms-cloud/cancel-association-scope.mjs');
      const { openLabtestCancellation, confirmLabtestCancellation } = await load('tooling/hms-cloud/guest-stay-cancel.mjs');
      const own = journal.created, effective = requestSchema.parse(journal.effectiveRequest);
      assert(own?.freshReadbackVerified === true && /^\d+-\d+$/.test(own.confirmation ?? '') && /^\d+$/.test(own.nativeStayId ?? '') &&
        own.note === effective.note && own.guestId === effective.guest.profileId, 'CANCEL_TARGET_INVALID');
      const lookup = async page => {
        await checkHold();
        await readShallow(page, own.confirmation, { guestName: 'Proof Labtest', arrivalDate: effective.stay.arrival });
        return readRecord(page, own.confirmation, { nativePropertyCode: args.propertyCode });
      };
      const initial = await cloud.withCloudCredentialLease(args.propertyCode, lease => cloud.withCloudReadSession(lookup,
        { propertyCode: args.propertyCode, transportId, credentialLease: lease, signal: lease.signal, startScreen: 'OSRESS',
          prepareContext: context => installSavedStayReadGuard(context, { propertyCode: args.propertyCode, confirmation: own.confirmation }) }));
      const expected = cancellationNativePreimage(initial, { propertyCode: args.propertyCode, allowRealGuest: false });
      assert(expected && expected.allowRealGuest === false && expected.cmsSend === false && expected.firstName === 'Proof' &&
        expected.lastName === 'Labtest' && expected.arrival === effective.stay.arrival && expected.departure === effective.stay.departure &&
        expected.confirmation === own.confirmation && expected.nativeStayId === own.nativeStayId &&
        expected.guestId === own.guestId && expected.note === own.note, 'CANCEL_PREIMAGE_INVALID');
      // Zero children proves an empty age list even when Record View omits childages, as in Create readback.
      const observedAges = native => native?.children === 0 ? [] : native?.childAges;
      const sortedAges = ages => hash([...ages].sort((a, b) => a - b));
      assert(Array.isArray(observedAges(initial?.nativePreimage)) &&
        sortedAges(observedAges(initial.nativePreimage)) === sortedAges(effective.stay.childAges), 'CANCEL_CHILD_AGES_UNVERIFIED');
      result = await withTarget({ propertyCode: args.propertyCode, kind: 'saved', confirmation: own.confirmation, nativeStayId: own.nativeStayId }, async options => {
        let ownedPage, cancelled, reason;
        const base = { ...options, propertyCode: args.propertyCode, transportId, startScreen: 'OSRESS' };
        await cloud.withCloudWriterSession(async page => {
          ownedPage = page;
          const fresh = cancellationNativePreimage(await lookup(page), { propertyCode: args.propertyCode, allowRealGuest: false });
          assert(fresh && hash(fresh) === hash(expected), 'CANCEL_PREIMAGE_CHANGED');
          await checkHold(options.signal);
          assert(await verifySingleCancellationScope(page, expected), 'CANCEL_SCOPE_UNVERIFIED');
          await markPossible('cancel_possible', { cancelExpected: expected });
          await checkHold(options.signal);
          const opened = await openLabtestCancellation(page, expected);
          await persist({ ...journal, cancelOpen: safeNativeResult(opened), updatedAt: new Date().toISOString() });
          assert(opened.outcome === 'reason_ready', 'CANCEL_OPEN_UNVERIFIED');
          const matches = opened.reasons?.filter(value => value.value === 'TEST' && value.display === 'Test Reservations');
          assert(matches?.length === 1, 'CANCEL_TEST_REASON_UNAVAILABLE');
          reason = matches[0];
          await checkHold(options.signal);
          cancelled = await confirmLabtestCancellation(page, expected, { reasonCode: reason.value, reasonLabel: reason.display,
            cancellationNote: CANCELLATION_NOTE,
            continuationAllowed: () => !options.signal.aborted,
            dispatchWithAuthority: async send => { await checkHold(options.signal); return send(); } });
          await persist({ ...journal, cancelResult: safeNativeResult(cancelled), updatedAt: new Date().toISOString() });
        }, { ...base, prepareContext: context => installSavedStayReadGuard(context, { propertyCode: args.propertyCode,
          confirmation: own.confirmation, getOwnedPage: () => ownedPage, forwardToCloud: true }) });
        assert(cancelled?.dispatchCallbacksDrained === true, 'CANCEL_CALLBACK_DRAIN_UNCONFIRMED');
        const readback = await cloud.withCloudReadSession(async page => {
          const record = await lookup(page), native = record?.nativePreimage;
          const fields = record?.details?.fields ?? [];
          const field = key => { const values = fields.filter(value => value.name === key); return values.length === 1 ? values[0] : null; };
          assert(native?.source === 'record_view_ext_model' && native.propertyCode === args.propertyCode &&
            native.confirmation === own.confirmation && native.reservationStayId === own.nativeStayId && native.guestId === own.guestId &&
            native.firstName === 'Proof' && native.lastName === 'Labtest' && native.arrival === expected.arrival &&
            native.departure === expected.departure && native.roomType === expected.roomType && native.ratePlan === expected.ratePlan &&
            native.adults === effective.stay.adults && native.children === effective.stay.childAges.length &&
            Array.isArray(observedAges(native)) && sortedAges(observedAges(native)) === sortedAges(effective.stay.childAges) &&
            (effective.guestoptin4 === undefined || field('guestoptin4')?.value === effective.guestoptin4) &&
            (effective.marketSegment === undefined || native.marketSegmentCode === effective.marketSegment) &&
            (effective.track === undefined || field('track')?.value === journal.prepared.applied.track) &&
            /^cancel(?:l)?ed$/i.test(native.status ?? '') && field('udfchkbox04')?.value === false &&
            field('reservationnote')?.rawValue === own.note, 'CANCEL_READBACK_IDENTITY_UNVERIFIED');
          const frames = page.locator('.x-window:visible:not(.x-menu) iframe:visible');
          assert(await frames.count() === 1, 'CANCEL_READBACK_FRAME_UNVERIFIED');
          const frame = await (await frames.elementHandle())?.contentFrame();
          assert(frame, 'CANCEL_READBACK_FRAME_UNVERIFIED');
          const verified = await frame.evaluate(({ confirmation, nativeStayId, guestId, reasonCode, note }) => {
            const visible = el => Boolean((el.offsetWidth || el.offsetHeight) && getComputedStyle(el).visibility !== 'hidden' && !el.closest('.x-window'));
            const guests = [...document.querySelectorAll('input[name="guestid"]')].filter(visible);
            if (guests.length !== 1) return false;
            const data = globalThis.Ext?.getCmp?.(guests[0].id.replace(/-inputEl$/, ''))?.up?.('form')?.getRecord?.()?.data;
            const exact = (key, value) => data && Object.hasOwn(data, key) && Object.keys(data).filter(name => name.toLowerCase() === key.toLowerCase()).length === 1 && String(data[key] ?? '') === value;
            return { verified: exact('confirmationnumber', confirmation) && exact('reservationstayid', nativeStayId) && exact('guestid', guestId) &&
              exact('cancelreason', reasonCode) && exact('cancellationnote', note) && exact('reservationstaystatus', 'CANCELED'),
              reasonCode: String(data?.cancelreason ?? ''), cancellationNote: String(data?.cancellationnote ?? ''),
              reservationStayStatus: String(data?.reservationstaystatus ?? '') };
          }, { confirmation: own.confirmation, nativeStayId: own.nativeStayId, guestId: own.guestId,
            reasonCode: reason.value, note: CANCELLATION_NOTE });
          assert(verified?.verified === true, 'CANCEL_REASON_READBACK_UNVERIFIED');
          const businessFields = new Set(['confirmationnumber', 'guestid', 'firstname', 'lastname', 'arrivaldate', 'departuredate',
            'adults', 'children', 'roomtype', 'roomtypecharge', 'rateplan', 'guaranteetype', 'reservationnote', 'guestoptin4',
            'udfchkbox04', 'marketsegment', 'track', 'sourceofbus', 'sourceofbusinessdesc']);
          const finalFields = fields.filter(value => businessFields.has(value.name) || /^child[1-9]\d*(?:_display)?$/i.test(value.name || ''))
            .map(value => Object.fromEntries(['name', 'value', 'rawValue', 'nativeCode'].filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]])));
          const nativeObservation = Object.fromEntries(['source', 'propertyCode', 'confirmation', 'reservationStayId', 'guestId', 'firstName',
            'lastName', 'arrival', 'departure', 'roomType', 'ratePlan', 'adults', 'children', 'childAges', 'cmsSend', 'note', 'marketSegmentCode', 'status']
            .filter(key => Object.hasOwn(native, key)).map(key => [key, native[key]]));
          nativeObservation.childAges = observedAges(native);
          nativeObservation.cancelReasonCode = verified.reasonCode;
          nativeObservation.cancellationNote = verified.cancellationNote;
          nativeObservation.reservationStayStatus = verified.reservationStayStatus;
          return { confirmation: own.confirmation, nativeStayId: own.nativeStayId, guestId: own.guestId,
            status: native.status, reasonCode: verified.reasonCode, cancellationNote: verified.cancellationNote, freshReadbackVerified: true,
            readback: { fields: finalFields, native: nativeObservation, cancelModelVerified: true, observedAt: new Date().toISOString() } };
        }, { ...base, prepareContext: context => installSavedStayReadGuard(context, { propertyCode: args.propertyCode, confirmation: own.confirmation }) });
        const zeroNotice = cancelled.outcome === 'zero_notice_awaiting_readback' && cancelled.zeroPenaltyNotice === ZERO_PENALTY_NOTICE;
        assert((cancelled.outcome === 'awaiting_readback' || zeroNotice) && cancelled.requestDispatched === true && cancelled.httpStatus === 200 &&
          cancelled.browserSendRequests === 0 && cancelled.chargeApproved === false && cancelled.chargeDispatched === false &&
          Array.isArray(cancelled.blockedRequests) && !cancelled.blockedRequests.length, 'CANCEL_UNCERTAIN_HELD');
        return { status: 'cancelled', cancelled: { ...readback, nativeResult: safeNativeResult(cancelled) } };
      });
    }
    await checkHold();
    await persist({ ...journal, ...result, provenance, updatedAt: new Date().toISOString() });
    if (mutationPossible) { await unlink(holdPath); mutationPossible = false; }
    process.stdout.write(`${JSON.stringify({ outcome: result.status, propertyCode: args.propertyCode, sha: args.sha,
      journalPath, stay: { arrival: journal.effectiveRequest.stay.arrival, departure: journal.effectiveRequest.stay.departure },
      confirmation: journal.created?.confirmation ?? null, nativeStayId: journal.created?.nativeStayId ?? null,
      requestBindingDigest: journal.prepared?.requestBinding?.digest ?? null })}\n`);
  } finally { await releaseLock(fileLock); }
}

const resultLine = verdict => `PROOF ${verdict} ${args?.stage ?? '-'} ${args?.propertyCode ?? '-'} ${args?.sha ?? '-'} ` +
  `conf=${journal?.created?.confirmation ?? journal?.createResult?.confirmation ?? '-'}\n`;

main().then(() => {
  process.stdout.write(resultLine('PASS'));
  // A leftover lease heartbeat or browser handle must not keep a finished stage alive.
  process.exit(0);
}, async error => {
  const issue = /^[A-Z][A-Z0-9_]{2,100}$/.test(error?.message ?? '') ? error.message : 'PROOF_FAILED';
  if (mutationPossible && journal) {
    await persist({ ...journal,
      status: args.stage === 'guest_profile_create' ? resumeStatus : 'uncertain_held', issue,
      workflowHolds: { ...journal.workflowHolds, [args.stage]: { status: 'uncertain_held', issue, holdPath } },
      updatedAt: new Date().toISOString() }).catch(() => {});
  }
  process.stderr.write(`${JSON.stringify({ outcome: mutationPossible ? 'uncertain_held' : 'refused', issue,
    propertyCode: args?.propertyCode ?? null, journalPath: journalPath ?? null })}\n`);
  process.stdout.write(resultLine('FAIL'));
  process.exit(1);
});
