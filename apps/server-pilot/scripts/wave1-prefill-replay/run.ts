import { createReadStream } from 'node:fs';
import { appendFile, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { createDb, __setDbForTests } from '../../src/db/client.js';
import { aiWorkflowRun, attachment, mailThread, message } from '../../src/db/schema/mail.js';
import { workItem } from '../../src/db/schema/work.js';
import { MESSAGE_ARRIVED_AT } from '../../src/ai/message-arrival-time.js';
import { staffQuoteSourceHash } from '../../src/ai/staff-quote-workflow.js';
import { createEvidenceGateway } from './cache.js';
import { createReplayStorage, seedAllRecoveredAttachments, seedMailbox, type RecoveredAttachment } from './runtime.js';
import { ReplayExecutionError, runCurrentV2Case } from './v2.js';

const CAPTURED_SOURCE_VERSION = 'cdb59e4d10a7379dd26d5a648ebec6883c40a0ab';
const SOURCE_VERSION = process.env.NAVA_BUILD_COMMIT ?? '';
if (!/^[a-f0-9]{40}$/.test(SOURCE_VERSION)) throw new Error('CANDIDATE_SOURCE_PIN_REQUIRED');
const WAVE1_ROOT = '/home/orca/.local/share/zero/research/halloween/prefill-wave1-20261112-195632';
const PRIVATE_RUN_ROOT = join(WAVE1_ROOT, 'runner');
const DEFAULT_SELECTION = join(WAVE1_ROOT, 'evidence/selection.json');
const DEFAULT_SEAL = join(WAVE1_ROOT, 'isolation/selection-sealed.json');
const ORIGINAL_ROOT = '/home/orca/.local/share/zero/research/halloween/v2-prefill-backtest-redesign-20261111';
const ATOMIC_ROOT = '/home/orca/.local/share/zero/research/halloween/prefill-architecture-run-20261112-atomic';
const APPROVED_PACKETS = join(ATOMIC_ROOT, 'scoring-tools/score-queue-safe-projection-v2/packets-all.jsonl');
const DATASET_ROOT = '/home/orca/.local/share/zero/research/halloween/dataset-run-20261111-1022';
const SOURCE_INDEX = join(DATASET_ROOT, 'coordinator/source-index.sqlite');
const ORIGINAL_INPUTS = join(ORIGINAL_ROOT, 'original-source-inputs-v2.json');
const RECOVERED_INPUTS = join(ORIGINAL_ROOT, 'recovered-originals-v2.jsonl');
const DEPLOYMENT_SNAPSHOT = join(ORIGINAL_ROOT, 'deployment.json');
const RUNTIME_SNAPSHOT = join(ORIGINAL_ROOT, 'runtime.json');
const CACHE_CATALOG = join(ORIGINAL_ROOT, 'cache-catalog-v7.jsonl');
const CACHE_PROOF = join(ORIGINAL_ROOT, 'cache-catalog-v7-proof.json');
const MAILBOX_FIDELITY = join(WAVE1_ROOT, 'isolation/mailbox-fidelity.json');
const MAILBOX_ADDRESS = 'centurion@legacyhotels.co.za';

const caseSchema = z.object({
  decisionId: z.string().min(1),
  selectedSourceRowId: z.string().uuid(),
  workflow: z.string().min(1),
  cutoff: z.string().min(1),
  journeyId: z.string().min(1),
  tags: z.array(z.string()).default([]),
  packetPath: z.string().min(1),
  groupId: z.string().optional(),
  senderAddress: z.string().optional(),
}).passthrough();
const selectionSchema = z.array(caseSchema).min(1).max(60);
const sealedSchema = z.object({ caseIds: z.array(z.string().min(1)).min(1).max(60) }).passthrough();
const originalMessageSchema = z.object({
  id: z.string(), thread_id: z.string(), subject: z.string().nullable(), text_body: z.string().nullable(),
  html_body: z.string().nullable(), received_at: z.string().nullable(), sent_at: z.string().nullable().optional(),
  from_address: z.string().nullable().optional(), transport_id: z.string().optional(), direction: z.string().optional(),
}).passthrough();
const sizeBytesSchema = z.union([
  z.number(),
  z.string().regex(/^\d+$/).transform(value => {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) throw new Error('SIZE_BYTES_NOT_SAFE_INTEGER');
    return parsed;
  }),
]).refine(value => Number.isSafeInteger(value) && value >= 0).nullable().optional();
const originalInputsSchema = z.object({ messages: z.array(originalMessageSchema), attachments: z.array(z.object({
  id: z.string(), message_id: z.string(), filename: z.string(), mime_type: z.string(), sha256: z.string().nullable().optional(),
  size_bytes: sizeBytesSchema,
}).passthrough()) }).passthrough();
const recoveredSchema = z.object({
  id: z.string(), messageId: z.string(), filename: z.string(), mimeType: z.string(), path: z.string(), sha256: z.string(),
  bytes: z.number().optional(), isInline: z.boolean().optional(), contentId: z.string().nullable().optional(),
  sourceAttachmentId: z.string().nullable().optional(), sourceSha256: z.string().nullable().optional(),
  s3Key: z.string().optional(), createdAt: z.string().optional(), status: z.string(),
}).passthrough();

type WaveCase = z.infer<typeof caseSchema> & { packetSha256: string; packetLine: number; packetLineSha256: string;
  packetFilePath: string; threadId: string };
type SourceMessage = z.infer<typeof originalMessageSchema>;
type LoadedInputs = {
  cases: WaveCase[];
  sourceMessages: SourceMessage[];
  originalById: Map<string, SourceMessage>;
  sourceAttachments: z.infer<typeof originalInputsSchema>['attachments'];
  recovered: RecoveredAttachment[];
  recoveredById: Map<string, RecoveredAttachment & { status: string }>;
  selectionSha256: string;
  sealSha256: string | null;
  artifactHashes: Record<string, string>;
  sourceHashes: Record<string, string>;
  deployment: { deployed_commit: string; checked_at_utc: string; processes: unknown[] };
  routeIdentityHash: string;
};

function readArg(name: string, fallback?: string): string | undefined {
  const args = process.argv.slice(2);
  const positions = args.flatMap((arg, index) => arg === name ? [index] : []);
  if (positions.length > 1) throw new Error(`DUPLICATE_${name.slice(2).toUpperCase().replaceAll('-', '_')}`);
  if (!positions.length) return fallback;
  const value = args[positions[0]! + 1];
  if (!value || value.startsWith('--')) throw new Error(`VALUE_REQUIRED_${name.slice(2).toUpperCase().replaceAll('-', '_')}`);
  return value;
}

function hasFlag(name: string): boolean { return process.argv.slice(2).includes(name); }

function conciseError(error: unknown): string {
  if (error instanceof z.ZodError) {
    const first = error.issues.slice(0, 3).map(issue => `${issue.path.join('.') || '$'}:${issue.code}`);
    return `ZodError: ${first.join(', ')}${error.issues.length > first.length ? `; totalIssues=${error.issues.length}` : ''}`;
  }
  const raw = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  let safe = raw;
  for (const name of ['DATABASE_URL', 'AZURE_FOUNDRY_API_KEY', 'AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_BASE_URL',
    'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN']) {
    const secret = process.env[name];
    if (secret) safe = safe.replaceAll(secret, '[redacted]');
  }
  return safe.replace(/postgres(?:ql)?:\/\/[^\s]+/gi, '[local replay DB]').slice(0, 2000);
}

function isWithin(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function normalizedSender(value: string | null | undefined): string {
  if (!value) return '';
  const address = value.match(/<\s*([^<>]+)\s*>/)?.[1] ?? value;
  return address.replace(/^['"]|['"]$/g, '').trim().toLowerCase();
}

function noMismatches(value: unknown): boolean {
  if (Array.isArray(value)) return value.length === 0;
  return Boolean(value) && typeof value === 'object' && Object.keys(value as Record<string, unknown>).length === 0;
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

function safeDatabaseIdentity(value: string | undefined) {
  if (!value) return null;
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error('REPLAY_DATABASE_URL_INVALID'); }
  const database = parsed.pathname.slice(1);
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || parsed.hostname !== '127.0.0.1' || parsed.port !== '55447' ||
      parsed.username !== 'fresh_replay' || !['nava_replay_wave1_20261112_195632', 'nava_replay_wave1_20261112_195632_r2', 'nava_replay_wave1_20261112_195632_r3', 'nava_replay_wave1_20261112_195632_r4', 'nava_replay_wave1_20261112_195632_r5', 'nava_replay_wave1_20261112_195632_r6', 'nava_replay_tier1_4_baseline', 'nava_replay_tier1_4_candidate'].includes(database))
    throw new Error('REPLAY_DATABASE_NOT_THE_OWNED_LOCAL_DATABASE');
  return { host: parsed.hostname, port: Number(parsed.port), database, user: parsed.username };
}

async function assertLaunchEnvironment(preflight: boolean) {
  const worktree = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: process.cwd(), encoding: 'utf8' }).trim();
  const sourceVersion = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worktree, encoding: 'utf8' }).trim();
  if (sourceVersion !== SOURCE_VERSION) throw new Error('CURRENT_SOURCE_PIN_MISMATCH');
  const trackedDiff = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'],
    { cwd: worktree, encoding: 'utf8' }).trim();
  if (trackedDiff) throw new Error('TRACKED_SOURCE_DIFF_PRESENT');
  const appRoot = await realpath(process.cwd());
  if (!isWithin(worktree, appRoot)) throw new Error('RUNNER_NOT_IN_CURRENT_WORKTREE');
  const privateRoot = process.env.FRESH_REPLAY_ROOT;
  const expectedPrivateRoot = await realpath(PRIVATE_RUN_ROOT);
  if (!privateRoot || await realpath(privateRoot) !== expectedPrivateRoot) throw new Error('PRIVATE_RUN_ROOT_MISMATCH');
  if (process.env.TEST_DATABASE_URL || process.env.VITEST_ALLOW_PILOT_RDS) throw new Error('TEST_DATABASE_ENVIRONMENT_SET');
  if (process.env.NODE_ENV !== 'test') throw new Error('REPLAY_NODE_ENV_MUST_BE_TEST');
  if (process.env.TZ !== 'UTC') throw new Error('REPLAY_TIMEZONE_MUST_BE_UTC');
  if (process.env.NAVA_BUILD_COMMIT !== SOURCE_VERSION) throw new Error('RUNNER_COMMIT_ENV_MISMATCH');
  if (process.env.EXTRACTION_REASONING_EFFORT !== 'high') throw new Error('HISTORICAL_REASONING_EFFORT_MUST_BE_HIGH');
  const database = safeDatabaseIdentity(process.env.DATABASE_URL);
  if (!database && !preflight) throw new Error('REPLAY_DATABASE_URL_REQUIRED');
  const shots = process.env.HMS_SHOTS_DIR;
  let shotPath: string | null = null;
  if (shots) { try { shotPath = await realpath(shots); } catch { /* checked below */ } }
  if (!shotPath || !isWithin(expectedPrivateRoot, shotPath)) throw new Error('PRIVATE_SCREENSHOT_DIR_REQUIRED');
  return { sourceVersion, database, privateRoot: expectedPrivateRoot, shots: shotPath };
}

async function loadInputs(selectionPath: string, sealPath?: string): Promise<LoadedInputs> {
  if (!isAbsolute(selectionPath)) throw new Error('ABSOLUTE_SELECTION_PATH_REQUIRED');
  const actualSelection = await realpath(selectionPath);
  const wave1Root = await realpath(WAVE1_ROOT);
  if (!isWithin(wave1Root, actualSelection)) throw new Error('SELECTION_OUTSIDE_PRIVATE_WAVE1_ROOT');
  const selectionBytes = await readFile(actualSelection);
  const selectionSha256 = createHash('sha256').update(selectionBytes).digest('hex');
  const entries = selectionSchema.parse(JSON.parse(selectionBytes.toString('utf8')));
  if (new Set(entries.map(row => row.decisionId)).size !== entries.length ||
      new Set(entries.map(row => row.selectedSourceRowId)).size !== entries.length) throw new Error('DUPLICATE_CASE_OR_SOURCE_ID');

  let sealSha256: string | null = null;
  if (sealPath) {
    if (!isAbsolute(sealPath)) throw new Error('ABSOLUTE_SELECTION_SEAL_PATH_REQUIRED');
    const actualSeal = await realpath(sealPath);
    if (!isWithin(wave1Root, actualSeal)) throw new Error('SELECTION_SEAL_OUTSIDE_PRIVATE_WAVE1_ROOT');
    const sealBytes = await readFile(actualSeal);
    sealSha256 = createHash('sha256').update(sealBytes).digest('hex');
    const sealed = sealedSchema.parse(JSON.parse(sealBytes.toString('utf8')));
    const selectedIds = new Set(entries.map(row => row.decisionId));
    if (new Set(sealed.caseIds).size !== sealed.caseIds.length || sealed.caseIds.length !== entries.length ||
        sealed.caseIds.some(id => !selectedIds.has(id))) throw new Error('SEALED_CASE_IDS_DO_NOT_MATCH_SELECTION');
  }

  const originalBytes = await readFile(ORIGINAL_INPUTS);
  const original = originalInputsSchema.parse(JSON.parse(originalBytes.toString('utf8')));
  const originalById = new Map(original.messages.map(row => [row.id, row]));
  if (originalById.size !== original.messages.length) throw new Error('DUPLICATE_ORIGINAL_SOURCE_MESSAGE_ID');
  const recoveredText = await readFile(RECOVERED_INPUTS, 'utf8');
  const recoveredAll = recoveredText.split('\n').filter(Boolean).map(line => recoveredSchema.parse(JSON.parse(line)));
  const recoveredAvailable = recoveredAll.filter(file => file.status === 'available') as RecoveredAttachment[];
  const recoveredById = new Map(recoveredAll.map(file => [file.id, file]));
  if (recoveredById.size !== recoveredAll.length) throw new Error('DUPLICATE_RECOVERED_ATTACHMENT_ID');

  const cases: WaveCase[] = [];
  const packetCache = new Map<string, { sha256: string; lines: string[] }>();
  for (const row of entries) {
    const originalMessage = originalById.get(row.selectedSourceRowId);
    if (!originalMessage || !originalMessage.received_at) throw new Error(`SOURCE_MESSAGE_MISSING:${row.decisionId}`);
    const cutoff = new Date(row.cutoff);
    if (!Number.isFinite(cutoff.getTime()) || cutoff.toISOString() !== row.cutoff ||
        new Date(originalMessage.received_at).toISOString() !== row.cutoff) throw new Error(`SOURCE_CUTOFF_MISMATCH:${row.decisionId}`);
    if (row.senderAddress && normalizedSender(originalMessage.from_address) !== normalizedSender(row.senderAddress))
      throw new Error(`SOURCE_SENDER_MISMATCH:${row.decisionId}`);
    const packetAnchor = row.packetPath.match(/^(.*)#L([1-9]\d*)$/);
    if (!packetAnchor || !isAbsolute(packetAnchor[1]!)) throw new Error(`PACKET_LINE_ANCHOR_REQUIRED:${row.decisionId}`);
    const packetPath = await realpath(packetAnchor[1]!);
    if (packetPath !== await realpath(APPROVED_PACKETS)) throw new Error(`PACKET_OUTSIDE_APPROVED_ARCHIVE:${row.decisionId}`);
    const packetInfo = await stat(packetPath);
    if (!packetInfo.isFile()) throw new Error(`PACKET_NOT_FILE:${row.decisionId}`);
    const packetLine = Number(packetAnchor[2]);
    let packetFile = packetCache.get(packetPath);
    if (!packetFile) {
      const packetBytes = await readFile(packetPath);
      packetFile = { sha256: createHash('sha256').update(packetBytes).digest('hex'),
        lines: packetBytes.toString('utf8').split(/\r?\n/) };
      packetCache.set(packetPath, packetFile);
    }
    const packetLineText = packetFile.lines[packetLine - 1];
    if (!packetLineText) throw new Error(`PACKET_LINE_MISSING:${row.decisionId}`);
    let packetRecord: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(packetLineText);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      packetRecord = parsed as Record<string, unknown>;
    } catch { throw new Error(`PACKET_LINE_NOT_JSON:${row.decisionId}`); }
    if (packetRecord.decisionId !== row.decisionId || packetRecord.cutoff !== row.cutoff ||
        packetRecord.selectedSourceRowId !== row.selectedSourceRowId)
      throw new Error(`PACKET_LINE_CASE_BINDING_MISMATCH:${row.decisionId}`);
    cases.push({ ...row, packetSha256: packetFile.sha256, packetLine,
      packetLineSha256: createHash('sha256').update(packetLineText).digest('hex'), packetFilePath: packetPath,
      threadId: originalMessage.thread_id });
  }

  const deployment = JSON.parse(await readFile(DEPLOYMENT_SNAPSHOT, 'utf8')) as LoadedInputs['deployment'];
  if (deployment.deployed_commit !== CAPTURED_SOURCE_VERSION) throw new Error('CAPTURED_SOURCE_VERSION_MISMATCH');
  const runtime = JSON.parse(await readFile(RUNTIME_SNAPSHOT, 'utf8')) as { model_route_identity?: unknown };
  if (typeof runtime.model_route_identity !== 'string' || !/^[a-f0-9]{64}$/.test(runtime.model_route_identity))
    throw new Error('CAPTURED_MODEL_ROUTE_IDENTITY_INVALID');
  const proof = JSON.parse(await readFile(CACHE_PROOF, 'utf8')) as { outputSha256?: unknown; sourceRunComplete?: unknown };
  const catalogHash = await hashFile(CACHE_CATALOG);
  if (proof.sourceRunComplete !== true || proof.outputSha256 !== catalogHash) throw new Error('CACHE_CATALOG_PROOF_MISMATCH');
  const mailboxProof = JSON.parse(await readFile(MAILBOX_FIDELITY, 'utf8')) as {
    databaseMessages?: unknown; originalMessages?: unknown; mismatches?: unknown; sourceFields?: unknown; timezone?: unknown;
  };
  const requiredMailboxFields = ['thread_id', 'subject', 'text_body', 'html_body', 'from_address', 'received_at', 'sent_at'];
  if (mailboxProof.timezone !== 'UTC' || mailboxProof.databaseMessages !== original.messages.length ||
      mailboxProof.originalMessages !== original.messages.length || !noMismatches(mailboxProof.mismatches) ||
      !Array.isArray(mailboxProof.sourceFields) ||
      requiredMailboxFields.some(field => !mailboxProof.sourceFields!.includes(field)))
    throw new Error('DEDICATED_DATABASE_SOURCE_FIDELITY_PROOF_MISMATCH');

  const artifactHashes = Object.fromEntries(await Promise.all([
    ['sourceIndex', SOURCE_INDEX], ['originalInputs', ORIGINAL_INPUTS], ['recoveredInputs', RECOVERED_INPUTS],
    ['deploymentSnapshot', DEPLOYMENT_SNAPSHOT], ['runtimeSnapshot', RUNTIME_SNAPSHOT], ['cacheCatalog', CACHE_CATALOG],
    ['cacheProof', CACHE_PROOF], ['mailboxFidelityProof', MAILBOX_FIDELITY],
  ].map(async ([name, path]) => [name!, await hashFile(path!)] as const)));
  const appRoot = await realpath(process.cwd());
  const productSources = {
    v2Prefill: join(appRoot, 'src/ai/reservation-workflow-v2-prefill.ts'),
    v2PrefillService: join(appRoot, 'src/ai/reservation-workflow-v2-prefill-service.ts'),
    v2State: join(appRoot, 'src/ai/reservation-workflow-v2-state.ts'),
    v2Contract: join(appRoot, 'src/ai/reservation-workflow-v2-contract.ts'),
    v2ArrivalChecks: join(appRoot, 'src/ai/reservation-workflow-v2-arrival-checks.ts'),
    v2Tools: join(appRoot, 'src/ai/reservation-workflow-v2-tools.ts'),
    v2Evidence: join(appRoot, 'src/ai/reservation-workflow-v2-evidence.ts'),
    syncedSelection: join(appRoot, 'src/ai/quote-workflow-synced-selection.ts'),
    arrivalTime: join(appRoot, 'src/ai/message-arrival-time.ts'),
    sourceHash: join(appRoot, 'src/ai/staff-quote-workflow.ts'),
    extractionAdapter: join(appRoot, 'src/ai/extraction/extract.ts'),
    paneClient: join(appRoot, '../mail/lib/reservation-workflow/client.ts'),
    paneTypes: join(appRoot, '../mail/lib/reservation-workflow/types.ts'),
    paneViews: join(appRoot, '../mail/lib/reservation-workflow/views.ts'),
    nativeLeads: join(appRoot, 'src/ai/reservation-workflow-v2-native-leads.ts'),
    nativeParty: join(appRoot, 'src/ai/reservation-workflow-v2-native-party.ts'),
  };
  const runnerSources = {
    replayEntry: fileURLToPath(new URL('./run.ts', import.meta.url)),
    replayV2: fileURLToPath(new URL('./v2.ts', import.meta.url)),
    replayRuntime: fileURLToPath(new URL('./runtime.ts', import.meta.url)),
    replayCache: fileURLToPath(new URL('./cache.ts', import.meta.url)),
    readBudget: fileURLToPath(new URL('./read-budget.ts', import.meta.url)),
  };
  const sourceHashes = Object.fromEntries(await Promise.all([
    ...Object.entries(productSources).map(async ([name, path]) => [`product:${name}`, await hashFile(path)] as const),
    ...Object.entries(runnerSources).map(async ([name, path]) => [`runner:${name}`, await hashFile(path)] as const),
  ]));
  return { cases, sourceMessages: original.messages, originalById, sourceAttachments: original.attachments,
    recovered: recoveredAvailable, recoveredById, selectionSha256, sealSha256, artifactHashes, sourceHashes,
    deployment, routeIdentityHash: runtime.model_route_identity };
}

async function verifyImports() {
  const [core, service, state, arrival, tools, run, cache, runtime] = await Promise.all([
    import('../../src/ai/reservation-workflow-v2-prefill.js'),
    import('../../src/ai/reservation-workflow-v2-prefill-service.js'),
    import('../../src/ai/reservation-workflow-v2-state.js'),
    import('../../src/ai/reservation-workflow-v2-arrival-checks.js'),
    import('../../src/ai/reservation-workflow-v2-tools.js'),
    import('./v2.js'), import('./cache.js'), import('./runtime.js'),
  ]);
  if (typeof core.runReservationWorkflowV2Prefill !== 'function' ||
      typeof core.createReservationWorkflowV2CandidateReader !== 'function' || typeof service.prefillDraft !== 'function' ||
      typeof state.initializeReservationWorkflowV2Draft !== 'function' || typeof arrival.runReservationArrivalChecks !== 'function' ||
      typeof tools.reservationWorkflowV2PreparationViews !== 'function' || typeof run.runCurrentV2Case !== 'function' ||
      typeof cache.createEvidenceGateway !== 'function' || typeof runtime.createReplayStorage !== 'function')
    throw new Error('CURRENT_V2_IMPORT_GATE_FAILED');
  return { sourceFiles: 8, serviceSeam: 'current checkout', candidateGateway: 'current checkout', modelCalls: 0, nativeCalls: 0 };
}

function serializeArtifact(value: unknown): string {
  const secrets = ['DATABASE_URL', 'AZURE_FOUNDRY_API_KEY', 'AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_BASE_URL',
    'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN'].map(name => process.env[name]).filter((item): item is string => Boolean(item));
  const sensitiveKeys = new Set(['password', 'credential', 'credentials', 'secret', 'clientsecret', 'authorization',
    'authorizationheader', 'cookie', 'cookies', 'authcookie', 'setcookie', 'token', 'accesstoken', 'refreshtoken',
    'claimtoken', 'idtoken', 'bearertoken', 'apikey', 'azurefoundryapikey', 'azureopenaiapikey', 'databaseurl',
    'connectionstring', 'sessionid', 'sessiontoken', 'searchid', 'preparedid', 'preparedref', 'prepareref',
    'preparedtoken', 'nativehandle', 'requestheaders', 'awsaccesskeyid', 'awssecretaccesskey', 'awssessiontoken']);
  return JSON.stringify(value, (key, item: unknown) => {
    if (sensitiveKeys.has(key.replace(/[^a-z0-9]/gi, '').toLowerCase())) return '[redacted]';
    if (item instanceof Uint8Array) return { sourceBinaryArchived: true, bytes: item.byteLength,
      sha256: createHash('sha256').update(item).digest('hex') };
    if (typeof item === 'string') {
      let safe = item;
      for (const secret of secrets) safe = safe.replaceAll(secret, '[redacted]');
      return safe.replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer [redacted]')
        .replace(/([?&](?:token|password|signature|sig|access_token)=)[^&\s"<>]+/gi, '$1[redacted]')
        .replace(/(postgres(?:ql)?:\/\/[^:\s/@]+:)[^@\s]+@/gi, '$1[redacted]@');
    }
    return item;
  });
}

async function runPreflight(selectionPath: string, sealPath?: string) {
  const environment = await assertLaunchEnvironment(true);
  const inputs = await loadInputs(selectionPath, sealPath);
  const imports = await verifyImports();
  const selectedThreads = new Set(inputs.cases.map(row => row.threadId));
  const output = { status: 'ready', phase: 'preflight', sourceVersion: environment.sourceVersion,
    sourceLabel: 'current checked-out product source', capturedConfigCheckedAtUtc: inputs.deployment.checked_at_utc,
    configLabel: 'captured historical config snapshot; not fresh PM2 verification', selectionCount: inputs.cases.length,
    selectionSha256: inputs.selectionSha256, sealSha256: inputs.sealSha256, sealed: inputs.sealSha256 !== null,
    workflows: [...new Set(inputs.cases.map(row => row.workflow))].sort(), threadCount: selectedThreads.size,
    artifacts: inputs.artifactHashes, sourceHashes: inputs.sourceHashes, routeIdentityHash: inputs.routeIdentityHash,
    cacheMode: 'production default native reader; current state; historical validity unresolved',
      nativeReaderMode: 'production-default',
    imports, database: environment.database ?? 'launcher identity verified by parent; no connection made',
    databaseConnected: false, databaseSeeded: false, modelCalls: 0, nativeCalls: 0,
    sourceCutoffsMatched: true, packetHashesVerified: true };
  console.info(JSON.stringify(output));
}

async function runCohort(selectionPath: string, sealPath: string | undefined, confirmSelection: string | undefined,
  confirmSeal: string | undefined, concurrency: number) {
  const environment = await assertLaunchEnvironment(false);
  if (!sealPath) throw new Error('SEALED_CASE_ID_FILE_REQUIRED');
  const inputs = await loadInputs(selectionPath, sealPath);
  if (inputs.cases.length < 40 || inputs.cases.length > 60) throw new Error('FINAL_COHORT_MUST_HAVE_40_TO_60_CASES');
  if (confirmSelection !== inputs.selectionSha256 || confirmSeal !== inputs.sealSha256) throw new Error('FINAL_SELECTION_HASH_CONFIRMATION_MISMATCH');
  const base = process.env.FRESH_REPLAY_ROOT!;
  const runId = `wave1-${new Date().toISOString().replace(/[:.]/g, '-')}-${inputs.selectionSha256.slice(0, 12)}`;
  const runDir = join(base, 'runs', runId);
  await mkdir(runDir, { recursive: true, mode: 0o700 });
  const shotsDir = join(runDir, 'shots');
  await mkdir(shotsDir, { recursive: true, mode: 0o700 });
  process.env.HMS_SHOTS_DIR = shotsDir;
  const database = createDb(process.env.DATABASE_URL!);
  __setDbForTests(database);
  const startedAt = new Date().toISOString();
  const resultsPath = join(runDir, 'results.jsonl');
  const summaryPath = join(runDir, 'summary.json');
  let resultWrites = Promise.resolve();
  const summaries: Record<string, unknown>[] = [];
  try {
    const db = database.db;
    const count = async (table: typeof message | typeof mailThread | typeof attachment | typeof aiWorkflowRun | typeof workItem) => {
      const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(table);
      return row?.count ?? 0;
    };
    const [workflowCount, workItemCount] = await Promise.all([count(aiWorkflowRun), count(workItem)]);
    if (workflowCount || workItemCount) throw new Error('REPLAY_DATABASE_HAS_PRIOR_WORKFLOW_ATTEMPTS');
    const storage = createReplayStorage();
    const seeded = await seedMailbox(db, SOURCE_INDEX, MAILBOX_ADDRESS);
    const seededAttachments = await seedAllRecoveredAttachments({ db, storage, recovered: inputs.recovered });
    const gateway = await createEvidenceGateway(join(runDir, 'native-cache'), { catalogPath: CACHE_CATALOG });

    const sortedCases = [...inputs.cases].sort((a, b) => a.threadId.localeCompare(b.threadId) || a.cutoff.localeCompare(b.cutoff));
    const lanes = new Map<string, WaveCase[]>();
    for (const item of sortedCases) lanes.set(item.threadId, [...(lanes.get(item.threadId) ?? []), item]);
    const manifest = { sourceVersion: environment.sourceVersion,
      sourceLabel: 'current checked-out product source', capturedConfigCheckedAtUtc: inputs.deployment.checked_at_utc,
      configLabel: 'captured historical config snapshot; not fresh PM2 verification', modelId: 'gpt-6-luna',
      reasoningEffort: 'high', cacheMode: 'production default native reader; current state; historical validity unresolved',
      nativeReaderMode: 'production-default',
      selectionSha256: inputs.selectionSha256, sealSha256: inputs.sealSha256, artifactHashes: inputs.artifactHashes,
      sourceHashes: inputs.sourceHashes,
      routeIdentityHash: inputs.routeIdentityHash, cases: inputs.cases.map(row => ({ decisionId: row.decisionId,
        selectedSourceRowId: row.selectedSourceRowId, workflow: row.workflow, journeyId: row.journeyId,
        cutoff: row.cutoff, packetPath: row.packetPath, packetSha256: row.packetSha256,
        packetLine: row.packetLine, packetLineSha256: row.packetLineSha256, threadId: row.threadId })),
      concurrency, threadLaneCount: lanes.size, seeded, seededAttachments: { registered: seededAttachments.registered,
        unavailable: seededAttachments.unavailable.length }, startedAt };
    await writeFile(join(runDir, 'manifest.json'), serializeArtifact(manifest), { mode: 0o600 });
    console.info(JSON.stringify({ status: 'running', phase: 'wave1-current-v2', pending: inputs.cases.length,
      concurrency, runDir }));

    const originalById = inputs.originalById;
    const failures = new Map<string, string>();
    const summaryCounts = () => {
      const exceptionCount = failures.size;
      const workflowFailedCount = summaries.filter(row => row.workflowFailed === true).length;
      return { failures: exceptionCount + workflowFailedCount, exceptionCount, workflowFailedCount,
        prefillFailedCount: summaries.filter(row => row.status === 'failed').length,
        nativeIncompleteCount: summaries.filter(row => row.checksIncomplete === true).length };
    };
    async function executeOne(item: WaveCase) {
      const began = Date.now();
      try {
        const original = originalById.get(item.selectedSourceRowId);
        const [actual] = await db.select({ id: message.id, threadId: message.threadId, textBody: message.textBody,
          htmlBody: message.htmlBody, subject: message.subject, fromAddress: message.fromAddress,
          arrivedAt: MESSAGE_ARRIVED_AT }).from(message)
          .where(and(eq(message.id, item.selectedSourceRowId), eq(message.transportId, 'transport-centurion'))).limit(1);
        if (!original || !actual || actual.threadId !== original.thread_id || actual.subject !== original.subject ||
            actual.textBody !== original.text_body || actual.htmlBody !== original.html_body ||
            actual.fromAddress.toLowerCase() !== (original.from_address ?? '').toLowerCase() ||
            actual.arrivedAt?.toISOString() !== item.cutoff || staffQuoteSourceHash(actual) !== staffQuoteSourceHash({
              id: original.id, subject: original.subject, textBody: original.text_body, htmlBody: original.html_body }))
          throw new Error(`SOURCE_CASE_BINDING_MISMATCH:${item.decisionId}`);
        const result = await runCurrentV2Case({ db, sourceMessageId: actual.id, expectedCutoff: item.cutoff,
          mailboxAddress: MAILBOX_ADDRESS, gateway, privateDir: process.env.FRESH_REPLAY_ROOT!,
          signal: AbortSignal.timeout(16 * 60_000) });
        const attachmentSources = inputs.sourceAttachments.filter(file => {
          const source = originalById.get(file.message_id);
          return source?.thread_id === item.threadId && source.received_at !== null && source.received_at !== undefined &&
            new Date(source.received_at).getTime() <= new Date(item.cutoff).getTime();
        }).map(file => ({ messageId: file.message_id, attachmentId: file.id, filename: file.filename,
          mimeType: file.mime_type, sha256: file.sha256 ?? null, bytes: file.size_bytes ?? null }));
        const record = { type: 'case_result', decisionId: item.decisionId, workflow: item.workflow,
          journeyId: item.journeyId, selectedSourceRowId: item.selectedSourceRowId, cutoff: item.cutoff,
          packetPath: item.packetPath, packetSha256: item.packetSha256, packetLine: item.packetLine,
          packetLineSha256: item.packetLineSha256, originalMessageSourceHash: result.source.sourceHash,
          reservationEvidenceHash: result.evidenceHash, attachmentSources, result };
        resultWrites = resultWrites.then(() => appendFile(resultsPath, `${serializeArtifact(record)}\n`, { mode: 0o600 }));
        await resultWrites;
        summaries.push({ decisionId: item.decisionId, status: result.persistedDraft.prefill?.status ?? 'missing',
          workflowFailed: result.workflowFailed, checksIncomplete: result.checksIncomplete,
          nativeStatus: result.nativeStatus, modelCalls: result.modelCalls.length, nativeObservationCount: result.candidateReads.length,
          seconds: Math.round((Date.now() - began) / 100) / 10 });
      } catch (error) {
        const failure = conciseError(error);
        failures.set(item.decisionId, failure);
        const record = { type: 'case_failure', decisionId: item.decisionId, workflow: item.workflow,
          journeyId: item.journeyId, selectedSourceRowId: item.selectedSourceRowId, cutoff: item.cutoff,
          packetPath: item.packetPath, packetSha256: item.packetSha256, packetLine: item.packetLine,
          packetLineSha256: item.packetLineSha256, failure,
          trace: error instanceof ReplayExecutionError ? error.trace : undefined };
        resultWrites = resultWrites.then(() => appendFile(resultsPath, `${serializeArtifact(record)}\n`, { mode: 0o600 }));
        await resultWrites;
        summaries.push({ decisionId: item.decisionId, status: 'failure', failure,
          seconds: Math.round((Date.now() - began) / 100) / 10 });
      }
      const summary = { updatedAt: new Date().toISOString(), completed: summaries.length, total: inputs.cases.length,
        ...summaryCounts(), summaries: [...summaries] };
      const serializedSummary = serializeArtifact(summary);
      resultWrites = resultWrites.then(() => writeFile(summaryPath, serializedSummary, { mode: 0o600 }));
      await resultWrites;
      const caseSummary = summaries.find(row => row.decisionId === item.decisionId)!;
      console.info(JSON.stringify({ status: failures.has(item.decisionId) ? 'exception' : caseSummary.workflowFailed ? 'workflow_failure' : 'complete',
        decisionId: item.decisionId, completed: summaries.length, total: inputs.cases.length,
        modelCalls: (caseSummary.modelCalls as number | undefined) ?? 0,
        candidateReads: (caseSummary.candidateReads as number | undefined) ?? 0,
        seconds: (caseSummary.seconds as number | undefined) ?? 0 }));
    }

    const laneQueue = [...lanes.values()];
    let nextLane = 0;
    async function worker() {
      while (nextLane < laneQueue.length) {
        const lane = laneQueue[nextLane++]!;
        for (const item of lane) await executeOne(item);
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, laneQueue.length) }, worker));
    await resultWrites;
    await writeFile(summaryPath, serializeArtifact({ completed: summaries.length, total: inputs.cases.length,
      ...summaryCounts(), summaries, finishedAt: new Date().toISOString() }), { mode: 0o600 });
    if (summaryCounts().failures) process.exitCode = 2;
  } finally {
    __setDbForTests(null);
    await database.conn.end();
  }
}

async function main() {
  const selectionPath = readArg('--selection', DEFAULT_SELECTION)!;
  const sealPath = readArg('--seal', DEFAULT_SEAL);
  const concurrency = Number(readArg('--concurrency', '4'));
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 4) throw new Error('CONCURRENCY_MUST_BE_1_TO_4');
  const modes = Number(hasFlag('--preflight')) + Number(hasFlag('--run'));
  if (modes !== 1) throw new Error('CHOOSE_EXACTLY_ONE_OF_PRELIGHT_OR_RUN');
  if (hasFlag('--preflight')) return runPreflight(selectionPath, sealPath);
  return runCohort(selectionPath, sealPath, readArg('--confirm-selection-sha256'),
    readArg('--confirm-seal-sha256'), concurrency);
}

main().catch(error => {
  console.error(JSON.stringify({ status: 'error', error: conciseError(error) }));
  process.exitCode = 1;
});
