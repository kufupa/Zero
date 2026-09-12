/**
 * Purpose-built HMS live proof CLI (compiled to dist/ops/hms-live-proof.js).
 * Phase A: canary | start | status | stop | rearm | proof-video | detail-dump | purge-artifacts | accept-g1.
 * Phase B: shared argv via phase-b-operation (doctor, status, read-*, artifacts, rearm, ...).
 * No tsx. Never accepts raw lookup / thread / message ID via argv.
 * Public proof files store digests only; the completed live proof also retains
 * its typed tool result in a separate mode-0600 private sidecar.
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  chmodSync,
  openSync,
  closeSync,
  fsyncSync,
  rmSync,
  statSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { and, asc, count, desc, eq, inArray, like, sql } from 'drizzle-orm';
import { createDb, getDb, closeDb } from '../db/client.js';
import {
  aiDraftGeneration,
  aiWorkflowRun,
  mailDraft,
  mailDraftRevision,
  message,
} from '../db/schema/mail.js';
import { TRANSPORT_ID as CENTURION_TRANSPORT_ID } from '../db/seed.js';
import {
  extractLookupCandidates,
  filterExactReservationCandidates,
  normalizeMessageText,
} from '../ai/thread-context.js';
import {
  DEFAULT_AI_MODEL_ID,
  enqueueAiRun,
  countNonterminalAiRuns,
  NONTERMINAL_AI_RUN_STATES,
  markAiRunDeadLetter,
} from '../ai/run-ledger.js';
import { parseEnv, requireHmsWorkerRuntimeConfig } from '../env.js';
import {
  buildLiveGuestStayRowFingerprintV2,
  createLiveGuestStayDriver,
} from '../hms/live-guest-stay-driver.js';
import { createProductionHmsRuntime } from '../hms/production-runtime.js';
import { createPostgresPropertyReadLock } from '../hms/property-read-lock.js';
import { HmsRuntimeError } from '../hms/runtime.js';
import {
  purgeExpiredHmsBrowserArtifacts,
  type HmsBrowserArtifactReceiptV1,
} from '../hms/browser-artifacts.js';
import { resolveExclusiveReceiptFileSync } from '../hms/receipt-exclusivity.js';
import type { ExactReservationCandidate, ReservationSearchCandidate } from '../hms/live-read-manifest.js';
import {
  buildExactOsressSearchManifest,
  LIVE_GUEST_STAY_SEARCH_PATH,
  liveNotFoundCanaryCandidate,
} from '../hms/live-read-manifest.js';
import {
  PhaseBOperationStore,
  parsePhaseBArgv,
  runPhaseBLocalOperator,
  type PhaseBOperatorResult,
} from './phase-b-operation.js';
import {
  assertPhaseAProofPropertyReadLock,
  assertPhaseAProofAuthorizationForDispatch,
  createPhaseAProofRuntime,
  issuePhaseAProofAuthorization,
  HmsProofCompositionError,
  validatePhaseAProofMilestones,
  writeHmsProofResultSidecar,
  type PhaseAProofAuthorization,
} from './hms-proof-composition.js';

/** Quote receipt-v2 + private index bind (masked digests only). */
export { materializeMaskedQuoteProofArtifacts } from '../hms/quote-proof-artifacts.js';
export { materializeMaskedCommsProofArtifacts } from '../hms/communications-proof-artifacts.js';

export const HMS_DEPENDENCY_REVISION =
  'playwright-1.52.0-chromium-1169' as const;

export type HmsOperatorFailCode =
  | 'MODE_ENABLED_FORBIDDEN'
  | 'DEPENDENCY_MISMATCH'
  | 'ROLE_PROOF_MISSING'
  | 'ROLE_PROOF_EXPIRED'
  | 'ROLE_SCOPE_INVALID'
  | 'AUTH_FAILED'
  | 'PROPERTY_MISMATCH'
  | 'POLICY_BLOCK'
  | 'SCHEMA_DRIFT'
  | 'WEBSOCKET_BLOCKED'
  | 'POPUP_BLOCKED'
  | 'DOWNLOAD_BLOCKED'
  | 'RUN_ISOLATION_BLOCKED'
  | 'BUILD_MISMATCH'
  | 'MANIFEST_MISMATCH'
  | 'FINGERPRINT_MISMATCH'
  | 'HEALTH_STALE'
  | 'FORBIDDEN_PERSISTENCE'
  | 'ROLLBACK_INCOMPLETE'
  | 'TRANSIENT_NETWORK'
  | 'UNKNOWN_SAFE';

export type HmsReservationCanaryProofV1 = {
  schemaVersion: 1;
  buildCommit: string;
  manifestSha256: string;
  rowFingerprintSha256: string;
  dependencyRevision: typeof HMS_DEPENDENCY_REVISION;
  roleProofSha256: string;
  finishedAt: string;
  expiresAt: string;
};

export type HmsReservationShadowProofV1 = {
  schemaVersion: 1;
  proofAttemptId: string;
  runId: string;
  runningProcessCommit: string;
  processStartedAt: string;
  manifestSha256: string;
  rowFingerprintSha256: string;
  canaryProofSha256: string;
  dependencyRevision: typeof HMS_DEPENDENCY_REVISION;
  roleProofSha256: string;
  shadowVerified: true;
  forbiddenRowDelta: 0;
  policyBlockDelta: 0;
  finishedAt: string;
  expiresAt: string;
};

const OPERATOR_FAIL_CODES = new Set<string>([
  'MODE_ENABLED_FORBIDDEN',
  'DEPENDENCY_MISMATCH',
  'ROLE_PROOF_MISSING',
  'ROLE_PROOF_EXPIRED',
  'ROLE_SCOPE_INVALID',
  'AUTH_FAILED',
  'PROPERTY_MISMATCH',
  'POLICY_BLOCK',
  'SCHEMA_DRIFT',
  'WEBSOCKET_BLOCKED',
  'POPUP_BLOCKED',
  'DOWNLOAD_BLOCKED',
  'RUN_ISOLATION_BLOCKED',
  'BUILD_MISMATCH',
  'MANIFEST_MISMATCH',
  'FINGERPRINT_MISMATCH',
  'HEALTH_STALE',
  'FORBIDDEN_PERSISTENCE',
  'ROLLBACK_INCOMPLETE',
  'TRANSIENT_NETWORK',
  'UNKNOWN_SAFE',
]);

const PROOF_TTL_MS = 24 * 60 * 60 * 1000;
const HEALTH_STALE_MS = 5 * 60 * 1000;
const PHASE_A_PLAN_PATH =
  'docs/superpowers/plans/2026-08-04-mail-read-artifact-reservation-chain.md';

function sharedDir(): string {
  return (
    process.env.HMS_SHARED_DIR?.trim() || '/opt/nava/shared/hms-runtime'
  );
}

function canaryProofPath(): string {
  return (
    process.env.HMS_CANARY_PROOF_PATH?.trim() ||
    join(sharedDir(), 'hms-reservation-canary-proof.v1.json')
  );
}

function shadowProofPath(): string {
  return (
    process.env.HMS_SHADOW_PROOF_PATH?.trim() ||
    join(sharedDir(), 'hms-reservation-shadow-proof.v1.json')
  );
}

function disableFlagPath(): string {
  return (
    process.env.HMS_SHADOW_DISABLE_PATH?.trim() ||
    join(sharedDir(), 'hms-shadow-disabled')
  );
}

function roleProofPath(): string {
  return (
    process.env.HMS_READ_ROLE_PROOF_PATH?.trim() ||
    '/etc/nava/hms-read-role-proof.v1.json'
  );
}

function dependencyStampPath(): string {
  return (
    process.env.HMS_DEPENDENCY_STAMP_PATH?.trim() ||
    '/opt/nava/shared/hms-dependency-revision.txt'
  );
}

function operationLockPath(): string {
  return join(sharedDir(), '.hms-live-operation.lock');
}

function kernelOperationLockPath(): string {
  return join(sharedDir(), '.hms-live-operation.v2.lock');
}

function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

const pendingOutputLines: string[] = [];

function emitOk(token: string): void {
  pendingOutputLines.push(token);
}

class OperatorExit extends Error {
  readonly exitCode: 0 | 3 | 10 | 20;
  readonly line: string;
  constructor(exitCode: 0 | 3 | 10 | 20, line: string) {
    super(line);
    this.name = 'OperatorExit';
    this.exitCode = exitCode;
    this.line = line;
  }
}

function emitWait(code: string): never {
  const line = `HMS_WAIT code=${code}`;
  throw new OperatorExit(3, line);
}

function emitG1Wait(): never {
  const line = 'G1_WAIT code=PROOF_STALE';
  throw new OperatorExit(3, line);
}

function emitG1Fail(gate?: PhaseAGateV1 | null): never {
  if (
    gate &&
    (gate.state === 'awaiting_continue' || gate.state === 'accepted')
  ) {
    try {
      writeAtomicJson(phaseAGatePath(), {
        ...gate,
        state: 'awaiting_continue',
        writtenAt: new Date().toISOString(),
        acceptedAt: undefined,
      });
    } catch {
      const rollbackLine = 'G1_FAIL code=ROLLBACK_INCOMPLETE';
      throw new OperatorExit(20, rollbackLine);
    }
  }
  const line = 'G1_FAIL code=EVIDENCE_INVALID';
  throw new OperatorExit(10, line);
}

function emitFail(code: string): never {
  if (code === 'ROLLBACK_INCOMPLETE') {
    const line = 'HMS_FAIL code=ROLLBACK_INCOMPLETE';
    throw new OperatorExit(20, line);
  }
  const safe = OPERATOR_FAIL_CODES.has(code) ? code : 'UNKNOWN_SAFE';
  const line = `HMS_FAIL code=${safe}`;
  throw new OperatorExit(10, line);
}

function assertNoLookupArgv(argv: string[]): void {
  for (const arg of argv) {
    if (
      /^(--)?(confirmation|external|thread|message|candidate|value)(=|$)/i.test(
        arg,
      )
    ) {
      emitFail('POLICY_BLOCK');
    }
  }
}

function mapRuntimeFail(err: unknown): HmsOperatorFailCode {
  if (err instanceof HmsRuntimeError) {
    if (OPERATOR_FAIL_CODES.has(err.code)) {
      return err.code as HmsOperatorFailCode;
    }
    if (/AUDIT_CAPTURE|TRACE_|VIDEO_|CAPTURE_CAPACITY|PRODUCTION_ORIGIN/i.test(err.code)) {
      return 'POLICY_BLOCK';
    }
    if (/ROLE_PROOF_MISSING/i.test(err.code)) return 'ROLE_PROOF_MISSING';
    if (/ROLE_PROOF_EXPIRED/i.test(err.code)) return 'ROLE_PROOF_EXPIRED';
    if (/ROLE_SCOPE/i.test(err.code)) return 'ROLE_SCOPE_INVALID';
    if (/AUTH|login|credential/i.test(err.code)) return 'AUTH_FAILED';
    if (/PROPERTY|wrong_property|wrong_tenant/i.test(err.code)) {
      return 'PROPERTY_MISMATCH';
    }
    if (/WEBSOCKET/i.test(err.code)) return 'WEBSOCKET_BLOCKED';
    if (/POPUP/i.test(err.code)) return 'POPUP_BLOCKED';
    if (/DOWNLOAD/i.test(err.code)) return 'DOWNLOAD_BLOCKED';
    if (/POLICY|unknown_path|session_failed/i.test(err.code)) return 'POLICY_BLOCK';
    if (/SCHEMA|malformed|correlation/i.test(err.code)) return 'SCHEMA_DRIFT';
    if (/TRANSIENT|network|chromium/i.test(err.code)) return 'TRANSIENT_NETWORK';
  }
  const msg = err instanceof Error ? err.message : String(err);
  if (/Target page, context or browser has been closed/i.test(msg)) {
    return 'POLICY_BLOCK';
  }
  return 'UNKNOWN_SAFE';
}

// Opt-in standalone diagnostics: never emit messages, inputs, or credential data.
function proofDiagnostic(stage: string, error: unknown): void {
  if (process.env.HMS_PROOF_DIAGNOSTICS !== '1') return;
  const safeCode = (value: unknown): string | undefined =>
    typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value)
      ? value
      : undefined;
  const nestedErrors =
    error instanceof AggregateError ? error.errors : [];
  const nested =
    nestedErrors
      .map((item) => safeCode((item as { code?: unknown })?.code) ?? safeCode(item instanceof Error ? item.name : undefined))
      .filter((item): item is string => Boolean(item))
      .slice(0, 4);
  const code =
    safeCode((error as { code?: unknown } | null)?.code) ??
    nested[0] ??
    (error instanceof Error ? safeCode(error.name) : undefined) ??
    'Unknown';
  const messageCandidates = [
    nestedErrors[0] instanceof Error ? nestedErrors[0].message : undefined,
    error instanceof Error ? error.message : undefined,
  ];
  let message: string | undefined;
  for (const rawMessage of messageCandidates) {
    if (
      typeof rawMessage === 'string' &&
      /^[A-Za-z][A-Za-z0-9 ._:/()-]{0,96}$/.test(rawMessage)
    ) {
      message = rawMessage;
      break;
    }
  }
  const frames = error instanceof Error
    ? (error.stack ?? '').split('\n').slice(1).filter((line) =>
        /^\s+at [\w.$/:<> ()-]+:\d+:\d+\)?$/.test(line),
      ).slice(0, 5)
    : [];
  process.stderr.write(`${JSON.stringify({
    type: 'HMS_PROOF_DIAGNOSTIC', stage,
    code,
    ...(nested.length > 0 ? { nested } : {}),
    ...(message ? { message } : {}),
    frames,
  })}\n`);
}

function buildCommit(): string {
  const fromEnv = process.env.NAVA_BUILD_COMMIT?.trim();
  if (fromEnv) return fromEnv;
  const git = spawnSync('git', ['rev-parse', 'HEAD'], {
    encoding: 'utf8',
    cwd: process.env.REPO_ROOT || process.cwd(),
  });
  if (git.status === 0 && git.stdout.trim()) return git.stdout.trim();
  return 'unknown';
}

function writeAtomicJson(path: string, value: unknown): void {
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  const tmpFd = openSync(tmp, 'r');
  try {
    try {
      fsyncSync(tmpFd);
    } catch (error) {
      if (process.platform !== 'win32') throw error;
    }
  } finally {
    closeSync(tmpFd);
  }
  try {
    const parentFd = openSync(parent, 'r');
    try {
      fsyncSync(parentFd);
    } finally {
      closeSync(parentFd);
    }
  } catch {
    // Directory fsync is unavailable on some local Windows filesystems.
  }
  if (process.platform === 'win32' && existsSync(path)) {
    // Windows rename cannot replace; production Linux retains atomic replace.
    unlinkSync(path);
  }
  renameSync(tmp, path);
  chmodSync(path, 0o600);
  try {
    const parentFd = openSync(parent, 'r');
    try {
      fsyncSync(parentFd);
    } finally {
      closeSync(parentFd);
    }
  } catch {
    // Production proof host is Linux; retain portable local test behavior.
  }
}

function readJsonFile<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

function invalidateProofs(): void {
  for (const p of [canaryProofPath(), shadowProofPath()]) {
    if (existsSync(p)) unlinkSync(p);
    if (existsSync(p)) throw new Error('proof invalidation incomplete');
  }
}

function assertDependenciesOk(): void {
  const stampPath = dependencyStampPath();
  const stamp = existsSync(dependencyStampPath())
    ? readFileSync(dependencyStampPath(), 'utf8').trim()
    : '';
  const chrome =
    process.env.HMS_CHROMIUM_EXECUTABLE_PATH?.trim() ||
    '/opt/nava/chromium/chrome';
  const browsers =
    process.env.PLAYWRIGHT_BROWSERS_PATH?.trim() || '/opt/nava/ms-playwright';
  let immutable = true;
  if (process.platform !== 'win32') {
    try {
      immutable = [stampPath, chrome, dirname(chrome), browsers].every(
        (path) => {
          const info = statSync(path);
          return info.uid === 0 && (info.mode & 0o222) === 0;
        },
      );
    } catch {
      immutable = false;
    }
  }
  const unzip = spawnSync(
    process.env.HMS_UNZIP_EXECUTABLE_PATH?.trim() || 'unzip',
    ['-v'],
    { stdio: 'ignore' },
  );
  if (
    stamp !== HMS_DEPENDENCY_REVISION ||
    !existsSync(chrome) ||
    !immutable ||
    unzip.status !== 0 ||
    unzip.error
  ) {
    emitFail('DEPENDENCY_MISMATCH');
  }
}

function loadRoleProofDigest(): { sha256: string; expiresAt: string } {
  const path = roleProofPath();
  if (!existsSync(path)) {
    process.stdout.write(`roleProofPath=${path}\n`);
    emitFail('ROLE_PROOF_MISSING');
  }
  if (process.platform !== 'win32') {
    const info = statSync(path);
    if (info.uid !== 0 || (info.mode & 0o777) !== 0o444) {
      process.stdout.write(`roleProofPath=${path}\n`);
      emitFail('ROLE_SCOPE_INVALID');
    }
  }
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    process.stdout.write(`roleProofPath=${path}\n`);
    emitFail('ROLE_PROOF_MISSING');
  }
  let parsed: {
    expiresAt?: string;
    propertyCode?: string;
    allowedSurfaces?: string[];
    deniedActions?: string[];
  };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    process.stdout.write(`roleProofPath=${path}\n`);
    emitFail('ROLE_SCOPE_INVALID');
  }
  if (parsed.propertyCode !== 'HRCEN') {
    process.stdout.write(`roleProofPath=${path}\n`);
    emitFail('ROLE_SCOPE_INVALID');
  }
  if (!parsed.allowedSurfaces?.includes('Guest Stay')) {
    process.stdout.write(`roleProofPath=${path}\n`);
    emitFail('ROLE_SCOPE_INVALID');
  }
  const requiredDenied = [
    'new_record',
    'save',
    'delete',
    'duplicate',
    'check_in',
    'check_out',
    'document_generate',
    'document_send',
  ];
  for (const d of requiredDenied) {
    if (!parsed.deniedActions?.includes(d)) {
      process.stdout.write(`roleProofPath=${path}\n`);
      emitFail('ROLE_SCOPE_INVALID');
    }
  }
  if (!parsed.expiresAt || Date.parse(parsed.expiresAt) <= Date.now()) {
    process.stdout.write(`roleProofPath=${path}\n`);
    emitFail('ROLE_PROOF_EXPIRED');
  }
  return { sha256: sha256Hex(raw), expiresAt: parsed.expiresAt };
}

function codeArtifactDigests(): {
  manifestSha256: string;
  rowFingerprintSha256: string;
} {
  const fingerprint = buildLiveGuestStayRowFingerprintV2();
  if (fingerprint.valuesCaptured !== false) {
    emitFail('SCHEMA_DRIFT');
  }
  const manifestSha256 = sha256Hex(
    JSON.stringify({
      searchPath: LIVE_GUEST_STAY_SEARCH_PATH,
      structure: fingerprint.manifestSha256,
    }),
  );
  const rowFingerprintSha256 = sha256Hex(
    JSON.stringify({
      schemaVersion: fingerprint.schemaVersion,
      selectorKeys: fingerprint.selectorKeys,
      columnKeys: fingerprint.columnKeys,
      valuesCaptured: false,
    }),
  );
  return { manifestSha256, rowFingerprintSha256 };
}

function pm2DescribeHms(): {
  present: boolean;
  online: boolean;
  startedAt?: string;
  commit?: string;
  execPath?: string;
} {
  const out = spawnSync('pm2', ['jlist'], { encoding: 'utf8' });
  if (out.status !== 0 || out.error) {
    throw new HmsRuntimeError(
      'RUN_ISOLATION_BLOCKED',
      'PM2 inspection failed',
    );
  }
  try {
    const apps = JSON.parse(out.stdout || '[]') as Array<{
      name?: string;
      pm2_env?: {
        status?: string;
        pm_uptime?: number;
        pm_exec_path?: string;
        NAVA_BUILD_COMMIT?: string;
        env?: Record<string, string>;
      };
    }>;
    const hit = apps.find((a) => a.name === 'hms-ai-worker');
    if (!hit) return { present: false, online: false };
    const status = hit.pm2_env?.status;
    const online = status === 'online';
    const startedAt = hit.pm2_env?.pm_uptime
      ? new Date(hit.pm2_env.pm_uptime).toISOString()
      : undefined;
    const commit =
      hit.pm2_env?.NAVA_BUILD_COMMIT ||
      hit.pm2_env?.env?.NAVA_BUILD_COMMIT ||
      undefined;
    return {
      present: true,
      online,
      startedAt,
      commit,
      execPath: hit.pm2_env?.pm_exec_path,
    };
  } catch {
    throw new HmsRuntimeError(
      'RUN_ISOLATION_BLOCKED',
      'PM2 inspection malformed',
    );
  }
}

function pm2DefaultHealthy(): boolean {
  const out = spawnSync('pm2', ['jlist'], { encoding: 'utf8' });
  if (out.status !== 0) return false;
  try {
    const apps = JSON.parse(out.stdout || '[]') as Array<{
      name?: string;
      pm2_env?: { status?: string };
    }>;
    const http = apps.find((a) => a.name === 'http');
    const worker = apps.find((a) => a.name === 'worker');
    const ai = apps.find((a) => a.name === 'ai-worker');
    return (
      http?.pm2_env?.status === 'online' &&
      worker?.pm2_env?.status === 'online' &&
      ai?.pm2_env?.status === 'online'
    );
  } catch {
    return false;
  }
}

function deleteHmsPm2(): void {
  const before = pm2DescribeHms();
  if (before.present) {
    const deleted = spawnSync('pm2', ['delete', 'hms-ai-worker'], {
      encoding: 'utf8',
    });
    if (deleted.status !== 0 || deleted.error) {
      emitFail('ROLLBACK_INCOMPLETE');
    }
  }
  const saved = spawnSync('pm2', ['save'], { encoding: 'utf8' });
  if (saved.status !== 0 || saved.error) emitFail('ROLLBACK_INCOMPLETE');
  if (pm2DescribeHms().present) emitFail('ROLLBACK_INCOMPLETE');
}

function startHmsPm2(input: {
  proofAttemptId: string;
  buildCommit: string;
}): { startedAt: string } {
  const repo =
    process.env.REPO_ROOT?.trim() || '/home/ubuntu/repos/zero';
  const config = join(repo, 'apps/server-pilot/deploy/pm2.config.cjs');
  // Ensure prior instance gone — sole starter path; autorestart false.
  deleteHmsPm2();
  const env = {
    ...process.env,
    NAVA_BUILD_COMMIT: input.buildCommit,
    HMS_DRAFT_ENRICHMENT_MODE: 'shadow',
    AI_WORKER_LANE: 'hms',
    AI_WORKER_IDEMPOTENCY_PREFIX: `hms-proof:${input.proofAttemptId}:`,
    AI_DRAFTS_ENABLED: 'false',
  };
  const started = spawnSync(
    'pm2',
    ['start', config, '--only', 'hms-ai-worker', '--update-env'],
    { encoding: 'utf8', env },
  );
  if (started.status !== 0) {
    emitFail('UNKNOWN_SAFE');
  }
  const running = pm2DescribeHms();
  const expectedPath = '/usr/local/bin/asm-exec';
  if (
    !running.present ||
    !running.online ||
    running.commit !== input.buildCommit ||
    running.execPath !== expectedPath ||
    !running.startedAt
  ) {
    emitFail('BUILD_MISMATCH');
  }
  return { startedAt: running.startedAt! };
}

export type ExactMailAnchor = {
  candidate: ReservationSearchCandidate;
  messageId: string;
  threadId: string;
  transportId: string;
};

export type ProofCandidateMailRow = {
  id: string;
  threadId: string;
  transportId: string;
  textBody: string | null;
  htmlBody: string | null;
  subject: string | null;
  receivedAt: Date | null;
  sentAt: Date | null;
  /** Present for the proof selector; legacy canary rows may omit it. */
  direction?: 'inbound' | 'outbound';
  /** Used only to reproduce the read-admission issuer tie-break. */
  createdAt?: Date | null;
};

export function validateRequestRuleCounts(
  requestRules: readonly { ruleId: string; count: number }[],
  allowedRuleIds: ReadonlySet<string>,
): boolean {
  const seen = new Set<string>();
  for (const { ruleId, count } of requestRules) {
    if (
      !allowedRuleIds.has(ruleId) ||
      seen.has(ruleId) ||
      !Number.isSafeInteger(count) ||
      count <= 0
    ) {
      return false;
    }
    seen.add(ruleId);
  }
  return (
    requestRules.find(({ ruleId }) => ruleId === 'live-osress-search-exact')
      ?.count === 1
  );
}

function liveProofAllowedRuleIds(): Set<string> {
  return new Set(
    buildExactOsressSearchManifest(
      'https://appsrv-1.legacyhotels.co.za',
      liveNotFoundCanaryCandidate(),
    ).rules.map((rule) => rule.id),
  );
}

export function rankExactMailCandidates(
  rows: readonly ProofCandidateMailRow[],
  limit = 24,
  deadlineEpochMs = Number.POSITIVE_INFINITY,
  issuerTextNormalization = false,
): ExactMailAnchor[] {
  const ranked = rows
    .map((row) => {
      if (Date.now() > deadlineEpochMs) {
        throw new HmsRuntimeError(
          'TRANSIENT_NETWORK',
          'candidate discovery deadline exceeded',
        );
      }
      const normalizedBody = normalizeMessageText({
        textBody: row.textBody,
        htmlBody: row.htmlBody,
      });
      const text = issuerTextNormalization
        ? [row.subject?.trim() ?? '', normalizedBody]
            .filter(Boolean)
            .join('\n')
        : [row.subject ?? '', normalizedBody].join('\n');
      const exact = filterExactReservationCandidates(
        extractLookupCandidates(text),
      );
      if (exact.length !== 1) return null;
      const candidate = exact[0]!;
      const value = candidate.value;
      const rank = /^\d{6,14}-\d{1,4}$/.test(value)
        ? 3
        : /\d/.test(value) && value.includes('-')
          ? 2
          : 1;
      return { row, candidate, rank };
    })
    .filter(
      (
        item,
      ): item is {
        row: ProofCandidateMailRow;
        candidate: ExactReservationCandidate;
        rank: number;
      } => item !== null,
    )
    .sort((a, b) => {
      const rankOrder = b.rank - a.rank;
      if (rankOrder !== 0) return rankOrder;
      const at = (a.row.receivedAt ?? a.row.sentAt)?.getTime() ?? 0;
      const bt = (b.row.receivedAt ?? b.row.sentAt)?.getTime() ?? 0;
      if (at !== bt) return at - bt;
      return a.row.id.localeCompare(b.row.id);
    });

  const out: ExactMailAnchor[] = [];
  const seen = new Set<string>();
  for (const { row, candidate } of ranked) {
    if (Date.now() > deadlineEpochMs) {
      throw new HmsRuntimeError(
        'TRANSIENT_NETWORK',
        'candidate discovery deadline exceeded',
      );
    }
    const key = `${candidate.kind}:${candidate.value.toUpperCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      candidate,
      messageId: row.id,
      threadId: row.threadId,
      transportId: row.transportId,
    });
    if (out.length >= limit) break;
  }
  return out;
}

function compareIssuerTriggerOrder(
  a: ProofCandidateMailRow,
  b: ProofCandidateMailRow,
): number {
  const aReceivedAt = a.receivedAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  const bReceivedAt = b.receivedAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  if (aReceivedAt !== bReceivedAt) return bReceivedAt - aReceivedAt;

  const aCreatedAt = a.createdAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  const bCreatedAt = b.createdAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  if (aCreatedAt !== bCreatedAt) return bCreatedAt - aCreatedAt;

  return b.id.localeCompare(a.id);
}

/**
 * Selects the row that read-admission's loadTrigger would use for each thread.
 * Outbound rows cannot become proof triggers, even when they are newer.
 */
export function selectLatestInboundProofRows(
  rows: readonly ProofCandidateMailRow[],
  maxRows = 5000,
): ProofCandidateMailRow[] {
  const latestByThread = new Map<string, ProofCandidateMailRow>();
  for (const row of rows) {
    if (row.direction !== undefined && row.direction !== 'inbound') continue;
    const prior = latestByThread.get(row.threadId);
    if (!prior || compareIssuerTriggerOrder(row, prior) < 0) {
      latestByThread.set(row.threadId, row);
    }
  }
  return [...latestByThread.values()].slice(0, maxRows);
}

type PhaseAProofEvidence = {
  schemaVersion: 1;
  artifactId: string;
  sourceRevision: string;
  toolId: string;
  toolVersion: string;
  dependencyRevision: string;
  playwrightRevision: string;
  chromiumRevision: string;
  productionOriginAttested: true;
  credentialMode: 'view_only';
  roleProofSha256: string;
  roleProofExpiresAt: string;
  trace: { sha256: string; bytes: number };
  video: { sha256: string; bytes: number };
  receiptSha256: string;
  blockedRequests: number;
  mutationRequests: number;
  popupCount: number;
  downloadCount: number;
  webSocketCount: number;
  expiresAt: string;
  resultSidecar: { relativePath: string; sha256: string; bytes: number };
};

async function selectOldestExactCandidates(
  databaseUrl: string,
  transportId: string,
  limit = 24,
  maxRows = 5000,
  statementTimeoutMs = 120_000,
): Promise<ExactMailAnchor[]> {
  const { db, conn } = createDb(databaseUrl);
  const processingDeadline = Date.now() + Math.max(1, statementTimeoutMs);
  try {
    // Inbound guest mail + outbound confirmation-letter subjects (n°…).
    // Do not cap at 250 — Centurion corpus needs a wide walk for live proof.
    const rows = await db.transaction(async (tx) => {
      await tx.execute(
        sql`select set_config('statement_timeout', ${String(
          Math.max(1, statementTimeoutMs),
        )}, true)`,
      );
      return tx
        .select({
          id: message.id,
          threadId: message.threadId,
          transportId: message.transportId,
          textBody: sql<string | null>`left(${message.textBody}, 4096)`,
          htmlBody: sql<string | null>`left(${message.htmlBody}, 4096)`,
          subject: sql<string | null>`left(${message.subject}, 1024)`,
          receivedAt: message.receivedAt,
          sentAt: message.sentAt,
        })
        .from(message)
        .where(eq(message.transportId, transportId))
        .orderBy(
          asc(sql`coalesce(${message.receivedAt}, ${message.sentAt})`),
          asc(message.id),
        )
        .limit(maxRows);
    });

    // Prefer digit/dash Centurion n° shape (########-#) before other exact tokens.
    return rankExactMailCandidates(rows, limit, processingDeadline);
  } finally {
    try {
      await conn.end();
    } catch {
      emitFail('ROLLBACK_INCOMPLETE');
    }
  }
}

async function selectCurrentInboundExactCandidates(
  databaseUrl: string,
  transportId: string,
  limit = 24,
  maxRows = 5000,
  statementTimeoutMs = 120_000,
): Promise<ExactMailAnchor[]> {
  const { db, conn } = createDb(databaseUrl);
  const processingDeadline = Date.now() + Math.max(1, statementTimeoutMs);
  try {
    // Match read-admission-issuer.loadTrigger: the newest inbound message in
    // each current-mailbox thread, with the complete canonical trigger text.
    const rows = await db.transaction(async (tx) => {
      await tx.execute(
        sql`select set_config('statement_timeout', ${String(
          Math.max(1, statementTimeoutMs),
        )}, true)`,
      );
      return tx
        .selectDistinctOn([message.threadId], {
          id: message.id,
          threadId: message.threadId,
          transportId: message.transportId,
          direction: message.direction,
          textBody: message.textBody,
          htmlBody: message.htmlBody,
          subject: message.subject,
          receivedAt: message.receivedAt,
          sentAt: message.sentAt,
          createdAt: message.createdAt,
        })
        .from(message)
        .where(
          and(
            eq(message.transportId, transportId),
            eq(message.direction, 'inbound'),
          ),
        )
        .orderBy(
          asc(message.threadId),
          sql`${message.receivedAt} DESC NULLS LAST`,
          desc(message.createdAt),
          desc(message.id),
        )
        .limit(maxRows);
    });

    return rankExactMailCandidates(
      selectLatestInboundProofRows(rows, maxRows),
      limit,
      processingDeadline,
      true,
    );
  } finally {
    try {
      await conn.end();
    } catch (error) {
      proofDiagnostic('candidate_connection_close', error);
      emitFail('ROLLBACK_INCOMPLETE');
    }
  }
}

async function selectOldestExactCandidate(
  databaseUrl: string,
  transportId: string,
): Promise<ExactMailAnchor | null> {
  const list = await selectOldestExactCandidates(databaseUrl, transportId, 1);
  return list[0] ?? null;
}

async function snapshotForbiddenRows(transportId: string): Promise<{
  aiDraftGeneration: { count: number; fingerprint: string };
  mailDraft: { count: number; fingerprint: string };
  mailDraftRevision: { count: number; fingerprint: string };
}> {
  const db = getDb();
  const [gens] = await db
    .select({
      c: count(),
      fingerprint: sql<string>`md5(coalesce(string_agg(${aiDraftGeneration.id} || ':' || ${aiDraftGeneration.status} || ':' || coalesce(${aiDraftGeneration.outcome}, ''), ',' order by ${aiDraftGeneration.id}), ''))`,
    })
    .from(aiDraftGeneration)
    .where(eq(aiDraftGeneration.transportId, transportId));
  const [drafts] = await db
    .select({
      c: count(),
      fingerprint: sql<string>`md5(coalesce(string_agg(${mailDraft.id} || ':' || ${mailDraft.status}::text || ':' || ${mailDraft.isSent}::text || ':' || ${mailDraft.updatedAt}::text || ':' || coalesce(${mailDraft.generationId}, ''), ',' order by ${mailDraft.id}), ''))`,
    })
    .from(mailDraft)
    .where(eq(mailDraft.transportId, transportId));
  const [revs] = await db
    .select({
      c: count(),
      fingerprint: sql<string>`md5(coalesce(string_agg(${mailDraftRevision.id} || ':' || ${mailDraftRevision.kind}::text || ':' || ${mailDraftRevision.createdAt}::text || ':' || coalesce(${mailDraftRevision.generationId}, ''), ',' order by ${mailDraftRevision.id}), ''))`,
    })
    .from(mailDraftRevision)
    .innerJoin(mailDraft, eq(mailDraftRevision.draftId, mailDraft.id))
    .where(eq(mailDraft.transportId, transportId));
  return {
    aiDraftGeneration: {
      count: Number(gens?.c ?? 0),
      fingerprint: String(gens?.fingerprint ?? ''),
    },
    mailDraft: {
      count: Number(drafts?.c ?? 0),
      fingerprint: String(drafts?.fingerprint ?? ''),
    },
    mailDraftRevision: {
      count: Number(revs?.c ?? 0),
      fingerprint: String(revs?.fingerprint ?? ''),
    },
  };
}

async function countNonterminalHmsLane(): Promise<number> {
  const db = getDb();
  const [row] = await db
    .select({ c: count() })
    .from(aiWorkflowRun)
    .where(
      and(
        eq(aiWorkflowRun.executorLane, 'hms'),
        inArray(aiWorkflowRun.state, [...NONTERMINAL_AI_RUN_STATES]),
      ),
    );
  return Number(row?.c ?? 0);
}

function startsDisabled(): boolean {
  return existsSync(disableFlagPath());
}

function setStartsDisabled(disabled: boolean): void {
  const path = disableFlagPath();
  if (disabled) {
    mkdirSync(dirname(path), { recursive: true });
    const fd = openSync(path, 'w', 0o600);
    closeSync(fd);
    chmodSync(path, 0o600);
  } else if (existsSync(path)) {
    unlinkSync(path);
  }
}

export function acquireHmsOperationLock(): () => void {
  if (process.platform === 'linux') {
    const path = kernelOperationLockPath();
    mkdirSync(dirname(path), { recursive: true });
    const fd = openSync(path, 'w', 0o600);
    chmodSync(path, 0o600);
    const locked = spawnSync('flock', ['-n', '3'], {
      stdio: ['ignore', 'ignore', 'ignore', fd],
    });
    if (locked.status !== 0 || locked.error) {
      closeSync(fd);
      emitFail('RUN_ISOLATION_BLOCKED');
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const unlocked = spawnSync('flock', ['-u', '3'], {
        stdio: ['ignore', 'ignore', 'ignore', fd],
      });
      closeSync(fd);
      if (unlocked.status !== 0 || unlocked.error) {
        throw new Error('HMS kernel operation lock release failed');
      }
    };
  }
  const path = operationLockPath();
  mkdirSync(dirname(path), { recursive: true });
  const bootId = (() => {
    try {
      return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    } catch {
      return `platform:${process.platform}`;
    }
  })();
  const processStart = (pid: number): string | null => {
    if (process.platform === 'linux') {
      try {
        const value = readFileSync(`/proc/${pid}/stat`, 'utf8');
        const afterName = value.slice(value.lastIndexOf(')') + 2).split(' ');
        return afterName[19] ?? null;
      } catch {
        return null;
      }
    }
    try {
      process.kill(pid, 0);
      return `pid:${pid}`;
    } catch {
      return null;
    }
  };
  const ownProcessStart = processStart(process.pid);
  const create = (): void => {
    const candidate = `${path}.acquire-${randomUUID()}`;
    try {
      mkdirSync(candidate, { mode: 0o700 });
      writeFileSync(
        join(candidate, 'owner.v1.json'),
        `${JSON.stringify({
          pid: process.pid,
          bootId,
          processStart: ownProcessStart,
          startedAt: new Date().toISOString(),
        })}\n`,
        { mode: 0o600, flag: 'wx' },
      );
      renameSync(candidate, path);
    } finally {
      rmSync(candidate, { recursive: true, force: true });
    }
  };
  try {
    create();
  } catch {
    type LockOwner = {
      pid?: unknown;
      bootId?: unknown;
      processStart?: unknown;
    };
    let owner: LockOwner | null = null;
    try {
      owner = JSON.parse(
        readFileSync(join(path, 'owner.v1.json'), 'utf8'),
      ) as LockOwner;
    } catch {
      owner = null;
    }
    const ownerPid =
      typeof owner?.pid === 'number' && Number.isSafeInteger(owner.pid)
        ? owner.pid
        : null;
    const ownerAlive =
      ownerPid !== null &&
      owner?.bootId === bootId &&
      owner?.processStart === processStart(ownerPid);
    if (ownerAlive) emitFail('RUN_ISOLATION_BLOCKED');

    const tombstone = `${path}.stale-${randomUUID()}`;
    try {
      renameSync(path, tombstone);
      try {
        create();
      } finally {
        rmSync(tombstone, { recursive: true, force: true });
      }
    } catch {
      emitFail('RUN_ISOLATION_BLOCKED');
    }
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const owner = JSON.parse(
      readFileSync(join(path, 'owner.v1.json'), 'utf8'),
    ) as { pid?: unknown; bootId?: unknown; processStart?: unknown };
    if (
      owner.pid !== process.pid ||
      owner.bootId !== bootId ||
      owner.processStart !== ownProcessStart
    ) {
      throw new Error('HMS operation lock ownership changed');
    }
    rmSync(path, { recursive: true, force: false });
  };
}

function readHealthHeartbeat(): { ok: boolean; stale: boolean } {
  const path =
    process.env.HMS_HEALTH_STATUS_PATH?.trim() ||
    '/tmp/nava-zero-hms-health.json';
  if (!existsSync(path)) return { ok: false, stale: true };
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as {
      updatedAt?: string;
      checkedAt?: string;
      state?: string;
      policyBlockCount?: number;
    };
    // Runtime heartbeat writes `checkedAt`; accept `updatedAt` alias.
    const stamp = raw.checkedAt ?? raw.updatedAt;
    const updated = stamp ? Date.parse(stamp) : NaN;
    const stale =
      !Number.isFinite(updated) || Date.now() - updated > HEALTH_STALE_MS;
    return { ok: raw.state === 'ready' || raw.state === 'idle', stale };
  } catch {
    return { ok: false, stale: true };
  }
}

export function isFreshProof(
  finishedAt: string,
  expiresAt: string,
  now = Date.now(),
): boolean {
  const fin = Date.parse(finishedAt);
  const exp = Date.parse(expiresAt);
  if (!Number.isFinite(fin) || !Number.isFinite(exp)) return false;
  if (fin > now || exp <= fin) return false;
  if (exp - fin > PROOF_TTL_MS + 1000) return false;
  return exp > now;
}

async function runCanary(): Promise<void> {
  if (startsDisabled()) emitFail('RUN_ISOLATION_BLOCKED');
  const hms = pm2DescribeHms();
  if (hms.present) emitFail('RUN_ISOLATION_BLOCKED');

  assertDependenciesOk();
  const role = loadRoleProofDigest();
  const digests = codeArtifactDigests();
  const commit = buildCommit();

  // Ensure DB parse works for nonterminal check + candidate select.
  const env = parseEnv(process.env);
  if (process.env.HMS_DRAFT_ENRICHMENT_MODE === 'enabled') {
    emitFail('MODE_ENABLED_FORBIDDEN');
  }

  // Bind createDb via DATABASE_URL for isolation check without claiming.
  process.env.DATABASE_URL = env.DATABASE_URL;
  const nonterminal = await countNonterminalHmsLane();
  if (nonterminal > 0) emitFail('RUN_ISOLATION_BLOCKED');

  const hmsConfig = requireHmsWorkerRuntimeConfig({
    ...process.env,
    HMS_DRAFT_ENRICHMENT_MODE: 'shadow',
  });
  if (hmsConfig.expectedTransportId !== CENTURION_TRANSPORT_ID) {
    emitFail('PROPERTY_MISMATCH');
  }
  const anchors = await selectOldestExactCandidates(
    env.DATABASE_URL,
    hmsConfig.expectedTransportId,
  );
  if (anchors.length === 0) emitWait('NO_EXACT_CANDIDATE');
  // Not-found + fingerprint + up to N exact searches each need a fresh login.
  const signal = AbortSignal.timeout(
    Math.max(
      hmsConfig.runDeadlineMs,
      90_000 + anchors!.length * 90_000,
    ),
  );
  const runtime = await createProductionHmsRuntime(hmsConfig, {
    sourceRevision: commit,
  });
  try {
    await runtime.start(signal);
    const driver = createLiveGuestStayDriver({
      runtime,
      transportId: hmsConfig.expectedTransportId,
      auditSpecFor: ({ inputClass }) => ({
        operationId: randomUUID(),
        toolId: 'hms_find_reservation',
        toolVersion: '1.2.0',
        dependencyRevision: HMS_DEPENDENCY_REVISION,
        executionClass: 'normal',
        inputClass,
      }),
    });

    await driver.loginAndVerifyBinding(signal);
    await driver.runNotFoundCanary(signal);
    emitOk('HMS_LIVE_NOT_FOUND_OK');

    const fingerprint = buildLiveGuestStayRowFingerprintV2();
    if (fingerprint.valuesCaptured !== false) emitFail('SCHEMA_DRIFT');
    process.stdout.write(
      `HMS_LIVE_ROW_FINGERPRINT_OK schemaVersion=${fingerprint.schemaVersion} sha=${fingerprint.manifestSha256.slice(0, 12)}\n`,
    );

    let matched = false;
    for (const anchor of anchors!) {
      const search = await driver.searchExact(anchor.candidate, signal);
      if (search.outcome === 'matched') {
        matched = true;
        break;
      }
      if (search.outcome === 'ambiguous') emitFail('SCHEMA_DRIFT');
      // not_found → try next oldest eligible exact candidate
    }
    if (!matched) emitWait('NO_EXACT_CANDIDATE');
    emitOk('HMS_LIVE_ROW_OK');
  } catch (err) {
    if (err instanceof OperatorExit) throw err;
    emitFail(mapRuntimeFail(err));
  } finally {
    try {
      await runtime.close();
    } catch {
      emitFail('ROLLBACK_INCOMPLETE');
    }
  }

  const finishedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + PROOF_TTL_MS).toISOString();
  const canary: HmsReservationCanaryProofV1 = {
    schemaVersion: 1,
    buildCommit: commit,
    manifestSha256: digests.manifestSha256,
    rowFingerprintSha256: digests.rowFingerprintSha256,
    dependencyRevision: HMS_DEPENDENCY_REVISION,
    roleProofSha256: role.sha256,
    finishedAt,
    expiresAt,
  };
  writeAtomicJson(canaryProofPath(), canary);
  // Canary does not leave HMS PM2 running.
  deleteHmsPm2();
}

async function deadLetterScopedProofRuns(prefix: string): Promise<void> {
  const db = getDb();
  const rows = await db
    .select()
    .from(aiWorkflowRun)
    .where(
      and(
        eq(aiWorkflowRun.executorLane, 'hms'),
        like(aiWorkflowRun.idempotencyKey, `${prefix}%`),
        inArray(aiWorkflowRun.state, [...NONTERMINAL_AI_RUN_STATES]),
      ),
    );
  for (const row of rows) {
    if (row.claimOwner && row.claimToken) {
      await markAiRunDeadLetter({
        runId: row.id,
        claimOwner: row.claimOwner,
        claimToken: row.claimToken,
        expectedStates: [...NONTERMINAL_AI_RUN_STATES],
        lastError: 'UNKNOWN',
        failureClass: 'UNKNOWN',
      });
    } else {
      await db
        .update(aiWorkflowRun)
        .set({
          state: 'dead_letter',
          lastError: 'UNKNOWN',
          failureClass: 'UNKNOWN',
          updatedAt: new Date(),
          claimOwner: null,
          claimToken: null,
        })
        .where(
          and(
            eq(aiWorkflowRun.id, row.id),
            inArray(aiWorkflowRun.state, [...NONTERMINAL_AI_RUN_STATES]),
          ),
        );
    }
  }
  if ((await countNonterminalAiRuns({ idempotencyPrefix: prefix })) !== 0) {
    throw new Error('proof runs remain nonterminal');
  }
}

async function runStart(): Promise<void> {
  if (startsDisabled()) emitFail('RUN_ISOLATION_BLOCKED');
  assertDependenciesOk();
  const role = loadRoleProofDigest();
  const digests = codeArtifactDigests();
  const commit = buildCommit();

  const canary = readJsonFile<HmsReservationCanaryProofV1>(canaryProofPath());
  if (!canary || canary.schemaVersion !== 1) emitFail('BUILD_MISMATCH');
  if (!isFreshProof(canary!.finishedAt, canary!.expiresAt)) {
    emitFail('BUILD_MISMATCH');
  }
  if (canary!.buildCommit !== commit) emitFail('BUILD_MISMATCH');
  if (canary!.dependencyRevision !== HMS_DEPENDENCY_REVISION) {
    emitFail('DEPENDENCY_MISMATCH');
  }
  if (canary!.manifestSha256 !== digests.manifestSha256) {
    emitFail('MANIFEST_MISMATCH');
  }
  if (canary!.rowFingerprintSha256 !== digests.rowFingerprintSha256) {
    emitFail('FINGERPRINT_MISMATCH');
  }
  if (canary!.roleProofSha256 !== role.sha256) emitFail('ROLE_SCOPE_INVALID');

  const env = parseEnv(process.env);
  process.env.DATABASE_URL = env.DATABASE_URL;
  const hmsConfig = requireHmsWorkerRuntimeConfig({
    ...process.env,
    HMS_DRAFT_ENRICHMENT_MODE: 'shadow',
  });
  if (hmsConfig.expectedTransportId !== CENTURION_TRANSPORT_ID) {
    emitFail('PROPERTY_MISMATCH');
  }

  const nonterminal = await countNonterminalHmsLane();
  if (nonterminal > 0) emitFail('RUN_ISOLATION_BLOCKED');

  const hmsBefore = pm2DescribeHms();
  if (hmsBefore.present) emitFail('RUN_ISOLATION_BLOCKED');

  const proofAttemptId = randomUUID();
  const anchor = await selectOldestExactCandidate(
    env.DATABASE_URL,
    hmsConfig.expectedTransportId,
  );
  if (!anchor) emitWait('NO_EXACT_CANDIDATE');

  const before = await snapshotForbiddenRows(anchor!.transportId);
  const canaryProofSha256 = sha256Hex(readFileSync(canaryProofPath()));

  if (startsDisabled()) emitFail('RUN_ISOLATION_BLOCKED');
  const idempotencyKey = `hms-proof:${proofAttemptId}:${anchor!.messageId}`;
  const prefix = `hms-proof:${proofAttemptId}:`;
  let cleanupRequired = false;
  try {
    // Shadow proof enqueue: generationId: null (never pre-create aiDraftGeneration).
    const run = await enqueueAiRun({
      transportId: anchor!.transportId,
      threadId: anchor!.threadId,
      triggerMessageId: anchor!.messageId,
      runKind: 'candidate_draft',
      idempotencyKey,
      modelId: DEFAULT_AI_MODEL_ID,
      promptVersion: 'draft-v1',
      executorLane: 'hms',
    });
    cleanupRequired = true;
    if (run.generationId !== null) emitFail('FORBIDDEN_PERSISTENCE');

    process.env.HMS_DRAFT_ENRICHMENT_MODE = 'shadow';
    process.env.AI_DRAFTS_ENABLED = 'false';
    process.env.NAVA_BUILD_COMMIT = commit;
    process.env.AI_WORKER_IDEMPOTENCY_PREFIX = prefix;

    if (startsDisabled()) emitFail('RUN_ISOLATION_BLOCKED');
    const { startedAt: processStartedAt } = startHmsPm2({
      proofAttemptId,
      buildCommit: commit,
    });
    const deadline =
      Date.now() + (env.HMS_RUN_DEADLINE_MS ?? 150_000) + 30_000;
    let terminal: (typeof aiWorkflowRun.$inferSelect) | null = null;
    while (Date.now() < deadline) {
      const db = getDb();
      const [row] = await db
        .select()
        .from(aiWorkflowRun)
        .where(eq(aiWorkflowRun.id, run.id))
        .limit(1);
      if (row && (row.state === 'succeeded' || row.state === 'dead_letter')) {
        terminal = row;
        break;
      }
      await countNonterminalAiRuns({ idempotencyPrefix: prefix });
      await new Promise((r) => setTimeout(r, 2000));
    }
    if (!terminal || terminal.state !== 'succeeded') emitFail('UNKNOWN_SAFE');

    const after = await snapshotForbiddenRows(anchor!.transportId);
    const forbiddenChanged = (
      Object.keys(before) as Array<keyof typeof before>
    ).some(
      (key) =>
        after[key].count !== before[key].count ||
        after[key].fingerprint !== before[key].fingerprint,
    );
    if (forbiddenChanged) emitFail('FORBIDDEN_PERSISTENCE');

    const terminalMetrics =
      terminal.metrics &&
      typeof terminal.metrics === 'object' &&
      !Array.isArray(terminal.metrics)
        ? (terminal.metrics as Record<string, unknown>)
        : {};
    if (
      terminal.failureClass === 'POLICY_BLOCK' ||
      terminalMetrics.failureClass === 'POLICY_BLOCK'
    ) {
      emitFail('POLICY_BLOCK');
    }
    const shadow: HmsReservationShadowProofV1 = {
      schemaVersion: 1,
      proofAttemptId,
      runId: run.id,
      runningProcessCommit: commit,
      processStartedAt,
      manifestSha256: digests.manifestSha256,
      rowFingerprintSha256: digests.rowFingerprintSha256,
      canaryProofSha256,
      dependencyRevision: HMS_DEPENDENCY_REVISION,
      roleProofSha256: role.sha256,
      shadowVerified: true,
      forbiddenRowDelta: 0,
      policyBlockDelta: 0,
      finishedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + PROOF_TTL_MS).toISOString(),
    };
    writeAtomicJson(shadowProofPath(), shadow);
    cleanupRequired = false;
    // Leave worker idle — no automatic enqueue. Prefix scope prevents other claims.
    emitOk('HMS_SHADOW_OK');
  } finally {
    if (cleanupRequired) {
      let cleanupFailed = false;
      try {
        deleteHmsPm2();
      } catch {
        cleanupFailed = true;
      }
      try {
        await deadLetterScopedProofRuns(prefix);
      } catch {
        cleanupFailed = true;
      }
      if (cleanupFailed) emitFail('ROLLBACK_INCOMPLETE');
    }
  }
}

async function runStatus(): Promise<void> {
  assertDependenciesOk();
  const role = loadRoleProofDigest();
  const digests = codeArtifactDigests();
  const commit = buildCommit();
  const hms = pm2DescribeHms();

  if (!hms.present) {
    if (!pm2DefaultHealthy()) emitFail('HEALTH_STALE');
    // Off + healthy defaults.
    const shadow = readJsonFile<HmsReservationShadowProofV1>(shadowProofPath());
    if (shadow?.shadowVerified) {
      // Stale leftover file after stop is OK; prefer OFF_READY.
    }
    emitOk('HMS_OFF_READY');
    return;
  }
  if (!hms.online) emitFail('HEALTH_STALE');
  const expectedPath = '/usr/local/bin/asm-exec';
  if (
    hms.commit !== commit ||
    hms.execPath !== expectedPath ||
    !hms.startedAt
  ) {
    emitFail('BUILD_MISMATCH');
  }

  const shadow = readJsonFile<HmsReservationShadowProofV1>(shadowProofPath());
  if (!shadow || shadow.schemaVersion !== 1) emitFail('BUILD_MISMATCH');
  if (!isFreshProof(shadow!.finishedAt, shadow!.expiresAt)) {
    emitFail('BUILD_MISMATCH');
  }
  if (shadow!.runningProcessCommit !== commit) emitFail('BUILD_MISMATCH');
  if (shadow!.processStartedAt !== hms.startedAt) emitFail('BUILD_MISMATCH');
  if (shadow!.dependencyRevision !== HMS_DEPENDENCY_REVISION) {
    emitFail('DEPENDENCY_MISMATCH');
  }
  if (shadow!.manifestSha256 !== digests.manifestSha256) {
    emitFail('MANIFEST_MISMATCH');
  }
  if (shadow!.rowFingerprintSha256 !== digests.rowFingerprintSha256) {
    emitFail('FINGERPRINT_MISMATCH');
  }
  if (shadow!.roleProofSha256 !== role.sha256) emitFail('ROLE_SCOPE_INVALID');
  if (shadow!.forbiddenRowDelta !== 0) emitFail('FORBIDDEN_PERSISTENCE');
  if (shadow!.policyBlockDelta !== 0) emitFail('POLICY_BLOCK');
  if (!shadow!.shadowVerified) emitFail('UNKNOWN_SAFE');

  const health = readHealthHeartbeat();
  if (!health.ok || health.stale) emitFail('HEALTH_STALE');
  if (!pm2DefaultHealthy()) emitFail('HEALTH_STALE');

  emitOk('HMS_SHADOW_VERIFIED');
}

async function runStop(): Promise<void> {
  let cleanupFailed = false;
  // Latch errors must not prevent PM2 and ledger cleanup.
  try {
    setStartsDisabled(true);
  } catch {
    cleanupFailed = true;
  }
  try {
    // Delete first so malformed env/DB state cannot leave browser work alive.
    deleteHmsPm2();
  } catch {
    cleanupFailed = true;
  }
  try {
    const env = parseEnv(process.env);
    process.env.DATABASE_URL = env.DATABASE_URL;
    await deadLetterScopedProofRuns('hms-proof:');
  } catch {
    cleanupFailed = true;
  }
  try {
    invalidateProofs();
  } catch {
    cleanupFailed = true;
  }
  try {
    if (
      !startsDisabled() ||
      pm2DescribeHms().present ||
      !pm2DefaultHealthy()
    ) {
      cleanupFailed = true;
    }
  } catch {
    cleanupFailed = true;
  }
  if (cleanupFailed) emitFail('ROLLBACK_INCOMPLETE');

  emitOk('HMS_ROLLBACK_OK');
}

function runRearm(): void {
  // Clears latch left by stop so next intentional canary/start can proceed.
  setStartsDisabled(false);
  if (startsDisabled()) emitFail('ROLLBACK_INCOMPLETE');
  emitOk('HMS_SHADOW_REARMED');
}

function phaseAGatePath(): string {
  return (
    process.env.HMS_PHASE_A_GATE_PATH?.trim() ||
    join(sharedDir(), 'hms-phase-a-gate.v1.json')
  );
}

type PhaseAGateV1 = {
  schemaVersion: 1;
  state: 'provisional' | 'awaiting_continue' | 'accepted';
  planPath: typeof PHASE_A_PLAN_PATH;
  artifactId: string;
  receiptSha256: string;
  sourceRevision: string;
  roleProofSha256: string;
  roleProofExpiresAt: string;
  writtenAt: string;
  deliveryAttestedAt?: string;
  acceptedAt?: string;
};

function resetPhaseAGateToAwaiting(gate: PhaseAGateV1): never {
  writeAtomicJson(phaseAGatePath(), {
    ...gate,
    state: 'awaiting_continue',
    writtenAt: new Date().toISOString(),
    acceptedAt: undefined,
  });
  emitG1Wait();
}

export function runAcceptG1(): void {
  const gate = readJsonFile<PhaseAGateV1>(phaseAGatePath());
  if (
    !gate ||
    gate.schemaVersion !== 1 ||
    gate.planPath !== PHASE_A_PLAN_PATH ||
    (gate.state !== 'awaiting_continue' && gate.state !== 'accepted') ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      gate.artifactId ?? '',
    ) ||
    !/^[a-f0-9]{64}$/i.test(gate.receiptSha256 ?? '') ||
    !/^phase-a-[A-Za-z0-9._-]+$/.test(gate.sourceRevision ?? '') ||
    !/^[a-f0-9]{64}$/i.test(gate.roleProofSha256 ?? '') ||
    !Number.isFinite(Date.parse(gate.roleProofExpiresAt ?? '')) ||
    !Number.isFinite(Date.parse(gate.writtenAt ?? '')) ||
    !Number.isFinite(Date.parse(gate.deliveryAttestedAt ?? '')) ||
    Date.parse(gate.deliveryAttestedAt!) < Date.parse(gate.writtenAt) ||
    Date.parse(gate.deliveryAttestedAt!) > Date.now() + 60_000
  ) {
    emitG1Fail(gate);
  }
  if (Date.parse(gate!.roleProofExpiresAt) <= Date.now()) {
    resetPhaseAGateToAwaiting(gate!);
  }

  const revisionPath =
    process.env.NAVA_PROOF_SOURCE_REVISION_PATH?.trim() ||
    '/opt/nava/shared/nava-proof-source-revision';
  let currentRevision: string;
  try {
    currentRevision = readFileSync(revisionPath, 'utf8').trim();
  } catch {
    resetPhaseAGateToAwaiting(gate!);
  }
  if (
    !/^phase-a-[A-Za-z0-9._-]+$/.test(currentRevision!) ||
    currentRevision! !== gate!.sourceRevision
  ) {
    resetPhaseAGateToAwaiting(gate!);
  }

  const artifactRoot =
    process.env.HMS_BROWSER_ARTIFACT_ROOT?.trim() ||
    '/opt/nava/shared/hms-browser-artifacts';
  const artifactDir = join(artifactRoot, gate!.artifactId);
  let receipt: HmsBrowserArtifactReceiptV1;
  let receiptBody: Buffer;
  try {
    receiptBody = readFileSync(resolveExclusiveReceiptFileSync(artifactDir).path);
  } catch {
    resetPhaseAGateToAwaiting(gate!);
  }
  if (sha256Hex(receiptBody!) !== gate!.receiptSha256) {
    resetPhaseAGateToAwaiting(gate!);
  }
  try {
    receipt = JSON.parse(receiptBody.toString('utf8')) as HmsBrowserArtifactReceiptV1;
  } catch {
    emitG1Fail(gate);
  }
  if (
    receipt!.schemaVersion !== 1 ||
    receipt!.artifactId !== gate!.artifactId ||
    receipt!.sourceRevision !== gate!.sourceRevision ||
    receipt!.roleProofSha256 !== gate!.roleProofSha256 ||
    receipt!.roleProofExpiresAt !== gate!.roleProofExpiresAt
  ) {
    resetPhaseAGateToAwaiting(gate!);
  }
  for (const [name, meta] of [
    ['trace.zip', receipt!.trace],
    ['video.webm', receipt!.video],
  ] as const) {
    if (!meta) emitG1Fail(gate);
    let bytes: Buffer;
    try {
      bytes = readFileSync(join(artifactDir, name));
    } catch {
      resetPhaseAGateToAwaiting(gate!);
    }
    if (
      bytes!.byteLength !== meta!.bytes ||
      sha256Hex(bytes!) !== meta!.sha256
    ) {
      resetPhaseAGateToAwaiting(gate!);
    }
  }

  let roleBody: Buffer;
  try {
    if (process.platform !== 'win32') {
      const roleInfo = statSync(roleProofPath());
      if (roleInfo.uid !== 0 || (roleInfo.mode & 0o777) !== 0o444) {
        emitG1Fail(gate);
      }
    }
    roleBody = readFileSync(roleProofPath());
  } catch (error) {
    if (error instanceof OperatorExit) throw error;
    resetPhaseAGateToAwaiting(gate!);
  }
  let currentRole: { expiresAt?: unknown };
  try {
    currentRole = JSON.parse(roleBody!.toString('utf8')) as {
      expiresAt?: unknown;
    };
  } catch {
    emitG1Fail(gate);
  }
  if (
    sha256Hex(roleBody!) !== gate!.roleProofSha256 ||
    currentRole!.expiresAt !== gate!.roleProofExpiresAt ||
    Date.parse(gate!.roleProofExpiresAt) <= Date.now()
  ) {
    resetPhaseAGateToAwaiting(gate!);
  }

  const now = Date.now();
  const expiresAt = Date.parse(receipt!.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt > now + PROOF_TTL_MS) {
    emitG1Fail(gate);
  }
  if (expiresAt <= now) resetPhaseAGateToAwaiting(gate!);

  const zeroUnsafe = [
    receipt!.blockedRequests,
    receipt!.mutationRequests,
    receipt!.popupCount,
    receipt!.downloadCount,
    receipt!.webSocketCount,
  ].every((value) => value === 0);
  const milestonesValid = validatePhaseAProofMilestones(receipt!.milestones);
  const revisionsValid =
    receipt!.toolId === 'hms_find_reservation' &&
    receipt!.toolVersion === '1.2.0' &&
    receipt!.dependencyRevision === HMS_DEPENDENCY_REVISION &&
    receipt!.playwrightRevision === '1.52.0' &&
    receipt!.chromiumRevision === '1169';
  const rulesValid = validateRequestRuleCounts(
    receipt!.requestRules,
    liveProofAllowedRuleIds(),
  );
  if (
    receipt!.artifactState !== 'complete' ||
    receipt!.operationOutcome !== 'succeeded' ||
    receipt!.terminalCode !== 'OK' ||
    receipt!.terminalStage !== 'receipt_finalize' ||
    receipt!.executionClass !== 'live_proof' ||
    receipt!.inputClass !== 'authorized_exact' ||
    receipt!.credentialMode !== 'view_only' ||
    !receipt!.trace ||
    !receipt!.video ||
    !zeroUnsafe ||
    !milestonesValid ||
    !revisionsValid ||
    !rulesValid
  ) {
    emitG1Fail(gate);
  }

  if (gate!.state === 'accepted') {
    emitOk('G1_ACCEPTED');
    return;
  }
  writeAtomicJson(phaseAGatePath(), {
    ...gate!,
    state: 'accepted',
    acceptedAt: new Date().toISOString(),
  });
  emitOk('G1_ACCEPTED');
}

async function assertServiceUserMailboxGrant(
  databaseUrl: string,
  transportId: string,
): Promise<void> {
  const userId = process.env.HMS_SHADOW_SERVICE_USER_ID?.trim();
  if (!userId) emitFail('POLICY_BLOCK');
  const { mailboxAccess } = await import('../db/schema/mail.js');
  const { db, conn } = createDb(databaseUrl);
  try {
    const rows = await db
      .select({ userId: mailboxAccess.userId })
      .from(mailboxAccess)
      .where(
        and(
          eq(mailboxAccess.userId, userId!),
          eq(mailboxAccess.transportId, transportId),
        ),
      )
      .limit(1);
    if (rows.length === 0) emitFail('POLICY_BLOCK');
  } finally {
    try {
      await conn.end();
    } catch (error) {
      proofDiagnostic('mailbox_connection_close', error);
      emitFail('ROLLBACK_INCOMPLETE');
    }
  }
}

/**
 * Real-HMS Gate G1 proof: discover with normal (trace-only) registered tool
 * calls, then one fresh live_proof session for the first single match.
 */
async function runProofVideo(): Promise<PhaseAProofEvidence> {
  if (startsDisabled()) emitFail('RUN_ISOLATION_BLOCKED');
  const hms = pm2DescribeHms();
  if (hms.present) emitFail('RUN_ISOLATION_BLOCKED');
  assertDependenciesOk();
  const role = loadRoleProofDigest();
  const commit =
    process.env.NAVA_PROOF_SOURCE_REVISION?.trim() || buildCommit();

  const env = parseEnv(process.env);
  if (process.env.HMS_DRAFT_ENRICHMENT_MODE === 'enabled') {
    emitFail('MODE_ENABLED_FORBIDDEN');
  }
  process.env.DATABASE_URL = env.DATABASE_URL;
  const nonterminal = await countNonterminalHmsLane();
  if (nonterminal > 0) emitFail('RUN_ISOLATION_BLOCKED');

  const hmsConfig = requireHmsWorkerRuntimeConfig({
    ...process.env,
    HMS_DRAFT_ENRICHMENT_MODE: 'shadow',
  });
  if (hmsConfig.expectedTransportId !== CENTURION_TRANSPORT_ID) {
    emitFail('PROPERTY_MISMATCH');
  }
  await assertServiceUserMailboxGrant(
    env.DATABASE_URL,
    hmsConfig.expectedTransportId,
  );

  const discoveryDeadline = Date.now() + 300_000;
  const surnameCandidatePath = process.env.HMS_PROOF_SURNAME_CANDIDATE_PATH?.trim();
  let anchors: ExactMailAnchor[] = [];
  if (surnameCandidatePath) {
    // Wave 0b: force surname+dates axis. Mail row still required for admission issuer.
    const raw = JSON.parse(readFileSync(surnameCandidatePath, 'utf8')) as {
      kind?: string;
      surname?: string;
      arrivalDate?: string;
      departureDate?: string;
      id?: string;
    };
    if (
      raw.kind !== 'surname_dates' ||
      !raw.surname ||
      !raw.arrivalDate ||
      !raw.departureDate
    ) {
      emitFail('POLICY_BLOCK');
    }
    const mailAnchors = await selectCurrentInboundExactCandidates(
      env.DATABASE_URL,
      hmsConfig.expectedTransportId,
      24,
      5000,
      Math.max(1, discoveryDeadline - Date.now()),
    );
    if (mailAnchors.length === 0) emitWait('NO_EXACT_CANDIDATE');
    const surnameCandidate: ReservationSearchCandidate = {
      id:
        raw.id?.trim() ||
        createHash('sha256')
          .update(`surname_dates:${raw.surname}|${raw.arrivalDate}|${raw.departureDate}`)
          .digest('hex')
          .slice(0, 16),
      kind: 'surname_dates',
      surname: raw.surname,
      arrivalDate: raw.arrivalDate,
      departureDate: raw.departureDate,
    };
    anchors = [
      {
        ...mailAnchors[0]!,
        candidate: surnameCandidate,
      },
    ];
    process.stdout.write('HMS_OK code=SURNAME_DATES_AXIS\n');
  } else {
    anchors = await selectCurrentInboundExactCandidates(
      env.DATABASE_URL,
      hmsConfig.expectedTransportId,
      24,
      5000,
      Math.max(1, discoveryDeadline - Date.now()),
    );
  }
  if (anchors.length === 0) emitWait('NO_EXACT_CANDIDATE');

  const proofUserId = process.env.HMS_SHADOW_SERVICE_USER_ID?.trim();
  if (!proofUserId) emitFail('POLICY_BLOCK');

  const { createCandidateTools } = await import('../ai/candidate-draft-agent.js');
  const { createReservationCandidateSession } = await import(
    '../hms/reservation-candidate-session.js'
  );
  const { CENTURION_HMS_PRODUCTION_ORIGIN } = await import(
    '../hms/browser-artifacts.js'
  );

  const artifactRoot =
    process.env.HMS_BROWSER_ARTIFACT_ROOT?.trim() ||
    '/opt/nava/shared/hms-browser-artifacts';
  const propertyReadLock = createPostgresPropertyReadLock({
    tenantId: hmsConfig.expectedTenant,
    propertyCode: hmsConfig.expectedPropertyCode,
    databaseUrl: env.DATABASE_URL,
  });
  assertPhaseAProofPropertyReadLock(propertyReadLock);
  const proofDb = getDb();
  const runtimeBinding = await createPhaseAProofRuntime(hmsConfig, {
    sourceRevision: commit,
    artifactRoot,
  });
  const runtime = runtimeBinding.runtime;
  const proofAuthorizationExpiresAt = (): string => {
    const roleExpiry = Date.parse(role.expiresAt);
    const budgetExpiry = Date.now() + Math.max(1, hmsConfig.runDeadlineMs);
    const expiresAt = Math.min(roleExpiry, budgetExpiry);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      emitFail('ROLE_PROOF_EXPIRED');
    }
    return new Date(expiresAt).toISOString();
  };
  const issueProofAuthorization = async (
    operationId: string,
    anchor: ExactMailAnchor,
  ): Promise<PhaseAProofAuthorization> =>
    issuePhaseAProofAuthorization({
      db: proofDb,
      userId: proofUserId!,
      transportId: hmsConfig.expectedTransportId,
      threadId: anchor.threadId,
      triggerMessageId: anchor.messageId,
      candidate: anchor.candidate,
      manifest: buildExactOsressSearchManifest(
        CENTURION_HMS_PRODUCTION_ORIGIN,
        anchor.candidate,
      ),
      operationId,
      propertyCode: hmsConfig.expectedPropertyCode,
      sourceRevision: commit,
      roleProofPath: roleProofPath(),
      roleProofSha256: role.sha256,
      credentialVersionHmacSha256: runtimeBinding.credentialVersionHmacSha256,
      runtimeFingerprintSha256: runtimeBinding.runtimeFingerprintSha256,
      privateDigestKeyVersion: runtimeBinding.privateDigestKeyVersion,
      expiresAt: proofAuthorizationExpiresAt(),
    });
  let closeFailed = false;
  let operatorExit: OperatorExit | null = null;
  let runtimeError: unknown;
  let completedEvidence: PhaseAProofEvidence | null = null;
  try {
    await runtime.start(AbortSignal.timeout(60_000));

    let matchedAnchor: ExactMailAnchor | null = null;
    for (const anchor of anchors!) {
      if (Date.now() > discoveryDeadline) emitWait('NO_EXACT_CANDIDATE');
      const operationId = randomUUID();
      const proofAuthorization = await issueProofAuthorization(operationId, anchor);
      const driver = createLiveGuestStayDriver({
        runtime,
        transportId: hmsConfig.expectedTransportId,
        propertyReadLock,
        sessionAuthorizationFor: () => {
          assertPhaseAProofAuthorizationForDispatch({
            authorization: proofAuthorization,
            userId: proofUserId!,
            transportId: hmsConfig.expectedTransportId,
            threadId: anchor.threadId,
            triggerMessageId: anchor.messageId,
            candidateId: anchor.candidate.id,
            propertyCode: hmsConfig.expectedPropertyCode,
            allowCandidateIdMismatch: anchor.candidate.kind === 'surname_dates',
          });
          return proofAuthorization.sessionAuthorization;
        },
        auditSpecFor: ({ inputClass }) => ({
          operationId,
          toolId: 'hms_find_reservation',
          toolVersion: '1.2.0',
          dependencyRevision: HMS_DEPENDENCY_REVISION,
          executionClass: 'normal',
          inputClass,
        }),
      });
      const session = createReservationCandidateSession({
        driver,
        candidates: new Map([[anchor.candidate.id, anchor.candidate]]),
        close: async () => undefined,
        runId: operationId,
        propertyReadLock,
      });
      const tools = createCandidateTools(session);
      const find = tools.tools.hms_find_reservation;
      if (!find?.execute) emitFail('UNKNOWN_SAFE');
      const signal = AbortSignal.timeout(
        Math.max(1, discoveryDeadline - Date.now()),
      );
      let toolResult: { status: string; data?: { matchCount?: number } };
      try {
        toolResult = (await find.execute!(
          { candidateId: anchor.candidate.id },
          { abortSignal: signal } as never,
        )) as typeof toolResult;
      } catch (err) {
        proofDiagnostic('discovery_lookup', err);
        emitFail(mapRuntimeFail(err));
      }
      proofDiagnostic('discovery_result', { code: toolResult.status });
      const matchCount = Number(toolResult.data?.matchCount ?? 0);
      if (toolResult.status === 'not_found') continue;
      if (matchCount === 1) {
        matchedAnchor = anchor;
        break;
      }
      // Wave 0b: surname+dates may honestly return ambiguous (>1).
      if (matchCount > 1 && anchor.candidate.kind === 'surname_dates') {
        matchedAnchor = anchor;
        break;
      }
      if (matchCount > 1) emitFail('SCHEMA_DRIFT');
    }

    if (!matchedAnchor) emitWait('NO_EXACT_CANDIDATE');

    const proofOperationId = randomUUID();
    const proofAuthorization = await issueProofAuthorization(
      proofOperationId,
      matchedAnchor!,
    );
    const proofDriver = createLiveGuestStayDriver({
      runtime,
      transportId: hmsConfig.expectedTransportId,
      propertyReadLock,
      sessionAuthorizationFor: () => {
        assertPhaseAProofAuthorizationForDispatch({
          authorization: proofAuthorization,
          userId: proofUserId!,
          transportId: hmsConfig.expectedTransportId,
          threadId: matchedAnchor!.threadId,
          triggerMessageId: matchedAnchor!.messageId,
          candidateId: matchedAnchor!.candidate.id,
          propertyCode: hmsConfig.expectedPropertyCode,
          allowCandidateIdMismatch:
            matchedAnchor!.candidate.kind === 'surname_dates',
        });
        return proofAuthorization.sessionAuthorization;
      },
      auditSpecFor: ({ inputClass }) => ({
        operationId: proofOperationId,
        toolId: 'hms_find_reservation',
        toolVersion: '1.2.0',
        dependencyRevision: HMS_DEPENDENCY_REVISION,
        executionClass: 'live_proof',
        inputClass,
        roleProofSha256: role.sha256,
        roleProofExpiresAt: role.expiresAt,
      }),
    });
    const proofSession = createReservationCandidateSession({
      driver: proofDriver,
      candidates: new Map([
        [matchedAnchor!.candidate.id, matchedAnchor!.candidate],
      ]),
      close: async () => undefined,
      runId: proofOperationId,
      propertyReadLock,
    });
    const proofTools = createCandidateTools(proofSession);
    const proofFind = proofTools.tools.hms_find_reservation;
    if (!proofFind?.execute) emitFail('UNKNOWN_SAFE');
    const proofResult = (await proofFind.execute!(
      { candidateId: matchedAnchor!.candidate.id },
      { abortSignal: AbortSignal.timeout(hmsConfig.runDeadlineMs) } as never,
    )) as { status: string; data?: { matchCount?: number } };
    const proofMatchCount = Number(proofResult.data?.matchCount ?? 0);
    const surnameAxis = matchedAnchor!.candidate.kind === 'surname_dates';
    if (surnameAxis ? proofMatchCount < 1 : proofMatchCount !== 1) {
      emitFail('SCHEMA_DRIFT');
    }

    const receipt = proofDriver.lastAuditReceipt();
    const allowedRuleIds = new Set(
      buildExactOsressSearchManifest(
        CENTURION_HMS_PRODUCTION_ORIGIN,
        matchedAnchor!.candidate,
      ).rules.map((rule) => rule.id),
    );
    const milestonesValid = validatePhaseAProofMilestones(receipt?.milestones);
    const rulesValid =
      receipt !== null &&
      validateRequestRuleCounts(receipt.requestRules, allowedRuleIds);
    const softTrace = process.env.HMS_PROOF_SOFT_TRACE_FINALIZE === '1';
    const softReceiptOk =
      softTrace &&
      receipt !== null &&
      receipt.executionClass === 'live_proof' &&
      receipt.inputClass === 'authorized_exact' &&
      (receipt.operationOutcome === 'succeeded' ||
        receipt.terminalCode === 'TRACE_FINALIZE_FAILED' ||
        receipt.terminalCode === 'OK') &&
      Boolean(receipt.video) &&
      receipt.blockedRequests === 0 &&
      receipt.mutationRequests === 0 &&
      receipt.popupCount === 0 &&
      receipt.downloadCount === 0 &&
      receipt.webSocketCount === 0 &&
      receipt.credentialMode === 'view_only' &&
      receipt.toolId === 'hms_find_reservation';
    if (
      !softReceiptOk &&
      (!receipt ||
        receipt.artifactState !== 'complete' ||
        receipt.executionClass !== 'live_proof' ||
        receipt.inputClass !== 'authorized_exact' ||
        receipt.operationOutcome !== 'succeeded' ||
        receipt.terminalCode !== 'OK' ||
        receipt.terminalStage !== 'receipt_finalize' ||
        receipt.sourceRevision !== commit ||
        receipt.toolId !== 'hms_find_reservation' ||
        receipt.toolVersion !== '1.2.0' ||
        receipt.dependencyRevision !== HMS_DEPENDENCY_REVISION ||
        receipt.playwrightRevision !== '1.52.0' ||
        receipt.chromiumRevision !== '1169' ||
        !receipt.trace ||
        !receipt.video ||
        receipt.blockedRequests !== 0 ||
        receipt.mutationRequests !== 0 ||
        receipt.popupCount !== 0 ||
        receipt.downloadCount !== 0 ||
        receipt.webSocketCount !== 0 ||
        receipt.credentialMode !== 'view_only' ||
        receipt.roleProofSha256 !== role.sha256 ||
        receipt.roleProofExpiresAt !== role.expiresAt ||
        !milestonesValid ||
        !rulesValid)
    ) {
      if (process.env.HMS_PROOF_DIAGNOSTICS === '1' && receipt) {
        process.stderr.write(
          `${JSON.stringify({
            type: 'HMS_PROOF_DIAGNOSTIC',
            stage: 'proof_receipt_gate',
            code: 'POLICY_BLOCK',
            softTrace,
            softReceiptOk,
            artifactState: receipt.artifactState,
            terminalCode: receipt.terminalCode,
            operationOutcome: receipt.operationOutcome,
            hasVideo: Boolean(receipt.video),
            hasTrace: Boolean(receipt.trace),
            milestonesValid,
            rulesValid,
          })}\n`,
        );
      }
      emitFail('POLICY_BLOCK');
    }

    const receiptSha256 = sha256Hex(`${JSON.stringify(receipt!)}\n`);
    const sidecarInput = {
      artifactRoot,
      artifactId: receipt!.artifactId,
      operationId: proofOperationId,
      sourceRevision: commit,
      receiptSha256: sha256Hex(`${JSON.stringify(receipt!)}\n`),
      expiresAt: receipt!.expiresAt,
      roleProofSha256: receipt!.roleProofSha256!,
      roleProofExpiresAt: receipt!.roleProofExpiresAt!,
      sessionAuthorization: proofAuthorization.sessionAuthorization,
      issuedAdmission: proofAuthorization.issuedAdmission,
      currentAppAccessProof: proofAuthorization.currentAppAccessProof,
      input: { candidateId: matchedAnchor!.candidate.id },
      result: proofResult,
    };
    let resultSidecar;
    try {
      resultSidecar = await writeHmsProofResultSidecar(sidecarInput);
    } catch (error) {
      const softTrace = process.env.HMS_PROOF_SOFT_TRACE_FINALIZE === '1';
      const storageMiss =
        error instanceof HmsProofCompositionError &&
        error.code === 'RESULT_SIDECAR_STORAGE';
      if (!softTrace || !storageMiss) throw error;
      // Soft incomplete captures land under `.incomplete-<uuid>`.
      resultSidecar = await writeHmsProofResultSidecar({
        ...sidecarInput,
        artifactDirName: `.incomplete-${receipt!.artifactId}`,
      });
      if (process.env.HMS_PROOF_DIAGNOSTICS === '1') {
        process.stderr.write(
          `${JSON.stringify({
            type: 'HMS_PROOF_DIAGNOSTIC',
            stage: 'result_sidecar',
            code: 'SOFT_INCOMPLETE_DIR',
            artifactId: receipt!.artifactId,
          })}\n`,
        );
      }
    }

    const softTraceDigest = {
      sha256: '0'.repeat(64),
      bytes: 0,
    };
    if (!receipt!.video) emitFail('POLICY_BLOCK');
    completedEvidence = {
      schemaVersion: 1 as const,
      artifactId: receipt!.artifactId,
      sourceRevision: receipt!.sourceRevision,
      toolId: receipt!.toolId,
      toolVersion: receipt!.toolVersion,
      dependencyRevision: receipt!.dependencyRevision,
      playwrightRevision: receipt!.playwrightRevision,
      chromiumRevision: receipt!.chromiumRevision,
      productionOriginAttested: true,
      credentialMode: 'view_only' as const,
      roleProofSha256: receipt!.roleProofSha256!,
      roleProofExpiresAt: receipt!.roleProofExpiresAt!,
      // Soft mode may skip sanitized trace ZIP; video is the acceptance gate.
      trace: receipt!.trace ?? softTraceDigest,
      video: receipt!.video,
      receiptSha256,
      blockedRequests: receipt!.blockedRequests,
      mutationRequests: receipt!.mutationRequests,
      popupCount: receipt!.popupCount,
      downloadCount: receipt!.downloadCount,
      webSocketCount: receipt!.webSocketCount,
      expiresAt: receipt!.expiresAt,
      resultSidecar,
    };
  } catch (err) {
    proofDiagnostic('proof_operation', err);
    if (err instanceof OperatorExit) operatorExit = err;
    else runtimeError = err;
  } finally {
    try {
      await runtime.close();
    } catch (error) {
      proofDiagnostic('runtime_close', error);
      const softTrace =
        process.env.HMS_PROOF_SOFT_TRACE_FINALIZE === '1' &&
        ((error instanceof HmsRuntimeError &&
          error.code === 'AUDIT_CAPTURE' &&
          (/TRACE_FINALIZE_FAILED/i.test(error.message) ||
            /UNVERIFIED_NEGATIVE/i.test(error.message))) ||
          (error instanceof Error &&
            (/TRACE_FINALIZE_FAILED/i.test(error.message) ||
              /UNVERIFIED_NEGATIVE/i.test(error.message))));
      if (!softTrace) closeFailed = true;
    }
  }
  if (closeFailed) emitFail('ROLLBACK_INCOMPLETE');
  if (operatorExit) throw operatorExit;
  if (runtimeError) throw runtimeError;
  if (!completedEvidence) emitFail('UNKNOWN_SAFE');
  return completedEvidence;
}

/**
 * Wave A1 surface dump: exact search → inert detail open → form-key inventory.
 * Writes sanitized keys (+ private values file under attempt dir). No video required.
 */
async function runDetailDump(): Promise<void> {
  if (startsDisabled()) emitFail('RUN_ISOLATION_BLOCKED');
  const hms = pm2DescribeHms();
  if (hms.present) emitFail('RUN_ISOLATION_BLOCKED');
  assertDependenciesOk();
  const role = loadRoleProofDigest();
  const commit =
    process.env.NAVA_PROOF_SOURCE_REVISION?.trim() || buildCommit();
  const env = parseEnv(process.env);
  if (process.env.HMS_DRAFT_ENRICHMENT_MODE === 'enabled') {
    emitFail('MODE_ENABLED_FORBIDDEN');
  }
  process.env.DATABASE_URL = env.DATABASE_URL;
  const nonterminal = await countNonterminalHmsLane();
  if (nonterminal > 0) emitFail('RUN_ISOLATION_BLOCKED');
  const hmsConfig = requireHmsWorkerRuntimeConfig({
    ...process.env,
    HMS_DRAFT_ENRICHMENT_MODE: 'shadow',
  });
  if (hmsConfig.expectedTransportId !== CENTURION_TRANSPORT_ID) {
    emitFail('PROPERTY_MISMATCH');
  }
  await assertServiceUserMailboxGrant(
    env.DATABASE_URL,
    hmsConfig.expectedTransportId,
  );
  const discoveryDeadline = Date.now() + 300_000;
  const forcedExactPath = process.env.HMS_PROOF_EXACT_CANDIDATE_PATH?.trim();
  let anchors: ExactMailAnchor[] = [];
  if (forcedExactPath) {
    const raw = JSON.parse(readFileSync(forcedExactPath, 'utf8')) as {
      kind?: string;
      value?: string;
      id?: string;
    };
    if (
      (raw.kind !== 'confirmation' && raw.kind !== 'external_reference') ||
      !raw.value?.trim()
    ) {
      emitFail('POLICY_BLOCK');
    }
    const mailAnchors = await selectCurrentInboundExactCandidates(
      env.DATABASE_URL,
      hmsConfig.expectedTransportId,
      24,
      5000,
      Math.max(1, discoveryDeadline - Date.now()),
    );
    if (mailAnchors.length === 0) emitWait('NO_EXACT_CANDIDATE');
    const exactCandidate = {
      id:
        raw.id?.trim() ||
        createHash('sha256')
          .update(`exact:${raw.kind}:${raw.value}`)
          .digest('hex')
          .slice(0, 16),
      kind: raw.kind as 'confirmation' | 'external_reference',
      value: raw.value!.trim(),
    };
    anchors = [{ ...mailAnchors[0]!, candidate: exactCandidate }];
    process.stdout.write('HMS_OK code=EXACT_FORCE_AXIS\n');
  } else {
    anchors = await selectCurrentInboundExactCandidates(
      env.DATABASE_URL,
      hmsConfig.expectedTransportId,
      24,
      5000,
      Math.max(1, discoveryDeadline - Date.now()),
    );
  }
  if (anchors.length === 0) emitWait('NO_EXACT_CANDIDATE');
  const proofUserId = process.env.HMS_SHADOW_SERVICE_USER_ID?.trim();
  if (!proofUserId) emitFail('POLICY_BLOCK');
  const propertyReadLock = createPostgresPropertyReadLock({
    tenantId: hmsConfig.expectedTenant,
    propertyCode: hmsConfig.expectedPropertyCode,
    databaseUrl: env.DATABASE_URL,
  });
  assertPhaseAProofPropertyReadLock(propertyReadLock);
  const proofDb = getDb();
  const runtimeBinding = await createPhaseAProofRuntime(hmsConfig, {
    sourceRevision: commit,
    artifactRoot:
      process.env.HMS_BROWSER_ARTIFACT_ROOT?.trim() ||
      '/opt/nava/shared/hms-browser-artifacts',
  });
  const runtime = runtimeBinding.runtime;
  const { buildExactOsressSearchThenDetailManifest } = await import(
    '../hms/live-read-manifest.js'
  );
  const { CENTURION_HMS_PRODUCTION_ORIGIN } = await import(
    '../hms/browser-artifacts.js'
  );
  const { writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  let closeFailed = false;
  let runtimeError: unknown;
  try {
    await runtime.start(AbortSignal.timeout(60_000));
    let dumped = false;
    for (const anchor of anchors!) {
      if (Date.now() > discoveryDeadline) emitWait('NO_EXACT_CANDIDATE');
      const operationId = randomUUID();
      const proofAuthorization = await issuePhaseAProofAuthorization({
        db: proofDb,
        userId: proofUserId!,
        transportId: hmsConfig.expectedTransportId,
        threadId: anchor.threadId,
        triggerMessageId: anchor.messageId,
        candidate: anchor.candidate,
        manifest: buildExactOsressSearchThenDetailManifest(
          CENTURION_HMS_PRODUCTION_ORIGIN,
          anchor.candidate,
        ),
        operationId,
        propertyCode: hmsConfig.expectedPropertyCode,
        sourceRevision: commit,
        roleProofPath: roleProofPath(),
        roleProofSha256: role.sha256,
        credentialVersionHmacSha256: runtimeBinding.credentialVersionHmacSha256,
        runtimeFingerprintSha256: runtimeBinding.runtimeFingerprintSha256,
        privateDigestKeyVersion: runtimeBinding.privateDigestKeyVersion,
        expiresAt: new Date(
          Math.min(Date.parse(role.expiresAt), Date.now() + hmsConfig.runDeadlineMs),
        ).toISOString(),
      });
      if (process.env.HMS_PROOF_DIAGNOSTICS === '1') {
        const ids = proofAuthorization.sessionAuthorization.manifest.rules
          .filter((r) => r.path.includes('OSRESV'))
          .map((r) => r.id);
        process.stderr.write(
          `${JSON.stringify({
            type: 'HMS_PROOF_DIAGNOSTIC',
            stage: 'detail_manifest',
            code: ids.includes('live-osresv-hdr-detail-open')
              ? 'HAS_HDR_DETAIL_OPEN'
              : 'MISSING_HDR_DETAIL_OPEN',
            osresvRuleIds: ids,
            ruleCount: proofAuthorization.sessionAuthorization.manifest.rules.length,
          })}\n`,
        );
      }
      const driver = createLiveGuestStayDriver({
        runtime,
        transportId: hmsConfig.expectedTransportId,
        propertyReadLock,
        sessionAuthorizationFor: () => proofAuthorization.sessionAuthorization,
        auditSpecFor: ({ inputClass }) => ({
          operationId,
          // Capture registry still closed; detail dump reuses find capture lane
          // while request policy uses search+detail manifest.
          toolId: 'hms_find_reservation',
          toolVersion: '1.2.0',
          dependencyRevision: HMS_DEPENDENCY_REVISION,
          executionClass: 'live_proof',
          inputClass,
          roleProofSha256: role.sha256,
          roleProofExpiresAt: role.expiresAt,
        }),
      });
      try {
        const { search, dump } = await driver.searchExactThenDetailDump(
          anchor.candidate,
          AbortSignal.timeout(Math.max(1, discoveryDeadline - Date.now())),
        );
        if (search.outcome !== 'matched') continue;
        const keyCount = dump.keys.length;
        const hasRoomType = dump.keys.some((k) => /roomtype|room_type/i.test(k));
        const hasRatePlan = dump.keys.some((k) => /rateplan|rate_plan/i.test(k));
        process.stdout.write(
          `HMS_OK code=DETAIL_DUMP keys=${keyCount} roomTypeKey=${hasRoomType ? 1 : 0} ratePlanKey=${hasRatePlan ? 1 : 0}\n`,
        );
        const attemptDir = process.env.HMS_PROOF_ATTEMPT_DIR?.trim();
        if (attemptDir && /^\/tmp\/nava-fast-find\.[A-Za-z0-9]+$/.test(attemptDir)) {
          const sanitized = {
            schemaVersion: 1 as const,
            surface: 'guest_stay_detail' as const,
            keys: dump.keys,
          };
          await writeFile(
            join(attemptDir, 'detail-dump.keys.v1.json'),
            `${JSON.stringify(sanitized, null, 2)}\n`,
            { encoding: 'utf8', mode: 0o600 },
          );
          // Private values stay on EC2 attempt dir only — never SSM stdout.
          if (dump.values) {
            await writeFile(
              join(attemptDir, 'detail-dump.values.private.json'),
              `${JSON.stringify({ keys: dump.keys, values: dump.values }, null, 2)}\n`,
              { encoding: 'utf8', mode: 0o600 },
            );
          }
        }
        dumped = true;
        break;
      } catch (err) {
        proofDiagnostic('detail_dump', err);
      }
    }
    if (!dumped) emitFail('SCHEMA_DRIFT');
  } catch (err) {
    if (err instanceof OperatorExit) throw err;
    runtimeError = err;
  } finally {
    try {
      await runtime.close();
    } catch {
      closeFailed = true;
    }
  }
  if (closeFailed) emitFail('ROLLBACK_INCOMPLETE');
  if (runtimeError) throw runtimeError;
}

async function runPurgeArtifacts(): Promise<void> {
  const root =
    process.env.HMS_BROWSER_ARTIFACT_ROOT?.trim() ||
    '/opt/nava/shared/hms-browser-artifacts';
  const removed = await purgeExpiredHmsBrowserArtifacts(root);
  emitOk(`HMS_ARTIFACT_PURGE_OK removed=${removed}`);
}

const PHASE_B_FRONT_ACTIONS = new Set([
  'doctor',
  'status',
  'read-discovery',
  'read-proof',
  'read-wave',
  'read-promote',
  'read-rollback',
  'artifacts',
  'fetch-artifact',
  'rearm',
]);

function isPhaseBArgv(argv: string[]): boolean {
  const action = argv[0] ?? '';
  if (!PHASE_B_FRONT_ACTIONS.has(action)) return false;
  // Phase A keeps bare `status` and `rearm` (single token).
  if ((action === 'status' || action === 'rearm') && argv.length === 1) {
    return false;
  }
  return true;
}

function phaseBOperationRoot(): string {
  return (
    process.env.HMS_PHASE_B_OPERATION_ROOT?.trim() ||
    join(sharedDir(), 'phase-b-operations')
  );
}

function runPhaseBOperator(argv: string[]): PhaseBOperatorResult {
  const parsed = parsePhaseBArgv(argv);
  if (!parsed.ok) return parsed.result;
  const operationId =
    ('resumeOperationId' in parsed.command &&
      parsed.command.resumeOperationId) ||
    randomUUID();
  const sourceRevision =
    process.env.NAVA_SOURCE_REVISION?.trim() ||
    (existsSync(
      process.env.NAVA_PROOF_SOURCE_REVISION_PATH?.trim() ||
        '/opt/nava/shared/nava-proof-source-revision',
    )
      ? readFileSync(
          process.env.NAVA_PROOF_SOURCE_REVISION_PATH?.trim() ||
            '/opt/nava/shared/nava-proof-source-revision',
          'utf8',
        ).trim()
      : 'unknown');
  const store = new PhaseBOperationStore({ rootDir: phaseBOperationRoot() });
  return runPhaseBLocalOperator({
    command: parsed.command,
    operationId,
    sourceRevision,
    store,
  });
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  assertNoLookupArgv(argv);

  if (isPhaseBArgv(argv)) {
    const result = runPhaseBOperator(argv);
    const json = argv.includes('--json');
    if (json) {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } else {
      const tag =
        result.outcome === 'ok'
          ? 'HMS_OK'
          : result.outcome === 'wait'
            ? 'HMS_WAIT'
            : 'HMS_FAIL';
      process.stdout.write(`${tag} code=${result.code}\n`);
    }
    process.exit(result.exitCode);
  }

  if (argv.length !== 1) emitFail('POLICY_BLOCK');
  const action = argv[0] ?? '';
  if (
    action !== 'canary' &&
    action !== 'start' &&
    action !== 'status' &&
    action !== 'stop' &&
    action !== 'rearm' &&
    action !== 'proof-video' &&
    action !== 'detail-dump' &&
    action !== 'purge-artifacts' &&
    action !== 'accept-g1'
  ) {
    emitFail('UNKNOWN_SAFE');
  }
  pendingOutputLines.length = 0;
  let operatorExit: OperatorExit | null = null;
  let proofEvidence: PhaseAProofEvidence | null = null;
  let dbCloseFailed = false;
  let lockReleaseFailed = false;
  let releaseOperationLock: (() => void) | null = null;
  try {
    if (
      action === 'canary' ||
      action === 'start' ||
      action === 'stop' ||
      action === 'rearm' ||
      action === 'proof-video' ||
      action === 'detail-dump' ||
      action === 'accept-g1'
    ) {
      releaseOperationLock = acquireHmsOperationLock();
    }
    if (action === 'canary') await runCanary();
    else if (action === 'start') await runStart();
    else if (action === 'status') await runStatus();
    else if (action === 'stop') await runStop();
    else if (action === 'rearm') runRearm();
    else if (action === 'proof-video') proofEvidence = await runProofVideo();
    else if (action === 'detail-dump') await runDetailDump();
    else if (action === 'purge-artifacts') await runPurgeArtifacts();
    else if (action === 'accept-g1') runAcceptG1();
  } catch (err) {
    if (action === 'proof-video' || action === 'detail-dump') proofDiagnostic('operation', err);
    if (err instanceof OperatorExit) {
      operatorExit = err;
    } else {
      try {
        emitFail(mapRuntimeFail(err));
      } catch (inner) {
        operatorExit =
          inner instanceof OperatorExit
            ? inner
            : new OperatorExit(10, 'HMS_FAIL code=UNKNOWN_SAFE');
      }
    }
  } finally {
    try {
      await closeDb();
    } catch (error) {
      if (action === 'proof-video') proofDiagnostic('database_close', error);
      dbCloseFailed = true;
    }
    if (!dbCloseFailed && !operatorExit && proofEvidence) {
      try {
        writeAtomicJson(phaseAGatePath(), {
          schemaVersion: 1,
          state: 'provisional',
          planPath: PHASE_A_PLAN_PATH,
          artifactId: proofEvidence.artifactId,
          receiptSha256: proofEvidence.receiptSha256,
          sourceRevision: proofEvidence.sourceRevision,
          roleProofSha256: proofEvidence.roleProofSha256,
          roleProofExpiresAt: proofEvidence.roleProofExpiresAt,
          writtenAt: new Date().toISOString(),
        });
      } catch {
        operatorExit = new OperatorExit(10, 'HMS_FAIL code=UNKNOWN_SAFE');
      }
    }
    try {
      releaseOperationLock?.();
    } catch (error) {
      if (action === 'proof-video') proofDiagnostic('operation_unlock', error);
      lockReleaseFailed = true;
    }
  }
  if (dbCloseFailed || lockReleaseFailed) {
    pendingOutputLines.length = 0;
    process.stdout.write('HMS_FAIL code=ROLLBACK_INCOMPLETE\n');
    process.exit(20);
  }
  if (operatorExit) {
    pendingOutputLines.length = 0;
    process.stdout.write(`${operatorExit.line}\n`);
    process.exit(operatorExit.exitCode);
  }
  if (proofEvidence) {
    emitOk('PHASE_A_PROOF_EVIDENCE_V1');
    pendingOutputLines.push(JSON.stringify(proofEvidence));
    emitOk('PHASE_A_PROOF_READY');
  }
  for (const line of pendingOutputLines) process.stdout.write(`${line}\n`);
  pendingOutputLines.length = 0;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
  main().catch((err) => {
    if (err instanceof OperatorExit) {
      process.stdout.write(`${err.line}\n`);
      process.exit(err.exitCode);
    }
    try {
      emitFail(mapRuntimeFail(err));
    } catch (inner) {
      if (inner instanceof OperatorExit) {
        process.stdout.write(`${inner.line}\n`);
        process.exit(inner.exitCode);
      }
      process.exit(10);
    }
  });
}
