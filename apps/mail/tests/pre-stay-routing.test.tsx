import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { WorkflowBadge } from '../components/quote-workflow/workflow-badge';
import type { QuoteAnalysis } from '../lib/quote-workflow/types';
import {
  canOfferQuoteWorkflow,
  ownMailboxPreStayConfirmation,
  quoteOrBookingWorkflow,
  readAsForAnalysis,
} from '../lib/quote-workflow/workflow-vocabulary';

const MAILBOX = 'reservations@example.test';
const SUBJECT = 'Pre Stay : Property Sample Confirmation No 12345678 Guestname';

const quoteAnalysis = {
  status: 'ready',
  intent: 'quote',
  groups: [],
  secondaryAsks: [],
  alternatives: [],
  sourceRevision: 1,
  luna: {
    workflow: 'create_booking',
    flags: [],
    groups: [],
    party: { kind: null, name: null, reference: null },
    rateClaims: [],
    missing: [],
    evidence: [],
    tasks: [],
  },
} as unknown as QuoteAnalysis;

describe('self-sent pre-stay selected-email routing', () => {
  it('overrides quote and create-booking analysis with existing-stay read-as and no quote controls', () => {
    const confirmation = ownMailboxPreStayConfirmation(
      `Reservations <${MAILBOX}>`,
      MAILBOX.toUpperCase(),
      SUBJECT,
    );
    const readAs = readAsForAnalysis(quoteAnalysis, {
      kind: 'quote',
      treatAs: 'create_booking',
      ownMailboxPreStay: confirmation !== null,
    });

    expect(confirmation).toBe('12345678');
    expect(readAs).toBe('existing_stay');
    expect(canOfferQuoteWorkflow(readAs)).toBe(false);
    expect(quoteOrBookingWorkflow(quoteAnalysis, 'quote', { ownMailboxPreStay: true })).toBeNull();

    render(
      <WorkflowBadge
        analysis={quoteAnalysis}
        kind="quote"
        treatAs="create_booking"
        readAs={readAs}
        onIntentChange={vi.fn()}
      />,
    );

    expect(screen.getByRole('status', { name: 'Nava reads this as: Existing stay / pre-arrival info' })).toBeTruthy();
    expect(screen.queryByLabelText('Change how Nava reads this email')).toBeNull();
  });

  it('does not grant the existing-stay read-as to a guest sender', () => {
    expect(
      ownMailboxPreStayConfirmation('guest@example.test', MAILBOX, SUBJECT),
    ).toBeNull();
  });

  it('does not grant the existing-stay read-as without a confirmation number', () => {
    expect(
      ownMailboxPreStayConfirmation(
        MAILBOX,
        MAILBOX,
        'Pre Stay : Property Sample Guestname',
      ),
    ).toBeNull();
  });
});
