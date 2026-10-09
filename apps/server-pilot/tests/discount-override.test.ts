/**
 * U13 / AE4: a discount override reprices its row. The client Excel and PDF show only the final rate, never the note or the
 * rate code. The totals agree, and the approved revision keeps HMS's price.
 */
import { describe, expect, it } from 'vitest';
import { unzipSync } from 'fflate';
import { syntheticRevision } from './helpers/synthetic-quote-revision';
import { deriveQuoteLines, pricedRoomTotal, rowRatesFor, type RowPrice } from '../src/quote-proposal/quote-lines.js';
import {
  buildStaysProposalPdf,
  renderRevisionProposalHtml,
  type RevisionProposalHeader,
} from '../src/quote-proposal/proposal-pdf.js';
import { quoteWorkbookForRevision, quoteWorkbookForStays } from '../src/quote-proposal/quote-workbook.js';
import {
  priorStaffQuoteRequotePayload,
  quotedTotalWithStoredExtras,
  storedRowPrices,
} from '../src/ai/prior-quote-booking.js';
import { prepareStaffQuote, staffQuoteInput, staffRowPriceInput } from '../src/ai/staff-quote-workflow.js';

const NOTE = "Kamala OK'd – repeat group";
const HEADER: RevisionProposalHeader = {
  attention: 'Ann Guest',
  company: 'Acme Travel',
  clientEmail: 'ann@example.test',
  clientTelephone: '021 000 0000',
  agency: 'Acme Travel',
  signerName: 'Staff Member',
  signerEmail: 'staff@example.test',
};

/** Two rooms for two nights at HMS's R2,400 a night: R9,600 in total. */
async function quoted() {
  const revision = await syntheticRevision(['2400.00', '2400.00']);
  return { revision, groupId: revision.groups[0]!.id };
}

/** AE4: NCOR1B at R1,850 a night, approved with a note. */
const override = (groupId: string): RowPrice => ({
  groupId,
  source: 'override',
  rateCode: 'NCOR1B',
  amountMinor: 185_000,
  note: NOTE,
});

/** Every text part of an .xlsx, so a check sees the sheets and the shared strings. */
function xlsxText(bytes: Uint8Array): string {
  return Object.values(unzipSync(bytes))
    .map((file) => Buffer.from(file).toString('utf8'))
    .join('\n');
}

describe('staff row prices (AE4)', () => {
  it('an override needs a rate code, a per-night rate and a note', () => {
    const complete = {
      groupId: 'g1',
      source: 'override',
      rateCode: 'NCOR1B',
      overrideRate: 185_000,
      note: NOTE,
    } as const;
    expect(staffRowPriceInput.safeParse(complete).success).toBe(true);
    expect(staffRowPriceInput.safeParse({ ...complete, note: '   ' }).success).toBe(false);
    expect(staffRowPriceInput.safeParse({ ...complete, note: undefined }).success).toBe(false);
    expect(staffRowPriceInput.safeParse({ ...complete, rateCode: undefined }).success).toBe(false);
    expect(staffRowPriceInput.safeParse({ ...complete, overrideRate: undefined }).success).toBe(false);
    expect(staffRowPriceInput.safeParse({ ...complete, overrideRate: 0 }).success).toBe(false);
  });

  it('reprices the row, and the approved revision keeps HMS price and identity', async () => {
    const { revision, groupId } = await quoted();
    const approved = structuredClone(revision);

    const lines = deriveQuoteLines(revision, [override(groupId)]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ nights: 2, quantity: 2, rateMinor: 185_000 });
    // Line total = quantity x nights x final rate.
    expect(lines[0]!.totalMinor).toBe(2 * 2 * 185_000);
    expect(pricedRoomTotal(revision, [override(groupId)])).toBe(740_000);

    expect(revision).toEqual(approved);
    expect(revision.totalMinor).toBe(960_000);
    expect(deriveQuoteLines(revision)[0]!.rateMinor).toBe(240_000);
  });

  it('refuses a price for a row that is not on the quote, and a second price for one row', async () => {
    const { revision, groupId } = await quoted();
    expect(() => deriveQuoteLines(revision, [{ ...override(groupId), groupId: 'missing' }])).toThrow('row_price_scope');
    expect(() => deriveQuoteLines(revision, [override(groupId), override(groupId)])).toThrow('row_price_scope');
  });

  it('lists each row as HMS priced it, the rate charged, and the code and note for the internal copy line', async () => {
    const { revision, groupId } = await quoted();
    expect(rowRatesFor(revision, [override(groupId)])).toEqual([
      {
        groupId,
        source: 'override',
        hmsNightlyMinor: [240_000, 240_000],
        nightlyMinor: [185_000, 185_000],
        rateCode: 'NCOR1B',
        note: NOTE,
        hmsComment: `Rate override NCOR1B R1850.00 per night: ${NOTE}`,
      },
    ]);
    expect(rowRatesFor(revision)).toEqual([
      { groupId, source: 'hms', hmsNightlyMinor: [240_000, 240_000], nightlyMinor: [240_000, 240_000] },
    ]);
  });

  it('a one-off rate prices the row and is labelled one-off', async () => {
    const { revision, groupId } = await quoted();
    const oneOff: RowPrice = { groupId, source: 'one_off', amountMinor: 200_000 };
    expect(pricedRoomTotal(revision, [oneOff])).toBe(2 * 2 * 200_000);
    expect(rowRatesFor(revision, [oneOff])[0]).toMatchObject({ source: 'one_off', nightlyMinor: [200_000, 200_000] });
  });

  it('the Excel shows the override rate and never the note or the code', async () => {
    const { revision, groupId } = await quoted();
    const workbook = quoteWorkbookForRevision({ revision, rowPrices: [override(groupId)], header: HEADER });
    expect(workbook.totalMinor).toBe(740_000);
    const text = xlsxText(workbook.bytes);
    expect(text).toContain('1850.00');
    expect(text).not.toContain('NCOR1B');
    expect(text).not.toContain('Kamala');
    expect(text).not.toContain('repeat group');
  });

  it('the PDF HTML shows the override rate and never the note or the code', async () => {
    const { revision, groupId } = await quoted();
    const html = renderRevisionProposalHtml(revision, HEADER, undefined, [override(groupId)]);
    expect(html).toContain('data-proposal-total="740000"');
    expect(html).toMatch(/R1\D?850\.00/);
    expect(html).not.toContain('NCOR1B');
    expect(html).not.toContain('Kamala');
  });

  it('the Excel and the HTML sent to the converter agree on the total and carry no note or code', async () => {
    const { revision, groupId } = await quoted();
    const sent: Blob[] = [];
    const converter = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = init?.body;
      const file = body instanceof FormData ? body.get('files') : null;
      if (!(file instanceof Blob)) throw new Error('no file sent to the converter');
      sent.push(file);
      return new Response(new TextEncoder().encode('%PDF-1.4 proof'), {
        status: 200,
        headers: { 'content-type': 'application/pdf' },
      });
    }) as typeof fetch;
    const stays = [{ revision, rowPrices: [override(groupId)] }];
    const url = 'http://gotenberg.test';

    const excel = await buildStaysProposalPdf(stays, HEADER, { url, fetchImpl: converter, html: false });
    const page = await buildStaysProposalPdf(stays, HEADER, { url, fetchImpl: converter, html: true });

    expect(excel.totalMinor).toBe(740_000);
    expect(page.totalMinor).toBe(740_000);
    expect(xlsxText(new Uint8Array(await sent[0]!.arrayBuffer()))).not.toContain('NCOR1B');
    const html = await sent[1]!.text();
    expect(html).toContain('data-proposal-total="740000"');
    expect(html).not.toContain('NCOR1B');
    expect(html).not.toContain('Kamala');
  });

  it('a combined quote prices each stay with its own rows and totals the stays', async () => {
    const first = await syntheticRevision(['2400.00', '2400.00'], undefined, undefined, undefined, '2026-10-12');
    const second = await syntheticRevision(['2400.00', '2400.00'], undefined, undefined, undefined, '2026-11-01');
    const stays = [{ revision: first, rowPrices: [override(first.groups[0]!.id)] }, { revision: second }];
    const workbook = quoteWorkbookForStays({ stays, header: HEADER });
    expect(workbook.totalMinor).toBe(740_000 + 960_000);
    const text = xlsxText(workbook.bytes);
    expect(text).toContain('1850.00');
    expect(text).toContain('2400.00');
    expect(text).not.toContain('NCOR1B');
    expect(text).not.toContain('Kamala');
  });

  it('a re-quote asks for the same override, and the booking total is the priced total', async () => {
    const { revision, groupId } = await quoted();
    const run = {
      id: 'run-u13',
      transportId: 'transport-x',
      threadId: 'thread-x',
      state: 'succeeded',
      metrics: {
        reservationistResult: { quoteRevisions: [revision], quoteRevisionIds: [revision.id] },
        staffQuoteAttestation: {
          version: 1,
          kind: 'staff_approved_quote',
          transportId: 'transport-x',
          userId: 'user-x',
          threadId: 'thread-x',
          messageId: 'message-x',
          sourceHash: 'a'.repeat(64),
          selectionEpoch: 1,
          inputRevision: 1,
          inputDigest: 'b'.repeat(64),
          authorizationId: 'staff-quote:x',
          revisionIds: [revision.id],
          header: { company: 'Acme Travel', agency: 'Acme Travel' },
          rowPrices: [override(groupId)],
        },
      },
    };
    expect(priorStaffQuoteRequotePayload(run, revision.id)?.rowPrices).toEqual([
      { groupId, source: 'override', rateCode: 'NCOR1B', overrideRate: 185_000, note: NOTE },
    ]);
    expect(quotedTotalWithStoredExtras(revision, run)).toBe(740_000);
    // A stored price belongs to its own revision only.
    expect(storedRowPrices(run, 'quote:other')).toEqual([]);
    const unpriced = { ...run, metrics: { reservationistResult: run.metrics.reservationistResult } };
    expect(quotedTotalWithStoredExtras(revision, unpriced)).toBe(960_000);
  });

  it('a saved rate never reaches the HMS request, and the approval binds the prices', () => {
    const base = {
      messageId: 'message-x',
      sourceHash: 'a'.repeat(64),
      selectionEpoch: 3,
      inputRevision: 2,
      groups: [
        {
          id: 'single',
          arrivalDate: '2026-10-12',
          departureDate: '2026-10-14',
          quantity: 2,
          adults: 1,
          childrenAges: [],
          board: 'room_only',
          roomCodes: ['SKNG'],
        },
      ],
    };
    const scope = {
      transportId: 'transport',
      userId: 'staff',
      threadId: 'thread',
      messageId: 'message-x',
      sourceHash: 'a'.repeat(64),
      propertyCode: 'HRCEN',
      messageAt: '2026-09-30T12:00:00Z',
      messageText: 'Quote please',
    };
    const signer = { signerName: 'Staff', signerEmail: 'staff@example.test' };
    const savedId = '9b1d2c3e-4f5a-4b6c-8d7e-0f1a2b3c4d5e';
    const plain = prepareStaffQuote(staffQuoteInput.parse(base), scope, signer, new AbortController().signal);
    const saved = prepareStaffQuote(
      staffQuoteInput.parse({ ...base, rowPrices: [{ groupId: 'single', source: 'saved', customRateId: savedId }] }),
      scope,
      signer,
      new AbortController().signal,
    );
    const request = JSON.stringify(saved.request);
    expect(request).not.toContain('rateCodes');
    expect(request).not.toContain(savedId);
    expect(saved.inputDigest).not.toBe(plain.inputDigest);
  });
});
