/**
 * Pane-path proof runner. Proof cells go through the same server functions the tRPC routes call
 * (`runPaneStay`, `previewCancel`/`commitCancel`, `previewAmend`/`commitAmend`, `spawnAttachDocument`,
 * `findStay`) after the U1 transport resolver and `createPostgresPropertyReadLock`. Writes refuse unless
 * the request is Labtest + arrival ≥ 2027 and `PANE_WRITE_*=lab`. Output is one JSON line plus screenshots
 * in `--out`.
 *
 * `queueUserHmsJob` only enqueues find/search_guest/party/availability/staff_quote and needs a thread/user
 * this CLI does not take, so find calls `findStay` (the pane's in-place path). `hms-job-proof.ts` covers the
 * queue. Attach calls `spawnAttachDocument` under the lock; `runPaneHmsWriteOnce` needs a claimed DB run.
 *
 *   node --import tsx src/ops/hms-proof-run.ts create|amend|cancel|attach|find \
 *     --transport <id> --request '<json-or-file>' --mode preview|commit --out <dir>
 */
import { paneStayHmsTargetForTransport } from '../ai/pane-stay-spawn-env.js';
import {
  paneStaySaveLoaders,
  paneStayTenantId,
  paneWriteModes,
  PANE_PREVIEW_TTL_MS,
  readPaneStayScreenshot,
  recordPanePreview,
  registerPaneRun,
  runPaneStay,
  type PaneStay,
  type PaneStayLock,
} from '../ai/pane-stay-save.js';
import { paneStayCancelLoaders, previewCancel, commitCancel } from '../ai/pane-stay-cancel.js';
import {
  paneHmsWriteLoaders,
  previewAmend,
  commitAmend,
  paneHmsWriteMode,
  spawnAttachDocument,
  type AmendRequest,
} from '../ai/pane-hms-write.js';
import { findStay, paneStayLookupLoaders } from '../ai/pane-stay-lookup.js';
import {
  acquisitionWithin,
  createPostgresPropertyReadLock,
  PANE_PROPERTY_LOCK_WAIT_MS,
} from '../hms/property-read-lock.js';
import type { HmsReadTarget } from '../hms/hms-read-target.js';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const COMMANDS = new Set(['create', 'amend', 'cancel', 'attach', 'find']);
const REQUIRED_FLAGS = new Set(['--transport', '--request', '--mode', '--out']);
const OPTIONAL_FLAGS = new Set(['--cell']);
const FLAGS = new Set([...REQUIRED_FLAGS, ...OPTIONAL_FLAGS]);
const MODES = new Set(['preview', 'commit']);
const CELL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const DEFAULT_HOLD_FILE = '/tmp/mh1024/HOLD.txt';
const DEFAULT_CELL_DIR = '/tmp/mh1024';
const LABTEST = /^labtest$/i;
const LAB_ARRIVAL_FLOOR = '2027-01-01';
const OWNER_PREFIX = 'proof:';
const GRANT_FILE = 'preview-grant.json';
const STAY_KEYS = [
  'firstName',
  'lastName',
  'arrival',
  'departure',
  'adults',
  'sourceOfBusiness',
  'roomType',
  'ratePlan',
  'track',
  'guaranteeType',
  'childAges',
  'bookingAgency',
  'organization',
  'reservationNote',
  'bookerName',
  'bookerEmail',
] as const;

export type ProofRunCommand = 'create' | 'amend' | 'cancel' | 'attach' | 'find';
export type ProofRunMode = 'preview' | 'commit';

export type ProofRunArgs = {
  command: ProofRunCommand;
  transportId: string;
  request: Record<string, unknown>;
  mode: ProofRunMode;
  outDir: string;
  cell?: string;
};

export type ProofLockFactory = (input: {
  tenantId: string;
  propertyCode: string;
  databaseUrl: string;
}) => PaneStayLock & { key?: string };

export function parseProofRunArgs(argv: string[]): ProofRunArgs {
  const [command, ...rest] = argv;
  if (!command || !COMMANDS.has(command)) {
    throw new Error('usage: hms-proof-run.ts create|amend|cancel|attach|find --flags');
  }
  const values = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index]!;
    const value = rest[index + 1];
    if (!FLAGS.has(flag)) throw new Error(`unknown argument: ${flag}`);
    if (value === undefined || value.startsWith('--') || value.trim() === '') {
      throw new Error(`missing value for ${flag}`);
    }
    if (values.has(flag)) throw new Error(`repeated argument: ${flag}`);
    values.set(flag, value);
  }
  const missing = [...REQUIRED_FLAGS].find((flag) => !values.has(flag));
  if (missing) throw new Error(`required: ${missing}`);
  const mode = values.get('--mode')!;
  if (!MODES.has(mode)) throw new Error('--mode must be preview or commit');
  const cell = values.get('--cell');
  if (cell !== undefined && !CELL_ID.test(cell)) throw new Error('--cell must be a short id');
  return {
    command: command as ProofRunCommand,
    transportId: values.get('--transport')!,
    request: parseRequestJson(values.get('--request')!),
    mode: mode as ProofRunMode,
    outDir: values.get('--out')!,
    ...(cell ? { cell } : {}),
  };
}

export function assertRunHold(env: NodeJS.Dict<string> = process.env): void {
  const hold = env.NAVA_RUN_HOLD_FILE?.trim() || DEFAULT_HOLD_FILE;
  if (existsSync(hold) && statSync(hold).isFile()) {
    throw new Error(`refused_hold:${hold}`);
  }
}

type CellLog = { failures: number[] };

function cellLogPath(dir: string, cell: string): string {
  return join(dir, `cell-${cell}.json`);
}

export function cellDiagnosisPath(dir: string, cell: string): string {
  return join(dir, `diagnosis-${cell}.md`);
}

function readCellLog(dir: string, cell: string): CellLog {
  const path = cellLogPath(dir, cell);
  if (!existsSync(path)) return { failures: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { failures?: unknown };
    const failures = Array.isArray(parsed.failures)
      ? parsed.failures.filter((item): item is number => typeof item === 'number')
      : [];
    return { failures };
  } catch {
    return { failures: [] };
  }
}

export function recordCellFailure(input: { cell: string; dir: string; at?: number }): void {
  mkdirSync(input.dir, { recursive: true });
  const log = readCellLog(input.dir, input.cell);
  log.failures.push(input.at ?? Date.now());
  writeFileSync(cellLogPath(input.dir, input.cell), `${JSON.stringify(log)}\n`);
}

export function assertCellAttempt(input: { cell: string; dir: string }): void {
  const log = readCellLog(input.dir, input.cell);
  if (log.failures.length < 2) return;
  const lastFailure = Math.max(...log.failures);
  const diagnosis = cellDiagnosisPath(input.dir, input.cell);
  if (!existsSync(diagnosis) || statSync(diagnosis).mtimeMs <= lastFailure) {
    throw new Error(`refused_cell_attempt:${basename(diagnosis)}`);
  }
}

function parseRequestJson(raw: string): Record<string, unknown> {
  const text = raw.trim().startsWith('{') ? raw : readFileSync(raw, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('--request must be JSON or a JSON file');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('--request must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

function textField(request: Record<string, unknown>, key: string): string {
  const nested =
    request.stay && typeof request.stay === 'object' && !Array.isArray(request.stay)
      ? (request.stay as Record<string, unknown>)[key]
      : undefined;
  const value = request[key] ?? nested;
  return typeof value === 'string' ? value.trim() : '';
}

function assertLabRequest(request: Record<string, unknown>): void {
  const stay = stayFromProofRequest(request);
  const lastName =
    typeof stay.lastName === 'string' && stay.lastName.trim() !== ''
      ? stay.lastName.trim()
      : textField(request, 'lastName');
  const arrival =
    typeof stay.arrival === 'string' && stay.arrival.trim() !== ''
      ? stay.arrival.trim()
      : textField(request, 'arrival');
  if (!LABTEST.test(lastName) || arrival < LAB_ARRIVAL_FLOOR) {
    throw new Error('refused_not_lab');
  }
}

function assertWriteFlagsLab(command: ProofRunCommand, env: NodeJS.Dict<string>): void {
  if (command === 'find') return;
  const modes = paneWriteModes(env);
  const needed =
    command === 'create'
      ? modes.create
      : command === 'amend'
        ? modes.amendUnpaid
        : command === 'cancel'
          ? modes.cancelUnpaid
          : paneHmsWriteMode(env);
  if (needed === 'off') throw new Error('refused_write_not_lab');
}

function previewDigestOf(request: Record<string, unknown>): string | undefined {
  const digest = request.previewDigest;
  return typeof digest === 'string' && digest.trim() !== '' ? digest.trim() : undefined;
}

export function stayFromProofRequest(request: Record<string, unknown>): PaneStay {
  const nested =
    request.stay && typeof request.stay === 'object' && !Array.isArray(request.stay)
      ? (request.stay as Record<string, unknown>)
      : request;
  const stay: Record<string, unknown> = {};
  for (const key of STAY_KEYS) {
    if (nested[key] !== undefined) stay[key] = nested[key];
  }
  return stay as PaneStay;
}

function asAmendFields(request: Record<string, unknown>): AmendRequest {
  const fields = request.fields;
  return fields && typeof fields === 'object' && !Array.isArray(fields)
    ? (fields as AmendRequest)
    : {};
}

function stripGuest(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(stripGuest);
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (/^(lastName|firstName|stay|expectedLastName|name)$/i.test(key)) continue;
    out[key] = stripGuest(item);
  }
  return out;
}

function screenshotNames(screenshots: unknown): string[] {
  if (!Array.isArray(screenshots)) return [];
  return screenshots
    .filter((name): name is string => typeof name === 'string')
    .map((name) => basename(name));
}

async function copyScreenshots(input: {
  outDir: string;
  screenshots: unknown;
  runDir: unknown;
  runId: unknown;
  owner: string;
}): Promise<string[]> {
  const names = screenshotNames(input.screenshots);
  const copied: string[] = [];
  for (const file of names) {
    const dest = join(input.outDir, file);
    if (typeof input.runDir === 'string') {
      const from = isAbsolute(file) ? file : join(input.runDir, file);
      await copyFile(from, dest);
      copied.push(file);
      continue;
    }
    if (typeof input.runId === 'string') {
      const shot = await readPaneStayScreenshot({
        runId: input.runId,
        name: file,
        owner: input.owner,
      });
      if (shot.status !== 'ok') throw new Error('screenshot_copy_failed');
      const bytes = Buffer.from(shot.dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64');
      await writeFile(dest, bytes);
      copied.push(file);
    }
  }
  if (copied.length !== names.length) throw new Error('screenshot_copy_failed');
  return copied;
}

function restorePreviewGrant(outDir: string, owner: string, digest: string | undefined): void {
  if (!digest) return;
  const path = join(outDir, GRANT_FILE);
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as {
      owner?: unknown;
      digest?: unknown;
      expiresAt?: unknown;
    };
    const expiresAt = raw.expiresAt;
    const valid =
      raw.owner === owner &&
      raw.digest === digest &&
      typeof expiresAt === 'number' &&
      expiresAt > Date.now();
    unlinkSync(path);
    if (!valid) return;
    recordPanePreview(owner, digest, expiresAt - PANE_PREVIEW_TTL_MS);
  } catch {
    // Missing or expired grant: the pane commit path refuses. Fail closed.
  }
}

async function persistPreviewGrant(
  outDir: string,
  owner: string,
  result: unknown,
): Promise<void> {
  const digest =
    result && typeof result === 'object'
      ? (result as { previewDigest?: unknown }).previewDigest
      : undefined;
  if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) return;
  const grant = { owner, digest, expiresAt: Date.now() + PANE_PREVIEW_TTL_MS };
  await writeFile(join(outDir, GRANT_FILE), `${JSON.stringify(grant)}\n`, { mode: 0o600 });
}

function defaultCreateLock(input: {
  tenantId: string;
  propertyCode: string;
  databaseUrl: string;
}): PaneStayLock & { key?: string } {
  const lock = createPostgresPropertyReadLock(input);
  return {
    key: lock.key,
    withLock: (fn, acquisition) => lock.withLock(() => fn(), acquisition),
  };
}

export async function hmsProofRun(
  args: ProofRunArgs,
  env: NodeJS.Dict<string> = process.env,
  createLock: ProofLockFactory = defaultCreateLock,
): Promise<Record<string, unknown>> {
  assertRunHold(env);
  const cellDir = env.NAVA_PROOF_CELL_DIR?.trim() || DEFAULT_CELL_DIR;
  if (args.cell) assertCellAttempt({ cell: args.cell, dir: cellDir });
  const resolved = paneStayHmsTargetForTransport(args.transportId);
  if (!resolved.ok) throw new Error('unknown_transport');
  assertLabRequest(args.request);
  assertWriteFlagsLab(args.command, env);
  if (args.command === 'attach' && args.mode !== 'commit') {
    throw new Error('attach_preview_unsupported');
  }
  if (
    args.command !== 'find' &&
    args.command !== 'attach' &&
    args.mode === 'commit' &&
    !previewDigestOf(args.request)
  ) {
    throw new Error('preview_digest_required');
  }
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error('refused_lock_unavailable');
  const lock = createLock({
    tenantId: paneStayTenantId(env),
    propertyCode: resolved.target.propertyCode,
    databaseUrl,
  });
  const owner = `${OWNER_PREFIX}${args.transportId}`;
  const prev = {
    save: paneStaySaveLoaders.lock,
    cancel: paneStayCancelLoaders.lock,
    write: paneHmsWriteLoaders.lock,
    lookup: paneStayLookupLoaders.lock,
  };
  paneStaySaveLoaders.lock = lock;
  paneStayCancelLoaders.lock = lock;
  paneHmsWriteLoaders.lock = lock;
  paneStayLookupLoaders.lock = lock;
  try {
    if (args.mode === 'commit' && args.command !== 'find' && args.command !== 'attach') {
      restorePreviewGrant(args.outDir, owner, previewDigestOf(args.request));
    }
    const result = await runCommand(args, resolved.target, lock, owner);
    await mkdir(args.outDir, { recursive: true });
    if (args.mode === 'preview') await persistPreviewGrant(args.outDir, owner, result);
    const record = result as Record<string, unknown>;
    const screenshots = await copyScreenshots({
      outDir: args.outDir,
      screenshots: record.screenshots,
      runDir: record.runDir,
      runId: record.runId,
      owner,
    });
    const line = {
      command: args.command,
      propertyCode: resolved.target.propertyCode,
      ...(typeof lock.key === 'string' ? { lockKey: lock.key } : {}),
      ...(stripGuest(result) as Record<string, unknown>),
      screenshots,
    };
    if (args.cell && proofFailed(line)) {
      recordCellFailure({ cell: args.cell, dir: cellDir });
    }
    return line;
  } catch (error) {
    if (args.cell) recordCellFailure({ cell: args.cell, dir: cellDir });
    throw error;
  } finally {
    paneStaySaveLoaders.lock = prev.save;
    paneStayCancelLoaders.lock = prev.cancel;
    paneHmsWriteLoaders.lock = prev.write;
    paneStayLookupLoaders.lock = prev.lookup;
  }
}

async function runCommand(
  args: ProofRunArgs,
  target: HmsReadTarget,
  lock: PaneStayLock,
  owner: string,
): Promise<unknown> {
  const confirmation = textField(args.request, 'confirmation');
  const arrival = textField(args.request, 'arrival');
  const lastName = textField(args.request, 'lastName');
  const digest = previewDigestOf(args.request);
  if (args.command === 'find') {
    return findStay(
      { confirmation, arrival },
      {
        lock: () => lock,
        target,
        onRun: ({ runId, dir }) => registerPaneRun({ runId, dir, owner, now: Date.now() }),
      },
    );
  }
  if (args.command === 'create') {
    return runPaneStay({
      mode: args.mode,
      stay: stayFromProofRequest(args.request),
      owner,
      previewDigest: digest,
      transportId: args.transportId,
    });
  }
  if (args.command === 'cancel') {
    const input = { confirmation, arrival, owner, transportId: args.transportId };
    return args.mode === 'commit'
      ? commitCancel({
          ...input,
          reason: textField(args.request, 'reason'),
          previewDigest: digest,
        })
      : previewCancel(input);
  }
  if (args.command === 'amend') {
    const input = {
      confirmation,
      arrival,
      lastName,
      fields: asAmendFields(args.request),
      owner,
    };
    return args.mode === 'commit'
      ? commitAmend({ ...input, previewDigest: digest ?? '' })
      : previewAmend(input);
  }
  const file = textField(args.request, 'file');
  const documentName = textField(args.request, 'documentName') || 'proof.pdf';
  if (!file) throw new Error('required: request.file');
  return lock.withLock(
    () => spawnAttachDocument({ confirmation, arrival, file, documentName, target }),
    acquisitionWithin(PANE_PROPERTY_LOCK_WAIT_MS),
  );
}

function proofFailed(result: Record<string, unknown>): boolean {
  if (result.status === 'refused') return true;
  const outcome = result.outcome;
  return typeof outcome === 'string' && /refus|fail|execution_failure/.test(outcome);
}

function proofExitCode(result: Record<string, unknown>): number {
  return proofFailed(result) ? 2 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  Promise.resolve()
    .then(() => hmsProofRun(parseProofRunArgs(process.argv.slice(2))))
    .then(
      (result) => {
        process.stdout.write(`${JSON.stringify(result)}\n`);
        process.exit(proofExitCode(result));
      },
      (error: unknown) => {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exit(2);
      },
    );
}
