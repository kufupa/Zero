import { trpcRequestTimeoutMs } from '../lib/trpc-request-timeout';
import { describe, expect, it } from 'vitest';

describe('procedure-specific request deadlines', () => {
  it('allows the server-bound native staff quote to complete', () => {
    expect(trpcRequestTimeoutMs('/api/trpc/workstation.executeStaffQuote?batch=1')).toBe(1_200_000);
  });
  it('uses the PDF deadline for qualified and legacy PDF routes', () => {
    expect(trpcRequestTimeoutMs('/api/trpc/workstation.qualifiedQuoteProposalPdf')).toBe(60_000);
    expect(trpcRequestTimeoutMs('/api/trpc/workstation.quoteProposalPdf')).toBe(60_000);
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
  it('gives prepareBookingDraft a 60s client deadline', () => {
    expect(trpcRequestTimeoutMs('/api/trpc/workstation.prepareBookingDraft?batch=1')).toBe(60_000);
    expect(trpcRequestTimeoutMs('/api/trpc/workstation.usePriorQuoteForBooking?batch=1')).toBe(
      60_000,
    );
  });
  it('takes the longer deadline for encoded batched paths', () => {
    expect(
      trpcRequestTimeoutMs('/api/trpc/drafts.list%2Cworkstation.executeStaffQuote?batch=1'),
    ).toBe(1_200_000);
  });
  it('accepts URL and Request inputs and keeps malformed input short', () => {
    expect(
      trpcRequestTimeoutMs(new URL('https://example.test/api/trpc/workstation.executeStaffQuote')),
    ).toBe(1_200_000);
    expect(
      trpcRequestTimeoutMs(
        new Request('https://example.test/api/trpc/workstation.qualifiedQuoteProposalPdf'),
      ),
    ).toBe(60_000);
    expect(trpcRequestTimeoutMs('/api/trpc/%ZZ')).toBe(5_000);
  });
});
