import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createPostgresPropertyReadLock } from '../hms/property-read-lock.js';

const execFileAsync = promisify(execFile);
const CREATE_LAB_STAY = fileURLToPath(
  new URL('../../tooling/playwright-quote/create-lab-stay.mjs', import.meta.url),
);
// The hotel this HMS session runs on. The CLI never receives a propertyCode (paneStayRequestBody strips it),
// so every property lock is keyed on this value, whatever the stay asks for.
export const PANE_STAY_PROPERTY_CODE = 'HRCEN';

export type PaneStay = {
  firstName: string;
  lastName: string;
  arrival: string;
  departure: string;
  adults: number;
  sourceOfBusiness: string;
  roomType: string;
  ratePlan: string;
  track: string;
  guaranteeType: string;
  childAges?: number[];
  propertyCode?: string;
};

export type PaneStayMode = 'preview' | 'commit';

export type OsressDuplicateStatus = 'parked' | 'clear' | 'duplicate';

export type PaneStaySpawnInput = {
  stay: PaneStay;
  stopBefore: 'save' | null;
  paneCommit: boolean;
};

export type PaneStaySpawnResult = {
  outcome: string;
  clickedSave: boolean;
  confirmationNumber: string;
  screenshot?: string;
};

export type PaneStayLock = {
  withLock: <T>(fn: () => Promise<T>) => Promise<T>;
};

export const paneStaySaveLoaders: {
  spawn: ((input: PaneStaySpawnInput) => Promise<PaneStaySpawnResult>) | null;
  lock: PaneStayLock | null;
  osressGuestDatesSearch:
    | ((input: {
        lastName: string;
        arrival: string;
        departure: string;
      }) => Promise<OsressDuplicateStatus>)
    | null;
  enabled: (() => boolean) | null;
} = {
  spawn: null,
  lock: null,
  osressGuestDatesSearch: null,
  enabled: null,
};

export function paneStaySaveEnabled(env: NodeJS.Dict<string> = process.env): boolean {
  return env.RESERVATIONIST_PANE_SAVE === 'on';
}

export function paneStayRequestBody(stay: PaneStay): Omit<PaneStay, 'propertyCode'> {
  const { propertyCode: _ignored, ...request } = stay;
  return request;
}

export function assertLabStayGuard(input: {
  lastName: string;
  arrivalDate?: string;
  arrival?: string;
}): void {
  const arrival = input.arrivalDate ?? input.arrival ?? '';
  if (!/^labtest$/i.test(input.lastName.trim())) {
    throw new Error('pane_save_labtest_required');
  }
  if (arrival < '2027-01-01') {
    throw new Error('pane_save_arrival_2027_required');
  }
}

async function defaultSpawn(input: PaneStaySpawnInput): Promise<PaneStaySpawnResult> {
  const dir = await mkdtemp(join(tmpdir(), 'pane-stay-'));
  const requestPath = join(dir, 'request.json');
  await writeFile(requestPath, JSON.stringify(paneStayRequestBody(input.stay)));
  const args = [CREATE_LAB_STAY, '--request', requestPath];
  if (input.stopBefore) args.push('--stop-before', input.stopBefore);
  if (input.paneCommit) args.push('--pane-commit');
  const { stdout } = await execFileAsync('node', args, {
    timeout: 20 * 60_000,
    env: { ...process.env },
  });
  const line = stdout.trim().split('\n').at(-1) ?? '';
  const [outcome = '', confirmationNumber = ''] = line.split(/\s+/);
  return {
    outcome,
    clickedSave: Boolean(input.paneCommit),
    confirmationNumber,
  };
}

// Production lock for the session's hotel. Cancel and save share this key, so they serialize with each other.
export function paneStayPropertyLock(): PaneStayLock | null {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) return null;
  return createPostgresPropertyReadLock({
    tenantId: process.env.PANE_STAY_TENANT_ID || 'legacy',
    propertyCode: PANE_STAY_PROPERTY_CODE,
    databaseUrl,
  });
}

// An explicit propertyCode must name the session's hotel. Any other value would lock a key the session never
// uses, so the lock could be bypassed. Such requests are refused before any lock or spawn.
export function paneStayPropertyRefusal(propertyCode: string | undefined): string | null {
  return propertyCode === undefined || propertyCode === PANE_STAY_PROPERTY_CODE
    ? null
    : 'pane_save_property_mismatch';
}

export async function runPaneStay(input: {
  mode: PaneStayMode;
  stay: PaneStay;
}): Promise<{
  status: 'ok' | 'refused';
  reason?: string;
  outcome?: string;
  confirmationNumber?: string;
  clickedSave?: boolean;
  screenshot?: string;
}> {
  const enabled = paneStaySaveLoaders.enabled ?? (() => paneStaySaveEnabled());
  if (!enabled()) {
    return { status: 'refused', reason: 'pane_save_flag_off' };
  }
  try {
    assertLabStayGuard({ lastName: input.stay.lastName, arrival: input.stay.arrival });
  } catch (error) {
    return { status: 'refused', reason: (error as Error).message };
  }
  const propertyRefusal = paneStayPropertyRefusal(input.stay.propertyCode);
  if (propertyRefusal) {
    return { status: 'refused', reason: propertyRefusal };
  }
  if (input.mode === 'commit') {
    const reader = paneStaySaveLoaders.osressGuestDatesSearch;
    if (!reader) {
      return { status: 'refused', reason: 'osress_reader_parked' };
    }
    const status = await reader({
      lastName: input.stay.lastName,
      arrival: input.stay.arrival,
      departure: input.stay.departure,
    });
    if (status === 'parked') {
      return { status: 'refused', reason: 'osress_reader_parked' };
    }
    if (status === 'duplicate') {
      return { status: 'refused', reason: 'osress_duplicate' };
    }
  }
  const lock = paneStaySaveLoaders.lock ?? paneStayPropertyLock();
  if (!lock) {
    return { status: 'refused', reason: 'pane_save_lock_unavailable' };
  }
  const spawn = paneStaySaveLoaders.spawn ?? defaultSpawn;
  const spawned = await lock.withLock(() =>
    spawn({
      stay: input.stay,
      stopBefore: input.mode === 'preview' ? 'save' : null,
      paneCommit: input.mode === 'commit',
    }),
  );
  if (/^refused/i.test(spawned.outcome)) {
    return { status: 'refused', reason: spawned.outcome };
  }
  return {
    status: 'ok',
    outcome: spawned.outcome,
    confirmationNumber: spawned.confirmationNumber,
    clickedSave: spawned.clickedSave,
    screenshot: spawned.screenshot,
  };
}
