import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  main,
  normalizeName,
  parseLiveCheckArgs,
  partyCheckLine,
  quoteRequestFor,
  rateRows,
  redactDeep,
  redactText,
  stayCheckLine,
  USAGE,
  type CliRun,
  type LiveCheckDeps,
  type QuoteResult,
} from '../scripts/v8-live-checks.js';
import type { PaneStayFields, PaneStayFindResult } from '../src/ai/pane-stay-lookup.js';
import type { PaneStayLock } from '../src/ai/pane-stay-save.js';
import { PROPERTY_READ_LOCK_DEADLINE_MESSAGE } from '../src/hms/property-read-lock.js';

const TODAY = '2026-10-09';
const parse = (...argv: string[]) => parseLiveCheckArgs(argv, TODAY);

const scratch: string[] = [];
async function scratchDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'v8-live-checks-test-'));
  scratch.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(scratch.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const passLock = { withLock: (fn: () => Promise<unknown>) => fn() } as unknown as PaneStayLock;
const busyLock = {
  withLock: async () => {
    throw Object.assign(new Error('property read advisory lock could not be acquired'), {
      cause: new Error(PROPERTY_READ_LOCK_DEADLINE_MESSAGE),
    });
  },
} as unknown as PaneStayLock;

function harness(overrides: Partial<LiveCheckDeps> = {}) {
  const lines: string[] = [];
  const deps: Partial<LiveCheckDeps> = {
    env: { DATABASE_URL: 'postgres://user:secret@db.invalid/app' },
    today: () => TODAY,
    writeLine: (line) => lines.push(line),
    lock: () => passLock,
    spawnEnv: () => ({}),
    runCli: async () => {
      throw new Error('runCli must not run in this test');
    },
    findStay: async () => {
      throw new Error('findStay must not run in this test');
    },
    newRunId: () => 'run-test',
    ...overrides,
  };
  return {
    deps,
    lines,
    parsed: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

function stayFields(overrides: Partial<PaneStayFields> = {}): PaneStayFields {
  return {
    status: 'Reserved',
    confirmation: '61143613-1',
    lastName: 'Labtest',
    firstName: 'Pat',
    arrival: '2027-10-12',
    departure: '2027-10-13',
    nights: 1,
    adults: 1,
    children: 0,
    roomType: 'KNG',
    ratePlan: 'BAR',
    mealPlan: null,
    averageRate: null,
    grandTotal: null,
    balance: null,
    sourceOfBusiness: null,
    guaranteeType: null,
    bookingAgency: null,
    organization: null,
    ...overrides,
  };
}

function findResult(overrides: Partial<PaneStayFindResult> = {}): PaneStayFindResult {
  return {
    outcome: 'found',
    reason: null,
    stay: stayFields(),
    arrivalMismatch: false,
    requestedArrival: null,
    hmsArrival: '2027-10-12',
    screenshots: [],
    runId: null,
    ...overrides,
  };
}

describe('parseLiveCheckArgs', () => {
  it('reads party names with a kind, defaulting to both', () => {
    expect(parse('party', 'Acme Travel')).toEqual({
      ok: true,
      value: { dryRun: false, check: { check: 'party', name: 'Acme Travel', kinds: ['company', 'agency'] } },
    });
    expect(parse('party', 'Acme', '--kind', 'agency')).toMatchObject({ ok: true, value: { check: { kinds: ['agency'] } } });
    expect(parse('party', 'Acme', '--kind=company', '--dry-run')).toMatchObject({
      ok: true,
      value: { dryRun: true, check: { kinds: ['company'] } },
    });
  });

  it('refuses bad party input', () => {
    expect(parse('party')).toEqual({ ok: false, error: 'party_needs_one_name' });
    expect(parse('party', 'A', 'B')).toEqual({ ok: false, error: 'party_needs_one_name' });
    expect(parse('party', 'Acme', '--kind', 'guest')).toEqual({ ok: false, error: 'kind_invalid' });
    expect(parse('party', 'bad\u0007name')).toEqual({ ok: false, error: 'name_invalid' });
    expect(parse('party', '   ')).toEqual({ ok: false, error: 'name_invalid' });
  });

  it('reads deeplink and stay confirmations, with an optional stay id for deeplink only', () => {
    expect(parse('deeplink', '--conf', '61143613-1', '--stay-id', '987')).toMatchObject({
      ok: true,
      value: { check: { check: 'deeplink', conf: '61143613-1', stayId: '987' } },
    });
    expect(parse('deeplink', '--conf', '61143613-1')).toMatchObject({ ok: true, value: { check: { stayId: null } } });
    expect(parse('stay', '--conf', '61143613-1', '--dry-run')).toMatchObject({
      ok: true,
      value: { dryRun: true, check: { check: 'stay', conf: '61143613-1' } },
    });
    expect(parse('deeplink')).toEqual({ ok: false, error: 'conf_required_or_invalid' });
    expect(parse('stay', '--conf', 'ABC')).toEqual({ ok: false, error: 'conf_required_or_invalid' });
    expect(parse('deeplink', '--conf', '1-1', '--stay-id', 'x1')).toEqual({ ok: false, error: 'stay_id_invalid' });
    expect(parse('stay', '--conf', '1-1', '--stay-id', '1')).toEqual({ ok: false, error: 'unknown_flag:stay-id' });
  });

  it('rateshop takes exactly one of org or agency, an agency needs its name, and dates and counts are bounded', () => {
    expect(parse('rateshop', '--org', '1234')).toEqual({
      ok: true,
      value: {
        dryRun: false,
        check: {
          check: 'rateshop',
          source: { contextKey: 'organization', nativeId: '1234', name: null },
          arrival: '2026-11-08',
          nights: 1,
          adults: 2,
        },
      },
    });
    expect(parse('rateshop', '--agency', '555', '--name', 'Acme Travel', '--arrival', '2027-01-05', '--nights', '3', '--adults', '4')).toMatchObject({
      ok: true,
      value: {
        check: {
          source: { contextKey: 'agency', nativeId: '555', name: 'Acme Travel' },
          arrival: '2027-01-05',
          nights: 3,
          adults: 4,
        },
      },
    });
    expect(parse('rateshop')).toEqual({ ok: false, error: 'org_or_agency_required' });
    expect(parse('rateshop', '--org', '1', '--agency', '2', '--name', 'x')).toEqual({ ok: false, error: 'org_or_agency_required' });
    expect(parse('rateshop', '--agency', '2')).toEqual({ ok: false, error: 'agency_needs_name' });
    expect(parse('rateshop', '--org', 'bad id')).toEqual({ ok: false, error: 'native_id_invalid' });
    expect(parse('rateshop', '--org', '1', '--arrival', '2027-02-30')).toEqual({ ok: false, error: 'arrival_invalid' });
    expect(parse('rateshop', '--org', '1', '--nights', '0')).toEqual({ ok: false, error: 'nights_invalid' });
    expect(parse('rateshop', '--org', '1', '--nights', '31')).toEqual({ ok: false, error: 'nights_invalid' });
    expect(parse('rateshop', '--org', '1', '--adults', '10')).toEqual({ ok: false, error: 'adults_invalid' });
    expect(parse('rateshop', '--org', '1', '--adults', 'two')).toEqual({ ok: false, error: 'adults_invalid' });
  });

  it('rejects unknown commands, flags from another command, duplicates, missing values and stray arguments', () => {
    expect(parse()).toEqual({ ok: false, error: 'unknown_command' });
    expect(parse('deploy')).toEqual({ ok: false, error: 'unknown_command' });
    expect(parse('stay', '--conf', '1-1', '--force', 'now')).toEqual({ ok: false, error: 'unknown_flag:force' });
    expect(parse('stay', '--conf', '1-1', '--kind', 'both')).toEqual({ ok: false, error: 'unknown_flag:kind' });
    expect(parse('stay', '--conf', '1-1', '--conf', '2-2')).toEqual({ ok: false, error: 'duplicate_flag:conf' });
    expect(parse('stay', '--conf')).toEqual({ ok: false, error: 'missing_value:conf' });
    expect(parse('stay', '--conf', '--dry-run')).toEqual({ ok: false, error: 'missing_value:conf' });
    expect(parse('stay', '1-1')).toEqual({ ok: false, error: 'unexpected_argument' });
    expect(parse('stay', '--conf', '1-1', '--dry-run', '--dry-run')).toEqual({ ok: false, error: 'duplicate_flag:dry-run' });
  });

  it('normalises party names to trimmed text of 1 to 100 characters without control characters', () => {
    expect(normalizeName('  Acme  ')).toBe('Acme');
    expect(normalizeName('a'.repeat(100))).toBe('a'.repeat(100));
    expect(normalizeName('a'.repeat(101))).toBeNull();
    expect(normalizeName('a\nb')).toBeNull();
  });
});

describe('redaction', () => {
  it('scrubs URLs, emails and phone-like runs, and keeps confirmation numbers', () => {
    expect(redactText('mail jo.doe@example.com or +61 2 9999 1234 via https://hms.example.test/x?y=1')).toBe(
      'mail <email> or <phone> via <url>',
    );
    expect(redactText('confirmation 61143613-1')).toBe('confirmation 61143613-1');
  });

  it('drops guest, contact and credential keys at any depth and keeps party names', () => {
    expect(
      redactDeep({
        name: 'Acme Travel',
        lastName: 'Doe',
        nested: [{ bookerEmail: 'a@b.co', reservationNote: 'x', firstName: 'Pat', keep: 'ok' }],
      }),
    ).toEqual({ name: 'Acme Travel', nested: [{ keep: 'ok' }] });
  });
});

describe('output builders', () => {
  it('party lines carry only kind, nativeId and name, and flag a grid at its row cap as truncated', () => {
    const line = partyCheckLine({
      kind: 'company',
      query: 'Acme',
      outcome: 'ambiguous',
      candidates: [{ nativeId: 101, displayName: 'Acme Ltd', matchedOn: ['companyname'], address: '1 Example St' }],
      ms: 5,
    });
    expect(line).toMatchObject({
      check: 'party',
      query: 'Acme',
      outcome: 'ambiguous',
      results: [{ kind: 'company', nativeId: '101', name: 'Acme Ltd' }],
      truncated: false,
      ok: true,
    });
    expect(JSON.stringify(line)).not.toContain('Example St');
    const capped = partyCheckLine({
      kind: 'agency',
      query: 'A',
      outcome: 'resolved',
      candidates: Array.from({ length: 80 }, (_, index) => ({ nativeId: String(index + 1), displayName: `Agency ${index}` })),
      ms: 1,
    });
    expect(capped.truncated).toBe(true);
  });

  it('stay lines print booleans, and a confirmation only for a Labtest stay', () => {
    const labtest = stayCheckLine({
      result: findResult({ stay: stayFields({ bookingAgency: 'Acme Travel', organization: null }) }),
      reservationNote: true,
      ms: 3,
    });
    expect(labtest).toMatchObject({
      check: 'stay',
      outcome: 'found',
      labtest: true,
      confirmation: '61143613-1',
      status: 'Reserved',
      arrival: '2027-10-12',
      departure: '2027-10-13',
      hasBookingAgency: true,
      hasOrganization: false,
      hasReservationNote: true,
      ok: true,
    });
    expect(JSON.stringify(labtest)).not.toContain('Acme Travel');
    const real = stayCheckLine({
      result: findResult({ stay: stayFields({ lastName: 'Doe', confirmation: '12345-1' }) }),
      reservationNote: false,
      ms: 3,
    });
    expect(real).toMatchObject({ labtest: false, confirmation: null, hasReservationNote: false });
  });

  it('rate rows map contextual, public and unknown scopes, and keep displayed amounts only', () => {
    const quote: QuoteResult = {
      outcome: 'quote',
      groups: [
        {
          id: 'g1',
          options: [
            {
              room: { code: 'KNG' },
              rate: { code: 'BAR' },
              rateScope: 'public',
              nightly: [{ date: '2026-12-01', price: { currency: 'USD', amount: '210.00' } }],
              calculated: { ok: true, perRoom: { amount: '210.00' } },
            },
            {
              room: { code: 'KNG' },
              rate: { code: 'CORP1' },
              rateScope: 'contextual',
              nightly: [{ date: '2026-12-01', price: { currency: 'USD', amount: '180.00' } }],
              calculated: { ok: false },
            },
            { room: { code: 'QQ' }, rate: { code: 'X9' }, rateScope: 'unknown', nightly: [] },
          ],
        },
      ],
    };
    expect(rateRows(quote).map((row) => [row.planCode, row.isNegotiatedRate, row.rate.perRoomSum])).toEqual([
      ['BAR', false, '210.00'],
      ['CORP1', true, null],
      ['X9', null, null],
    ]);
  });

  it('quote requests ask for summary details only, with the Preset strategy and the context reference', () => {
    expect(
      quoteRequestFor({ contextKey: 'organization', nativeId: '1234', name: null }, '2026-12-01', 2, 2),
    ).toEqual({
      schemaVersion: 2,
      propertyCode: 'HRCEN',
      arrivalDate: '2026-12-01',
      departureDate: '2026-12-03',
      rooms: [{ id: 'live-check-1', quantity: 1, adults: 2, children: 0, childAges: [] }],
      rateContext: { organization: { nativeId: '1234' } },
      search: { salesStrategy: 'Preset' },
      details: 'summary',
    });
  });
});

describe('main', () => {
  it('dry-run reports the env a real run needs by name, and never builds the lock or spawns a child', async () => {
    const h = harness({
      env: {},
      spawnEnv: () => ({}),
      lock: () => {
        throw new Error('lock built in a dry run');
      },
    });
    expect(await main(['party', 'Acme', '--dry-run'], h.deps)).toBe(1);
    const [report] = h.parsed();
    expect(report).toMatchObject({ check: 'party', dryRun: true, ok: false, plan: { kinds: ['company', 'agency'] } });
    expect(report.problems).toEqual(
      expect.arrayContaining([
        'property_lock_unavailable',
        'cdp_not_loopback_or_unset',
        'browser_ownership_not_borrowed',
        'credential_source_missing',
      ]),
    );
  });

  it('dry-run passes with a loopback borrowed browser and a credential file, and prints no path, host or URL', async () => {
    const dir = await scratchDir();
    const secretPath = join(dir, 'secret.json');
    await writeFile(secretPath, '{}');
    const h = harness({
      env: { DATABASE_URL: 'postgres://user:pw@db.invalid/app' },
      spawnEnv: () => ({
        HMS_STAGEHAND_CDP_URL: 'http://127.0.0.1:9222',
        HMS_STAGEHAND_BROWSER_OWNERSHIP: 'borrowed',
        HMS_QUOTE_SECRET_PATH: secretPath,
      }),
    });
    expect(await main(['rateshop', '--org', '1234', '--arrival', '2026-12-01', '--nights', '2', '--dry-run'], h.deps)).toBe(0);
    const [report] = h.parsed();
    expect(report).toMatchObject({
      check: 'rateshop',
      ok: true,
      problems: [],
      plan: { contextKey: 'organization', arrival: '2026-12-01', nights: 2, adults: 2, salesStrategy: 'Preset' },
      env: { databaseUrlSet: true, cdpLoopback: true, borrowedOwnership: true, credentialFileFound: true },
    });
    const raw = h.lines.join('\n');
    expect(raw).not.toContain(secretPath);
    expect(raw).not.toContain('127.0.0.1');
    expect(raw).not.toContain('db.invalid');
  });

  it('a busy property lock refuses the check and never spawns the CLI', async () => {
    let spawned = false;
    const h = harness({
      lock: () => busyLock,
      runCli: async (): Promise<CliRun> => {
        spawned = true;
        return { code: 0, stdout: '' };
      },
    });
    expect(await main(['party', 'Acme', '--kind', 'company'], h.deps)).toBe(1);
    expect(spawned).toBe(false);
    expect(h.parsed()).toEqual([expect.objectContaining({ check: 'party', kind: 'company', outcome: 'refused_lock_busy', ok: false })]);
  });

  it('no lock configured refuses before anything runs', async () => {
    const h = harness({ lock: () => null });
    expect(await main(['deeplink', '--conf', '1-1'], h.deps)).toBe(1);
    expect(h.parsed()).toEqual([expect.objectContaining({ check: 'deeplink', outcome: 'refused_lock_unavailable', ok: false })]);
  });

  it('party runs party-lookup.mjs once per kind with the route request shape, and maps candidates to kind, nativeId and name', async () => {
    const requests: unknown[] = [];
    const h = harness({
      runCli: async (file, args): Promise<CliRun> => {
        expect(file.endsWith('party-lookup.mjs')).toBe(true);
        expect(args[0]).toBe('--request');
        requests.push(JSON.parse(await readFile(args[1], 'utf8')));
        const envelope = {
          outcome: 'resolved',
          candidates: [{ nativeId: 77, displayName: 'Acme Ltd', matchedOn: ['companyname'], address: 'Level 2, 1 Example St' }],
        };
        return { code: 0, stdout: `${JSON.stringify(envelope)}\n` };
      },
    });
    expect(await main(['party', 'Acme'], h.deps)).toBe(0);
    expect(requests).toEqual([
      { kind: 'organization', query: { organizationName: 'Acme' } },
      { kind: 'bookingAgency', query: { bookingAgencyName: 'Acme' } },
    ]);
    expect(h.parsed()).toEqual([
      expect.objectContaining({ check: 'party', kind: 'company', results: [{ kind: 'company', nativeId: '77', name: 'Acme Ltd' }], ok: true }),
      expect.objectContaining({ check: 'party', kind: 'agency', results: [{ kind: 'agency', nativeId: '77', name: 'Acme Ltd' }], ok: true }),
    ]);
    expect(h.lines.join('\n')).not.toContain('Example St');
  });

  it('stay reads the note flag from the lookup run, prints only booleans, and deletes the run directory', async () => {
    const runDir = await scratchDir();
    await writeFile(
      join(runDir, 'result.json'),
      JSON.stringify({ outcome: 'found', stay: { reservationNote: 'Quiet room please', lastName: 'Labtest' } }),
    );
    let sawLock = false;
    const h = harness({
      findStay: async (_input, options) => {
        sawLock = options.lock() !== null;
        options.onRun?.({ runId: 'r1', dir: runDir });
        return findResult({ stay: stayFields({ bookingAgency: 'Acme Travel', confirmation: '61143613-1' }) });
      },
    });
    expect(await main(['stay', '--conf', '61143613-1'], h.deps)).toBe(0);
    expect(sawLock).toBe(true);
    const raw = h.lines.join('\n');
    expect(raw).not.toContain('Pat');
    expect(raw).not.toContain('Acme Travel');
    expect(raw).not.toContain('Quiet room');
    expect(h.parsed()[0]).toMatchObject({
      check: 'stay',
      outcome: 'found',
      labtest: true,
      confirmation: '61143613-1',
      hasBookingAgency: true,
      hasOrganization: false,
      hasReservationNote: true,
      ok: true,
    });
    expect(existsSync(runDir)).toBe(false);
  });

  it('deeplink passes each probe line through, marks navigation errors not ok, and redacts their URLs', async () => {
    const stdout = [
      {
        id: 'P0_common_bare',
        httpStatus: 200,
        navError: null,
        redirects: 0,
        finalPath: '/web/base/COMMON',
        rows: null,
        class: 'SHELL_OR_BLANK',
        outcome: 'observed',
        evidence: '.private/playwright-quote/deeplink-probe/x',
        ms: 9,
      },
      {
        id: 'P3_osresv_get_confirmation',
        httpStatus: null,
        navError: 'goto at https://hms.example.test/web/base/OSRESV?confirmationnumber=61143613-1',
        redirects: 0,
        finalPath: 'about:blank',
        rows: null,
        class: 'SHELL_OR_BLANK',
        outcome: 'navigation_error',
        evidence: '.private/playwright-quote/deeplink-probe/x',
        ms: 11,
      },
    ]
      .map((record) => JSON.stringify(record))
      .join('\n');
    const h = harness({
      runCli: async (file, args): Promise<CliRun> => {
        expect(file.endsWith('hms-deeplink-probe.mjs')).toBe(true);
        expect(args).toEqual(['--conf', '61143613-1', '--stay-id', '987']);
        return { code: 0, stdout: `${stdout}\n` };
      },
    });
    expect(await main(['deeplink', '--conf', '61143613-1', '--stay-id', '987'], h.deps)).toBe(1);
    const lines = h.parsed();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ check: 'deeplink', id: 'P0_common_bare', class: 'SHELL_OR_BLANK', ok: true });
    expect(lines[1]).toMatchObject({ check: 'deeplink', id: 'P3_osresv_get_confirmation', ok: false });
    expect(h.lines.join('\n')).not.toContain('hms.example.test');
  });

  it('deeplink reports execution_failure when the probe child exits non-zero without output', async () => {
    const h = harness({ runCli: async (): Promise<CliRun> => ({ code: 2, stdout: '' }) });
    expect(await main(['deeplink', '--conf', '1-1'], h.deps)).toBe(1);
    expect(h.parsed()).toEqual([expect.objectContaining({ check: 'deeplink', outcome: 'execution_failure', exitCode: 2, ok: false })]);
  });

  it('rateshop sends the agency reference, reads the evidence result, and maps rows', async () => {
    const dir = await scratchDir();
    const quote: QuoteResult = {
      outcome: 'quote',
      groups: [
        {
          id: 'live-check-1',
          options: [
            {
              room: { code: 'KNG' },
              rate: { code: 'CORP1' },
              rateScope: 'contextual',
              eligibility: 'verified',
              availability: 'available',
              nightly: [
                { date: '2026-12-01', price: { currency: 'USD', amount: '180.00' } },
                { date: '2026-12-02', price: { currency: 'USD', amount: '185.00' } },
              ],
              calculated: { ok: true, perRoom: { amount: '365.00' } },
            },
          ],
        },
      ],
    };
    await writeFile(join(dir, 'result.json'), JSON.stringify(quote));
    const requests: unknown[] = [];
    const h = harness({
      runCli: async (file, args): Promise<CliRun> => {
        expect(file.endsWith('fetch-quote.mjs')).toBe(true);
        requests.push(JSON.parse(await readFile(args[1], 'utf8')));
        return { code: 0, stdout: `Hotel Availability: quote\nEvidence: ${dir}\n` };
      },
    });
    const code = await main(
      ['rateshop', '--agency', '555', '--name', 'Acme Travel', '--arrival', '2026-12-01', '--nights', '2', '--adults', '1'],
      h.deps,
    );
    expect(code).toBe(0);
    expect(requests).toEqual([
      {
        schemaVersion: 2,
        propertyCode: 'HRCEN',
        arrivalDate: '2026-12-01',
        departureDate: '2026-12-03',
        rooms: [{ id: 'live-check-1', quantity: 1, adults: 1, children: 0, childAges: [] }],
        rateContext: { agency: { nativeId: '555', name: 'Acme Travel' } },
        search: { salesStrategy: 'Preset' },
        details: 'summary',
      },
    ]);
    expect(h.parsed()).toEqual([
      expect.objectContaining({
        check: 'rateshop',
        outcome: 'quote',
        ok: true,
        contextKey: 'agency',
        rows: [
          {
            group: 'live-check-1',
            roomType: 'KNG',
            planCode: 'CORP1',
            isNegotiatedRate: true,
            rateScope: 'contextual',
            eligibility: 'verified',
            availability: 'available',
            rate: {
              currency: 'USD',
              perNight: [
                { date: '2026-12-01', amount: '180.00' },
                { date: '2026-12-02', amount: '185.00' },
              ],
              perRoomSum: '365.00',
            },
          },
        ],
      }),
    ]);
  });

  it('party maps a lock deadline to refused_lock_busy when the lock wait runs out', async () => {
    const h = harness({ lock: () => busyLock });
    expect(await main(['party', 'Acme', '--kind', 'agency'], h.deps)).toBe(1);
    expect(h.parsed()[0]).toMatchObject({ check: 'party', outcome: 'refused_lock_busy' });
  });

  it('prints usage for no arguments and exits 2, and bad arguments print one JSON line and exit 2', async () => {
    const usage = harness();
    expect(await main([], usage.deps)).toBe(2);
    expect(usage.lines).toEqual([USAGE]);
    const bad = harness();
    expect(await main(['deploy'], bad.deps)).toBe(2);
    expect(bad.parsed()).toEqual([{ check: 'args', ok: false, error: 'unknown_command' }]);
  });
});
