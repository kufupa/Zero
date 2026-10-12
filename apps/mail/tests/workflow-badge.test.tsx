/**
 * @vitest-environment happy-dom
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QuoteWorkflowPanel } from '../components/quote-workflow/quote-workflow-panel';
import { WorkflowBadge } from '../components/quote-workflow/workflow-badge';
import { initialQuoteSession, reduceQuoteSession } from '../lib/quote-workflow/session';
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

describe('WorkflowBadge', () => {
  it('shows the reading as the selected type when no amendment is given', () => {
    const cases = [
      ['quote', 'Quote request'],
      ['create_booking', 'Booking'],
      ['other', 'Other'],
    ] as const;
    for (const [intent, text] of cases) {
      const { unmount } = render(<WorkflowBadge analysis={analysis(intent)} intent={intent} />);
      const picker = screen.getByLabelText('Nava reads this as') as HTMLSelectElement;
      expect(picker.value).toBe(intent);
      expect(picker.options[picker.selectedIndex]?.text).toBe(text);
      expect(screen.queryByText('Amendment')).toBeNull();
      expect(screen.queryByText('Cancellation')).toBeNull();
      unmount();
    }
  });

  it('offers quote and booking, and lists Other only while it is the reading', () => {
    const { unmount } = render(<WorkflowBadge analysis={analysis('quote')} intent="quote" />);
    const picker = screen.getByLabelText('Nava reads this as') as HTMLSelectElement;
    expect(Array.from(picker.options).map((option) => option.value)).toEqual(['quote', 'create_booking']);
    unmount();
  });

  it('reports a change of type to its owner', () => {
    const onIntentChange = vi.fn();
    render(<WorkflowBadge analysis={analysis('quote')} intent="quote" onIntentChange={onIntentChange} />);
    fireEvent.change(screen.getByLabelText('Nava reads this as'), { target: { value: 'create_booking' } });
    expect(onIntentChange).toHaveBeenCalledWith('create_booking');
  });

  it('is unchanged when the amendment kind is null', () => {
    render(<WorkflowBadge analysis={analysis('quote')} amendmentKind={null} intent="quote" />);
    expect((screen.getByLabelText('Nava reads this as') as HTMLSelectElement).value).toBe('quote');
    expect(screen.queryByText('Amendment')).toBeNull();
  });

  it('renders nothing without an analysis, even with an amendment kind', () => {
    const { container } = render(<WorkflowBadge analysis={null} amendmentKind="cancel" />);
    expect(container.textContent).toBe('');
  });

  it('shows Amendment with hover text for an amend', () => {
    render(<WorkflowBadge analysis={analysis('other')} amendmentKind="amend" />);
    const chip = screen.getByText('Amendment');
    expect(chip.getAttribute('title')).toBe(CHANGE_HINT);
    expect(chip.getAttribute('data-amendment-kind')).toBe('amend');
    expect(screen.queryByText('Other')).toBeNull();
    expect(screen.queryByLabelText('Nava reads this as')).toBeNull();
  });

  it('shows Cancellation with hover text for a cancel', () => {
    render(<WorkflowBadge analysis={analysis('other')} amendmentKind="cancel" />);
    const chip = screen.getByText('Cancellation');
    expect(chip.getAttribute('title')).toBe(CANCEL_HINT);
    expect(chip.getAttribute('data-amendment-kind')).toBe('cancel');
    expect(screen.queryByText('Other')).toBeNull();
    expect(screen.queryByLabelText('Nava reads this as')).toBeNull();
  });

  it('shows the amendment chip even when Nava gave no workflow', () => {
    render(<WorkflowBadge analysis={analysis(null)} amendmentKind="amend" />);
    expect(screen.getByText('Amendment')).toBeDefined();
  });

  it('uses clear, distinct colours for the two amendment chips', () => {
    const { unmount } = render(<WorkflowBadge analysis={analysis('other')} amendmentKind="amend" />);
    const amendClass = screen.getByText('Amendment').className;
    unmount();
    render(<WorkflowBadge analysis={analysis('other')} amendmentKind="cancel" />);
    const cancelClass = screen.getByText('Cancellation').className;
    expect(amendClass).toContain('bg-indigo-100');
    expect(cancelClass).toContain('bg-red-100');
    expect(amendClass).not.toContain('emerald');
    expect(cancelClass).not.toContain('emerald');
    expect(amendClass).not.toBe(cancelClass);
  });

  it('keeps the Read without AI note next to an amendment chip', () => {
    render(
      <WorkflowBadge analysis={analysis('other', { aiUnavailable: true })} amendmentKind="cancel" />,
    );
    expect(screen.getByText('Cancellation')).toBeDefined();
    expect(screen.getByText('Read without AI')).toBeDefined();
  });

  it('gets the amendment kind from the analysis in the quote panel', () => {
    const session = reduceQuoteSession(initialQuoteSession(), {
      type: 'analysis_ready',
      analysis: analysis('other', { amendment: AMEND }),
    } as never);
    render(<QuoteWorkflowPanel session={session} />);
    expect(screen.getByText('Amendment').closest('[title]')?.getAttribute('title')).toBe(
      CHANGE_HINT,
    );
    expect(screen.queryByText('Cancellation')).toBeNull();
    expect(screen.queryByText('Other')).toBeNull();
  });

  it('shows Cancellation in the quote panel for a cancel from the analysis', () => {
    const session = reduceQuoteSession(initialQuoteSession(), {
      type: 'analysis_ready',
      analysis: analysis('other', { amendment: { ...AMEND, kind: 'cancel' } }),
    } as never);
    render(<QuoteWorkflowPanel session={session} />);
    expect(screen.getByText('Cancellation').closest('[title]')?.getAttribute('title')).toBe(
      CANCEL_HINT,
    );
  });

  it('keeps the normal label in the quote panel when the analysis has no amendment', () => {
    const session = reduceQuoteSession(initialQuoteSession(), {
      type: 'analysis_ready',
      analysis: analysis('quote'),
    } as never);
    render(<QuoteWorkflowPanel session={session} />);
    expect(screen.queryByText('Amendment')).toBeNull();
    expect(screen.queryByText('Cancellation')).toBeNull();
  });

  it('shows an amendment chip without a treat-as picker (AE2)', () => {
    render(<WorkflowBadge analysis={analysis('other')} amendmentKind="amend" intent="other" />);
    const chip = screen.getByText('Amendment');
    expect(chip.getAttribute('title')).toBe(CHANGE_HINT);
    expect(screen.queryByText('Other')).toBeNull();
    expect(screen.queryByLabelText('Nava reads this as')).toBeNull();
  });

  it('shows a cancellation chip without a treat-as picker', () => {
    render(<WorkflowBadge analysis={analysis('other')} amendmentKind="cancel" intent="other" />);
    expect(screen.getByText('Cancellation').getAttribute('title')).toBe(CANCEL_HINT);
    expect(screen.queryByLabelText('Nava reads this as')).toBeNull();
  });
});
