import { readFolioDataSchema } from '../../../../../apps/server-pilot/src/hms/read-service-contracts.js';
import { folioReadDataSchema } from '../../../../../apps/server-pilot/src/hms/folio-read-contract.js';
import { describe, expect, it } from 'vitest';

const known = (value: unknown) => ({
  state: 'known',
  value,
  data: value,
  evidenceRef: 'ev:transaction',
  observedAt: '2026-09-17T00:00:00Z',
  sourceUpdatedAt: null,
  expiresAt: '2026-09-17T00:05:00Z',
});
const transactionValue = (overrides: Record<string, unknown> = {}) => ({
  amount: '-125.50',
  currency: 'ZAR',
  basis: 'ledger_movement',
  taxTreatment: 'unknown',
  ...overrides,
});
const transactionMoney = (overrides: Record<string, unknown> = {}) =>
  known(transactionValue(overrides));
const row = (overrides: Record<string, unknown> = {}) => ({
  transactionRef: known('posting:one'),
  folioRef: known('folio:guest'),
  postingDate: known('2026-09-01'),
  transactionCode: known('ROOM'),
  amount: transactionMoney(),
  ...overrides,
});
const payload = (
  items: unknown[],
  options: {
    rowsScanned?: number;
    page?: { returnedCount: number; hasMore: boolean | null; nextCursor: string | null };
    transactionSection?: Record<string, unknown>;
  } = {},
) => ({
  reservationBinding: 'exact_parent_redacted',
  guestPrivacy: 'identity_redacted',
  currency: 'ZAR',
  transactions: {
    state: 'available',
    completeness: 'complete',
    issues: [],
    data: {
      items,
      page: options.page ?? { returnedCount: items.length, hasMore: false, nextCursor: null },
    },
    ...options.transactionSection,
  },
  disclosure: {
    recipientClass: 'internal_finance',
    inquiryClass: 'other',
    claimEligibility: 'partial',
  },
  rowsScanned: options.rowsScanned ?? items.length,
  bytesObserved: 100,
  durationMs: 20,
  observedAt: '2026-09-17T00:00:00Z',
});

describe('bounded posting receipt contract', () => {
  it('accepts a signed posting amount, date, code, identity and bounded page in both schemas', () => {
    const value = payload([row()]);
    expect(readFolioDataSchema.safeParse(value).success).toBe(true);
    expect(folioReadDataSchema.safeParse(value).success).toBe(true);
  });
  it('rejects card/free-text fields and more than fifty postings', () => {
    expect(
      readFolioDataSchema.safeParse(payload([{ ...row(), cardNumber: 'private' }])).success,
    ).toBe(false);
    expect(
      readFolioDataSchema.safeParse(payload([{ ...row(), description: 'free text' }])).success,
    ).toBe(false);
    expect(
      readFolioDataSchema.safeParse(payload(Array.from({ length: 51 }, row), { rowsScanned: 50 }))
        .success,
    ).toBe(false);
    expect(
      folioReadDataSchema.safeParse(payload(Array.from({ length: 51 }, row), { rowsScanned: 50 }))
        .success,
    ).toBe(false);
  });
  it('bounds returned pages and keeps continuation metadata consistent', () => {
    for (const page of [
      { returnedCount: 51, hasMore: false, nextCursor: null },
      { returnedCount: 1, hasMore: true, nextCursor: null },
      { returnedCount: 1, hasMore: false, nextCursor: 'posting:next' },
    ]) {
      expect(readFolioDataSchema.safeParse(payload([row()], { page })).success).toBe(false);
      expect(folioReadDataSchema.safeParse(payload([row()], { page })).success).toBe(false);
    }
  });
  it('requires movement money, valid dates, safe codes, and matching currency', () => {
    const cases = [
      {
        amount: transactionMoney({ basis: 'ledger_balance' }),
      },
      {
        amount: transactionMoney({ amount: '1.234' }),
      },
      { postingDate: known('2026-99-99') },
      { transactionCode: known('Room charge with free text') },
      { transactionCode: known('411111111111') },
      { amount: transactionMoney({ currency: 'USD' }) },
      {
        amount: {
          ...transactionMoney(),
          data: transactionValue({ currency: 'USD' }),
        },
      },
    ];
    for (const overrides of cases) {
      const value = payload([row(overrides)]);
      expect(readFolioDataSchema.safeParse(value).success).toBe(false);
      expect(folioReadDataSchema.safeParse(value).success).toBe(false);
    }
  });
  it('normalizes legacy balance/deposit-shaped transactions to partial unsupported format', () => {
    const legacyData = [
      {
        items: [
          {
            folioRef: known('folio:guest'),
            folioType: known('guest'),
            balance: known({
              amount: '1.00',
              currency: 'ZAR',
              basis: 'ledger_balance',
              taxTreatment: 'unknown',
            }),
          },
        ],
      },
      {
        items: [
          {
            due: transactionMoney({ amount: '1.00', basis: 'ledger_movement' }),
            paid: transactionMoney({ amount: '0.00', basis: 'ledger_movement' }),
            refunded: transactionMoney({ amount: '0.00', basis: 'ledger_movement' }),
            forfeited: transactionMoney({ amount: '0.00', basis: 'ledger_movement' }),
            transferred: transactionMoney({ amount: '0.00', basis: 'ledger_movement' }),
            untransferred: transactionMoney({ amount: '0.00', basis: 'ledger_movement' }),
          },
        ],
      },
    ];
    for (const data of legacyData) {
      const legacy = payload([], {
        transactionSection: { data },
        rowsScanned: 1,
      });
      for (const schema of [readFolioDataSchema, folioReadDataSchema]) {
        const parsed = schema.safeParse(legacy);
        expect(parsed.success).toBe(true);
        if (parsed.success) {
          expect(parsed.data.transactions).toMatchObject({
            state: 'partial',
            completeness: 'partial',
            data: { items: [], page: { returnedCount: 0, hasMore: null, nextCursor: null } },
            issues: [{ code: 'UNSUPPORTED_FORMAT' }],
          });
        }
      }
    }
  });
});
