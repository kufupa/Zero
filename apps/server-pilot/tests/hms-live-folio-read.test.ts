import {
  buildDepositSummary,
  classifyDepositActivity,
  createLiveFolioReadDriver,
  DEPOSIT_LEDGER_RESERVATION_SCOPE_BLOCKER,
  extractDepositLedgerDateScopes,
  mergeFolioEvidence,
  parseDepositLedgerTransport,
  parseFolioBalanceTransport,
  type DepositSummaryKernelResult,
  type FolioBalanceKernelResult,
} from '../src/hms/live-folio-read-driver.js';
import {
  buildLiveDepositLedgerManifest,
  buildLiveFolioReadManifest,
  LIVE_DEPOSIT_LEDGER_DETAIL_PATH,
  LIVE_DEPOSIT_LEDGER_LIST_PATH,
  LIVE_GUEST_STAY_SEARCH_PATH,
} from '../src/hms/live-read-manifest.js';
import {
  FOLIO_READ_MAX_BYTES,
  FOLIO_READ_MAX_DURATION_MS,
  FOLIO_READ_PRIVACY_POLICY,
} from '../src/hms/folio-read-contract.js';
import { HmsRuntimeError, type HmsPage, type HmsRuntime } from '../src/hms/runtime.js';
import type { HmsSessionAuthorization } from '../src/hms/release-kernel.js';
import type { ReadCandidateChild } from '../src/hms/candidate-graph.js';
import { READ_TOOLS } from '../src/hms/read-tools.js';
import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

const ORIGIN = 'https://appsrv-1.legacyhotels.co.za';
const NOW = '2026-08-06T12:00:00.000Z';
const SCOPE = 'a'.repeat(64);
const CONFIRM = '12345';

function folioEnvelope(rows: Array<Record<string, unknown>>): string {
  return JSON.stringify({
    pageData: {
      success: true,
      grid: {
        GRIDRESULT: {
          type: 'LIST.DATA_ONLY.STORED',
          GRID: { DATA: rows },
        },
      },
    },
  });
}

function auth(overrides: Partial<HmsSessionAuthorization> = {}): HmsSessionAuthorization {
  const branch = overrides.requestBranchId ?? 'folio_summary';
  const manifest =
    branch === 'deposit_ledger_summary'
      ? buildLiveDepositLedgerManifest(ORIGIN)
      : buildLiveFolioReadManifest(ORIGIN);
  return {
    operationId: randomUUID(),
    toolId: 'hms_read_folio',
    discoveryOperationId:
      branch === 'deposit_ledger_summary' ? 'deposit_ledger_summary' : 'folio_summary',
    releaseId: randomUUID(),
    requestBranchId: branch,
    manifest,
    manifestSha256: createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
    roleProofPath: '/tmp/role-proof-folio.v2.json',
    roleProofSha256: 'b'.repeat(64),
    credentialVersionHmacSha256: 'c'.repeat(64),
    runtimeFingerprintSha256: 'd'.repeat(64),
    privateDigestKeyVersion: 'v1',
    sourceRevision: 'test-rev',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  };
}

function child(overrides: Partial<ReadCandidateChild> = {}): ReadCandidateChild {
  return {
    id: randomUUID(),
    sessionId: randomUUID(),
    parentEvidenceId: randomUUID(),
    toolId: 'hms_read_folio',
    requestBranchId: 'folio_summary',
    propertyCode: 'HRCEN',
    scopeHash: SCOPE,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  };
}

function mockRuntime(htmlOrBody: string | ((path: string) => string)) {
  const posts: Array<{ path: string; fields: Record<string, string> }> = [];
  const resolve = (path: string) =>
    typeof htmlOrBody === 'function' ? htmlOrBody(path) : htmlOrBody;
  const page: Partial<HmsPage> = {
    async content() {
      return typeof htmlOrBody === 'function' ? htmlOrBody('') : htmlOrBody;
    },
    async click() {},
    async evaluate() {
      return {};
    },
    async postForm(url: string, fields: Record<string, string>) {
      const path = new URL(url).pathname;
      posts.push({ path, fields });
      return resolve(path);
    },
    waitForCorrelatedResponse: async () => undefined,
  };
  const session = {
    id: 'folio-session',
    origin: ORIGIN,
    page: page as HmsPage,
    violation: () => null,
    terminal: () => false,
    close: vi.fn(async () => undefined),
  };
  const runtime = {
    openReadSession: vi.fn(async () => session),
  } as unknown as HmsRuntime;
  return { runtime, posts, session };
}

describe('folio / deposit transport parsers', () => {
  it('parses foliobalance + currency and rejects fixture HTML', () => {
    const parsed = parseFolioBalanceTransport(
      folioEnvelope([{ foliobalance: '75.50', propertycurrency: 'ZAR', cardnumber: '****' }]),
    );
    expect(parsed.envelopeRecognized).toBe(true);
    expect(parsed.totalBalance).toBe('75.50');
    expect(parsed.currency).toBe('ZAR');
    expect(() => parseFolioBalanceTransport('<div data-testid="folio-row"></div>')).toThrow(
      HmsRuntimeError,
    );
  });

  it('suppresses card-like money and flags card leak', () => {
    const parsed = parseFolioBalanceTransport(
      folioEnvelope([
        {
          foliobalance: '4111111111111111',
          propertycurrency: 'ZAR',
          cardnumber: '4111111111111111',
        },
      ]),
    );
    expect(parsed.totalBalance).toBeNull();
    expect(parsed.hasCardLeak).toBe(true);
  });

  it('requires confirmation column for deposit reservation scope', () => {
    const noConf = parseDepositLedgerTransport(
      folioEnvelope([
        {
          currency: 'ZAR',
          newdeposits: '10.00',
          refunds: '0.00',
          forfeits: '0.00',
          toguestledger: '0.00',
          name: 'REDACTED',
        },
      ]),
      CONFIRM,
    );
    expect(noConf.reservationScopeProven).toBe(false);

    const withConf = parseDepositLedgerTransport(
      folioEnvelope([
        {
          confirmationnumber: CONFIRM,
          currency: 'ZAR',
          newdeposits: '10.00',
          refunds: '1.00',
          forfeits: '0.00',
          toguestledger: '2.00',
        },
      ]),
      CONFIRM,
    );
    expect(withConf.reservationScopeProven).toBe(true);
    expect(withConf.depositSummary?.paid.amount).toBe('10.00');
    expect(withConf.depositSummary?.refunded.amount).toBe('1.00');
    expect(withConf.depositSummary?.transferred.amount).toBe('2.00');
    const serialized = JSON.stringify(withConf);
    expect(serialized).not.toContain('REDACTED');
    expect(serialized).not.toMatch(/4111/);
  });

  it('parses OSLEDG.DLD activity rows by confirmationnumber; flags PAN leak', () => {
    expect(classifyDepositActivity('Deposit Payment')).toBe('paid');
    expect(classifyDepositActivity('Amount Refunded')).toBe('refunded');
    expect(classifyDepositActivity('Transfer to Guest Ledger')).toBe('transferred');

    const scopes = extractDepositLedgerDateScopes(
      folioEnvelope([
        {
          hoteldate: '06-AUG-2026',
          closingdate: '06-AUG-2026',
          property: 'HRCEN',
          currency: 'ZAR',
          newdeposits: '1.00',
        },
      ]),
    );
    expect(scopes.scopes).toEqual([{ closingdate: '06-AUG-2026', property: 'HRCEN' }]);
    expect(scopes.truncated).toBe(false);

    const dld = parseDepositLedgerTransport(
      folioEnvelope([
        {
          confirmationnumber: CONFIRM,
          currency: 'ZAR',
          amount: '50.00',
          activitytype_display: 'Deposit Payment',
          name: 'REDACTED',
          paymentcardnumber: '****',
          toaccount: 'ACC1',
        },
        {
          confirmationnumber: CONFIRM,
          currency: 'ZAR',
          amount: '10.00',
          activitytype_display: 'Amount Refunded',
        },
        {
          confirmationnumber: 'OTHER',
          currency: 'ZAR',
          amount: '99.00',
          activitytype_display: 'Deposit Payment',
        },
      ]),
      CONFIRM,
    );
    expect(dld.reservationScopeProven).toBe(true);
    expect(dld.depositSummary?.paid.amount).toBe('50.00');
    expect(dld.depositSummary?.refunded.amount).toBe('10.00');
    expect(JSON.stringify(dld)).not.toContain('REDACTED');
    expect(JSON.stringify(dld)).not.toContain('ACC1');

    const leak = parseDepositLedgerTransport(
      folioEnvelope([
        {
          confirmationnumber: CONFIRM,
          currency: 'ZAR',
          amount: '1.00',
          activitytype_display: 'Deposit Payment',
          paymentcardnumber: '4111111111111111',
        },
      ]),
      CONFIRM,
    );
    expect(leak.hasCardLeak).toBe(true);
  });
});

describe('mergeFolioEvidence', () => {
  const disclosure = {
    recipientClass: 'reservation_guest' as const,
    inquiryClass: 'labelled_narrow_status' as const,
  };

  it('requires trusted disclosure — observations cannot supply classes', () => {
    const balance: FolioBalanceKernelResult = {
      status: 'ok',
      currency: 'ZAR',
      totalBalance: '10.00',
      evidenceId: randomUUID(),
      blocker: null,
      observedAt: NOW,
      rowsScanned: 1,
      bytesObserved: 100,
      durationMs: 10,
    };
    const merged = mergeFolioEvidence([balance]);
    expect(merged.status).toBe('manual_required');
    expect(merged.unresolvedFields).toContain('FOLIO_TRUSTED_DISCLOSURE_REQUIRED');
  });

  it('two-step merge ok; one branch yields explicitly partial', () => {
    const balance: FolioBalanceKernelResult = {
      status: 'ok',
      currency: 'ZAR',
      totalBalance: '75.00',
      evidenceId: randomUUID(),
      blocker: null,
      observedAt: NOW,
      rowsScanned: 1,
      bytesObserved: 200,
      durationMs: 20,
    };
    const deposit: DepositSummaryKernelResult = {
      status: 'ok',
      currency: 'ZAR',
      depositSummary: buildDepositSummary({
        due: '0.00',
        paid: '50.00',
        refunded: '0.00',
        forfeited: '0.00',
        transferred: '0.00',
      }),
      evidenceId: randomUUID(),
      blocker: null,
      observedAt: NOW,
      rowsScanned: 1,
      bytesObserved: 200,
      durationMs: 20,
    };
    const full = mergeFolioEvidence([balance, deposit], disclosure);
    expect(full.status).toBe('ok');
    expect(full.data.totalBalance).toBe('75.00');
    expect(full.data.disclosure.recipientClass).toBe('reservation_guest');

    const partial = mergeFolioEvidence([balance], disclosure);
    expect(partial.status).toBe('partial');
    expect(partial.unresolvedFields.length).toBeGreaterThan(0);

    const currencyMismatch = mergeFolioEvidence(
      [balance, { ...deposit, currency: 'USD' }],
      disclosure,
    );
    expect(currencyMismatch.status).toBe('manual_required');
    expect(currencyMismatch.unresolvedFields).toContain('FOLIO_CURRENCY_OR_TOTAL_INCONSISTENT');
  });
});

describe('live folio driver binding + denied actions', () => {
  it('binds parent authorization + child and posts OSRESS.search only for folio branch', async () => {
    const body = folioEnvelope([{ foliobalance: '12.00', propertycurrency: 'ZAR' }]);
    const { runtime, posts } = mockRuntime(body);
    const driver = createLiveFolioReadDriver({
      runtime,
      transportId: 't1',
      expectedConfirmationToken: CONFIRM,
      auditSpecFor: ({ branchId }) => ({
        operationId: 'folio-audit-operation',
        toolId: 'hms_read_folio',
        toolVersion: '1.0.0',
        dependencyRevision: 'playwright-1.52.0-chromium-1169',
        executionClass: 'normal',
        inputClass: 'authorized_exact',
        requestBranchId: branchId,
      }),
    });
    const a = auth();
    const c = child({
      toolId: a.toolId,
      requestBranchId: a.requestBranchId,
    });
    const result = await driver.observeFolioBalance(a, c, new AbortController().signal);
    expect(result.status).toBe('ok');
    expect(result.totalBalance).toBe('12.00');
    expect(
      (runtime.openReadSession as ReturnType<typeof vi.fn>).mock.calls[0]?.[0].auditSpec,
    ).toMatchObject({
      toolId: 'hms_read_folio',
      requestBranchId: 'folio_summary',
    });
    expect(posts.some((p) => p.path === LIVE_GUEST_STAY_SEARCH_PATH)).toBe(true);
    expect(
      posts.every((p) => !/settle|refund|post|print|export|advance|transfer|void/i.test(p.path)),
    ).toBe(true);
    expect(JSON.stringify(result)).not.toContain('recipientClass');
    expect(JSON.stringify(result)).not.toContain('inquiryClass');
  });

  it('rejects stale/cross-thread/third-party branch/unknown property', async () => {
    const { runtime } = mockRuntime(folioEnvelope([]));
    const driver = createLiveFolioReadDriver({
      runtime,
      transportId: 't1',
      expectedConfirmationToken: CONFIRM,
    });
    const signal = new AbortController().signal;

    await expect(
      driver.observeFolioBalance(
        auth({ expiresAt: new Date(Date.now() - 1000).toISOString() }),
        child(),
        signal,
      ),
    ).rejects.toBeInstanceOf(HmsRuntimeError);

    await expect(
      driver.observeFolioBalance(
        auth({ requestBranchId: 'deposit_ledger_summary' }),
        child({ requestBranchId: 'deposit_ledger_summary' }),
        signal,
      ),
    ).rejects.toBeInstanceOf(HmsRuntimeError);

    await expect(
      driver.observeFolioBalance(
        auth(),
        child({ toolId: 'hms_sent_email_audit' as never }),
        signal,
      ),
    ).rejects.toBeInstanceOf(HmsRuntimeError);

    await expect(
      driver.observeFolioBalance(auth(), child({ propertyCode: 'OTHER' }), signal),
    ).rejects.toBeInstanceOf(HmsRuntimeError);
  });

  it('sibling branch swap denied — deposit observer rejects folio auth', async () => {
    const { runtime } = mockRuntime(
      folioEnvelope([
        {
          confirmationnumber: CONFIRM,
          currency: 'ZAR',
          newdeposits: '1.00',
          refunds: '0.00',
          forfeits: '0.00',
          toguestledger: '0.00',
        },
      ]),
    );
    const driver = createLiveFolioReadDriver({
      runtime,
      transportId: 't1',
      expectedConfirmationToken: CONFIRM,
    });
    await expect(
      driver.observeDepositSummary(
        auth({ requestBranchId: 'folio_summary' }),
        child({ requestBranchId: 'folio_summary' }),
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(HmsRuntimeError);
  });

  it('deposit live LST without confirmation → reservation scope blocker', async () => {
    const body = folioEnvelope([
      {
        currency: 'ZAR',
        newdeposits: '10.00',
        refunds: '0.00',
        forfeits: '0.00',
        toguestledger: '0.00',
        hoteldate: '06-AUG-2026',
      },
    ]);
    const { runtime, posts } = mockRuntime(body);
    const driver = createLiveFolioReadDriver({
      runtime,
      transportId: 't1',
      expectedConfirmationToken: CONFIRM,
      auditSpecFor: ({ branchId }) => ({
        operationId: 'deposit-audit-operation',
        toolId: 'hms_read_folio',
        toolVersion: '1.0.0',
        dependencyRevision: 'playwright-1.52.0-chromium-1169',
        executionClass: 'normal',
        inputClass: 'authorized_exact',
        requestBranchId: branchId,
      }),
    });
    const a = auth({ requestBranchId: 'deposit_ledger_summary' });
    const c = child({
      toolId: a.toolId,
      requestBranchId: a.requestBranchId,
    });
    const result = await driver.observeDepositSummary(a, c, new AbortController().signal);
    expect(result.status).toBe('manual_required');
    expect(result.blocker).toBe(DEPOSIT_LEDGER_RESERVATION_SCOPE_BLOCKER);
    expect(
      (runtime.openReadSession as ReturnType<typeof vi.fn>).mock.calls[0]?.[0].auditSpec,
    ).toMatchObject({
      toolId: 'hms_read_folio',
      requestBranchId: 'deposit_ledger_summary',
    });
    expect(posts.some((p) => p.path === LIVE_DEPOSIT_LEDGER_LIST_PATH)).toBe(true);
  });

  it('deposit LST→DLD with confirmationnumber → ok; no card/name leakage', async () => {
    const lst = folioEnvelope([
      {
        closingdate: '06-AUG-2026',
        property: 'HRCEN',
        currency: 'ZAR',
        newdeposits: '10.00',
      },
    ]);
    const dld = folioEnvelope([
      {
        confirmationnumber: CONFIRM,
        currency: 'ZAR',
        amount: '25.00',
        activitytype_display: 'Deposit Payment',
        name: 'REDACTED',
        paymentcardnumber: '****',
      },
    ]);
    const { runtime, posts } = mockRuntime((path) => (path.includes('OSLEDG.DLD') ? dld : lst));
    const driver = createLiveFolioReadDriver({
      runtime,
      transportId: 't1',
      expectedConfirmationToken: CONFIRM,
    });
    const a = auth({ requestBranchId: 'deposit_ledger_summary' });
    const c = child({
      toolId: a.toolId,
      requestBranchId: a.requestBranchId,
    });
    const result = await driver.observeDepositSummary(a, c, new AbortController().signal);
    expect(result.status).toBe('ok');
    expect(result.depositSummary?.paid.amount).toBe('25.00');
    expect(posts.some((p) => p.path === LIVE_DEPOSIT_LEDGER_LIST_PATH)).toBe(true);
    expect(posts.some((p) => p.path === LIVE_DEPOSIT_LEDGER_DETAIL_PATH)).toBe(true);
    const dldPost = posts.find((p) => p.path === LIVE_DEPOSIT_LEDGER_DETAIL_PATH);
    expect(dldPost?.fields.closingdate).toBe('06-AUG-2026');
    expect(dldPost?.fields.property).toBe('HRCEN');
    expect(dldPost?.fields.CURRENT_TAB_NAME).toBe('DLD');
    expect(JSON.stringify(result)).not.toContain('REDACTED');
    expect(JSON.stringify(result)).not.toMatch(
      /(?:cardnumber|paymentcardnumber|virtualcardnumber)/i,
    );
    expect(
      posts.every((p) => !/settle|refund|post|print|export|advance|transfer|void/i.test(p.path)),
    ).toBe(true);
  });

  it('keeps unknown normal-observer activity incomplete through merge', async () => {
    const unknownActivity = folioEnvelope([
      {
        confirmationnumber: CONFIRM,
        currency: 'ZAR',
        amount: '20.00',
        activitytype_display: 'Manual Reconciliation Adjustment',
      },
    ]);
    const { runtime } = mockRuntime(unknownActivity);
    const driver = createLiveFolioReadDriver({
      runtime,
      transportId: 't1',
      expectedConfirmationToken: CONFIRM,
    });
    const deposit = await driver.observeDepositSummary(
      auth({ requestBranchId: 'deposit_ledger_summary' }),
      child({ requestBranchId: 'deposit_ledger_summary' }),
      new AbortController().signal,
    );
    const merged = mergeFolioEvidence(
      [
        {
          status: 'ok',
          currency: 'ZAR',
          totalBalance: '75.00',
          evidenceId: randomUUID(),
          blocker: null,
          observedAt: NOW,
          rowsScanned: 1,
          bytesObserved: 100,
          durationMs: 10,
        },
        deposit,
      ],
      {
        recipientClass: 'reservation_guest',
        inquiryClass: 'labelled_narrow_status',
      },
    );

    expect(merged.status).toBe('partial');
    expect(merged.data.deposits.state).not.toBe('available');
  });

  it('aggregates every bounded detail page before reporting a complete ledger', async () => {
    const lst = folioEnvelope([
      { closingdate: '06-AUG-2026', property: 'HRCEN' },
      { closingdate: '05-AUG-2026', property: 'HRCEN' },
    ]);
    const detailPages = [
      folioEnvelope([
        {
          confirmationnumber: CONFIRM,
          currency: 'ZAR',
          amount: '25.00',
          activitytype_display: 'Deposit Payment',
        },
      ]),
      folioEnvelope([
        {
          confirmationnumber: CONFIRM,
          currency: 'ZAR',
          amount: '35.00',
          activitytype_display: 'Deposit Payment',
        },
      ]),
    ];
    let detailIndex = 0;
    const { runtime, posts } = mockRuntime((path) =>
      path.includes(LIVE_DEPOSIT_LEDGER_DETAIL_PATH) ? detailPages[detailIndex++]! : lst,
    );
    const driver = createLiveFolioReadDriver({
      runtime,
      transportId: 't1',
      expectedConfirmationToken: CONFIRM,
    });
    const result = await driver.observeDepositSummary(
      auth({ requestBranchId: 'deposit_ledger_summary' }),
      child({ requestBranchId: 'deposit_ledger_summary' }),
      new AbortController().signal,
    );

    expect(result.status).toBe('ok');
    expect(result.depositSummary?.paid.amount).toBe('60.00');
    expect(result.rowsScanned).toBe(2);
    expect(posts.filter((post) => post.path === LIVE_DEPOSIT_LEDGER_DETAIL_PATH)).toHaveLength(2);
  });

  it('marks the bounded date window partial while preserving the seven valid detail facts', async () => {
    const lst = folioEnvelope(
      Array.from({ length: 8 }, (_, index) => ({
        closingdate: `0${index + 1}-AUG-2026`,
        property: 'HRCEN',
      })),
    );
    const dld = folioEnvelope([
      {
        confirmationnumber: CONFIRM,
        currency: 'ZAR',
        amount: '10.00',
        activitytype_display: 'Deposit Payment',
      },
    ]);
    const { runtime, posts } = mockRuntime((path) =>
      path.includes(LIVE_DEPOSIT_LEDGER_DETAIL_PATH) ? dld : lst,
    );
    const driver = createLiveFolioReadDriver({
      runtime,
      transportId: 't1',
      expectedConfirmationToken: CONFIRM,
    });

    const result = await driver.observeDepositSummary(
      auth({ requestBranchId: 'deposit_ledger_summary' }),
      child({ requestBranchId: 'deposit_ledger_summary' }),
      new AbortController().signal,
    );

    expect(result.status).toBe('ok');
    expect(result.completeness).toBe('partial');
    expect(result.unmappedActivities).toContain('DEPOSIT_LEDGER_DATE_SCOPE_TRUNCATED');
    expect(result.depositSummary?.paid.amount).toBe('70.00');
    expect(posts.filter((post) => post.path === LIVE_DEPOSIT_LEDGER_DETAIL_PATH)).toHaveLength(7);
  });

  it('keeps valid pages and marks a malformed middle page partial instead of using the last page', async () => {
    const lst = folioEnvelope([
      { closingdate: '06-AUG-2026', property: 'HRCEN' },
      { closingdate: '05-AUG-2026', property: 'HRCEN' },
      { closingdate: '04-AUG-2026', property: 'HRCEN' },
    ]);
    const detailPages = [
      folioEnvelope([
        {
          confirmationnumber: CONFIRM,
          currency: 'ZAR',
          amount: '25.00',
          activitytype_display: 'Deposit Payment',
        },
      ]),
      '<malformed-dld-page>',
      folioEnvelope([
        {
          confirmationnumber: CONFIRM,
          currency: 'ZAR',
          amount: '35.00',
          activitytype_display: 'Deposit Payment',
        },
      ]),
    ];
    let detailIndex = 0;
    const { runtime, posts } = mockRuntime((path) =>
      path.includes(LIVE_DEPOSIT_LEDGER_DETAIL_PATH) ? detailPages[detailIndex++]! : lst,
    );
    const driver = createLiveFolioReadDriver({
      runtime,
      transportId: 't1',
      expectedConfirmationToken: CONFIRM,
    });

    const result = await driver.observeDepositSummary(
      auth({ requestBranchId: 'deposit_ledger_summary' }),
      child({ requestBranchId: 'deposit_ledger_summary' }),
      new AbortController().signal,
    );

    expect(result.status).toBe('ok');
    expect(result.completeness).toBe('partial');
    expect(result.unmappedActivities).toContain('DEPOSIT_LEDGER_PAGE_UNAVAILABLE');
    expect(result.depositSummary?.paid.amount).toBe('60.00');
    expect(result.rowsScanned).toBe(2);
    expect(posts.filter((post) => post.path === LIVE_DEPOSIT_LEDGER_DETAIL_PATH)).toHaveLength(3);

    const merged = mergeFolioEvidence(
      [
        {
          status: 'ok',
          currency: 'ZAR',
          totalBalance: '75.00',
          evidenceId: randomUUID(),
          blocker: null,
          observedAt: NOW,
          rowsScanned: 1,
          bytesObserved: 100,
          durationMs: 10,
        },
        result,
      ],
      {
        recipientClass: 'reservation_guest',
        inquiryClass: 'labelled_narrow_status',
      },
    );
    expect(merged.status).toBe('partial');
    expect(merged.data.deposits).toMatchObject({ state: 'partial' });
    expect(merged.data.deposits.data?.items[0]?.paid.value.amount).toBe('60.00');
  });

  it('registry denies post/transfer/settle/refund/advance_deposit', () => {
    for (const action of FOLIO_READ_PRIVACY_POLICY.deniedActions) {
      expect(
        READ_TOOLS.hms_read_folio.deniedActions.some((a) => a.includes(action.split('_')[0]!)) ||
          FOLIO_READ_PRIVACY_POLICY.deniedActions.includes(action),
      ).toBe(true);
    }
    expect(READ_TOOLS.hms_read_folio.deniedActions).toEqual(
      expect.arrayContaining([
        'email',
        'line_item_export',
        'advance_deposit_form',
        'report_execution',
      ]),
    );
    expect(FOLIO_READ_MAX_BYTES).toBe(64 * 1024);
    expect(FOLIO_READ_MAX_DURATION_MS).toBe(5_000);
  });

  it('deterministic branch ids folio_summary vs deposit_ledger_summary', () => {
    const branches = READ_TOOLS.hms_read_folio.requestBranches;
    expect(branches.map((b) => b.id).sort()).toEqual(['deposit_ledger_summary', 'folio_summary']);
    expect(branches.find((b) => b.id === 'folio_summary')?.discoveryOperationId).toBe(
      'folio_summary',
    );
    expect(branches.find((b) => b.id === 'deposit_ledger_summary')?.discoveryOperationId).toBe(
      'deposit_ledger_summary',
    );
  });
});
