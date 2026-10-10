import {
  completedDateOptions,
  formatStayRange,
  multiOptionDraftHtml,
  multiOptionSignature,
  requireMultiOptionDraft,
} from '../lib/quote-workflow/multi-option-draft';
import type {
  QuoteOffer,
  QuotePdf,
  QuoteSession,
  StaffQuoteAllocation,
  StayGroupRequirement,
} from '../lib/quote-workflow/types';
import { initialQuoteSession, reduceQuoteSession } from '../lib/quote-workflow/session';
import { describe, expect, it } from 'vitest';

const BINDING = {
  transportId: 't1',
  mailboxEmail: 'centurion@legacyhotels.co.za',
  storeId: 'store',
  folderEntryId: 'inbox',
  entryId: 'e1',
  selectionEpoch: 1,
  scopeEpoch: 1,
};
const SOURCE_HASH = 'ab'.repeat(32);
const NOV = { key: '2027-11-12:2027-11-14', arrival: '2027-11-12', departure: '2027-11-14' };
const DEC = { key: '2027-12-01:2027-12-03', arrival: '2027-12-01', departure: '2027-12-03' };

function stayGroup(id: string, arrivalDate: string, departureDate: string): StayGroupRequirement {
  return {
    id,
    arrivalDate,
    departureDate,
    quantity: 1,
    roomPreference: 'standard king',
    adults: 1,
    childrenAges: [],
    board: 'bb',
    specialRequests: [],
    fields: { arrivalDate: 'extracted', departureDate: 'extracted', adults: 'extracted' },
  };
}

function allocation(
  revisionRef: string,
  quoteRequestKey: string,
  totalMinor: number,
  roomLabel = 'Standard King',
): QuoteOffer {
  return {
    id: revisionRef,
    kind: 'allocation',
    roomCode: '',
    roomLabel,
    board: 'bb',
    rateCode: '',
    currency: 'ZAR',
    nightly: [],
    stayTotalMinor: totalMinor,
    observedAt: '',
    sourceRef: revisionRef,
    restrictions: [],
    combinable: true,
    quoteRequestKey,
    coversGroupIds: [quoteRequestKey === NOV.key ? 'stay-a' : 'stay-b'],
    quantity: 1,
    adults: 1,
  };
}

function staffRun(
  session: QuoteSession,
  revisionRef: string,
  quoteRequestKey: string,
  totalMinor: number,
): StaffQuoteAllocation {
  return {
    workflowRunId: `run-${revisionRef}`,
    revisionRef,
    factRefs: [],
    messageId: 'mail-1',
    threadId: 'thread-1',
    sourceHash: SOURCE_HASH,
    selectionEpoch: 1,
    inputRevision: session.inputRevision,
    inputDigest: `digest-${revisionRef}`,
    totalMinor,
    currency: 'ZAR',
    quoteRequestKey,
    approvedHeader: {
      salesStrategy: 'BAR',
      company: '',
      agency: '',
      attention: '',
      clientEmail: '',
      clientTelephone: '',
    },
  };
}

function pdfFor(revisionRef: string, totalMinor: number, hash: string, fileName: string): QuotePdf {
  return {
    fileName,
    bytesBase64: Buffer.from(`%PDF-1.4 ${revisionRef}`).toString('base64'),
    pdfHash: hash,
    revisionId: revisionRef,
    totalMinor,
  };
}

/** Records one stay's staff run the way the pane does. The stays share one combined PDF, made after they are rated. */
function quoteOption(
  session: QuoteSession,
  option: { revisionRef: string; key: string; totalMinor: number; roomLabel?: string },
): QuoteSession {
  const offer = allocation(option.revisionRef, option.key, option.totalMinor, option.roomLabel);
  return reduceQuoteSession(session, {
    type: 'staff_quote_ready',
    offer,
    staffQuote: staffRun(session, option.revisionRef, option.key, option.totalMinor),
    selectionEpoch: 1,
    inputRevision: session.inputRevision,
  });
}

/** The one combined PDF for every stay: its revision names the set of stays and its total is their sum. */
function combinedPdf(totalMinor: number): QuotePdf {
  return pdfFor('quotes:both', totalMinor, 'cd'.repeat(32), 'Quote - Standard King.pdf');
}

function withCombinedPdf(session: QuoteSession, pdf: QuotePdf): QuoteSession {
  return reduceQuoteSession(session, {
    type: 'pdf_ready',
    pdf,
    selectionEpoch: 1,
    inputRevision: session.inputRevision,
    // The pane names the stays' runs the combined PDF was built from.
    selectedOfferIds: Object.values(session.staffQuotes).map((quote) => quote.revisionRef),
  });
}

function stayedSession(): QuoteSession {
  let session = reduceQuoteSession(initialQuoteSession(), { type: 'selection', binding: BINDING });
  session = reduceQuoteSession(session, {
    type: 'analysis_ready',
    analysis: {
      intent: 'quote',
      groups: [
        stayGroup('stay-a', NOV.arrival, NOV.departure),
        stayGroup('stay-b', DEC.arrival, DEC.departure),
      ],
      secondaryAsks: [],
      alternatives: [],
    },
  });
  return reduceQuoteSession(session, {
    type: 'staff_source_ready',
    source: { messageId: 'mail-1', threadId: 'thread-1', sourceHash: SOURCE_HASH },
  });
}

/** Two stays: A (12–14 Nov 2027) and B (1–3 Dec 2027), both rated and covered by one combined PDF. */
function twoQuotedOptions(): QuoteSession {
  let session = quoteOption(stayedSession(), { revisionRef: 'rev-a', key: NOV.key, totalMinor: 272000 });
  session = quoteOption(session, { revisionRef: 'rev-b', key: DEC.key, totalMinor: 136000 });
  return withCombinedPdf(session, combinedPdf(408000));
}

describe('one reply for every stay of a multi-stay quote', () => {
  it('lists every stay with its own current run, in email date order', () => {
    const options = completedDateOptions(twoQuotedOptions());
    expect(options.map((option) => option.letter)).toEqual(['A', 'B']);
    expect(options.map((option) => option.quote.revisionRef)).toEqual(['rev-a', 'rev-b']);
  });

  it('writes one body with a heading, a table and a total for each stay', () => {
    const html = multiOptionDraftHtml(completedDateOptions(twoQuotedOptions()));
    expect(html).toContain('Option A: 12–14 Nov 2027');
    expect(html).toContain('Option B: 1–3 Dec 2027');
    expect(html.match(/<table/g)).toHaveLength(2);
    expect(html).toContain('<th align="left">DATE</th>');
    expect(html).toContain('<td>12 Nov 2027 to 14 Nov 2027</td>');
    expect(html).toContain('<td>Standard King · Bed &amp; breakfast</td>');
    expect(html).toMatch(/Option A total: R2\D*720\.00/);
    expect(html).toMatch(/Option B total: R1\D*360\.00/);
    expect(html).toMatch(/Total for all options: R4\D*080\.00/);
    expect(html.indexOf('Option A:')).toBeLessThan(html.indexOf('Option B:'));
    expect(html).toContain('quotes only and are not bookings');
  });

  it('uses the staff-edited combined reply while the stays are unchanged, and the generated body otherwise', () => {
    const session = twoQuotedOptions();
    const generated = requireMultiOptionDraft(session)?.html ?? '';
    const edited = '<p>Rates are per room per night, breakfast included.</p>';
    const signature = multiOptionSignature(session) ?? '';
    expect(requireMultiOptionDraft(session, { signature, html: edited })?.html).toBe(edited);
    // An edit made for another set of stays is never sent.
    expect(requireMultiOptionDraft(session, { signature: 'stale', html: edited })?.html).toBe(generated);
    expect(requireMultiOptionDraft(session, null)?.html).toBe(generated);
  });

  it('carries the staff note into the combined reply once, and an edit made before a note change is not used', () => {
    const base = twoQuotedOptions();
    const session = { ...base, staffHeader: { ...base.staffHeader, notes: 'Breakfast only <day 2>' } };
    const note = '<p><strong>Note:</strong> Breakfast only &lt;day 2&gt;</p>';
    expect(requireMultiOptionDraft(session)?.html.endsWith(note)).toBe(true);
    // An edited combined reply that already has the note is not given a second one.
    const edited = `<p>Edited rates.</p>${note}`;
    const signature = multiOptionSignature(session) ?? '';
    expect(requireMultiOptionDraft(session, { signature, html: edited })?.html).toBe(edited);
    // Changing the note makes the earlier edit stale.
    const changed = { ...session, staffHeader: { ...session.staffHeader, notes: 'Late check-in' } };
    expect(requireMultiOptionDraft(changed, { signature, html: edited })?.html).not.toBe(edited);
  });

  it('offers no combined reply while an amount is unreadable, even with a PDF made earlier', () => {
    const base = twoQuotedOptions();
    const errored = { ...base, staffHeader: { ...base.staffHeader, fieldErrors: { dinnerAllowance: 'Enter an amount in rand, like 450 or 1,250.50' } } };
    expect(requireMultiOptionDraft(base)).not.toBeNull();
    expect(requireMultiOptionDraft(errored)).toBeNull();
  });

  it('attaches the one combined PDF unchanged, and the stays are named in the body', () => {
    const draft = requireMultiOptionDraft(twoQuotedOptions());
    expect(draft?.letters).toEqual(['A', 'B']);
    expect(draft?.attachments).toEqual([
      {
        fileName: 'Quote - Standard King.pdf',
        pdfBase64: Buffer.from('%PDF-1.4 quotes:both').toString('base64'),
      },
    ]);
  });

  it('needs every stay rated before there is a reply', () => {
    let session = quoteOption(stayedSession(), { revisionRef: 'rev-a', key: NOV.key, totalMinor: 272000 });
    expect(completedDateOptions(session)).toHaveLength(1);
    expect(requireMultiOptionDraft(session)).toBeNull();
    session = quoteOption(session, { revisionRef: 'rev-b', key: DEC.key, totalMinor: 136000 });
    // Rated, but the combined PDF was made before stay B: no reply until it is made again.
    expect(requireMultiOptionDraft(session)).toBeNull();
    expect(requireMultiOptionDraft(withCombinedPdf(session, combinedPdf(408000)))).not.toBeNull();
  });

  it('refuses a PDF made for one stay, or for a different total', () => {
    const session = twoQuotedOptions();
    expect(requireMultiOptionDraft(withCombinedPdf(session, pdfFor('rev-a', 272000, 'cd'.repeat(32), 'Quote.pdf')))).toBeNull();
    expect(requireMultiOptionDraft(withCombinedPdf(session, combinedPdf(1)))).toBeNull();
  });

  it('refuses fixture evidence and the fixture PDF name', () => {
    const session = twoQuotedOptions();
    expect(
      requireMultiOptionDraft({
        ...session,
        evidence: { kind: 'fixture', selectionEpoch: 1, inputRevision: session.inputRevision },
      }),
    ).toBeNull();
    expect(requireMultiOptionDraft(session)).not.toBeNull();
    const fixtureNamed = { ...session, pdf: { ...combinedPdf(408000), fileName: 'Quote-fixture-not-live-hms.pdf' } };
    expect(requireMultiOptionDraft(fixtureNamed)).toBeNull();
  });

  it('re-quoting one stay keeps the other stay run, and the combined PDF is made again', () => {
    const session = twoQuotedOptions();
    const requoted = quoteOption(session, { revisionRef: 'rev-b2', key: DEC.key, totalMinor: 150000 });
    expect(requoted.staffQuotes[NOV.key]?.revisionRef).toBe('rev-a');
    expect(requoted.pdf).toBeNull();
    expect(requireMultiOptionDraft(requoted)).toBeNull();
    const again = withCombinedPdf(requoted, combinedPdf(422000));
    const draft = requireMultiOptionDraft(again);
    expect(draft).not.toBeNull();
    expect(multiOptionDraftHtml(completedDateOptions(again))).toContain('Option A:');
  });

  it('escapes allocation text inside the table', () => {
    const session = quoteOption(twoQuotedOptions(), {
      revisionRef: 'rev-c',
      key: NOV.key,
      totalMinor: 1000,
      roomLabel: '<b>Suite</b> & co',
    });
    const html = multiOptionDraftHtml(completedDateOptions(session));
    expect(html).not.toContain('<b>Suite');
    expect(html).toContain('&lt;b&gt;Suite&lt;/b&gt; &amp; co');
  });

  it('formats stay ranges within a month, across months and across years', () => {
    expect(formatStayRange('2027-11-12', '2027-11-14')).toBe('12–14 Nov 2027');
    expect(formatStayRange('2027-11-28', '2027-12-02')).toBe('28 Nov – 2 Dec 2027');
    expect(formatStayRange('2027-12-30', '2028-01-02')).toBe('30 Dec 2027 – 2 Jan 2028');
    expect(formatStayRange('unknown', '2027-11-14')).toBe('unknown to 2027-11-14');
  });
});
