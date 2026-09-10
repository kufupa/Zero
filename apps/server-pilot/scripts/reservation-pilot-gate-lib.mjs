import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';
import path from 'node:path';

const ALLOWED_MODES = new Set(['current-state', 'historical-replay', 'future-shadow']);
const ALLOWED_OUTCOMES = new Set([
  'match',
  'mismatch',
  'changed_state',
  'ambiguous',
  'unscorable',
  'denied',
  'missing_capability',
]);
const BLOCKED_OUTCOMES = new Set([
  'changed_state',
  'unscorable',
  'ambiguous',
  'denied',
  'missing_capability',
]);
const HOLDOUT_ACTIONS = new Set(['tune', 'repair', 'choose-fixture', 'retry']);

const DB_PROFILES = Object.freeze({
  pg17: Object.freeze({
    name: 'pg17',
    runLabel: '20260907-u1setup',
    port: '15432',
    major: '17',
    receipt: '.private/centurion-dashboard-tools-execution/disposable-postgres-receipt.txt',
    connection: '.private/centurion-dashboard-tools-execution/disposable-postgres-connection.env',
    sentinelTable: 'centurion_u1_setup_sentinel',
    sentinelMarker: '20260907-u1setup',
    requiredLabels: {
      'zero.owner': 'centurion-dashboard-tools',
      'zero.run': '20260907-u1setup',
      'zero.lifecycle': 'disposable',
    },
  }),
  pg16: Object.freeze({
    name: 'pg16',
    runLabel: '20260907-pg16-u1setup',
    port: '15433',
    major: '16',
    receipt: '.private/centurion-dashboard-tools-execution/pg16/disposable-postgres-receipt.txt',
    connection:
      '.private/centurion-dashboard-tools-execution/pg16/disposable-postgres-connection.env',
    sentinelTable: 'centurion_u1_pg16_setup_sentinel',
    sentinelMarker: '20260907-pg16-u1setup',
    requiredLabels: {
      'zero.owner': 'centurion-dashboard-tools',
      'zero.run': '20260907-pg16-u1setup',
      'zero.lifecycle': 'disposable',
      'zero.purpose': 'migration-parity',
      'zero.postgres-major': '16',
    },
  }),
});

export function getDbProfile(name = 'pg17') {
  const profile = DB_PROFILES[name];
  if (!profile) throw new Error(`unknown disposable database profile: ${name}`);
  return clone(profile);
}

export const CHILD_ENV_ALLOWLIST = new Set([
  'PATH',
  'HOME',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'CI',
  'FORCE_COLOR',
  'NO_COLOR',
  'PNPM_HOME',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'NODE_ENV',
  'NODE_OPTIONS',
  'MAIL_TRANSPORT_MODE',
  'HMS_TRANSPORT_MODE',
  'PMS_TRANSPORT_MODE',
  'AWS_EC2_METADATA_DISABLED',
  'NO_PROXY',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'DOTENV_CONFIG_PATH',
  'NAVA_FIXTURE_NETWORK',
  'NAVA_EXTERNAL_SOCKETS',
  'NAVA_FIXTURE_ORIGIN',
  'NAVA_TEST_DATABASE_URL',
  'TEST_DATABASE_URL',
  'CONFIRM_DISPOSABLE_TEST_DB',
  'HMS_DB_TEST_REQUIRED',
  'NAVA_TEST_DATABASE_SCOPE',
  'NAVA_TEST_DATABASE_PROFILE',
  'DATABASE_URL',
  'PORT',
  'BETTER_AUTH_URL',
  'BETTER_AUTH_SECRET',
  'AWS_REGION',
  'S3_BUCKET',
]);

const SLICE_PLANS = {
  unit: {
    gate: {
      server: [
        'tests/reservation-pilot-gate.test.ts',
        'tests/reservation-pilot-gate-dispatch.test.ts',
        'tests/fixtures/reservation-tools-pilot.json',
        'scripts/reservation-pilot-gate-lib.mjs',
        'scripts/reservation-pilot-fixture-guard.mjs',
      ],
    },
    dashboard: {
      server: [
        'tests/admin-dashboard-access.test.ts',
        'tests/admin-dashboard-metrics.test.ts',
        'tests/admin-dashboard-query.test.ts',
        'tests/admin-dashboard-export.test.ts',
      ],
      mail: [
        'tests/admin-dashboard/response-metrics-availability.test.ts',
        'tests/admin-dashboard/business-overview.test.tsx',
        'tests/admin-dashboard/export.test.ts',
      ],
    },
    measurement: {
      server: ['tests/mail-measurement-config.test.ts', 'tests/mail-data-health.test.ts'],
    },
    reads: {
      server: [
        'tests/hms-read-service.test.ts',
        'tests/hms-normal-runtime-read-service.test.ts',
        'tests/hms-reservation-context.test.ts',
        'tests/hms-property-read-lock.test.ts',
      ],
    },
    documents: {
      server: [
        'tests/existing-document-service.test.ts',
        'tests/existing-document-validation.test.ts',
        'tests/hms-live-communications-reads.test.ts',
        'tests/hms-artifact.test.ts',
      ],
    },
    finance: {
      server: [
        'tests/hms-folio-read.test.ts',
        'tests/hms-live-folio-read.test.ts',
        'tests/hms-finance-completeness.test.ts',
      ],
    },
    quotes: {
      server: [
        'tests/hms-quote-stay-v2.test.ts',
        'tests/hms-live-quote-stay.test.ts',
        'tests/hms-quote-request-normalization.test.ts',
        'tests/hms-quote-completeness.test.ts',
      ],
    },
    contexts: {
      server: ['tests/hms-context-reads.test.ts', 'tests/hms-notes-traces-read.test.ts'],
    },
    knowledge: {
      server: ['tests/property-knowledge-read.test.ts'],
      fixtures: ['tests/fixtures/property-knowledge.json'],
    },
    drafting: {
      server: [
        'tests/reply-playbooks.test.ts',
        'tests/reply-assessment.test.ts',
        'tests/prepared-draft-input.test.ts',
        'tests/hms-candidate-agent.test.ts',
        'tests/hms-claim-envelope.test.ts',
        'tests/hms-live-guest-stay.test.ts',
        'tests/local-model-adapter-contract.test.ts',
        'tests/shadow-model-routing.test.ts',
      ],
    },
    baseline: {
      server: [
        'tests/mail-baseline.test.ts',
        'tests/mail-baseline-projection.test.ts',
        'tests/mail-baseline-extraction.test.ts',
        'tests/mail-baseline-ingest.test.ts',
        'tests/mail-baseline-coverage.test.ts',
      ],
    },
    shadow: {
      server: [
        'tests/shadow-evaluation.test.ts',
        'tests/shadow-reference-matcher.test.ts',
        'tests/shadow-scorecard.test.ts',
      ],
    },
    approval: {
      server: ['tests/draft-approval.test.ts', 'tests/draft-refresh-generation.test.ts'],
    },
  },
  db: {
    dashboard: { server: ['tests/admin-dashboard-query.test.ts'] },
    reads: {
      server: ['tests/hms-read-service.test.ts', 'tests/hms-normal-runtime-read-service.test.ts'],
    },
    quotes: { server: ['tests/hms-quote-db.test.ts'] },
    finance: { server: ['tests/hms-finance-db.test.ts'] },
    documents: { server: ['tests/existing-document-validation.test.ts'] },
    baseline: {
      server: [
        'tests/mail-baseline-projection.test.ts',
        'tests/mail-baseline-worker.test.ts',
        'tests/outbound-queue.test.ts',
      ],
    },
    shadow: { server: ['tests/shadow-evaluation.test.ts'] },
    integration: { server: ['tests/reservation-tools-pilot-integration.test.ts'] },
    outbox: {
      server: [
        'tests/outbound-queue.test.ts',
        'tests/draft-stale-conflict.test.ts',
        'tests/hms-candidate-state.test.ts',
      ],
    },
    'candidate-drafting': {
      server: ['tests/ai-candidate-draft-contract.test.ts', 'tests/ai-worker-contract.test.ts'],
    },
  },
  browser: {
    dashboard: {
      mail: ['tests/e2e/reservation-tools-pilot.spec.ts'],
      grep: 'reservation-tools-pilot/dashboard',
    },
    documents: {
      mail: ['tests/e2e/reservation-tools-pilot.spec.ts'],
      grep: 'reservation-tools-pilot/documents',
    },
    pilot: {
      mail: ['tests/e2e/reservation-tools-pilot.spec.ts'],
      grep: 'reservation-tools-pilot/pilot',
    },
  },
  build: {
    server: { package: '@zero/server' },
    mail: { package: '@zero/mail' },
  },
};

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function sortCanonical(value) {
  if (Array.isArray(value)) return value.map(sortCanonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortCanonical(value[key])]),
    );
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(sortCanonical(value));
}

function digest(value) {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

function digestInputs(manifest) {
  const phase2B = manifest.phase2B;
  const source = manifest.source;
  const cases = manifest.cases;
  const caseMapping = cases.map((pilotCase) => ({
    id: pilotCase.id,
    conversationId: pilotCase.conversationId,
    evaluationMode: pilotCase.evaluationMode,
    split: pilotCase.split,
    selectionStatus: pilotCase.selectionStatus,
    skipReason: pilotCase.skipReason ?? null,
  }));
  return {
    content: {
      schemaVersion: manifest.schemaVersion,
      fixtureKind: manifest.fixtureKind,
      publicFixture: manifest.publicFixture,
      source: { name: source.name, version: source.version },
      counts: manifest.counts,
      privacy: manifest.privacy,
      phase2B: {
        membershipFrozenBeforeResults: phase2B.membershipFrozenBeforeResults,
        caseIdentifiersFrozenBeforeResults: phase2B.caseIdentifiersFrozenBeforeResults,
        evaluationModeFrozenBeforeResults: phase2B.evaluationModeFrozenBeforeResults,
        selectionReasonsFrozenBeforeResults: phase2B.selectionReasonsFrozenBeforeResults,
        conversationSplitFrozen: phase2B.conversationSplitFrozen,
        splitUnit: phase2B.splitUnit,
        goldTargetExposure: phase2B.goldTargetExposure,
        modeSpecificAggregation: phase2B.modeSpecificAggregation,
        allowedOutcomes: phase2B.allowedOutcomes,
        blockedPassOutcomes: phase2B.blockedPassOutcomes,
      },
      cases,
      laterInboundFirstHoldout: manifest.laterInboundFirstHoldout,
      ...(source.inputDigestSetHash ? { inputDigestSetHash: source.inputDigestSetHash } : {}),
      ...(source.canonicalMap ? { canonicalMap: source.canonicalMap } : {}),
      ...(source.pointerDigests ? { pointerDigests: source.pointerDigests } : {}),
      ...(manifest.partitionSummary ? { partitionSummary: manifest.partitionSummary } : {}),
      browserSafety: manifest.browserSafety,
    },
    mapping: {
      caseMapping: caseMapping.map((entry, index) => ({
        ...entry,
        ...(cases[index]?.partitionLabels ? { partitionLabels: cases[index].partitionLabels } : {}),
        ...(cases[index]?.conversationBasis
          ? { conversationBasis: cases[index].conversationBasis }
          : {}),
      })),
    },
    selection: {
      counts: manifest.counts,
      selectionHashScope: 'conversation-membership-before-outcomes',
      caseMapping,
    },
  };
}

export function computeManifestDigests(manifest) {
  const inputs = digestInputs(manifest);
  return {
    contentHash: digest(inputs.content),
    mappingHash: digest(inputs.mapping),
    selectionHash: digest(inputs.selection),
  };
}

/**
 * Hash an opaque identifier without allowing private source identifiers into a
 * qualification receipt. This is intentionally a one-way, canonical digest.
 */
export function hashOpaqueIdentifier(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('opaque qualification identifier must be a non-empty string');
  }
  return digest({ opaque: value });
}

/** Hash bytes as a transport-independent SHA-256 digest. */
export function sha256Bytes(bytes) {
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) {
    throw new Error('qualification input bytes are required');
  }
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function normalizeSha256(value, label) {
  const raw = typeof value === 'string' ? value.replace(/^sha256:/, '') : '';
  if (!/^[a-f0-9]{64}$/i.test(raw)) throw new Error(`${label} must be a SHA-256 digest`);
  return `sha256:${raw.toLowerCase()}`;
}

function qualificationFile(root, relativePath, label) {
  if (typeof root !== 'string' || typeof relativePath !== 'string' || relativePath.length === 0) {
    throw new Error(`${label} path is required`);
  }
  const rootPath = path.resolve(root);
  const target = path.resolve(rootPath, relativePath);
  if (target !== rootPath && !target.startsWith(`${rootPath}${path.sep}`)) {
    throw new Error(`${label} path escapes the private root`);
  }
  let metadata;
  try {
    metadata = lstatSync(target);
  } catch {
    throw new Error(`${label} path is missing`);
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a regular non-symlink file`);
  }
  return target;
}

function qualificationInputDescriptor(input, label) {
  if (!input || typeof input !== 'object') throw new Error(`${label} descriptor is required`);
  if (typeof input.path !== 'string' || input.path.length === 0) {
    throw new Error(`${label} path is required`);
  }
  if (!Number.isSafeInteger(input.bytes) || input.bytes < 0) {
    throw new Error(`${label} byte count is invalid`);
  }
  return {
    ...(typeof input.name === 'string' ? { name: input.name } : {}),
    path: input.path,
    bytes: input.bytes,
    sha256: normalizeSha256(input.sha256, `${label} digest`),
  };
}

/**
 * Hash the actual bytes for the pinned canonical map and every declared source
 * pointer. Expected byte counts/digests are never refreshed from disk.
 */
export function hashQualificationInputs({ root, canonicalMap, pointers }) {
  const mapDescriptor = qualificationInputDescriptor(canonicalMap, 'canonical map');
  const pointerDescriptors = (pointers ?? []).map((pointer, index) =>
    qualificationInputDescriptor(pointer, `source pointer ${index}`),
  );
  if (pointerDescriptors.length === 0) throw new Error('at least one source pointer is required');
  const names = new Set();
  const paths = new Set([mapDescriptor.path]);
  const verify = (descriptor, label) => {
    if (descriptor.name) {
      if (names.has(descriptor.name))
        throw new Error(`duplicate source pointer ${descriptor.name}`);
      names.add(descriptor.name);
    }
    if (paths.has(descriptor.path))
      throw new Error(`duplicate qualification input path ${descriptor.path}`);
    paths.add(descriptor.path);
    const target = qualificationFile(root, descriptor.path, label);
    const bytes = readFileSync(target);
    const actualDigest = sha256Bytes(bytes);
    if (bytes.length !== descriptor.bytes) {
      throw new Error(`${label} byte count mismatch`);
    }
    if (actualDigest !== descriptor.sha256) {
      throw new Error(`${label} SHA-256 digest mismatch`);
    }
    return descriptor;
  };
  const verifiedMap = (() => {
    const target = qualificationFile(root, mapDescriptor.path, 'canonical map');
    const bytes = readFileSync(target);
    if (bytes.length !== mapDescriptor.bytes) throw new Error('canonical map byte count mismatch');
    if (sha256Bytes(bytes) !== mapDescriptor.sha256) {
      throw new Error('canonical map SHA-256 digest mismatch');
    }
    paths.delete(mapDescriptor.path);
    return mapDescriptor;
  })();
  const verifiedPointers = pointerDescriptors.map((descriptor, index) =>
    verify(descriptor, `source pointer ${index}`),
  );
  const digestSet = {
    canonicalMap: verifiedMap,
    pointers: [...verifiedPointers].sort((left, right) =>
      `${left.name ?? ''}:${left.path}`.localeCompare(`${right.name ?? ''}:${right.path}`),
    ),
  };
  return {
    canonicalMap: verifiedMap,
    pointers: verifiedPointers,
    digestSetHash: digest(digestSet),
  };
}

function dedupeExternalPointerRows(rows) {
  const seen = new Set();
  return rows.filter((row) => {
    const key = canonicalJson({
      fp: row?.fp ?? null,
      message_id: row?.message_id ?? null,
      thread_id: row?.thread_id ?? null,
    });
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeOpaqueReference(value) {
  return typeof value === 'string' ? value.trim().replace(/^<|>$/g, '').toLowerCase() : '';
}

/**
 * Join the map to independently pinned pointer metadata. The return value is
 * receipt-safe: only array position and one-way digests leave this function.
 * A thread split is verified only when the fingerprint, message, and thread
 * all agree with an independent union/catch-up pointer.
 */
export function joinPrivateQualificationPointers({
  mapRecords,
  reviewRecords = [],
  extraRecords = [],
  unionRecords = [],
  catchupRecords = [],
}) {
  if (!Array.isArray(mapRecords)) throw new Error('qualification map records are required');
  const reviewById = new Map();
  const extraById = new Map();
  for (const record of reviewRecords) {
    if (record?.review_id) reviewById.set(record.review_id, record);
  }
  for (const record of extraRecords) {
    if (record?.review_id) extraById.set(record.review_id, record);
  }
  const externalByFingerprint = new Map();
  for (const record of [...unionRecords, ...catchupRecords]) {
    if (!record?.fp) continue;
    const rows = externalByFingerprint.get(record.fp) ?? [];
    rows.push(record);
    externalByFingerprint.set(record.fp, rows);
  }

  return mapRecords.map((record, index) => {
    const review = reviewById.get(record?.id);
    const extra = extraById.get(record?.id);
    if (review && extra) throw new Error(`ambiguous source pointer for map row ${index}`);
    const pointer = review ?? extra;
    const pointerKind = review ? 'review' : extra ? 'extra' : 'missing';
    const externalRows = dedupeExternalPointerRows(
      pointer?.fp ? (externalByFingerprint.get(pointer.fp) ?? []) : [],
    );
    const external = externalRows.length === 1 ? externalRows[0] : undefined;
    const fingerprintJoin = external
      ? 'verified'
      : externalRows.length > 1
        ? 'ambiguous'
        : 'missing';
    const sourceMessageBinding =
      external && pointer?.source_message_id && external.message_id === pointer.source_message_id
        ? 'verified'
        : 'not-proven';
    const sourceThreadBinding =
      external && pointer?.source_thread_id && external.thread_id === pointer.source_thread_id
        ? 'verified'
        : 'not-proven';
    const referenceBinding =
      external &&
      normalizeOpaqueReference(pointer?.rfc_message_id) &&
      normalizeOpaqueReference(pointer.rfc_message_id) ===
        normalizeOpaqueReference(external.message_id)
        ? 'verified'
        : 'not-proven';
    const conversationBasis =
      sourceThreadBinding === 'verified' && sourceMessageBinding === 'verified'
        ? 'verified-thread'
        : 'unresolved';
    const sourceEvidence =
      fingerprintJoin === 'verified'
        ? sourceMessageBinding === 'verified' && sourceThreadBinding === 'verified'
          ? 'verified-pointer-message-thread'
          : sourceMessageBinding === 'verified'
            ? 'verified-pointer-message-only'
            : 'verified-pointer-fingerprint-only'
        : pointer
          ? 'pointer-only'
          : 'missing';
    return {
      index,
      idHash: record?.id ? hashOpaqueIdentifier(record.id) : null,
      pointerKind,
      fingerprintJoin,
      sourceMessageBinding,
      sourceThreadBinding,
      referenceBinding,
      conversationBasis,
      sourceEvidence,
      sourceMessageDigest: pointer?.source_message_id
        ? hashOpaqueIdentifier(pointer.source_message_id)
        : null,
      sourceThreadDigest: pointer?.source_thread_id
        ? hashOpaqueIdentifier(pointer.source_thread_id)
        : null,
      preReplyContextCount: Number.isInteger(
        record?.source_evidence?.strict_earlier_nonidentical_context_count,
      )
        ? record.source_evidence.strict_earlier_nonidentical_context_count
        : 0,
    };
  });
}

/** Derive hashed canonical partition sets without exposing private member IDs. */
export function derivePrivateQualificationPartitions(records) {
  if (!Array.isArray(records)) throw new Error('qualification records are required');
  const hashed = (rows) => rows.map((row) => hashOpaqueIdentifier(row.id)).sort();
  const canonical = records.filter((row) => row?.cohort === 'original_420');
  const external = canonical.filter((row) => row?.original_external_mixed_candidate === true);
  const strictOutbound = external.filter((row) => row?.physical_direction === 'outbound');
  const partition = (rows) => {
    const memberSet = hashed(rows);
    return { count: memberSet.length, memberSet, memberSetDigest: digest(memberSet) };
  };
  const summary = {
    partitions: {
      canonical420: partition(canonical),
      externalMixed253: partition(external),
      strictOutbound251: partition(strictOutbound),
      allRecords581: partition(records),
    },
  };
  assertPrivatePartitionSummary(summary);
  return summary;
}

export function assertPrivatePartitionSummary(summary) {
  const partitions = summary?.partitions;
  if (!partitions || typeof partitions !== 'object') {
    throw new Error('private partition summary is required');
  }
  for (const key of ['canonical420', 'externalMixed253', 'strictOutbound251', 'allRecords581']) {
    const value = partitions[key];
    if (
      !value ||
      !Number.isInteger(value.count) ||
      value.count < 0 ||
      !Array.isArray(value.memberSet) ||
      value.memberSet.length !== value.count ||
      new Set(value.memberSet).size !== value.memberSet.length ||
      !PRIVATE_SHA256.test(value.memberSetDigest) ||
      digest([...value.memberSet].sort()) !== value.memberSetDigest
    ) {
      throw new Error(`private partition ${key} is invalid`);
    }
  }
  const canonical = new Set(partitions.canonical420.memberSet);
  const external = new Set(partitions.externalMixed253.memberSet);
  if (!partitions.externalMixed253.memberSet.every((id) => canonical.has(id))) {
    throw new Error('external/mixed partition is not nested in canonical420');
  }
  if (!partitions.strictOutbound251.memberSet.every((id) => external.has(id))) {
    throw new Error('strict outbound partition is not nested in external/mixed');
  }
  return true;
}

function privateRunPath(root, runId) {
  if (
    typeof root !== 'string' ||
    typeof runId !== 'string' ||
    !/^u11-[a-z0-9][a-z0-9.-]*$/i.test(runId)
  ) {
    throw new Error('private qualification run ID is invalid');
  }
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, runId);
  if (target !== resolvedRoot && !target.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error('private qualification run escapes its root');
  }
  return { resolvedRoot, target, temporary: `${target}.tmp` };
}

function writeQualificationJson(target, value) {
  writeFileSync(target, `${canonicalJson(value)}\n`, { encoding: 'utf8', flag: 'wx' });
}

/** Atomically publish a versioned, immutable qualification run. */
export function publishPrivateQualificationSeal({ root, runId, manifest, aggregate, receipt }) {
  const paths = privateRunPath(root, runId);
  if (existsSync(paths.target))
    throw new Error(`private qualification run already exists: ${runId}`);
  if (existsSync(paths.temporary))
    throw new Error(`private qualification temporary run already exists: ${runId}`);
  if (!manifest || manifest.schemaVersion !== 'u11-private-qualification.v2') {
    throw new Error('private qualification v2 manifest is required for sealing');
  }
  assertPrivateQualificationV2Manifest(manifest);
  mkdirSync(paths.resolvedRoot, { recursive: true });
  mkdirSync(paths.temporary, { recursive: false });
  try {
    writeQualificationJson(path.join(paths.temporary, 'manifest.json'), manifest);
    writeQualificationJson(path.join(paths.temporary, 'aggregate.json'), aggregate ?? {});
    writeQualificationJson(path.join(paths.temporary, 'receipt.json'), receipt ?? {});
    const outputByteHashes = Object.fromEntries(
      ['manifest.json', 'aggregate.json', 'receipt.json'].map((name) => {
        const bytes = readFileSync(path.join(paths.temporary, name));
        return [name, { bytes: bytes.length, sha256: sha256Bytes(bytes) }];
      }),
    );
    const seal = {
      schemaVersion: 'u11-private-seal.v2',
      runId,
      sealedAt: new Date().toISOString(),
      complete: true,
      inputDigestSetHash:
        receipt?.inputDigestSetHash ?? manifest.source?.inputDigestSetHash ?? null,
      inputByteHashes: receipt?.inputByteHashes ?? manifest.source?.pointerDigests ?? null,
      outputByteHashes,
    };
    writeQualificationJson(path.join(paths.temporary, 'seal.json'), seal);
    renameSync(paths.temporary, paths.target);
    return { runId, path: paths.target, seal };
  } catch (error) {
    if (existsSync(paths.temporary)) rmSync(paths.temporary, { recursive: true, force: true });
    throw error;
  }
}

/** Verify a frozen qualification run without writing or changing it. */
export function verifyPrivateQualificationSeal({
  root,
  runId,
  expectedInputDigestSetHash,
  inputs,
}) {
  const paths = privateRunPath(root, runId);
  if (!existsSync(paths.target)) throw new Error(`private qualification run is missing: ${runId}`);
  const sealPath = path.join(paths.target, 'seal.json');
  let seal;
  try {
    seal = JSON.parse(readFileSync(sealPath, 'utf8'));
  } catch {
    throw new Error('private qualification seal is missing or invalid');
  }
  if (
    seal?.schemaVersion !== 'u11-private-seal.v2' ||
    seal.runId !== runId ||
    seal.complete !== true ||
    typeof seal.sealedAt !== 'string'
  ) {
    throw new Error('private qualification seal is incomplete or invalid');
  }
  const outputByteHashes = {};
  for (const name of ['manifest.json', 'aggregate.json', 'receipt.json']) {
    const target = qualificationFile(paths.target, name, `sealed ${name}`);
    const bytes = readFileSync(target);
    const expected = seal.outputByteHashes?.[name];
    if (!expected || expected.bytes !== bytes.length || expected.sha256 !== sha256Bytes(bytes)) {
      throw new Error(`sealed ${name} hash/integrity mismatch`);
    }
    outputByteHashes[name] = { bytes: bytes.length, sha256: sha256Bytes(bytes) };
  }
  if (
    expectedInputDigestSetHash !== undefined &&
    seal.inputDigestSetHash !== expectedInputDigestSetHash
  ) {
    throw new Error('sealed input digest-set mismatch');
  }
  if (inputs) {
    const recomputed = hashQualificationInputs(inputs);
    if (recomputed.digestSetHash !== seal.inputDigestSetHash) {
      throw new Error('current qualification inputs no longer match the sealed digest-set');
    }
  }
  return {
    runId,
    complete: true,
    sealedAt: seal.sealedAt,
    inputDigestSetHash: seal.inputDigestSetHash,
    outputByteHashes,
  };
}

function forbiddenToolInputKey(key) {
  return /gold|targetreply|humanoutbound|humanreply|staffreply/i.test(key);
}

function assertNoForbiddenToolInput(value, pathName = 'toolInput') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoForbiddenToolInput(item, `${pathName}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value)) {
    if (forbiddenToolInputKey(key)) {
      throw new Error(`target leakage in ${pathName}.${key}`);
    }
    assertNoForbiddenToolInput(nested, `${pathName}.${key}`);
  }
}

export function assertManifestContract(manifest) {
  if (!manifest || manifest.fixtureKind !== 'synthetic' || manifest.publicFixture !== true) {
    throw new Error('synthetic public fixture contract required');
  }
  if (manifest.schemaVersion !== 'reservation-tools-pilot.v1') {
    throw new Error('unsupported reservation-tools fixture schema');
  }
  if (
    JSON.stringify(manifest.counts) !==
      JSON.stringify({
        selectedRecords: 420,
        externalOrMixedCandidates: 253,
        strictExternalOutboundCandidates: 251,
        eligibleGoldCases: 0,
      }) ||
    manifest.privacy.rawCorpusIncluded !== false ||
    manifest.privacy.targetReplyInToolInput !== false ||
    manifest.privacy.targetReplyInFixture !== false ||
    manifest.privacy.privatePaths.length !== 0
  ) {
    throw new Error('synthetic count or privacy boundary drift');
  }

  const computed = computeManifestDigests(manifest);
  if (
    manifest.source.contentHash !== computed.contentHash ||
    manifest.source.mappingHash !== computed.mappingHash ||
    manifest.phase2B.mappingHash !== computed.mappingHash ||
    manifest.phase2B.selectionHash !== computed.selectionHash
  ) {
    throw new Error('manifest canonical digest mismatch');
  }

  if (
    manifest.phase2B.membershipFrozenBeforeResults !== true ||
    manifest.phase2B.caseIdentifiersFrozenBeforeResults !== true ||
    manifest.phase2B.evaluationModeFrozenBeforeResults !== true ||
    manifest.phase2B.selectionReasonsFrozenBeforeResults !== true ||
    manifest.phase2B.conversationSplitFrozen !== true ||
    manifest.phase2B.splitUnit !== 'conversation' ||
    manifest.phase2B.goldTargetExposure !== 'evaluator-only' ||
    manifest.phase2B.modeSpecificAggregation !== true
  ) {
    throw new Error('Phase 2/B freeze contract is not active');
  }
  if (
    canonicalJson(manifest.phase2B.allowedOutcomes) !== canonicalJson([...ALLOWED_OUTCOMES]) ||
    canonicalJson(manifest.phase2B.blockedPassOutcomes) !== canonicalJson([...BLOCKED_OUTCOMES]) ||
    manifest.phase2B.blockedPassOutcomes.includes('match')
  ) {
    throw new Error('Phase 2/B outcome aggregation contract is not active');
  }

  const ids = new Set();
  const splitByConversation = new Map();
  for (const pilotCase of manifest.cases) {
    if (!pilotCase.id || ids.has(pilotCase.id))
      throw new Error('duplicate or missing case identifier');
    ids.add(pilotCase.id);
    if (!ALLOWED_MODES.has(pilotCase.evaluationMode)) throw new Error('unknown evaluation mode');
    if (!['development', 'holdout'].includes(pilotCase.split))
      throw new Error('unknown case split');
    if (!['runnable', 'not-runnable', 'unscorable'].includes(pilotCase.selectionStatus)) {
      throw new Error('unknown case selection status');
    }
    if (pilotCase.selectionStatus !== 'runnable' && !pilotCase.skipReason) {
      throw new Error(`missing skip reason for ${pilotCase.id}`);
    }
    if (Object.hasOwn(pilotCase.retirement ?? {}, 'originalOutcome')) {
      throw new Error(`retirement outcome must remain evaluator-only for ${pilotCase.id}`);
    }
    assertNoForbiddenToolInput(pilotCase.toolInput, `${pilotCase.id}.toolInput`);
    for (const outcome of Object.values(pilotCase.fieldOutcomes ?? {})) {
      if (!ALLOWED_OUTCOMES.has(outcome))
        throw new Error(`unknown field outcome for ${pilotCase.id}`);
    }
    const previousSplit = splitByConversation.get(pilotCase.conversationId);
    if (previousSplit && previousSplit !== pilotCase.split) {
      throw new Error(`conversation split drift for ${pilotCase.conversationId}`);
    }
    splitByConversation.set(pilotCase.conversationId, pilotCase.split);
    if (pilotCase.split === 'holdout') {
      if (
        pilotCase.exposure?.sealedBeforeOutcome !== true ||
        pilotCase.exposure.outcomeMayInformTuning !== false ||
        pilotCase.exposure.outcomeMayInformRepair !== false ||
        pilotCase.exposure.outcomeMayChooseFixtures !== false ||
        pilotCase.exposure.outcomeMayTriggerRetry !== false ||
        pilotCase.exposure.state !== 'sealed'
      ) {
        throw new Error(`held-out isolation drift for ${pilotCase.id}`);
      }
    }
    if (pilotCase.exposure?.state === 'unsealed-retired') {
      if (
        pilotCase.split !== 'development' ||
        pilotCase.exposure.originalScorePreserved !== true ||
        pilotCase.exposure.originalExposurePreserved !== true
      ) {
        throw new Error(`unsealed case was not retired safely for ${pilotCase.id}`);
      }
    }
  }
  if (manifest.laterInboundFirstHoldout.targetEpisodes !== 200) {
    throw new Error('later holdout target drift');
  }
  if (
    manifest.laterInboundFirstHoldout.independentOfReplyExistence !== true ||
    manifest.laterInboundFirstHoldout.excludesTargetAndFutureContext !== true ||
    manifest.laterInboundFirstHoldout.includesNoReplyEpisode !== true
  ) {
    throw new Error('inbound-first holdout isolation drift');
  }
  if (
    JSON.stringify(manifest.browserSafety.allowedOrigins) !==
      JSON.stringify(['http://127.0.0.1:4179']) ||
    manifest.browserSafety.externalSocketsAllowed !== false ||
    manifest.browserSafety.transport !== 'fake'
  ) {
    throw new Error('browser fixture safety contract drift');
  }
  return true;
}

const PRIVATE_SHA256 = /^sha256:[a-f0-9]{64}$/;
const PRIVATE_QUALIFICATION_STATES = new Set([
  'missing',
  'not-proven',
  'candidate-only',
  'source-message-only',
  'partial',
  'verified',
]);
const PRIVATE_TOOL_INPUT_KEYS = new Set([
  'requestContextDigest',
  'sourceMessageDigest',
  'sourceThreadDigest',
  'preReplyContextDigest',
  'preReplyContextCount',
  'evaluationMode',
]);

function assertPrivateToolInput(value, pathName = 'toolInput') {
  assertNoForbiddenToolInput(value, pathName);
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertPrivateToolInput(item, `${pathName}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value)) {
    if (!PRIVATE_TOOL_INPUT_KEYS.has(key))
      throw new Error(`private tool input contains unapproved field ${pathName}.${key}`);
    if (typeof nested === 'string') {
      if (
        !PRIVATE_SHA256.test(nested) &&
        !ALLOWED_MODES.has(nested) &&
        !['development', 'holdout'].includes(nested)
      ) {
        throw new Error(`private tool input contains unbounded string ${pathName}.${key}`);
      }
    }
    assertPrivateToolInput(nested, `${pathName}.${key}`);
  }
}

/**
 * Validate the private, pre-outcome qualification contract. This is separate
 * from the public synthetic fixture contract: private source membership may
 * be frozen with zero runnable cases while identity, horizon, permission or
 * runtime capability remains explicitly unproven.
 */
export function assertPrivateEvaluationManifest(manifest) {
  if (!manifest || manifest.fixtureKind !== 'private' || manifest.publicFixture !== false) {
    throw new Error('private qualification contract required');
  }
  if (manifest.schemaVersion !== 'u11-private-qualification.v1') {
    throw new Error('unsupported private qualification schema');
  }
  if (!manifest.source || typeof manifest.source.name !== 'string') {
    throw new Error('private qualification source metadata is required');
  }
  if (!manifest.counts || !Array.isArray(manifest.cases)) {
    throw new Error('private qualification counts and cases are required');
  }
  const countKeys = [
    'mapRecords',
    'original420',
    'originalExternalMixedCandidates',
    'originalOutboundExternalMixedCandidates',
    'runnable',
    'notRunnable',
    'unscorable',
  ];
  for (const key of countKeys) {
    if (!Number.isInteger(manifest.counts[key]) || manifest.counts[key] < 0) {
      throw new Error(`private qualification count ${key} is invalid`);
    }
  }
  if (
    manifest.counts.mapRecords !== manifest.cases.length ||
    manifest.counts.runnable + manifest.counts.notRunnable + manifest.counts.unscorable !==
      manifest.counts.mapRecords
  ) {
    throw new Error('private qualification counts do not reconcile with membership');
  }
  if (
    !manifest.privacy ||
    manifest.privacy.rawCorpusIncluded !== false ||
    manifest.privacy.targetReplyInToolInput !== false ||
    manifest.privacy.targetReplyInFixture !== false ||
    !Array.isArray(manifest.privacy.privatePaths)
  ) {
    throw new Error('private qualification privacy boundary drift');
  }

  const computed = computeManifestDigests(manifest);
  if (
    manifest.source.contentHash !== computed.contentHash ||
    manifest.source.mappingHash !== computed.mappingHash ||
    manifest.phase2B?.mappingHash !== computed.mappingHash ||
    manifest.phase2B?.selectionHash !== computed.selectionHash
  ) {
    throw new Error('private qualification canonical digest mismatch');
  }
  const phase2B = manifest.phase2B;
  if (
    !phase2B ||
    phase2B.membershipFrozenBeforeResults !== true ||
    phase2B.caseIdentifiersFrozenBeforeResults !== true ||
    phase2B.evaluationModeFrozenBeforeResults !== true ||
    phase2B.selectionReasonsFrozenBeforeResults !== true ||
    phase2B.conversationSplitFrozen !== true ||
    phase2B.splitUnit !== 'conversation' ||
    phase2B.goldTargetExposure !== 'evaluator-only' ||
    phase2B.modeSpecificAggregation !== true ||
    canonicalJson(phase2B.allowedOutcomes) !== canonicalJson([...ALLOWED_OUTCOMES]) ||
    canonicalJson(phase2B.blockedPassOutcomes) !== canonicalJson([...BLOCKED_OUTCOMES]) ||
    phase2B.blockedPassOutcomes.includes('match')
  ) {
    throw new Error('private Phase 2/B freeze contract is not active');
  }
  const holdout = manifest.laterInboundFirstHoldout;
  if (
    !holdout ||
    !Number.isInteger(holdout.targetEpisodes) ||
    holdout.targetEpisodes < 0 ||
    holdout.independentOfReplyExistence !== true ||
    holdout.excludesTargetAndFutureContext !== true ||
    holdout.includesNoReplyEpisode !== true
  ) {
    throw new Error('private inbound-first holdout isolation drift');
  }

  const ids = new Set();
  const splitByConversation = new Map();
  for (const pilotCase of manifest.cases) {
    if (
      typeof pilotCase.id !== 'string' ||
      !PRIVATE_SHA256.test(pilotCase.id) ||
      ids.has(pilotCase.id) ||
      typeof pilotCase.conversationId !== 'string' ||
      !PRIVATE_SHA256.test(pilotCase.conversationId)
    ) {
      throw new Error('private case identifiers must be unique hashed values');
    }
    ids.add(pilotCase.id);
    if (!ALLOWED_MODES.has(pilotCase.evaluationMode))
      throw new Error('unknown private evaluation mode');
    if (!['development', 'holdout'].includes(pilotCase.split)) {
      throw new Error('unknown private case split');
    }
    if (!['runnable', 'not-runnable', 'unscorable'].includes(pilotCase.selectionStatus)) {
      throw new Error('unknown private case selection status');
    }
    if (pilotCase.selectionStatus !== 'runnable' && !pilotCase.skipReason) {
      throw new Error(`missing private skip reason for ${pilotCase.id}`);
    }
    if (Object.hasOwn(pilotCase.retirement ?? {}, 'originalOutcome')) {
      throw new Error(`private retirement outcome must remain evaluator-only for ${pilotCase.id}`);
    }
    assertPrivateToolInput(pilotCase.toolInput, `${pilotCase.id}.toolInput`);
    const qualification = pilotCase.sourceQualification;
    if (!qualification || typeof qualification !== 'object') {
      throw new Error(`private source qualification is missing for ${pilotCase.id}`);
    }
    for (const key of [
      'sameRequestIdentity',
      'legitimateInboundBeforeTarget',
      'sourceBinding',
      'permission',
    ]) {
      if (!PRIVATE_QUALIFICATION_STATES.has(qualification[key])) {
        throw new Error(`private source qualification ${key} is invalid for ${pilotCase.id}`);
      }
    }
    for (const outcome of Object.values(pilotCase.fieldOutcomes ?? {})) {
      if (!ALLOWED_OUTCOMES.has(outcome)) {
        throw new Error(`unknown private field outcome for ${pilotCase.id}`);
      }
    }
    if (
      pilotCase.selectionStatus === 'runnable' &&
      [
        qualification.sameRequestIdentity,
        qualification.legitimateInboundBeforeTarget,
        qualification.sourceBinding,
        qualification.permission,
      ].some((state) => state !== 'verified')
    ) {
      throw new Error(`runnable private case has unverified qualification for ${pilotCase.id}`);
    }
    const exposure = pilotCase.exposure;
    if (
      !exposure ||
      exposure.target !== 'evaluator-only' ||
      exposure.sealedBeforeOutcome !== true ||
      exposure.outcomeMayInformTuning !== false ||
      exposure.outcomeMayInformRepair !== false ||
      exposure.outcomeMayChooseFixtures !== false ||
      exposure.outcomeMayTriggerRetry !== false
    ) {
      throw new Error(`private target exposure drift for ${pilotCase.id}`);
    }
    if (pilotCase.split === 'holdout' && exposure.state !== 'sealed') {
      throw new Error(`private held-out case is not sealed for ${pilotCase.id}`);
    }
    if (pilotCase.split === 'development' && exposure.state !== 'development') {
      throw new Error(`private development exposure state drift for ${pilotCase.id}`);
    }
    const previousSplit = splitByConversation.get(pilotCase.conversationId);
    if (previousSplit && previousSplit !== pilotCase.split) {
      throw new Error(`private conversation split drift for ${pilotCase.conversationId}`);
    }
    splitByConversation.set(pilotCase.conversationId, pilotCase.split);
  }
  return true;
}

/**
 * Validate the second, independent private qualification contract. It keeps
 * the v1 assertion above intact for historical receipts while requiring v2 to
 * bind source bytes, independent pointer joins, partition membership, and an
 * explicit unresolved/unassigned state.
 */
export function assertPrivateQualificationV2Manifest(manifest) {
  if (!manifest || manifest.fixtureKind !== 'private' || manifest.publicFixture !== false) {
    throw new Error('private qualification v2 contract required');
  }
  if (manifest.schemaVersion !== 'u11-private-qualification.v2') {
    throw new Error('unsupported private qualification v2 schema');
  }
  const source = manifest.source;
  if (
    !source ||
    typeof source.name !== 'string' ||
    typeof source.version !== 'string' ||
    !PRIVATE_SHA256.test(source.inputDigestSetHash) ||
    !source.canonicalMap ||
    typeof source.canonicalMap.path !== 'string' ||
    !Number.isSafeInteger(source.canonicalMap.bytes) ||
    !PRIVATE_SHA256.test(source.canonicalMap.sha256) ||
    !Array.isArray(source.pointerDigests) ||
    source.pointerDigests.length !== 14
  ) {
    throw new Error('private v2 source digest set is incomplete');
  }
  const pointerNames = new Set();
  const pointerPaths = new Set([source.canonicalMap.path]);
  for (const [index, pointer] of source.pointerDigests.entries()) {
    if (
      !pointer ||
      typeof pointer.name !== 'string' ||
      pointerNames.has(pointer.name) ||
      typeof pointer.path !== 'string' ||
      pointerPaths.has(pointer.path) ||
      !Number.isSafeInteger(pointer.bytes) ||
      pointer.bytes < 0 ||
      !PRIVATE_SHA256.test(pointer.sha256)
    ) {
      throw new Error(`private v2 source pointer ${index} is invalid`);
    }
    pointerNames.add(pointer.name);
    pointerPaths.add(pointer.path);
  }
  if (
    !manifest.counts ||
    !Array.isArray(manifest.cases) ||
    manifest.counts.mapRecords !== manifest.cases.length ||
    manifest.counts.runnable + manifest.counts.notRunnable + manifest.counts.unscorable !==
      manifest.counts.mapRecords
  ) {
    throw new Error('private v2 membership counts do not reconcile');
  }
  const privacy = manifest.privacy;
  if (
    !privacy ||
    privacy.rawCorpusIncluded !== false ||
    privacy.targetReplyInToolInput !== false ||
    privacy.targetReplyInFixture !== false ||
    !Array.isArray(privacy.privatePaths)
  ) {
    throw new Error('private v2 privacy boundary drift');
  }
  const phase2B = manifest.phase2B;
  if (
    !phase2B ||
    phase2B.membershipFrozenBeforeResults !== true ||
    phase2B.caseIdentifiersFrozenBeforeResults !== true ||
    phase2B.evaluationModeFrozenBeforeResults !== true ||
    phase2B.selectionReasonsFrozenBeforeResults !== true ||
    phase2B.conversationSplitFrozen !== true ||
    phase2B.splitUnit !== 'conversation' ||
    phase2B.goldTargetExposure !== 'evaluator-only' ||
    phase2B.modeSpecificAggregation !== true ||
    canonicalJson(phase2B.allowedOutcomes) !== canonicalJson([...ALLOWED_OUTCOMES]) ||
    canonicalJson(phase2B.blockedPassOutcomes) !== canonicalJson([...BLOCKED_OUTCOMES])
  ) {
    throw new Error('private v2 Phase 2/B freeze contract is not active');
  }
  const holdout = manifest.laterInboundFirstHoldout;
  if (
    !holdout ||
    !Number.isInteger(holdout.targetEpisodes) ||
    holdout.targetEpisodes < 200 ||
    holdout.independentOfReplyExistence !== true ||
    holdout.excludesTargetAndFutureContext !== true ||
    holdout.includesNoReplyEpisode !== true
  ) {
    throw new Error('private v2 inbound-first holdout floor/isolation drift');
  }
  const partitionSummary = manifest.partitionSummary;
  assertPrivatePartitionSummary(partitionSummary);
  const partitionCounts = {
    canonical420: partitionSummary.partitions.canonical420.count,
    externalMixed253: partitionSummary.partitions.externalMixed253.count,
    strictOutbound251: partitionSummary.partitions.strictOutbound251.count,
    allRecords581: partitionSummary.partitions.allRecords581.count,
  };
  if (
    manifest.counts.mapRecords !== partitionCounts.allRecords581 ||
    manifest.counts.original420 !== partitionCounts.canonical420 ||
    manifest.counts.originalExternalMixedCandidates !== partitionCounts.externalMixed253 ||
    manifest.counts.originalOutboundExternalMixedCandidates !== partitionCounts.strictOutbound251
  ) {
    throw new Error('private v2 partition counts do not match membership');
  }
  const expectedLabels = {
    canonical420: 'canonical-420',
    externalMixed253: 'external-mixed-253',
    strictOutbound251: 'strict-outbound-251',
    allRecords581: 'all-581',
  };
  const labelCounts = Object.fromEntries(Object.keys(expectedLabels).map((key) => [key, 0]));
  const ids = new Set();
  const splitByConversation = new Map();
  for (const pilotCase of manifest.cases) {
    if (
      typeof pilotCase.id !== 'string' ||
      !PRIVATE_SHA256.test(pilotCase.id) ||
      ids.has(pilotCase.id) ||
      typeof pilotCase.conversationId !== 'string' ||
      !PRIVATE_SHA256.test(pilotCase.conversationId)
    ) {
      throw new Error('private v2 case identifiers must be unique hashed values');
    }
    ids.add(pilotCase.id);
    if (!ALLOWED_MODES.has(pilotCase.evaluationMode))
      throw new Error('unknown private v2 evaluation mode');
    if (!['runnable', 'not-runnable', 'unscorable'].includes(pilotCase.selectionStatus)) {
      throw new Error('unknown private v2 selection status');
    }
    if (pilotCase.selectionStatus !== 'runnable' && !pilotCase.skipReason) {
      throw new Error(`missing private v2 skip reason for ${pilotCase.id}`);
    }
    assertPrivateToolInput(pilotCase.toolInput, `${pilotCase.id}.toolInput`);
    const qualification = pilotCase.sourceQualification;
    if (!qualification || typeof qualification !== 'object') {
      throw new Error(`private v2 source qualification is missing for ${pilotCase.id}`);
    }
    for (const key of [
      'sameRequestIdentity',
      'legitimateInboundBeforeTarget',
      'sourceBinding',
      'permission',
    ]) {
      if (!PRIVATE_QUALIFICATION_STATES.has(qualification[key])) {
        throw new Error(`private v2 source qualification ${key} is invalid for ${pilotCase.id}`);
      }
    }
    if (pilotCase.conversationBasis === 'verified-thread') {
      if (!['development', 'holdout'].includes(pilotCase.split)) {
        throw new Error(`verified private v2 case is not assigned a split ${pilotCase.id}`);
      }
      if (qualification.sourceBinding !== 'verified') {
        throw new Error(`verified private v2 thread has unverified source binding ${pilotCase.id}`);
      }
      if (pilotCase.exposure?.state !== 'development' && pilotCase.exposure?.state !== 'sealed') {
        throw new Error(`verified private v2 case exposure is invalid ${pilotCase.id}`);
      }
      const previousSplit = splitByConversation.get(pilotCase.conversationId);
      if (previousSplit && previousSplit !== pilotCase.split) {
        throw new Error(`private v2 conversation split drift for ${pilotCase.conversationId}`);
      }
      splitByConversation.set(pilotCase.conversationId, pilotCase.split);
    } else if (pilotCase.conversationBasis === 'unresolved') {
      if (pilotCase.split !== null || pilotCase.exposure?.state !== 'unassigned') {
        throw new Error(`unresolved private v2 case must remain unassigned ${pilotCase.id}`);
      }
    } else {
      throw new Error(`private v2 conversation basis is invalid for ${pilotCase.id}`);
    }
    if (pilotCase.selectionStatus === 'runnable') {
      if (
        pilotCase.conversationBasis !== 'verified-thread' ||
        [
          qualification.sameRequestIdentity,
          qualification.legitimateInboundBeforeTarget,
          qualification.sourceBinding,
          qualification.permission,
        ].some((state) => state !== 'verified')
      ) {
        throw new Error(`runnable private v2 case has unverified qualification ${pilotCase.id}`);
      }
    }
    if (
      !Array.isArray(pilotCase.partitionLabels) ||
      !pilotCase.partitionLabels.includes(expectedLabels.allRecords581)
    ) {
      throw new Error(`private v2 case partition labels are incomplete ${pilotCase.id}`);
    }
    for (const [key, label] of Object.entries(expectedLabels)) {
      if (pilotCase.partitionLabels.includes(label)) labelCounts[key] += 1;
    }
    const exposure = pilotCase.exposure;
    if (
      !exposure ||
      exposure.target !== 'evaluator-only' ||
      exposure.sealedBeforeOutcome !== true ||
      exposure.outcomeMayInformTuning !== false ||
      exposure.outcomeMayInformRepair !== false ||
      exposure.outcomeMayChooseFixtures !== false ||
      exposure.outcomeMayTriggerRetry !== false
    ) {
      throw new Error(`private v2 target exposure drift for ${pilotCase.id}`);
    }
    for (const outcome of Object.values(pilotCase.fieldOutcomes ?? {})) {
      if (!ALLOWED_OUTCOMES.has(outcome))
        throw new Error(`unknown private v2 field outcome for ${pilotCase.id}`);
    }
  }
  if (
    labelCounts.canonical420 !== partitionCounts.canonical420 ||
    labelCounts.externalMixed253 !== partitionCounts.externalMixed253 ||
    labelCounts.strictOutbound251 !== partitionCounts.strictOutbound251 ||
    labelCounts.allRecords581 !== partitionCounts.allRecords581
  ) {
    throw new Error('private v2 partition label counts drifted');
  }
  const computed = computeManifestDigests(manifest);
  if (
    manifest.source.contentHash !== computed.contentHash ||
    manifest.source.mappingHash !== computed.mappingHash ||
    phase2B.mappingHash !== computed.mappingHash ||
    phase2B.selectionHash !== computed.selectionHash
  ) {
    throw new Error('private v2 canonical digest mismatch');
  }
  return true;
}

function hasBlockedFieldOutcome(pilotCase) {
  return Object.values(pilotCase.fieldOutcomes ?? {}).some((outcome) =>
    BLOCKED_OUTCOMES.has(outcome),
  );
}

function isEligibleEvaluationCase(pilotCase) {
  return pilotCase.selectionStatus === 'runnable' && !hasBlockedFieldOutcome(pilotCase);
}

export function createEvaluationSession(manifest, options = {}) {
  if (options.contract === 'private') assertPrivateEvaluationManifest(manifest);
  else assertManifestContract(manifest);
  let current = clone(manifest);
  const frozenMembership = new Map(
    current.cases.map((pilotCase) => [
      pilotCase.id,
      {
        conversationId: pilotCase.conversationId,
        evaluationMode: pilotCase.evaluationMode,
        split: pilotCase.split,
      },
    ]),
  );
  const findCase = (caseId) => {
    const found = current.cases.find((pilotCase) => pilotCase.id === caseId);
    if (!found) throw new Error(`unknown evaluation case ${caseId}`);
    return found;
  };
  const publicManifest = () => {
    const manifestView = clone(current);
    for (const pilotCase of manifestView.cases) {
      if (pilotCase.retirement) delete pilotCase.retirement.originalOutcome;
    }
    return manifestView;
  };
  return {
    get manifest() {
      return publicManifest();
    },
    canUse(caseId, action) {
      const pilotCase = findCase(caseId);
      if (!HOLDOUT_ACTIONS.has(action)) throw new Error(`unknown holdout action ${action}`);
      return (
        isEligibleEvaluationCase(pilotCase) &&
        pilotCase.split === 'development' &&
        pilotCase.exposure?.state !== 'unsealed-retired'
      );
    },
    aggregate(evaluationMode, split = 'development') {
      if (!ALLOWED_MODES.has(evaluationMode)) throw new Error('unknown evaluation mode');
      if (split !== 'development') {
        throw new Error('holdout outcomes cannot be aggregated into a release score');
      }
      const caseIds = current.cases
        .filter(
          (pilotCase) =>
            pilotCase.split === 'development' &&
            pilotCase.evaluationMode === evaluationMode &&
            isEligibleEvaluationCase(pilotCase) &&
            pilotCase.exposure?.state !== 'unsealed-retired',
        )
        .map((pilotCase) => pilotCase.id);
      return { evaluationMode, split, caseIds, eligibleCount: caseIds.length };
    },
    recordOutcome(caseId, evaluationMode, outcome) {
      const pilotCase = findCase(caseId);
      const frozen = frozenMembership.get(caseId);
      if (frozen.evaluationMode !== evaluationMode) throw new Error('evaluation mode mismatch');
      if (!isEligibleEvaluationCase(pilotCase)) {
        throw new Error('evaluation case is not eligible for implementation outcome use');
      }
      if (!ALLOWED_OUTCOMES.has(outcome)) throw new Error('unknown field outcome');
      if (BLOCKED_OUTCOMES.has(outcome)) {
        throw new Error('blocked outcome cannot be used as a passing implementation result');
      }
      if (pilotCase.split === 'holdout') {
        throw new Error('held-out outcome is sealed from implementation consumers');
      }
      if (pilotCase.exposure?.state === 'unsealed-retired') {
        throw new Error('unsealed-retired outcome is regression-only');
      }
      return { caseId, evaluationMode, outcome, split: pilotCase.split };
    },
    unsealHoldout(caseId, originalOutcome) {
      const pilotCase = findCase(caseId);
      if (pilotCase.split !== 'holdout' || pilotCase.exposure?.state !== 'sealed') {
        throw new Error('only a sealed held-out case can be unsealed');
      }
      if (!originalOutcome || typeof originalOutcome !== 'object') {
        throw new Error('original held-out outcome is required for retirement');
      }
      const retired = {
        ...pilotCase,
        split: 'development',
        exposure: {
          ...pilotCase.exposure,
          state: 'unsealed-retired',
          originalScorePreserved: true,
          originalExposurePreserved: true,
        },
        retirement: {
          state: 'development-regression',
          originalOutcome: clone(originalOutcome),
          originalExposure: clone(pilotCase.exposure),
        },
      };
      current = {
        ...current,
        cases: current.cases.map((candidate) => (candidate.id === caseId ? retired : candidate)),
      };
      return clone(retired);
    },
  };
}

export function assertRequiredFiles(root, relativePaths) {
  const missing = relativePaths.filter((relativePath) => {
    const target = path.resolve(root, relativePath);
    try {
      return !statSync(target).isFile();
    } catch {
      return true;
    }
  });
  if (missing.length) throw new Error(`required file/config missing: ${missing.join(', ')}`);
  return true;
}

const PLAN_PACKAGE_ROOTS = Object.freeze({
  server: 'apps/server-pilot',
  mail: 'apps/mail',
  fixtures: 'apps/server-pilot',
});

export function assertPlanFiles(root, mode, slice) {
  const plan = getSlicePlan(mode, slice);
  const required = [];
  for (const [packageName, files] of Object.entries(plan)) {
    if (!Array.isArray(files)) continue;
    const packageRoot = PLAN_PACKAGE_ROOTS[packageName];
    if (!packageRoot) throw new Error(`unknown package root in ${mode}:${slice}: ${packageName}`);
    required.push(...files.map((file) => path.join(packageRoot, file)));
  }
  return assertRequiredFiles(root, required);
}

export function getSlicePlan(mode, slice) {
  const plan = SLICE_PLANS[mode]?.[slice];
  if (!plan) throw new Error(`unknown slice ${slice} for mode ${mode}`);
  return clone(plan);
}

/**
 * Return the exact server-side test files for a named gate slice.
 * Dispatchers must consume this plan rather than silently accepting an empty
 * branch when a slice is known only to the library.
 */
export function getServerTestFiles(mode, slice) {
  const plan = getSlicePlan(mode, slice);
  const files = plan.server;
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error(`named ${mode} slice ${slice} has no server test files`);
  }
  return [...files];
}

/**
 * Validate the JSON reporter contract used by required unit/DB slices.
 * A zero-test, failed, or skipped report is never a passing gate receipt.
 */
export function validateVitestReport(report) {
  if (!report || typeof report !== 'object') {
    throw new Error('Vitest report is missing or invalid');
  }
  const total = Number(report.numTotalTests ?? 0);
  const passed = Number(report.numPassedTests ?? 0);
  const failed = Number(report.numFailedTests ?? 0);
  const skipped =
    Number(report.numPendingTests ?? 0) +
    Number(report.numTodoTests ?? 0) +
    Number(report.numSkippedTests ?? 0);
  const countSkipped = (assertions) =>
    (assertions ?? []).filter((assertion) =>
      ['pending', 'skipped', 'todo'].includes(assertion.status),
    ).length;
  const assertionSkipped = (report.testResults ?? []).reduce(
    (sum, suite) => sum + countSkipped(suite.assertionResults),
    0,
  );
  const effectiveSkipped = skipped + assertionSkipped;

  if (total < 1) throw new Error('required test slice selected zero tests');
  if (failed > 0 || effectiveSkipped > 0 || passed !== total) {
    throw new Error(
      `required test slice is not fully green (total=${total}, passed=${passed}, failed=${failed}, skipped=${effectiveSkipped})`,
    );
  }
  return { total, passed, failed, skipped: effectiveSkipped };
}

function assertLoopbackOrigin(origin) {
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    throw new Error('fixture origin must be a valid URL');
  }
  if (
    parsed.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error('fixture origin must be an HTTP loopback origin');
  }
  return parsed.origin;
}

function assertDisposableUrlForProfile(raw, profile) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('verified disposable database URL is invalid');
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error('verified disposable database URL must use postgres protocol');
  }
  if (parsed.hostname !== '127.0.0.1' || parsed.port !== profile.port) {
    throw new Error('verified disposable database URL does not match the owned loopback profile');
  }
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, '')).toLowerCase();
  if (!database || /^(postgres|template0|template1)$/i.test(database)) {
    throw new Error('verified disposable database URL names a generic database');
  }
  if (/(pilot|prod|production|live|rds|amazonaws|aurora|neon|supabase)/i.test(raw)) {
    throw new Error('production-looking disposable database URL refused');
  }
  return true;
}

export function buildChildEnvironment(parent, { kind, guardPath }) {
  const output = {};
  for (const key of [
    'PATH',
    'HOME',
    'TMPDIR',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'TERM',
    'FORCE_COLOR',
    'NO_COLOR',
    'PNPM_HOME',
    'XDG_CACHE_HOME',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
  ]) {
    if (typeof parent[key] === 'string') output[key] = parent[key];
  }
  output.PATH ||= '/usr/local/bin:/usr/bin:/bin';
  output.HOME ||= '/tmp';
  output.NODE_ENV = kind === 'build' ? 'production' : 'test';
  output.CI = '1';
  output.MAIL_TRANSPORT_MODE = 'fixture';
  output.HMS_TRANSPORT_MODE = 'fixture';
  output.PMS_TRANSPORT_MODE = 'fixture';
  output.AWS_EC2_METADATA_DISABLED = 'true';
  output.NO_PROXY = '*';
  output.HTTP_PROXY = '';
  output.HTTPS_PROXY = '';
  output.ALL_PROXY = '';
  output.DOTENV_CONFIG_PATH = '/dev/null';
  output.NAVA_FIXTURE_NETWORK = 'loopback-only';
  output.NAVA_EXTERNAL_SOCKETS = 'deny';
  if (!guardPath) throw new Error('fixture network guard is required');
  output.NODE_OPTIONS = `--import=${path.resolve(guardPath)}`;
  if (typeof parent.NAVA_FIXTURE_ORIGIN === 'string') {
    output.NAVA_FIXTURE_ORIGIN = assertLoopbackOrigin(parent.NAVA_FIXTURE_ORIGIN);
    output.VITE_PUBLIC_BACKEND_URL = output.NAVA_FIXTURE_ORIGIN;
    output.VITE_FRONTEND_ONLY = '0';
    output.VITE_ZERO_DEMO_MODE = '0';
    output.ZERO_DEMO_MODE = '0';
    output.PLAYWRIGHT_BROWSERS_PATH =
      '/home/ubuntu/projects/zero/.worktrees/centurion-dashboard-tools/.private/centurion-dashboard-tools-execution/playwright-browsers';
  }
  if (kind === 'db') {
    if (!parent.NAVA_TEST_DATABASE_URL) throw new Error('verified NAVA_TEST_DATABASE_URL required');
    const profile = getDbProfile(parent.NAVA_TEST_DATABASE_PROFILE || 'pg17');
    assertDisposableUrlForProfile(parent.NAVA_TEST_DATABASE_URL, profile);
    // The DB contract imports application modules that parse required server
    // settings before the test helper maps TEST_DATABASE_URL. These are
    // neutral disposable-test values, never inherited or production values.
    output.DATABASE_URL = parent.NAVA_TEST_DATABASE_URL;
    output.PORT = '8788';
    output.BETTER_AUTH_URL = 'http://127.0.0.1:8788';
    output.BETTER_AUTH_SECRET = 'reservation-pilot-disposable-test-secret';
    output.AWS_REGION = 'af-south-1';
    output.S3_BUCKET = 'reservation-pilot-disposable-test';
    output.NAVA_TEST_DATABASE_URL = parent.NAVA_TEST_DATABASE_URL;
    output.TEST_DATABASE_URL = parent.NAVA_TEST_DATABASE_URL;
    output.CONFIRM_DISPOSABLE_TEST_DB = '1';
    output.HMS_DB_TEST_REQUIRED = '1';
    output.NAVA_TEST_DATABASE_SCOPE = 'reservation-pilot-owned';
    output.NAVA_TEST_DATABASE_PROFILE = parent.NAVA_TEST_DATABASE_PROFILE || 'pg17';
  }
  return output;
}

function unwrapExpression(expression) {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

const DOCUMENT_SERVICE_FIXTURE_PLUGIN = 'documentServiceFixturePlugin';

function namedZeroArgCall(expression, name) {
  const current = unwrapExpression(expression);
  return (
    ts.isCallExpression(current) &&
    ts.isIdentifier(current.expression) &&
    current.expression.text === name &&
    current.arguments.length === 0
  );
}

function importedLocallyAs(sourceFile, name) {
  return sourceFile.statements.some((statement) => {
    if (!ts.isImportDeclaration(statement)) return false;
    const clause = statement.importClause;
    if (!clause) return false;
    if (clause.name?.text === name) return true;
    if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
      return clause.namedBindings.name.text === name;
    }
    return Boolean(
      clause.namedBindings?.elements.some(
        (element) => (element.name?.text ?? element.propertyName?.text) === name,
      ),
    );
  });
}

function assertExplicitFixturePluginShape(sourceFile, configExpression) {
  const config = unwrapExpression(configExpression);
  if (!ts.isObjectLiteralExpression(config)) return;
  const pluginProperties = config.properties.filter(
    (property) =>
      ts.isPropertyAssignment(property) &&
      ts.isIdentifier(property.name) &&
      property.name.text === 'plugins',
  );
  if (pluginProperties.length > 1) {
    throw new Error('fixture config may define only one top-level plugins property');
  }
  const pluginProperty = pluginProperties[0];
  if (!pluginProperty || !ts.isPropertyAssignment(pluginProperty)) return;
  const plugins = unwrapExpression(pluginProperty.initializer);
  if (!ts.isArrayLiteralExpression(plugins)) {
    if (namedZeroArgCall(plugins, DOCUMENT_SERVICE_FIXTURE_PLUGIN)) {
      throw new Error(
        'document fixture plugin must be the second element in the exact two-plugin shape',
      );
    }
    return;
  }
  const serviceCalls = plugins.elements.filter((element) => {
    const current = unwrapExpression(element);
    return (
      ts.isCallExpression(current) &&
      ts.isIdentifier(current.expression) &&
      current.expression.text === DOCUMENT_SERVICE_FIXTURE_PLUGIN
    );
  });
  if (!serviceCalls.length) return;

  const declarations = sourceFile.statements.filter(
    (statement) =>
      ts.isFunctionDeclaration(statement) &&
      statement.name?.text === DOCUMENT_SERVICE_FIXTURE_PLUGIN,
  );
  if (
    declarations.length !== 1 ||
    declarations[0].parameters.length !== 0 ||
    importedLocallyAs(sourceFile, DOCUMENT_SERVICE_FIXTURE_PLUGIN)
  ) {
    throw new Error('document fixture plugin must be one local zero-argument function declaration');
  }
  if (
    plugins.elements.length !== 2 ||
    !namedZeroArgCall(plugins.elements[0], 'tailwindcss') ||
    !namedZeroArgCall(plugins.elements[1], DOCUMENT_SERVICE_FIXTURE_PLUGIN)
  ) {
    throw new Error(
      'document fixture plugin must be the second element in the exact two-plugin shape',
    );
  }
}

function literalValue(expression, options = {}) {
  const current = unwrapExpression(expression);
  if (
    options.allowDocumentServicePluginSecondElement === true &&
    namedZeroArgCall(current, DOCUMENT_SERVICE_FIXTURE_PLUGIN)
  ) {
    return '__approved_local_document_service_fixture_plugin__';
  }
  // The fixture may use the installed production Tailwind Vite plugin so its
  // real theme compiles. Keep these two reviewed executable config exceptions;
  // all safety-contract fields remain literal and are still inspected below.
  if (
    ts.isCallExpression(current) &&
    ts.isIdentifier(current.expression) &&
    current.expression.text === 'tailwindcss' &&
    current.arguments.length === 0
  ) {
    return '__approved_local_tailwindcss_vite_plugin__';
  }
  if (ts.isStringLiteral(current) || ts.isNoSubstitutionTemplateLiteral(current)) {
    return current.text;
  }
  if (current.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (current.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isNumericLiteral(current)) return Number(current.text);
  if (ts.isArrayLiteralExpression(current)) {
    return current.elements.map((element, index) => {
      if (
        options.allowDocumentServicePluginSecondElement === true &&
        index === 1 &&
        namedZeroArgCall(element, DOCUMENT_SERVICE_FIXTURE_PLUGIN)
      ) {
        return '__approved_local_document_service_fixture_plugin__';
      }
      return literalValue(element);
    });
  }
  if (ts.isObjectLiteralExpression(current)) {
    const result = {};
    for (const property of current.properties) {
      if (!ts.isPropertyAssignment(property))
        throw new Error('fixture config must use literal properties');
      const name = property.name;
      const key = ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : undefined;
      if (!key) throw new Error('fixture config has a non-literal property name');
      result[key] = literalValue(property.initializer, {
        allowDocumentServicePluginSecondElement:
          options.allowDocumentServicePluginSecondElement === true && key === 'plugins',
      });
    }
    return result;
  }
  throw new Error('fixture config contains a non-literal value');
}

function findLiteralExport(sourceFile, name) {
  let found;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) {
      found = literalValue(node.initializer);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  if (!found) throw new Error(`fixture config must export literal ${name}`);
  return found;
}

function isDefineConfigCall(node) {
  const current = unwrapExpression(node);
  return (
    ts.isCallExpression(current) &&
    ts.isIdentifier(current.expression) &&
    current.expression.text === 'defineConfig' &&
    current.arguments.length === 1
  );
}

function findDefaultDefineConfigLiteral(sourceFile) {
  const calls = [];
  let defaultCall;
  function visit(node) {
    if (isDefineConfigCall(node)) {
      calls.push(unwrapExpression(node));
    }
    if (ts.isExportAssignment(node) && !node.isExportEquals) {
      const expression = unwrapExpression(node.expression);
      if (isDefineConfigCall(expression)) defaultCall = expression;
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  if (calls.length !== 1 || !defaultCall || calls[0] !== defaultCall) {
    throw new Error('fixture config must have exactly one default defineConfig export');
  }
  assertExplicitFixturePluginShape(sourceFile, defaultCall.arguments[0]);
  return literalValue(defaultCall.arguments[0], {
    allowDocumentServicePluginSecondElement: true,
  });
}

function assertNoUnsupportedBrowserConfig(value, pathName = 'config') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoUnsupportedBrowserConfig(item, `${pathName}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value)) {
    if (
      /proxy|endpoint|target|url|origin|websocket|socket|remote|external|pms|hms|mail|model|hmr/i.test(
        key,
      )
    ) {
      throw new Error(`fixture config contains unsupported live browser entry ${pathName}.${key}`);
    }
    if (
      typeof nested === 'string' &&
      /^https?:\/\//i.test(nested) &&
      !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?\/?$/i.test(nested)
    ) {
      throw new Error(`fixture config contains external endpoint ${pathName}.${key}`);
    }
    assertNoUnsupportedBrowserConfig(nested, `${pathName}.${key}`);
  }
}

export function validateFixtureConfigSource(source, expectedOrigins) {
  const sourceFile = ts.createSourceFile(
    'reservation-tools-pilot.fixture.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  function visitUnsafe(node) {
    if (ts.isImportDeclaration(node)) {
      const moduleName = node.moduleSpecifier.text;
      if (/dotenv|\.dev\.vars|production/i.test(moduleName)) {
        throw new Error('fixture config imports live environment bindings');
      }
    }
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'loadEnv'
    ) {
      throw new Error('fixture config cannot call loadEnv');
    }
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'require' &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0]) &&
      /dotenv|\.dev\.vars|production/i.test(node.arguments[0].text)
    ) {
      throw new Error('fixture config cannot require live environment bindings');
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'process' &&
      node.name.text === 'env'
    ) {
      throw new Error('fixture config cannot read process.env');
    }
    if (
      ts.isElementAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'process' &&
      ts.isStringLiteral(node.argumentExpression) &&
      node.argumentExpression.text === 'env'
    ) {
      throw new Error('fixture config cannot read process.env');
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === 'env' &&
      ts.isMetaProperty(node.expression)
    ) {
      throw new Error('fixture config cannot read import.meta.env');
    }
    ts.forEachChild(node, visitUnsafe);
  }
  visitUnsafe(sourceFile);
  const hasApprovedTailwindImport = sourceFile.statements.some(
    (statement) =>
      ts.isImportDeclaration(statement) &&
      statement.moduleSpecifier.text === '@tailwindcss/vite' &&
      statement.importClause?.name?.text === 'tailwindcss',
  );
  let usesTailwindPluginCall = false;
  function visitTailwindPlugin(node) {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'tailwindcss'
    ) {
      usesTailwindPluginCall = true;
    }
    ts.forEachChild(node, visitTailwindPlugin);
  }
  visitTailwindPlugin(sourceFile);
  if (usesTailwindPluginCall && !hasApprovedTailwindImport) {
    throw new Error(
      'fixture Tailwind plugin must come from the installed @tailwindcss/vite package',
    );
  }
  const contract = findLiteralExport(sourceFile, 'pilotFixtureContract');
  const config = findDefaultDefineConfigLiteral(sourceFile);
  assertNoUnsupportedBrowserConfig(config);
  if (
    contract.mode !== 'fixture' ||
    contract.envFiles !== false ||
    contract.liveBindings !== false ||
    contract.externalSockets !== false ||
    contract.networkPolicy !== 'loopback-only' ||
    contract.transport !== 'fake' ||
    JSON.stringify(contract.allowedOrigins) !== JSON.stringify(expectedOrigins) ||
    contract.publicOrigin !== expectedOrigins[0]
  ) {
    throw new Error('fixture config contract does not enforce fake loopback mode');
  }
  if (
    config.envDir !== '/dev/null' ||
    config.server?.host !== '127.0.0.1' ||
    config.server?.port !== 4179
  ) {
    throw new Error('fixture Vite config does not pin env files and server to loopback');
  }
  return contract;
}

export function assertFixtureConfigFile(configPath, expectedOrigins) {
  return validateFixtureConfigSource(readFileSync(configPath, 'utf8'), expectedOrigins);
}

export function validatePostgresPortBindings(bindings, expectedPort = '15432') {
  const keys = Object.keys(bindings ?? {});
  if (keys.length !== 1 || keys[0] !== '5432/tcp') {
    throw new Error('unexpected published database port binding');
  }
  const entries = bindings['5432/tcp'];
  if (!Array.isArray(entries) || entries.length !== 1) {
    throw new Error('database port must have exactly one binding');
  }
  if (entries[0]?.HostIp !== '127.0.0.1' || String(entries[0]?.HostPort) !== String(expectedPort)) {
    throw new Error(`database binding must be 127.0.0.1:${expectedPort}`);
  }
  return true;
}

function collectPlaywrightSpecs(suites, parentTitle = '') {
  const specs = [];
  for (const suite of suites ?? []) {
    const suiteTitle = [parentTitle, suite.title].filter(Boolean).join(' / ');
    for (const spec of suite.specs ?? []) {
      specs.push({ ...spec, fullTitle: [suiteTitle, spec.title].filter(Boolean).join(' / ') });
    }
    specs.push(...collectPlaywrightSpecs(suite.suites, suiteTitle));
  }
  return specs;
}

export function validatePlaywrightReport(report, expectedTitle, expectedCount = 1) {
  if (!Number.isInteger(expectedCount) || expectedCount < 1) {
    throw new Error(`required browser title has invalid expected test count: ${expectedCount}`);
  }
  const matching = collectPlaywrightSpecs(report.suites).filter((spec) =>
    spec.fullTitle.includes(expectedTitle),
  );
  if (!matching.length)
    throw new Error(`required browser title did not select tests: ${expectedTitle}`);
  let testCount = 0;
  let skipped = 0;
  let failed = 0;
  for (const spec of matching) {
    for (const test of spec.tests ?? []) {
      testCount += 1;
      const statuses = (test.results ?? []).map((result) => result.status);
      if (
        test.status === 'skipped' ||
        statuses.some((status) => ['skipped', 'pending', 'todo'].includes(status)) ||
        statuses.length === 0
      ) {
        skipped += 1;
      } else if (test.status && !['expected', 'passed'].includes(test.status)) {
        failed += 1;
      } else if (statuses.some((status) => status !== 'passed')) {
        failed += 1;
      }
    }
  }
  if (testCount < 1) throw new Error(`required browser title selected no tests: ${expectedTitle}`);
  if (testCount !== expectedCount) {
    throw new Error(
      `required browser title selected ${testCount} tests; expected ${expectedCount}: ${expectedTitle}`,
    );
  }
  if (skipped || failed)
    throw new Error(`required browser title has skipped/failed tests: ${expectedTitle}`);
  return { testCount, skipped, failed };
}

export function assertBrowserNetworkBoundary() {
  const probe = spawnSync(
    'unshare',
    [
      '--user',
      '--map-root-user',
      '--net',
      '--fork',
      '/bin/sh',
      '-ceu',
      `
        /usr/sbin/ip link set lo up
        interfaces=$(/usr/sbin/ip -o link show | /usr/bin/awk -F': ' '{print $2}' | /usr/bin/cut -d: -f1)
        for interface in $interfaces; do
          test "$interface" = lo
        done
        printf browser-network-namespace-ready
      `,
    ],
    {
      env: { PATH: '/usr/local/bin:/usr/bin:/usr/sbin:/bin:/sbin', HOME: '/tmp' },
      encoding: 'utf8',
      timeout: 3000,
    },
  );
  if (
    probe.error ||
    probe.status !== 0 ||
    !probe.stdout.includes('browser-network-namespace-ready')
  ) {
    throw new Error('actual browser egress isolation is unavailable');
  }
  return true;
}

function runChild(argv) {
  const kindArg = argv.find((arg) => arg.startsWith('--kind='));
  const cwdArg = argv.find((arg) => arg.startsWith('--cwd='));
  const separator = argv.indexOf('--');
  if (!kindArg || !cwdArg || separator < 0 || separator === argv.length - 1) {
    throw new Error('run-child requires --kind, --cwd, and a command after --');
  }
  const kind = kindArg.slice('--kind='.length);
  const cwd = cwdArg.slice('--cwd='.length);
  const command = argv.slice(separator + 1);
  const guardPath = new URL('./reservation-pilot-fixture-guard.mjs', import.meta.url).pathname;
  const environment = buildChildEnvironment(process.env, { kind, guardPath });
  const child = spawn(command[0], command.slice(1), { cwd, env: environment, stdio: 'inherit' });
  child.on('error', () => process.exit(1));
  child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 1)));
}

function readJsonFile(filePath, description) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    throw new Error(`${description} is missing or invalid`);
  }
}

function runCli(argv) {
  const command = argv[0];
  if (command === 'run-child') {
    runChild(argv.slice(1));
    return;
  }
  if (command === 'assert-files') {
    if (argv.length < 3) throw new Error('assert-files requires a root and at least one path');
    assertRequiredFiles(argv[1], argv.slice(2));
    return;
  }
  if (command === 'assert-plan-files') {
    if (argv.length !== 4) throw new Error('assert-plan-files requires root, mode, and slice');
    assertPlanFiles(argv[1], argv[2], argv[3]);
    return;
  }
  if (command === 'server-test-files') {
    if (argv.length !== 3) throw new Error('server-test-files requires mode and slice');
    process.stdout.write(`${getServerTestFiles(argv[1], argv[2]).join('\n')}\n`);
    return;
  }
  if (command === 'validate-vitest-report') {
    if (argv.length !== 2) throw new Error('validate-vitest-report requires report path');
    validateVitestReport(readJsonFile(argv[1], 'Vitest report'));
    return;
  }
  if (command === 'validate-manifest') {
    if (argv.length !== 2) throw new Error('validate-manifest requires a manifest path');
    assertManifestContract(readJsonFile(argv[1], 'manifest'));
    return;
  }
  if (command === 'validate-browser-config') {
    if (argv.length !== 3)
      throw new Error('validate-browser-config requires config and manifest paths');
    const manifest = readJsonFile(argv[2], 'manifest');
    assertManifestContract(manifest);
    assertFixtureConfigFile(argv[1], manifest.browserSafety.allowedOrigins);
    return;
  }
  if (command === 'manifest-origin') {
    if (argv.length !== 2) throw new Error('manifest-origin requires a manifest path');
    const manifest = readJsonFile(argv[1], 'manifest');
    assertManifestContract(manifest);
    const origin = manifest.browserSafety.allowedOrigins[0];
    if (typeof origin !== 'string') throw new Error('manifest has no browser origin');
    process.stdout.write(`${origin}\n`);
    return;
  }
  if (command === 'validate-browser-report') {
    if (argv.length < 3 || argv.length > 4) {
      throw new Error(
        'validate-browser-report requires report, title, and optional expected count',
      );
    }
    const expectedCount = argv[3] === undefined ? 1 : Number(argv[3]);
    validatePlaywrightReport(readJsonFile(argv[1], 'browser report'), argv[2], expectedCount);
    return;
  }
  if (command === 'check-browser-boundary') {
    if (argv.length !== 1) throw new Error('check-browser-boundary takes no arguments');
    assertBrowserNetworkBoundary();
    return;
  }
  if (command === 'validate-port-bindings') {
    if (argv.length < 2 || argv.length > 3) {
      throw new Error('validate-port-bindings requires JSON path and optional expected port');
    }
    validatePostgresPortBindings(readJsonFile(argv[1], 'Docker port bindings'), argv[2] ?? '15432');
    return;
  }
  if (command === 'db-profile') {
    if (argv.length !== 3) throw new Error('db-profile requires profile and field');
    const profile = getDbProfile(argv[1]);
    if (argv[2] === 'all') {
      process.stdout.write(
        [
          profile.port,
          profile.runLabel,
          profile.major,
          profile.receipt,
          profile.connection,
          profile.sentinelTable,
          profile.sentinelMarker,
        ].join('\t') + '\n',
      );
      return;
    }
    const value = profile[argv[2]];
    if (typeof value !== 'string') throw new Error(`unknown database profile field: ${argv[2]}`);
    process.stdout.write(`${value}\n`);
    return;
  }
  throw new Error(`unknown gate helper command: ${command ?? ''}`);
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly && process.argv[2]) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    console.error(
      `reservation-pilot-gate helper: ${error instanceof Error ? error.message : error}`,
    );
    process.exitCode = 1;
  }
}
