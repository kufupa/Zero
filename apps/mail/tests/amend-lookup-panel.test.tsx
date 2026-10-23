/**
 * @vitest-environment happy-dom
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AmendLookupPanel } from '../components/quote-workflow/amend-lookup-panel';
import { initialQuoteSession, reduceQuoteSession } from '../lib/quote-workflow/session';
import type { QuoteAmendment, QuoteSession } from '../lib/quote-workflow/types';

afterEach(() => {
  cleanup();
});

const THREAD = 'thread-saved-stay';
const CONF_ONE = '46184891-1';
const CONF_TWO = '57291630-1';
const STAY_ONE = 's_aaaa1111';
const STAY_TWO = 's_cccc2222';

const AMEND: QuoteAmendment = {
  kind: 'amend',
  confirmationNumber: null,
  guestLastName: 'Labtest',
  arrival: '2027-10-12',
  departure: '2027-10-14',
  requestedChange: 'Move the stay by two nights',
};

function sessionWith(amendment: QuoteAmendment | null): QuoteSession {
  let session = reduceQuoteSession(initialQuoteSession(), {
    type: 'selection',
    binding: {
      transportId: 't1',
      mailboxEmail: 'centurion@legacyhotels.co.za',
      storeId: 'store',
      folderEntryId: 'inbox',
      entryId: 'e1',
      selectionEpoch: 7,
      scopeEpoch: 1,
    },
  });
  session = reduceQuoteSession(session, {
    type: 'analysis_ready',
    analysis: { intent: 'other', groups: [], secondaryAsks: [], alternatives: [], amendment },
  });
  return reduceQuoteSession(session, {
    type: 'staff_source_ready',
    source: { messageId: 'msg-1', threadId: THREAD, sourceHash: 'a'.repeat(64) },
  });
}

function lookupTrpc(findStay: ReturnType<typeof vi.fn>) {
  const jobs = new Map<string, { runId: string; request: { kind: 'find'; confirmation: string } }>();
  let issued = 0;
  const queueFind = vi.fn(async (input: { confirmation: string; autoStart?: true }) => {
    if (input.autoStart) return { runId: null };
    const runId = `run-${++issued}`;
    jobs.set(runId, { runId, request: { kind: 'find', confirmation: input.confirmation } });
    await findStay({ confirmation: input.confirmation });
    return { runId };
  });
  return {
    paneStayLookup: {
      queueFind: { mutate: queueFind },
      queueSearchGuest: { mutate: vi.fn() },
      jobStatus: { query: async () => null },
      screenshot: { query: vi.fn().mockResolvedValue({ status: 'unavailable', reason: 'screenshot_unavailable' }) },
    },
    brain: {
      getCapabilities: { query: async () => ({ paneSave: false, paneSaveMode: 'off' }) },
    },
    queueFind,
  };
}

const SAVED_TWO = {
  [STAY_ONE]: { confirmationNumber: CONF_ONE, status: 'booked' as const, screenshotRef: null },
  [STAY_TWO]: { confirmationNumber: CONF_TWO, status: 'booked' as const, screenshotRef: null },
};

describe('AmendLookupPanel saved stays', () => {
  it('lists saved confirmations and waits for a pick instead of a blank lookup', () => {
    const findStay = vi.fn();
    render(
      <AmendLookupPanel session={sessionWith(AMEND)} trpc={lookupTrpc(findStay)} savedStays={SAVED_TWO} />,
    );
    const list = screen.getByTestId('amend-saved-stays');
    expect(list.textContent).toContain(CONF_ONE);
    expect(list.textContent).toContain(CONF_TWO);
    expect(screen.queryByRole('button', { name: 'Find this booking in HMS' })).toBeNull();
    expect(findStay).not.toHaveBeenCalled();
  });

  it('looks up the chosen saved stay and leaves the other confirmation unused', async () => {
    const findStay = vi.fn(async () => ({ outcome: 'found', stay: null, screenshots: [], runId: null }));
    const trpc = lookupTrpc(findStay);
    render(<AmendLookupPanel session={sessionWith(AMEND)} trpc={trpc} savedStays={SAVED_TWO} />);
    fireEvent.click(screen.getByRole('button', { name: CONF_TWO }));
    await waitFor(() => expect(trpc.queueFind).toHaveBeenCalled());
    expect(trpc.queueFind.mock.calls.some((call) => call[0]?.confirmation === CONF_TWO)).toBe(true);
    expect(trpc.queueFind.mock.calls.some((call) => call[0]?.confirmation === CONF_ONE)).toBe(false);
  });

  it('uses the one saved confirmation when the email has no booking number', () => {
    const findStay = vi.fn();
    render(
      <AmendLookupPanel
        session={sessionWith(AMEND)}
        trpc={lookupTrpc(findStay)}
        savedStays={{ [STAY_ONE]: { confirmationNumber: CONF_ONE, status: 'booked', screenshotRef: null } }}
      />,
    );
    expect(screen.getByRole('button', { name: CONF_ONE })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Find this booking in HMS' })).toBeTruthy();
  });

  it('hides the picker when the work item has no saved confirmation', () => {
    render(<AmendLookupPanel session={sessionWith(AMEND)} trpc={lookupTrpc(vi.fn())} />);
    expect(screen.queryByTestId('amend-saved-stays')).toBeNull();
  });
});
