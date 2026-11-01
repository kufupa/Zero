import { describe, expect, it } from 'vitest';
import { projectCancellationPreflight } from '../tooling/hms-cloud/guest-stay-cancel-preflight.mjs';
import { projectFinanceDisplayPreflight } from '../tooling/hms-cloud/guest-stay-finance-preflight.mjs';

const CONFIRMATION = 'CONF-PREFLIGHT-TEST';
type Field = { name: string; value: unknown; section?: string };
type ShallowOptions = {
  confirmation?: string;
  header?: string;
  complete?: boolean;
  status?: string;
  room?: string;
  arrivalDate?: string;
  departureDate?: string;
  nights?: string;
  grandTotal?: string;
  ratePlan?: string;
  adults?: string;
  omitStayCard?: boolean;
  omitFolioCard?: boolean;
  stayFields?: Field[];
  associationFields?: Field[];
  folioFields?: Field[];
  visibleFields?: Field[];
};
type RecordOptions = {
  confirmation?: string;
  activeTab?: string;
  status?: string;
  cancellationNumber?: string;
  omitCancellationNumber?: boolean;
  room?: string;
  balance?: string;
  balanceCurrency?: string;
  grandTotal?: string;
  grandTotalCurrency?: string;
  arrivalDate?: string;
  departureDate?: string;
  nights?: string;
  guaranteeType?: string;
  ratePlan?: string;
  adults?: string;
  children?: string;
  bookingAgency?: string;
  organization?: string;
  group?: string;
  extraFields?: Field[];
};

function read1A({
  confirmation = CONFIRMATION,
  header = confirmation,
  complete = true,
  status = 'Reserved',
  room = 'ROOM-TEST',
  arrivalDate = 'Wed 03-Feb-2027',
  departureDate = 'Fri 05-Feb-2027',
  nights = '2 Nights',
  grandTotal = '0.00',
  ratePlan = 'RATE-PLAN-TEST',
  adults = '2 Adults1 Child',
  omitStayCard = false,
  omitFolioCard = false,
  stayFields = [],
  folioFields = [
    { name: 'foliobalance', value: 'R1,234.50' },
    { name: 'depositreceived', value: 'R0.00' },
    { name: 'depositamount', value: 'R500.00' },
    { name: 'depositduedate', value: 'Tue 02-Feb-2027' },
  ],
  associationFields = [
    { name: 'ta1', value: 'AGENCY-TEST' },
    { name: 'company', value: 'ORG-TEST' },
    { name: 'groupname', value: 'GROUP-TEST' },
  ],
  visibleFields = [],
}: ShallowOptions = {}) {
  const fields: Field[] = [
    { name: 'status', value: status },
    { name: 'arrivaldate', value: arrivalDate },
    { name: 'departuredate', value: departureDate },
    { name: 'nights', value: nights },
    { name: 'room', value: room },
    { name: 'roomtype', value: 'ROOM-TYPE-TEST' },
    { name: 'grandtotal', value: grandTotal },
    { name: 'rateplan', value: ratePlan },
    { name: 'adults', value: adults },
    ...stayFields,
  ];
  return {
    ok: true,
    confirmation,
    selectedRow: confirmation,
    searchResults: { displayed: 1, total: 1, complete },
    details: {
      confirmationInHeader: header,
      cards: omitStayCard ? [] : [
        { title: 'Stay', fields, visibleText: 'synthetic', grids: [] },
        { title: 'Associations', fields: associationFields, visibleText: 'synthetic', grids: [] },
        ...(omitFolioCard ? [] : [{ title: 'Folio', fields: folioFields, visibleText: 'synthetic', grids: [] }]),
      ],
      visibleFormFields: visibleFields,
      visiblePageTextOutsideGrids: 'synthetic only',
      captureScope: 'synthetic 1A reader fixture',
    },
  };
}

function read1B({
  confirmation = CONFIRMATION,
  activeTab = 'Record View',
  status = 'Reserved',
  cancellationNumber = '',
  omitCancellationNumber = false,
  room = 'ROOM-TEST',
  arrivalDate = '03-FEB-2027',
  departureDate = '05-FEB-2027',
  nights = '2',
  balance = '0.00',
  balanceCurrency = 'GBP',
  grandTotal = '0.00',
  grandTotalCurrency = 'GBP',
  guaranteeType = 'GUARANTEE-TEST',
  ratePlan = 'RATE-PLAN-TEST',
  adults = '2',
  children = '1',
  bookingAgency = 'AGENCY-TEST',
  organization = 'ORG-TEST',
  group = 'GROUP-TEST',
  extraFields = [],
}: RecordOptions = {}) {
  const fields: Field[] = [
    { name: 'confirmationnumber', value: confirmation },
    { name: 'status', value: status },
    ...(omitCancellationNumber ? [] : [{ name: 'cancelnumber', value: cancellationNumber }]),
    { name: 'arrivaldate', value: arrivalDate },
    { name: 'departuredate', value: departureDate },
    { name: 'nights', value: nights },
    { name: 'room', value: room },
    { name: 'scheduledroom', value: '' },
    { name: 'roomtype', value: 'ROOM-TYPE-TEST' },
    { name: 'roomtypecharge', value: '' },
    { name: 'guaranteetype', value: guaranteeType },
    { name: 'rateplan', value: ratePlan },
    { name: 'adults', value: adults },
    { name: 'children', value: children },
    { name: 'ta1', value: bookingAgency },
    { name: 'company', value: organization },
    { name: 'groupname', value: group },
    { name: 'balance', value: balance },
    { name: 'balancecurr', value: balanceCurrency },
    { name: 'grandtotal', value: grandTotal },
    { name: 'grandtotalcurr', value: grandTotalCurrency },
    { name: 'firstname', value: 'TEST-GUEST-NAME', section: 'Guest' },
    { name: 'emailaddress', value: 'guest@example.invalid', section: 'Guest' },
    ...extraFields,
  ];
  return {
    notes: [{ title: 'synthetic note', text: 'synthetic private note' }],
    details: {
      confirmationInRecord: confirmation,
      activeTab,
      fields,
      visibleText: 'synthetic record',
      grids: ['synthetic grid'],
      captureScope: 'synthetic 1B reader fixture',
    },
  };
}

type Overrides = {
  confirmation?: string;
  requestedScope?: 'whole_stay' | 'specific_room' | 'unspecified';
  shallow?: ReturnType<typeof read1A>;
  record?: ReturnType<typeof read1B>;
};

function project(overrides: Overrides = {}) {
  return projectCancellationPreflight({
    confirmation: CONFIRMATION,
    requestedScope: 'whole_stay',
    shallow: read1A(),
    record: read1B(),
    ...overrides,
  });
}

describe('projectCancellationPreflight', () => {
  it('projects exact reader facts without forwarding unrelated guest data', () => {
    const result = project({ requestedScope: 'specific_room' });
    expect(result.outcome).toBe('prepared_for_human_review');
    expect(result.target).toEqual({ confirmation: CONFIRMATION, verified: true });
    expect(result.stay.status).toMatchObject({
      state: 'observed', value: 'Reserved', sources: ['1a_stay_card', '1b_record_view'],
    });
    expect(result.stay.cancellationNumber).toMatchObject({ state: 'blank', value: '', sources: ['1b_record_view'] });
    expect(result.stay.arrivalDate.value).toBe('03-FEB-2027');
    expect(result.stay.departureDate.value).toBe('05-FEB-2027');
    expect(result.stay.nights.value).toBe('2');
    expect(result.stay.guaranteeType).toMatchObject({
      state: 'observed', value: 'GUARANTEE-TEST', sources: ['1b_record_view'],
    });
    expect(result.stay.ratePlan).toMatchObject({
      state: 'observed', value: 'RATE-PLAN-TEST', sources: ['1a_stay_card', '1b_record_view'],
    });
    expect(result.stay.adults).toMatchObject({
      state: 'observed', value: '2', sources: ['1a_stay_card', '1b_record_view'],
    });
    expect(result.stay.children).toMatchObject({
      state: 'observed', value: '1', sources: ['1a_stay_card', '1b_record_view'],
    });
    expect(result.party.bookingAgency).toMatchObject({
      state: 'observed', value: 'AGENCY-TEST', sources: ['1a_associations_card', '1b_record_view'],
    });
    expect(result.party.organization).toMatchObject({
      state: 'observed', value: 'ORG-TEST', sources: ['1a_associations_card', '1b_record_view'],
    });
    expect(result.party.group).toMatchObject({
      state: 'observed', value: 'GROUP-TEST', sources: ['1a_associations_card', '1b_record_view'],
    });
    expect(result.roomScope).toMatchObject({
      requested: 'specific_room', state: 'unresolved', complete: false,
    });
    expect(result.roomScope.room.value).toBe('ROOM-TEST');
    expect(result.money.balance).toMatchObject({ amount: { state: 'observed_zero' },
      currency: { state: 'observed', value: 'GBP' } });
    expect(result.policy.state).toBe('unknown');
    expect(result.fee).toEqual({ state: 'unknown_precommit', amount: null, currency: null });
    expect(result.action).toEqual({
      actor: 'human', cancellationStarted: false, commitAvailable: false,
    });
    const output = JSON.stringify(result);
    expect(output).not.toContain('TEST-GUEST-NAME');
    expect(output).not.toContain('guest@example.invalid');
    expect(output).not.toContain('synthetic private note');
  });

  it('requires complete, exact 1A and matching Record View identity', () => {
    const cases = [
      [project({ shallow: read1A({ confirmation: 'CONF-OTHER' }) }), 'SHALLOW_TARGET_MISMATCH'],
      [project({ shallow: read1A({ header: 'CONF-OTHER' }) }), 'SHALLOW_TARGET_MISMATCH'],
      [project({ shallow: read1A({ complete: false }) }), 'SHALLOW_RESULTS_INCOMPLETE'],
      [project({ shallow: read1A({ omitStayCard: true }) }), 'SHALLOW_DETAILS_UNVERIFIED'],
      [project({ record: read1B({ confirmation: 'CONF-OTHER' }) }), 'RECORD_TARGET_MISMATCH'],
      [project({ record: read1B({ activeTab: 'Documents' }) }), 'RECORD_VIEW_UNVERIFIED'],
    ] as const;
    for (const [result, issue] of cases) {
      expect(result).toEqual({ outcome: 'target_unverified', issue });
    }
  });

  it('returns ambiguity or conflict instead of choosing duplicate or disagreeing values', () => {
    expect(project({ record: read1B({ extraFields: [{ name: 'nights', value: '3' }] }) })
      .stay.nights.state).toBe('ambiguous');
    expect(project({
      shallow: read1A(), record: read1B({ status: 'Cancelled' }),
    }).stay.status).toMatchObject({ state: 'conflict', values: ['Reserved', 'Cancelled'] });
    expect(project({
      shallow: read1A({ visibleFields: [{ name: 'status', value: 'Checked Out' }] }),
    }).stay.status.state).toBe('ambiguous');
    expect(project({
      shallow: read1A(), record: read1B({ grandTotal: '75.00' }),
    }).money.grandTotal.amount.state).toBe('conflict');
    expect(project({
      shallow: read1A({ associationFields: [{ name: 'groupname', value: 'GROUP-OTHER' }] }),
    }).party.group.state).toBe('conflict');
    expect(project({
      record: read1B({ extraFields: [{ name: 'company', value: 'ORG-DUPLICATE' }] }),
    }).party.organization.state).toBe('ambiguous');
  });

  it('splits the exact cancelled status decoration only when 1B status and cancellation number both match', () => {
    const result = project({
      shallow: read1A({ status: 'Cancelled\n1234567' }),
      record: read1B({ status: 'Cancelled', cancellationNumber: '1234567' }),
    });
    expect(result.stay.status).toMatchObject({
      state: 'observed', value: 'Cancelled',
      sources: ['1a_stay_card', '1b_record_view'],
      normalization: 'verified_1b_status_and_cancelnumber',
    });
    expect(result.stay.cancellationNumber).toMatchObject({
      state: 'observed', value: '1234567', sources: ['1a_stay_card', '1b_record_view'],
    });
  });

  it('preserves cancellation conflicts when the status label or number disagrees', () => {
    const wrongNumber = project({
      shallow: read1A({ status: 'Cancelled\n1234567' }),
      record: read1B({ status: 'Cancelled', cancellationNumber: '7654321' }),
    });
    expect(wrongNumber.stay.status.state).toBe('conflict');
    expect(wrongNumber.stay.cancellationNumber).toMatchObject({
      state: 'conflict', values: ['1234567', '7654321'], sources: ['1a_stay_card', '1b_record_view'],
    });

    const blankNumber = project({
      shallow: read1A({ status: 'Cancelled\n1234567' }),
      record: read1B({ status: 'Cancelled', cancellationNumber: '' }),
    });
    expect(blankNumber.stay.status.state).toBe('conflict');
    expect(blankNumber.stay.cancellationNumber).toMatchObject({ state: 'conflict', values: ['1234567', ''] });

    const wrongStatus = project({
      shallow: read1A({ status: 'Cancelled\n1234567' }),
      record: read1B({ status: 'Reserved', cancellationNumber: '1234567' }),
    });
    expect(wrongStatus.stay.status.state).toBe('conflict');
    expect(wrongStatus.stay.cancellationNumber).toMatchObject({ state: 'observed', value: '1234567' });
  });

  it('leaves a recognized decoration ambiguous when 1B cancellation number is not rendered', () => {
    const result = project({
      shallow: read1A({ status: 'Cancelled\n1234567' }),
      record: read1B({ status: 'Cancelled', omitCancellationNumber: true }),
    });
    expect(result.stay.status).toMatchObject({
      state: 'ambiguous', reason: 'cancellation_status_decoration_not_reconciled',
    });
    expect(result.stay.cancellationNumber).toMatchObject({
      state: 'unavailable', reason: 'field_not_rendered',
    });
  });

  it('does not normalize unsupported decorations or duplicate cancellation-number fields', () => {
    const unsupported = project({
      shallow: read1A({ status: 'Cancelled\n123456' }),
      record: read1B({ status: 'Cancelled', cancellationNumber: '123456' }),
    });
    expect(unsupported.stay.status.state).toBe('conflict');
    expect(unsupported.stay.cancellationNumber).toMatchObject({
      state: 'observed', value: '123456', sources: ['1b_record_view'],
    });

    const duplicate = project({
      shallow: read1A({ status: 'Cancelled\n1234567' }),
      record: read1B({ status: 'Cancelled', cancellationNumber: '1234567', extraFields: [
        { name: 'cancelnumber', value: '1234567' },
      ] }),
    });
    expect(duplicate.stay.status).toMatchObject({ state: 'ambiguous', reason: 'duplicate_field' });
    expect(duplicate.stay.cancellationNumber).toMatchObject({ state: 'ambiguous', reason: 'duplicate_field' });
  });

  it('normalizes supported date, night, and occupancy displays but preserves real conflicts and unknown formats', () => {
    const normalized = project();
    expect(normalized.stay.arrivalDate).toMatchObject({ state: 'observed', value: '03-FEB-2027' });
    expect(normalized.stay.departureDate).toMatchObject({ state: 'observed', value: '05-FEB-2027' });
    expect(normalized.stay.nights).toMatchObject({ state: 'observed', value: '2' });
    expect(normalized.stay.adults).toMatchObject({ state: 'observed', value: '2' });
    expect(normalized.stay.children).toMatchObject({ state: 'observed', value: '1' });

    expect(project({
      shallow: read1A({ arrivalDate: 'Thu 04-Feb-2027' }),
    }).stay.arrivalDate.state).toBe('conflict');
    expect(project({
      shallow: read1A({ arrivalDate: 'Thu 03-Feb-2027' }),
    }).stay.arrivalDate.state).toBe('ambiguous');
    expect(project({
      shallow: read1A({ arrivalDate: 'Wed 03-Feb-2027 09:30' }),
    }).stay.arrivalDate.state).toBe('observed');
    expect(project({
      shallow: read1A({ nights: '3 Nights' }),
    }).stay.nights.state).toBe('conflict');
    expect(project({
      shallow: read1A({ nights: 'about two nights' }),
    }).stay.nights.state).toBe('ambiguous');
    expect(project({
      shallow: read1A({ adults: '3 Adults1 Child' }),
    }).stay.adults.state).toBe('conflict');
    expect(project({
      shallow: read1A({ adults: '2 Adults2 Child' }),
    }).stay.children.state).toBe('conflict');

    const unrecognizedOccupancy = project({
      shallow: read1A({ adults: 'two adults and one child' }),
    });
    expect(unrecognizedOccupancy.stay.adults.state).toBe('ambiguous');
    expect(unrecognizedOccupancy.stay.children.state).toBe('ambiguous');
  });

  it('keeps displayed zero, blank, and unavailable money distinct', () => {
    expect(project().money.balance.amount.state).toBe('observed_zero');
    const blank = project({
      shallow: read1A({ grandTotal: '' }),
      record: read1B({ balance: '', balanceCurrency: '', grandTotal: '' }),
    });
    expect(blank.money.balance.amount.state).toBe('blank');
    expect(blank.money.balance.currency.state).toBe('blank');
    expect(blank.money.grandTotal.amount.state).toBe('blank');
    expect(blank.money.totalRate.amount.state).toBe('unavailable');
    expect(blank.money.totalRate.currency.state).toBe('unavailable');
  });

  it('recognizes only numeric zero with a supported currency affix', () => {
    const codedZero = project({
      shallow: read1A({ grandTotal: 'GBP 0.00' }),
      record: read1B({ grandTotal: 'GBP 0.00' }),
    });
    expect(codedZero.money.grandTotal.amount.state).toBe('observed_zero');

    const textContainingZero = project({
      shallow: read1A({ grandTotal: 'not 0' }),
      record: read1B({ grandTotal: 'not 0' }),
    });
    expect(textContainingZero.money.grandTotal.amount).toMatchObject({
      state: 'observed', value: 'not 0',
    });
  });

  it('reconciles an R-prefixed amount only when the displayed currency resolves to ZAR', () => {
    const resolved = project({
      shallow: read1A({ grandTotal: 'R1,234.50' }),
      record: read1B({ grandTotal: '1,234.50', grandTotalCurrency: 'ZAR' }),
    });
    expect(resolved.money.grandTotal.amount).toMatchObject({
      state: 'observed', value: '1,234.50', sources: ['1a_stay_card', '1b_record_view'],
    });

    const unresolved = project({
      shallow: read1A({ grandTotal: 'R1,234.50' }),
      record: read1B({ grandTotal: '1,234.50', grandTotalCurrency: '' }),
    });
    expect(unresolved.money.grandTotal.amount.state).toBe('ambiguous');

    const mismatchedCurrency = project({
      shallow: read1A({ grandTotal: 'R1,234.50' }),
      record: read1B({ grandTotal: '1,234.50', grandTotalCurrency: 'GBP' }),
    });
    expect(mismatchedCurrency.money.grandTotal.amount.state).toBe('conflict');

    const mismatchedAmount = project({
      shallow: read1A({ grandTotal: 'R1,234.50' }),
      record: read1B({ grandTotal: '1,235.50', grandTotalCurrency: 'ZAR' }),
    });
    expect(mismatchedAmount.money.grandTotal.amount.state).toBe('conflict');

    const unsupportedNumberFormat = project({
      shallow: read1A({ grandTotal: 'R1.234,50' }),
      record: read1B({ grandTotal: '1,234.50', grandTotalCurrency: 'ZAR' }),
    });
    expect(unsupportedNumberFormat.money.grandTotal.amount.state).toBe('ambiguous');
  });

  it('keeps equal zero amounts conflicting when their explicit currencies differ', () => {
    const result = project({
      shallow: read1A({ grandTotal: 'GBP 0.00' }),
      record: read1B({ grandTotal: 'USD 0.00', grandTotalCurrency: 'USD' }),
    });
    expect(result.money.grandTotal.amount).toMatchObject({
      state: 'conflict', values: ['GBP 0.00', 'USD 0.00'],
    });
  });

  it('exposes Folio-card observations without inferring cleared deposits or a verified due date', () => {
    const result = project();
    expect(result.folio).toMatchObject({
      basis: '1a_folio_card_display_only',
      balance: { state: 'observed', value: 'R1,234.50', sources: ['1a_folio_card'] },
      depositReceived: { state: 'observed_zero', value: 'R0.00', sources: ['1a_folio_card'] },
      depositAmount: { state: 'observed', value: 'R500.00', sources: ['1a_folio_card'] },
      depositDueDate: { state: 'observed', value: 'Tue 02-Feb-2027', sources: ['1a_folio_card'] },
      interpretation: {
        ledgerBalance: 'not_established',
        depositCleared: 'not_established',
        depositDue: 'not_verified',
      },
    });
    expect(result.money.depositReceived.amount.state).toBe('unavailable');

    const missingCard = project({ shallow: read1A({ omitFolioCard: true }) });
    expect(missingCard.folio.balance).toMatchObject({
      state: 'unavailable', reason: 'folio_card_unavailable',
    });
  });

  it('keeps requested scope separate and never derives policy or fee from history', () => {
    const wholeStay = project();
    expect(wholeStay.roomScope).toMatchObject({
      requested: 'whole_stay', state: 'unresolved', complete: false,
    });
    const cancelled = project({
      shallow: read1A({ status: 'Cancelled' }),
      record: read1B({ status: 'Cancelled', cancellationNumber: '1234567', extraFields: [
        { name: 'canceldate', value: '2027-02-01' },
        { name: 'cancelreasondesc', value: 'Synthetic history' },
        { name: 'cancelpolicytext', value: 'Synthetic policy text' },
        { name: 'penalty', value: '0.00' },
      ] }),
    });
    expect(cancelled.stay.status.value).toBe('Cancelled');
    expect(cancelled.stay.cancellationNumber).toMatchObject({ state: 'observed', value: '1234567' });
    expect(cancelled.policy.state).toBe('unknown');
    expect(cancelled.fee.state).toBe('unknown_precommit');
    expect(cancelled.action.commitAvailable).toBe(false);
    expect(JSON.stringify(cancelled)).not.toContain('Synthetic policy text');
  });
});

describe('projectFinanceDisplayPreflight', () => {
  it('returns only exact-stay display facts and never implies a cleared deposit or ledger read', () => {
    const result = projectFinanceDisplayPreflight({
      confirmation: CONFIRMATION,
      shallow: read1A(),
      record: read1B({
        balance: '0.00',
        balanceCurrency: 'ZAR',
        extraFields: [
          { name: 'depositreceived', value: '125.00' },
          { name: 'depositreceivedcurrency', value: 'ZAR' },
          { name: 'udfchar02', value: '300.00' },
          { name: 'udfdate02', value: '02-FEB-2027' },
        ],
      }),
    });

    expect(result).toMatchObject({
      outcome: 'prepared_for_human_review',
      target: { confirmation: CONFIRMATION, verified: true },
      recordView: {
        basis: 'stay360_display_only_not_ledger',
        balance: { amount: { state: 'observed_zero', value: '0.00' }, currency: { value: 'ZAR' } },
        depositReceived: { amount: { state: 'observed', value: '125.00' } },
        depositDue: { state: 'observed', value: '300.00' },
        depositDueDate: { state: 'observed', value: '02-FEB-2027' },
      },
      folioCard: {
        basis: '1a_folio_card_display_only',
        balance: { state: 'observed', value: 'R1,234.50' },
        depositReceived: { state: 'observed_zero', value: 'R0.00' },
      },
      interpretation: {
        ledgerBalance: 'not_established',
        depositCleared: 'not_established',
        depositDue: 'not_verified',
        transactionHistory: 'not_read',
      },
    });
    expect(JSON.stringify(result)).not.toContain('TEST-GUEST-NAME');

    const blank = projectFinanceDisplayPreflight({
      confirmation: CONFIRMATION,
      shallow: read1A(),
      record: read1B({
        balance: '',
        extraFields: [{ name: 'depositreceived', value: '' }],
      }),
    });
    expect(blank.recordView.balance.amount.state).toBe('blank');
    expect(blank.recordView.depositReceived.amount.state).toBe('blank');

    const mismatch = projectFinanceDisplayPreflight({
      confirmation: CONFIRMATION,
      shallow: read1A(),
      record: read1B({ confirmation: 'OTHER-TEST-RECORD' }),
    });
    expect(mismatch).toMatchObject({ outcome: 'target_unverified' });
    expect(mismatch).not.toHaveProperty('recordView');
  });
});
