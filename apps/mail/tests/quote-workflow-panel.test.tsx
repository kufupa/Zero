/**
 * @vitest-environment happy-dom
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QuoteWorkflowPanel } from '../components/quote-workflow/quote-workflow-panel';
import { loadQuoteFixture } from '../lib/quote-workflow/fixtures';
import { initialQuoteSession, reduceQuoteSession } from '../lib/quote-workflow/session';
import type { QuoteSession } from '../lib/quote-workflow/types';

afterEach(() => cleanup());

function sessionFromFixture(id: Parameters<typeof loadQuoteFixture>[0]): QuoteSession {
  const fixture = loadQuoteFixture(id);
  let session = reduceQuoteSession(initialQuoteSession(), {
    type: 'selection',
    binding: {
      transportId: 't1',
      mailboxEmail: 'centurion@legacyhotels.co.za',
      storeId: 'store',
      folderEntryId: 'inbox',
      entryId: 'e1',
      selectionEpoch: 1,
      scopeEpoch: 1,
    },
  });
  if (fixture.phase === 'missing_source') {
    return reduceQuoteSession(session, {
      type: 'analysis_missing_source',
      missing: fixture.missing ?? [],
    });
  }
  if (fixture.phase === 'unsupported') {
    return reduceQuoteSession(session, { type: 'analysis_unsupported', message: 'Unsupported request' });
  }
  if (fixture.phase === 'failed') {
    return reduceQuoteSession(session, { type: 'analysis_failed', message: 'Source failed' });
  }
  session = reduceQuoteSession(session, {
    type: 'analysis_ready',
    analysis: {
      intent: 'quote',
      groups: fixture.groups,
      secondaryAsks: fixture.secondaryAsks,
      alternatives: fixture.alternatives,
    },
  });
  if (fixture.offers.length) {
    session = reduceQuoteSession(session, { type: 'results_ready', offers: fixture.offers });
  }
  return session;
}

describe('QuoteWorkflowPanel', () => {
  it('shows analysing, unsynced, missing-source, failed, unsupported, and non-quote states', () => {
    const start = initialQuoteSession();
    render(<QuoteWorkflowPanel session={{ ...start, phase: 'analysing' }} />);
    expect(screen.getByText(/Analysing selected email/i)).toBeDefined();
    cleanup();
    render(<QuoteWorkflowPanel session={{ ...start, phase: 'unsynced' }} />);
    expect(screen.getByText(/not synced/i)).toBeDefined();
    cleanup();
    render(<QuoteWorkflowPanel session={sessionFromFixture('attachment-dependent')} />);
    expect(screen.getByText(/authorised attachment content is missing/i)).toBeDefined();
    expect(screen.queryByText(/rooming-list\.pdf is the document/i)).toBeNull();
    cleanup();
    render(<QuoteWorkflowPanel session={sessionFromFixture('source-failure')} />);
    expect(screen.getByText(/Source failed/i)).toBeDefined();
    cleanup();
    render(<QuoteWorkflowPanel session={sessionFromFixture('unsupported')} />);
    expect(screen.getByText(/Unsupported request/i)).toBeDefined();
    cleanup();
    render(
      <QuoteWorkflowPanel
        session={reduceQuoteSession(reduceQuoteSession(initialQuoteSession(), {
          type: 'selection',
          binding: {
            transportId: 't1',
            mailboxEmail: 'centurion@legacyhotels.co.za',
            storeId: 's',
            folderEntryId: 'f',
            entryId: 'e',
            selectionEpoch: 1,
            scopeEpoch: 1,
          },
        }), { type: 'analysis_ready', analysis: { intent: 'other', groups: [], secondaryAsks: [], alternatives: [] } })}
      />,
    );
    expect(screen.getByText(/not a quoting request/i)).toBeDefined();
    expect(screen.queryByRole('button', { name: /Run next/i })).toBeNull();
  });

  it('renders one editable card per stay group with month and year dates', () => {
    const onPatchGroup = vi.fn();
    render(
      <QuoteWorkflowPanel session={sessionFromFixture('mixed-same-dates')} onPatchGroup={onPatchGroup} />,
    );
    const arrivals = screen.getAllByLabelText(/Arrival/i);
    expect(arrivals).toHaveLength(2);
    expect((arrivals[0] as HTMLInputElement).value).toBe('2026-10-16');
    fireEvent.change(screen.getAllByLabelText(/Adults/i)[0]!, { target: { value: '3' } });
    expect(onPatchGroup).toHaveBeenCalledWith('g-double', expect.objectContaining({ adults: 3 }));
  });

  it('labels missing fields and extracted provenance', () => {
    render(<QuoteWorkflowPanel session={sessionFromFixture('missing-fields')} />);
    expect(screen.getAllByText('Missing').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Extracted').length).toBeGreaterThan(0);
  });

  it('runs next only when not already running, and shows retry guidance on failure', () => {
    const onRunNext = vi.fn();
    let session = sessionFromFixture('failed-run');
    session = { ...session, steps: [{
      id: 'quote-1',
      kind: 'quote_stay',
      title: 'Search availability for 12–14 Nov',
      inputs: {},
      dependsOn: [],
      status: 'failed',
      retryGuidance: sessionFromFixture('failed-run').errorMessage ??
        'The read failed before a quote result was stored. Approve the same step again; do not assume inventory is held.',
    }], phase: 'tools' };
    render(<QuoteWorkflowPanel session={session} onRunNext={onRunNext} />);
    expect(screen.getByText(/do not assume inventory is held/i)).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: /Run next/i }));
    expect(onRunNext).toHaveBeenCalledTimes(1);
  });

  it('does not sum alternatives and shows honest missing screenshots', () => {
    render(<QuoteWorkflowPanel session={sessionFromFixture('ro-vs-bb')} />);
    expect(screen.getByText(/not included in the selected allocation total/i)).toBeDefined();
    expect(screen.getAllByText(/No authorised screenshot is tied to this tool run/i).length).toBeGreaterThan(0);
  });

  it('labels mailbox analyseSelection unsynced while keeping local requirement cards', () => {
    const session = { ...sessionFromFixture('public-single'), mailboxStatus: 'unsynced' as const };
    render(<QuoteWorkflowPanel session={session} />);
    expect(screen.getByText(/Mailbox quoteWorkflow.analyseSelection: unsynced/i)).toBeDefined();
    expect(screen.getAllByLabelText(/Arrival/i).length).toBeGreaterThan(0);
  });
});
