import {
  buildLiveGuestStayRowFingerprintV2,
  buildLiveGuestStayRowFingerprintV1,
  createLiveGuestStayDriver,
  extractOsressPageData,
  parseAndCorrelateGuestStayHtml,
  parseLiveOsressGridRows,
  type ExactReservationCandidate,
} from '../src/hms/live-guest-stay-driver.js';
import {
  liveGuestStayRowFingerprintV2Schema,
  liveGuestStayRowFingerprintV1Schema,
  type LiveGuestStayRowFingerprintV2,
  type LiveGuestStayRowFingerprintV1,
} from '../src/hms/contracts.js';
import {
  createCandidateTools,
  claimsFromToolResult,
  runClaimSafeCandidateDraft,
} from '../src/ai/candidate-draft-agent.js';
import {
  HmsRuntimeError,
  type HmsPage,
  type HmsReadSession,
  type HmsRuntime,
} from '../src/hms/runtime.js';
import {
  filterExactReservationCandidates,
  type LookupCandidate,
} from '../src/ai/thread-context.js';
import { createReservationCandidateSession } from '../src/hms/reservation-candidate-session.js';
import { issueTrustedRequesterAuthorization } from '../src/hms/requester-authorization.js';
import type { HmsBrowserArtifactReceiptV1 } from '../src/hms/browser-artifacts.js';
import type { LiveGuestStayDriver } from '../src/hms/live-guest-stay-driver.js';
import type { HmsPortfolioToolReleaseV2 } from '../src/hms/release-kernel.js';
import { describe, expect, it, vi } from 'vitest';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const fingerprintEvalPath = join(here, '../evals/hms/live-guest-stay-row-fingerprint.v1.json');
const fingerprintEvalV2Path = join(here, '../evals/hms/live-guest-stay-row-fingerprint.v2.json');

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

function confCandidate(value = SYNTH.conf): ExactReservationCandidate {
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
  violation?: HmsReadSession['violation'];
}) {
  const close = vi.fn(async () => undefined);
  const session = {
    id: 'session-test',
    origin: input.origin ?? 'http://127.0.0.1:17888',
    violation: input.violation ?? (() => null),
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
  it('v2 freezes reviewed GRIDRESULT aliases without capturing values', () => {
    const fp = buildLiveGuestStayRowFingerprintV2();
    expect(liveGuestStayRowFingerprintV2Schema.parse(fp)).toEqual(fp);
    expect(fp).toMatchObject({
      schemaVersion: 2,
      valuesCaptured: false,
      rowAliasKeys: [
        'arrivaldate',
        'confirmationnumber',
        'departuredate',
        'externalconfirmation',
        'firstname',
        'lastname',
        'primaryguest',
        'rateplan',
        'roomtype',
        'status',
      ],
    });
    expect(JSON.stringify(fp)).not.toContain(SYNTH.conf);
  });

  it('v2 eval artifact matches key-only structural fingerprint', () => {
    const raw = JSON.parse(readFileSync(fingerprintEvalV2Path, 'utf8')) as unknown;
    const fp = liveGuestStayRowFingerprintV2Schema.parse(raw) as LiveGuestStayRowFingerprintV2;
    expect(fp).toEqual(buildLiveGuestStayRowFingerprintV2());
  });

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

describe('normal reservation claim authorization and capture join', () => {
  it('maps only an issued authorization joined to the normal reservation capture', async () => {
    const now = new Date('2026-07-30T12:00:00.000Z');
    const state = {
      operationId: 'normal-reservation-operation',
      mailboxGrant: {
        sha256: 'a'.repeat(64),
        transportId: 'transport-normal',
        active: true,
      },
      thread: {
        transportId: 'transport-normal',
        threadId: 'thread-normal',
        stateVersion: 'thread-v1',
      },
      requester: {
        identity: 'guest-normal',
        requesterClass: 'reservation_guest',
        inquiryClass: 'labelled_narrow_status',
        allowedClaimKinds: ['reservation_summary'],
        forwarded: false,
        spoofed: false,
      },
    };
    const key = Buffer.alloc(32, 0x41);
    const authorization = issueTrustedRequesterAuthorization(state, {
      key,
      keyVersion: 'normal-key-v1',
      issuedAt: now,
      expiresAt: new Date('2026-07-30T13:00:00.000Z'),
    });
    expect(authorization).not.toBeNull();
    const receipt = {
      artifactState: 'complete',
      artifactId: 'reservation-capture-artifact',
      operationOutcome: 'succeeded',
      terminalCode: 'OK',
      expiresAt: '2026-07-30T12:45:00.000Z',
    } as unknown as HmsBrowserArtifactReceiptV1;
    const release = {
      evidenceKind: 'hms',
      requestBranches: [{ id: 'guest_stay_search', manifestSha256: 'b'.repeat(64) }],
    } as unknown as HmsPortfolioToolReleaseV2;
    const candidate = confCandidate('NORMAL-CONF-1');
    const driver: LiveGuestStayDriver = {
      loginAndVerifyBinding: vi.fn(),
      runNotFoundCanary: vi.fn(),
      searchExact: vi.fn(),
      searchExactAndMap: vi.fn(async (_candidate, _signal, mapResult) =>
        mapResult({
          outcome: 'matched',
          capped: false,
          observations: [
            {
              confirmationNumber: 'NORMAL-CONF-1',
              externalReference: null,
              guestName: 'Synthetic Guest',
              arrivalDate: '2026-08-01',
              departureDate: '2026-08-03',
              reservationStatus: 'Confirmed',
              roomType: 'STD',
              ratePlan: null,
            },
          ],
        }),
      ),
      lastAuditReceipt: vi.fn(() => receipt),
    };
    const session = createReservationCandidateSession({
      driver,
      candidates: new Map([[candidate.id, candidate]]),
      close: async () => undefined,
      now: () => now,
      activeReleases: new Map([['hms_find_reservation', release]]),
      claimAuthorization: {
        authorization,
        currentState: state,
        key,
        expectedPrivateDigestKeyVersion: 'normal-key-v1',
        now,
      },
    });
    const result = await session.findReservation(candidate.id, new AbortController().signal);
    expect(result.status).toBe('ok');
    expect(result.evidence).toMatchObject({
      scopeVerified: true,
      artifactRef: 'reservation-capture-artifact',
      requesterAuthorizationId: authorization!.authorizationId,
      manifestSha256: 'b'.repeat(64),
    });
    const claims = claimsFromToolResult(result, now, session.claimAuthorization);
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      kind: 'reservation_summary',
      requesterAuthorizationId: authorization!.authorizationId,
    });

    const unjoined = createReservationCandidateSession({
      driver: { ...driver, lastAuditReceipt: vi.fn(() => null) },
      candidates: new Map([[candidate.id, candidate]]),
      close: async () => undefined,
      now: () => now,
      activeReleases: new Map([['hms_find_reservation', release]]),
      claimAuthorization: {
        authorization,
        currentState: state,
        key,
        expectedPrivateDigestKeyVersion: 'normal-key-v1',
        now,
      },
    });
    const unjoinedResult = await unjoined.findReservation(
      candidate.id,
      new AbortController().signal,
    );
    expect(unjoinedResult.status).toBe('manual_required');
    expect(claimsFromToolResult(unjoinedResult, now, unjoined.claimAuthorization)).toEqual([]);
  });

  it('find claimKeys omit null roomType and never claim ratePlan', async () => {
    const now = new Date('2026-08-11T12:00:00.000Z');
    const candidate = confCandidate('HONEST-CONF-1');
    const driver = {
      searchExactAndMap: vi.fn(async (_candidate, _signal, mapResult) =>
        mapResult({
          outcome: 'matched',
          capped: false,
          observations: [
            {
              confirmationNumber: 'HONEST-CONF-1',
              externalReference: null,
              guestName: 'Syntherson, Alpha',
              arrivalDate: '2026-08-01',
              departureDate: '2026-08-03',
              reservationStatus: 'Confirmed',
              roomType: null,
              ratePlan: 'SHOULD-NOT-CLAIM',
            },
          ],
        }),
      ),
      lastAuditReceipt: vi.fn(() => null),
    };
    const session = createReservationCandidateSession({
      driver,
      candidates: new Map([[candidate.id, candidate]]),
      close: async () => undefined,
      now: () => now,
      activeReleases: new Map(),
    });
    const result = await session.findReservation(candidate.id, new AbortController().signal);
    expect(result.status).toBe('partial');
    expect(result.data?.matches[0]?.ratePlan).toBeNull();
    expect(result.unresolvedFields).toEqual(expect.arrayContaining(['roomType']));
    expect(result.evidence.claimKeys).toEqual(
      expect.arrayContaining([
        'matches.0.confirmationNumber',
        'matches.0.guestName',
        'matches.0.reservationStatus',
        'matches.0.arrivalDate',
        'matches.0.departureDate',
      ]),
    );
    expect(result.evidence.claimKeys).not.toContain('matches.0.roomType');
    expect(result.evidence.claimKeys).not.toContain('matches.0.ratePlan');
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

  it('duplicate exact rows same confirmation → ambiguous, never cherry-picks one row', () => {
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
    expect(result.outcome).toBe('ambiguous');
    if (result.outcome !== 'ambiguous') return;
    expect(result.observations).toHaveLength(2);
    expect(result.observations.every((row) => row.guestName === null)).toBe(true);
  });

  it('unrelated rows stripped — only candidate-correlated count', () => {
    const html = grid([
      rowHtml({ 'data-confirmation': SYNTH.confOther, 'data-status': 'Confirmed' }),
      rowHtml({ 'data-confirmation': 'UNRELATED-1', 'data-status': 'Confirmed' }),
    ]);
    expect(parseAndCorrelateGuestStayHtml(html, candidate).outcome).toBe('not_found');
  });

  it('many same-confirmation rows → capped ambiguity', () => {
    const rows = Array.from({ length: 21 }, (_, i) =>
      rowHtml({
        'data-confirmation': SYNTH.conf,
        'data-external': `E-${i}`,
        'data-status': 'Confirmed',
      }),
    );
    const result = parseAndCorrelateGuestStayHtml(grid(rows), candidate);
    expect(result.outcome).toBe('ambiguous');
    if (result.outcome !== 'ambiguous') return;
    expect(result.observations).toHaveLength(20);
    expect(result.capped).toBe(true);
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
      [rowHtml({ 'data-confirmation': SYNTH.conf, 'data-status': 'Confirmed' }, true)],
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
  const liveShapePath = join(here, '../evals/hms/osress-grid-dataspy-1941.live-shape.v1.json');

  function gridEnvelope(rows: unknown[], records?: string): string {
    const rec = records ?? (Array.isArray(rows) ? String(rows.length) : '0');
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
      ((wrongGrid.grid as Record<string, unknown>).GRIDRESULT as Record<string, unknown>)
        .GRID as Record<string, unknown>
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

    for (const envelope of [failed, wrongGrid, malformed, paginated, malformedEmpty]) {
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
        roomtype: 'STD',
        rateplan: 'BAR',
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
      roomType: 'STD',
      ratePlan: 'BAR',
    });
  });

  it('rejects lookalike aliases and keeps absent reviewed room/rate aliases null', () => {
    const lookalike = extractOsressPageData(
      gridEnvelope([
        {
          confirmation_number: SYNTH.conf,
          reservationstatus: 'Confirmed',
        },
      ]),
    )!;
    expect(() => parseLiveOsressGridRows(lookalike)).toThrowError(
      expect.objectContaining({ code: 'SCHEMA_DRIFT' }),
    );

    const exact = parseLiveOsressGridRows(
      extractOsressPageData(
        gridEnvelope([
          {
            confirmationnumber: SYNTH.conf,
            roomtypedescription: 'LOOKALIKE',
            rateplandescription: 'LOOKALIKE',
          },
        ]),
      )!,
    );
    expect(exact?.[0]).toMatchObject({ roomType: null, ratePlan: null });
  });

  it('primaryguest sentinel "-1" → compose guestName from lastname/firstname', () => {
    const rows = parseLiveOsressGridRows(
      extractOsressPageData(
        gridEnvelope([
          {
            confirmationnumber: SYNTH.conf,
            primaryguest: '-1',
            lastname: 'Syntherson',
            firstname: 'Alpha',
            status: 'Confirmed',
            arrivaldate: '15-Jan-2099',
            departuredate: '18-Jan-2099',
          },
        ]),
      )!,
    );
    expect(rows?.[0]?.guestName).toBe('Syntherson, Alpha');
    expect(rows?.[0]?.guestName).not.toBe('-1');
  });

  it('surname_dates correlates lastname+dates; wrong dates → not_found', () => {
    const text = gridEnvelope([
      {
        confirmationnumber: SYNTH.conf,
        primaryguest: '-1',
        lastname: 'Syntherson',
        firstname: 'Alpha',
        status: 'Confirmed',
        arrivaldate: '15-Jan-2099',
        departuredate: '18-Jan-2099',
      },
    ]);
    const hit = parseAndCorrelateGuestStayHtml(text, {
      id: 's1',
      kind: 'surname_dates',
      surname: 'Syntherson',
      arrivalDate: '2099-01-15',
      departureDate: '2099-01-18',
    });
    expect(hit.outcome).toBe('matched');
    if (hit.outcome === 'matched') {
      expect(hit.observations[0]?.guestName).toBe('Syntherson, Alpha');
    }
    const miss = parseAndCorrelateGuestStayHtml(text, {
      id: 's2',
      kind: 'surname_dates',
      surname: 'Syntherson',
      arrivalDate: '2099-02-01',
      departureDate: '2099-02-03',
    });
    expect(miss.outcome).toBe('not_found');
  });

  it('surname_dates ambiguous → capped matchCount honesty', () => {
    const text = gridEnvelope([
      {
        confirmationnumber: SYNTH.conf,
        lastname: 'Syntherson',
        firstname: 'Alpha',
        status: 'Confirmed',
        arrivaldate: '15-Jan-2099',
        departuredate: '18-Jan-2099',
      },
      {
        confirmationnumber: SYNTH.confOther,
        lastname: 'Syntherson',
        firstname: 'Beta',
        status: 'Confirmed',
        arrivaldate: '15-Jan-2099',
        departuredate: '18-Jan-2099',
      },
    ]);
    const result = parseAndCorrelateGuestStayHtml(text, {
      id: 's1',
      kind: 'surname_dates',
      surname: 'Syntherson',
      arrivalDate: '2099-01-15',
      departureDate: '2099-01-18',
    });
    expect(result.outcome).toBe('ambiguous');
    if (result.outcome === 'ambiguous') {
      expect(result.observations).toHaveLength(2);
      expect(result.observations.every((r) => r.guestName === null)).toBe(true);
    }
  });

  it('primaryguest-only numeric sentinel with no name parts → guestName null', () => {
    const rows = parseLiveOsressGridRows(
      extractOsressPageData(
        gridEnvelope([
          {
            confirmationnumber: SYNTH.conf,
            primaryguest: '-1',
            status: 'Confirmed',
          },
        ]),
      )!,
    );
    expect(rows?.[0]?.guestName).toBeNull();
  });

  it('committed live-shape fixture: sentinel primaryguest + absent roomtype/rateplan', () => {
    const fixture = JSON.parse(readFileSync(liveShapePath, 'utf8')) as {
      syntheticPageData: Record<string, unknown>;
      rowAliasKeysAbsentOnLiveSearchGrid: string[];
    };
    expect(fixture.rowAliasKeysAbsentOnLiveSearchGrid).toEqual(['roomtype', 'rateplan']);
    const rows = parseLiveOsressGridRows(fixture.syntheticPageData);
    expect(rows).toHaveLength(1);
    expect(rows![0]).toMatchObject({
      confirmationNumber: SYNTH.conf,
      guestName: 'Syntherson, Alpha',
      roomType: null,
      ratePlan: null,
      reservationStatus: 'Confirmed',
    });
    expect(rows![0]!.guestName).not.toBe('-1');
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
    const text = gridEnvelope([{ confirmationnumber: SYNTH.confOther, status: 'Confirmed' }]);
    expect(parseAndCorrelateGuestStayHtml(text, candidate).outcome).toBe('not_found');
  });
});

describe('live driver fail-closed boundaries', () => {
  const productionOrigin = 'https://hmsweb.hms.eu1.inforcloudsuite.com';

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

    await expect(driver.loginAndVerifyBinding(AbortSignal.timeout(5_000))).rejects.toMatchObject({
      code: 'POLICY_BLOCK',
    });
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

    await expect(driver.runNotFoundCanary(AbortSignal.timeout(5_000))).rejects.toMatchObject({
      code: 'SCHEMA_DRIFT',
    });
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
      await expect(driver.searchExact(confCandidate(), AbortSignal.timeout(5_000))).rejects.toBe(
        postError,
      );
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(unhandled).toEqual([]);
  });

  it('closes a blocked session as policy_blocked even when the tool succeeded', async () => {
    const { driver, close } = liveDriverWithSession({
      violation: () =>
        ({ action: 'block', ruleId: 'reservation-search' }) as ReturnType<
          HmsReadSession['violation']
        >,
      page: {
        content: async () => '<input name="search">',
        fill: async () => undefined,
        postForm: async () => grid([rowHtml({ 'data-confirmation': SYNTH.conf })]),
        waitForCorrelatedResponse: async () => undefined,
      },
    });

    await expect(
      driver.searchExact(confCandidate(), AbortSignal.timeout(5_000)),
    ).rejects.toMatchObject({ code: 'POLICY_BLOCK' });
    expect(close).toHaveBeenCalledWith({
      outcome: 'policy_blocked',
      terminalCode: 'POLICY_BLOCK',
      complete: true,
    });
  });

  it('quarantines successful no-match search receipts', async () => {
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
      outcome: 'unverified_negative',
      terminalCode: 'UNVERIFIED_NEGATIVE',
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
      outcome: 'unverified_negative',
      terminalCode: 'UNVERIFIED_NEGATIVE',
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
    expect(exact.map((c) => c.kind).sort()).toEqual(['confirmation', 'external_reference']);
  });

  it('surname_dates opens browser via lastname filters (Wave 0b)', async () => {
    const searchExactAndMap = vi.fn(async (_c, _s, map) =>
      map({
        outcome: 'matched' as const,
        observations: [
          {
            confirmationNumber: SYNTH.conf,
            externalReference: null,
            guestName: 'Syntherson, Ada',
            arrivalDate: SYNTH.arrival,
            departureDate: SYNTH.departure,
            reservationStatus: 'Reserved',
            roomType: null,
            ratePlan: null,
          },
        ] as [
          {
            confirmationNumber: string;
            externalReference: null;
            guestName: string;
            arrivalDate: string;
            departureDate: string;
            reservationStatus: string;
            roomType: null;
            ratePlan: null;
          },
        ],
        capped: false as const,
      }),
    );
    const driver: LiveGuestStayDriver = {
      loginAndVerifyBinding: vi.fn(),
      runNotFoundCanary: vi.fn(),
      searchExact: vi.fn(),
      searchExactAndMap,
      lastAuditReceipt: vi.fn(() => null),
    };
    const surnameId = 'surname-opaque';
    const session = createReservationCandidateSession({
      driver,
      candidates: new Map([
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
      close: async () => undefined,
    });
    const result = await session.findReservation(surnameId, new AbortController().signal);
    expect(searchExactAndMap).toHaveBeenCalledOnce();
    expect(result.status === 'ok' || result.status === 'partial').toBe(true);
    expect(result.data.matchCount).toBe(1);
    expect(result.data.matches[0]?.guestName).toBe('Syntherson, Ada');
  });

  it('missing candidate ID is manual_required, not a PMS negative', async () => {
    const driver: LiveGuestStayDriver = {
      loginAndVerifyBinding: vi.fn(),
      runNotFoundCanary: vi.fn(),
      searchExact: vi.fn(),
      searchExactAndMap: vi.fn(),
      lastAuditReceipt: vi.fn(() => null),
    };
    const session = createReservationCandidateSession({
      driver,
      candidates: new Map(),
      close: async () => undefined,
    });
    const result = await session.findReservation('missing', new AbortController().signal);
    expect(result.status).toBe('manual_required');
    expect(result.unresolvedFields).toEqual(['candidateId']);
    expect(driver.searchExactAndMap).not.toHaveBeenCalled();
  });

  it('maps parser not_found to unverified_negative', async () => {
    const candidate = confCandidate();
    const driver: LiveGuestStayDriver = {
      loginAndVerifyBinding: vi.fn(),
      runNotFoundCanary: vi.fn(),
      searchExact: vi.fn(),
      searchExactAndMap: vi.fn(async (_candidate, _signal, mapResult) =>
        mapResult({ outcome: 'not_found', observations: [], capped: false }),
      ),
      lastAuditReceipt: vi.fn(() => null),
    };
    const session = createReservationCandidateSession({
      driver,
      candidates: new Map([[candidate.id, candidate]]),
      close: async () => undefined,
    });
    const result = await session.findReservation(candidate.id, new AbortController().signal);
    expect(result.status).toBe('unverified_negative');
    expect(result.draftReady).toBe(false);
  });

  it('gather routes surname_dates via find when quote inactive → live search (Wave 0b)', async () => {
    const searchExactAndMap = vi.fn(async (_c, _s, map) =>
      map({
        outcome: 'matched' as const,
        observations: [
          {
            confirmationNumber: SYNTH.conf,
            externalReference: null,
            guestName: 'Syntherson, Ada',
            arrivalDate: SYNTH.arrival,
            departureDate: SYNTH.departure,
            reservationStatus: 'Reserved',
            roomType: null,
            ratePlan: null,
          },
        ] as [
          {
            confirmationNumber: string;
            externalReference: null;
            guestName: string;
            arrivalDate: string;
            departureDate: string;
            reservationStatus: string;
            roomType: null;
            ratePlan: null;
          },
        ],
        capped: false as const,
      }),
    );
    const surnameId = 'surname-gather';
    const session = createReservationCandidateSession({
      driver: {
        loginAndVerifyBinding: vi.fn(),
        runNotFoundCanary: vi.fn(),
        searchExact: vi.fn(),
        searchExactAndMap,
        lastAuditReceipt: vi.fn(() => null),
      },
      candidates: new Map([
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
      close: async () => undefined,
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

    expect(searchExactAndMap).toHaveBeenCalled();
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
      candidates: new Map([[confCandidate().id, confCandidate()]]),
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
    expect((bundle.tools as Record<string, unknown>).hms_quote_stay).toBeUndefined();
    expect((bundle.tools as Record<string, unknown>).mail_read_artifact).toBeUndefined();
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
          throw new AggregateError([new Error('tool failed'), fatal], 'tool and capture failed');
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
