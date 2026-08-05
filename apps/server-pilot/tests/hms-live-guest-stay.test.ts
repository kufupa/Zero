import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  liveGuestStayRowFingerprintV1Schema,
  type LiveGuestStayRowFingerprintV1,
} from '../src/hms/contracts.js';
import {
  buildLiveGuestStayRowFingerprintV1,
  createLiveGuestStayDriver,
  extractOsressPageData,
  parseAndCorrelateGuestStayHtml,
  parseLiveOsressGridRows,
  type ExactReservationCandidate,
} from '../src/hms/live-guest-stay-driver.js';
import { createReservationCandidateSession } from '../src/hms/reservation-candidate-session.js';
import type { LiveGuestStayDriver } from '../src/hms/live-guest-stay-driver.js';
import {
  HmsRuntimeError,
  type HmsPage,
  type HmsReadSession,
  type HmsRuntime,
} from '../src/hms/runtime.js';
import {
  createCandidateTools,
  runClaimSafeCandidateDraft,
} from '../src/ai/candidate-draft-agent.js';
import {
  filterExactReservationCandidates,
  type LookupCandidate,
} from '../src/ai/thread-context.js';
import type { HmsBrowserArtifactReceiptV1 } from '../src/hms/browser-artifacts.js';

const here = dirname(fileURLToPath(import.meta.url));
const fingerprintEvalPath = join(
  here,
  '../evals/hms/live-guest-stay-row-fingerprint.v1.json',
);

const SYNTH = {
  guest: 'Synthetic Guest Alpha',
  email: 'synth.guest@example.test',
  conf: 'SYNTH-CONF-1001',
  confDup: 'SYNTH-CONF-1001',
  confOther: 'SYNTH-OTHER-9999',
  ext: 'SYNTH-EXT-55',
  arrival: '2099-01-15',
  departure: '2099-01-18',
};

function confCandidate(
  value = SYNTH.conf,
): ExactReservationCandidate {
  return {
    id: createHash('sha256').update(`confirmation:${value}`).digest('hex').slice(0, 16),
    kind: 'confirmation',
    value,
  };
}

function rowHtml(attrs: Record<string, string>, stale = false): string {
  const parts = Object.entries(attrs)
    .map(([k, v]) => `${k}="${v}"`)
    .join(' ');
  const staleAttr = stale ? ' data-stale-row="prior"' : '';
  return `<tr data-testid="result-row" ${parts}${staleAttr}><td>x</td></tr>`;
}

function grid(rows: string[], extras = ''): string {
  return `<table data-testid="results">${rows.join('')}</table>${extras}`;
}

function liveDriverWithSession(input: {
  page: Partial<HmsPage>;
  receipt?: HmsBrowserArtifactReceiptV1 | null;
  origin?: string;
}) {
  const close = vi.fn(async () => undefined);
  const session = {
    id: 'session-test',
    origin: input.origin ?? 'http://127.0.0.1:17888',
    violation: () => null,
    terminal: () => false,
    page: input.page as HmsPage,
    lastReceipt: () => input.receipt ?? null,
    close,
  } satisfies HmsReadSession;
  const runtime = {
    openReadSession: vi.fn(async () => session),
  } as unknown as HmsRuntime;
  return {
    close,
    driver: createLiveGuestStayDriver({
      runtime,
      transportId: 'transport-centurion',
    }),
  };
}

describe('live guest stay row fingerprint (structure only)', () => {
  it('schema rejects value capture and value-derived fields', () => {
    const fp = buildLiveGuestStayRowFingerprintV1();
    expect(fp.valuesCaptured).toBe(false);
    expect(fp.schemaVersion).toBe(1);
    expect(liveGuestStayRowFingerprintV1Schema.parse(fp)).toEqual(fp);

    expect(() =>
      liveGuestStayRowFingerprintV1Schema.parse({
        ...fp,
        valuesCaptured: true,
      }),
    ).toThrow();

    expect(() =>
      liveGuestStayRowFingerprintV1Schema.parse({
        ...fp,
        matchCount: 1,
      }),
    ).toThrow();

    expect(() =>
      liveGuestStayRowFingerprintV1Schema.parse({
        ...fp,
        valueHash: 'a'.repeat(64),
      }),
    ).toThrow();
  });

  it('fingerprint has selector/column keys only — no PII, HTML, cardinality, or value hashes', () => {
    const fp = buildLiveGuestStayRowFingerprintV1();
    const serialized = JSON.stringify(fp);
    for (const bad of [
      SYNTH.guest,
      SYNTH.email,
      SYNTH.conf,
      SYNTH.arrival,
      '<html',
      'screenshot',
      'matchCount',
      'cardinality',
      'trace',
    ]) {
      expect(serialized.toLowerCase()).not.toContain(bad.toLowerCase());
    }
    expect(fp.selectorKeys.length).toBeGreaterThan(0);
    expect(fp.columnKeys).toEqual(
      expect.arrayContaining([
        'confirmationNumber',
        'externalReference',
        'reservationStatus',
        'arrivalDate',
        'departureDate',
      ]),
    );
    expect(fp.manifestSha256).toMatch(/^[a-f0-9]{64}$/);
    // Hash derives from structure keys, not guest values.
    const again = buildLiveGuestStayRowFingerprintV1();
    expect(again.manifestSha256).toBe(fp.manifestSha256);
  });

  it('eval artifact matches structural fingerprint contract', () => {
    const raw = JSON.parse(readFileSync(fingerprintEvalPath, 'utf8')) as unknown;
    const fp = liveGuestStayRowFingerprintV1Schema.parse(raw) as LiveGuestStayRowFingerprintV1;
    expect(fp.valuesCaptured).toBe(false);
    expect(fp).toEqual(buildLiveGuestStayRowFingerprintV1());
  });
});

describe('guest stay HTML parser correlation', () => {
  const candidate = confCandidate();

  it('zero rows → not_found', () => {
    const html = '<p data-testid="no-results">No reservations found</p>';
    expect(parseAndCorrelateGuestStayHtml(html, candidate)).toEqual({
      outcome: 'not_found',
      observations: [],
      capped: false,
    });
  });

  it('one exact active row → matched (correlated only)', () => {
    const html = grid([
      rowHtml({
        'data-confirmation': SYNTH.conf,
        'data-external': SYNTH.ext,
        'data-guest-name': SYNTH.guest,
        'data-arrival': SYNTH.arrival,
        'data-departure': SYNTH.departure,
        'data-status': 'Confirmed',
        'data-room-type': 'STD',
        'data-rate-plan': 'BAR',
      }),
      rowHtml({
        'data-confirmation': SYNTH.confOther,
        'data-status': 'Confirmed',
      }),
    ]);
    const result = parseAndCorrelateGuestStayHtml(html, candidate);
    expect(result.outcome).toBe('matched');
    if (result.outcome !== 'matched') return;
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]).toMatchObject({
      confirmationNumber: SYNTH.conf,
      externalReference: SYNTH.ext,
      reservationStatus: 'Confirmed',
      arrivalDate: SYNTH.arrival,
      departureDate: SYNTH.departure,
    });
  });

  it('cancelled status still correlates as single match (session maps draft readiness)', () => {
    const html = grid([
      rowHtml({
        'data-confirmation': SYNTH.conf,
        'data-status': 'Cancelled',
        'data-arrival': SYNTH.arrival,
        'data-departure': SYNTH.departure,
      }),
    ]);
    const result = parseAndCorrelateGuestStayHtml(html, candidate);
    expect(result.outcome).toBe('matched');
    if (result.outcome !== 'matched') return;
    expect(result.observations[0]!.reservationStatus).toBe('Cancelled');
  });

  it('unknown status correlates as single match', () => {
    const html = grid([
      rowHtml({
        'data-confirmation': SYNTH.conf,
        'data-status': 'Waitlist',
      }),
    ]);
    const result = parseAndCorrelateGuestStayHtml(html, candidate);
    expect(result.outcome).toBe('matched');
  });

  it('duplicate exact rows same confirmation → matched primary', () => {
    const html = grid([
      rowHtml({
        'data-confirmation': SYNTH.confDup,
        'data-status': 'Confirmed',
        'data-guest-name': '',
      }),
      rowHtml({
        'data-confirmation': SYNTH.confDup,
        'data-status': 'InHouse',
        'data-guest-name': SYNTH.guest,
      }),
    ]);
    const result = parseAndCorrelateGuestStayHtml(html, candidate);
    expect(result.outcome).toBe('matched');
    if (result.outcome !== 'matched') return;
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]!.guestName).toBe(SYNTH.guest);
    expect(result.observations[0]!.reservationStatus).toBe('InHouse');
  });

  it('unrelated rows stripped — only candidate-correlated count', () => {
    const html = grid([
      rowHtml({ 'data-confirmation': SYNTH.confOther, 'data-status': 'Confirmed' }),
      rowHtml({ 'data-confirmation': 'UNRELATED-1', 'data-status': 'Confirmed' }),
    ]);
    expect(parseAndCorrelateGuestStayHtml(html, candidate).outcome).toBe('not_found');
  });

  it('many same-confirmation rows → matched primary (not ambiguous)', () => {
    const rows = Array.from({ length: 21 }, (_, i) =>
      rowHtml({
        'data-confirmation': SYNTH.conf,
        'data-external': `E-${i}`,
        'data-status': 'Confirmed',
      }),
    );
    const result = parseAndCorrelateGuestStayHtml(grid(rows), candidate);
    expect(result.outcome).toBe('matched');
    if (result.outcome !== 'matched') return;
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]!.confirmationNumber).toBe(SYNTH.conf);
  });

  it('missing cells → matched with nulls', () => {
    const html = grid([rowHtml({ 'data-confirmation': SYNTH.conf })]);
    const result = parseAndCorrelateGuestStayHtml(html, candidate);
    expect(result.outcome).toBe('matched');
    if (result.outcome !== 'matched') return;
    expect(result.observations[0]).toMatchObject({
      confirmationNumber: SYNTH.conf,
      externalReference: null,
      guestName: null,
      arrivalDate: null,
      departureDate: null,
      reservationStatus: null,
    });
  });

  it('stale prior-grid rows ignored', () => {
    const html = grid(
      [
        rowHtml({ 'data-confirmation': SYNTH.conf, 'data-status': 'Confirmed' }, true),
      ],
      '<p data-testid="no-results">No reservations found</p>',
    );
    // Stale-only + no-results → not_found
    expect(parseAndCorrelateGuestStayHtml(html, candidate).outcome).toBe('not_found');
  });

  it('failed correlated response marker → SCHEMA_DRIFT', () => {
    const html =
      '<div data-testid="search-correlation-failed">timeout</div>' +
      grid([rowHtml({ 'data-confirmation': SYNTH.conf })]);
    expect(() => parseAndCorrelateGuestStayHtml(html, candidate)).toThrow(
      /SCHEMA_DRIFT|correlation/i,
    );
  });

  it('production parsing rejects fixture HTML fallback', () => {
    const html = grid([
      rowHtml({
        'data-confirmation': SYNTH.conf,
        'data-status': 'Confirmed',
      }),
    ]);
    expect(() =>
      parseAndCorrelateGuestStayHtml(html, candidate, undefined, {
        requireLiveEnvelope: true,
      }),
    ).toThrowError(expect.objectContaining({ code: 'SCHEMA_DRIFT' }));
  });

  it('abort signal → AbortError before parse', () => {
    const ac = new AbortController();
    ac.abort();
    expect(() =>
      parseAndCorrelateGuestStayHtml(
        grid([rowHtml({ 'data-confirmation': SYNTH.conf })]),
        candidate,
        ac.signal,
      ),
    ).toThrow(/abort/i);
  });
});

describe('live OSRESS GRIDRESULT parser', () => {
  const candidate = confCandidate();

  function gridEnvelope(rows: unknown[], records?: string): string {
    const rec =
      records ??
      (Array.isArray(rows) ? String(rows.length) : '0');
    return ` { pageData: ${JSON.stringify({
      fromCome: true,
      grid: {
        GRIDRESULT: {
          type: 'LIST.DATA_ONLY.STORED',
          DATASPY: { id: '1941', label: 'All' },
          TOOLBAR: null,
          GRID: {
            METADATA: { RECORDS: rec, GRIDNAME: 'OSRESS' },
            DATA: rows,
          },
        },
      },
      success: true,
    })} } `;
  }

  it('extractOsressPageData parses unquoted pageData envelope', () => {
    const text = gridEnvelope([]);
    const pd = extractOsressPageData(text);
    expect(pd).not.toBeNull();
    expect(parseLiveOsressGridRows(pd!)).toEqual([]);
  });

  it('RECORDS 0 / empty DATA → not_found', () => {
    const text = gridEnvelope([], '0');
    expect(parseAndCorrelateGuestStayHtml(text, candidate)).toEqual({
      outcome: 'not_found',
      observations: [],
      capped: false,
    });
  });

  it('production null-grid envelope → not_found', () => {
    const text = ` { pageData: ${JSON.stringify({
      fromCome: true,
      grid: null,
      messages: null,
    })} } `;
    const pageData = extractOsressPageData(text);

    expect(pageData).not.toBeNull();
    expect(parseLiveOsressGridRows(pageData!)).toEqual([]);
    expect(
      parseAndCorrelateGuestStayHtml(text, candidate, undefined, {
        requireLiveEnvelope: true,
      }),
    ).toEqual({
      outcome: 'not_found',
      observations: [],
      capped: false,
    });
  });

  it('rejects failed, wrong-grid, and malformed live envelopes', () => {
    const base = extractOsressPageData(gridEnvelope([]))!;
    const failed = structuredClone(base);
    failed.success = false;
    const wrongGrid = structuredClone(base);
    (
      (
        (wrongGrid.grid as Record<string, unknown>).GRIDRESULT as Record<
          string,
          unknown
        >
      ).GRID as Record<string, unknown>
    ).METADATA = { RECORDS: '0', GRIDNAME: 'OTHER' };
    const malformed = extractOsressPageData(gridEnvelope([null], '1'))!;
    const paginated = extractOsressPageData(
      gridEnvelope(
        [
          {
            confirmationnumber: '12345678-1',
            externalconfirmation: 'EXT-1',
          },
        ],
        '2',
      ),
    )!;
    const malformedEmpty = {
      fromCome: true,
      grid: null,
      messages: [],
    };

    for (const envelope of [
      failed,
      wrongGrid,
      malformed,
      paginated,
      malformedEmpty,
    ]) {
      expect(() => parseLiveOsressGridRows(envelope)).toThrowError(
        expect.objectContaining({ code: 'SCHEMA_DRIFT' }),
      );
    }
  });

  it('one exact confirmation row → matched; maps dd-mon-yyyy dates', () => {
    const text = gridEnvelope([
      {
        id: '1',
        confirmationnumber: SYNTH.conf,
        externalconfirmation: SYNTH.ext,
        primaryguest: SYNTH.guest,
        arrivaldate: '15-Jan-2099',
        departuredate: '18-Jan-2099',
        status: 'Confirmed',
        lastname: 'Syntherson',
        firstname: 'Alpha',
      },
      {
        id: '2',
        confirmationnumber: SYNTH.confOther,
        status: 'Confirmed',
      },
    ]);
    const result = parseAndCorrelateGuestStayHtml(text, candidate);
    expect(result.outcome).toBe('matched');
    if (result.outcome !== 'matched') return;
    expect(result.observations[0]).toMatchObject({
      confirmationNumber: SYNTH.conf,
      externalReference: SYNTH.ext,
      guestName: SYNTH.guest,
      arrivalDate: SYNTH.arrival,
      departureDate: SYNTH.departure,
      reservationStatus: 'Confirmed',
      roomType: null,
      ratePlan: null,
    });
  });

  it('external_reference candidate correlates on externalconfirmation', () => {
    const extCandidate: ExactReservationCandidate = {
      id: 'ext1',
      kind: 'external_reference',
      value: SYNTH.ext,
    };
    const text = gridEnvelope([
      {
        confirmationnumber: SYNTH.confOther,
        externalconfirmation: SYNTH.ext,
        status: 'In House',
      },
    ]);
    const result = parseAndCorrelateGuestStayHtml(text, extCandidate);
    expect(result.outcome).toBe('matched');
  });

  it('external_reference rows without one shared confirmation stay ambiguous', () => {
    const extCandidate: ExactReservationCandidate = {
      id: 'ext-missing-conf',
      kind: 'external_reference',
      value: SYNTH.ext,
    };
    const text = gridEnvelope([
      { externalconfirmation: SYNTH.ext, status: 'Confirmed' },
      {
        confirmationnumber: SYNTH.confOther,
        externalconfirmation: SYNTH.ext,
        status: 'Confirmed',
      },
    ]);
    const result = parseAndCorrelateGuestStayHtml(text, extCandidate);
    expect(result.outcome).toBe('ambiguous');
  });

  it('unrelated rows only → not_found', () => {
    const text = gridEnvelope([
      { confirmationnumber: SYNTH.confOther, status: 'Confirmed' },
    ]);
    expect(parseAndCorrelateGuestStayHtml(text, candidate).outcome).toBe(
      'not_found',
    );
  });
});

describe('live driver fail-closed boundaries', () => {
  const productionOrigin = 'https://appsrv-1.legacyhotels.co.za';

  it('rejects an unsafe finalized audit receipt instead of returning a result', async () => {
    const unsafeReceipt = {
      operationOutcome: 'succeeded',
      terminalCode: 'OK',
      blockedRequests: 0,
      mutationRequests: 0,
      popupCount: 1,
      downloadCount: 0,
      webSocketCount: 0,
    } as unknown as HmsBrowserArtifactReceiptV1;
    const { driver } = liveDriverWithSession({
      origin: productionOrigin,
      receipt: unsafeReceipt,
      page: {
        readPropertyBinding: async () => ({
          tenant: 'LIVE',
          propertyCode: 'HRCEN',
        }),
        title: async () => 'Centurion HRCEN',
        url: () => `${productionOrigin}/web/base/COMMON`,
      },
    });

    await expect(
      driver.loginAndVerifyBinding(AbortSignal.timeout(5_000)),
    ).rejects.toMatchObject({ code: 'POLICY_BLOCK' });
  });

  it('production not-found canary rejects generic 404 text', async () => {
    const { driver } = liveDriverWithSession({
      origin: productionOrigin,
      page: {
        content: async () => '<input name="search">',
        fill: async () => undefined,
        postForm: async () => '404 not found',
        waitForCorrelatedResponse: async () => undefined,
      },
    });

    await expect(
      driver.runNotFoundCanary(AbortSignal.timeout(5_000)),
    ).rejects.toMatchObject({ code: 'SCHEMA_DRIFT' });
  });

  it('observes correlation rejection when the POST also fails', async () => {
    const postError = new Error('post failed');
    const correlationError = new Error('correlation failed');
    const { driver } = liveDriverWithSession({
      page: {
        content: async () => '<input name="search">',
        fill: async () => undefined,
        postForm: async () => {
          throw postError;
        },
        waitForCorrelatedResponse: async () => {
          throw correlationError;
        },
      },
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => unhandled.push(error);
    process.on('unhandledRejection', onUnhandled);
    try {
      await expect(
        driver.searchExact(confCandidate(), AbortSignal.timeout(5_000)),
      ).rejects.toBe(postError);
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(unhandled).toEqual([]);
  });

  it('closes successful no-match searches as business_not_found', async () => {
    const makeDriver = () =>
      liveDriverWithSession({
        page: {
          content: async () => '<input name="search">',
          fill: async () => undefined,
          postForm: async () =>
            '<table data-testid="results"></table><div data-testid="no-results">No results</div>',
          waitForCorrelatedResponse: async () => undefined,
        },
      });

    const direct = makeDriver();
    await expect(
      direct.driver.searchExact(confCandidate(), AbortSignal.timeout(5_000)),
    ).resolves.toMatchObject({ outcome: 'not_found' });
    expect(direct.close).toHaveBeenCalledWith({
      outcome: 'business_not_found',
      terminalCode: 'BUSINESS_NOT_FOUND',
      complete: true,
    });

    const mapped = makeDriver();
    await expect(
      mapped.driver.searchExactAndMap(
        confCandidate(),
        AbortSignal.timeout(5_000),
        (result) => result.outcome,
      ),
    ).resolves.toBe('not_found');
    expect(mapped.close).toHaveBeenCalledWith({
      outcome: 'business_not_found',
      terminalCode: 'BUSINESS_NOT_FOUND',
      complete: true,
    });
  });
});

describe('production candidates and reservation-only session', () => {
  it('only confirmation and external_reference enter live session filter', () => {
    const mixed: LookupCandidate[] = [
      { id: 'c1', kind: 'confirmation', value: SYNTH.conf },
      { id: 'e1', kind: 'external_reference', value: SYNTH.ext },
      {
        id: 's1',
        kind: 'surname_dates',
        surname: 'Syntherson',
        arrivalDate: SYNTH.arrival,
        departureDate: SYNTH.departure,
      },
    ];
    const exact = filterExactReservationCandidates(mixed);
    expect(exact.map((c) => c.kind).sort()).toEqual([
      'confirmation',
      'external_reference',
    ]);
  });

  it('surname_dates → manual_required before browser / driver call', async () => {
    const searchExact = vi.fn(async () => {
      throw new Error('browser must not open');
    });
    const searchExactAndMap = vi.fn(async () => {
      throw new Error('browser must not open');
    });
    const driver: LiveGuestStayDriver = {
      loginAndVerifyBinding: vi.fn(),
      runNotFoundCanary: vi.fn(),
      searchExact,
      searchExactAndMap,
      lastAuditReceipt: vi.fn(() => null),
    };
    const surnameId = 'surname-opaque';
    const session = createReservationCandidateSession({
      driver,
      candidates: new Map(),
      close: async () => undefined,
      // Force surname into lookup map for this safety proof.
      extraLookupCandidates: new Map([
        [
          surnameId,
          {
            id: surnameId,
            kind: 'surname_dates',
            surname: 'Syntherson',
            arrivalDate: SYNTH.arrival,
            departureDate: SYNTH.departure,
          },
        ],
      ]),
    });
    const result = await session.findReservation(
      surnameId,
      new AbortController().signal,
    );
    expect(result.status).toBe('manual_required');
    expect(searchExact).not.toHaveBeenCalled();
    expect(searchExactAndMap).not.toHaveBeenCalled();
  });

  it('gather routes surname_dates via find when quote inactive → manual_required (not silent skip)', async () => {
    const searchExact = vi.fn(async () => {
      throw new Error('browser must not open');
    });
    const searchExactAndMap = vi.fn(async () => {
      throw new Error('browser must not open');
    });
    const surnameId = 'surname-gather';
    const session = createReservationCandidateSession({
      driver: {
        loginAndVerifyBinding: vi.fn(),
        runNotFoundCanary: vi.fn(),
        searchExact,
        searchExactAndMap,
        lastAuditReceipt: vi.fn(() => null),
      },
      candidates: new Map(),
      close: async () => undefined,
      extraLookupCandidates: new Map([
        [
          surnameId,
          {
            id: surnameId,
            kind: 'surname_dates',
            surname: 'Syntherson',
            arrivalDate: SYNTH.arrival,
            departureDate: SYNTH.departure,
          },
        ],
      ]),
    });

    const result = await runClaimSafeCandidateDraft({
      session,
      normalizedThreadText: 'Guest Syntherson arriving 2099-01-15',
      signal: new AbortController().signal,
      probeCandidateIds: [surnameId],
      planModel: async () => ({
        outcome: 'insufficient_evidence',
        questionCodes: [],
        unavailableSources: ['hms'],
      }),
    });

    expect(searchExact).not.toHaveBeenCalled();
    expect(searchExactAndMap).not.toHaveBeenCalled();
    expect(result.evidence.some((e) => e.status === 'manual_required')).toBe(
      true,
    );
    expect(result.metrics.toolCalls).toBeGreaterThan(0);
    expect(result.outcome).toBe('insufficient_evidence');
  });

  it('active production tool IDs equal [hms_find_reservation] only', () => {
    const driver: LiveGuestStayDriver = {
      loginAndVerifyBinding: vi.fn(),
      runNotFoundCanary: vi.fn(),
      searchExact: vi.fn(),
      searchExactAndMap: vi.fn(),
      lastAuditReceipt: vi.fn(() => null),
    };
    const session = createReservationCandidateSession({
      driver,
      candidates: new Map([
        [confCandidate().id, confCandidate()],
      ]),
      close: async () => undefined,
    });
    expect([...session.activeToolIds!].sort()).toEqual(['hms_find_reservation']);
    const bundle = createCandidateTools(session);
    expect(Object.keys(bundle.tools).sort()).toEqual(['hms_find_reservation']);
    expect(bundle.tools).not.toHaveProperty('hms_quote_stay');
    expect(bundle.tools).not.toHaveProperty('mail_read_artifact');
  });

  it('hms_quote_stay and mail_read_artifact not registered/callable in production session', () => {
    const session = createReservationCandidateSession({
      driver: {
        loginAndVerifyBinding: vi.fn(),
        runNotFoundCanary: vi.fn(),
        searchExact: vi.fn(),
        searchExactAndMap: vi.fn(),
        lastAuditReceipt: vi.fn(() => null),
      },
      candidates: new Map(),
      close: async () => undefined,
    });
    const bundle = createCandidateTools(session);
    expect(
      (bundle.tools as Record<string, unknown>).hms_quote_stay,
    ).toBeUndefined();
    expect(
      (bundle.tools as Record<string, unknown>).mail_read_artifact,
    ).toBeUndefined();
  });

  it('fatal runtime errors escape gathering loop (no blanket catch)', async () => {
    const cand = confCandidate();
    const session = createReservationCandidateSession({
      driver: {
        loginAndVerifyBinding: vi.fn(),
        runNotFoundCanary: vi.fn(),
        searchExact: vi.fn(),
        searchExactAndMap: async () => {
          throw new HmsRuntimeError('POLICY_BLOCK', 'blocked search');
        },
        lastAuditReceipt: vi.fn(() => null),
      },
      candidates: new Map([[cand.id, cand]]),
      close: async () => undefined,
    });

    await expect(
      runClaimSafeCandidateDraft({
        session,
        normalizedThreadText: `Please check confirmation ${SYNTH.conf}`,
        signal: new AbortController().signal,
        probeCandidateIds: [cand.id],
        planModel: async () => ({
          outcome: 'insufficient_evidence',
          questionCodes: [],
          unavailableSources: ['hms'],
        }),
      }),
    ).rejects.toThrow(HmsRuntimeError);
  });

  it('fatal runtime errors nested in AggregateError escape gathering', async () => {
    const cand = confCandidate();
    const fatal = new HmsRuntimeError('AUDIT_CAPTURE', 'capture close failed');
    const session = createReservationCandidateSession({
      driver: {
        loginAndVerifyBinding: vi.fn(),
        runNotFoundCanary: vi.fn(),
        searchExact: vi.fn(),
        searchExactAndMap: async () => {
          throw new AggregateError(
            [new Error('tool failed'), fatal],
            'tool and capture failed',
          );
        },
        lastAuditReceipt: vi.fn(() => null),
      },
      candidates: new Map([[cand.id, cand]]),
      close: async () => undefined,
    });

    await expect(
      runClaimSafeCandidateDraft({
        session,
        normalizedThreadText: `Please check confirmation ${SYNTH.conf}`,
        signal: new AbortController().signal,
        probeCandidateIds: [cand.id],
        planModel: async () => ({
          outcome: 'insufficient_evidence',
          questionCodes: [],
          unavailableSources: ['hms'],
        }),
      }),
    ).rejects.toBeInstanceOf(AggregateError);
  });

  it('createCandidateTools validates every active ID has a handler', () => {
    expect(() =>
      createCandidateTools({
        activeToolIds: new Set(['hms_find_reservation', 'hms_quote_stay']),
        lookupCandidates: new Map(),
        authorizedAttachmentIds: new Set(),
        findReservation: async () => {
          throw new Error('nope');
        },
        // quoteStay missing → validation fail
        readArtifact: async () => {
          throw new Error('nope');
        },
      } as never),
    ).toThrow(/active tool|handler|quoteStay/i);
  });
});
