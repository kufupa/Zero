/**
 * @vitest-environment happy-dom
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BookingVoucherCard } from '../components/nava-pane/blocks/booking-voucher-card';
import { QuoteWorkflowPanel } from '../components/quote-workflow/quote-workflow-panel';
import { HmsTodoCard, type HmsTodoCardPayload } from '../components/quote-workflow/hms-todo-card';
import { initialQuoteSession } from '../lib/quote-workflow/session';
import type { QuoteSession } from '../lib/quote-workflow/types';

vi.mock('@/providers/query-provider', () => ({
  trpcClient: {},
}));

afterEach(() => cleanup());

const NEW_BOOKING: HmsTodoCardPayload = {
  kind: 'new_booking',
  title: 'Key into HMS',
  writesEnabled: false,
  missing: ['Rooms'],
  steps: [
    { label: 'Arrival', value: '2026-11-12', source: 'mail' },
    { label: 'Departure', value: '2026-11-14', source: 'mail' },
    { label: 'Rooms', value: null, source: 'missing' },
    { label: 'Adults', value: '2', source: 'mail' },
    { label: 'Guest last name', value: 'Example', source: 'mail' },
  ],
};

/** Outlook NavaPane quoting-tool tree: QuoteWorkflowPanel then BookingVoucherCard. */
function outlookNavaPaneTree(session: QuoteSession) {
  return (
    <>
      <QuoteWorkflowPanel session={session} />
      <BookingVoucherCard
        session={session}
        internetMessageId={null}
        syncCommitted={null}
        syncPending={false}
      />
    </>
  );
}

function bookingSessionWithCard(): QuoteSession {
  return {
    ...initialQuoteSession(),
    phase: 'non_quote',
    analysis: {
      intent: 'other',
      groups: [],
      secondaryAsks: [],
      alternatives: [],
      hmsTodoCard: NEW_BOOKING,
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
    },
  };
}

describe('HmsTodoCard', () => {
  it('renders a new_booking card as Key into HMS steps with Missing for empty values', () => {
    render(<HmsTodoCard card={NEW_BOOKING} />);

    expect(screen.getByRole('heading', { name: 'Key into HMS' })).toBeDefined();
    expect(screen.getByText('Arrival')).toBeDefined();
    expect(screen.getByText('2026-11-12')).toBeDefined();
    expect(screen.getByText('Departure')).toBeDefined();
    expect(screen.getByText('2026-11-14')).toBeDefined();
    expect(screen.getByText('Rooms')).toBeDefined();
    expect(screen.getByText('Missing')).toBeDefined();
    expect(screen.getByText('Adults')).toBeDefined();
    expect(screen.getByText('2')).toBeDefined();
    expect(screen.getByText('Guest last name')).toBeDefined();
    expect(screen.getByText('Example')).toBeDefined();
    expect(screen.getByText('Nava does not write to HMS')).toBeDefined();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByText('Rooms')).not.toBeNull();
    expect(document.querySelectorAll('[class*="amber"]').length).toBe(0);
  });

  it('renders nothing when the card is null', () => {
    const { container } = render(<HmsTodoCard card={null} />);
    expect(container.innerHTML).toBe('');
  });
});

describe('Outlook NavaPane tree', () => {
  it('shows Key into HMS once when analysis returns a to-do card', () => {
    render(outlookNavaPaneTree(bookingSessionWithCard()));
    expect(screen.getAllByRole('heading', { name: 'Key into HMS' })).toHaveLength(1);
  });
});
