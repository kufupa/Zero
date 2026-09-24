import {
  extractHmsPageDataRecord,
  parseBoundFolioAllDataTransport,
  parseBoundFolioFolTransport,
  parseFolioFolTransport,
  type FolioFolParentProof,
} from '../src/hms/folio-fol-parse.js';
import { readFolioTransactionsSectionSchema } from '../src/hms/read-service-contracts.js';
import { describe, expect, it } from 'vitest';

const parentProof: FolioFolParentProof = {
  confirmationNumber: 'CONF-1',
  reservationStayId: 'STAY-1',
  propertyCode: 'HRCEN',
  account: 'ACCT-1',
  currency: 'ZAR',
};

const parseContext = {
  evidenceRef: 'ev:folio-fol',
  observedAt: '2026-09-17T00:00:00Z',
  expiresAt: '2026-09-17T00:05:00Z',
};

function postingRow(overrides: Record<string, unknown> = {}) {
  return {
    id: '1',
    line: '1',
    reference: 'CONF-1',
    accountid: 'STAY-1',
    account: 'ACCT-1',
    propertycode: 'HRCEN',
    currency: 'ZAR',
    fdate: '24-AUG-2026',
    transactioncode: '5401',
    amount: '150.00',
    foreigncurrency: 'ZAR',
    transdesc: 'Private description must not cross the receipt boundary',
    fcomment: 'Private comment must not cross the receipt boundary',
    ...overrides,
  };
}

function boundFolBody(
  options: {
    rows?: Record<string, unknown>[];
    values?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
    outsidePageData?: Record<string, unknown>;
  } = {},
) {
  return JSON.stringify({
    labels: {
      amount: '999.99',
      transactioncode: 'metadata-must-not-be-read',
      ...(options.outsidePageData ?? {}),
    },
    pageData: {
      values: {
        confirmationnumber: parentProof.confirmationNumber,
        accountid: parentProof.reservationStayId,
        account: parentProof.account,
        propertycode: parentProof.propertyCode,
        hotelcurrency: parentProof.currency,
        foliototalcurr: parentProof.currency,
        ...(options.values ?? {}),
      },
      grid: {
        GRIDRESULT: {
          GRID: {
            METADATA: {
              RECORDS: String(options.rows?.length ?? 2),
              CURRENTCURSORPOSITION: String(options.rows?.length ?? 2),
              CLIENTROWS: '50',
              MORERECORDPRESENT: '-',
              ...(options.metadata ?? {}),
            },
            DATA: options.rows ?? [
              postingRow(),
              postingRow({ id: '2', line: '2', fdate: '25-AUG-2026', amount: '-4,000.00' }),
            ],
          },
        },
      },
    },
  });
}

function allDataBody(
  options: {
    rows?: Record<string, unknown>[];
    metadata?: Record<string, unknown>;
    dataspy?: Record<string, unknown>;
    grid?: Record<string, unknown>;
    pageData?: Record<string, unknown>;
  } = {},
) {
  const rows = options.rows ?? [postingRow(), postingRow({ id: '2', line: '2' })];
  return JSON.stringify({
    pageData: {
      ...(options.pageData ?? {}),
      grid: {
        GRIDRESULT: {
          DATASPY: { id: '836', label: 'All Folios', ...(options.dataspy ?? {}) },
          GRID: {
            DATA: rows,
            METADATA: {
              DATASPYID: '836',
              GRIDID: '780',
              GRIDNAME: 'OSFOLO',
              RECORDS: '96',
              CLIENTROWS: '50',
              CURRENTCURSORPOSITION: String(rows.length),
              MORERECORDPRESENT: rows.length < 96 ? '+' : '-',
              ...(options.metadata ?? {}),
            },
            ...(options.grid ?? {}),
          },
        },
      },
    },
  });
}

describe('parseFolioFolTransport', () => {
  it('extracts a bounded non-strict pageData record without scanning arbitrary text', () => {
    const text =
      '{"classPath":"osledg_dld","pageData":{values:{amount:"125.00",currency:"ZAR"},grid:{GRIDRESULT:{GRID:{DATA:[]}}}}}';

    const pageData = extractHmsPageDataRecord(text);

    expect(pageData).not.toBeNull();
    expect(Object.keys(pageData ?? {}).sort()).toEqual(['grid', 'values']);
    expect(pageData?.values).toEqual({ amount: '125.00', currency: 'ZAR' });
  });

  it('extracts balance + currency from pageData GRID row', () => {
    const text = JSON.stringify({
      pageData: {
        success: true,
        grid: {
          GRIDRESULT: {
            GRID: {
              DATA: [{ balance: '12.00', balancecurr: 'ZAR' }],
            },
          },
        },
      },
    });
    const parsed = parseFolioFolTransport(text);
    expect(parsed.envelopeRecognized).toBe(true);
    expect(parsed.totalBalance).toBe('12.00');
    expect(parsed.currency).toBe('ZAR');
  });

  it('returns unavailable money for key-only folio flags', () => {
    const text = JSON.stringify({
      pageData: {
        success: true,
        folio: true,
        fields: { guestname: 'X' },
      },
    });
    const parsed = parseFolioFolTransport(text);
    expect(parsed.envelopeRecognized).toBe(true);
    expect(parsed.totalBalance).toBeNull();
    expect(parsed.currency).toBeNull();
  });

  it('rejects 813 stub as unrecognized envelope', () => {
    const stub = 'x'.repeat(813);
    const parsed = parseFolioFolTransport(stub);
    expect(parsed.envelopeRecognized).toBe(false);
    expect(parsed.totalBalance).toBeNull();
  });

  it('flags card leak and still parses money when present', () => {
    const text = JSON.stringify({
      pageData: {
        foliobalance: '99.00',
        propertycurrency: 'USD',
        cardnumber: '4111111111111111',
      },
    });
    const parsed = parseFolioFolTransport(text);
    expect(parsed.hasCardLeak).toBe(true);
    expect(parsed.totalBalance).toBe('99.00');
    expect(parsed.currency).toBe('USD');
  });
});

describe('parseBoundFolioFolTransport', () => {
  it('does not mark an all-unknown balance source complete', () => {
    const parsed = parseBoundFolioFolTransport(
      boundFolBody({ values: { foliototal: null } }),
      parentProof,
      parseContext,
    );
    expect(parsed.totalBalance).toBeNull();
    expect(parsed.balanceSection).toBeNull();
    expect(parsed.section?.state).toBe('available');
  });

  it('does not promote an aggregate amount without a source currency', () => {
    const parsed = parseBoundFolioFolTransport(
      boundFolBody({
        values: {
          foliototal: '12.00',
          foliototalcurr: undefined,
          hotelcurrency: undefined,
          propertycurrency: undefined,
          balancecurr: undefined,
          currency: undefined,
          guesttotal: '4.00',
          guesttotalcurr: 'ZAR',
        },
      }),
      parentProof,
      parseContext,
    );
    expect(parsed.blocker).toBeNull();
    expect(parsed.totalBalance).toBeNull();
    expect(parsed.currency).toBe('ZAR');
    expect(
      parsed.balanceSection?.data.items.find((item) => item.folioType.value === 'guest'),
    ).toMatchObject({
      balance: { state: 'known', value: { amount: '4.00', currency: 'ZAR' } },
    });
  });

  it('uses an explicit page currency for an aggregate when the paired total currency is absent', () => {
    const parsed = parseBoundFolioFolTransport(
      boundFolBody({
        values: {
          foliototal: '12.00',
          foliototalcurr: undefined,
          hotelcurrency: 'ZAR',
        },
      }),
      parentProof,
      parseContext,
    );
    expect(parsed.blocker).toBeNull();
    expect(parsed.totalBalance).toBe('12.00');
    expect(parsed.currency).toBe('ZAR');
  });

  it('projects only bounded posting fields from the exact parent-bound grid', () => {
    const body = boundFolBody();
    const parsed = parseBoundFolioFolTransport(body, parentProof, parseContext);

    expect(parsed.envelopeRecognized).toBe(true);
    expect(parsed.scopeVerified).toBe(true);
    expect(parsed.rowsScanned).toBe(2);
    expect(parsed.bytesObserved).toBe(Buffer.byteLength(body));
    expect(parsed.blocker).toBeNull();
    expect(parsed.section?.state).toBe('available');
    expect(parsed.section?.completeness).toBe('complete');
    expect(parsed.section?.data.page).toEqual({
      returnedCount: 2,
      hasMore: false,
      nextCursor: null,
    });
    expect(parsed.section?.data.items[0]).toMatchObject({
      postingDate: { state: 'known', value: '2026-08-24' },
      transactionCode: { state: 'known', value: '5401' },
      amount: {
        state: 'known',
        value: {
          amount: '150.00',
          currency: 'ZAR',
          basis: 'ledger_movement',
          taxTreatment: 'unknown',
        },
      },
    });
    expect(parsed.section?.data.items[0]?.folioRef).toMatchObject({
      state: 'unknown',
      value: null,
    });
    expect(parsed.section?.data.items[1]).toMatchObject({
      postingDate: { state: 'known', value: '2026-08-25' },
      amount: { value: { amount: '-4000.00' } },
    });
    expect(JSON.stringify(parsed)).not.toContain('Private description');
    expect(JSON.stringify(parsed)).not.toContain('Private comment');
    expect(readFolioTransactionsSectionSchema.safeParse(parsed.section).success).toBe(true);
  });

  it('joins posting labels to distinct source-coded folio refs', () => {
    const parsed = parseBoundFolioFolTransport(
      boundFolBody({
        values: {
          guesttotal: '-2.50',
          guesttotalcurr: 'ZAR',
          folio6total: '0.00',
          folio6totalcurr: 'ZAR',
          subfolio: {
            dd: true,
            selected: null,
            option: [
              { display: 'Guest Folio 1', value: 'GUEST' },
              { display: 'Accounting', value: 'FOLIO6' },
            ],
          },
        },
        rows: [
          postingRow({ id: '1', subfolio_display: 'Guest Folio 1' }),
          postingRow({ id: '2', subfolio_display: 'Accounting' }),
        ],
      }),
      parentProof,
      parseContext,
    );

    const balanceItems = parsed.balanceSection?.data.items ?? [];
    const guestRef = balanceItems.find((item) => item.folioType.value === 'guest')?.folioRef.value;
    const accountingRef = balanceItems.find((item) => item.folioType.value === 'accounting')
      ?.folioRef.value;
    expect(parsed.section?.data.items.map((item) => item.folioRef)).toEqual([
      expect.objectContaining({ state: 'known', value: guestRef }),
      expect.objectContaining({ state: 'known', value: accountingRef }),
    ]);
    expect(guestRef).toMatch(/^folio:/);
    expect(accountingRef).toMatch(/^folio:/);
  });

  it.each([
    ['missing options', undefined],
    [
      'ambiguous display',
      [
        { display: 'Guest Folio 1', value: 'GUEST' },
        { display: 'Guest Folio 1', value: 'FOLIO6' },
      ],
    ],
    ['invalid code', [{ display: 'Guest Folio 1', value: 'FOLIO12' }]],
  ])('leaves a %s subfolio label unbound', (_name, options) => {
    const parsed = parseBoundFolioFolTransport(
      boundFolBody({
        values: options === undefined ? {} : { subfolio: { option: options } },
        rows: [postingRow({ subfolio_display: 'Guest Folio 1' })],
      }),
      parentProof,
      parseContext,
    );

    expect(parsed.blocker).toBeNull();
    expect(parsed.section?.data.items[0]?.folioRef).toMatchObject({
      state: 'unknown',
      value: null,
    });
  });

  it('projects source-coded per-folio balances without turning blanks into zero', () => {
    const parsed = parseBoundFolioFolTransport(
      boundFolBody({
        values: {
          foliototal: '-1.25',
          guesttotal: '-2.50',
          guesttotalcurr: 'ZAR',
          incidentaltotal: null,
          incidentaltotalcurr: 'ZAR',
          artotal: '3',
          artotalcurr: 'ZAR',
          folio4total: '',
          folio4totalcurr: 'ZAR',
          folio6total: '0.00',
          folio6totalcurr: 'ZAR',
        },
      }),
      parentProof,
      parseContext,
    );

    expect(parsed.blocker).toBeNull();
    expect(parsed.balanceSection?.state).toBe('available');
    expect(parsed.balanceSection?.completeness).toBe('complete');
    const items = parsed.balanceSection?.data.items ?? [];
    expect(items).toHaveLength(11);
    expect(items.find((item) => item.folioType.value === 'guest')).toMatchObject({
      folioRef: { state: 'known', value: expect.stringMatching(/^folio:/) },
      balance: { state: 'known', value: { amount: '-2.50', currency: 'ZAR' } },
    });
    expect(items.find((item) => item.folioType.value === 'accounts_receivable')).toMatchObject({
      balance: { state: 'known', value: { amount: '3.00', currency: 'ZAR' } },
    });
    expect(items.find((item) => item.folioType.value === 'ta_co')).toMatchObject({
      balance: { state: 'unknown', value: null },
    });
    expect(items.find((item) => item.folioType.value === 'accounting')).toMatchObject({
      balance: { state: 'known', value: { amount: '0.00', currency: 'ZAR' } },
    });
    const refs = items.map((item) => item.folioRef.value);
    expect(new Set(refs).size).toBe(11);
    expect(refs).toEqual(expect.arrayContaining([expect.stringMatching(/^folio:/)]));
    expect(parsed.totalBalance).toBe('-1.25');
  });

  it.each(['folio6totalcurr', 'propertycurrency', 'balancecurr', 'currency'])(
    'fails closed when source-coded currency %s differs from the parent',
    (currencyKey) => {
      const parsed = parseBoundFolioFolTransport(
        boundFolBody({
          values: {
            folio6total: '1.00',
            folio6totalcurr: currencyKey === 'folio6totalcurr' ? 'USD' : undefined,
            [currencyKey]: 'USD',
          },
        }),
        parentProof,
        parseContext,
      );

      expect(parsed.scopeVerified).toBe(false);
      expect(parsed.balanceSection).toBeNull();
      expect(parsed.blocker).toBe('FOLIO_CURRENCY_MISMATCH');
    },
  );

  it.each([
    ['confirmationNumber', { confirmationNumber: 'OTHER' }, 'FOLIO_PARENT_BINDING_MISMATCH'],
    ['reservationStayId', { reservationStayId: 'OTHER' }, 'FOLIO_PARENT_BINDING_MISMATCH'],
    ['account', { account: 'OTHER' }, 'FOLIO_ACCOUNT_BINDING_MISMATCH'],
    ['propertyCode', { propertyCode: 'OTHER' }, 'FOLIO_PARENT_BINDING_MISMATCH'],
    ['currency', { currency: 'USD' }, 'FOLIO_CURRENCY_MISMATCH'],
  ])('rejects wrong %s proof without returning rows', (_name, override, blocker) => {
    const parsed = parseBoundFolioFolTransport(
      boundFolBody(),
      { ...parentProof, ...override },
      parseContext,
    );

    expect(parsed.scopeVerified).toBe(false);
    expect(parsed.section).toBeNull();
    expect(parsed.blocker).toBe(blocker);
  });

  it('rejects a mixed-parent row and a mixed-currency row instead of filtering them', () => {
    for (const row of [
      postingRow({ account: 'OTHER' }),
      postingRow({ reference: 'OTHER' }),
      postingRow({ currency: 'USD' }),
      postingRow({ foreigncurrency: 'USD' }),
    ]) {
      const parsed = parseBoundFolioFolTransport(
        boundFolBody({ rows: [row] }),
        parentProof,
        parseContext,
      );
      expect(parsed.section).toBeNull();
      expect(parsed.scopeVerified).toBe(false);
      expect(parsed.blocker).toMatch(/FOLIO_(?:ACCOUNT_BINDING|PARENT_BINDING|CURRENCY)_MISMATCH/);
    }
  });

  it('does not claim completeness when the source omits the reviewed more-row sentinel', () => {
    const parsed = parseBoundFolioFolTransport(
      boundFolBody({ metadata: { MORERECORDPRESENT: undefined } }),
      parentProof,
      parseContext,
    );

    expect(parsed.scopeVerified).toBe(true);
    expect(parsed.section?.state).toBe('partial');
    expect(parsed.section?.completeness).toBe('unknown');
    expect(parsed.section?.data.page).toEqual({
      returnedCount: 2,
      hasMore: null,
      nextCursor: null,
    });
    expect(parsed.section?.issues).toEqual([
      { code: 'PARTIAL_WINDOW', retryable: false, safeNextAction: 'manual_review' },
    ]);
    expect(readFolioTransactionsSectionSchema.safeParse(parsed.section).success).toBe(true);
  });

  it('fails closed when a continuation is advertised without a cursor', () => {
    const parsed = parseBoundFolioFolTransport(
      boundFolBody({ metadata: { MORERECORDPRESENT: '+' } }),
      parentProof,
      parseContext,
    );

    expect(parsed.scopeVerified).toBe(true);
    expect(parsed.section).toBeNull();
    expect(parsed.blocker).toBe('FOLIO_PAGING_UNSUPPORTED');
  });

  it('suppresses card-bearing responses and rejects row bounds', () => {
    const card = parseBoundFolioFolTransport(
      boundFolBody({ outsidePageData: { cardnumber: '4111111111111111' } }),
      parentProof,
      parseContext,
    );
    expect(card.section).toBeNull();
    expect(card.blocker).toBe('FOLIO_PCI_FIELD_SUPPRESSED');

    const tooMany = Array.from({ length: 51 }, (_, index) =>
      postingRow({ id: String(index + 1), line: String(index + 1) }),
    );
    const bounded = parseBoundFolioFolTransport(
      boundFolBody({ rows: tooMany }),
      parentProof,
      parseContext,
    );
    expect(bounded.rowsScanned).toBe(51);
    expect(bounded.section).toBeNull();
    expect(bounded.blocker).toBe('FOLIO_BOUNDS_EXCEEDED');
  });
});

describe('parseBoundFolioAllDataTransport', () => {
  it('accepts the reviewed All Folios envelope and projects only typed postings', () => {
    const body = allDataBody({
      metadata: { CURRENTCURSORPOSITION: '50', RECORDS: '96', MORERECORDPRESENT: '+' },
      rows: Array.from({ length: 50 }, (_, index) =>
        postingRow({ id: String(index + 1), line: String(index + 1) }),
      ),
    });
    const parsed = parseBoundFolioAllDataTransport(body, parentProof, {
      ...parseContext,
      expectedCursorPosition: 0,
    });

    expect(parsed.envelopeRecognized).toBe(true);
    expect(parsed.scopeVerified).toBe(true);
    expect(parsed.totalRecords).toBe(96);
    expect(parsed.currentCursorPosition).toBe(50);
    expect(parsed.hasMore).toBe(true);
    expect(parsed.rowsScanned).toBe(50);
    expect(parsed.items).toHaveLength(50);
    expect(parsed.items[0]).toMatchObject({
      postingDate: { value: '2026-08-24' },
      amount: { value: { amount: '150.00', currency: 'ZAR' } },
    });
    expect(JSON.stringify(parsed)).not.toContain('Private description');
    expect(JSON.stringify(parsed)).not.toContain('Private comment');
    expect(parsed.sourceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(parsed.blocker).toBeNull();
  });

  it('accepts a bounded cache page only at its requested cursor position', () => {
    const rows = Array.from({ length: 2 }, (_, index) =>
      postingRow({ id: String(index + 51), line: String(index + 51) }),
    );
    const body = allDataBody({
      rows,
      metadata: { CURRENTCURSORPOSITION: '52', RECORDS: '96', MORERECORDPRESENT: '+' },
    });
    const parsed = parseBoundFolioAllDataTransport(body, parentProof, {
      ...parseContext,
      expectedCursorPosition: 51,
    });
    expect(parsed.blocker).toBeNull();
    expect(parsed.scopeVerified).toBe(true);
    expect(parsed.currentCursorPosition).toBe(52);
    expect(parsed.hasMore).toBe(true);
  });

  it('rejects a cache response whose endpoint is not requested start plus row count', () => {
    const body = allDataBody({
      rows: [postingRow({ id: '51', line: '51' }), postingRow({ id: '52', line: '52' })],
      metadata: { CURRENTCURSORPOSITION: '53', RECORDS: '96', MORERECORDPRESENT: '+' },
    });
    const parsed = parseBoundFolioAllDataTransport(body, parentProof, {
      ...parseContext,
      expectedCursorPosition: 51,
    });
    expect(parsed.scopeVerified).toBe(false);
    expect(parsed.blocker).toBe('FOLIO_ALL_DATA_PAGING_UNSUPPORTED');
  });

  it('excludes ephemeral server timestamps from the stable source hash', () => {
    const rows = Array.from({ length: 50 }, (_, index) =>
      postingRow({ id: String(index + 1), line: String(index + 1) }),
    );
    const first = parseBoundFolioAllDataTransport(
      allDataBody({
        rows,
        metadata: {
          CURRENTCURSORPOSITION: '50',
          RECORDS: '96',
          MORERECORDPRESENT: '+',
          SERVERTIMESTAMP: '1789617259736',
        },
      }),
      parentProof,
      { ...parseContext, expectedCursorPosition: 0 },
    );
    const later = parseBoundFolioAllDataTransport(
      allDataBody({
        rows,
        metadata: {
          CURRENTCURSORPOSITION: '50',
          RECORDS: '96',
          MORERECORDPRESENT: '+',
          SERVERTIMESTAMP: '1789617263121',
        },
      }),
      parentProof,
      { ...parseContext, expectedCursorPosition: 0 },
    );
    expect(first.blocker).toBeNull();
    expect(later.blocker).toBeNull();
    expect(first.sourceHash).toBe(later.sourceHash);
  });

  it.each([
    ['wrong dataspy', { dataspy: { id: '999' } }, 'FOLIO_ALL_DATA_UNSUPPORTED_FORMAT'],
    ['wrong grid', { metadata: { GRIDID: '781' } }, 'FOLIO_ALL_DATA_UNSUPPORTED_FORMAT'],
    [
      'wrong parent row',
      { rows: [postingRow({ reference: 'OTHER' })] },
      'FOLIO_PARENT_BINDING_MISMATCH',
    ],
    ['wrong currency row', { rows: [postingRow({ currency: 'USD' })] }, 'FOLIO_CURRENCY_MISMATCH'],
    [
      'payment token',
      { rows: [postingRow({ token: 'opaque-payment-token' })] },
      'FOLIO_PCI_FIELD_SUPPRESSED',
    ],
  ] as const)('fails closed for %s', (_label, options, blocker) => {
    const parsed = parseBoundFolioAllDataTransport(
      allDataBody({
        ...options,
        metadata: {
          CURRENTCURSORPOSITION: 'rows' in options ? String(options.rows?.length ?? 0) : '50',
          RECORDS: '96',
          MORERECORDPRESENT: '+',
          ...(options.metadata ?? {}),
        },
      }),
      parentProof,
      { ...parseContext, expectedCursorPosition: 0 },
    );
    expect(parsed.scopeVerified).toBe(false);
    expect(parsed.items).toEqual([]);
    expect(parsed.blocker).toBe(blocker);
  });

  it('rejects a card-bearing response and pages over the hard source limit', () => {
    const card = parseBoundFolioAllDataTransport(
      allDataBody({ rows: [postingRow({ cardnumber: '4111111111111111' })] }),
      parentProof,
      parseContext,
    );
    expect(card.blocker).toBe('FOLIO_PCI_FIELD_SUPPRESSED');

    const tooMany = Array.from({ length: 51 }, (_, index) =>
      postingRow({ id: String(index + 1), line: String(index + 1) }),
    );
    const bounded = parseBoundFolioAllDataTransport(
      allDataBody({ rows: tooMany, metadata: { RECORDS: '96', CURRENTCURSORPOSITION: '51' } }),
      parentProof,
      { ...parseContext, expectedCursorPosition: 0 },
    );
    expect(bounded.blocker).toBe('FOLIO_ALL_DATA_BOUNDS_EXCEEDED');
  });
});
