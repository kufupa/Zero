import { describe, expect, it } from 'vitest';
import { extractInboundMail } from '../src/ai/extraction/extract.js';
import { anchorStayDateRange, receivedDateAtHotel } from '../src/ai/stay-date-anchoring.js';
import { AE1_OUTPUT, fakeModel, selectionFor } from './fixtures/inbound-extraction.js';

async function extractRequestedDates(input: {
  bodyText: string;
  receivedAt: string;
  arrival: string;
  departure: string;
  subject?: string;
}) {
  const selection = {
    ...selectionFor(input.bodyText, input.subject),
    receivedAt: input.receivedAt,
  };
  const model = fakeModel(() => ({
    ...AE1_OUTPUT,
    stays: [
      {
        ...AE1_OUTPUT.stays[0]!,
        requested: { arrival: input.arrival, departure: input.departure },
        requestedDateEvidence: input.bodyText,
      },
    ],
  }));
  const result = await extractInboundMail({
    adapter: model.adapter,
    selection,
    messageId: 'msg-date-anchor-test',
  });
  if (!result.ok) throw new Error(`extraction failed: ${result.reason}`);
  return { requested: result.payload.stays[0]?.requested, prompt: model.calls[0]?.userPrompt ?? '' };
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

  it('keeps the explicit trip year when it differs from the receipt-based occurrence', async () => {
    const dateYear = await extractRequestedDates({
      bodyText: 'Please quote 12-14 March 2026.',
      receivedAt: '2026-12-20T12:00:00.000Z',
      arrival: '2027-03-12',
      departure: '2027-03-15',
    });
    const subjectYear = await extractRequestedDates({
      bodyText: 'Please quote 12-14 March.',
      subject: 'Tour 2027 dates',
      receivedAt: '2026-04-01T12:00:00.000Z',
      arrival: '2026-03-12',
      departure: '2026-03-15',
    });

    expect(dateYear.requested).toEqual({ arrival: '2026-03-12', departure: '2026-03-15' });
    expect(subjectYear.requested).toEqual({ arrival: '2027-03-12', departure: '2027-03-15' });
  });

  it('honors a trip year stated in the preceding thread', () => {
    expect(
      anchorStayDateRange(
        { arrival: '2026-03-12', departure: '2026-03-15' },
        {
          receivedAt: '2026-01-01T12:00:00.000Z',
          sourceText: 'Subject: Quote\nPlease quote 12-14 March.\nOur trip is planned for 2027.',
        },
      ),
    ).toEqual({ arrival: '2027-03-12', departure: '2027-03-15' });
  });

  it('uses Johannesburg local date when received timestamp crosses UTC new year', () => {
    expect(receivedDateAtHotel('2026-12-31T22:30:00.000Z')).toBe('2027-01-01');
  });
});
