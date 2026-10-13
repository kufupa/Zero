import { describe, expect, it } from 'vitest';
import { createTRPCProxyClient, httpBatchLink } from '@trpc/client';
import type { AppRouter } from '@zero/server/trpc';
import superjson from 'superjson';
import { quoteWorkflowFromTrpc } from '../lib/quote-workflow/backend-bind';
import { staffQuoteFromTrpc } from '../lib/quote-workflow/staff-quote-bind';
import { paneStayFromTrpc } from '../lib/quote-workflow/pane-stay-bind';
import { amendCancelClientFromTrpc, amendCapabilitiesFromTrpc } from '../lib/quote-workflow/amend-cancel';
import { amendFindClientFromTrpc } from '../lib/quote-workflow/amend-find';
import { partyFinderFromTrpc } from '../lib/quote-workflow/party-lookup';
import { savedRatesFromTrpc } from '../components/quote-workflow/rate-controls';
import { hmsApprovalFromTrpc } from '../lib/quote-workflow/hms-write';

// The pane passes the real tRPC client, which is a function-backed proxy (typeof 'function').
// Plain-object mocks hid the bug where every helper returned empty routes in production.
const client = createTRPCProxyClient<AppRouter>({
  links: [httpBatchLink({ url: 'https://pane.invalid/api/trpc', transformer: superjson })],
});

describe('pane tRPC helpers bind routes off the real client', () => {
  it('reaches quoteWorkflow.analyseSelection', () => {
    expect(typeof quoteWorkflowFromTrpc(client).analyseSelection?.mutate).toBe('function');
  });

  it('keeps every workstation route reachable through the function-backed client proxy', () => {
    expect(typeof client).toBe('function');
    const staff = staffQuoteFromTrpc(client);

    expect(typeof staff.workstation.staffQuoteSource?.query).toBe('function');
    expect(typeof staff.workstation.executeStaffQuote?.mutate).toBe('function');
    expect(typeof staff.workstation.queueStaffQuote?.mutate).toBe('function');
    expect(typeof staff.workstation.staffQuoteJob?.query).toBe('function');
    expect(typeof staff.workstation.hmsQueueStatus?.query).toBe('function');
    expect(typeof staff.workstation.quoteRunScreenshot?.query).toBe('function');
    expect(typeof staff.workstation.qualifiedQuoteProposalPdf?.mutate).toBe('function');
    expect(typeof staff.workstation.quoteWorkbook?.mutate).toBe('function');
    expect(typeof staff.workstation.prepareBookingDraft?.mutate).toBe('function');
    expect(typeof staff.workstation.listThreadQuoteRevisions?.query).toBe('function');
    expect(typeof staff.workstation.usePriorQuoteForBooking?.mutate).toBe('function');
    expect(typeof staff.workstation.getPriorStaffQuoteRequote?.query).toBe('function');
    expect(typeof staff.drafts.list?.query).toBe('function');
    expect(typeof staff.drafts.get?.query).toBe('function');
  });

  it('binds pane stay lookup and cancel routes', () => {
    expect(amendFindClientFromTrpc(client)).not.toBeNull();
    expect(amendCancelClientFromTrpc(client)).not.toBeNull();
    expect(amendCapabilitiesFromTrpc(client)).not.toBeNull();
    expect(paneStayFromTrpc(client)).toBeTruthy();
  });

  it('binds the Find in HMS party search off the real client', () => {
    expect(partyFinderFromTrpc(client)).not.toBeNull();
  });

  it('binds the saved-rate routes off the real client', () => {
    expect(savedRatesFromTrpc(client)).not.toBeNull();
  });

  it('binds the HMS approve, review and re-read routes off the real client', () => {
    expect(hmsApprovalFromTrpc(client)).not.toBeNull();
  });

  it('still refuses a missing client', () => {
    expect(quoteWorkflowFromTrpc(undefined)).toEqual({});
    expect(amendFindClientFromTrpc(null)).toBeNull();
    expect(partyFinderFromTrpc(undefined)).toBeNull();
    expect(savedRatesFromTrpc(undefined)).toBeNull();
  });
});
