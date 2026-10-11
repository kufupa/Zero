import {
  baselineCorrect,
  candidateCorrect,
  contactValueHash,
  evaluateLabelGates,
  fieldClassOf,
  finalLabels,
  LABEL_GATES,
  parseLabelCases,
  scoreKind,
  scoreField,
  scoreLabelCases,
  type CandidateTrace,
  type LabelCase,
  type LabelRow,
  type LabelSummary,
} from '../src/ai/label-scorers.js';
import type { MailExtractionPayload } from '../src/ai/extraction/schema.js';
import { describe, expect, it } from 'vitest';

const STAY = 's_stay0001';
const ROW = 'r_row0001';
const ARRIVAL = `stays[${STAY}].requested.arrival`;
const DEPARTURE = `stays[${STAY}].requested.departure`;
const COUNT = `stays[${STAY}].rows[${ROW}].count`;

/** What the extraction read from the fixture mail: one stay, one row. */
function payload(
  overrides: Partial<{
    arrival: string | null;
    departure: string | null;
    rooms: number | null;
    name: string | null;
    email: string | null;
    phone: string | null;
    stays: MailExtractionPayload['stays'];
  }> = {},
): MailExtractionPayload {
  return {
    contact: {
      name: overrides.name === undefined ? 'Jane Smith' : overrides.name,
      email: overrides.email === undefined ? '[email]' : overrides.email,
      phone: overrides.phone === undefined ? null : overrides.phone,
    },
    agency: null,
    endClient: null,
    confirmationNumbers: [],
    stays: overrides.stays ?? [
      {
        id: STAY,
        hotel: null,
        requested: {
          arrival: overrides.arrival === undefined ? '2027-10-26' : overrides.arrival,
          departure: overrides.departure === undefined ? '2027-10-28' : overrides.departure,
        },
        booked: null,
        totalRooms: 2,
        rows: [
          {
            id: ROW,
            roomType: 'Single',
            rooms: overrides.rooms === undefined ? 2 : overrides.rooms,
            adultsPerRoom: 1,
            childAges: [],
            board: null,
          },
        ],
      },
    ],
    missing: [],
  };
}

function label(overrides: Partial<LabelRow>): LabelRow {
  return {
    event_id: `e-${Math.random()}`,
    field_id: ARRIVAL,
    label_kind: 'correction',
    ai_source: 'extractor-v3',
    ai_value: '2027-10-26',
    human_value: '2027-10-27',
    value_hash: null,
    ...overrides,
  };
}

function caseOf(
  id: string,
  split: 'dev' | 'holdout' | 'test',
  labels: LabelRow[],
  kind = 'quote',
): LabelCase {
  return {
    schema_version: 'work-event-label/v2',
    work_item_id: id,
    message_id: `msg-${id}`,
    transport_id: 'transport-1',
    kind,
    extractor_version: 'extractor-v3',
    mailbox: '[email]@legacyhotels.co.za',
    from: '[email]@example.com',
    subject: 'Quote request',
    text: 'Two rooms, 2027-10-26 to 2027-10-28.',
    split,
    split_source: 'hash',
    labels,
  };
}

const answered = (value: MailExtractionPayload, kind = 'quote'): CandidateTrace => ({
  extraction: { kind, payload: value },
});

describe('label dataset contract', () => {
  it('parses cases and names the bad line when a row is invalid', () => {
    const good = JSON.stringify(caseOf('w-1', 'dev', []));
    expect(parseLabelCases(`${good}\n\n${good}\n`)).toHaveLength(2);
    expect(() => parseLabelCases(`${good}\n{"schema_version":"other"}\n`)).toThrow(
      /dataset line 2 is invalid/,
    );
    expect(() => parseLabelCases('not json\n')).toThrow(/dataset line 1 is not JSON/);
  });

  it('groups extraction fields into stay, row, contact and other classes', () => {
    expect(fieldClassOf(ARRIVAL)).toBe('stay.arrival');
    expect(fieldClassOf(`stays[${STAY}].removed`)).toBe('stay.removed');
    expect(fieldClassOf(COUNT)).toBe('row.count');
    expect(fieldClassOf(`stays[${STAY}].rows[${ROW}].removed`)).toBe('row.removed');
    expect(fieldClassOf('contact.email')).toBe('contact.email');
    expect(fieldClassOf('followUp.draft')).toBe('other');
  });
});

describe('per-field scorers', () => {
  it('a correction is right when the candidate gives the value the person kept', () => {
    const correction = label({
      field_id: ARRIVAL,
      ai_value: '2027-10-26',
      human_value: '2027-10-27',
    });
    expect(candidateCorrect(correction, payload({ arrival: '2027-10-27' }))).toBe(true);
    expect(candidateCorrect(correction, payload({ arrival: '2027-10-26' }))).toBe(false);
    expect(candidateCorrect(correction, payload({ arrival: null }))).toBe(false);
  });

  it('a confirmation is right when the candidate still gives the value the person kept', () => {
    const confirmation = label({
      label_kind: 'confirmation',
      field_id: DEPARTURE,
      ai_value: '2027-10-28',
      human_value: '2027-10-28',
    });
    expect(candidateCorrect(confirmation, payload({ departure: '2027-10-28' }))).toBe(true);
    expect(candidateCorrect(confirmation, payload({ departure: '2027-10-29' }))).toBe(false);
  });

  it('a removed stay is right only when the candidate does not produce it', () => {
    const removed = label({
      field_id: `stays[${STAY}].removed`,
      ai_value: false,
      human_value: true,
    });
    expect(candidateCorrect(removed, payload())).toBe(false);
    expect(candidateCorrect(removed, payload({ stays: [] }))).toBe(true);
  });

  it('compares an address by hash of its raw value, so a changed address is still a mismatch', () => {
    const kept = label({
      label_kind: 'confirmation',
      field_id: 'contact.email',
      ai_value: '[email]',
      human_value: '[email]',
      value_hash: contactValueHash('contact.email', 'Jane@Hotel.co.za', 'Jane@Hotel.co.za', 'salt-1'),
    });
    expect(candidateCorrect(kept, payload({ email: 'jane@hotel.co.za' }))).toBe(true);
    expect(candidateCorrect(kept, payload({ email: 'jane@other.co.za' }))).toBe(false);
    expect(candidateCorrect(kept, payload({ email: null }))).toBe(false);

    const corrected = label({
      field_id: 'contact.email',
      ai_value: '[email]',
      human_value: '[email]',
      value_hash: contactValueHash('contact.email', 'jane@hotel.co.za', 'jen@hotel.co.za', 'salt-1'),
    });
    expect(baselineCorrect(corrected)).toBe(false);
    expect(candidateCorrect(corrected, payload({ email: 'jen@hotel.co.za' }))).toBe(true);
    expect(candidateCorrect(corrected, payload({ email: 'jane@hotel.co.za' }))).toBe(false);
  });

  it('compares a phone by its digits, so spacing and a leading + do not count as a change', () => {
    const phone = label({
      label_kind: 'correction',
      field_id: 'contact.phone',
      ai_value: '[phone]',
      human_value: '[phone]',
      value_hash: contactValueHash('contact.phone', '082 555 1234', '+27 82 555 1234', 'salt-2'),
    });
    expect(candidateCorrect(phone, payload({ phone: '+27825551234' }))).toBe(true);
    expect(candidateCorrect(phone, payload({ phone: '082 555 1234' }))).toBe(false);
  });

  it('a label without hashes never matches a contact value', () => {
    const bare = label({ field_id: 'contact.email', ai_value: '[email]', human_value: '[email]' });
    expect(candidateCorrect(bare, payload({ email: 'jane@hotel.co.za' }))).toBe(false);
  });

  it('a scorer step returns 1 for a right value and 0 for a wrong one, with no judge', async () => {
    const correction = label({ field_id: COUNT, ai_value: 2, human_value: 3 });
    expect(await scoreField(correction, payload({ rooms: 3 }))).toBe(1);
    expect(await scoreField(correction, payload({ rooms: 2 }))).toBe(0);
    expect(await scoreField(correction, null)).toBe(0);
    expect(await scoreKind('quote', 'quote')).toBe(1);
    expect(await scoreKind('quote', 'booking')).toBe(0);
    expect(await scoreKind('quote', null)).toBe(0);
  });
});

describe('scoreLabelCases', () => {
  const cases: LabelCase[] = [
    // Corrected by the person: production said 26, the person kept 27.
    caseOf('w-dev-1', 'dev', [
      label({ field_id: ARRIVAL, ai_value: '2027-10-26', human_value: '2027-10-27' }),
    ]),
    // Confirmed by the person: production said 28 and it stayed.
    caseOf('w-dev-2', 'dev', [
      label({
        label_kind: 'confirmation',
        field_id: DEPARTURE,
        ai_value: '2027-10-28',
        human_value: '2027-10-28',
      }),
    ]),
    caseOf(
      'w-hold-1',
      'holdout',
      [
        label({
          label_kind: 'confirmation',
          field_id: DEPARTURE,
          ai_value: '2027-10-28',
          human_value: '2027-10-28',
        }),
      ],
      'booking',
    ),
    // A note and a run flag carry no extraction field, so they are not scored.
    caseOf('w-test-1', 'test', [
      label({
        label_kind: 'note',
        field_id: 'note.staff',
        ai_value: null,
        human_value: 'Call first',
      }),
    ]),
  ];

  it('scores production against the labels and the candidate per split, with the gap between dev and holdout', async () => {
    const traces = new Map<string, CandidateTrace>([
      ['w-dev-1', answered(payload({ arrival: '2027-10-27' }))],
      ['w-dev-2', answered(payload({ departure: '2027-10-28' }))],
      ['w-hold-1', answered(payload({ departure: '2027-10-28' }), 'booking')],
      ['w-test-1', answered(payload())],
    ]);

    const summary = await scoreLabelCases(cases, traces);

    expect(summary.byField['stay.arrival']).toMatchObject({
      n: 1,
      baselinePct: 0,
      candidatePct: 100,
      dropPoints: -100,
    });
    expect(summary.byField['stay.departure']).toMatchObject({
      n: 2,
      baselinePct: 100,
      candidatePct: 100,
      dropPoints: 0,
    });
    expect(summary.byField['note']).toBeUndefined();
    expect(summary.confirmations).toMatchObject({ n: 2, pct: 100 });
    expect(summary.stays).toMatchObject({ n: 3, pct: 100 });
    expect(summary.booked).toMatchObject({ n: 0, pct: null });
    expect(summary.kind).toMatchObject({
      n: 4,
      baselinePct: 100,
      candidatePct: 100,
      dropPoints: 0,
    });
    expect(summary.bySplit.dev).toMatchObject({ n: 2, pct: 100 });
    expect(summary.bySplit.holdout).toMatchObject({ n: 1, pct: 100 });
    expect(summary.bySplit.test).toMatchObject({ n: 0, pct: null });
    expect(summary.gapPoints).toBe(0);
    expect(summary.unanswered).toBe(0);
  });

  it('scores only the last edit of a field, so an earlier value that staff changed again is not gold', async () => {
    const twice = caseOf('w-twice', 'dev', [
      label({ field_id: ARRIVAL, ai_value: '2027-10-26', human_value: '2027-10-27' }),
      label({ field_id: ARRIVAL, ai_value: '2027-10-27', human_value: '2027-10-28' }),
    ]);
    expect(finalLabels(twice.labels).map((row) => row.human_value)).toEqual(['2027-10-28']);

    const kept = await scoreLabelCases(
      [twice],
      new Map([['w-twice', answered(payload({ arrival: '2027-10-28' }))]]),
    );
    expect(kept.stays).toMatchObject({ n: 1, correct: 1, pct: 100 });
    expect(kept.byField['stay.arrival']).toMatchObject({ n: 1, baselinePct: 0, candidatePct: 100 });

    const superseded = await scoreLabelCases(
      [twice],
      new Map([['w-twice', answered(payload({ arrival: '2027-10-27' }))]]),
    );
    expect(superseded.stays).toMatchObject({ n: 1, correct: 0, pct: 0 });
  });

  it('counts a case with no extraction as wrong, so an incomplete run cannot pass', async () => {
    const summary = await scoreLabelCases(
      cases,
      new Map([['w-dev-2', { extraction: null, error: 'timeout' }]]),
    );

    expect(summary.unanswered).toBe(4);
    expect(summary.confirmations.pct).toBe(0);
    expect(evaluateLabelGates(summary).pass).toBe(false);
  });
});

describe('evaluateLabelGates', () => {
  /** A summary that passes every gate, then one change per test. */
  function passing(patch: Partial<LabelSummary> = {}): LabelSummary {
    return {
      cases: 40,
      unanswered: 0,
      byField: {
        'stay.arrival': { n: 12, baselinePct: 60, candidatePct: 60, dropPoints: 0 },
        'row.count': { n: 10, baselinePct: 90, candidatePct: 88, dropPoints: 2 },
      },
      stays: { n: 12, correct: 12, pct: 100 },
      booked: { n: 0, correct: 0, pct: null },
      confirmations: { n: 20, correct: 20, pct: 100 },
      kind: { n: 40, baselinePct: 100, candidatePct: 96, dropPoints: 4 },
      bySplit: {
        dev: { n: 25, correct: 22, pct: 88 },
        holdout: { n: 10, correct: 8, pct: 80 },
        test: { n: 0, correct: 0, pct: null },
      },
      gapPoints: 8,
      ...patch,
    };
  }

  it('passes when every criterion holds, and skips the ones with nothing to score', () => {
    const gates = evaluateLabelGates(passing());
    expect(gates.pass).toBe(true);
    expect(gates.checks.find((check) => check.name === 'booked 100%')?.status).toBe('skipped');
  });

  it('fails a 100% criterion that is one case short', () => {
    const gates = evaluateLabelGates(passing({ confirmations: { n: 20, correct: 19, pct: 95 } }));
    expect(gates.pass).toBe(false);
    expect(gates.checks.find((check) => check.name === 'confirmations 100%')).toMatchObject({
      status: 'fail',
      detail: '19 of 20 (95%)',
    });
  });

  it('fails a field that drops more than 5 points against production, and passes one at exactly 5', () => {
    const drop = (points: number) =>
      evaluateLabelGates(
        passing({
          byField: {
            'row.count': { n: 10, baselinePct: 90, candidatePct: 90 - points, dropPoints: points },
          },
        }),
      );
    expect(drop(LABEL_GATES.maxFieldDropPoints).pass).toBe(true);
    expect(drop(5.01).pass).toBe(false);
  });

  it('judges the kind drop only from 30 cases, and fails it above 10 points', () => {
    const kind = (n: number, dropPoints: number) =>
      evaluateLabelGates(
        passing({ kind: { n, baselinePct: 100, candidatePct: 100 - dropPoints, dropPoints } }),
      );
    expect(kind(29, 25).pass).toBe(true);
    expect(kind(29, 25).checks.find((check) => check.name.startsWith('kind'))?.status).toBe(
      'skipped',
    );
    expect(kind(30, 10).pass).toBe(true);
    expect(kind(30, 10.5).pass).toBe(false);
  });

  it('fails a dev-holdout gap above 10 points, but not a holdout that beats dev', () => {
    expect(evaluateLabelGates(passing({ gapPoints: 10 })).pass).toBe(true);
    expect(evaluateLabelGates(passing({ gapPoints: 11 })).pass).toBe(false);
    expect(evaluateLabelGates(passing({ gapPoints: -15 })).pass).toBe(true);
    expect(
      evaluateLabelGates(passing({ gapPoints: null })).checks.find((check) =>
        check.name.startsWith('dev-holdout'),
      )?.status,
    ).toBe('skipped');
  });

  it('fails when any case has no answer, whatever the scores say', () => {
    const gates = evaluateLabelGates(passing({ unanswered: 1 }));
    expect(gates.pass).toBe(false);
    expect(gates.checks[0]).toMatchObject({ name: 'every case answered', status: 'fail' });
  });
});
