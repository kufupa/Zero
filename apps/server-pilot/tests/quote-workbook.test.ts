import { afterEach, describe, expect, it, vi } from 'vitest';
import { unzipSync } from 'fflate';
import {
  excelSerialDate,
  quoteDateLabel,
  quoteWorkbookFileName,
  quoteWorkbookForRevision,
  workbookLinesFor,
  WORKBOOK_LINE_ROWS,
} from '../src/quote-proposal/quote-workbook.js';
import { renderRevisionProposalHtml } from '../src/quote-proposal/proposal-pdf.js';
import type { AuthorizedProposalFacts } from '../src/quote-proposal/quote-lines.js';
import {
  buildStaffProposalFacts,
  staffQuoteCurrencyProblem,
  staffQuoteInput,
  staffQuoteSourceHash,
  type StaffQuoteInput,
} from '../src/ai/staff-quote-workflow.js';
import { resolveLedgerProposal } from '../src/trpc/routes/workstation.js';
import { syntheticRevision } from './helpers/synthetic-quote-revision.js';

const SOURCE_HASH = 'a'.repeat(64);
const header = {
  attention: 'David Miller',
  company: 'CIDB',
  clientEmail: 'guest@example.com',
  clientTelephone: '',
  signerName: 'R Opperman',
  signerEmail: 'ropperman@legacyhotels.co.za',
};
const pdfHeader = { ...header, agency: 'CIDB', signerTelephone: '0126433600' };

function baseInput(overrides: Partial<StaffQuoteInput> = {}): StaffQuoteInput {
  return staffQuoteInput.parse({
    messageId: 'message-1',
    sourceHash: SOURCE_HASH,
    selectionEpoch: 1,
    inputRevision: 1,
    groups: [
      {
        id: 'stay',
        arrivalDate: '2026-10-12',
        departureDate: '2026-10-15',
        quantity: 1,
        adults: 2,
        childrenAges: [],
        board: 'bb',
      },
    ],
    ...overrides,
  });
}

async function staffScenario(overrides: Partial<StaffQuoteInput> = {}, amounts?: string[]) {
  const revision = await syntheticRevision(amounts);
  const built = buildStaffProposalFacts(
    baseInput(overrides),
    { messageId: 'message-1', sourceHash: SOURCE_HASH },
    { authorizationId: revision.authorizationId },
    revision,
  );
  return { revision, facts: built.facts ?? undefined };
}

/** Everything the staff quote can add, so the sheet has more lines than fit. */
const fullExtras: Partial<StaffQuoteInput> = {
  dinnerAllowanceMinor: 45_000,
  lunchAllowanceMinor: 20_000,
  officeTransferMinor: 20_000,
  shuttleRequested: true,
  shuttleMinor: 60_000,
  shuttleTrips: 2,
  other: { label: 'Parking', amountMinor: 30_000, unit: 'item' },
};

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

function pdfTotalMinor(html: string): number {
  return Number(html.match(/data-proposal-total="(\d+)"/)?.[1]);
}

describe('quote workbook totals and formulas', () => {
  it('totals in the workbook equal the PDF total for the same revision', async () => {
    const { revision, facts } = await staffScenario(fullExtras);
    const { bytes, totalMinor } = quoteWorkbookForRevision({ revision, facts, header });
    const pdfTotal = pdfTotalMinor(renderRevisionProposalHtml(revision, pdfHeader, facts));
    const sheet = sheetOf(bytes);
    expect(totalMinor).toBe(pdfTotal);
    expect(cachedCents(sheet, 'H33')).toBe(pdfTotal);
    expect(cachedCents(sheet, 'H31')).toBe(pdfTotal);
    const lineTotals = [24, 25, 26, 27, 28, 29].reduce((sum, row) => sum + cachedCents(sheet, `H${row}`), 0);
    expect(lineTotals).toBe(pdfTotal);
  });

  it('keeps line totals, subtotal and total as formulas with cached values', async () => {
    const { revision, facts } = await staffScenario(fullExtras);
    const sheet = sheetOf(quoteWorkbookForRevision({ revision, facts, header }).bytes);
    for (const row of [24, 25, 26, 27, 28, 29]) {
      expect(cellXml(sheet, `H${row}`)).toContain(`<f>+B${row}*F${row}*G${row}</f>`);
      const qty = Number(cellXml(sheet, `B${row}`).match(/<v>([^<]*)<\/v>/)?.[1] ?? 0);
      const nights = Number(cellXml(sheet, `F${row}`).match(/<v>([^<]*)<\/v>/)?.[1] ?? 0);
      const rateCents = Math.round(Number(cellXml(sheet, `G${row}`).match(/<v>([^<]*)<\/v>/)?.[1] ?? 0) * 100);
      expect(cachedCents(sheet, `H${row}`)).toBe(qty * nights * rateCents);
    }
    expect(cellXml(sheet, 'H31')).toContain('<f>SUM(H24:H30)</f>');
    expect(cellXml(sheet, 'H33')).toContain('<f>+H31</f>');
    expect((sheet.match(/<f[ >]/g) ?? []).length).toBe(8);
    expect(sheet).not.toContain('t="shared"');
    const workbookXml = new TextDecoder().decode(unzipSync(quoteWorkbookForRevision({ revision, facts, header }).bytes)['xl/workbook.xml']!);
    expect(workbookXml).toMatch(/<calcPr[^>]*fullCalcOnLoad="1"/);
  });

  it('writes the authored date as a fixed date, never TODAY()', async () => {
    const { revision, facts } = await staffScenario();
    const sheet = sheetOf(quoteWorkbookForRevision({ revision, facts, header }).bytes);
    expect(sheet).not.toContain('TODAY');
    expect(cellXml(sheet, 'B9')).not.toContain('<f');
    expect(cachedCents(sheet, 'B9')).toBe(Math.round(excelSerialDate(revision.authoredDate) * 100));
  });

  it('scrubs the template author, last editor and local save path from the package', async () => {
    const { revision, facts } = await staffScenario();
    const files = unzipSync(quoteWorkbookForRevision({ revision, facts, header }).bytes);
    const core = new TextDecoder().decode(files['docProps/core.xml']!);
    expect(core).not.toContain('<dc:creator>');
    expect(core).not.toContain('<cp:lastModifiedBy>');
    for (const [name, bytes] of Object.entries(files)) {
      const text = new TextDecoder().decode(bytes);
      for (const needle of ['EloiseH', 'Jaco', 'Vermaak', 'C:\\Users', 'absPath']) {
        expect(text.includes(needle), `${name} contains ${needle}`).toBe(false);
      }
    }
    expect(files['xl/calcChain.xml']).toBeUndefined();
  });

  it('keeps a hostile extra label as text in the sheet', async () => {
    const { revision, facts } = await staffScenario({ other: { label: '<img src=x onerror=alert(1)>', amountMinor: 30_000, unit: 'item' } });
    const sheet = sheetOf(quoteWorkbookForRevision({ revision, facts, header, note: '<script>alert(1)</script>' }).bytes);
    expect(sheet).not.toContain('<img src=x');
    expect(sheet).not.toContain('<script>alert');
    expect(sheet).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(sheet).toContain('Note: &lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('fills the header, the signer and the unused line rows as empty cells', async () => {
    const { revision, facts } = await staffScenario();
    const sheet = sheetOf(quoteWorkbookForRevision({ revision, facts, header }).bytes);
    expect(cellXml(sheet, 'B12')).toContain('David Miller');
    expect(cellXml(sheet, 'B13')).toContain('CIDB');
    expect(cellXml(sheet, 'B61')).toContain('R Opperman');
    expect(cellXml(sheet, 'B63')).toContain('0126433600');
    // Unused rows must not hold empty text: text in B or F would make the line-total formula fail.
    expect(cellXml(sheet, 'B26')).not.toContain('inlineStr');
    expect(cellXml(sheet, 'B26')).not.toContain('<v>');
    expect(cachedCents(sheet, 'H26')).toBe(0);
  });
});

describe('quote workbook line rows', () => {
  it('fits extras that overflow six rows into one exact "Other charges" line', async () => {
    const { revision, facts } = await staffScenario(fullExtras);
    const { lines, totalMinor } = workbookLinesFor(revision, facts);
    expect(lines.length).toBeLessThanOrEqual(WORKBOOK_LINE_ROWS);
    expect(lines.at(-1)?.description).toBe('Other charges');
    expect(lines.at(-1)?.totalMinor).toBe(120_000 + 30_000);
    const sheet = sheetOf(quoteWorkbookForRevision({ revision, facts, header }).bytes);
    expect(cellXml(sheet, `A${24 + lines.length}`)).not.toContain('inlineStr');
    expect(cachedCents(sheet, 'H33')).toBe(totalMinor);
  });

  it('handles more than six native room lines without losing money', async () => {
    const amounts = ['100.00', '110.00', '120.00', '130.00', '140.00', '150.00', '160.00'];
    const { revision, facts } = await staffScenario({}, amounts);
    const { lines, totalMinor } = workbookLinesFor(revision, facts);
    expect(lines.length).toBe(WORKBOOK_LINE_ROWS);
    expect(lines.at(-1)?.description).toBe('Other charges');
    const sheet = sheetOf(quoteWorkbookForRevision({ revision, facts, header }).bytes);
    expect(cachedCents(sheet, 'H33')).toBe(totalMinor);
    expect(totalMinor).toBe(revision.totalMinor);
  });

  it('merges same-type extra blocks into guests x nights when that brings the sheet within six rows', async () => {
    const revision = await syntheticRevision();
    const sourceRef = 'message:message-1';
    const facts: AuthorizedProposalFacts = {
      revisionId: revision.id,
      authorizationId: revision.authorizationId,
      sourceRef,
      sourceHash: SOURCE_HASH,
      includedEntitlements: [
        { sourceRef: 'policy', sourceHash: 'b'.repeat(64), service: 'dinner_allowance', personIds: ['adult-2'], dates: ['2026-10-14'] },
        { sourceRef: 'policy', sourceHash: 'b'.repeat(64), service: 'dinner_allowance', personIds: ['adult-1'], dates: ['2026-10-12'] },
      ],
      extras: [
        {
          id: 'dinner-allowance',
          label: 'Dinner allowance',
          quantity: 1,
          units: 6,
          unitKind: 'person_service',
          unitMinor: 45_000,
          service: 'dinner_allowance',
          persons: [
            { id: 'adult-1', age: 18 },
            { id: 'adult-2', age: 18 },
          ],
          dates: ['2026-10-12', '2026-10-13', '2026-10-14'],
        },
        { id: 'lunch', label: 'Lunch allowance', quantity: 1, units: 6, unitKind: 'person_service', unitMinor: 20_000, service: 'lunch_allowance', persons: [{ id: 'adult-1', age: 18 }, { id: 'adult-2', age: 18 }], dates: ['2026-10-12', '2026-10-13', '2026-10-14'] },
        { id: 'office-transfer', label: 'Office transfer', quantity: 1, units: 6, unitKind: 'person_service', unitMinor: 20_000, service: 'office_transfer', persons: [{ id: 'adult-1', age: 18 }, { id: 'adult-2', age: 18 }], dates: ['2026-10-12', '2026-10-13', '2026-10-14'] },
        { id: 'shuttle', label: 'Shuttle', quantity: 1, units: 2, unitKind: 'trip', unitMinor: 60_000, service: 'shuttle', persons: [], dates: ['2026-10-12'] },
      ],
    };
    const { lines, totalMinor } = workbookLinesFor(revision, facts);
    // Two rooms, two dinner blocks, lunch, office transfer and shuttle: seven rows before merging, six after.
    expect(lines.length).toBe(6);
    const dinner = lines.find((line) => line.description === 'Dinner allowance');
    expect(dinner).toMatchObject({ qty: 2, nights: 2, totalMinor: 2 * 2 * 45_000 });
    expect(lines.some((line) => line.description === 'Other charges')).toBe(false);
    const pdfTotal = pdfTotalMinor(renderRevisionProposalHtml(revision, pdfHeader, facts));
    expect(totalMinor).toBe(pdfTotal);
    expect(cachedCents(sheetOf(quoteWorkbookForRevision({ revision, facts, header }).bytes), 'H33')).toBe(pdfTotal);
  });

  it('writes the staff note into a wrapped, merged block and keeps the merge count consistent', async () => {
    const { revision, facts } = await staffScenario();
    const note = 'Breakfast only on day 2. '.repeat(40).trim();
    const sheet = sheetOf(quoteWorkbookForRevision({ revision, facts, header, note }).bytes);
    expect(cellXml(sheet, 'A42')).toContain('Note: Breakfast only on day 2.');
    expect(sheet).toContain('<mergeCell ref="A42:H46"/>');
    const declared = Number(sheet.match(/<mergeCells count="(\d+)">/)?.[1]);
    expect(declared).toBe((sheet.match(/<mergeCell /g) ?? []).length);
    expect(sheet).toMatch(/<row r="42"[^>]*ht="[1-9]\d*(\.\d+)?"[^>]*customHeight="1"/);
  });
});

describe('quote workbook file name and dates', () => {
  it('labels the file "Quote - <Company or Guest> - <arrival>.xlsx" with unsafe characters removed', () => {
    expect(quoteWorkbookFileName('Acme / Co: "Ltd"', '2026-10-12')).toBe('Quote - Acme Co Ltd - 2026-10-12.xlsx');
    expect(quoteWorkbookFileName('   ', '2026-10-12')).toBe('Quote - Guest - 2026-10-12.xlsx');
  });

  it('labels DATE ranges the way the quotation reads them', () => {
    expect(quoteDateLabel('2026-10-12', '2026-10-14')).toBe('12-14 October 2026');
    expect(quoteDateLabel('2026-10-30', '2026-11-02')).toBe('30 October - 2 November 2026');
    expect(quoteDateLabel('2026-12-30', '2027-01-02')).toBe('30 December 2026 - 2 January 2027');
    expect(quoteDateLabel('2026-10-12', '2026-10-12')).toBe('12 October 2026');
  });
});

describe('quote workbook authority', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('refuses a superseded generation, a changed email, a different user, and a changed party', () => {
    const current = { id: 'message-1', threadId: 'thread-1', subject: 'Quote', textBody: 'Please quote', htmlBody: null };
    const staff = {
      userId: 'user-1',
      threadId: 'thread-1',
      sourceHash: staffQuoteSourceHash(current),
      header: { company: 'CIDB', agency: 'CIDB' },
    };
    const base = {
      staff,
      runGenerationId: 'gen-2',
      latestGenerationId: 'gen-2',
      currentMessage: current,
      userId: 'user-1',
      party: { company: 'CIDB', agency: 'CIDB' },
    };
    expect(staffQuoteCurrencyProblem(base)).toBeNull();
    expect(staffQuoteCurrencyProblem({ ...base, latestGenerationId: 'gen-3' })).toMatch(/Newer stay inputs/);
    expect(staffQuoteCurrencyProblem({ ...base, currentMessage: { ...current, textBody: 'Changed' } })).toMatch(
      /Selected email changed/,
    );
    expect(staffQuoteCurrencyProblem({ ...base, currentMessage: undefined })).toMatch(/Selected email changed/);
    expect(staffQuoteCurrencyProblem({ ...base, userId: 'user-2' })).toMatch(/Selected email changed/);
    expect(staffQuoteCurrencyProblem({ ...base, party: { company: 'Other', agency: 'CIDB' } })).toMatch(
      /Party identity changed/,
    );
  });

  it('refuses a run from another transport or another trigger message', async () => {
    // The source is fresh for an hour from its evaluation time, and the window starts on the authored date.
    const sourceAt = '2026-10-04T10:00:00Z';
    const revision = await syntheticRevision(undefined, undefined, undefined, sourceAt);
    const run = {
      transportId: 'transport-2',
      triggerMessageId: 'message-1',
      state: 'succeeded',
      metrics: {
        reservationistResult: {
          readiness: 'ready_for_staff_review',
          quoteRevisionIds: [revision.id],
          quoteRevisions: [revision],
          proposalFacts: [],
        },
      },
    };
    const scope = { transportId: 'transport-1', messageId: 'message-1', revisionRef: revision.id, factRefs: [] };
    expect(() => resolveLedgerProposal(run, scope)).toThrow(/proposal_scope/);
    expect(() => resolveLedgerProposal({ ...run, transportId: 'transport-1', triggerMessageId: 'message-9' }, scope)).toThrow(
      /proposal_scope/,
    );
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-04T10:30:00Z'));
    expect(resolveLedgerProposal({ ...run, transportId: 'transport-1' }, scope).revision.id).toBe(revision.id);
  });
});
