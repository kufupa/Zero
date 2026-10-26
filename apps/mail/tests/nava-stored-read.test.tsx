/**
 * @vitest-environment happy-dom
 */
import { act, cleanup, render, screen } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QuoteWorkflowPanel } from '@/components/quote-workflow/quote-workflow-panel';
import type { StoredWork } from '@/lib/quote-workflow/backend-bind';
import { initialQuoteSession, reduceQuoteSession } from '@/lib/quote-workflow/session';
import type { QuoteAnalysis, QuoteSelectionBinding } from '@/lib/quote-workflow/types';
import {
  STORED_LOOKUP_TIMEOUT_MS,
  storedDecision,
  useStoredWork,
} from '@/lib/quote-workflow/use-work-item';

const ANALYSIS: QuoteAnalysis = {
  intent: 'quote',
  groups: [
    {
      id: 'stay-1',
      arrivalDate: '2026-11-03',
      departureDate: '2026-11-05',
      quantity: 1,
      adults: 2,
      childrenAges: [],
      board: 'bb',
      specialRequests: [],
      fields: {},
    },
  ],
  secondaryAsks: [],
  alternatives: [],
};

const STORED_READY = {
  status: 'ready',
  kind: 'quote',
  workItemId: 'work-item-1',
  workItemStatus: 'needs_you',
  extractionId: 'extraction-1',
  refs: {},
  analysis: ANALYSIS,
  contact: { name: null, company: null, endClient: null, email: null, phone: null },
  language: null,
  translation: null,
} as unknown as Extract<StoredWork, { status: 'ready' }>;

const BINDING: QuoteSelectionBinding = {
  transportId: 'test-mailbox',
  mailboxEmail: 'nava-test@example.invalid',
  storeId: 'test-store',
  folderEntryId: 'test-inbox',
  entryId: 'test-entry',
  internetMessageId: 'test-message',
  selectionEpoch: 1,
  scopeEpoch: 1,
};

const liveRead = vi.fn();

function StoredReadHost({ trpc }: { trpc: unknown }) {
  const storedWork = useStoredWork({ trpc, internetMessageId: 'test-message' });
  const [session, setSession] = useState(() =>
    reduceQuoteSession(initialQuoteSession(), { type: 'selection', binding: BINDING }),
  );

  useEffect(() => {
    const decision = storedDecision(storedWork.pane, false);
    setSession((current) => reduceQuoteSession(current, { type: 'analysis_started' }));
    if (decision.kind === 'ready') {
      setSession((current) => reduceQuoteSession(current, { type: 'analysis_ready', analysis: decision.analysis }));
    } else if (decision.kind === 'failed') {
      setSession((current) => reduceQuoteSession(current, { type: 'analysis_failed', message: decision.reason }));
    } else if (decision.kind === 'live') {
      liveRead();
    }
    // The production host uses this same stable gate: pane is represented by its lookup key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storedWork.key]);

  return <QuoteWorkflowPanel session={session} paneConfig={null} makeQuote={false} />;
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  liveRead.mockClear();
});

describe('late stored quote reads', () => {
  it('renders a late stored result without starting another live read', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let resolveStored!: (stored: typeof STORED_READY) => void;
    const pendingStored = new Promise<typeof STORED_READY>((resolve) => {
      resolveStored = resolve;
    });
    const query = vi.fn(() => pendingStored);
    const trpc = { workItems: { getByMessage: { query } } };

    render(<StoredReadHost trpc={trpc} />);
    expect(liveRead).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(STORED_LOOKUP_TIMEOUT_MS);
    });
    expect(liveRead).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveStored(STORED_READY);
      await pendingStored;
      await Promise.resolve();
    });

    expect((screen.getAllByLabelText(/Arrival/i)[0] as HTMLInputElement).value).toBe('2026-11-03');
    expect(liveRead).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledTimes(1);
  });
});
