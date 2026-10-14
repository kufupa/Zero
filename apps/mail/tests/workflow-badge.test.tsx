/**
 * @vitest-environment happy-dom
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkflowBadge } from '../components/quote-workflow/workflow-badge';
import { NAVA_READ_AS_LABEL, readAsForAnalysis, readAsForKind } from '../lib/quote-workflow/workflow-vocabulary';
import type { LunaAnalysisWire, QuoteAmendment, QuoteAnalysis } from '../lib/quote-workflow/types';

const CHANGE_HINT = 'Nava thinks the guest wants to change an existing booking.';
const CANCEL_HINT = 'Nava thinks the guest wants to cancel an existing booking.';

const AMEND: QuoteAmendment = {
  kind: 'amend',
  confirmationNumber: '90000-1',
  guestLastName: 'Sample',
  arrival: '2026-11-12',
  departure: '2026-11-15',
  requestedChange: 'Move arrival to 13 Nov',
};

function luna(workflow: LunaAnalysisWire['workflow']): LunaAnalysisWire {
  return {
    workflow,
    flags: [],
    groups: [],
    party: { kind: null, name: null, reference: null },
    rateClaims: [],
    missing: [],
    evidence: [],
    tasks: [],
  };
}

function analysis(
  workflow: LunaAnalysisWire['workflow'] | null,
  extra: Partial<QuoteAnalysis> = {},
): QuoteAnalysis {
  return {
    intent: 'other',
    groups: [],
    secondaryAsks: [],
    alternatives: [],
    luna: workflow ? luna(workflow) : null,
    ...extra,
  };
}

afterEach(() => cleanup());

describe('shared Nava read-as vocabulary', () => {
  it('maps current mail kinds into the staff-facing labels', () => {
    const cases = [
      ['quote', 'Quote'],
      ['booking', 'New booking'],
      ['amendment', 'Amendment'],
      ['cancellation', 'Cancellation'],
      ['voucher_pop', 'Payment'],
      ['billing', 'Billing'],
      ['group', 'Group'],
      ['other', 'Not for Nava'],
      ['spam', 'Not for Nava'],
      ['unknown_future_kind', 'Not for Nava'],
    ] as const;
    for (const [kind, label] of cases) {
      const readAs = readAsForKind(kind);
      expect(NAVA_READ_AS_LABEL[readAs]).toBe(label);
    }
  });

  it('uses amendment, group, payment and booking evidence before the generic quote label', () => {
    expect(readAsForAnalysis(analysis('other', { amendment: AMEND }))).toBe('amendment');
    expect(
      readAsForAnalysis(
        analysis('quote', {
          luna: luna('quote'),
        }),
      ),
    ).toBe('quote');
    const grouped = analysis('quote');
    grouped.luna!.flags.push('conference_or_group');
    expect(readAsForAnalysis(grouped)).toBe('group');
    const paid = analysis('quote');
    paid.luna!.rateClaims.push({
      kind: 'paid',
      amount: '100',
      currency: 'ZAR',
      basis: 'total',
      taxBasis: 'unknown',
      quote: 'already paid',
    });
    expect(readAsForAnalysis(paid)).toBe('payment');
    expect(readAsForAnalysis(analysis('create_booking'))).toBe('new_booking');
  });
});

describe('WorkflowBadge', () => {
  it('shows one read-as banner and a separate work-state chip', () => {
    render(<WorkflowBadge analysis={analysis('quote')} workState="queued" />);
    const banner = screen.getByRole('status', { name: 'Nava reads this as: Quote' });
    expect(banner.textContent).toContain('Nava reads this as:');
    expect(banner.querySelector('[data-read-as="quote"]')?.textContent).toBe('Quote');
    expect(banner.querySelector('[data-work-state="queued"]')?.textContent).toBe('Queued');
    expect(screen.getAllByText(/^Nava reads this as:/)).toHaveLength(1);
  });

  it('offers the supported quote and new-booking corrections in the banner', () => {
    render(<WorkflowBadge analysis={analysis('quote')} onIntentChange={() => {}} />);
    const picker = screen.getByLabelText('Change how Nava reads this email') as HTMLSelectElement;
    expect(Array.from(picker.options).map((option) => option.text)).toEqual(['Quote', 'New booking']);
  });

  it('lets staff correct a rooms-only group, defaulting its quote picker to Quote', () => {
    const grouped = analysis('quote');
    grouped.luna!.flags.push('rooms_only_group');
    const onIntentChange = vi.fn();
    render(<WorkflowBadge analysis={grouped} onIntentChange={onIntentChange} />);

    const picker = screen.getByLabelText('Change how Nava reads this email') as HTMLSelectElement;
    expect(picker.value).toBe('quote');
    fireEvent.change(picker, { target: { value: 'create_booking' } });
    expect(onIntentChange).toHaveBeenCalledWith('create_booking');
  });

  it('keeps the correction on a booking request that mentions a payment', () => {
    const paid = analysis('create_booking');
    paid.luna!.rateClaims.push({ kind: 'paid' } as NonNullable<typeof paid.luna>['rateClaims'][number]);
    const onIntentChange = vi.fn();
    render(<WorkflowBadge analysis={paid} onIntentChange={onIntentChange} />);

    expect(screen.getByText('Payment')).toBeDefined();
    const picker = screen.getByLabelText('Change how Nava reads this email') as HTMLSelectElement;
    expect(picker.value).toBe('create_booking');
    fireEvent.change(picker, { target: { value: 'quote' } });
    expect(onIntentChange).toHaveBeenCalledWith('quote');
  });

  it('reports a supported change of reading to its owner', () => {
    const onIntentChange = vi.fn();
    render(
      <WorkflowBadge
        analysis={analysis('quote')}
        onIntentChange={onIntentChange}
      />,
    );
    fireEvent.change(screen.getByLabelText('Change how Nava reads this email'), {
      target: { value: 'create_booking' },
    });
    expect(onIntentChange).toHaveBeenCalledWith('create_booking');
  });

  it.each([
    ['amend', 'amendment', 'Amendment', CHANGE_HINT],
    ['cancel', 'cancellation', 'Cancellation', CANCEL_HINT],
  ] as const)('uses one banner for a %s', (_amendmentKind, readAs, label, hint) => {
    render(
      <WorkflowBadge
        analysis={analysis('other')}
        readAs={readAs}
      />,
    );
    const banner = screen.getByRole('status', { name: `Nava reads this as: ${label}` });
    expect(banner.querySelector(`[data-read-as="${readAs}"]`)?.getAttribute('title')).toBe(hint);
    expect(screen.queryByText('Other')).toBeNull();
    expect(screen.queryByLabelText('Change how Nava reads this email')).toBeNull();
  });

  it.each([
    ['payment', 'Payment'],
    ['billing', 'Billing'],
    ['group', 'Group'],
    ['not_for_nava', 'Not for Nava'],
  ] as const)('shows %s without an override control when no action is provided', (readAs, label) => {
    render(<WorkflowBadge analysis={analysis('other')} readAs={readAs} />);
    expect(screen.getByRole('status', { name: `Nava reads this as: ${label}` })).toBeDefined();
    expect(screen.queryByLabelText('Change how Nava reads this email')).toBeNull();
  });

  it('renders nothing without a classification and keeps the low-confidence note inside the banner', () => {
    const { unmount, container } = render(<WorkflowBadge analysis={null} />);
    expect(container.textContent).toBe('');
    unmount();
    render(<WorkflowBadge analysis={analysis('other', { aiUnavailable: true })} readAs="not_for_nava" />);
    expect(screen.getByRole('status', { name: 'Nava reads this as: Not for Nava' })).toBeDefined();
    expect(screen.getByText('Read without AI')).toBeDefined();
  });
});
