import { trpcRequestTimeoutMs } from '../lib/trpc-request-timeout';
import { describe, expect, it } from 'vitest';

describe('procedure-specific request deadlines', () => {
  it('allows the server-bound native staff quote to complete', () => {
    expect(trpcRequestTimeoutMs('/api/trpc/workstation.executeStaffQuote?batch=1')).toBe(1_200_000);
  });
  it('gives the legacy PDF route 60 seconds and the qualified PDF route the trace-finish deadline', () => {
    expect(trpcRequestTimeoutMs('/api/trpc/workstation.quoteProposalPdf')).toBe(60_000);
    expect(trpcRequestTimeoutMs('/api/trpc/workstation.qualifiedQuoteProposalPdf')).toBe(120_000);
  });
  it('gives the Excel workbook the trace-finish deadline', () => {
    expect(trpcRequestTimeoutMs('/api/trpc/workstation.quoteWorkbook')).toBe(120_000);
  });

  it('keeps source and ordinary queries short', () => {
    expect(trpcRequestTimeoutMs('/api/trpc/workstation.staffQuoteSource')).toBe(5_000);
    expect(trpcRequestTimeoutMs('/api/trpc/drafts.list')).toBe(5_000);
  });
  it('matches exact route names rather than query text or similarly named procedures', () => {
    expect(trpcRequestTimeoutMs('/api/trpc/drafts.get?input=workstation.executeStaffQuote')).toBe(
      5_000,
    );
    expect(trpcRequestTimeoutMs('/api/trpc/workstation.executeStaffQuoteExtra')).toBe(5_000);
    expect(trpcRequestTimeoutMs('/api/trpc/quoteWorkflow.analyseSelectionX')).toBe(5_000);
  });
  it('gives analyseSelection a 45s client deadline', () => {
    expect(trpcRequestTimeoutMs('/api/trpc/quoteWorkflow.analyseSelection?batch=1')).toBe(45_000);
  });
  it('gives voucherFind 45s, past its 15s text read plus the 20s scanned-PDF vision read', () => {
    expect(trpcRequestTimeoutMs('/api/trpc/quoteWorkflow.voucherFind?batch=1')).toBe(45_000);
    expect(trpcRequestTimeoutMs('/api/trpc/quoteWorkflow.voucherFindX')).toBe(5_000);
  });
  it('gives the translation retry 45s, past its 40s server deadline', () => {
    expect(trpcRequestTimeoutMs('/api/trpc/workItems.retryTranslation?batch=1')).toBe(45_000);
    expect(trpcRequestTimeoutMs('/api/trpc/workItems.retryTranslationX')).toBe(5_000);
  });
  it('gives prepareBookingDraft and usePriorQuoteForBooking the trace-finish deadline', () => {
    expect(trpcRequestTimeoutMs('/api/trpc/workstation.prepareBookingDraft?batch=1')).toBe(120_000);
    expect(trpcRequestTimeoutMs('/api/trpc/workstation.usePriorQuoteForBooking?batch=1')).toBe(
      120_000,
    );
  });
  it('takes the longer deadline for encoded batched paths', () => {
    expect(
      trpcRequestTimeoutMs('/api/trpc/drafts.list%2Cworkstation.executeStaffQuote?batch=1'),
    ).toBe(1_200_000);
    expect(
      trpcRequestTimeoutMs('/api/trpc/workstation.quoteProposalPdf%2Cworkstation.quoteWorkbook?batch=1'),
    ).toBe(120_000);
  });
  it('accepts URL and Request inputs and keeps malformed input short', () => {
    expect(
      trpcRequestTimeoutMs(new URL('https://example.test/api/trpc/workstation.executeStaffQuote')),
    ).toBe(1_200_000);
    expect(
      trpcRequestTimeoutMs(
        new Request('https://example.test/api/trpc/workstation.qualifiedQuoteProposalPdf'),
      ),
    ).toBe(120_000);
    expect(trpcRequestTimeoutMs('/api/trpc/%ZZ')).toBe(5_000);
  });
  it('gives a browser find and guest-name search six minutes, longer than their five-minute server bound', () => {
    expect(trpcRequestTimeoutMs('/api/trpc/paneStayLookup.findStay?batch=1')).toBe(360_000);
    expect(trpcRequestTimeoutMs('/api/trpc/paneStayLookup.searchGuest?batch=1')).toBe(360_000);
  });
  it('gives the Find in HMS party search six minutes, and leaves its neighbours short', () => {
    expect(trpcRequestTimeoutMs('/api/trpc/panePartyLookup.findParty?batch=1')).toBe(360_000);
    expect(trpcRequestTimeoutMs('/api/trpc/panePartyLookup.findPartyX')).toBe(5_000);
    expect(trpcRequestTimeoutMs('/api/trpc/paneStayLookup.findStay?batch=1')).toBe(360_000);
  });
  it('gives cancel preview and commit 21 minutes, longer than the 20-minute server bound', () => {
    expect(trpcRequestTimeoutMs('/api/trpc/paneStayCancel.previewCancel?batch=1')).toBe(1_260_000);
    expect(trpcRequestTimeoutMs('/api/trpc/paneStayCancel.commitCancel?batch=1')).toBe(1_260_000);
  });
  it('gives preview and commit of a pane save 27 minutes, past the duplicate read and the 20-minute save bound', () => {
    expect(trpcRequestTimeoutMs('/api/trpc/quoteWorkflow.previewStay?batch=1')).toBe(1_620_000);
    expect(trpcRequestTimeoutMs('/api/trpc/quoteWorkflow.commitStay?batch=1')).toBe(1_620_000);
  });
  it('keeps the screenshot reads short', () => {
    expect(trpcRequestTimeoutMs('/api/trpc/paneStayLookup.screenshot?batch=1')).toBe(5_000);
    expect(trpcRequestTimeoutMs('/api/trpc/paneStayCancel.paneStayScreenshot?batch=1')).toBe(5_000);
  });
  it('gives every route that waits for a provisional quote trace 120 seconds', () => {
    for (const route of [
      'workstation.quoteRunScreenshot?batch=1',
      'workstation.qualifiedProposalChoices?batch=1',
      'workstation.getPriorStaffQuoteRequote?batch=1',
      'workstation.sourceQuoteProposalPdf?batch=1',
    ])
      expect(trpcRequestTimeoutMs(`/api/trpc/${route}`)).toBe(120_000);
  });
  it('takes the trace-finish deadline for a batch that includes a waiting route', () => {
    expect(
      trpcRequestTimeoutMs('/api/trpc/workstation.quoteRunScreenshot,workstation.foo?batch=1'),
    ).toBe(120_000);
    expect(trpcRequestTimeoutMs('/api/trpc/drafts.list,workstation.qualifiedProposalChoices')).toBe(
      120_000,
    );
  });
  it('does not extend unrelated workstation routes by name similarity', () => {
    expect(trpcRequestTimeoutMs('/api/trpc/workstation.quoteRunScreenshotLater')).toBe(5_000);
    expect(trpcRequestTimeoutMs('/api/trpc/workstation.qualifiedProposalChoicesX')).toBe(5_000);
  });
});
