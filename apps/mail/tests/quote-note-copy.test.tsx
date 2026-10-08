/**
 * @vitest-environment happy-dom
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
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

  it('sends staff to the Quote header for extras, not to add them by hand', () => {
    render(<NotSupportedList flags={['extras']} />);
    expect(screen.getByText(/set them in the Quote header before you make the PDF/)).toBeDefined();
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
    expect(screen.getByText(/Create one reply with all date options puts them in one draft/)).toBeDefined();
  });

  it('says the draft attaches each option PDF through the combined reply', () => {
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
    expect(screen.getByText(/Create one reply with all date options attaches each option's PDF/)).toBeDefined();
  });
});
