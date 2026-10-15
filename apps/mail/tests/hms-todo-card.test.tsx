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

const FORWARD_CARD: HmsTodoCardPayload = {
  kind: 'forward_to_partner',
  title: 'Forward to Events',
  writesEnabled: false,
  missing: [],
  steps: [
    { label: 'Reason', value: 'Mail belongs to another team, property or partner.', source: 'mail' },
    {
      label: 'Next step',
      value: 'Staff forwards or redirects it. Nava does not send it.',
      source: 'mail',
    },
  ],
};

function sessionWithCard(card: HmsTodoCardPayload): QuoteSession {
  return {
    ...bookingSessionWithCard(),
    analysis: {
      ...bookingSessionWithCard().analysis!,
      hmsTodoCard: card,
      luna: {
        ...bookingSessionWithCard().analysis!.luna!,
        workflow: 'other',
      },
    },
  };
}

/** Webmail panel quoting-tool tree: same QuoteWorkflowPanel host as NavaPane preview. */
function webmailPanelTree(session: QuoteSession) {
  return <QuoteWorkflowPanel session={session} />;
}

describe('named move cards', () => {
  it('renders Forward to team, Attach invoice/folio and Record payment with no send or write controls', () => {
    render(<HmsTodoCard card={FORWARD_CARD} />);
    expect(screen.getByRole('heading', { name: 'Forward to Events' })).toBeDefined();
    expect(screen.getByText('Mail belongs to another team, property or partner.')).toBeDefined();
    expect(screen.getByText('Staff forwards or redirects it. Nava does not send it.')).toBeDefined();
    expect(screen.queryByRole('button')).toBeNull();
    expect(document.querySelectorAll('[class*="amber"]').length).toBe(0);

    cleanup();
    render(
      <HmsTodoCard
        card={{
          kind: 'send_document',
          title: 'Attach invoice/folio',
          writesEnabled: false,
          missing: [],
          steps: [
            { label: 'Reason', value: 'Guest asked for an invoice, folio, proforma or statement.', source: 'mail' },
            { label: 'Next step', value: 'Staff attaches the document. Nava does not send it.', source: 'mail' },
            { label: 'Document', value: 'folio', source: 'mail' },
          ],
        }}
      />,
    );
    expect(screen.getByRole('heading', { name: 'Attach invoice/folio' })).toBeDefined();
    expect(screen.queryByRole('button')).toBeNull();

    cleanup();
    render(
      <HmsTodoCard
        card={{
          kind: 'payment_ack',
          title: 'Record payment',
          writesEnabled: false,
          missing: [],
          steps: [
            { label: 'Reason', value: 'Guest sent proof of payment.', source: 'mail' },
            { label: 'Next step', value: 'Staff records the payment in HMS. Nava does not post it.', source: 'mail' },
          ],
        }}
      />,
    );
    expect(screen.getByRole('heading', { name: 'Record payment' })).toBeDefined();
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('Outlook pane and webmail panel', () => {
  it('shows the named move card once on the Outlook pane tree', () => {
    render(outlookNavaPaneTree(sessionWithCard(FORWARD_CARD)));
    expect(screen.getAllByRole('heading', { name: 'Forward to Events' })).toHaveLength(1);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('shows the named move card once on the webmail panel', () => {
    render(webmailPanelTree(sessionWithCard(FORWARD_CARD)));
    expect(screen.getAllByRole('heading', { name: 'Forward to Events' })).toHaveLength(1);
    expect(screen.queryByRole('button')).toBeNull();
  });
});
