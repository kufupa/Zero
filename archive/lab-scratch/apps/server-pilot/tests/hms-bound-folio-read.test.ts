import {
  createLiveFolioReadDriver,
  type LiveFolioReadDriverInput,
} from '../../../../../apps/server-pilot/src/hms/live-folio-read-driver.js';
import {
  readResultSchema,
  type ReadResult,
} from '../../../../../apps/server-pilot/src/hms/read-service-contracts.js';
import { buildLiveFolioReadManifest } from '../../../../../apps/server-pilot/src/hms/live-read-manifest.js';
import type { HmsSessionAuthorization } from '../../../../../apps/server-pilot/src/hms/release-kernel.js';
import {
  FOLIO_BOUND_READ_MAX_DURATION_MS,
  FOLIO_READ_MAX_BYTES,
  folioReadDataSchema,
} from '../../../../../apps/server-pilot/src/hms/folio-read-contract.js';
import type { ReadCandidateChild } from '../../../../../apps/server-pilot/src/hms/candidate-graph.js';
import { HmsRuntimeError, type HmsPage, type HmsRuntime } from '../../../../../apps/server-pilot/src/hms/runtime.js';
import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

const ORIGIN = 'https://appsrv-1.legacyhotels.co.za';
const CONFIRM = '12345';
const STAY_ID = '67890';
const ACCOUNT = 'ACC01';
const CURRENCY = 'ZAR';
const SCOPE = 'a'.repeat(64);

const DETAIL_VALUES = {
  confirmationnumber: CONFIRM,
  reservationstayid: STAY_ID,
  propertycode: 'HRCEN',
  guestfullname: 'REDACTED',
  account: ACCOUNT,
  guestid: 'GUEST1',
  hoteldate: '17-SEP-2026',
  lastname: 'REDACTED',
  firstname: 'REDACTED',
  twitterid: '',
  facebookid: '',
  tripadvisorid: '',
  bookingdotcomid: '',
  room: '101',
  balancecurr: CURRENCY,
};

const DETAIL_VALUES_WITH_CONFIGURED_DEPOSIT = {
  ...DETAIL_VALUES,
  depositamount: '3400.00',
  depositamountcurrency: CURRENCY,
  depositduedate: '08/24/2026 00:00',
  depositreceived: null,
  depositreceivedcurrency: null,
};

function auth(): HmsSessionAuthorization {
  const manifest = buildLiveFolioReadManifest(ORIGIN);
  return {
    operationId: randomUUID(),
    toolId: 'hms_read_folio',
    discoveryOperationId: 'folio_summary',
    releaseId: randomUUID(),
    requestBranchId: 'folio_summary',
    manifest,
    manifestSha256: createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
    roleProofPath: '/private/role-proof.json',
    roleProofSha256: 'b'.repeat(64),
    credentialVersionHmacSha256: 'c'.repeat(64),
    runtimeFingerprintSha256: 'd'.repeat(64),
    privateDigestKeyVersion: 'v1',
    sourceRevision: 'test',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

function child(): ReadCandidateChild {
  return {
    id: randomUUID(),
    sessionId: randomUUID(),
    parentEvidenceId: randomUUID(),
    toolId: 'hms_read_folio',
    requestBranchId: 'folio_summary',
    propertyCode: 'HRCEN',
    scopeHash: SCOPE,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

function folBody(
  overrides: {
    values?: Record<string, unknown>;
    rows?: Array<Record<string, unknown>>;
    metadata?: Record<string, unknown>;
    suffix?: string;
  } = {},
): string {
  const rows = overrides.rows ?? [
    {
      reference: CONFIRM,
      accountid: STAY_ID,
      account: ACCOUNT,
      propertycode: 'HRCEN',
      currency: CURRENCY,
      fdate: '17-SEP-2026',
      transactioncode: 'ROOM',
      amount: '10.00',
    },
    {
      reference: CONFIRM,
      accountid: STAY_ID,
      account: ACCOUNT,
      propertycode: 'HRCEN',
      currency: CURRENCY,
      fdate: '18-SEP-2026',
      transactioncode: 'TAX',
      amount: '-2.00',
    },
  ];
  return `${JSON.stringify({
    pageData: {
      values: {
        confirmationnumber: CONFIRM,
        accountid: STAY_ID,
        account: ACCOUNT,
        propertycode: 'HRCEN',
        foliototal: '0',
        foliototalcurr: CURRENCY,
        hotelcurrency: CURRENCY,
        ...overrides.values,
      },
      grid: {
        GRIDRESULT: {
          GRID: {
            DATA: rows,
            METADATA: {
              RECORDS: String(rows.length),
              CURRENTCURSORPOSITION: String(rows.length),
              MORERECORDPRESENT: '-',
              ...overrides.metadata,
            },
          },
        },
      },
    },
  })}${overrides.suffix ?? ''}`;
}

function allFolBody(
  rows: Array<Record<string, unknown>>,
  currentCursorPosition: number,
  more: '+' | '-',
): string {
  return JSON.stringify({
    pageData: {
      grid: {
        GRIDRESULT: {
          DATASPY: { id: '836', label: 'All Folios' },
          GRID: {
            DATA: rows,
            METADATA: {
              DATASPYID: '836',
              GRIDID: '780',
              GRIDNAME: 'OSFOLO',
              RECORDS: '96',
              CLIENTROWS: '50',
              CURRENTCURSORPOSITION: String(currentCursorPosition),
              MORERECORDPRESENT: more,
            },
          },
        },
      },
    },
  });
}

function allFolPosting(index: number): Record<string, unknown> {
  return {
    id: String(index),
    line: String(index),
    reference: CONFIRM,
    accountid: STAY_ID,
    account: ACCOUNT,
    propertycode: 'HRCEN',
    currency: CURRENCY,
    fdate: '17-SEP-2026',
    transactioncode: 'ROOM',
    amount: '1.00',
    transdesc: 'must not cross receipt boundary',
    fcomment: 'must not cross receipt boundary',
  };
}

function driverFor(
  body: string,
  onSetup?: () => void,
  onRead?: () => void,
  allDataBodies: string[] = [],
  detailValues: Record<string, string | number | null> = DETAIL_VALUES,
): {
  driver: ReturnType<typeof createLiveFolioReadDriver>;
  posts: Array<{
    path: string;
    fields: Record<string, string>;
    responseBounds?: { maxBytes: number; timeoutMs: number };
  }>;
  close: ReturnType<typeof vi.fn>;
} {
  const posts: Array<{
    path: string;
    fields: Record<string, string>;
    responseBounds?: { maxBytes: number; timeoutMs: number };
  }> = [];
  const close = vi.fn(async () => undefined);
  let allDataIndex = 0;
  const page: Partial<HmsPage> = {
    async postForm(
      url: string,
      fields: Record<string, string>,
      responseBounds?: { maxBytes: number; timeoutMs: number },
    ) {
      const path = new URL(url).pathname;
      posts.push({ path, fields, responseBounds });
      onRead?.();
      if (path === '/web/base/OSRESV.FOL.xmlhttp' || path === '/web/base/GETCACHE') {
        return allDataBodies[allDataIndex++] ?? body;
      }
      return body;
    },
  };
  const session = {
    id: randomUUID(),
    origin: ORIGIN,
    page: page as HmsPage,
    violation: () => null,
    terminal: () => false,
    close,
    lastReceipt: () => null,
  };
  const runtime = {
    openReadSession: vi.fn(async () => {
      onSetup?.();
      return session;
    }),
  } as unknown as HmsRuntime;
  const input: LiveFolioReadDriverInput = {
    runtime,
    transportId: 'folio-test-transport',
    expectedConfirmationToken: CONFIRM,
    reservationStayId: STAY_ID,
    expectedPropertyCode: 'HRCEN',
    detailDumpFor: async () => ({
      schemaVersion: 1,
      surface: 'guest_stay_detail',
      keys: Object.keys(detailValues),
      values: detailValues,
    }),
  };
  return { driver: createLiveFolioReadDriver(input), posts, close };
}

describe('bounded bound-parent FOL reader', () => {
  it('rejects complete balance when aggregate and every sub-folio are unknown', async () => {
    const { driver } = driverFor(folBody({ values: { foliototal: null } }));
    const result = await driver.observeBoundFolio(
      auth(),
      child(),
      ['balance'],
      new AbortController().signal,
    );
    expect(result.status).toBe('manual_required');
    expect(result.unavailableSections).toContainEqual({
      section: 'balance',
      reasonCode: 'SOURCE_UNAVAILABLE',
    });
  });

  it('measures source duration after bounded browser/session setup', async () => {
    vi.useFakeTimers();
    try {
      const { driver } = driverFor(folBody(), () => vi.setSystemTime(Date.now() + 20_000));
      const result = await driver.observeBoundFolio(
        auth(),
        child(),
        ['balance'],
        new AbortController().signal,
      );
      expect(result.status).toBe('ok');
      expect(result.data?.durationMs).toBeLessThan(5_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('still rejects a source read exceeding five seconds', async () => {
    vi.useFakeTimers();
    try {
      const { driver } = driverFor(folBody(), undefined, () =>
        vi.setSystemTime(Date.now() + 6_000),
      );
      const result = await driver.observeBoundFolio(
        auth(),
        child(),
        ['balance'],
        new AbortController().signal,
      );
      expect(result.status).toBe('manual_required');
      expect(result.issues.map((issue) => issue.code)).toContain('TIMEOUT');
    } finally {
      vi.useRealTimers();
    }
  });

  it('allows a ten-second bound receipt but rejects a 10001ms receipt', async () => {
    const { driver } = driverFor(folBody());
    const result = await driver.observeBoundFolio(
      auth(),
      child(),
      ['balance'],
      new AbortController().signal,
    );
    expect(result.data).not.toBeNull();
    if (!result.data) return;

    const tenSecondData = { ...result.data, durationMs: FOLIO_BOUND_READ_MAX_DURATION_MS };
    expect(folioReadDataSchema.safeParse(tenSecondData).success).toBe(true);
    expect(readResultSchema.safeParse({ ...result, data: tenSecondData }).success).toBe(true);

    const overTenSecondData = { ...result.data, durationMs: FOLIO_BOUND_READ_MAX_DURATION_MS + 1 };
    expect(folioReadDataSchema.safeParse(overTenSecondData).success).toBe(false);
    expect(readResultSchema.safeParse({ ...result, data: overTenSecondData }).success).toBe(false);
  });

  it('uses ten seconds across bound reads while capping every request at five seconds', async () => {
    vi.useFakeTimers();
    try {
      const firstRows = Array.from({ length: 50 }, (_, index) => allFolPosting(index + 1));
      const secondRows = Array.from({ length: 46 }, (_, index) => allFolPosting(index + 51));
      const baseBody = folBody({
        rows: Array.from({ length: 12 }, (_, index) => allFolPosting(index + 1)),
      });
      const { driver, posts } = driverFor(
        baseBody,
        undefined,
        () => vi.advanceTimersByTime(2_000),
        [allFolBody(firstRows, 50, '+'), allFolBody(secondRows, 96, '-')],
      );

      const result = await driver.observeBoundFolio(
        auth(),
        child(),
        ['transactions'],
        new AbortController().signal,
        undefined,
        { limit: 50 },
      );

      expect(result.status).toBe('ok');
      expect(result.data?.durationMs).toBe(6_000);
      expect(posts.map((post) => post.responseBounds?.timeoutMs)).toEqual([5_000, 5_000, 5_000]);
      expect(posts.every((post) => (post.responseBounds?.timeoutMs ?? 0) <= 5_000)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('maps a recognized bounded transport timeout to stable TIMEOUT', async () => {
    const { driver } = driverFor(folBody(), undefined, () => {
      throw new HmsRuntimeError('TIMEOUT', 'private transport detail must not escape');
    });
    const result = await driver.observeBoundFolio(
      auth(),
      child(),
      ['balance'],
      new AbortController().signal,
    );

    expect(result.status).toBe('manual_required');
    expect(result.issues.map((issue) => issue.code)).toContain('TIMEOUT');
    expect(JSON.stringify(result)).not.toContain('private transport detail');
  });

  it('marks a balance-only request complete without counting unrequested sections', async () => {
    const { driver } = driverFor(folBody());
    const result = await driver.observeBoundFolio(
      auth(),
      child(),
      ['balance'],
      new AbortController().signal,
    );

    expect(result.status).toBe('ok');
    expect(result.completeness).toBe('complete');
    expect(result.unavailableSections).toEqual([]);
    expect(result.data?.disclosure.claimEligibility).toBe('blocked');
    expect(readResultSchema.safeParse(result).success).toBe(true);
  });

  it('returns source-coded per-folio balances while retaining aggregate total', async () => {
    const { driver } = driverFor(
      folBody({
        values: {
          foliototal: '0.00',
          guesttotal: '-2.50',
          guesttotalcurr: CURRENCY,
          artotal: '3.00',
          artotalcurr: CURRENCY,
          folio6total: '0.00',
          folio6totalcurr: CURRENCY,
        },
      }),
    );
    const result = await driver.observeBoundFolio(
      auth(),
      child(),
      ['balance'],
      new AbortController().signal,
    );

    expect(result.status).toBe('ok');
    expect(result.data?.totalBalance).toBe('0.00');
    const balance = result.data?.balance;
    expect(balance?.state).toBe('available');
    if (balance?.state !== 'available') return;
    expect(balance.data.items).toHaveLength(11);
    expect(balance.data.items.find((item) => item.folioType.value === 'guest')).toMatchObject({
      folioRef: { state: 'known', value: expect.stringMatching(/^folio:/) },
      balance: { state: 'known', value: { amount: '-2.50', currency: CURRENCY } },
    });
    expect(
      balance.data.items.find((item) => item.folioType.value === 'accounts_receivable'),
    ).toMatchObject({
      balance: { state: 'known', value: { amount: '3.00', currency: CURRENCY } },
    });
    expect(balance.data.items.find((item) => item.folioType.value === 'accounting')).toMatchObject({
      balance: { state: 'known', value: { amount: '0.00', currency: CURRENCY } },
    });
    expect(balance.data.items.find((item) => item.folioType.value === 'adjustment')).toMatchObject({
      balance: { state: 'unknown', value: null },
    });
    expect(readResultSchema.safeParse(result).success).toBe(true);
  });

  it('returns a direct canonical partial result for all requested sections', async () => {
    const { driver, posts, close } = driverFor(folBody({ suffix: 'x'.repeat(85_000) }));
    const result = await driver.observeBoundFolio(
      auth(),
      child(),
      ['balance', 'deposits', 'transactions', 'authorization'],
      new AbortController().signal,
      { recipientClass: 'reservation_guest', inquiryClass: 'labelled_narrow_status' },
    );

    expect(result.status).toBe('partial');
    expect(result.completeness).toBe('partial');
    expect(result.data?.currency).toBe(CURRENCY);
    expect(result.data?.totalBalance).toBe('0.00');
    expect(result.data?.transactions?.state).toBe('unavailable');
    expect(result.data?.transactions?.reasonCode).toBe('SOURCE_UNAVAILABLE');
    expect(result.data?.deposits?.state).toBe('unavailable');
    expect(result.data?.deposits?.reasonCode).toBe('SOURCE_UNAVAILABLE');
    expect(result.data?.authorization?.state).toBe('unknown');
    expect(result.unavailableSections.map((section) => section.section)).toEqual(
      expect.arrayContaining(['deposits', 'authorization']),
    );
    expect(result.evidence[0]?.sourceSurface).toBe('OSRESV.FOL');
    expect(result.data?.bytesObserved).toBeGreaterThan(85_000);
    expect(readResultSchema.safeParse(result).success).toBe(true);
    expect(posts).toHaveLength(2);
    expect(posts[0]?.path).toBe('/web/base/OSRESV.FOL');
    expect(posts[0]?.fields.hoteldate).toBe('09/17/2026');
    expect(posts[0]?.fields).not.toHaveProperty('id');
    expect(posts[0]?.fields).not.toHaveProperty('MENU_MODULE_KEY');
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('does not promote a configured detail deposit requirement into ledger facts', async () => {
    const { driver } = driverFor(
      folBody(),
      undefined,
      undefined,
      [],
      DETAIL_VALUES_WITH_CONFIGURED_DEPOSIT,
    );
    const result = await driver.observeBoundFolio(
      auth(),
      child(),
      ['deposits'],
      new AbortController().signal,
    );

    expect(result.status).toBe('manual_required');
    expect(result.data?.deposits).toMatchObject({
      state: 'unavailable',
      data: null,
      reasonCode: 'SOURCE_UNAVAILABLE',
      issues: [{ code: 'SOURCE_UNAVAILABLE' }],
    });
    expect(result.data?.depositSummary).toBeUndefined();
    expect(result.data?.deposits?.data).toBeNull();
  });

  it('rejects a FOL source beyond the bounded source budget', async () => {
    const { driver, close } = driverFor(folBody({ suffix: 'x'.repeat(FOLIO_READ_MAX_BYTES + 1) }));
    const result = await driver.observeBoundFolio(
      auth(),
      child(),
      ['balance', 'transactions'],
      new AbortController().signal,
    );

    expect(result.status).toBe('manual_required');
    expect(result.data).toBeNull();
    expect(result.issues.map((issue) => issue.code)).toContain('SIZE_LIMIT');
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('returns TIMEOUT when the caller aborts after the bound FOL response', async () => {
    const controller = new AbortController();
    const { driver } = driverFor(folBody(), undefined, () => controller.abort());
    const result = await driver.observeBoundFolio(
      auth(),
      child(),
      ['balance'],
      controller.signal,
    );

    expect(result.status).toBe('manual_required');
    expect(result.issues.map((issue) => issue.code)).toContain('TIMEOUT');
  });

  it('does not downgrade an All Folios AbortError into source unavailability', async () => {
    const controller = new AbortController();
    let readCount = 0;
    const { driver } = driverFor(
      folBody(),
      undefined,
      () => {
        readCount += 1;
        if (readCount === 2) {
          controller.abort();
          const error = new Error('request aborted');
          error.name = 'AbortError';
          throw error;
        }
      },
      [allFolBody([allFolPosting(1)], 1, '-')],
    );
    const result = await driver.observeBoundFolio(
      auth(),
      child(),
      ['transactions'],
      controller.signal,
      undefined,
      { limit: 50 },
    );

    expect(readCount).toBe(2);
    expect(result.status).toBe('manual_required');
    expect(result.issues.map((issue) => issue.code)).toContain('TIMEOUT');
  });

  it.each([
    ['wrong parent', { values: { accountid: 'OTHER-STAY' } }, 'SCOPE_DENIED'],
    ['wrong currency', { values: { foliototalcurr: 'USD' } }, 'SCOPE_DENIED'],
    ['unsupported schema', { metadata: { RECORDS: 'not-a-count' } }, 'UNSUPPORTED_FORMAT'],
  ] as const)('fails closed for %s', async (_label, options, reasonCode) => {
    const { driver } = driverFor(folBody(options));
    const result = await driver.observeBoundFolio(
      auth(),
      child(),
      ['balance', 'deposits', 'transactions'],
      new AbortController().signal,
    );
    expect(result.status).toBe('manual_required');
    expect(result.data).toBeNull();
    expect(result.issues.map((issue) => issue.code)).toContain(reasonCode);
  });

  it('reads all typed All Folios pages and exposes at most fifty rows with a bound cursor', async () => {
    const firstRows = Array.from({ length: 50 }, (_, index) => allFolPosting(index + 1));
    const secondRows = Array.from({ length: 46 }, (_, index) => allFolPosting(index + 51));
    const baseBody = folBody({
      rows: Array.from({ length: 12 }, (_, index) => allFolPosting(index + 1)),
    });
    const { driver, posts } = driverFor(baseBody, undefined, undefined, [
      allFolBody(firstRows, 50, '+'),
      allFolBody(secondRows, 96, '-'),
    ]);

    const result = await driver.observeBoundFolio(
      auth(),
      child(),
      ['transactions'],
      new AbortController().signal,
      undefined,
      { limit: 50 },
    );

    expect(result.status).toBe('ok');
    expect(result.completeness).toBe('complete');
    expect(result.data?.transactions?.state).toBe('available');
    expect(result.data?.transactions?.data?.items).toHaveLength(50);
    expect(result.data?.rowsScanned).toBe(108);
    expect(result.page?.hasMore).toBe(true);
    expect(result.page?.nextCursor).toMatch(/^fol1:[a-f0-9]{64}:50$/);
    expect(result.evidence[0]?.sourceSurface).toBe('OSRESV.FOL+OSRESV.FOL.xmlhttp+GETCACHE');
    expect(result.evidence[0]?.sourceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.evidence[0]?.sourceHash).not.toBe(
      createHash('sha256').update(baseBody).digest('hex'),
    );
    expect(posts.map((post) => post.path)).toEqual([
      '/web/base/OSRESV.FOL',
      '/web/base/OSRESV.FOL.xmlhttp',
      '/web/base/GETCACHE',
    ]);
    expect(posts[0]?.responseBounds).toEqual({
      maxBytes: FOLIO_READ_MAX_BYTES,
      timeoutMs: expect.any(Number),
    });
    expect(posts[0]?.responseBounds?.timeoutMs).toBeGreaterThan(0);
    expect(posts[0]?.responseBounds?.timeoutMs).toBeLessThanOrEqual(5_000);
    for (const post of posts.slice(1)) {
      expect(post.responseBounds?.maxBytes).toBeGreaterThan(0);
      expect(post.responseBounds?.maxBytes).toBeLessThanOrEqual(FOLIO_READ_MAX_BYTES);
      expect(post.responseBounds?.timeoutMs).toBeGreaterThan(0);
      expect(post.responseBounds?.timeoutMs).toBeLessThanOrEqual(5_000);
    }
    expect(posts[1]?.responseBounds?.maxBytes).toBe(
      FOLIO_READ_MAX_BYTES - Buffer.byteLength(baseBody),
    );
    expect(posts[2]?.responseBounds?.maxBytes).toBe(
      FOLIO_READ_MAX_BYTES - Buffer.byteLength(baseBody) - Buffer.byteLength(allFolBody(firstRows, 50, '+')),
    );
    expect(JSON.stringify(result)).not.toContain('must not cross receipt boundary');
  });

  it('re-reads a full source before accepting a continuation cursor', async () => {
    const firstRows = Array.from({ length: 50 }, (_, index) => allFolPosting(index + 1));
    const secondRows = Array.from({ length: 46 }, (_, index) => allFolPosting(index + 51));
    const initial = [allFolBody(firstRows, 50, '+'), allFolBody(secondRows, 96, '-')];
    const first = driverFor(folBody(), undefined, undefined, initial);
    const firstResult = await first.driver.observeBoundFolio(
      auth(),
      child(),
      ['transactions'],
      new AbortController().signal,
      undefined,
      { limit: 50 },
    );
    const cursor = firstResult.page?.nextCursor;
    expect(cursor).toMatch(/^fol1:/);

    const second = driverFor(folBody(), undefined, undefined, initial);
    const secondResult = await second.driver.observeBoundFolio(
      auth(),
      child(),
      ['transactions'],
      new AbortController().signal,
      undefined,
      { cursor: cursor ?? undefined, limit: 50 },
    );
    expect(secondResult.status).toBe('ok');
    expect(secondResult.data?.transactions?.data?.items).toHaveLength(46);
    expect(secondResult.page?.hasMore).toBe(false);

    const changed = driverFor(folBody(), undefined, undefined, [
      allFolBody(
        firstRows.map((row) => ({ ...row, amount: '2.00' })),
        50,
        '+',
      ),
      allFolBody(secondRows, 96, '-'),
    ]);
    const changedResult = await changed.driver.observeBoundFolio(
      auth(),
      child(),
      ['transactions'],
      new AbortController().signal,
      undefined,
      { cursor: cursor ?? undefined, limit: 50 },
    );
    expect(changedResult.status).toBe('manual_required');
    expect(changedResult.issues.map((issue) => issue.code)).toContain('STALE_EVIDENCE');
  });

  it('rejects a cursor whose offset was forged without changing its source digest', async () => {
    const firstRows = Array.from({ length: 50 }, (_, index) => allFolPosting(index + 1));
    const secondRows = Array.from({ length: 46 }, (_, index) => allFolPosting(index + 51));
    const pages = [allFolBody(firstRows, 50, '+'), allFolBody(secondRows, 96, '-')];
    const first = driverFor(folBody(), undefined, undefined, pages);
    const firstResult = await first.driver.observeBoundFolio(
      auth(),
      child(),
      ['transactions'],
      new AbortController().signal,
      undefined,
      { limit: 50 },
    );
    const cursor = firstResult.page?.nextCursor;
    expect(cursor).toMatch(/^fol1:[a-f0-9]{64}:50$/);
    const forgedCursor = cursor!.replace(/:\d+$/, ':1');

    const second = driverFor(folBody(), undefined, undefined, pages);
    const result = await second.driver.observeBoundFolio(
      auth(),
      child(),
      ['transactions'],
      new AbortController().signal,
      undefined,
      { cursor: forgedCursor, limit: 50 },
    );

    expect(result.status).toBe('manual_required');
    expect(result.issues.map((issue) => issue.code)).toContain('STALE_EVIDENCE');
  });
});

type AssertCanonical = ReadResult<unknown>;
void (null as AssertCanonical | null);
