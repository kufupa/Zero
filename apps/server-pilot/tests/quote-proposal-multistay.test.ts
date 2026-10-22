import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { unzipSync } from 'fflate';
import type { AuthorizedProposalFacts } from '../src/quote-proposal/quote-lines.js';
import type { QuoteRevision } from '../src/quote-proposal/quote-revision.js';
import {
  buildStaysProposalPdf,
  documentIdFor,
  ProposalPdfUnavailableError,
  quoteProposalPdfUsesHtml,
} from '../src/quote-proposal/proposal-pdf.js';
import {
  MixedPropertyQuoteError,
  quoteWorkbookForStays,
  workbookLinesForStays,
  WorkbookLineLimitError,
  WorkbookRefusalError,
  type WorkbookStay,
} from '../src/quote-proposal/quote-workbook.js';
import { approvedStaySpan, combinedStayCurrencyProblem } from '../src/ai/staff-quote-workflow.js';
import { quoteDigest } from '../src/quote-proposal/quote-revision.js';
import { syntheticRevision } from './helpers/synthetic-quote-revision.js';

const SOURCE_HASH = 'a'.repeat(64);
const TEMPLATE = new URL('../fixtures/centurion-quotation-template.xlsx', import.meta.url);
const GOTENBERG = 'http://local.test';
const PDF_BYTES = '%PDF-1.4 synthetic';
const header = {
  attention: 'David Miller',
  company: 'CIDB',
  clientEmail: 'guest@example.com',
  clientTelephone: '',
  signerName: 'R Opperman',
  signerEmail: 'ropperman@legacyhotels.co.za',
};
const proposalHeader = { ...header, agency: 'CIDB' };
/** Ten line rows: the six template rows plus four inserted below them, which move every row from 30 down. */
const INSERTED = 4;
const THREE_NIGHTS = ['100.00', '110.00', '120.00'];

/** A stay that starts on the given date, with one room rate run per run of equal nightly prices. */
async function stayOn(
  arrival: string,
  amounts: string[],
  facts?: (revision: QuoteRevision) => AuthorizedProposalFacts,
): Promise<WorkbookStay> {
  const revision = await syntheticRevision(amounts, undefined, undefined, undefined, arrival);
  return { revision, facts: facts?.(revision) };
}

function distinctNights(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `${100 + index}.00`);
}

/** Airport trips dated on the arrival day, so each trip row shares the stay's first date label. */
function tripFacts(revision: QuoteRevision, count: number): AuthorizedProposalFacts {
  return {
    revisionId: revision.id,
    authorizationId: revision.authorizationId,
    sourceRef: 'message:message-1',
    sourceHash: SOURCE_HASH,
    includedEntitlements: [],
    extras: Array.from({ length: count }, (_, index) => ({
      id: `trip-${index + 1}`,
      label: `Airport trip ${index + 1}`,
      quantity: 1,
      units: 1,
      unitKind: 'trip' as const,
      unitMinor: 60_000,
      service: 'transport',
      persons: [],
      dates: [revision.groups[0]!.arrivalDate],
    })),
  };
}

/** Three stays of three rate runs each, with one airport trip on the first: nine room rows and one extra row. */
async function tenRowStays(): Promise<WorkbookStay[]> {
  return [
    await stayOn('2026-10-12', THREE_NIGHTS, (revision) => tripFacts(revision, 1)),
    await stayOn('2026-10-20', THREE_NIGHTS),
    await stayOn('2026-11-01', THREE_NIGHTS),
  ];
}

function roomTotalOf(stays: WorkbookStay[]): number {
  return stays.reduce((sum, stay) => sum + stay.revision.totalMinor, 0);
}

function sheetOf(bytes: Uint8Array): string {
  return new TextDecoder().decode(unzipSync(bytes)['xl/worksheets/sheet1.xml']!);
}

function cellXml(sheet: string, ref: string): string {
  return sheet.match(new RegExp(`<c r="${ref}"[^>]*?(?:/>|>[\\s\\S]*?</c>)`))?.[0] ?? '';
}

function cachedCents(sheet: string, ref: string): number {
  const value = cellXml(sheet, ref).match(/<v>([^<]*)<\/v>/)?.[1];
  expect(value, `${ref} has a cached value`).toBeDefined();
  return Math.round(Number(value) * 100);
}

function text(bytes: Uint8Array | undefined): string {
  return new TextDecoder().decode(bytes);
}

/** A cell or range reference moved by the inserted rows: every row from 30 down moves. */
function shiftRef(ref: string): string {
  return ref.replace(/([A-Z]+)(\d+)/g, (_, column: string, row: string) =>
    `${column}${Number(row) >= 30 ? Number(row) + INSERTED : row}`,
  );
}

/** A Gotenberg stand-in that returns a PDF for whatever it is sent. */
function gotenberg() {
  return vi.fn<typeof fetch>(async () => new Response(PDF_BYTES, { headers: { 'content-type': 'application/pdf' } }));
}

describe('combined quote rows', () => {
  it('two stays with one room type each give two rows and one total', async () => {
    const stays = [await stayOn('2026-10-12', ['100.00', '100.00']), await stayOn('2026-11-01', ['110.00', '110.00'])];
    const { bytes, totalMinor } = quoteWorkbookForStays({ stays, header });
    const sheet = sheetOf(bytes);
    expect(totalMinor).toBe(roomTotalOf(stays));
    expect(cachedCents(sheet, 'H24')).toBe(stays[0]!.revision.totalMinor);
    expect(cachedCents(sheet, 'H25')).toBe(stays[1]!.revision.totalMinor);
    expect(cachedCents(sheet, 'H26')).toBe(0);
    expect(cellXml(sheet, 'H31')).toContain('<f>SUM(H24:H30)</f>');
    expect(cachedCents(sheet, 'H31')).toBe(totalMinor);
    expect(cachedCents(sheet, 'H33')).toBe(totalMinor);
    expect(sheet).toContain('12-14 October 2026');
    expect(sheet).toContain('1-3 November 2026');
  });

  it('three stays of three rate runs plus one extra give ten rows, with no collapse', async () => {
    const stays = await tenRowStays();
    const expected = roomTotalOf(stays) + 60_000;
    const { bytes, totalMinor } = quoteWorkbookForStays({ stays, header });
    const sheet = sheetOf(bytes);
    expect(totalMinor).toBe(expected);
    const lineTotals = Array.from({ length: 10 }, (_, index) => cachedCents(sheet, `H${24 + index}`));
    expect(lineTotals.reduce((sum, value) => sum + value, 0)).toBe(expected);
    // Ten lines move the subtotal to row 35 and the total to row 37.
    expect(cellXml(sheet, 'H35')).toContain('<f>SUM(H24:H34)</f>');
    expect(cachedCents(sheet, 'H35')).toBe(expected);
    expect(cellXml(sheet, 'H37')).toContain('<f>+H35</f>');
    expect(cachedCents(sheet, 'H37')).toBe(expected);
  });

  it('on ten rows no merge touches a line row, and the anchors, print area and dimension move by the inserted count', async () => {
    const files = unzipSync(quoteWorkbookForStays({ stays: await tenRowStays(), header }).bytes);
    const template = unzipSync(readFileSync(TEMPLATE));
    const sheet = text(files['xl/worksheets/sheet1.xml']);
    const templateSheet = text(template['xl/worksheets/sheet1.xml']);
    const mergesOf = (xml: string) => [...xml.matchAll(/<mergeCell ref="([^"]+)"/g)].map((match) => match[1]!);
    // Every template merge moves with its rows, and each new line row gets its own C:E merge.
    expect(mergesOf(sheet).sort()).toEqual(
      [...mergesOf(templateSheet).map(shiftRef), 'C30:E30', 'C31:E31', 'C32:E32', 'C33:E33'].sort(),
    );
    for (const ref of mergesOf(sheet)) {
      const rows = [...ref.matchAll(/\d+/g)].map((match) => Number(match[0]));
      if (rows.some((row) => row >= 24 && row <= 33)) expect(ref).toMatch(/^C(\d+):E\1$/);
    }
    const anchorRows = (xml: string) => [...xml.matchAll(/<xdr:row>(\d+)<\/xdr:row>/g)].map((match) => Number(match[1]));
    expect(anchorRows(text(files['xl/drawings/drawing1.xml']))).toEqual(
      anchorRows(text(template['xl/drawings/drawing1.xml'])).map((row) => (row >= 29 ? row + INSERTED : row)),
    );
    expect(text(files['xl/workbook.xml'])).toContain(`Sheet1!$A$1:$H$${69 + INSERTED}`);
    expect(sheet).toContain(`<dimension ref="${shiftRef('A1:N1244')}"/>`);
    const hyperlinksOf = (xml: string) => [...xml.matchAll(/<hyperlink ref="([^"]+)"/g)].map((match) => match[1]!);
    expect(hyperlinksOf(sheet)).toEqual(hyperlinksOf(templateSheet).map(shiftRef));
  });

  it('drops the calculation chain and every reference to it', async () => {
    const files = unzipSync(quoteWorkbookForStays({ stays: await tenRowStays(), header }).bytes);
    expect(files['xl/calcChain.xml']).toBeUndefined();
    expect(text(files['[Content_Types].xml'])).not.toContain('calcChain');
    expect(text(files['xl/_rels/workbook.xml.rels'])).not.toContain('calcChain');
  });

  it('blanks the DATE only on a row that continues the same stay dates, and never across stays', async () => {
    const stays = [
      await stayOn('2026-10-12', ['100.00', '100.00'], (revision) => tripFacts(revision, 2)),
      await stayOn('2026-11-01', ['100.00', '100.00']),
    ];
    // The room block, then two trips dated 12 October: the second repeats the first trip's label. The next stay starts its own.
    expect(workbookLinesForStays(stays).lines.map((line) => line.dateLabel)).toEqual([
      '12-14 October 2026',
      '12 October 2026',
      '',
      '1-3 November 2026',
    ]);
  });

  it('prints the DATE on every row of a single stay', async () => {
    const stays = [await stayOn('2026-10-12', ['100.00', '100.00'], (revision) => tripFacts(revision, 2))];
    expect(workbookLinesForStays(stays).lines.map((line) => line.dateLabel)).toEqual([
      '12-14 October 2026',
      '12 October 2026',
      '12 October 2026',
    ]);
  });
});

describe('combined quote PDF', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('posts the workbook to the LibreOffice converter and returns its PDF with the workbook total', async () => {
    const stays = [await stayOn('2026-10-12', ['100.00', '100.00']), await stayOn('2026-11-01', ['110.00', '110.00'])];
    const fetchImpl = gotenberg();
    const result = await buildStaysProposalPdf(stays, proposalHeader, { url: `${GOTENBERG}/`, fetchImpl, html: false });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(`${GOTENBERG}/forms/libreoffice/convert`);
    const sent = new Uint8Array(await ((init!.body as FormData).get('files') as Blob).arrayBuffer());
    expect(new TextDecoder().decode(sent.subarray(0, 2))).toBe('PK');
    expect(cachedCents(sheetOf(sent), 'H33')).toBe(result.totalMinor);
    expect(result.totalMinor).toBe(roomTotalOf(stays));
    expect(new TextDecoder().decode(result.pdf)).toBe(PDF_BYTES);
    expect(result.revisionId).toBe(documentIdFor(stays));
    expect(result.pdfHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('names a combined quote by its whole stay span, with its document id', async () => {
    const stays = [await stayOn('2026-10-12', ['100.00', '100.00']), await stayOn('2026-11-01', ['110.00', '110.00'])];
    const { fileName, revisionId } = await buildStaysProposalPdf(stays, proposalHeader, {
      url: GOTENBERG,
      fetchImpl: gotenberg(),
      html: false,
    });
    expect(fileName).toBe(`Quote - CIDB 12 October - 3 November 2026 (${revisionId.replace(/^[a-z]+:/, '').slice(0, 8)}).pdf`);
  });

  it('names two options for one agency and the same dates differently', async () => {
    const names: string[] = [];
    for (const amount of ['100.00', '120.00']) {
      const stay = await stayOn('2026-10-12', [amount, amount]);
      const { fileName } = await buildStaysProposalPdf([stay], proposalHeader, {
        url: GOTENBERG,
        fetchImpl: gotenberg(),
        html: false,
      });
      names.push(fileName);
    }
    expect(names[0]).toMatch(/^Quote - CIDB 12-14 October 2026 \([0-9a-f]{8}\)\.pdf$/);
    expect(names[0]).not.toBe(names[1]);
  });

  it('renders HTML for one stay only, and only when QUOTE_PDF_RENDERER says html', async () => {
    const one = [await stayOn('2026-10-12', ['100.00', '100.00'])];
    const two = [...one, await stayOn('2026-11-01', ['110.00', '110.00'])];
    vi.stubEnv('QUOTE_PDF_RENDERER', 'html');
    const fetchImpl = gotenberg();
    await buildStaysProposalPdf(one, proposalHeader, { url: GOTENBERG, fetchImpl });
    expect(fetchImpl.mock.calls[0]![0]).toBe(`${GOTENBERG}/forms/chromium/convert/html`);
    await expect(buildStaysProposalPdf(two, proposalHeader, { url: GOTENBERG, fetchImpl: gotenberg() })).rejects.toThrow(
      new ProposalPdfUnavailableError(
        'This server renders quote PDFs from HTML, which holds one stay only. Send the Excel for a combined quote.',
      ),
    );
  });

  it('falls back to the HTML renderer for one stay when the LibreOffice conversion fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const one = [await stayOn('2026-10-12', ['100.00', '100.00'])];
    const fetchImpl = vi.fn<typeof fetch>(async (url) =>
      String(url).endsWith('/forms/libreoffice/convert')
        ? new Response('down', { status: 503 })
        : new Response(PDF_BYTES, { headers: { 'content-type': 'application/pdf' } }),
    );
    const result = await buildStaysProposalPdf(one, proposalHeader, { url: GOTENBERG, fetchImpl, html: false });
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      `${GOTENBERG}/forms/libreoffice/convert`,
      `${GOTENBERG}/forms/chromium/convert/html`,
    ]);
    expect(new TextDecoder().decode(result.pdf)).toBe(PDF_BYTES);
    expect(result.totalMinor).toBe(roomTotalOf(one));
  });

  it('gives every converter call a deadline, and fails a combined quote with a clear error when Gotenberg is down', async () => {
    const two = [await stayOn('2026-10-12', ['100.00', '100.00']), await stayOn('2026-11-01', ['110.00', '110.00'])];
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new TypeError('fetch failed');
    });
    await expect(buildStaysProposalPdf(two, proposalHeader, { url: GOTENBERG, fetchImpl, html: false })).rejects.toThrow(
      ProposalPdfUnavailableError,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]![1]!.signal).toBeInstanceOf(AbortSignal);
  });

  it('never prints a non-rand quote in the rand Excel: one stay falls back to HTML, a combined quote is refused', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const usd = await stayOn('2026-10-12', ['100.00', '100.00']);
    const { id: _id, ...data } = { ...usd.revision, currency: 'USD', groups: usd.revision.groups.map((group) => ({ ...group, currency: 'USD' })) };
    usd.revision = { ...data, id: `quote:${quoteDigest(data)}` };
    const fetchImpl = gotenberg();
    await buildStaysProposalPdf([usd], proposalHeader, { url: GOTENBERG, fetchImpl, html: false });
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([`${GOTENBERG}/forms/chromium/convert/html`]);
    const two = [usd, await stayOn('2026-11-01', ['110.00', '110.00'])];
    expect(() => quoteWorkbookForStays({ stays: two, header })).toThrow(WorkbookRefusalError);
    await expect(buildStaysProposalPdf(two, proposalHeader, { url: GOTENBERG, fetchImpl: gotenberg(), html: false })).rejects.toThrow(
      WorkbookRefusalError,
    );
  });

  it('fails one stay with a clear error when neither renderer answers', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const one = [await stayOn('2026-10-12', ['100.00', '100.00'])];
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    });
    await expect(buildStaysProposalPdf(one, proposalHeader, { url: GOTENBERG, fetchImpl, html: false })).rejects.toThrow(
      ProposalPdfUnavailableError,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('keeps the workbook path unless the flag asks for HTML', () => {
    expect(quoteProposalPdfUsesHtml({})).toBe(false);
    expect(quoteProposalPdfUsesHtml({ QUOTE_PDF_RENDERER: 'excel' })).toBe(false);
    expect(quoteProposalPdfUsesHtml({ QUOTE_PDF_RENDERER: ' HTML ' })).toBe(true);
  });

  it('refuses a combined quote over the line limit before any PDF is requested', async () => {
    const stays = [await stayOn('2026-10-12', distinctNights(40)), await stayOn('2026-11-01', distinctNights(24))];
    const fetchImpl = gotenberg();
    await expect(buildStaysProposalPdf(stays, proposalHeader, { url: GOTENBERG, fetchImpl, html: false })).rejects.toThrow(
      WorkbookLineLimitError,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses one stay over the line limit on the HTML renderer and on the non-rand HTML fallback', async () => {
    const big = await stayOn('2026-10-12', distinctNights(64));
    const fetchImpl = gotenberg();
    await expect(buildStaysProposalPdf([big], proposalHeader, { url: GOTENBERG, fetchImpl, html: true })).rejects.toThrow(
      WorkbookLineLimitError,
    );
    const { id: _id, ...data } = { ...big.revision, currency: 'USD', groups: big.revision.groups.map((group) => ({ ...group, currency: 'USD' })) };
    const usd = { ...big, revision: { ...data, id: `quote:${quoteDigest(data)}` } };
    await expect(buildStaysProposalPdf([usd], proposalHeader, { url: GOTENBERG, fetchImpl, html: false })).rejects.toThrow(
      WorkbookLineLimitError,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('combined stay approvals', () => {
  it('reads the one date set a revision covers, and none when its stays differ', async () => {
    const revision = await syntheticRevision(['100.00', '100.00']);
    expect(approvedStaySpan(revision)).toBe('2026-10-12/2026-10-14');
    const split = structuredClone(revision);
    split.groups.push({ ...split.groups[0]!, arrivalDate: '2026-10-20', departureDate: '2026-10-22' });
    expect(approvedStaySpan(split)).toBeNull();
  });

  it('supersedes a stay by a newer approval for the same dates, or by one whose dates are unknown', () => {
    const span = '2026-10-12/2026-10-14';
    const other = '2026-11-01/2026-11-03';
    // Newest first, as the route lists them.
    const approvals = [
      { generationId: 'gen-4', span: other },
      { generationId: 'gen-3', span },
      { generationId: 'gen-2', span: null },
      { generationId: 'gen-1', span },
    ];
    expect(combinedStayCurrencyProblem({ stay: { generationId: 'gen-4', span: other }, approvals })).toBeNull();
    expect(combinedStayCurrencyProblem({ stay: { generationId: 'gen-3', span }, approvals })).toBeNull();
    expect(combinedStayCurrencyProblem({ stay: { generationId: 'gen-1', span }, approvals })).toMatch(/Newer stay inputs/);
    // A newer approval with unknown dates could have changed any stay, so it supersedes this one too.
    expect(
      combinedStayCurrencyProblem({
        stay: { generationId: 'gen-4', span: other },
        approvals: [{ generationId: 'gen-5', span: null }, ...approvals],
      }),
    ).toMatch(/Newer stay inputs/);
  });

  it('refuses a stay with no single date set, or one whose run is not among the approvals', () => {
    const approvals = [{ generationId: 'gen-1', span: '2026-10-12/2026-10-14' }];
    expect(combinedStayCurrencyProblem({ stay: { generationId: 'gen-1', span: null }, approvals })).toMatch(/not one set/);
    expect(
      combinedStayCurrencyProblem({ stay: { generationId: 'gen-9', span: '2026-10-12/2026-10-14' }, approvals }),
    ).toMatch(/Newer stay inputs/);
    expect(
      combinedStayCurrencyProblem({ stay: { generationId: null, span: '2026-10-12/2026-10-14' }, approvals }),
    ).toMatch(/Newer stay inputs/);
  });
});

describe('same-property combined quotes', () => {
  async function stayOnProperty(propertyCode: string, arrival: string, amounts: string[]): Promise<WorkbookStay> {
    const stay = await stayOn(arrival, amounts);
    const revision = structuredClone(stay.revision);
    revision.propertyCode = propertyCode;
    const { id: _id, ...data } = revision;
    revision.id = `quote:${quoteDigest(data)}`;
    return { ...stay, revision };
  }

  it('keeps two HRCEN stays in one workbook', async () => {
    const stays = [
      await stayOnProperty('HRCEN', '2026-10-12', ['100.00']),
      await stayOnProperty('HRCEN', '2026-11-01', ['110.00']),
    ];
    const { totalMinor } = quoteWorkbookForStays({ stays, header });
    expect(totalMinor).toBe(roomTotalOf(stays));
  });

  it('refuses a mixed HRCEN + HRDAV quote before writing Excel or PDF', async () => {
    const stays = [
      await stayOnProperty('HRCEN', '2026-10-12', ['100.00']),
      await stayOnProperty('HRDAV', '2026-11-01', ['110.00']),
    ];
    expect(() => quoteWorkbookForStays({ stays, header })).toThrow(MixedPropertyQuoteError);
    expect(() => quoteWorkbookForStays({ stays, header })).toThrow(/more than one property/);
    expect(() => workbookLinesForStays(stays)).toThrow(MixedPropertyQuoteError);
    await expect(
      buildStaysProposalPdf(stays, proposalHeader, { url: GOTENBERG, fetchImpl: gotenberg(), html: true }),
    ).rejects.toBeInstanceOf(MixedPropertyQuoteError);
  });
});
