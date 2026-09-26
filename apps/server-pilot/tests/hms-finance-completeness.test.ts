import {
  classifyDepositActivity,
  mergeFolioEvidence,
  parseDepositLedgerTransport,
  parseFolioBalanceTransport,
  type FolioBalanceKernelResult,
} from '../src/hms/live-folio-read-driver.js';
import {
  executeRead,
  readRequestSchema,
  type ReadExecutionContext,
} from '../src/hms/read-service.js';
import { FOLIO_READ_MAX_BYTES, FOLIO_READ_MAX_ROWS } from '../src/hms/folio-read-contract.js';
import { issueCurrentAppAccessProof } from '../src/hms/requester-authorization.js';
import { readResultSchema } from '../src/hms/read-service-contracts.js';
import { describe, expect, it, vi } from 'vitest';

const OBSERVED_AT = '2026-09-07T12:00:00.000Z';
const CONFIRMATION = 'U17-CONF-001';

function envelope(rows: Array<Record<string, unknown>>, suffix = ''): string {
  return `${JSON.stringify({
    pageData: {
      success: true,
      grid: {
        GRIDRESULT: {
          type: 'LIST.DATA_ONLY.STORED',
          GRID: { DATA: rows },
        },
      },
    },
  })}${suffix}`;
}

function trustedDisclosure() {
  return {
    recipientClass: 'reservation_guest' as const,
    inquiryClass: 'labelled_narrow_status' as const,
  };
}

function balanceKernel(): FolioBalanceKernelResult {
  return {
    status: 'ok',
    currency: 'ZAR',
    totalBalance: '75.00',
    evidenceId: 'u17-balance-evidence',
    blocker: null,
    observedAt: OBSERVED_AT,
    rowsScanned: 1,
    bytesObserved: 200,
    durationMs: 20,
  };
}

describe('U17 finance completeness RED contracts', () => {
  it('accepts a reservation-scoped folio request on the normal read contract', () => {
    const request = readRequestSchema.parse({
      toolId: 'hms_read_folio',
      reservationRef: 'server-issued-u17-reservation-ref',
      candidateId: 'u17-finance-candidate',
      sections: ['balance', 'deposits'],
    });

    expect(request).toMatchObject({
      toolId: 'hms_read_folio',
      reservationRef: 'server-issued-u17-reservation-ref',
      candidateId: 'u17-finance-candidate',
      sections: ['balance', 'deposits'],
    });
  });

  it('keeps finance and reservation requester claim classes separate before any handler I/O', async () => {
    const context: ReadExecutionContext = {
      transportId: 'transport-u17',
      mailboxId: 'mailbox-u17',
      threadId: 'thread-u17',
      triggerMessageId: 'trigger-u17',
      propertyCode: 'HRCEN',
      parentRef: 'parent-u17',
      branchId: 'folio_summary',
      releaseId: 'release-u17',
      signal: new AbortController().signal,
      budget: { total: 0, limit: 3 },
      now: () => new Date('2026-09-07T12:00:00.000Z'),
      requester: {
        authorizationId: 'access-u17',
        transportId: 'transport-u17',
        threadId: 'thread-u17',
        triggerMessageId: 'trigger-u17',
        allowedClaimKinds: ['reservation_summary'],
        expiresAt: '2099-09-07T12:00:00.000Z',
      },
    };
    const folioHandler = vi.fn(async () => {
      throw new Error('folio handler must not run for reservation-only claims');
    });
    await expect(
      executeRead(
        { ...context, handlers: { readFolio: folioHandler } },
        {
          toolId: 'hms_read_folio',
          reservationRef: 'reservation-u17',
          candidateId: 'candidate-u17',
          sections: ['balance'],
        },
      ),
    ).rejects.toMatchObject({ code: 'READ_CLAIM_NOT_ALLOWED' });
    expect(folioHandler).not.toHaveBeenCalled();

    const reservationHandler = vi.fn(async () => {
      throw new Error('reservation handler must not run for finance-only claims');
    });
    await expect(
      executeRead(
        {
          ...context,
          branchId: 'guest_stay_search',
          requester: {
            ...context.requester,
            allowedClaimKinds: ['folio_deposit_summary'],
          },
          handlers: { findReservation: reservationHandler },
        },
        { toolId: 'hms_find_reservation', candidateId: 'candidate-u17' },
      ),
    ).rejects.toMatchObject({ code: 'READ_CLAIM_NOT_ALLOWED' });
    expect(reservationHandler).not.toHaveBeenCalled();
  });

  it('does not let a plain mailbox claim authorize finance disclosure', async () => {
    const readFolio = vi.fn(async () => ({
      toolId: 'hms_read_folio' as const,
      schemaVersion: 'hms-folio/1',
      status: 'ok' as const,
      data: {},
      completeness: 'complete' as const,
      unavailableSections: [],
      scopeRef: 'reservation-u17',
      evidence: [],
      page: null,
      issues: [],
    }));

    await expect(
      executeRead(
        {
          transportId: 'transport-u17',
          mailboxId: 'mailbox-u17',
          threadId: 'thread-u17',
          triggerMessageId: 'trigger-u17',
          propertyCode: 'HRCEN',
          parentRef: 'parent-u17',
          branchId: 'folio_summary',
          releaseId: 'release-u17',
          signal: new AbortController().signal,
          budget: { total: 0, limit: 3 },
          now: () => new Date('2026-09-07T12:00:00.000Z'),
          requester: {
            authorizationId: 'access-u17',
            transportId: 'transport-u17',
            threadId: 'thread-u17',
            triggerMessageId: 'trigger-u17',
            // This generic claim list is not a signed TrustedRequesterAuthorization.
            allowedClaimKinds: ['folio_deposit_summary'],
            expiresAt: '2099-09-07T12:00:00.000Z',
          },
          handlers: { readFolio },
          requireCurrentAppAccess: true,
        },
        {
          toolId: 'hms_read_folio',
          reservationRef: 'reservation-u17',
          candidateId: 'candidate-u17',
          sections: ['balance'],
        },
      ),
    ).rejects.toMatchObject({ code: 'READ_CURRENT_APP_ACCESS_REQUIRED' });
    expect(readFolio).not.toHaveBeenCalled();
  });

  it('accepts every released finance tool for a server-issued current app access proof', async () => {
    const now = new Date('2026-09-07T12:00:00.000Z');
    const readFolio = vi.fn(async () => ({
      toolId: 'hms_read_folio' as const,
      schemaVersion: 'hms-folio/1',
      status: 'manual_required' as const,
      data: null,
      completeness: 'unknown' as const,
      unavailableSections: [{ section: 'balance', reasonCode: 'SOURCE_UNAVAILABLE' as const }],
      scopeRef: 'reservation-u17',
      evidence: [],
      page: null,
      issues: [],
    }));

    const result = await executeRead(
      {
        transportId: 'transport-u17',
        mailboxId: 'mailbox-u17',
        threadId: 'thread-u17',
        triggerMessageId: 'trigger-u17',
        propertyCode: 'HRCEN',
        parentRef: 'parent-u17',
        branchId: 'folio_summary',
        releaseId: 'release-u17',
        signal: new AbortController().signal,
        budget: { total: 0, limit: 3 },
        now: () => now,
        requester: {
          authorizationId: 'access-u17',
          transportId: 'transport-u17',
          threadId: 'thread-u17',
          triggerMessageId: 'trigger-u17',
          // Caller claims do not grant the tool; current app access does.
          allowedClaimKinds: [],
          expiresAt: '2099-09-07T12:00:00.000Z',
        },
        handlers: { readFolio },
        requireCurrentAppAccess: true,
        currentAppAccessProof: issueCurrentAppAccessProof({
          userId: 'user-u17',
          mailboxAccessId: 'access-u17',
          transportId: 'transport-u17',
          threadId: 'thread-u17',
          triggerMessageId: 'trigger-u17',
          expiresAt: '2099-09-07T12:05:00.000Z',
          now,
        }),
      },
      {
        toolId: 'hms_read_folio',
        reservationRef: 'reservation-u17',
        candidateId: 'candidate-u17',
        sections: ['balance'],
      },
    );

    expect(result).toMatchObject({ toolId: 'hms_read_folio', status: 'manual_required' });
    expect(readFolio).toHaveBeenCalledTimes(1);
  });

  it('keeps a known balance useful while unavailable finance stays typed unknown', () => {
    const result = mergeFolioEvidence([balanceKernel()], trustedDisclosure());
    const data = result.data as unknown as Record<string, any>;

    expect(result.status).toBe('partial');
    expect(data.totalBalance).toBe('75.00');
    expect(data.balance).toMatchObject({ state: 'partial' });
    expect(data.deposits).toMatchObject({ state: 'unavailable', data: null });
    expect(data.liabilityLocation).toMatchObject({
      state: 'unknown',
      value: null,
    });
  });

  it('does not classify an unrecognized deposit activity as paid', () => {
    expect(classifyDepositActivity('Manual Reconciliation Adjustment')).toBe('unknown');
  });

  it('marks an unrecognized activity unmapped instead of adding it to paid', () => {
    const parsed = parseDepositLedgerTransport(
      envelope([
        {
          confirmationnumber: CONFIRMATION,
          currency: 'ZAR',
          amount: '25.00',
          activitytype_display: 'Manual Reconciliation Adjustment',
        },
      ]),
      CONFIRMATION,
    );

    expect(parsed.depositSummary?.paid.amount).toBe('0.00');
    expect((parsed as unknown as { completeness?: string }).completeness).toBe('partial');
  });

  it('does not fold mixed currencies or signed postings into a complete total', () => {
    const mixed = parseDepositLedgerTransport(
      envelope([
        {
          confirmationnumber: CONFIRMATION,
          currency: 'ZAR',
          amount: '10.00',
          activitytype_display: 'Deposit Payment',
        },
        {
          confirmationnumber: CONFIRMATION,
          currency: 'USD',
          amount: '20.00',
          activitytype_display: 'Deposit Payment',
        },
      ]),
      CONFIRMATION,
    );
    expect(mixed.completeness).not.toBe('complete');
    expect(mixed.depositSummary).toBeNull();
  });

  it('does not discard a signed posting and claim a complete total', () => {
    const signed = parseDepositLedgerTransport(
      envelope([
        {
          confirmationnumber: CONFIRMATION,
          currency: 'ZAR',
          amount: '-10.00',
          activitytype_display: 'Amount Refunded',
        },
      ]),
      CONFIRMATION,
    );
    expect(signed.completeness).not.toBe('complete');
    expect(signed.unmappedActivities.length).toBeGreaterThan(0);
  });

  it('counts a transferred posting once when the same posting is repeated', () => {
    const row = {
      confirmationnumber: CONFIRMATION,
      currency: 'ZAR',
      amount: '10.00',
      activitytype_display: 'Transfer to Guest Ledger',
      postingref: 'U17-TRANSFER-001',
    };
    const parsed = parseDepositLedgerTransport(envelope([row, { ...row }]), CONFIRMATION);

    expect(parsed.depositSummary?.transferred.amount).toBe('10.00');
  });

  it('retains pre-clamp row observations for oversized folio input', () => {
    const rows = Array.from({ length: FOLIO_READ_MAX_ROWS + 1 }, (_, index) => ({
      confirmationnumber: CONFIRMATION,
      foliobalance: index === 0 ? '75.00' : '0.01',
      propertycurrency: 'ZAR',
    }));
    const parsed = parseFolioBalanceTransport(envelope(rows), CONFIRMATION);

    expect(parsed.rowsScanned).toBeGreaterThan(FOLIO_READ_MAX_ROWS);
  });

  it('retains pre-clamp byte observations for oversized folio input', () => {
    const parsed = parseFolioBalanceTransport(
      envelope([
        {
          confirmationnumber: CONFIRMATION,
          foliobalance: '75.00',
          propertycurrency: 'ZAR',
          boundedPadding: 'x'.repeat(FOLIO_READ_MAX_BYTES),
        },
      ]),
      CONFIRMATION,
    );

    expect(parsed.bytesObserved).toBeGreaterThan(FOLIO_READ_MAX_BYTES);
  });

  it('closes the typed finance result instead of accepting generic data', () => {
    const receipt = (data: unknown) => ({
      toolId: 'hms_read_folio' as const,
      schemaVersion: 'hms-folio/1',
      status: 'ok' as const,
      data,
      completeness: 'complete' as const,
      unavailableSections: [],
      scopeRef: 'reservation-u17',
      evidence: [],
      page: null,
      issues: [],
    });

    for (const data of [
      { foo: 'bar' },
      {},
      { foo: 'bar', extraFinanceField: 'unexpected' },
      { currency: 'ZAR', totalBalance: 'not-a-money-fact' },
    ]) {
      expect(() => readResultSchema.parse(receipt(data))).toThrow();
    }
  });

  it('keeps generated evidence within the five-minute source-age window', () => {
    const merged = mergeFolioEvidence([balanceKernel()], trustedDisclosure());
    const observedAt = Date.parse(merged.evidence.observedAt);
    const expiresAt = Date.parse(merged.evidence.expiresAt);
    expect(expiresAt - observedAt).toBeLessThanOrEqual(5 * 60_000);
  });
});
