import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
} from 'node:fs';
import { platform, userInfo } from 'node:os';
import { basename, resolve } from 'node:path';
import { parseSealedCenturionThreadAuditSnapshotBytes } from './centurion-thread-audit-snapshot.js';

export const CENTURION_THREAD_AUDIT_CANDIDATE_SCHEMA =
  'centurion_thread_audit_candidate_v1' as const;
export const CENTURION_THREAD_AUDIT_CANDIDATE_ORIGIN =
  'centurion_thread_adjudication_apply_reports_v1' as const;
export const CENTURION_THREAD_AUDIT_CANDIDATE_FILE =
  'audit-snapshot-candidate.json' as const;
const OPERATOR_ROOT_NAME = '.zero-centurion-operator';
const CANDIDATES_DIRECTORY_NAME = 'candidates';
const CACHE_KEY_FILE_NAME = '.cache-signing-key';
const NOFOLLOW_FLAG = fsConstants.O_NOFOLLOW ?? 0;
const DIRECTORY_FLAG = fsConstants.O_DIRECTORY ?? 0;

type Candidate = {
  schema: typeof CENTURION_THREAD_AUDIT_CANDIDATE_SCHEMA;
  origin: typeof CENTURION_THREAD_AUDIT_CANDIDATE_ORIGIN;
  transportId: string;
  sourceIdentityDigest: string;
  sealedEnvelopeDigest: string;
  sealedEnvelopeBytes: string;
  originBinding: string;
};

function fail(code: string): never {
  throw new Error(code);
}

function currentUid(): number {
  return typeof process.getuid === 'function' ? process.getuid() : -1;
}

function assertPrivateDirectoryStat(stat: ReturnType<typeof fstatSync>): void {
  if (
    !stat.isDirectory() ||
    stat.uid !== currentUid() ||
    (Number(stat.mode) & 0o777) !== 0o700
  ) {
    fail('CENTURION_THREAD_AUDIT_SNAPSHOT_CANDIDATE_PATH_INVALID');
  }
}

function openPrivateDirectory(path: string): number {
  const expected = lstatSync(path);
  if (expected.isSymbolicLink()) fail('CENTURION_THREAD_AUDIT_SNAPSHOT_CANDIDATE_PATH_INVALID');
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, fsConstants.O_RDONLY | DIRECTORY_FLAG | NOFOLLOW_FLAG);
    const stat = fstatSync(descriptor);
    if (stat.dev !== expected.dev || stat.ino !== expected.ino) {
      fail('CENTURION_THREAD_AUDIT_SNAPSHOT_CANDIDATE_PATH_INVALID');
    }
    assertPrivateDirectoryStat(stat);
    return descriptor;
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    throw error;
  }
}

function readPrivateFile(input: { directoryFd: number; name: string }): Buffer {
  const anchoredPath = `/proc/self/fd/${input.directoryFd}/${input.name}`;
  const expected = lstatSync(anchoredPath);
  if (expected.isSymbolicLink()) fail('CENTURION_THREAD_AUDIT_SNAPSHOT_CANDIDATE_PATH_INVALID');
  let descriptor: number | undefined;
  try {
    descriptor = openSync(anchoredPath, fsConstants.O_RDONLY | NOFOLLOW_FLAG);
    const stat = fstatSync(descriptor);
    if (
      stat.dev !== expected.dev ||
      stat.ino !== expected.ino ||
      !stat.isFile() ||
      stat.uid !== currentUid() ||
      (stat.mode & 0o777) !== 0o600
    ) {
      fail('CENTURION_THREAD_AUDIT_SNAPSHOT_CANDIDATE_PATH_INVALID');
    }
    return readFileSync(descriptor);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function centurionThreadAuditCandidateOperatorRoot(): string {
  return resolve(userInfo().homedir, OPERATOR_ROOT_NAME);
}

export function readVerifiedCenturionThreadAuditSnapshotCandidate(path: string): string {
  return readVerifiedCandidateAtRoot({
    path,
    operatorRoot: centurionThreadAuditCandidateOperatorRoot(),
  });
}

function readVerifiedCandidateAtRoot(input: { path: string; operatorRoot: string }): string {
  if (platform() !== 'linux') {
    fail('CENTURION_THREAD_AUDIT_SNAPSHOT_CANDIDATE_PLATFORM_UNSUPPORTED');
  }
  const candidateName = basename(input.path);
  if (!/^[a-f0-9]{64}\.json$/u.test(candidateName)) {
    fail('CENTURION_THREAD_AUDIT_SNAPSHOT_CANDIDATE_PATH_INVALID');
  }
  if (
    resolve(input.path) !==
    resolve(input.operatorRoot, CANDIDATES_DIRECTORY_NAME, candidateName)
  ) {
    fail('CENTURION_THREAD_AUDIT_SNAPSHOT_CANDIDATE_PATH_INVALID');
  }
  const operatorFd = openPrivateDirectory(input.operatorRoot);
  let candidatesFd: number | undefined;
  try {
    candidatesFd = openPrivateDirectory(`/proc/self/fd/${operatorFd}/${CANDIDATES_DIRECTORY_NAME}`);
    const key = readPrivateFile({ directoryFd: operatorFd, name: CACHE_KEY_FILE_NAME });
    if (key.length !== 32) fail('CENTURION_THREAD_AUDIT_SNAPSHOT_CANDIDATE_PATH_INVALID');
    const candidateBytes = readPrivateFile({ directoryFd: candidatesFd, name: candidateName }).toString('utf8');
  const sealedEnvelopeBytes = parseCenturionThreadAuditSnapshotCandidate({
      candidateBytes,
      key,
    });
    if (`${parseSealedCenturionThreadAuditSnapshotBytes(sealedEnvelopeBytes).sealedEnvelopeDigest}.json` !== candidateName) {
      fail('CENTURION_THREAD_AUDIT_SNAPSHOT_CANDIDATE_PATH_INVALID');
    }
    return sealedEnvelopeBytes;
  } finally {
    if (candidatesFd !== undefined) closeSync(candidatesFd);
    closeSync(operatorFd);
  }
}

export function readVerifiedCenturionThreadAuditSnapshotCandidateForTest(input: {
  path: string;
  operatorRoot: string;
}): string {
  if (process.env.NODE_ENV !== 'test') {
    fail('CENTURION_THREAD_AUDIT_SNAPSHOT_CANDIDATE_PATH_INVALID');
  }
  return readVerifiedCandidateAtRoot(input);
}

function originBinding(input: {
  sealedEnvelopeBytes: string;
  transportId: string;
  sourceIdentityDigest: string;
  sealedEnvelopeDigest: string;
  key: Buffer;
}): string {
  return createHmac('sha256', input.key)
    .update(CENTURION_THREAD_AUDIT_CANDIDATE_SCHEMA)
    .update('\u0000')
    .update(CENTURION_THREAD_AUDIT_CANDIDATE_ORIGIN)
    .update('\u0000')
    .update(input.transportId)
    .update('\u0000')
    .update(input.sourceIdentityDigest)
    .update('\u0000')
    .update(input.sealedEnvelopeDigest)
    .update('\u0000')
    .update(input.sealedEnvelopeBytes)
    .digest('hex');
}

function serialize(candidate: Candidate): string {
  return JSON.stringify(candidate);
}

export function createCenturionThreadAuditSnapshotCandidate(input: {
  sealedEnvelopeBytes: string;
  key: Buffer;
}): string {
  const envelope = parseSealedCenturionThreadAuditSnapshotBytes(
    input.sealedEnvelopeBytes,
  );
  return serialize({
    schema: CENTURION_THREAD_AUDIT_CANDIDATE_SCHEMA,
    origin: CENTURION_THREAD_AUDIT_CANDIDATE_ORIGIN,
    transportId: envelope.transportId,
    sourceIdentityDigest: envelope.sourceIdentityDigest,
    sealedEnvelopeDigest: envelope.sealedEnvelopeDigest,
    sealedEnvelopeBytes: input.sealedEnvelopeBytes,
    originBinding: originBinding({ ...input, ...envelope }),
  });
}

export function parseCenturionThreadAuditSnapshotCandidate(input: {
  candidateBytes: string;
  key: Buffer;
}): string {
  let value: unknown;
  try {
    value = JSON.parse(input.candidateBytes) as unknown;
  } catch {
    fail('CENTURION_THREAD_AUDIT_SNAPSHOT_CANDIDATE_INVALID');
  }
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !==
      'origin,originBinding,schema,sealedEnvelopeBytes,sealedEnvelopeDigest,sourceIdentityDigest,transportId'
  ) {
    fail('CENTURION_THREAD_AUDIT_SNAPSHOT_CANDIDATE_INVALID');
  }
  const candidate = value as Candidate;
  if (
    candidate.schema !== CENTURION_THREAD_AUDIT_CANDIDATE_SCHEMA ||
    candidate.origin !== CENTURION_THREAD_AUDIT_CANDIDATE_ORIGIN ||
    typeof candidate.transportId !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(candidate.sourceIdentityDigest) ||
    !/^[a-f0-9]{64}$/u.test(candidate.sealedEnvelopeDigest) ||
    typeof candidate.sealedEnvelopeBytes !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(candidate.originBinding)
  ) {
    fail('CENTURION_THREAD_AUDIT_SNAPSHOT_CANDIDATE_INVALID');
  }
  if (serialize(candidate) !== input.candidateBytes) {
    fail('CENTURION_THREAD_AUDIT_SNAPSHOT_CANDIDATE_BYTES_INVALID');
  }
  const expected = Buffer.from(
    originBinding({
      sealedEnvelopeBytes: candidate.sealedEnvelopeBytes,
      transportId: candidate.transportId,
      sourceIdentityDigest: candidate.sourceIdentityDigest,
      sealedEnvelopeDigest: candidate.sealedEnvelopeDigest,
      key: input.key,
    }),
    'hex',
  );
  const supplied = Buffer.from(candidate.originBinding, 'hex');
  if (
    supplied.length !== expected.length ||
    !timingSafeEqual(supplied, expected)
  ) {
    fail('CENTURION_THREAD_AUDIT_SNAPSHOT_CANDIDATE_ORIGIN_INVALID');
  }
  const envelope = parseSealedCenturionThreadAuditSnapshotBytes(
    candidate.sealedEnvelopeBytes,
  );
  if (
    envelope.transportId !== candidate.transportId ||
    envelope.sourceIdentityDigest !== candidate.sourceIdentityDigest ||
    envelope.sealedEnvelopeDigest !== candidate.sealedEnvelopeDigest
  ) {
    fail('CENTURION_THREAD_AUDIT_SNAPSHOT_CANDIDATE_ORIGIN_INVALID');
  }
  return candidate.sealedEnvelopeBytes;
}
