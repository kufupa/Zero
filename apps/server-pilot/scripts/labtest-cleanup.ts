/**
 * Labtest cleanup. Lists Reserved Labtest stays with arrival >= 2027-01-01 per hotel.
 * Dry-run by default. --apply calls hms-proof-run cancel preview then commit.
 * Never cancel-stay.mjs. Masked confs only. No live mail.
 *
 *   pnpm --dir apps/server-pilot exec tsx scripts/labtest-cleanup.ts \
 *     --in stays.json [--property HRCEN|HRDAV] [--apply] [--out report.json]
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const LAB_ARRIVAL_FLOOR = '2027-01-01';
export const PROOF_RUN_REL = 'src/ops/hms-proof-run.ts';
export const CLEANUP_CANCEL_REASON = 'Test Reservations';
const COMMIT_OK = new Set(['cancelled', 'already_cancelled']);

export type HotelCode = 'HRCEN' | 'HRDAV';
export type CleanupAction = 'would_cancel' | 'cancelled' | 'skipped';
export type CleanupReason =
  | 'not_lab'
  | 'arrival_before_floor'
  | 'not_reserved'
  | 'invalid_arrival'
  | 'missing_confirmation'
  | 'unknown_property'
  | 'preview_digest_missing'
  | 'preview_failed'
  | 'commit_failed';

export type InventoryStay = {
  propertyCode: HotelCode | string;
  confirmation: string;
  lastName: string;
  firstName?: string;
  arrival: string;
  status: string;
};

export type CleanupCli = {
  inPath: string;
  outPath?: string;
  property?: HotelCode;
  apply: boolean;
};

export type ProofCancelCall = {
  tool: typeof PROOF_RUN_REL;
  command: 'cancel';
  transportId: string;
  request: Record<string, unknown>;
  mode: 'preview' | 'commit';
  outDir: string;
  argv: string[];
};

export type ProofCancelResult = {
  previewDigest?: string;
  outcome?: string;
  status?: string;
};

export type ProofCancelRunner = (call: ProofCancelCall) => Promise<ProofCancelResult>;

export type CleanupRow = {
  propertyCode: HotelCode;
  confirmation: string;
  arrival: string;
  status: string;
  action: CleanupAction;
  reason: CleanupReason | null;
};

export type HotelCounts = { listed: number; skipped: number; cancelled: number };

export type CleanupReport = {
  mode: 'dry-run' | 'apply';
  byHotel: Record<HotelCode, HotelCounts>;
  stays: CleanupRow[];
};

export type CleanupRunOptions = {
  apply?: boolean;
  property?: HotelCode;
  cancel?: ProofCancelRunner;
  workDir?: string;
};

const USAGE = 'labtest-cleanup.ts --in <stays.json> [--property HRCEN|HRDAV] [--apply] [--out report.json]';
const LABTEST = /^labtest$/i;
const TRANSPORT: Record<HotelCode, string> = {
  HRCEN: 'transport-centurion',
  HRDAV: 'transport-davinci',
};
const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function codedError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

function emptyCounts(): Record<HotelCode, HotelCounts> {
  return {
    HRCEN: { listed: 0, skipped: 0, cancelled: 0 },
    HRDAV: { listed: 0, skipped: 0, cancelled: 0 },
  };
}

function asHotel(value: string): HotelCode | null {
  return value === 'HRCEN' || value === 'HRDAV' ? value : null;
}

function isLocalPath(value: string): boolean {
  return !/^(postgres|postgresql|https?):\/\//i.test(value);
}

export function parseLabtestCleanupArgs(argv: readonly string[]): CleanupCli {
  const flags = new Map<string, string>();
  let apply = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--help' || arg === '-h') throw codedError('usage');
    if (arg === '--apply') {
      apply = true;
      continue;
    }
    if (arg === '--in' || arg === '--out' || arg === '--property') {
      const value = argv[i + 1];
      if (!value || value.startsWith('-')) throw codedError('usage');
      flags.set(arg, value);
      i += 1;
      continue;
    }
    throw codedError('unknown_option');
  }
  const inPath = flags.get('--in');
  if (!inPath) throw codedError('usage');
  const outPath = flags.get('--out');
  const propertyRaw = flags.get('--property');
  const property = propertyRaw ? asHotel(propertyRaw) : undefined;
  if (propertyRaw && !property) throw codedError('unknown_property');
  for (const candidate of [inPath, outPath]) {
    if (candidate && !isLocalPath(candidate)) throw codedError('local_paths_only');
  }
  return { inPath, apply, ...(outPath ? { outPath } : {}), ...(property ? { property } : {}) };
}

export function maskConfirmation(conf: string): string {
  const trimmed = conf.trim();
  const dash = trimmed.lastIndexOf('-');
  const number = dash === -1 ? trimmed : trimmed.slice(0, dash);
  const suffix = dash === -1 ? '' : trimmed.slice(dash);
  if (number.length <= 4) return `****${suffix}`;
  return `${'*'.repeat(number.length - 4)}${number.slice(-4)}${suffix}`;
}

function arrivalDay(value: string): string | null {
  const raw = value.trim();
  const day = raw.length >= 10 ? raw.slice(0, 10) : raw;
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}

function skipReason(stay: InventoryStay): CleanupReason | null {
  const hotel = asHotel(String(stay.propertyCode ?? '').trim());
  if (!hotel) return 'unknown_property';
  if (!String(stay.confirmation ?? '').trim()) return 'missing_confirmation';
  const arrival = arrivalDay(String(stay.arrival ?? ''));
  if (!arrival) return 'invalid_arrival';
  if (arrival < LAB_ARRIVAL_FLOOR) return 'arrival_before_floor';
  if (!LABTEST.test(String(stay.lastName ?? '').trim())) return 'not_lab';
  if (String(stay.status ?? '').trim().toLowerCase() !== 'reserved') {
    return 'not_reserved';
  }
  return null;
}

export function selectCleanupStays(
  stays: readonly InventoryStay[],
  property?: HotelCode,
): CleanupRow[] {
  const rows: CleanupRow[] = [];
  for (const stay of stays) {
    const hotel = asHotel(String(stay.propertyCode ?? '').trim());
    if (property && hotel !== property) continue;
    const reason = skipReason(stay);
    const arrival = arrivalDay(String(stay.arrival ?? '')) ?? String(stay.arrival ?? '').trim();
    rows.push({
      propertyCode: hotel ?? 'HRCEN',
      confirmation: maskConfirmation(String(stay.confirmation ?? '')),
      arrival,
      status: String(stay.status ?? '').trim() || 'unknown',
      action: reason ? 'skipped' : 'would_cancel',
      reason,
    });
  }
  return rows;
}

export function buildProofCancelCall(
  stay: InventoryStay,
  mode: 'preview' | 'commit',
  extra: { workDir: string; previewDigest?: string },
): ProofCancelCall {
  const hotel = asHotel(String(stay.propertyCode ?? '').trim());
  if (!hotel) throw codedError('unknown_property');
  const request: Record<string, unknown> = {
    confirmation: stay.confirmation.trim(),
    arrival: arrivalDay(stay.arrival) ?? stay.arrival.trim(),
    lastName: stay.lastName.trim(),
  };
  if (mode === 'commit') {
    request.reason = CLEANUP_CANCEL_REASON;
    if (extra.previewDigest) request.previewDigest = extra.previewDigest;
  }
  const transportId = TRANSPORT[hotel];
  const argv = [
    'cancel',
    '--transport',
    transportId,
    '--request',
    JSON.stringify(request),
    '--mode',
    mode,
    '--out',
    extra.workDir,
  ];
  return {
    tool: PROOF_RUN_REL,
    command: 'cancel',
    transportId,
    request,
    mode,
    outDir: extra.workDir,
    argv,
  };
}

function countRows(rows: readonly CleanupRow[]): Record<HotelCode, HotelCounts> {
  const byHotel = emptyCounts();
  for (const row of rows) {
    const hotel = byHotel[row.propertyCode];
    if (row.action === 'skipped') hotel.skipped += 1;
    else hotel.listed += 1;
    if (row.action === 'cancelled') hotel.cancelled += 1;
  }
  return byHotel;
}

function digestOf(result: ProofCancelResult): string | undefined {
  return typeof result.previewDigest === 'string' && /^[0-9a-f]{64}$/.test(result.previewDigest)
    ? result.previewDigest
    : undefined;
}

export async function spawnProofCancel(
  call: ProofCancelCall,
  extra: { serverRoot?: string } = {},
): Promise<ProofCancelResult> {
  if (call.tool !== PROOF_RUN_REL || call.command !== 'cancel') {
    throw codedError('refused_not_proof_run');
  }
  const serverRoot = extra.serverRoot ?? SERVER_ROOT;
  const tool = path.resolve(serverRoot, call.tool);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', tool, ...call.argv], {
      cwd: serverRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer | string) => {
      stdout += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(codedError('preview_failed'));
        return;
      }
      const line = stdout.trim().split('\n').at(-1) ?? '';
      try {
        resolve(JSON.parse(line) as ProofCancelResult);
      } catch {
        reject(codedError('preview_failed'));
      }
    });
  });
}

export async function runLabtestCleanup(
  stays: readonly InventoryStay[],
  options: CleanupRunOptions = {},
): Promise<CleanupReport> {
  const apply = options.apply === true;
  const workDir = options.workDir ?? path.join('/tmp', 'labtest-cleanup');
  const selected = stays.filter((stay) => {
    const hotel = asHotel(String(stay.propertyCode ?? '').trim());
    return !options.property || hotel === options.property;
  });
  const planned = selectCleanupStays(selected);
  if (!apply) {
    return { mode: 'dry-run', byHotel: countRows(planned), stays: planned };
  }
  if (!options.cancel) throw codedError('cancel_runner_required');
  const rows: CleanupRow[] = [];
  for (let index = 0; index < planned.length; index += 1) {
    const row = planned[index]!;
    const stay = selected[index]!;
    if (row.action === 'skipped') {
      rows.push(row);
      continue;
    }
    let failed: CleanupReason = 'preview_failed';
    const stayDir = path.join(workDir, `stay-${index}`);
    try {
      const preview = await options.cancel(buildProofCancelCall(stay, 'preview', { workDir: stayDir }));
      const previewDigest = digestOf(preview);
      if (!previewDigest) {
        rows.push({ ...row, action: 'skipped', reason: 'preview_digest_missing' });
        continue;
      }
      failed = 'commit_failed';
      const committed = await options.cancel(
        buildProofCancelCall(stay, 'commit', { workDir: stayDir, previewDigest }),
      );
      if (!COMMIT_OK.has(committed.outcome ?? '')) {
        rows.push({ ...row, action: 'skipped', reason: 'commit_failed' });
        continue;
      }
      rows.push({ ...row, action: 'cancelled', reason: null });
    } catch {
      rows.push({ ...row, action: 'skipped', reason: failed });
    }
  }
  return { mode: 'apply', byHotel: countRows(rows), stays: rows };
}

export function formatCleanupStdout(report: CleanupReport): string {
  return `${JSON.stringify(report)}\n`;
}

function parseInventory(text: string): InventoryStay[] {
  const parsed = JSON.parse(text) as { stays?: unknown } | unknown;
  const list = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { stays?: unknown }).stays)
      ? (parsed as { stays: unknown[] }).stays
      : null;
  if (!list) throw codedError('invalid_inventory');
  return list.map((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw codedError('invalid_inventory');
    const stay = row as Record<string, unknown>;
    return {
      propertyCode: String(stay.propertyCode ?? ''),
      confirmation: String(stay.confirmation ?? ''),
      lastName: String(stay.lastName ?? ''),
      firstName: typeof stay.firstName === 'string' ? stay.firstName : undefined,
      arrival: String(stay.arrival ?? ''),
      status: String(stay.status ?? ''),
    };
  });
}

export async function runLabtestCleanupCli(
  argv: readonly string[],
  deps: { cancel?: ProofCancelRunner; workDir?: string } = {},
): Promise<number> {
  let cli: CleanupCli;
  try {
    cli = parseLabtestCleanupArgs(argv);
  } catch (error) {
    const code = error instanceof Error ? error.message : 'usage';
    process.stderr.write(`${JSON.stringify({ error: code, usage: USAGE })}\n`);
    return 2;
  }
  try {
    const inPath = path.resolve(cli.inPath);
    if (!existsSync(inPath)) throw codedError('inventory_not_found');
    const stays = parseInventory(readFileSync(inPath, 'utf8'));
    const report = await runLabtestCleanup(stays, {
      apply: cli.apply,
      property: cli.property,
      workDir: deps.workDir,
      cancel: cli.apply ? (deps.cancel ?? spawnProofCancel) : undefined,
    });
    const stdout = formatCleanupStdout(report);
    process.stdout.write(stdout);
    if (cli.outPath) writeFileSync(path.resolve(cli.outPath), stdout);
    return 0;
  } catch (error) {
    const code =
      error instanceof Error && 'code' in error ? String((error as { code: string }).code) : 'cleanup_failed';
    process.stderr.write(`${JSON.stringify({ error: code })}\n`);
    return 1;
  }
}

const entry = process.argv[1];
if (typeof entry === 'string' && import.meta.url === pathToFileURL(path.resolve(entry)).href) {
  process.exitCode = await runLabtestCleanupCli(process.argv.slice(2));
}
