import { describe, expect, it } from 'vitest';
import { createTRPCClient, httpBatchLink } from '@trpc/client';
import type { AppRouter } from '@zero/server/trpc';
import superjson from 'superjson';
import { quoteWorkflowFromTrpc } from '../lib/quote-workflow/backend-bind';
import { staffQuoteFromTrpc } from '../lib/quote-workflow/staff-quote-bind';
import { paneStayFromTrpc } from '../lib/quote-workflow/pane-stay-bind';
import { amendCancelClientFromTrpc, amendCapabilitiesFromTrpc } from '../lib/quote-workflow/amend-cancel';
import { amendFindClientFromTrpc } from '../lib/quote-workflow/amend-find';
import { partyFinderFromTrpc } from '../lib/quote-workflow/party-lookup';
import { savedRatesFromTrpc } from '../components/quote-workflow/rate-controls';

// The pane passes the real tRPC client, which is a function-backed proxy (typeof 'function').
// Plain-object mocks hid the bug where every helper returned empty routes in production.
const client = createTRPCClient<AppRouter>({
  links: [httpBatchLink({ url: 'https://pane.invalid/api/trpc', transformer: superjson })],
});

describe('pane tRPC helpers bind routes off the real client', () => {
  it('reaches quoteWorkflow.analyseSelection', () => {
    expect(typeof quoteWorkflowFromTrpc(client).analyseSelection?.mutate).toBe('function');
  });

  it('reaches workstation quote, PDF and drafts routes', () => {
    const staff = staffQuoteFromTrpc(client);
    expect(typeof staff.workstation.executeStaffQuote?.mutate).toBe('function');
    expect(staff.drafts).toBeTruthy();
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

  it('still refuses a missing client', () => {
    expect(quoteWorkflowFromTrpc(undefined)).toEqual({});
    expect(amendFindClientFromTrpc(null)).toBeNull();
    expect(partyFinderFromTrpc(undefined)).toBeNull();
    expect(savedRatesFromTrpc(undefined)).toBeNull();
  });
});
