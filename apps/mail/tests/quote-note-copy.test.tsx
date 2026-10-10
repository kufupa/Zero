/**
 * @vitest-environment happy-dom
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DocumentReview } from '../components/quote-workflow/document-review';
import { AMENDMENT_PANEL_COPY, NotSupportedList } from '../components/quote-workflow/not-supported-list';
import { QuoteWorkflowPanel } from '../components/quote-workflow/quote-workflow-panel';
import { fixtureResultsReady, loadQuoteFixture } from '../lib/quote-workflow/fixtures';
import { initialQuoteSession, reduceQuoteSession } from '../lib/quote-workflow/session';
import type { LunaAnalysisWire, QuoteAmendment, QuoteAnalysis } from '../lib/quote-workflow/types';

const NOT_SUPPORTED = 'Changing or cancelling a booking is not supported yet. Handle it by hand in HMS.';

const AMEND: QuoteAmendment = {
  kind: 'amend',
  confirmationNumber: '90000-1',
  guestLastName: 'Guest',
  arrival: '2026-11-12',
  departure: '2026-11-15',
  requestedChange: 'Arrive one night later',
};

function luna(flags: LunaAnalysisWire['flags']): LunaAnalysisWire {
  return {
    workflow: 'other',
    flags,
    groups: [],
    party: { kind: null, name: null, reference: null },
    rateClaims: [],
    missing: [],
    evidence: [],
    tasks: [],
  };
}

afterEach(() => cleanup());

describe('NotSupportedList', () => {
  it('points at the panel instead of saying not supported when an amendment is set', () => {
    render(<NotSupportedList flags={['amendment_or_cancel']} amendment={AMEND} />);
    expect(screen.getByText(AMENDMENT_PANEL_COPY)).toBeDefined();
    expect(screen.queryByText(NOT_SUPPORTED)).toBeNull();
  });

  it('keeps the not-supported copy when there is no amendment', () => {
    render(<NotSupportedList flags={['amendment_or_cancel']} amendment={null} />);
    expect(screen.getByText(NOT_SUPPORTED)).toBeDefined();
    expect(screen.queryByText(AMENDMENT_PANEL_COPY)).toBeNull();
  });

  it('sends staff to the Extras section for extras, not to add them by hand', () => {
    render(<NotSupportedList flags={['extras']} />);
    expect(screen.getByText(/set them under Extras in Stay details before you make the PDF/)).toBeDefined();
    expect(screen.queryByText(/add these by hand/)).toBeNull();
  });
});

describe('quote panel notes', () => {
  it('drops the not-supported copy from the amber list when the change panel is shown', () => {
    const analysis = {
      intent: 'other',
      groups: [],
      secondaryAsks: [],
      alternatives: [],
      luna: luna(['amendment_or_cancel']),
      amendment: AMEND,
    } as QuoteAnalysis;
    const session = reduceQuoteSession(initialQuoteSession(), { type: 'analysis_ready', analysis } as never);
    render(<QuoteWorkflowPanel session={session} />);
    expect(screen.getByText(AMENDMENT_PANEL_COPY)).toBeDefined();
    expect(screen.queryByText(NOT_SUPPORTED)).toBeNull();
  });

  it('describes the combined reply, not a blocked PDF, for several date options', () => {
    const fixture = loadQuoteFixture('staggered-dates');
    let session = reduceQuoteSession(initialQuoteSession(), {
      type: 'analysis_ready',
      analysis: {
        intent: 'quote',
        groups: fixture.groups,
        secondaryAsks: fixture.secondaryAsks,
        alternatives: fixture.alternatives,
      },
    } as never);
    session = reduceQuoteSession(session, fixtureResultsReady(fixture.offers) as never);
    render(<QuoteWorkflowPanel session={session} />);
    expect(screen.queryByText(/combined PDF is blocked/)).toBeNull();
    expect(screen.getByText(/Every date option goes into one quote/)).toBeDefined();
  });

  it('says a single stay draft attaches its own PDF, not one per option', () => {
    const session = {
      ...initialQuoteSession(),
      pdf: {
        fileName: 'Quote-option-A.pdf',
        bytesBase64: 'AA==',
        pdfHash: 'a'.repeat(64),
        revisionId: 'rev-a',
        totalMinor: 100,
      },
    } as never;
    render(<DocumentReview session={session} />);
    expect(screen.getByText(/Prepared PDF Quote-option-A\.pdf\./)).toBeDefined();
    expect(screen.getByText(/The Outlook draft will attach this exact file\./)).toBeDefined();
    expect(screen.queryByText(/attaches each option's PDF/)).toBeNull();
  });
});

describe('the HMS no-building check on the quote documents', () => {
  const run = (jointRoomsChecked?: boolean) => ({
    revisionRef: 'rev-a',
    quoteRequestKey: '2026-11-12:2026-11-14',
    poolBasis: 'property_room_type',
    ...(jointRoomsChecked === undefined ? {} : { jointRoomsChecked }),
  });
  const session = (quote: object | null) =>
    ({
      ...initialQuoteSession(),
      selectedStayKey: '2026-11-12:2026-11-14',
      staffQuote: quote,
      staffQuotes: quote ? { '2026-11-12:2026-11-14': quote } : {},
    }) as never;

  it('shows the caution and a tick that reports the run it is for', () => {
    const onJointRoomsChecked = vi.fn();
    render(<DocumentReview session={session(run())} onJointRoomsChecked={onJointRoomsChecked} />);
    expect(
      screen.getByText('HMS has no building for these rooms. Check in HMS that they can be booked together before you send.'),
    ).toBeDefined();
    const tick = screen.getByRole('checkbox', { name: 'I checked these rooms together in HMS' }) as HTMLInputElement;
    expect(tick.checked).toBe(false);
    fireEvent.click(tick);
    expect(onJointRoomsChecked).toHaveBeenCalledWith('rev-a', true);
  });

  it('shows the tick as given, and nothing for a run HMS did not flag', () => {
    render(<DocumentReview session={session(run(true))} />);
    expect((screen.getByRole('checkbox', { name: 'I checked these rooms together in HMS' }) as HTMLInputElement).checked).toBe(
      true,
    );
    cleanup();
    render(<DocumentReview session={session({ ...run(), poolBasis: undefined })} />);
    expect(screen.queryByText(/HMS has no building/)).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });
});
