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
  type FolioEvidenceBinding,
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
import type { HmsBrowserArtifactReceiptV1 } from '../src/hms/browser-artifacts.js';
import type { HmsSessionAuthorization } from '../src/hms/release-kernel.js';
import { claimsFromToolResult } from '../src/ai/candidate-draft-agent.js';
import type { ReadCandidateChild } from '../src/hms/candidate-graph.js';
import { evaluateObservedRequest } from '../src/hms/request-policy.js';
import { renderClaim } from '../src/ai/draft-evidence.js';
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

function mockRuntime(
  htmlOrBody: string | ((path: string) => string),
  receiptPatch: Partial<HmsBrowserArtifactReceiptV1> = {},
) {
  const posts: Array<{ path: string; fields: Record<string, string> }> = [];
  let latestAuditSpec:
    | {
        operationId: string;
        toolId: 'hms_read_folio';
        toolVersion: string;
        executionClass: 'normal';
        inputClass: 'authorized_exact';
        requestBranchId?: string;
      }
    | undefined;
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
    lastReceipt: (): HmsBrowserArtifactReceiptV1 | null =>
      latestAuditSpec
        ? ({
            schemaVersion: 1,
            artifactId: 'local-folio-artifact',
            operationId: latestAuditSpec.operationId,
            sourceRevision: 'local-test',
            toolId: latestAuditSpec.toolId,
            toolVersion: latestAuditSpec.toolVersion,
            executionClass: latestAuditSpec.executionClass,
            inputClass: latestAuditSpec.inputClass,
            requestBranchId: latestAuditSpec.requestBranchId ?? 'folio_summary',
            operationOutcome: 'succeeded',
            artifactState: 'complete',
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            ...receiptPatch,
          } as HmsBrowserArtifactReceiptV1)
        : null,
  };
  const runtime = {
    openReadSession: vi.fn(async (input: { auditSpec?: typeof latestAuditSpec }) => {
      latestAuditSpec = input.auditSpec;
      return session;
    }),
  } as unknown as HmsRuntime;
  return { runtime, posts, session };
}

describe('folio / deposit transport parsers', () => {
  it('parses foliobalance + currency and rejects fixture HTML', () => {
    const parsed = parseFolioBalanceTransport(
      folioEnvelope([
        {
          confirmationnumber: CONFIRM,
          foliobalance: '75.50',
          propertycurrency: 'ZAR',
          cardnumber: '****',
        },
      ]),
      CONFIRM,
    );
    expect(parsed.envelopeRecognized).toBe(true);
    expect(parsed.totalBalance).toBe('75.50');
    expect(parsed.currency).toBe('ZAR');
    expect(parsed.reservationScopeProven).toBe(true);
    expect(() =>
      parseFolioBalanceTransport('<div data-testid="folio-row"></div>', CONFIRM),
    ).toThrow(HmsRuntimeError);
  });

  it('suppresses card-like money and flags card leak', () => {
    const parsed = parseFolioBalanceTransport(
      folioEnvelope([
        {
          confirmationnumber: CONFIRM,
          foliobalance: '4111111111111111',
          propertycurrency: 'ZAR',
          cardnumber: '4111111111111111',
        },
      ]),
      CONFIRM,
    );
    expect(parsed.totalBalance).toBeNull();
    expect(parsed.hasCardLeak).toBe(true);
  });

  it('does not attribute a balance row from another reservation', () => {
    const parsed = parseFolioBalanceTransport(
      folioEnvelope([
        {
          confirmationnumber: 'OTHER-RES',
          foliobalance: '999.00',
          propertycurrency: 'ZAR',
        },
      ]),
      CONFIRM,
    );
    expect(parsed.envelopeRecognized).toBe(true);
    expect(parsed.reservationScopeProven).toBe(false);
    expect(parsed.totalBalance).toBeNull();
    expect(parsed.currency).toBeNull();
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

  it('bounds merged finance evidence by the earliest finalized branch capture', () => {
    const observedAt = new Date().toISOString();
    const balanceExpiry = new Date(Date.now() + 30_000).toISOString();
    const depositExpiry = new Date(Date.now() + 90_000).toISOString();
    const binding: FolioEvidenceBinding = {
      runId: 'expiry-run',
      readResultRef: 'expiry-read-result',
      transportId: 'expiry-transport',
      threadId: 'expiry-thread',
      triggerMessageId: 'expiry-message',
      candidateId: 'expiry-candidate',
      reservationRef: 'expiry-reservation',
      inputDigest: 'a'.repeat(64),
      requesterAuthorizationId: 'expiry-authorization',
      releaseId: 'expiry-release',
      requestBranchIds: ['folio_summary', 'deposit_ledger_summary'],
      manifestSha256ByBranch: {
        folio_summary: 'b'.repeat(64),
        deposit_ledger_summary: 'c'.repeat(64),
      },
      scopeHash: SCOPE,
      captureBindingRef: 'expiry-read-result',
      propertyCode: 'HRCEN',
      confirmationToken: CONFIRM,
    };
    const receipt = (branch: 'folio_summary' | 'deposit_ledger_summary', expiresAt: string) => ({
      artifactId: `${branch}-expiry-artifact`,
      operationId: binding.runId,
      toolId: 'hms_read_folio' as const,
      toolVersion: '1.0.0',
      executionClass: 'normal' as const,
      inputClass: 'authorized_exact' as const,
      requestBranchId: branch,
      operationOutcome: 'succeeded' as const,
      expiresAt,
    });
    const balance: FolioBalanceKernelResult = {
      status: 'ok',
      currency: 'ZAR',
      totalBalance: '12.00',
      evidenceId: 'expiry-balance-evidence',
      blocker: null,
      scopeVerified: true,
      manifestSha256: binding.manifestSha256ByBranch.folio_summary,
      scopeHash: SCOPE,
      artifactRef: 'folio_summary-expiry-artifact',
      finalizedReceipt: receipt('folio_summary', balanceExpiry),
      observedAt,
      rowsScanned: 1,
      bytesObserved: 100,
      durationMs: 10,
    };
    const deposit: DepositSummaryKernelResult = {
      status: 'ok',
      currency: 'ZAR',
      depositSummary: buildDepositSummary({
        due: '0.00',
        paid: '10.00',
        refunded: '0.00',
        forfeited: '0.00',
        transferred: '0.00',
      }),
      evidenceId: 'expiry-deposit-evidence',
      blocker: null,
      scopeVerified: true,
      manifestSha256: binding.manifestSha256ByBranch.deposit_ledger_summary,
      scopeHash: SCOPE,
      artifactRef: 'deposit_ledger_summary-expiry-artifact',
      finalizedReceipt: receipt('deposit_ledger_summary', depositExpiry),
      observedAt,
      rowsScanned: 1,
      bytesObserved: 100,
      durationMs: 10,
      completeness: 'complete',
      unmappedActivities: [],
    };
    const merged = mergeFolioEvidence(
      [balance, deposit],
      disclosure,
      ['balance', 'deposits'],
      binding,
    );
    expect(merged.status).toBe('ok');
    expect(merged.evidence.kind).toBe('hms');
    if (merged.evidence.kind === 'hms') {
      expect(merged.evidence.expiresAt).toBe(balanceExpiry);
      expect(Date.parse(merged.evidence.expiresAt)).toBeLessThan(Date.parse(depositExpiry));
      expect(merged.evidence.scopeVerified).toBe(true);
      const claims = claimsFromToolResult(merged, new Date());
      expect(claims).toHaveLength(1);
      expect(claims[0]?.kind).toBe('folio_deposit_summary');
      expect(renderClaim(claims[0]!)).toContain('Full credit: labelled narrow status');
    }
  });
});

describe('live folio driver binding + denied actions', () => {
  it('binds parent authorization + child and posts OSRESS.search only for folio branch', async () => {
    const body = folioEnvelope([
      { confirmationnumber: CONFIRM, foliobalance: '12.00', propertycurrency: 'ZAR' },
    ]);
    const { runtime, posts } = mockRuntime(body);
    const driver = createLiveFolioReadDriver({
      runtime,
      transportId: 't1',
      expectedConfirmationToken: CONFIRM,
      expectedPropertyCode: 'HRCEN',
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

  it('fails closed when the audited runtime exposes no finalized receipt', async () => {
    const { runtime, session } = mockRuntime(
      folioEnvelope([
        { confirmationnumber: CONFIRM, foliobalance: '12.00', propertycurrency: 'ZAR' },
      ]),
    );
    (session as typeof session & { lastReceipt: () => null }).lastReceipt = () => null;
    const driver = createLiveFolioReadDriver({
      runtime,
      transportId: 't1',
      expectedConfirmationToken: CONFIRM,
      auditSpecFor: ({ branchId }) => ({
        operationId: 'folio-receipt-operation',
        toolId: 'hms_read_folio',
        toolVersion: '1.0.0',
        dependencyRevision: 'playwright-1.52.0-chromium-1169',
        executionClass: 'normal',
        inputClass: 'authorized_exact',
        requestBranchId: branchId,
      }),
    });
    const result = await driver.observeFolioBalance(auth(), child(), new AbortController().signal);
    expect(result.status).toBe('manual_required');
    expect(result.blocker).toBe('FOLIO_FINALIZED_RECEIPT_INVALID');
  });

  it('rejects stale finalized receipts on both balance and deposit normal branches', async () => {
    const staleReceipt = { expiresAt: '2000-01-01T00:00:00.000Z' };
    const cases = [
      {
        branch: 'folio_summary' as const,
        body: folioEnvelope([
          { confirmationnumber: CONFIRM, foliobalance: '12.00', propertycurrency: 'ZAR' },
        ]),
      },
      {
        branch: 'deposit_ledger_summary' as const,
        body: folioEnvelope([
          {
            confirmationnumber: CONFIRM,
            closingdate: '06-AUG-2026',
            property: 'HRCEN',
            currency: 'ZAR',
            newdeposits: '10.00',
            refunds: '0.00',
            forfeits: '0.00',
            toguestledger: '0.00',
          },
        ]),
      },
    ];
    for (const testCase of cases) {
      const { runtime } = mockRuntime(testCase.body, staleReceipt);
      const driver = createLiveFolioReadDriver({
        runtime,
        transportId: 't1',
        expectedConfirmationToken: CONFIRM,
        auditSpecFor: ({ branchId }) => ({
          operationId: 'folio-stale-receipt-operation',
          toolId: 'hms_read_folio',
          toolVersion: '1.0.0',
          dependencyRevision: 'playwright-1.52.0-chromium-1169',
          executionClass: 'normal',
          inputClass: 'authorized_exact',
          requestBranchId: branchId,
        }),
      });
      const result =
        testCase.branch === 'folio_summary'
          ? await driver.observeFolioBalance(
              auth({ requestBranchId: testCase.branch }),
              child({ requestBranchId: testCase.branch }),
              new AbortController().signal,
            )
          : await driver.observeDepositSummary(
              auth({ requestBranchId: testCase.branch }),
              child({ requestBranchId: testCase.branch }),
              new AbortController().signal,
            );
      expect(result.status).toBe('manual_required');
      expect(result.blocker).toBe('FOLIO_FINALIZED_RECEIPT_INVALID');
    }
  });

  it('rejects missing and malformed finalized receipt expiry independently on both finance branches', async () => {
    const cases = [
      {
        branch: 'folio_summary' as const,
        body: folioEnvelope([
          { confirmationnumber: CONFIRM, foliobalance: '12.00', propertycurrency: 'ZAR' },
        ]),
      },
      {
        branch: 'deposit_ledger_summary' as const,
        body: folioEnvelope([
          {
            confirmationnumber: CONFIRM,
            closingdate: '06-AUG-2026',
            property: 'HRCEN',
            currency: 'ZAR',
            newdeposits: '10.00',
            refunds: '0.00',
            forfeits: '0.00',
            toguestledger: '0.00',
          },
        ]),
      },
    ];
    for (const testCase of cases) {
      for (const [label, expiresAt] of [
        ['missing', undefined],
        ['malformed', 'not-a-timestamp'],
      ] as const) {
        const { runtime } = mockRuntime(testCase.body, { expiresAt });
        const driver = createLiveFolioReadDriver({
          runtime,
          transportId: 't1',
          expectedConfirmationToken: CONFIRM,
          expectedPropertyCode: 'HRCEN',
          auditSpecFor: ({ branchId }) => ({
            operationId: `finance-expiry-shape-${testCase.branch}-${label}`,
            toolId: 'hms_read_folio',
            toolVersion: '1.0.0',
            dependencyRevision: 'playwright-1.52.0-chromium-1169',
            executionClass: 'normal',
            inputClass: 'authorized_exact',
            requestBranchId: branchId,
          }),
        });
        const result =
          testCase.branch === 'folio_summary'
            ? await driver.observeFolioBalance(
                auth({ requestBranchId: testCase.branch }),
                child({ requestBranchId: testCase.branch }),
                new AbortController().signal,
              )
            : await driver.observeDepositSummary(
                auth({ requestBranchId: testCase.branch }),
                child({ requestBranchId: testCase.branch }),
                new AbortController().signal,
              );
        expect(result.status, `${testCase.branch}/${label}`).toBe('manual_required');
        expect(result.blocker, `${testCase.branch}/${label}`).toBe(
          'FOLIO_FINALIZED_RECEIPT_INVALID',
        );
      }
    }
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

  it('rejects missing, malformed, and mixed LST property scope before DLD or aggregation', async () => {
    const cases = [
      [
        {
          closingdate: '06-AUG-2026',
          confirmationnumber: CONFIRM,
          currency: 'ZAR',
          newdeposits: '10.00',
        },
      ],
      [
        {
          closingdate: '06-AUG-2026',
          property: '???',
          confirmationnumber: CONFIRM,
          currency: 'ZAR',
          newdeposits: '10.00',
        },
      ],
      [
        { closingdate: '06-AUG-2026', property: 'HRCEN' },
        {
          closingdate: '05-AUG-2026',
          property: '',
          confirmationnumber: CONFIRM,
          currency: 'ZAR',
          newdeposits: '10.00',
        },
      ],
    ];
    for (const [index, rows] of cases.entries()) {
      const { runtime, posts } = mockRuntime(folioEnvelope(rows));
      const driver = createLiveFolioReadDriver({
        runtime,
        transportId: 't1',
        expectedConfirmationToken: CONFIRM,
        expectedPropertyCode: 'HRCEN',
      });
      const result = await driver.observeDepositSummary(
        auth({ requestBranchId: 'deposit_ledger_summary' }),
        child({ requestBranchId: 'deposit_ledger_summary' }),
        new AbortController().signal,
      );
      expect(result.status, `property case ${index}`).toBe('manual_required');
      expect(result.blocker, `property case ${index}`).toBe(
        'DEPOSIT_LEDGER_PROPERTY_SCOPE_UNRESOLVED',
      );
      expect(result.depositSummary, `property case ${index}`).toBeNull();
      expect(
        posts.some((post) => post.path === LIVE_DEPOSIT_LEDGER_DETAIL_PATH),
        `property case ${index}`,
      ).toBe(false);
    }
  });

  it('rejects an LST property mismatch before any DLD request', async () => {
    const lst = folioEnvelope([{ closingdate: '06-AUG-2026', property: 'OTHER' }]);
    const dld = folioEnvelope([
      {
        confirmationnumber: CONFIRM,
        currency: 'ZAR',
        amount: '25.00',
        activitytype_display: 'Deposit Payment',
      },
    ]);
    const { runtime, posts } = mockRuntime((path) => (path.includes('OSLEDG.DLD') ? dld : lst));
    const driver = createLiveFolioReadDriver({
      runtime,
      transportId: 't1',
      expectedConfirmationToken: CONFIRM,
      expectedPropertyCode: 'HRCEN',
    });
    const result = await driver.observeDepositSummary(
      auth({ requestBranchId: 'deposit_ledger_summary' }),
      child({ requestBranchId: 'deposit_ledger_summary' }),
      new AbortController().signal,
    );
    expect(result.status).toBe('manual_required');
    expect(result.blocker).toBe('DEPOSIT_LEDGER_PROPERTY_SCOPE_MISMATCH');
    expect(posts.some((post) => post.path === LIVE_DEPOSIT_LEDGER_DETAIL_PATH)).toBe(false);
  });

  it('makes the reviewed deposit firewall reject a different property', () => {
    const decision = evaluateObservedRequest(buildLiveDepositLedgerManifest(ORIGIN), {
      url: `${ORIGIN}${LIVE_DEPOSIT_LEDGER_DETAIL_PATH}`,
      method: 'POST',
      resourceType: 'xhr',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      postData:
        'SYSTEM_FUNCTION_NAME=OSLEDG&USER_FUNCTION_NAME=OSLEDG&CURRENT_TAB_NAME=DLD&closingdate=06-AUG-2026&property=OTHER',
    });
    expect(decision.action).toBe('block');
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

  it('requires receipt-bound artifacts and binds canonical observed evidence to the run', () => {
    const binding: FolioEvidenceBinding = {
      runId: 'run-1',
      readResultRef: 'read-result-1',
      transportId: 'transport-1',
      threadId: 'thread-1',
      triggerMessageId: 'message-1',
      candidateId: 'candidate-1',
      reservationRef: 'reservation-1',
      inputDigest: 'a'.repeat(64),
      requesterAuthorizationId: 'authorization-1',
      releaseId: 'release-1',
      requestBranchIds: ['folio_summary', 'deposit_ledger_summary'],
      manifestSha256ByBranch: {
        folio_summary: 'c'.repeat(64),
        deposit_ledger_summary: 'd'.repeat(64),
      },
      scopeHash: SCOPE,
      captureBindingRef: 'read-result-1',
      propertyCode: 'HRCEN',
      confirmationToken: CONFIRM,
    };
    const balance: FolioBalanceKernelResult = {
      status: 'ok',
      currency: 'ZAR',
      totalBalance: '12.00',
      evidenceId: 'balance-evidence',
      blocker: null,
      scopeVerified: true,
      manifestSha256: 'c'.repeat(64),
      scopeHash: SCOPE,
      artifactRef: 'balance-artifact',
      finalizedReceipt: {
        artifactId: 'balance-artifact',
        operationId: 'run-1',
        toolId: 'hms_read_folio',
        toolVersion: '1.0.0',
        executionClass: 'normal',
        inputClass: 'authorized_exact',
        requestBranchId: 'folio_summary',
        operationOutcome: 'succeeded',
        expiresAt: '2099-01-01T00:00:00.000Z',
      },
      observedAt: NOW,
      rowsScanned: 1,
      bytesObserved: 100,
      durationMs: 10,
    };
    const disclosure = {
      recipientClass: 'reservation_guest' as const,
      inquiryClass: 'labelled_narrow_status' as const,
    };
    const missingReceipt = mergeFolioEvidence(
      [{ ...balance, finalizedReceipt: undefined, artifactRef: undefined }],
      disclosure,
      ['balance'],
      binding,
    );
    expect(missingReceipt.status).toBe('manual_required');
    expect(missingReceipt.unresolvedFields).toContain('FOLIO_FINALIZED_RECEIPT_REQUIRED');

    for (const invalidReceipt of [
      { ...balance.finalizedReceipt!, operationId: 'other-run' },
      { ...balance.finalizedReceipt!, operationOutcome: 'failed' as const },
    ]) {
      const invalid = mergeFolioEvidence(
        [{ ...balance, finalizedReceipt: invalidReceipt }],
        disclosure,
        ['balance'],
        binding,
      );
      expect(invalid.status).toBe('manual_required');
      expect(invalid.unresolvedFields).toContain('FOLIO_FINALIZED_RECEIPT_REQUIRED');
    }

    const merged = mergeFolioEvidence([balance], disclosure, ['balance'], binding);
    expect(merged.status).toBe('ok');
    expect(merged.evidence.kind).toBe('hms');
    if (merged.evidence.kind === 'hms') {
      expect(merged.evidence.artifactRef).toBe('balance-artifact');
      expect(merged.evidence.artifactRefs).toEqual(['balance-artifact']);
      expect(merged.evidence.scopeVerified).toBe(true);
    }
  });

  it('rejects finance evidence whose reviewed branch manifest or scope digest is missing/tampered', () => {
    const binding: FolioEvidenceBinding = {
      runId: 'run-binding-negative',
      readResultRef: 'read-result-binding-negative',
      transportId: 'transport-binding-negative',
      threadId: 'thread-binding-negative',
      triggerMessageId: 'message-binding-negative',
      candidateId: 'candidate-binding-negative',
      reservationRef: 'reservation-binding-negative',
      inputDigest: 'a'.repeat(64),
      requesterAuthorizationId: 'authorization-binding-negative',
      releaseId: 'release-binding-negative',
      requestBranchIds: ['folio_summary'],
      manifestSha256ByBranch: { folio_summary: 'c'.repeat(64) },
      scopeHash: SCOPE,
      captureBindingRef: 'read-result-binding-negative',
      propertyCode: 'HRCEN',
      confirmationToken: CONFIRM,
    };
    const balance: FolioBalanceKernelResult = {
      status: 'ok',
      currency: 'ZAR',
      totalBalance: '12.00',
      evidenceId: 'balance-binding-negative',
      blocker: null,
      scopeVerified: true,
      manifestSha256: '0'.repeat(64),
      scopeHash: '1'.repeat(64),
      artifactRef: 'balance-binding-negative-artifact',
      finalizedReceipt: {
        artifactId: 'balance-binding-negative-artifact',
        operationId: binding.runId,
        toolId: 'hms_read_folio',
        toolVersion: '1.0.0',
        executionClass: 'normal',
        inputClass: 'authorized_exact',
        requestBranchId: 'folio_summary',
        operationOutcome: 'succeeded',
        expiresAt: '2099-01-01T00:00:00.000Z',
      },
      observedAt: NOW,
      rowsScanned: 1,
      bytesObserved: 100,
      durationMs: 10,
    };
    const result = mergeFolioEvidence(
      [balance],
      { recipientClass: 'reservation_guest', inquiryClass: 'labelled_narrow_status' },
      ['balance'],
      binding,
    );
    expect(result.status).toBe('manual_required');
    expect(result.unresolvedFields).toContain('FOLIO_FINALIZED_RECEIPT_REQUIRED');
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
