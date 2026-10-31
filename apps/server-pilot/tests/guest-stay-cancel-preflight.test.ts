import { describe, expect, it } from 'vitest';
import { projectCancellationPreflight } from '../tooling/hms-cloud/guest-stay-cancel-preflight.mjs';

const CONFIRMATION = 'CONF-PREFLIGHT-TEST';
type Field = { name: string; value: unknown; section?: string };
type ShallowOptions = {
  confirmation?: string;
  header?: string;
  complete?: boolean;
  status?: string;
  room?: string;
  grandTotal?: string;
  ratePlan?: string;
  adults?: string;
  omitStayCard?: boolean;
  stayFields?: Field[];
  associationFields?: Field[];
  visibleFields?: Field[];
};
type RecordOptions = {
  confirmation?: string;
  activeTab?: string;
  status?: string;
  room?: string;
  balance?: string;
  balanceCurrency?: string;
  grandTotal?: string;
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
  grandTotal = '0.00',
  ratePlan = 'RATE-PLAN-TEST',
  adults = '2',
  omitStayCard = false,
  stayFields = [],
  associationFields = [
    { name: 'ta1', value: 'AGENCY-TEST' },
    { name: 'company', value: 'ORG-TEST' },
    { name: 'groupname', value: 'GROUP-TEST' },
  ],
  visibleFields = [],
}: ShallowOptions = {}) {
  const fields: Field[] = [
    { name: 'status', value: status },
    { name: 'arrivaldate', value: '2027-02-03' },
    { name: 'departuredate', value: '2027-02-05' },
    { name: 'nights', value: '2' },
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
  room = 'ROOM-TEST',
  balance = '0.00',
  balanceCurrency = 'GBP',
  grandTotal = '0.00',
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
    { name: 'arrivaldate', value: '2027-02-03' },
    { name: 'departuredate', value: '2027-02-05' },
    { name: 'nights', value: '2' },
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
    { name: 'grandtotalcurr', value: 'GBP' },
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
    expect(result.stay.arrivalDate.value).toBe('2027-02-03');
    expect(result.stay.departureDate.value).toBe('2027-02-05');
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
      state: 'observed', value: '1', sources: ['1b_record_view'],
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

  it('keeps requested scope separate and never derives policy or fee from history', () => {
    const wholeStay = project();
    expect(wholeStay.roomScope).toMatchObject({
      requested: 'whole_stay', state: 'unresolved', complete: false,
    });
    const cancelled = project({
      shallow: read1A({ status: 'Cancelled' }),
      record: read1B({ status: 'Cancelled', extraFields: [
        { name: 'canceldate', value: '2027-02-01' },
        { name: 'cancelreasondesc', value: 'Synthetic history' },
        { name: 'cancelpolicytext', value: 'Synthetic policy text' },
        { name: 'penalty', value: '0.00' },
      ] }),
    });
    expect(cancelled.stay.status.value).toBe('Cancelled');
    expect(cancelled.policy.state).toBe('unknown');
    expect(cancelled.fee.state).toBe('unknown_precommit');
    expect(cancelled.action.commitAvailable).toBe(false);
    expect(JSON.stringify(cancelled)).not.toContain('Synthetic policy text');
  });
});
