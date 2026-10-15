import { describe, expect, it } from 'vitest';
import { extractInboundMail } from '../src/ai/extraction/extract.js';
import type { MailKind } from '../src/ai/extraction/schema.js';
import { anchorStayDateRange, receivedDateAtHotel } from '../src/ai/stay-date-anchoring.js';
import { buildPreparedStaffQuotePlan } from '../src/ai/quote-ready.js';
import { AE1_OUTPUT, fakeModel, selectionFor } from './fixtures/inbound-extraction.js';

async function extractRequestedDates(input: {
  bodyText: string;
  receivedAt: string;
  arrival: string;
  departure: string | null;
  subject?: string;
  dateEvidence?: string | null;
  kind?: MailKind;
  preceding?: Array<{ bodyText: string }>;
}) {
  const baseSelection = selectionFor(input.bodyText, input.subject);
  const selection = {
    ...baseSelection,
    receivedAt: input.receivedAt,
    preceding: input.preceding ?? baseSelection.preceding,
  };
  const model = fakeModel(() => ({
    ...AE1_OUTPUT,
    kind: input.kind ?? AE1_OUTPUT.kind,
    stays: [
      {
        ...AE1_OUTPUT.stays[0]!,
        requested: { arrival: input.arrival, departure: input.departure },
        requestedDateEvidence: input.dateEvidence === undefined ? input.bodyText : input.dateEvidence,
      },
    ],
  }));
  const result = await extractInboundMail({
    adapter: model.adapter,
    selection,
    messageId: 'msg-date-anchor-test',
  });
  if (!result.ok) throw new Error(`extraction failed: ${result.reason}`);
  const requested = result.payload.stays[0]?.requested;
  if (!requested) throw new Error('extraction returned no stay');
  return { requested, prompt: model.calls[0]?.userPrompt ?? '', payload: result.payload };
}

async function extractRequestedDateSets(input: {
  bodyText: string;
  receivedAt: string;
  stays: Array<{ arrival: string; departure: string; dateEvidence: string }>;
}) {
  const selection = { ...selectionFor(input.bodyText), receivedAt: input.receivedAt };
  const model = fakeModel(() => ({
    ...AE1_OUTPUT,
    stays: input.stays.map((stay) => ({
      ...AE1_OUTPUT.stays[0]!,
      requested: { arrival: stay.arrival, departure: stay.departure },
      requestedDateEvidence: stay.dateEvidence,
    })),
  }));
  const result = await extractInboundMail({
    adapter: model.adapter,
    selection,
    messageId: 'msg-date-anchor-multiple-test',
  });
  if (!result.ok) throw new Error(`extraction failed: ${result.reason}`);
  return result.payload.stays.map(({ requested }) => requested);
}

describe('received-time date anchoring', () => {
  it.each([
    {
      name: 'ignores a year from a previous visit',
      bodyText: 'Previous visit was in 2025. Please quote 12–14 March.',
      dateEvidence: '12–14 March',
      kind: 'quote' as const,
      arrival: '2026-03-12',
      departure: '2026-03-15',
      expected: { arrival: '2027-03-12', departure: '2027-03-15' },
    },
    {
      name: 'keeps a year attached to this stay',
      bodyText: 'Please quote 12–14 March 2026.',
      dateEvidence: '12–14 March 2026',
      kind: 'quote' as const,
      arrival: '2026-03-12',
      departure: '2026-03-15',
      expected: { arrival: '2026-03-12', departure: '2026-03-15' },
    },
    {
      name: 'recognizes the stay year despite an unrelated year in the body',
      bodyText: 'Previous visit was in 2025. Please quote 12–14 March 2026.',
      dateEvidence: null,
      kind: 'quote' as const,
      arrival: '2026-03-12',
      departure: '2026-03-15',
      expected: { arrival: '2026-03-12', departure: '2026-03-15' },
    },
  ])('counts a year only when it belongs to this stay: $name', async (scenario) => {
    const result = await extractRequestedDates({
      bodyText: scenario.bodyText,
      dateEvidence: scenario.dateEvidence,
      kind: scenario.kind,
      receivedAt: '2026-12-20T12:00:00.000Z',
      arrival: scenario.arrival,
      departure: scenario.departure,
    });

    expect(result.requested).toEqual(scenario.expected);
  });

  it.each([
    {
      name: 'older message contains next Friday',
      bodyText: 'Please confirm the dates from our earlier email.',
      preceding: [{ bodyText: 'Please quote next Friday for two nights.' }],
      dateEvidence: 'next Friday for two nights',
      receivedAt: '2026-12-25T12:00:00.000Z',
      arrival: '2026-12-25',
      departure: '2026-12-27',
      expected: { arrival: '2026-12-25', departure: '2026-12-27' },
    },
    {
      name: 'older yearless dates do not use the selected email receipt',
      bodyText: 'Please confirm the dates from my earlier request.',
      preceding: [{ bodyText: 'Please quote 12–14 March.' }],
      dateEvidence: '12–14 March',
      receivedAt: '2026-12-20T12:00:00.000Z',
      arrival: '2026-03-12',
      departure: '2026-03-15',
      expected: { arrival: '2026-03-12', departure: '2026-03-15' },
    },
  ])('does not re-anchor an unattributed older-message phrase: $name', async (scenario) => {
    const result = await extractRequestedDates(scenario);

    expect(result.requested).toEqual(scenario.expected);
  });

  it.each([
    {
      name: 'existing booking extension stays in its extracted year',
      kind: 'amendment' as const,
      bodyText: 'Please extend the existing booking from 12–15 March to 12–17 March.',
      dateEvidence: '12–17 March',
      receivedAt: '2026-03-14T12:00:00.000Z',
      arrival: '2026-03-12',
      departure: '2026-03-18',
      expected: { arrival: '2026-03-12', departure: '2026-03-18' },
    },
    {
      name: 'new quote request still rolls forward',
      kind: 'quote' as const,
      bodyText: 'Please quote 12–17 March.',
      dateEvidence: '12–17 March',
      receivedAt: '2026-03-14T12:00:00.000Z',
      arrival: '2026-03-12',
      departure: '2026-03-18',
      expected: { arrival: '2027-03-12', departure: '2027-03-18' },
    },
  ])('applies yearless rollover only to a new stay: $name', async (scenario) => {
    const result = await extractRequestedDates(scenario);

    expect(result.requested).toEqual(scenario.expected);
  });

  it('reproduces a yearless March stay accepted in the past after a December email', async () => {
    const result = await extractRequestedDates({
      bodyText: 'Please quote 12-14 March.',
      receivedAt: '2026-12-20T12:00:00.000Z',
      arrival: '2026-03-12',
      departure: '2026-03-15',
    });

    expect(result.prompt).toContain('Received at (Johannesburg local date): 2026-12-20');
    expect(result.requested).toEqual({ arrival: '2027-03-12', departure: '2027-03-15' });
  });

  it('rolls a yearless numeric day/month phrase forward from receipt time', async () => {
    const result = await extractRequestedDates({
      bodyText: 'Please quote 12/03 to 15/03.',
      receivedAt: '2026-12-20T12:00:00.000Z',
      arrival: '2026-03-12',
      departure: '2026-03-15',
    });

    expect(result.requested).toEqual({ arrival: '2027-03-12', departure: '2027-03-15' });
  });

  it('carries a yearless January stay over the December year boundary', async () => {
    const result = await extractRequestedDates({
      bodyText: 'Please quote 4-6 January.',
      receivedAt: '2026-12-20T12:00:00.000Z',
      arrival: '2026-01-04',
      departure: '2026-01-07',
    });

    expect(result.requested).toEqual({ arrival: '2027-01-04', departure: '2027-01-07' });
  });

  it('resolves next Friday from received date, not model year', async () => {
    const result = await extractRequestedDates({
      bodyText: 'Please quote for next Friday.',
      receivedAt: '2026-12-18T12:00:00.000Z',
      arrival: '2026-12-11',
      departure: '2026-12-14',
    });

    expect(result.requested).toEqual({ arrival: '2026-12-25', departure: '2026-12-28' });
  });

  it('anchors multiple extracted stays from their own source phrases', async () => {
    const requested = await extractRequestedDateSets({
      bodyText: 'Please quote next Friday for two nights, and 4–6 January.',
      receivedAt: '2026-12-18T12:00:00.000Z',
      stays: [
        { arrival: '2026-12-11', departure: '2026-12-13', dateEvidence: 'next Friday for two nights' },
        { arrival: '2026-01-04', departure: '2026-01-07', dateEvidence: '4–6 January' },
      ],
    });

    expect(requested).toEqual([
      { arrival: '2026-12-25', departure: '2026-12-27' },
      { arrival: '2027-01-04', departure: '2027-01-07' },
    ]);
  });

  it('keeps model dates when the stay evidence or single-stay subject has a year', async () => {
    const dateYear = await extractRequestedDates({
      bodyText: 'Please quote 12-14 March 2026.',
      receivedAt: '2026-12-20T12:00:00.000Z',
      arrival: '2026-03-12',
      departure: '2026-03-15',
    });
    const subjectYear = await extractRequestedDates({
      bodyText: 'Please quote 12-14 March.',
      subject: 'March 2028',
      receivedAt: '2026-12-20T12:00:00.000Z',
      arrival: '2028-03-12',
      departure: '2028-03-15',
    });
    const pastSubjectYear = await extractRequestedDates({
      bodyText: 'Please quote 12-14 March.',
      subject: 'March 2028',
      receivedAt: '2028-12-20T12:00:00.000Z',
      arrival: '2028-03-12',
      departure: '2028-03-15',
    });

    expect(dateYear.requested).toEqual({ arrival: '2026-03-12', departure: '2026-03-15' });
    expect(subjectYear.requested).toEqual({ arrival: '2028-03-12', departure: '2028-03-15' });
    expect(pastSubjectYear.requested).toEqual({ arrival: '2028-03-12', departure: '2028-03-15' });
  });

  it('uses a relative weekday only from this stay’s date evidence', () => {
    expect(
      anchorStayDateRange(
        { arrival: '2026-12-11', departure: '2026-12-13' },
        {
          receivedAt: '2026-12-18T12:00:00.000Z',
          sourceText: 'next Friday for two nights',
        },
      ),
    ).toEqual({ arrival: '2026-12-25', departure: '2026-12-27' });
  });

  it('uses Johannesburg local date when received timestamp crosses UTC new year', () => {
    expect(receivedDateAtHotel('2026-12-31T22:30:00.000Z')).toBe('2027-01-01');
  });

  const greptileDateScenarios: Array<{
    name: string;
    run: () => unknown | Promise<unknown>;
    expected: unknown;
  }> = [
    {
      name: 'explicit ISO year wins over yearless rollover',
      run: async () =>
        (await extractRequestedDates({
          bodyText: 'Please quote 2028-03-12 to 2028-03-15.',
          receivedAt: '2026-12-20T12:00:00.000Z',
          arrival: '2028-03-12',
          departure: '2028-03-15',
        })).requested,
      expected: { arrival: '2028-03-12', departure: '2028-03-15' },
    },
    {
      name: 'relative evidence is scoped to its matching stay',
      run: () =>
        extractRequestedDateSets({
          bodyText: 'Please quote next Friday for two nights, and 4–6 January.',
          receivedAt: '2026-12-18T12:00:00.000Z',
          stays: [
            { arrival: '2026-12-11', departure: '2026-12-13', dateEvidence: 'next Friday for two nights' },
            { arrival: '2026-01-04', departure: '2026-01-07', dateEvidence: '4–6 January' },
          ],
        }),
      expected: [
        { arrival: '2026-12-25', departure: '2026-12-27' },
        { arrival: '2027-01-04', departure: '2027-01-07' },
      ],
    },
    {
      name: 'staff correction outranks a conflicting email year',
      run: () =>
        anchorStayDateRange(
          { arrival: '2028-03-12', departure: '2028-03-15' },
          {
            receivedAt: '2026-12-20T12:00:00.000Z',
            sourceText: '12–14 March 2027',
            staffNote: 'Use 12–14 March 2028 instead.',
          },
        ),
      expected: { arrival: '2028-03-12', departure: '2028-03-15' },
    },
    {
      name: 'single-stay subject year wins even when it is past',
      run: async () =>
        (await extractRequestedDates({
          bodyText: 'Please quote 12–14 March.',
          subject: 'March 2028',
          receivedAt: '2028-12-20T12:00:00.000Z',
          arrival: '2028-03-12',
          departure: '2028-03-15',
        })).requested,
      expected: { arrival: '2028-03-12', departure: '2028-03-15' },
    },
    {
      name: 'yearless numeric day-month dates roll from received date',
      run: async () =>
        (await extractRequestedDates({
          bodyText: 'Please quote 12/03 to 15/03.',
          receivedAt: '2026-12-20T12:00:00.000Z',
          arrival: '2026-03-12',
          departure: '2026-03-15',
        })).requested,
      expected: { arrival: '2027-03-12', departure: '2027-03-15' },
    },
    {
      name: 'staff correction affects only its attributed stay',
      run: () => [
        anchorStayDateRange(
          { arrival: '2026-12-11', departure: '2026-12-13' },
          { receivedAt: '2026-12-18T12:00:00.000Z', sourceText: 'next Friday for two nights' },
        ),
        anchorStayDateRange(
          { arrival: '2026-01-04', departure: '2026-01-07' },
          {
            receivedAt: '2026-12-18T12:00:00.000Z',
            sourceText: '4–6 January',
            staffNote: 'Keep 4–6 January for the second stay.',
          },
        ),
      ],
      expected: [
        { arrival: '2026-12-25', departure: '2026-12-27' },
        { arrival: '2026-01-04', departure: '2026-01-07' },
      ],
    },
    {
      name: 'another stay’s explicit year does not leak',
      run: () =>
        extractRequestedDateSets({
          bodyText: 'Stay one: 12–14 March. Stay two: 12–14 March 2028.',
          receivedAt: '2026-12-20T12:00:00.000Z',
          stays: [
            { arrival: '2026-03-12', departure: '2026-03-15', dateEvidence: '12–14 March' },
            { arrival: '2028-03-12', departure: '2028-03-15', dateEvidence: '12–14 March 2028' },
          ],
        }),
      expected: [
        { arrival: '2027-03-12', departure: '2027-03-15' },
        { arrival: '2028-03-12', departure: '2028-03-15' },
      ],
    },
    {
      name: 'verified next Friday overrides a future model range',
      run: async () =>
        (await extractRequestedDates({
          bodyText: 'Please quote next Friday for two nights.',
          receivedAt: '2026-12-18T12:00:00.000Z',
          arrival: '2027-01-01',
          departure: '2027-01-03',
        })).requested,
      expected: { arrival: '2026-12-25', departure: '2026-12-27' },
    },
    {
      name: 'null or mismatched evidence preserves an explicit body year and flags it past',
      run: async () =>
        Promise.all(
          ([null, 'March dates'] as const).map(async (dateEvidence) => {
            const extracted = await extractRequestedDates({
              bodyText: 'Please quote 12–14 March 2026.',
              receivedAt: '2026-12-20T12:00:00.000Z',
              arrival: '2026-03-12',
              departure: '2026-03-15',
              dateEvidence,
            });
            const plan = buildPreparedStaffQuotePlan({
              messageId: 'msg-date-year-check',
              sourceHash: 'a'.repeat(64),
              payload: extracted.payload,
              now: new Date('2026-12-20T12:00:00.000Z'),
            });
            return { requested: extracted.requested, reason: plan.stays[0]?.reason };
          }),
        ),
      expected: [
        { requested: { arrival: '2026-03-12', departure: '2026-03-15' }, reason: 'past_dates' },
        { requested: { arrival: '2026-03-12', departure: '2026-03-15' }, reason: 'past_dates' },
      ],
    },
    {
      name: 'mixed December-January range uses the explicit departure year',
      run: async () =>
        (await extractRequestedDates({
          bodyText: 'Please quote 28 Dec - 2 Jan 2027.',
          receivedAt: '2026-10-14T08:00:00.000Z',
          arrival: '2027-12-28',
          departure: '2028-01-03',
        })).requested,
      expected: { arrival: '2026-12-28', departure: '2027-01-03' },
    },
    {
      name: 'arrival-only yearless date rolls forward from receipt',
      run: async () =>
        (await extractRequestedDates({
          bodyText: 'Is a room available on 12 March?',
          receivedAt: '2026-12-20T12:00:00.000Z',
          arrival: '2026-03-12',
          departure: null,
        })).requested,
      expected: { arrival: '2027-03-12', departure: null },
    },
    {
      name: 'yearless date overrides a farther-future model year',
      run: async () =>
        (await extractRequestedDates({
          bodyText: 'Please quote 12-14 March.',
          receivedAt: '2026-12-20T12:00:00.000Z',
          arrival: '2028-03-12',
          departure: '2028-03-15',
        })).requested,
      expected: { arrival: '2027-03-12', departure: '2027-03-15' },
    },
    {
      name: 'occupancy range in a staff note is not a date correction',
      run: () =>
        anchorStayDateRange(
          { arrival: '2026-03-12', departure: '2026-03-15' },
          {
            receivedAt: '2026-12-20T12:00:00.000Z',
            sourceText: '12-14 March',
            staffNote: '2-3 adults requested.',
          },
        ),
      expected: { arrival: '2027-03-12', departure: '2027-03-15' },
    },
    {
      name: 'next year means the year after receipt, even when current-year dates are future',
      run: async () =>
        (await extractRequestedDates({
          bodyText: 'Please quote 12-14 March next year.',
          receivedAt: '2026-03-01T12:00:00.000Z',
          arrival: '2026-03-12',
          departure: '2026-03-15',
        })).requested,
      expected: { arrival: '2027-03-12', departure: '2027-03-15' },
    },
    {
      name: 'reversed requested dates are carried to the pane warning field',
      run: async () => {
        const result = await extractRequestedDates({
          bodyText: 'Please quote 12-14 March.',
          receivedAt: '2026-12-20T12:00:00.000Z',
          arrival: '2027-03-15',
          departure: '2027-03-12',
        });
        return {
          requested: result.requested,
          hasDateWarning: result.payload.missing.some((item) => item.field === 'stayDates'),
        };
      },
      expected: { requested: { arrival: '2027-03-15', departure: null }, hasDateWarning: true },
    },
  ];

  it.each(greptileDateScenarios)('Greptile scenario: $name', async ({ run, expected }) => {
    expect(await run()).toEqual(expected);
  });
});
