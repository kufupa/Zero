/**
 * Purpose-built HMS live proof CLI (compiled to dist/ops/hms-live-proof.js).
 * Actions: canary | start | status | stop | rearm.
 * No tsx. Never accepts raw lookup / thread / message ID via argv.
 * Proof files store digests only — never guest/email/HMS/model values.
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
} from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { and, asc, count, eq, inArray, like } from 'drizzle-orm';
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
  buildLiveGuestStayRowFingerprintV1,
  createLiveGuestStayDriver,
} from '../hms/live-guest-stay-driver.js';
import { createProductionHmsRuntime } from '../hms/production-runtime.js';
import { HmsRuntimeError } from '../hms/runtime.js';
import type { ExactReservationCandidate } from '../hms/live-read-manifest.js';
import { LIVE_GUEST_STAY_SEARCH_PATH } from '../hms/live-read-manifest.js';

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

function sharedDir(): string {
  return process.env.HMS_SHARED_DIR?.trim() || '/opt/nava/shared';
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
    join(sharedDir(), 'hms-read-role-proof.v1.json')
  );
}

function dependencyStampPath(): string {
  return join(sharedDir(), 'hms-dependency-revision.txt');
}

function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

function emitOk(token: string): void {
  process.stdout.write(`${token}\n`);
}

function emitWait(code: string): never {
  process.stdout.write(`HMS_WAIT code=${code}\n`);
  process.exit(3);
}

function emitFail(code: string): never {
  if (code === 'ROLLBACK_INCOMPLETE') {
    process.stdout.write(`HMS_FAIL code=ROLLBACK_INCOMPLETE\n`);
    process.exit(20);
  }
  const safe = OPERATOR_FAIL_CODES.has(code) ? code : 'UNKNOWN_SAFE';
  process.stdout.write(`HMS_FAIL code=${safe}\n`);
  process.exit(10);
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
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  chmodSync(path, 0o600);
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
    if (existsSync(p)) {
      try {
        unlinkSync(p);
      } catch {
        /* ignore */
      }
    }
  }
}

function assertDependenciesOk(): void {
  const stamp = existsSync(dependencyStampPath())
    ? readFileSync(dependencyStampPath(), 'utf8').trim()
    : '';
  const chrome =
    process.env.HMS_CHROMIUM_EXECUTABLE_PATH?.trim() ||
    '/opt/nava/chromium/chrome';
  if (stamp !== HMS_DEPENDENCY_REVISION || !existsSync(chrome)) {
    emitFail('DEPENDENCY_MISMATCH');
  }
}

function loadRoleProofDigest(): { sha256: string; expiresAt: string } {
  const path = roleProofPath();
  if (!existsSync(path)) {
    process.stdout.write(`roleProofPath=${path}\n`);
    emitFail('ROLE_PROOF_MISSING');
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
  const fingerprint = buildLiveGuestStayRowFingerprintV1();
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
  online: boolean;
  startedAt?: string;
  commit?: string;
} {
  const out = spawnSync('pm2', ['jlist'], { encoding: 'utf8' });
  if (out.status !== 0) return { online: false };
  try {
    const apps = JSON.parse(out.stdout || '[]') as Array<{
      name?: string;
      pm2_env?: {
        status?: string;
        pm_uptime?: number;
        NAVA_BUILD_COMMIT?: string;
        env?: Record<string, string>;
      };
    }>;
    const hit = apps.find((a) => a.name === 'hms-ai-worker');
    if (!hit) return { online: false };
    const status = hit.pm2_env?.status;
    const online = status === 'online';
    const startedAt = hit.pm2_env?.pm_uptime
      ? new Date(hit.pm2_env.pm_uptime).toISOString()
      : undefined;
    const commit =
      hit.pm2_env?.NAVA_BUILD_COMMIT ||
      hit.pm2_env?.env?.NAVA_BUILD_COMMIT ||
      undefined;
    return { online, startedAt, commit };
  } catch {
    return { online: false };
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
    const ai = apps.find((a) => a.name === 'ai-worker');
    return http?.pm2_env?.status === 'online' && ai?.pm2_env?.status === 'online';
  } catch {
    return false;
  }
}

function deleteHmsPm2(): void {
  spawnSync('pm2', ['delete', 'hms-ai-worker'], { encoding: 'utf8' });
  spawnSync('pm2', ['save'], { encoding: 'utf8' });
}

function startHmsPm2(input: {
  proofAttemptId: string;
  buildCommit: string;
}): void {
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
  spawnSync('pm2', ['save'], { encoding: 'utf8', env });
}

type ExactMailAnchor = {
  candidate: ExactReservationCandidate;
  messageId: string;
  threadId: string;
  transportId: string;
};

async function selectOldestExactCandidates(
  databaseUrl: string,
  limit = 12,
): Promise<ExactMailAnchor[]> {
  const { db, conn } = createDb(databaseUrl);
  try {
    const rows = await db
      .select({
        id: message.id,
        threadId: message.threadId,
        transportId: message.transportId,
        textBody: message.textBody,
        htmlBody: message.htmlBody,
        subject: message.subject,
        receivedAt: message.receivedAt,
      })
      .from(message)
      .where(
        and(
          eq(message.transportId, CENTURION_TRANSPORT_ID),
          eq(message.direction, 'inbound'),
        ),
      )
      .orderBy(asc(message.receivedAt), asc(message.id));

    const out: ExactMailAnchor[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      const text = [
        row.subject ?? '',
        normalizeMessageText({
          textBody: row.textBody,
          htmlBody: row.htmlBody,
        }),
      ].join('\n');
      const exact = filterExactReservationCandidates(extractLookupCandidates(text));
      if (exact.length !== 1) continue;
      const candidate = exact[0]!;
      // Skip obvious short false positives (live HRCEN confirmations are longer).
      if (candidate.value.length < 6) continue;
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
  } finally {
    await conn.end().catch(() => undefined);
  }
}

async function selectOldestExactCandidate(
  databaseUrl: string,
): Promise<ExactMailAnchor | null> {
  const list = await selectOldestExactCandidates(databaseUrl, 1);
  return list[0] ?? null;
}

async function snapshotForbiddenRows(transportId: string): Promise<{
  aiDraftGeneration: number;
  mailDraft: number;
  mailDraftRevision: number;
}> {
  const db = getDb();
  const [gens] = await db
    .select({ c: count() })
    .from(aiDraftGeneration)
    .where(eq(aiDraftGeneration.transportId, transportId));
  const [drafts] = await db
    .select({ c: count() })
    .from(mailDraft)
    .where(eq(mailDraft.transportId, transportId));
  const [revs] = await db
    .select({ c: count() })
    .from(mailDraftRevision)
    .innerJoin(mailDraft, eq(mailDraftRevision.draftId, mailDraft.id))
    .where(eq(mailDraft.transportId, transportId));
  return {
    aiDraftGeneration: Number(gens?.c ?? 0),
    mailDraft: Number(drafts?.c ?? 0),
    mailDraftRevision: Number(revs?.c ?? 0),
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

function isFreshProof(finishedAt: string, expiresAt: string): boolean {
  const fin = Date.parse(finishedAt);
  const exp = Date.parse(expiresAt);
  if (!Number.isFinite(fin) || !Number.isFinite(exp)) return false;
  if (exp - fin > PROOF_TTL_MS + 1000) return false;
  return exp > Date.now();
}

async function runCanary(): Promise<void> {
  if (startsDisabled()) emitFail('RUN_ISOLATION_BLOCKED');
  const hms = pm2DescribeHms();
  if (hms.online) emitFail('RUN_ISOLATION_BLOCKED');

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

  const anchors = await selectOldestExactCandidates(env.DATABASE_URL);
  if (anchors.length === 0) emitWait('NO_EXACT_CANDIDATE');

  const hmsConfig = requireHmsWorkerRuntimeConfig({
    ...process.env,
    HMS_DRAFT_ENRICHMENT_MODE: 'shadow',
  });
  // Not-found + fingerprint + up to N exact searches each need a fresh login.
  const signal = AbortSignal.timeout(
    Math.max(
      hmsConfig.runDeadlineMs,
      90_000 + anchors!.length * 90_000,
    ),
  );
  const runtime = await createProductionHmsRuntime(hmsConfig);
  try {
    await runtime.start(signal);
    const driver = createLiveGuestStayDriver({
      runtime,
      transportId: hmsConfig.expectedTransportId,
    });

    await driver.loginAndVerifyBinding(signal);
    await driver.runNotFoundCanary(signal);
    emitOk('HMS_LIVE_NOT_FOUND_OK');

    const fingerprint = buildLiveGuestStayRowFingerprintV1();
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
    emitFail(mapRuntimeFail(err));
  } finally {
    await runtime.close().catch(() => undefined);
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

  const nonterminal = await countNonterminalHmsLane();
  if (nonterminal > 0) emitFail('RUN_ISOLATION_BLOCKED');

  const hmsBefore = pm2DescribeHms();
  if (hmsBefore.online) emitFail('RUN_ISOLATION_BLOCKED');

  const proofAttemptId = randomUUID();
  const anchor = await selectOldestExactCandidate(env.DATABASE_URL);
  if (!anchor) emitWait('NO_EXACT_CANDIDATE');

  const before = await snapshotForbiddenRows(anchor!.transportId);
  const canaryProofSha256 = sha256Hex(readFileSync(canaryProofPath()));

  const idempotencyKey = `hms-proof:${proofAttemptId}:${anchor!.messageId}`;
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
  if (run.generationId !== null) {
    emitFail('FORBIDDEN_PERSISTENCE');
  }

  process.env.HMS_DRAFT_ENRICHMENT_MODE = 'shadow';
  process.env.AI_DRAFTS_ENABLED = 'false';
  process.env.NAVA_BUILD_COMMIT = commit;
  process.env.AI_WORKER_IDEMPOTENCY_PREFIX = `hms-proof:${proofAttemptId}:`;

  startHmsPm2({ proofAttemptId, buildCommit: commit });
  const processStartedAt = new Date().toISOString();

  const prefix = `hms-proof:${proofAttemptId}:`;
  const deadline = Date.now() + (env.HMS_RUN_DEADLINE_MS ?? 150_000) + 30_000;
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
    // Scoped wait — only this proof prefix (never drain unrelated).
    await countNonterminalAiRuns({ idempotencyPrefix: prefix });
    await new Promise((r) => setTimeout(r, 2000));
  }

  if (!terminal || terminal.state !== 'succeeded') {
    emitFail('UNKNOWN_SAFE');
  }

  const after = await snapshotForbiddenRows(anchor!.transportId);
  const forbiddenRowDelta =
    after.aiDraftGeneration -
    before.aiDraftGeneration +
    (after.mailDraft - before.mailDraft) +
    (after.mailDraftRevision - before.mailDraftRevision);
  if (forbiddenRowDelta !== 0) emitFail('FORBIDDEN_PERSISTENCE');

  const policyBlockDelta = 0;
  const finishedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + PROOF_TTL_MS).toISOString();
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
    finishedAt,
    expiresAt,
  };
  writeAtomicJson(shadowProofPath(), shadow);
  // Leave worker idle — no automatic enqueue. Prefix scope prevents other claims.
  void policyBlockDelta;
  emitOk('HMS_SHADOW_OK');
}

async function runStatus(): Promise<void> {
  assertDependenciesOk();
  const role = loadRoleProofDigest();
  const digests = codeArtifactDigests();
  const commit = buildCommit();
  const hms = pm2DescribeHms();

  if (!hms.online) {
    if (!pm2DefaultHealthy()) emitFail('HEALTH_STALE');
    // Off + healthy defaults.
    const shadow = readJsonFile<HmsReservationShadowProofV1>(shadowProofPath());
    if (shadow?.shadowVerified) {
      // Stale leftover file after stop is OK; prefer OFF_READY.
    }
    emitOk('HMS_OFF_READY');
    return;
  }

  if (hms.commit && hms.commit !== commit) emitFail('BUILD_MISMATCH');

  const shadow = readJsonFile<HmsReservationShadowProofV1>(shadowProofPath());
  if (!shadow || shadow.schemaVersion !== 1) emitFail('BUILD_MISMATCH');
  if (!isFreshProof(shadow!.finishedAt, shadow!.expiresAt)) {
    emitFail('BUILD_MISMATCH');
  }
  if (shadow!.runningProcessCommit !== commit) emitFail('BUILD_MISMATCH');
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
  if (health.stale) emitFail('HEALTH_STALE');
  if (!pm2DefaultHealthy()) emitFail('HEALTH_STALE');

  emitOk('HMS_SHADOW_VERIFIED');
}

async function runStop(): Promise<void> {
  // preventStarts — disable future start until flag cleared by ops.
  setStartsDisabled(true);

  const env = parseEnv(process.env);
  process.env.DATABASE_URL = env.DATABASE_URL;

  const shadow = readJsonFile<HmsReservationShadowProofV1>(shadowProofPath());
  const prefix = shadow?.proofAttemptId
    ? `hms-proof:${shadow.proofAttemptId}:`
    : null;

  // Signal worker + delete PM2 app (autorestart false → no loop).
  spawnSync('pm2', ['stop', 'hms-ai-worker'], { encoding: 'utf8' });

  if (prefix) {
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
            updatedAt: new Date(),
            claimOwner: null,
            claimToken: null,
          })
          .where(eq(aiWorkflowRun.id, row.id));
      }
    }
  }

  deleteHmsPm2();
  invalidateProofs();

  const still = pm2DescribeHms();
  if (still.online) emitFail('ROLLBACK_INCOMPLETE');
  if (!pm2DefaultHealthy()) emitFail('ROLLBACK_INCOMPLETE');

  emitOk('HMS_ROLLBACK_OK');
}

function runRearm(): void {
  // Clears latch left by stop so next intentional canary/start can proceed.
  setStartsDisabled(false);
  if (startsDisabled()) emitFail('ROLLBACK_INCOMPLETE');
  emitOk('HMS_SHADOW_REARMED');
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  assertNoLookupArgv(argv);
  const action = argv[0] ?? '';
  if (
    action !== 'canary' &&
    action !== 'start' &&
    action !== 'status' &&
    action !== 'stop' &&
    action !== 'rearm'
  ) {
    emitFail('UNKNOWN_SAFE');
  }
  try {
    if (action === 'canary') await runCanary();
    else if (action === 'start') await runStart();
    else if (action === 'status') await runStatus();
    else if (action === 'stop') await runStop();
    else if (action === 'rearm') runRearm();
  } finally {
    await closeDb().catch(() => undefined);
  }
}

main().catch((err) => {
  emitFail(mapRuntimeFail(err));
});
