import { describe, expect, it, vi } from 'vitest';

// The gates have their own tests in quote-workflow-session.test.ts. Here they are stubbed so the approved quote
// on screen can be mapped to the server request on its own.
vi.mock('../lib/quote-workflow/session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/quote-workflow/session')>();
  return { ...actual, staffSourceReady: () => true, evidenceMatchesSession: () => true, canCreatePdf: () => true };
});

import {
  bindQualifiedStaffWorkbook,
  downloadStaffQuoteWorkbook,
  workbookRequestFor,
  XLSX_MIME_TYPE,
} from '../lib/quote-workflow/quote-workbook-download';
import { initialQuoteSession } from '../lib/quote-workflow/session';
import type { QualifiedStaffPdfInput, QualifiedStaffWorkbookResult } from '../lib/quote-workflow/staff-quote-bind';
import type { QuoteSession } from '../lib/quote-workflow/types';

const input: QualifiedStaffPdfInput = {
  workflowRunId: 'run-1',
  revisionRef: 'quote:rev-1',
  messageId: 'mail-1',
  outlookEmail: 'centurion@legacyhotels.co.za',
  factRefs: ['extras'],
  attention: 'David Miller',
  company: 'CIDB',
  clientEmail: 'guest@example.com',
  clientTelephone: '',
  agency: 'CIDB',
  notes: 'Breakfast only on day two.',
};
const xlsxBase64 = btoa(String.fromCharCode(0x50, 0x4b, 0x03, 0x04, 0, 0));
const serverResult = (overrides: Partial<QualifiedStaffWorkbookResult> = {}): QualifiedStaffWorkbookResult => ({
  fileName: 'Quote - CIDB - 2026-10-12.xlsx',
  xlsxBase64,
  totalMinor: 270_000,
  revisionId: 'quote:rev-1',
  ...overrides,
});
const NOT_READY = 'The quote is not ready for Excel yet. Run the search again, then download the Excel.';

describe('Excel download request', () => {
  it('refuses to make an Excel without an approved quote for the selected stay', () => {
    expect(workbookRequestFor(initialQuoteSession())).toEqual({ status: 'unavailable', reason: NOT_READY });
  });

  it('maps the approved quote on screen to the same request the PDF makes', () => {
    const session = {
      ...initialQuoteSession(),
      binding: { mailboxEmail: 'centurion@legacyhotels.co.za' },
      selectedStayKey: 'stay-1',
      staffSource: { messageId: 'mail-1', threadId: 'thread-1', sourceHash: 'ab'.repeat(32) },
      evidence: { kind: 'authorised', selectionEpoch: 1, inputRevision: 1 },
      staffQuotes: {
        'stay-1': {
          workflowRunId: 'run-1',
          revisionRef: 'quote:rev-1',
          factRefs: ['extras'],
          totalMinor: 270_000,
          approvedHeader: {
            salesStrategy: 'BAR',
            company: 'CIDB',
            agency: 'CIDB',
            attention: 'David Miller',
            clientEmail: 'guest@example.com',
            clientTelephone: '',
            notes: 'Breakfast only on day two.',
          },
        },
      },
    } as unknown as QuoteSession;
    expect(workbookRequestFor(session)).toEqual({ status: 'ok', input, expectedTotalMinor: 270_000 });
  });

  it('asks for the dinner allowance first, as the PDF does', () => {
    const session = {
      ...initialQuoteSession(),
      staffHeader: { ...initialQuoteSession().staffHeader, dinnerAllowanceRequired: true },
    } as QuoteSession;
    expect(workbookRequestFor(session)).toEqual({
      status: 'unavailable',
      reason: 'Dinner price — enter amount.',
    });
  });
});

describe('Excel download binding', () => {
  it('saves the workbook when it matches the quote on screen', async () => {
    const download = vi.fn();
    const mutate = vi.fn(async () => serverResult());
    const bound = await bindQualifiedStaffWorkbook({ mutate, input, expectedTotalMinor: 270_000, download });
    expect(bound).toEqual({ status: 'ok', fileName: 'Quote - CIDB - 2026-10-12.xlsx' });
    expect(mutate).toHaveBeenCalledWith(input);
    const [blob, fileName] = download.mock.calls[0] as unknown as [Blob, string];
    expect(fileName).toBe('Quote - CIDB - 2026-10-12.xlsx');
    expect(blob.type).toBe(XLSX_MIME_TYPE);
  });

  it('does not download an Excel returned after the quote changes', async () => {
    let release!: (value: QualifiedStaffWorkbookResult) => void;
    let current = true;
    const download = vi.fn();
    const pending = bindQualifiedStaffWorkbook({ input, expectedTotalMinor: 270_000, download,
      isCurrent: () => current, mutate: () => new Promise((resolve) => { release = resolve; }) });
    current = false;
    release(serverResult());
    await expect(pending).resolves.toEqual({ status: 'unavailable',
      reason: 'The quote changed in the pane. Download Excel again.' });
    expect(download).not.toHaveBeenCalled();
  });

  it.each([
    ['a different total', serverResult({ totalMinor: 1 })],
    ['a different revision', serverResult({ revisionId: 'quote:other' })],
    ['a file that is not an xlsx package', serverResult({ xlsxBase64: btoa('plain text') })],
    ['a name that is not a quote workbook', serverResult({ fileName: 'evil.exe' })],
    ['no bytes', serverResult({ xlsxBase64: '' })],
  ])('refuses %s and saves nothing', async (_name, bad) => {
    const download = vi.fn();
    const bound = await bindQualifiedStaffWorkbook({
      mutate: async () => bad,
      input,
      expectedTotalMinor: 270_000,
      download,
    });
    expect(bound.status).toBe('unavailable');
    expect(download).not.toHaveBeenCalled();
  });

  it('says why when the server route is missing or refuses the request', async () => {
    expect(await bindQualifiedStaffWorkbook({ input, expectedTotalMinor: 270_000 })).toEqual({
      status: 'unavailable',
      reason: 'Excel download is not connected to this pane yet. Refresh the pane and try again.',
    });
    expect(
      await bindQualifiedStaffWorkbook({
        mutate: async () => {
          throw new Error('Newer stay inputs were approved; use the current quote');
        },
        input,
        expectedTotalMinor: 270_000,
        download: vi.fn(),
      }),
    ).toEqual({ status: 'unavailable', reason: 'Newer stay inputs were approved; use the current quote' });
  });

  it('tells staff why nothing was downloaded', async () => {
    const notify = vi.fn();
    await downloadStaffQuoteWorkbook({ session: initialQuoteSession(), mutate: vi.fn(), notify });
    expect(notify).toHaveBeenCalledWith(NOT_READY);
  });
});
