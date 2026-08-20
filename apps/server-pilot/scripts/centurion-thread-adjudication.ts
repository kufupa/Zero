#!/usr/bin/env npx tsx
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { platform } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  adjudicateCenturionThreadState,
  trustCenturionThreadAdjudicationCacheRecords,
  type CenturionThreadAdjudicationReceipt,
} from '../src/ops/centurion-thread-adjudication.js';
import {
  CENTURION_THREAD_REPORT_FILES,
  createCenturionThreadReportReferenceFactory,
  renderCenturionThreadReports,
  type CenturionThreadReportsResult,
} from '../src/ops/centurion-thread-reports.js';
import {
  CENTURION_THREAD_BUSINESS_INSIGHTS_METRIC_DEFINITION_VERSION,
} from '../src/ops/centurion-thread-business-insights.js';
import {
  centurionThreadAuditCandidateOperatorRoot,
  createCenturionThreadAuditSnapshotCandidate,
  parseCenturionThreadAuditSnapshotCandidate,
} from '../src/ops/centurion-thread-audit-candidate.js';
import { parseSealedCenturionThreadAuditSnapshotBytes } from '../src/ops/centurion-thread-audit-snapshot.js';

const DEFAULT_OUTPUT_ROOT = '.tmp-centurion-thread-adjudication';
const DEFAULT_IDENTITY_RULES_VERSION = 'identity-rules-v1';
const DEFAULT_CLASSIFIER_VERSION = 'deterministic-classifier-v1';
const DEFAULT_METRIC_DEFINITION_VERSION =
  CENTURION_THREAD_BUSINESS_INSIGHTS_METRIC_DEFINITION_VERSION;
const CACHE_ENVELOPE_SCHEMA = 'centurion_thread_adjudication_cache_envelope_v1';
const CACHE_FILE_NAME = 'cache.json';
const CACHE_KEY_FILE_NAME = '.cache-signing-key';
const AUDIT_OPERATOR_ROOT_NAME = '.zero-centurion-operator';
const AUDIT_CANDIDATES_DIRECTORY_NAME = 'candidates';
const REPORT_DIRECTORY_NAME = 'reports';
const NOFOLLOW_FLAG = fsConstants.O_NOFOLLOW ?? 0;
const DIRECTORY_FLAG = fsConstants.O_DIRECTORY ?? 0;
const SERVER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPOSITORY_ROOT = resolve(SERVER_ROOT, '..', '..');

type CenturionThreadAdjudicationCommand =
  | { kind: 'help' }
  | {
      kind: 'dry_run' | 'apply';
      inputPath: string;
      rosterPath: string;
      cachePath: string | null;
      reviewDecisionPath: string | null;
      legacyPath: string | null;
      outputRoot: string | null;
      reports: boolean;
      identityRulesVersion: string;
      classifierVersion: string;
      metricDefinitionVersion: string;
    };

type LocalDependencies = {
  readText?: (path: string) => string | Promise<string>;
  loadTrustedCache?: (path: string) => unknown | Promise<unknown>;
  createCacheEnvelope?: (
    root: string,
    records: unknown,
  ) => unknown | Promise<unknown>;
  writeArtifacts?: (
    root: string,
    artifacts: Record<string, string>,
  ) => void | Promise<void>;
  writeReportRun?: (
    root: string,
    reports: CenturionThreadReportsResult,
  ) => void | Promise<void>;
};

export type CenturionThreadAdjudicationCliReceipt =
  CenturionThreadAdjudicationReceipt & {
    mode: 'dry_run' | 'apply';
  };

function fail(code: string): never {
  throw new Error(code);
}

function isInside(parent: string, target: string): boolean {
  const value = relative(parent, target);
  return (
    value === '' ||
    (!value.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) &&
      value !== '..' &&
      !isAbsolute(value))
  );
}

function parseRequiredPath(value: string | undefined, code: string): string {
  if (!value || value.startsWith('--')) fail(code);
  const normalized = value.trim();
  if (!normalized) fail(code);
  return resolve(normalized);
}

function parseVersion(value: string | undefined, code: string): string {
  if (!value || value.startsWith('--')) fail(code);
  const normalized = value.trim();
  if (!/^[A-Za-z0-9._:-]{1,160}$/u.test(normalized)) fail(code);
  return normalized;
}

export function validateCenturionThreadAdjudicationLocalPath(input: {
  path: string;
  serverRoot?: string;
  repositoryRoot?: string;
}): string {
  const serverRoot = resolve(input.serverRoot ?? SERVER_ROOT);
  const repositoryRoot = resolve(input.repositoryRoot ?? REPOSITORY_ROOT);
  const outputRoot = resolve(serverRoot, DEFAULT_OUTPUT_ROOT);
  const path = resolve(input.path);
  if (isInside(repositoryRoot, path) && !isInside(outputRoot, path)) {
    fail('CENTURION_THREAD_ADJUDICATION_LOCAL_PATH_REPOSITORY_REJECTED');
  }
  return path;
}

export function parseCenturionThreadAdjudicationArgs(
  argv: readonly string[],
): CenturionThreadAdjudicationCommand {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
    return { kind: 'help' };
  }
  let apply = false;
  let inputPath: string | undefined;
  let rosterPath: string | undefined;
  let cachePath: string | null = null;
  let reviewDecisionPath: string | null = null;
  let legacyPath: string | null = null;
  let outputRoot: string | null = null;
  let reports = false;
  let identityRulesVersion = DEFAULT_IDENTITY_RULES_VERSION;
  let classifierVersion = DEFAULT_CLASSIFIER_VERSION;
  let metricDefinitionVersion: string = DEFAULT_METRIC_DEFINITION_VERSION;
  const seen = new Set<string>();
  const mark = (option: string): void => {
    if (seen.has(option)) fail('CENTURION_THREAD_ADJUDICATION_DUPLICATE_ARGUMENT');
    seen.add(option);
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--apply') {
      mark(argument);
      apply = true;
      continue;
    }
    if (argument === '--reports') {
      mark(argument);
      reports = true;
      continue;
    }
    if (argument === '--input') {
      mark(argument);
      inputPath = validateCenturionThreadAdjudicationLocalPath({
        path: parseRequiredPath(
          argv[++index],
          'CENTURION_THREAD_ADJUDICATION_INPUT_REQUIRED',
        ),
      });
      continue;
    }
    if (argument === '--roster') {
      mark(argument);
      rosterPath = validateCenturionThreadAdjudicationLocalPath({
        path: parseRequiredPath(
          argv[++index],
          'CENTURION_THREAD_ADJUDICATION_ROSTER_REQUIRED',
        ),
      });
      continue;
    }
    if (argument === '--cache') {
      mark(argument);
      cachePath = validateCenturionThreadAdjudicationLocalPath({
        path: parseRequiredPath(
          argv[++index],
          'CENTURION_THREAD_ADJUDICATION_CACHE_PATH_REQUIRED',
        ),
      });
      continue;
    }
    if (argument === '--review-decisions') {
      mark(argument);
      reviewDecisionPath = validateCenturionThreadAdjudicationLocalPath({
        path: parseRequiredPath(
          argv[++index],
          'CENTURION_THREAD_ADJUDICATION_REVIEW_DECISION_PATH_REQUIRED',
        ),
      });
      continue;
    }
    if (argument === '--legacy-no-observed-response') {
      mark(argument);
      legacyPath = validateCenturionThreadAdjudicationLocalPath({
        path: parseRequiredPath(
          argv[++index],
          'CENTURION_THREAD_ADJUDICATION_LEGACY_PATH_REQUIRED',
        ),
      });
      continue;
    }
    if (argument === '--output-root') {
      mark(argument);
      outputRoot = validateCenturionThreadAdjudicationLocalPath({
        path: parseRequiredPath(
          argv[++index],
          'CENTURION_THREAD_ADJUDICATION_OUTPUT_ROOT_REQUIRED',
        ),
      });
      continue;
    }
    if (argument === '--identity-rules-version') {
      mark(argument);
      identityRulesVersion = parseVersion(
        argv[++index],
        'CENTURION_THREAD_ADJUDICATION_IDENTITY_RULES_VERSION_INVALID',
      );
      continue;
    }
    if (argument === '--classifier-version') {
      mark(argument);
      classifierVersion = parseVersion(
        argv[++index],
        'CENTURION_THREAD_ADJUDICATION_CLASSIFIER_VERSION_INVALID',
      );
      continue;
    }
    if (argument === '--metric-definition-version') {
      mark(argument);
      metricDefinitionVersion = parseVersion(
        argv[++index],
        'CENTURION_THREAD_ADJUDICATION_METRIC_DEFINITION_VERSION_INVALID',
      );
      continue;
    }
    fail('CENTURION_THREAD_ADJUDICATION_UNKNOWN_ARGUMENT');
  }
  if (!inputPath) fail('CENTURION_THREAD_ADJUDICATION_INPUT_REQUIRED');
  if (!rosterPath) fail('CENTURION_THREAD_ADJUDICATION_ROSTER_REQUIRED');
  if (!apply && outputRoot !== null) {
    fail('CENTURION_THREAD_ADJUDICATION_OUTPUT_REQUIRES_APPLY');
  }
  if (!apply && reports) {
    fail('CENTURION_THREAD_ADJUDICATION_REPORTS_REQUIRE_APPLY');
  }
  return {
    kind: apply ? 'apply' : 'dry_run',
    inputPath,
    rosterPath,
    cachePath,
    reviewDecisionPath,
    legacyPath,
    outputRoot: apply
      ? outputRoot ??
        validateCenturionThreadAdjudicationLocalPath({
          path: join(SERVER_ROOT, DEFAULT_OUTPUT_ROOT),
        })
      : null,
    reports,
    identityRulesVersion,
    classifierVersion,
    metricDefinitionVersion,
  };
}

export function centurionThreadAdjudicationHelp(): string {
  return [
    'usage: centurion-thread-adjudication.ts --input PATH --roster PATH [--cache PATH] [--review-decisions PATH] [--legacy-no-observed-response PATH] [--apply --reports --output-root PATH]',
    '  Default mode is dry run; it reads local canonical artifacts and writes nothing.',
    '  --apply writes private local-only cache, safe adjudication, and review-packet artifacts.',
    '  --apply --reports additionally publishes one private atomic reports run.',
    '  Paths inside repository must remain under .tmp-centurion-thread-adjudication.',
  ].join('\n');
}

function parseJson(value: string, code: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    fail(code);
  }
}

function stableJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(',')}}`;
  }
  fail('CENTURION_THREAD_ADJUDICATION_CACHE_ENVELOPE_INVALID');
}

function cacheEnvelopeSignature(records: unknown, key: Uint8Array): string {
  return createHmac('sha256', key)
    .update(stableJson({ schema: CACHE_ENVELOPE_SCHEMA, records }))
    .digest('hex');
}

export function createCenturionThreadAdjudicationCacheEnvelope(input: {
  records: unknown;
  key: Uint8Array;
}): {
  schema: typeof CACHE_ENVELOPE_SCHEMA;
  records: unknown;
  signature: string;
} {
  return {
    schema: CACHE_ENVELOPE_SCHEMA,
    records: input.records,
    signature: cacheEnvelopeSignature(input.records, input.key),
  };
}

export function parseCenturionThreadAdjudicationCacheEnvelope(input: {
  value: unknown;
  key: Uint8Array;
}): unknown {
  if (!input.value || typeof input.value !== 'object' || Array.isArray(input.value)) {
    fail('CENTURION_THREAD_ADJUDICATION_CACHE_ENVELOPE_INVALID');
  }
  const envelope = input.value as Record<string, unknown>;
  if (
    Object.keys(envelope).sort().join(',') !== 'records,schema,signature' ||
    envelope.schema !== CACHE_ENVELOPE_SCHEMA ||
    typeof envelope.signature !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(envelope.signature)
  ) {
    fail('CENTURION_THREAD_ADJUDICATION_CACHE_ENVELOPE_INVALID');
  }
  const supplied = Buffer.from(envelope.signature, 'hex');
  const expected = Buffer.from(
    cacheEnvelopeSignature(envelope.records, input.key),
    'hex',
  );
  if (
    supplied.length !== expected.length ||
    !timingSafeEqual(supplied, expected)
  ) {
    fail('CENTURION_THREAD_ADJUDICATION_CACHE_SIGNATURE_INVALID');
  }
  return envelope.records;
}

function defaultReadText(path: string): string {
  return readFileSync(path, 'utf8');
}

export type CenturionThreadAdjudicationApplyRootInspection = {
  path: string;
  realPath: string;
  isDirectory: boolean;
  isSymbolicLink: boolean;
  mode: number;
  uid: number;
};

export function validateCenturionThreadAdjudicationApplyRoot(input: {
  platform: string;
  currentUid: number;
  root: CenturionThreadAdjudicationApplyRootInspection;
}): void {
  if (input.platform !== 'linux') {
    fail('CENTURION_THREAD_ADJUDICATION_APPLY_PLATFORM_UNSUPPORTED');
  }
  if (input.root.isSymbolicLink) {
    fail('CENTURION_THREAD_ADJUDICATION_APPLY_ROOT_SYMLINK');
  }
  if (
    !input.root.isDirectory ||
    resolve(input.root.path) !== resolve(input.root.realPath)
  ) {
    fail('CENTURION_THREAD_ADJUDICATION_APPLY_ROOT_ESCAPE');
  }
  if (
    input.root.uid !== input.currentUid ||
    (input.root.mode & 0o777) !== 0o700
  ) {
    fail('CENTURION_THREAD_ADJUDICATION_APPLY_ROOT_PRIVATE');
  }
}

export function validateCenturionThreadAdjudicationReportFile(input: {
  currentUid: number;
  file: {
    isFile: boolean;
    isSymbolicLink: boolean;
    mode: number;
    uid: number;
  };
}): void {
  if (
    !input.file.isFile ||
    input.file.isSymbolicLink ||
    input.file.uid !== input.currentUid ||
    (input.file.mode & 0o777) !== 0o600
  ) {
    fail('CENTURION_THREAD_ADJUDICATION_REPORT_FILE_PRIVATE');
  }
}

export function validateCenturionThreadAdjudicationReportParent(input: {
  currentUid: number;
  parent: {
    isDirectory: boolean;
    isSymbolicLink: boolean;
    mode: number;
    uid: number;
  };
}): void {
  if (
    !input.parent.isDirectory ||
    input.parent.isSymbolicLink ||
    input.parent.uid !== input.currentUid ||
    (input.parent.mode & 0o777) !== 0o700
  ) {
    fail('CENTURION_THREAD_ADJUDICATION_REPORT_PARENT_PRIVATE');
  }
}

export function assertCenturionThreadAdjudicationReportRunName(
  name: string,
): void {
  if (!/^run_[a-f0-9]{64}$/u.test(name)) {
    fail('CENTURION_THREAD_ADJUDICATION_REPORT_RUN_NAME_INVALID');
  }
}

export function assertCenturionThreadAdjudicationApplyTargetAbsent(
  path: string,
  inspect: (path: string) => { isSymbolicLink: () => boolean } = lstatSync,
): void {
  try {
    const entry = inspect(path);
    if (entry.isSymbolicLink()) {
      fail('CENTURION_THREAD_ADJUDICATION_APPLY_TARGET_SYMLINK');
    }
    fail('CENTURION_THREAD_ADJUDICATION_APPLY_TARGET_EXISTS');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
}

function currentApplyUid(): number {
  if (platform() !== 'linux' || typeof process.getuid !== 'function') {
    fail('CENTURION_THREAD_ADJUDICATION_APPLY_PLATFORM_UNSUPPORTED');
  }
  return process.getuid();
}

function inspectApplyRoot(
  path: string,
): CenturionThreadAdjudicationApplyRootInspection {
  const info = lstatSync(path);
  return {
    path,
    realPath: realpathSync(path),
    isDirectory: info.isDirectory(),
    isSymbolicLink: info.isSymbolicLink(),
    mode: info.mode,
    uid: info.uid,
  };
}

export function centurionThreadAdjudicationAnchoredApplyRootPath(input: {
  platform: string;
  directoryFd: number;
}): string {
  if (input.platform !== 'linux' || !Number.isSafeInteger(input.directoryFd) || input.directoryFd < 0) {
    fail('CENTURION_THREAD_ADJUDICATION_APPLY_PLATFORM_UNSUPPORTED');
  }
  return `/proc/self/fd/${input.directoryFd}`;
}

function validateAnchoredApplyRoot(directoryFd: number, uid: number): void {
  const info = fstatSync(directoryFd);
  if (
    !info.isDirectory() ||
    info.uid !== uid ||
    (info.mode & 0o777) !== 0o700
  ) {
    fail('CENTURION_THREAD_ADJUDICATION_APPLY_ROOT_PRIVATE');
  }
}

function openAnchoredApplyRoot(root: string, uid: number): number {
  const expected = lstatSync(root);
  const descriptor = openSync(
    root,
    fsConstants.O_RDONLY | DIRECTORY_FLAG | NOFOLLOW_FLAG,
  );
  try {
    const anchored = fstatSync(descriptor);
    if (anchored.dev !== expected.dev || anchored.ino !== expected.ino) {
      fail('CENTURION_THREAD_ADJUDICATION_APPLY_ROOT_ESCAPE');
    }
    validateAnchoredApplyRoot(descriptor, uid);
    return descriptor;
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

function cacheSigningKeyFromPrivateRoot(input: {
  root: string;
  create: boolean;
}): Buffer {
  const uid = currentApplyUid();
  const outputRoot = input.create
    ? preparePrivateApplyRoot(input.root, uid)
    : input.root;
  if (!input.create) {
    validateCenturionThreadAdjudicationApplyRoot({
      platform: platform(),
      currentUid: uid,
      root: inspectApplyRoot(outputRoot),
    });
  }
  const directoryFd = openAnchoredApplyRoot(outputRoot, uid);
  try {
    const anchoredRoot = centurionThreadAdjudicationAnchoredApplyRootPath({
      platform: platform(),
      directoryFd,
    });
    const keyPath = join(anchoredRoot, CACHE_KEY_FILE_NAME);
    const existing = lstatIfExists(keyPath);
    if (!existing) {
      if (!input.create) {
        fail('CENTURION_THREAD_ADJUDICATION_CACHE_KEY_UNAVAILABLE');
      }
      let keyFd: number | undefined;
      try {
        keyFd = openSync(
          keyPath,
          fsConstants.O_WRONLY |
            fsConstants.O_CREAT |
            fsConstants.O_EXCL |
            NOFOLLOW_FLAG,
          0o600,
        );
        writeFileSync(keyFd, randomBytes(32));
        fsyncSync(keyFd);
        closeSync(keyFd);
        keyFd = undefined;
        chmodSync(keyPath, 0o600);
      } finally {
        if (keyFd !== undefined) closeSync(keyFd);
      }
    }
    validatePrivateApplyFile(keyPath, uid);
    const key = readFileSync(keyPath);
    if (key.length !== 32) {
      fail('CENTURION_THREAD_ADJUDICATION_CACHE_KEY_INVALID');
    }
    validateAnchoredApplyRoot(directoryFd, uid);
    return key;
  } finally {
    closeSync(directoryFd);
  }
}

function loadTrustedCacheEnvelope(cachePath: string): unknown {
  if (basename(cachePath) !== CACHE_FILE_NAME) {
    fail('CENTURION_THREAD_ADJUDICATION_CACHE_PATH_INVALID');
  }
  const root = dirname(cachePath);
  const key = cacheSigningKeyFromPrivateRoot({ root, create: false });
  return parseCenturionThreadAdjudicationCacheEnvelope({
    value: parseJson(
      readFileSync(cachePath, 'utf8'),
      'CENTURION_THREAD_ADJUDICATION_CACHE_JSON_INVALID',
    ),
    key,
  });
}

export function centurionThreadAuditOperatorRoot(input: {
  homeDirectory?: string;
  candidatePath?: string;
} = {}): string {
  if (input.homeDirectory !== undefined && process.env.NODE_ENV === 'test') {
    return resolve(input.homeDirectory, AUDIT_OPERATOR_ROOT_NAME);
  }
  return centurionThreadAuditCandidateOperatorRoot();
}

export function centurionThreadAuditCandidateRoot(input: {
  homeDirectory?: string;
  outputRoot?: string;
} = {}): string {
  return centurionThreadAuditOperatorRoot({ homeDirectory: input.homeDirectory });
}

export function centurionThreadAuditSnapshotCandidatePath(input: {
  root: string;
  sealedEnvelopeDigest: string;
}): string {
  if (!/^[a-f0-9]{64}$/u.test(input.sealedEnvelopeDigest)) {
    fail('CENTURION_THREAD_AUDIT_SNAPSHOT_CANDIDATE_PATH_INVALID');
  }
  return resolve(
    input.root,
    AUDIT_CANDIDATES_DIRECTORY_NAME,
    `${input.sealedEnvelopeDigest}.json`,
  );
}

export function writeCenturionThreadAuditSnapshotCandidate(input: {
  root: string;
  sealedEnvelopeBytes: string;
}): string {
  return writeCenturionThreadAuditSnapshotCandidateAtRoot({
    ...input,
    operatorRoot: centurionThreadAuditCandidateRoot(),
  });
}

function writeCenturionThreadAuditSnapshotCandidateAtRoot(input: {
  root: string;
  operatorRoot: string;
  sealedEnvelopeBytes: string;
}): string {
  const uid = currentApplyUid();
  const canonicalRoot = resolve(input.operatorRoot);
  if (resolve(input.root) !== canonicalRoot) {
    fail('CENTURION_THREAD_AUDIT_SNAPSHOT_CANDIDATE_PATH_INVALID');
  }
  const operatorRoot = preparePrivateApplyRoot(canonicalRoot, uid);
  const outputRoot = preparePrivateApplyRoot(
    join(operatorRoot, AUDIT_CANDIDATES_DIRECTORY_NAME),
    uid,
  );
  const key = cacheSigningKeyFromPrivateRoot({
    root: operatorRoot,
    create: true,
  });
  const candidateBytes = createCenturionThreadAuditSnapshotCandidate({
    sealedEnvelopeBytes: input.sealedEnvelopeBytes,
    key,
  });
  const candidatePath = centurionThreadAuditSnapshotCandidatePath({
    root: operatorRoot,
    sealedEnvelopeDigest: parseSealedCenturionThreadAuditSnapshotBytes(
      input.sealedEnvelopeBytes,
    ).sealedEnvelopeDigest,
  });
  const existing = lstatIfExists(candidatePath);
  if (existing) {
    validatePrivateApplyFile(candidatePath, uid);
    if (readFileSync(candidatePath, 'utf8') !== candidateBytes) {
      fail('CENTURION_THREAD_AUDIT_SNAPSHOT_CANDIDATE_BYTES_INVALID');
    }
    return candidatePath;
  }
  writePrivateApplyArtifact({
    root: outputRoot,
    name: basename(candidatePath),
    content: candidateBytes,
    uid,
  });
  return candidatePath;
}

export function writeCenturionThreadAuditSnapshotCandidateForTest(input: {
  root: string;
  operatorRoot: string;
  sealedEnvelopeBytes: string;
}): string {
  if (process.env.NODE_ENV !== 'test') {
    fail('CENTURION_THREAD_AUDIT_SNAPSHOT_CANDIDATE_PATH_INVALID');
  }
  return writeCenturionThreadAuditSnapshotCandidateAtRoot(input);
}

export function readVerifiedCenturionThreadAuditSnapshotCandidate(
  path: string,
): string {
  return readVerifiedCenturionThreadAuditSnapshotCandidateAtRoot({
    path,
    operatorRoot: centurionThreadAuditCandidateRoot(),
  });
}

function readVerifiedCenturionThreadAuditSnapshotCandidateAtRoot(input: {
  path: string;
  operatorRoot: string;
}): string {
  const path = input.path;
  const suppliedPath = resolve(path);
  const suppliedEntry = lstatSync(suppliedPath);
  if (suppliedEntry.isSymbolicLink()) {
    fail('CENTURION_THREAD_AUDIT_SNAPSHOT_CANDIDATE_PATH_INVALID');
  }
  const candidatePath = realpathSync(suppliedPath);
  const root = realpathSync(dirname(suppliedPath));
  const canonicalRoot = realpathSync(
    join(input.operatorRoot, AUDIT_CANDIDATES_DIRECTORY_NAME),
  );
  if (
    !/^[a-f0-9]{64}\.json$/u.test(basename(candidatePath)) ||
    dirname(candidatePath) !== root ||
    root !== canonicalRoot ||
    isInside(REPOSITORY_ROOT, root)
  ) {
    fail('CENTURION_THREAD_AUDIT_SNAPSHOT_CANDIDATE_PATH_INVALID');
  }
  validateCenturionThreadAdjudicationApplyRoot({
    platform: platform(),
    currentUid: currentApplyUid(),
    root: inspectApplyRoot(root),
  });
  const key = cacheSigningKeyFromPrivateRoot({
    root: input.operatorRoot,
    create: false,
  });
  validatePrivateApplyFile(candidatePath, currentApplyUid());
  const sealedEnvelopeBytes = parseCenturionThreadAuditSnapshotCandidate({
    candidateBytes: readFileSync(candidatePath, 'utf8'),
    key,
  });
  if (
    basename(candidatePath) !==
    `${parseSealedCenturionThreadAuditSnapshotBytes(sealedEnvelopeBytes).sealedEnvelopeDigest}.json`
  ) {
    fail('CENTURION_THREAD_AUDIT_SNAPSHOT_CANDIDATE_PATH_INVALID');
  }
  return sealedEnvelopeBytes;
}

export function readVerifiedCenturionThreadAuditSnapshotCandidateForTest(input: {
  path: string;
  operatorRoot: string;
}): string {
  if (process.env.NODE_ENV !== 'test') {
    fail('CENTURION_THREAD_AUDIT_SNAPSHOT_CANDIDATE_PATH_INVALID');
  }
  return readVerifiedCenturionThreadAuditSnapshotCandidateAtRoot(input);
}

function lstatIfExists(path: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function preparePrivateApplyRoot(root: string, uid: number): string {
  const resolvedRoot = resolve(root);
  const rootEntry = lstatIfExists(resolvedRoot);
  if (rootEntry?.isSymbolicLink()) {
    fail('CENTURION_THREAD_ADJUDICATION_APPLY_ROOT_SYMLINK');
  }
  if (!rootEntry) {
    const parent = dirname(resolvedRoot);
    const parentEntry = lstatIfExists(parent);
    if (
      !parentEntry ||
      !parentEntry.isDirectory() ||
      parentEntry.isSymbolicLink()
    ) {
      fail('CENTURION_THREAD_ADJUDICATION_APPLY_ROOT_ESCAPE');
    }
    mkdirSync(resolvedRoot, { mode: 0o700 });
  }
  validateCenturionThreadAdjudicationApplyRoot({
    platform: platform(),
    currentUid: uid,
    root: inspectApplyRoot(resolvedRoot),
  });
  return resolvedRoot;
}

function inspectApplyFile(path: string): {
  isFile: boolean;
  isSymbolicLink: boolean;
  mode: number;
  uid: number;
} {
  const info = lstatSync(path);
  return {
    isFile: info.isFile(),
    isSymbolicLink: info.isSymbolicLink(),
    mode: info.mode,
    uid: info.uid,
  };
}

function validatePrivateApplyFile(path: string, uid: number): void {
  const file = inspectApplyFile(path);
  if (
    !file.isFile ||
    file.isSymbolicLink ||
    file.uid !== uid ||
    (file.mode & 0o777) !== 0o600
  ) {
    fail('CENTURION_THREAD_ADJUDICATION_APPLY_TARGET_PRIVATE');
  }
}

function writePrivateApplyArtifact(input: {
  root: string;
  name: string;
  content: string;
  uid: number;
}): void {
  const outputPath = join(input.root, input.name);
  assertCenturionThreadAdjudicationApplyTargetAbsent(outputPath);
  const temporaryPath = join(
    input.root,
    `.centurion-thread-adjudication-${process.pid}-${Date.now()}-${input.name}.tmp`,
  );
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      temporaryPath,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        NOFOLLOW_FLAG,
      0o600,
    );
    writeFileSync(descriptor, input.content, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    chmodSync(temporaryPath, 0o600);
    validatePrivateApplyFile(temporaryPath, input.uid);
    linkSync(temporaryPath, outputPath);
    unlinkSync(temporaryPath);
    validatePrivateApplyFile(outputPath, input.uid);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      const temporaryEntry = lstatIfExists(temporaryPath);
      if (temporaryEntry && !temporaryEntry.isSymbolicLink()) {
        unlinkSync(temporaryPath);
      }
    } catch {
      // Keep an inaccessible local temporary artifact for operator recovery.
    }
    throw error;
  }
}

function defaultWriteArtifacts(
  root: string,
  artifacts: Record<string, string>,
): void {
  const uid = currentApplyUid();
  const outputRoot = preparePrivateApplyRoot(root, uid);
  const directoryFd = openAnchoredApplyRoot(outputRoot, uid);
  try {
    const anchoredRoot = centurionThreadAdjudicationAnchoredApplyRootPath({
      platform: platform(),
      directoryFd,
    });
    for (const [name, content] of Object.entries(artifacts)) {
      if (!/^(?:adjudication|cache|review-packets)\.json$/u.test(name)) {
        fail('CENTURION_THREAD_ADJUDICATION_APPLY_TARGET_INVALID');
      }
      validateAnchoredApplyRoot(directoryFd, uid);
      writePrivateApplyArtifact({
        root: anchoredRoot,
        name,
        content,
        uid,
      });
      validateAnchoredApplyRoot(directoryFd, uid);
    }
  } finally {
    closeSync(directoryFd);
  }
}

function reportFileNames(reports: CenturionThreadReportsResult): readonly string[] {
  const names = Object.keys(reports.files).sort();
  assertCenturionThreadAdjudicationReportRunFiles(names);
  return names;
}

export function assertCenturionThreadAdjudicationReportRunFiles(
  names: readonly string[],
): void {
  const expected = [...CENTURION_THREAD_REPORT_FILES].sort();
  const actual = [...names].sort();
  if (
    actual.length !== expected.length ||
    actual.some((name, index) => name !== expected[index])
  ) {
    fail('CENTURION_THREAD_ADJUDICATION_REPORT_FILES_INVALID');
  }
}

export function writeCenturionThreadAdjudicationReportRun(
  root: string,
  reports: CenturionThreadReportsResult,
  options: { testOnlyCandidateOperatorRoot?: string } = {},
): void {
  if (
    options.testOnlyCandidateOperatorRoot !== undefined &&
    process.env.NODE_ENV !== 'test'
  ) {
    fail('CENTURION_THREAD_AUDIT_SNAPSHOT_CANDIDATE_PATH_INVALID');
  }
  const uid = currentApplyUid();
  const outputRoot = preparePrivateApplyRoot(root, uid);
  const outputRootFd = openAnchoredApplyRoot(outputRoot, uid);
  try {
    const anchoredOutputRoot = centurionThreadAdjudicationAnchoredApplyRootPath({
      platform: platform(),
      directoryFd: outputRootFd,
    });
    const reportParentPath = join(anchoredOutputRoot, REPORT_DIRECTORY_NAME);
    const existingParent = lstatIfExists(reportParentPath);
    if (existingParent?.isSymbolicLink()) {
      fail('CENTURION_THREAD_ADJUDICATION_REPORT_PARENT_SYMLINK');
    }
    if (!existingParent) {
      mkdirSync(reportParentPath, { mode: 0o700 });
      chmodSync(reportParentPath, 0o700);
    }
    const reportParentEntry = lstatSync(reportParentPath);
    validateCenturionThreadAdjudicationReportParent({
      currentUid: uid,
      parent: {
        isDirectory: reportParentEntry.isDirectory(),
        isSymbolicLink: reportParentEntry.isSymbolicLink(),
        mode: reportParentEntry.mode,
        uid: reportParentEntry.uid,
      },
    });
    const reportParentFd = openAnchoredApplyRoot(reportParentPath, uid);
    try {
      const anchoredReportParent =
        centurionThreadAdjudicationAnchoredApplyRootPath({
          platform: platform(),
          directoryFd: reportParentFd,
        });
      const runName = reports.receipt.runRef;
      assertCenturionThreadAdjudicationReportRunName(runName);
      const finalPath = join(anchoredReportParent, runName);
      assertCenturionThreadAdjudicationApplyTargetAbsent(finalPath);
      const stageName = `.${runName}.stage-${process.pid}-${randomBytes(16).toString('hex')}`;
      const stagePath = join(anchoredReportParent, stageName);
      let stageFd: number | undefined;
      let published = false;
      try {
        mkdirSync(stagePath, { mode: 0o700 });
        chmodSync(stagePath, 0o700);
        stageFd = openAnchoredApplyRoot(stagePath, uid);
        const anchoredStage = centurionThreadAdjudicationAnchoredApplyRootPath({
          platform: platform(),
          directoryFd: stageFd,
        });
        for (const name of reportFileNames(reports)) {
          validateAnchoredApplyRoot(stageFd, uid);
          writePrivateApplyArtifact({
            root: anchoredStage,
            name,
            content: reports.files[name as keyof typeof reports.files],
            uid,
          });
          validateCenturionThreadAdjudicationReportFile({
            currentUid: uid,
            file: inspectApplyFile(join(anchoredStage, name)),
          });
        }
        assertCenturionThreadAdjudicationReportRunFiles(
          readdirSync(anchoredStage),
        );
        fsyncSync(stageFd);
        validateAnchoredApplyRoot(stageFd, uid);
        validateAnchoredApplyRoot(reportParentFd, uid);
        assertCenturionThreadAdjudicationApplyTargetAbsent(finalPath);
        renameSync(stagePath, finalPath);
        published = true;
        fsyncSync(reportParentFd);
        const finalFd = openAnchoredApplyRoot(finalPath, uid);
        try {
          const anchoredFinal = centurionThreadAdjudicationAnchoredApplyRootPath({
            platform: platform(),
            directoryFd: finalFd,
          });
          for (const name of CENTURION_THREAD_REPORT_FILES) {
            validateCenturionThreadAdjudicationReportFile({
              currentUid: uid,
              file: inspectApplyFile(join(anchoredFinal, name)),
            });
          }
          assertCenturionThreadAdjudicationReportRunFiles(
            readdirSync(anchoredFinal),
          );
          validateAnchoredApplyRoot(finalFd, uid);
        } finally {
          closeSync(finalFd);
        }
      } catch (error) {
        if (!published) {
          const finalEntry = lstatIfExists(finalPath);
          if (finalEntry && !finalEntry.isSymbolicLink()) {
            fail('CENTURION_THREAD_ADJUDICATION_REPORT_STAGING_FAILED');
          }
        }
        throw error;
      } finally {
        if (stageFd !== undefined) closeSync(stageFd);
      }
    } finally {
      closeSync(reportParentFd);
    }
    if (options.testOnlyCandidateOperatorRoot !== undefined) {
      writeCenturionThreadAuditSnapshotCandidateForTest({
        root: options.testOnlyCandidateOperatorRoot,
        operatorRoot: options.testOnlyCandidateOperatorRoot,
        sealedEnvelopeBytes: reports.auditSnapshotEnvelopeBytes,
      });
    } else {
      writeCenturionThreadAuditSnapshotCandidate({
        root: centurionThreadAuditCandidateRoot(),
        sealedEnvelopeBytes: reports.auditSnapshotEnvelopeBytes,
      });
    }
  } finally {
    closeSync(outputRootFd);
  }
}

function safeAdjudicationArtifact(result: ReturnType<typeof adjudicateCenturionThreadState>) {
  const messageRefs = new Map(
    result.turns.map((turn) => [turn.messageId, turn.messageRef]),
  );
  return {
    schema: result.schema,
    turns: result.turns.map(({ messageId: _messageId, ...turn }) => turn),
    annotations: result.annotations.map((annotation) => ({
      messageRef: messageRefs.get(annotation.messageId) ?? null,
      intent: annotation.intent,
      actionability: annotation.actionability,
    })),
    quoteCoverage: result.quoteCoverage.map((coverage) => ({
      messageRef: messageRefs.get(coverage.messageId) ?? null,
      status: coverage.status,
    })),
    reviewQueue: result.reviewQueue,
    correctionLedger: result.correctionLedger.map(
      ({ messageId: _messageId, ...row }) => row,
    ),
    receipt: result.receipt,
  };
}

export async function runCenturionThreadAdjudication(
  command: Exclude<CenturionThreadAdjudicationCommand, { kind: 'help' }>,
  dependencies: LocalDependencies = {},
): Promise<CenturionThreadAdjudicationCliReceipt> {
  if (
    command.kind === 'apply' &&
    command.reports &&
    command.metricDefinitionVersion !==
      CENTURION_THREAD_BUSINESS_INSIGHTS_METRIC_DEFINITION_VERSION
  ) {
    fail(
      'CENTURION_THREAD_BUSINESS_INSIGHTS_UNSUPPORTED_METRIC_DEFINITION_VERSION',
    );
  }
  const readText = dependencies.readText ?? defaultReadText;
  const writeArtifacts = dependencies.writeArtifacts ?? defaultWriteArtifacts;
  const writeReportRun =
    dependencies.writeReportRun ?? writeCenturionThreadAdjudicationReportRun;
  const corpora = parseJson(
    await readText(command.inputPath),
    'CENTURION_THREAD_ADJUDICATION_INPUT_JSON_INVALID',
  );
  const roster = parseJson(
    await readText(command.rosterPath),
    'CENTURION_THREAD_ADJUDICATION_ROSTER_JSON_INVALID',
  );
  const cacheRecords =
    command.cachePath === null
      ? undefined
      : await (dependencies.loadTrustedCache ?? loadTrustedCacheEnvelope)(
          command.cachePath,
        );
  const reviewDecisions =
    command.reviewDecisionPath === null
      ? undefined
      : parseJson(
          await readText(command.reviewDecisionPath),
          'CENTURION_THREAD_ADJUDICATION_REVIEW_DECISION_JSON_INVALID',
        );
  const legacyNoObservedResponses =
    command.legacyPath === null
      ? undefined
      : parseJson(
          await readText(command.legacyPath),
          'CENTURION_THREAD_ADJUDICATION_LEGACY_JSON_INVALID',
        );
  const result = adjudicateCenturionThreadState({
    roster: roster as Parameters<typeof adjudicateCenturionThreadState>[0]['roster'],
    corpora: corpora as readonly unknown[],
    trustedCacheRecords:
      cacheRecords === undefined
        ? undefined
        : trustCenturionThreadAdjudicationCacheRecords(cacheRecords),
    reviewDecisions,
    legacyNoObservedResponses,
    identityRulesVersion: command.identityRulesVersion,
    classifierVersion: command.classifierVersion,
    metricDefinitionVersion: command.metricDefinitionVersion,
  });
  if (command.kind === 'apply') {
    const outputRoot = command.outputRoot;
    if (!outputRoot) fail('CENTURION_THREAD_ADJUDICATION_OUTPUT_ROOT_REQUIRED');
    const cacheEnvelope = await (
      dependencies.createCacheEnvelope ??
      ((root: string, records: unknown) =>
        createCenturionThreadAdjudicationCacheEnvelope({
          records,
          key: cacheSigningKeyFromPrivateRoot({ root, create: true }),
        }))
    )(outputRoot, result.cacheRecords);
    const artifacts = {
      'adjudication.json': `${JSON.stringify(safeAdjudicationArtifact(result))}\n`,
      'cache.json': `${JSON.stringify(cacheEnvelope)}\n`,
      ...(command.reports
        ? {}
        : {
            'review-packets.json': `${JSON.stringify(result.reviewPackets)}\n`,
          }),
    };
    await writeArtifacts(outputRoot, artifacts);
    if (command.reports) {
      const reports = renderCenturionThreadReports({
        corpora: corpora as readonly unknown[],
        adjudication: result,
        generatedAt: new Date().toISOString(),
        identityRulesVersion: command.identityRulesVersion,
        classifierVersion: command.classifierVersion,
        metricDefinitionVersion: command.metricDefinitionVersion,
        referenceFactory: createCenturionThreadReportReferenceFactory(
          (size) => randomBytes(size),
        ),
      });
      await writeReportRun(outputRoot, reports);
    }
  }
  return {
    ...result.receipt,
    mode: command.kind,
  };
}

export function formatCenturionThreadAdjudicationReceipt(
  receipt: CenturionThreadAdjudicationCliReceipt,
): string {
  return JSON.stringify({
    ok: true,
    mode: receipt.mode,
    corpusCount: receipt.corpusCount,
    messageCount: receipt.messageCount,
    componentCount: receipt.componentCount,
    cacheReusedCount: receipt.cacheReusedCount,
    reviewQueueCount: receipt.reviewQueueCount,
    outputDigest: receipt.outputDigest,
  });
}

export function safeCenturionThreadAdjudicationErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  return /^CENTURION_THREAD_(?:ADJUDICATION|BUSINESS_INSIGHTS)_[A-Z0-9_:-]+$/u.test(
    message,
  )
    ? message
    : 'CENTURION_THREAD_ADJUDICATION_FAILED';
}

async function main(): Promise<void> {
  const command = parseCenturionThreadAdjudicationArgs(process.argv.slice(2));
  if (command.kind === 'help') {
    process.stdout.write(`${centurionThreadAdjudicationHelp()}\n`);
    return;
  }
  const receipt = await runCenturionThreadAdjudication(command);
  process.stdout.write(`${formatCenturionThreadAdjudicationReceipt(receipt)}\n`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (
  invokedPath &&
  pathToFileURL(invokedPath).href === import.meta.url
) {
  main().catch((error) => {
    process.stderr.write(`${safeCenturionThreadAdjudicationErrorCode(error)}\n`);
    process.exitCode = 1;
  });
}
