/**
 * Availability probe for an inbound quote's stays (U10), run as a third hms-job/1 kind.
 *
 * One read per stay on the Hotel Availability screen (fetch-quote.mjs, the view-only quote reader): the stay's dates
 * and each room group's occupancy. No party lookup and no rate code. The read takes the property lock with try-lock
 * (background priority), and the job keeps the result as a dated snapshot (KTD11). Enqueued from hms-jobs.ts only
 * when HMS_JOB_QUEUE=on and HMS_AVAILABILITY_PREFETCH=on.
 */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { z } from 'zod';
import {
  isPropertyReadLockDeadline,
  type PropertyReadLockAcquisitionOptions,
} from '../hms/property-read-lock.js';
import type { ExtractionRow, ExtractionStay } from './extraction/schema.js';
import { paneStaySpawnEnv, warnPaneStaySpawnFailed } from './pane-stay-spawn-env.js';
import { PANE_STAY_PROPERTY_CODE, type PaneStayLock } from './pane-stay-save.js';

const execFileAsync = promisify(execFile);
const QUOTE_TOOL = fileURLToPath(new URL('../../tooling/playwright-quote/fetch-quote.mjs', import.meta.url));
// The quote tool writes under the repo's .private/playwright-quote only (fetchQuote refuses any other output).
const QUOTE_ROOT = fileURLToPath(new URL('../../../../.private/playwright-quote/', import.meta.url));
// A summary read opens the availability screen and reads the grid. Same bound as the pane lookups.
const PROBE_TIMEOUT_MS = 5 * 60_000;
const OPTIONS_KEPT_PER_GROUP = 25;

// Limits of the quote tool's v2 request (quote-contract.mjs): 8 occupancy groups, 30 nights, child ages up to 99.
const MAX_ROOM_GROUPS = 8;
const MAX_NIGHTS = 30;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

export const availabilityRequestSchema = z
  .object({
    kind: z.literal('availability'),
    arrival: z.string().regex(ISO_DAY),
    departure: z.string().regex(ISO_DAY),
    rooms: z
      .array(
        z
          .object({
            // The stated room type, kept for the snapshot's label. It is not sent to HMS: there is no code map yet.
            roomType: z.string().min(1).max(120),
            quantity: z.number().int().min(1).max(99),
            adults: z.number().int().min(1).max(9),
            childAges: z.array(z.number().int().min(0).max(99)).max(9),
          })
          .strict(),
      )
      .min(1)
      .max(MAX_ROOM_GROUPS),
  })
  .strict();
export type AvailabilityRequest = z.infer<typeof availabilityRequestSchema>;

/** A real calendar day in YYYY-MM-DD form. 2026-02-30 and 2026-13-01 are not one. */
function isRealIsoDay(value: string): boolean {
  if (!ISO_DAY.test(value)) return false;
  // Date.parse gives NaN for a month past 12 (toISOString would throw on it), so the check stays inside the parse.
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}

function availabilityRequestForStay(stay: ExtractionStay | null | undefined): AvailabilityRequest | null {
  const arrival = stay?.requested?.arrival;
  const departure = stay?.requested?.departure;
  if (!arrival || !departure || !isRealIsoDay(arrival) || !isRealIsoDay(departure)) return null;
  const nights = (Date.parse(`${departure}T00:00:00Z`) - Date.parse(`${arrival}T00:00:00Z`)) / 86_400_000;
  if (!(nights >= 1 && nights <= MAX_NIGHTS)) return null;
  if (!Array.isArray(stay?.rows) || stay.rows.length === 0) return null;
  // Every row must be complete. A group with no room count or no adults is not invented from a headcount.
  const rooms: unknown[] = [];
  for (const row of stay.rows as ExtractionRow[]) {
    if (!row || !row.roomType || row.rooms === null || row.adultsPerRoom === null) return null;
    rooms.push({
      roomType: row.roomType,
      quantity: row.rooms,
      adults: row.adultsPerRoom,
      childAges: row.childAges ?? [],
    });
  }
  const parsed = availabilityRequestSchema.safeParse({ kind: 'availability', arrival, departure, rooms });
  return parsed.success ? parsed.data : null;
}

/**
 * One probe request per complete stay of a quote extraction (mail_extraction.payload). A stay with an incomplete row,
 * no dates, or a shape the quote tool would refuse yields no request.
 */
export function availabilityRequestsFor(payload: unknown): AvailabilityRequest[] {
  const stays = (payload as { stays?: unknown } | null | undefined)?.stays;
  if (!Array.isArray(stays)) return [];
  return stays.flatMap((stay: ExtractionStay | null) => {
    const request = availabilityRequestForStay(stay);
    return request ? [request] : [];
  });
}

/** The quote tool's v2 request for one probe. Groups carry no room or rate codes, so every room type is read. */
export function quoteRequestFor(request: AvailabilityRequest): Record<string, unknown> {
  return {
    schemaVersion: 2,
    propertyCode: PANE_STAY_PROPERTY_CODE,
    arrivalDate: request.arrival,
    departureDate: request.departure,
    details: 'summary',
    rooms: request.rooms.map((room, index) => ({
      id: `group-${index + 1}`,
      quantity: room.quantity,
      adults: room.adults,
      children: room.childAges.length,
      childAges: room.childAges,
    })),
  };
}

// The parts of the quote tool's result.json the snapshot reads. Everything else stays in the run folder.
type QuoteOption = { room?: { code?: unknown } | null; rate?: { code?: unknown } | null; availability?: unknown } | null;
type QuoteGroup = { id?: unknown; outcome?: unknown; options?: QuoteOption[] } | null;
export type QuoteEnvelope = { outcome?: unknown; observedAt?: unknown; groups?: QuoteGroup[] };

export type AvailabilitySnapshot = {
  /**
   * What the read covered. Room types are not mapped to HMS codes yet, so each group's search is for every room type
   * at that occupancy; the stated room type in the request is a label only. Show it as all-room availability.
   */
  roomScope: 'all_room_types';
  /** The quote tool's outcome for the search: quote, partial, no_match, unavailable, input_gap or execution_failure. */
  searchOutcome: string;
  observedAt: string | null;
  availableOptions: number;
  groups: Array<{
    id: string | null;
    outcome: string | null;
    options: Array<{ room: string | null; rate: string | null; availability: string }>;
  }>;
};

export type AvailabilityProbeResult =
  | ({ outcome: 'read' } & AvailabilitySnapshot)
  | { outcome: 'execution_failure' | 'refused_lock_busy' | 'refused_lock_unavailable' | 'refused_input_invalid' };

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** The snapshot the job stores: outcome per group and the options with their availability. No evidence or screenshots. */
export function availabilitySnapshotOf(result: QuoteEnvelope): AvailabilitySnapshot {
  const groups = (Array.isArray(result.groups) ? result.groups : []).map((group) => {
    const options = Array.isArray(group?.options) ? group.options : [];
    return {
      id: text(group?.id),
      outcome: text(group?.outcome),
      options: options.slice(0, OPTIONS_KEPT_PER_GROUP).map((option) => ({
        room: text(option?.room?.code),
        rate: text(option?.rate?.code),
        availability: text(option?.availability) ?? 'unknown',
      })),
    };
  });
  const availableOptions = groups.reduce(
    (count, group) => count + group.options.filter((option) => option.availability === 'available').length,
    0,
  );
  return {
    roomScope: 'all_room_types',
    searchOutcome: text(result.outcome) ?? 'execution_failure',
    observedAt: text(result.observedAt),
    availableOptions,
    groups,
  };
}

/**
 * Test seam: when set, replaces the spawn of the quote tool. Production runs fetch-quote.mjs. The seam returns the same
 * result.json the tool writes.
 */
export const availabilityProbeLoaders: {
  spawn: ((quote: Record<string, unknown>) => Promise<QuoteEnvelope>) | null;
} = { spawn: null };

// Runs fetch-quote.mjs on one request file and reads its run folder. The folder is removed after the snapshot is read
// (a run folder is ~24 MB with its trace, and the snapshot is what the job keeps).
async function defaultQuoteSpawn(quote: Record<string, unknown>): Promise<QuoteEnvelope> {
  const runId = randomUUID();
  const requestDir = join(QUOTE_ROOT, 'availability-requests');
  const outputDir = join(QUOTE_ROOT, 'availability-runs');
  await mkdir(requestDir, { recursive: true, mode: 0o700 });
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  const requestPath = join(requestDir, `${runId}.json`);
  await writeFile(requestPath, JSON.stringify(quote), { mode: 0o600 });
  let stdout = '';
  try {
    // The tool exits non-zero on refusals and failures but still prints its Evidence line when it wrote a result.
    const run = await execFileAsync(process.execPath, [QUOTE_TOOL, '--request', requestPath, '--output', outputDir], {
      timeout: PROBE_TIMEOUT_MS,
      env: paneStaySpawnEnv(),
    }).catch((error: unknown) => error as { stdout?: string });
    stdout = typeof run.stdout === 'string' ? run.stdout : '';
  } finally {
    await rm(requestPath, { force: true }).catch(() => undefined);
  }
  const evidence = /^Evidence: (.+)$/m.exec(stdout)?.[1];
  if (!evidence) throw new Error('availability_probe_no_result');
  try {
    const { audit: _audit, ...result } = JSON.parse(await readFile(join(evidence, 'result.json'), 'utf8')) as QuoteEnvelope & {
      audit?: unknown;
    };
    return result;
  } finally {
    // ponytail: the run folder is removed here. Quote run folders otherwise pile up on the EC2 disk (plan: Data Handling).
    await rm(evidence, { recursive: true, force: true }).catch(() => undefined);
  }
}

export type AvailabilityProbeDeps = {
  /** The session hotel's property lock. Null means no lock can be made, so the probe is refused. */
  lock: () => PaneStayLock | null;
  acquisition: PropertyReadLockAcquisitionOptions;
};

/**
 * One read for one stay under the property lock. The outcome uses the same vocabulary as the pane lookups, so the job
 * executor settles it the same way: busy and failed reads retry, refusals dead-letter, and a read is a dated snapshot.
 */
export async function probeAvailability(
  request: AvailabilityRequest,
  deps: AvailabilityProbeDeps,
): Promise<AvailabilityProbeResult> {
  const lock = deps.lock();
  if (!lock) return { outcome: 'refused_lock_unavailable' };
  const spawn = availabilityProbeLoaders.spawn ?? defaultQuoteSpawn;
  let result: QuoteEnvelope;
  try {
    result = await lock.withLock(() => spawn(quoteRequestFor(request)), deps.acquisition);
  } catch (error) {
    if (isPropertyReadLockDeadline(error)) return { outcome: 'refused_lock_busy' };
    warnPaneStaySpawnFailed('availability', error);
    return { outcome: 'execution_failure' };
  }
  const searchOutcome = text(result.outcome);
  if (searchOutcome === 'input_gap') return { outcome: 'refused_input_invalid' };
  if (!searchOutcome || searchOutcome === 'execution_failure') return { outcome: 'execution_failure' };
  return { outcome: 'read', ...availabilitySnapshotOf(result) };
}
