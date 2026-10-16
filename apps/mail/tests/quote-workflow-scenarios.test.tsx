/**
 * @vitest-environment happy-dom
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { QuoteWorkflowPanel } from '../components/quote-workflow/quote-workflow-panel';
import { fixtureResultsReady, loadQuoteFixture } from '../lib/quote-workflow/fixtures';
import { initialQuoteSession, reduceQuoteSession } from '../lib/quote-workflow/session';
import type { QuoteFixtureId } from '../lib/quote-workflow/fixtures';
import type { QuoteSession } from '../lib/quote-workflow/types';

afterEach(() => cleanup());

function bind() {
  return {
    transportId: 't1',
    mailboxEmail: 'centurion@legacyhotels.co.za',
    storeId: 'store',
    folderEntryId: 'inbox',
    entryId: 'e1',
    selectionEpoch: 1,
    scopeEpoch: 1,
  };
}

function sessionFromFixture(id: QuoteFixtureId): QuoteSession {
  const fixture = loadQuoteFixture(id);
  let session = reduceQuoteSession(initialQuoteSession(), { type: 'selection', binding: bind() });
  if (fixture.phase === 'missing_source') {
    return reduceQuoteSession(session, { type: 'analysis_missing_source', missing: fixture.missing ?? [] });
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
    session = reduceQuoteSession(session, fixtureResultsReady(fixture.offers, {
      reviewedReplyHtml: fixture.reviewedReplyHtml,
    }));
  }
  return session;
}

const SCENARIOS: QuoteFixtureId[] = [
  'public-single',
  'agency-contract',
  'mixed-same-dates',
  'staggered-dates',
  'varying-nights',
  'ro-vs-bb',
  'attachment-dependent',
  'missing-fields',
  'unsupported',
  'source-failure',
  'staff-invalidate',
  'failed-run',
  'uncertain-native',
];

describe('quote workflow scenario matrix', () => {
  for (const id of SCENARIOS) {
    it(`renders ${id} without inventing live HMS proof`, () => {
      render(<QuoteWorkflowPanel session={sessionFromFixture(id)} />);
      expect(screen.queryByText(/Audit Saved/i)).toBeNull();
      expect(document.body.textContent).not.toMatch(/Hermes demo rate/i);
    });
  }

  it('does not sum RO and BB alternatives as one booking', () => {
    const session = sessionFromFixture('ro-vs-bb');
    session.selectedOfferIds = ['bb-1'];
    render(<QuoteWorkflowPanel session={session} />);
    const subtotal = screen.getByText('Stay subtotal').parentElement?.textContent ?? '';
    const body = document.body.textContent ?? '';
    expect(subtotal.replace(/\s/g, '')).toContain('R2140,00');
    expect(body.replace(/\s/g, '')).not.toContain('R4040,00');
    expect(body).toMatch(/Alternative — not counted in the total/);
  });

  it('shows separate stay subtotals and the combined selected total across date options', () => {
    const session = sessionFromFixture('staggered-dates');
    session.selectedOfferIds = session.offers.map((offer) => offer.id);
    render(<QuoteWorkflowPanel session={session} />);
    const subtotals = screen.getAllByText('Stay subtotal').map((label) => label.parentElement?.textContent ?? '');
    expect(subtotals).toHaveLength(2);
    expect(subtotals.every((subtotal) => subtotal.replace(/\s/g, '').includes('R2720,00'))).toBe(true);
    expect(screen.getByLabelText('Quotation total').textContent?.replace(/\s/g, '')).toContain('R5440,00');
    expect(screen.queryByText(/do not prove that all stays are available together/i)).toBeNull();
  });

  it('expands varying nightly prices', () => {
    render(<QuoteWorkflowPanel session={sessionFromFixture('varying-nights')} />);
    expect(screen.getByText(/Nightly breakdown/i)).toBeDefined();
  });

  it('blocks PDF until an evidenced allocation is selected', () => {
    render(<QuoteWorkflowPanel session={sessionFromFixture('public-single')} />);
    expect(screen.getByRole('button', { name: /^Prepare PDF$/i }).hasAttribute('disabled')).toBe(true);
  });

  it('staff edits invalidate results in the session used by the panel', () => {
    let session = sessionFromFixture('staff-invalidate');
    session = reduceQuoteSession(session, { type: 'select_offers', offerIds: ['inv-1'] });
    expect(session.offers.length).toBeGreaterThan(0);
    session = reduceQuoteSession(session, { type: 'patch_group', groupId: 'g1', patch: { adults: 2 } });
    expect(session.offers).toEqual([]);
    expect(session.pdf).toBeNull();
  });

  it('keeps secondary answers in the reviewed reply for native insert', () => {
    render(<QuoteWorkflowPanel session={sessionFromFixture('uncertain-native')} />);
    expect(screen.getByLabelText(/Reviewed reply/i).innerHTML).toContain('Parking is available on site.');
  });
});
