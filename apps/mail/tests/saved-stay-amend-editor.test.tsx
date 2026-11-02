/** @vitest-environment happy-dom */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SavedStayAmendEditor } from '../components/quote-workflow/saved-stay-amend-editor';
import { initialSavedStayAmendDraft, savedStayAmendProposal, amendmentReadbackDifferences } from '../lib/quote-workflow/saved-stay-amendment';
import type { StayRecordWire } from '../lib/quote-workflow/amend-find';

const stay: StayRecordWire = { confirmation: '12345678-1', status: 'Reserved', firstName: 'Proof', lastName: 'Labtest',
  arrival: '2027-10-01', departure: '2027-10-03', nights: 2, adults: 2, children: 0, roomType: 'DLX', ratePlan: 'BAR',
  mealPlan: null, averageRate: '100.00', grandTotal: null, balance: null, sourceOfBusiness: null, guaranteeType: null,
  bookingAgency: null, organization: null };
afterEach(cleanup);

describe('saved stay amendment request', () => {
  it('distinguishes missing ages from zero and requires exact ages on child changes', () => {
    const initial = initialSavedStayAmendDraft(stay, {});
    expect(initial.childAges).toBe('');
    expect(savedStayAmendProposal(stay.confirmation!, stay, { ...initial, children: '2' }).errors).toContain('Enter one age for each child.');
    expect(savedStayAmendProposal(stay.confirmation!, stay, { ...initial, children: '2', childAges: '8' }).proposal).toBeNull();
    expect(savedStayAmendProposal(stay.confirmation!, stay, { ...initial, children: '2', childAges: '8, 3' }).proposal)
      .toEqual({ confirmation: stay.confirmation, changes: { children: 2, childAges: [8, 3] } });
    const two = { ...stay, children: 2 };
    expect(savedStayAmendProposal(two.confirmation!, two, { ...initial, children: '0' }).proposal?.changes)
      .toEqual({ children: 0, childAges: [] });
  });
  it('binds age-only edits to the explicit child count and selected confirmation', () => {
    const two = { ...stay, children: 2 };
    const draft = { ...initialSavedStayAmendDraft(two, {}), childAges: '8, 3' };
    expect(savedStayAmendProposal(two.confirmation!, two, draft).proposal?.changes)
      .toEqual({ children: 2, childAges: [8, 3] });
    expect(savedStayAmendProposal('87654321-1', two, draft).proposal).toBeNull();
  });
  it('rejects invalid dates and blank counts', () => {
    const initial = initialSavedStayAmendDraft(stay, {});
    expect(savedStayAmendProposal(stay.confirmation!, stay, { ...initial, arrival: '2027-02-30', adults: '' }).proposal).toBeNull();
  });
  it('emits edits as an unsaved proposal and does not offer a Save button', async () => {
    const onDraftChange = vi.fn();
    render(<SavedStayAmendEditor confirmation={stay.confirmation!} stay={stay} onDraftChange={onDraftChange} />);
    fireEvent.change(screen.getByLabelText('Requested adults'), { target: { value: '3' } });
    await waitFor(() => expect(onDraftChange).toHaveBeenLastCalledWith({ proposal: { confirmation: stay.confirmation, changes: { adults: 3 } }, errors: [] }));
    expect(screen.getByText(/not saved to HMS/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /save|approve|preview/i })).toBeNull();
  });
  it('does not carry a draft onto a different confirmation', async () => {
    const onDraftChange = vi.fn();
    const { rerender } = render(<SavedStayAmendEditor confirmation={stay.confirmation!} stay={stay} onDraftChange={onDraftChange} />);
    fireEvent.change(screen.getByLabelText('Requested adults'), { target: { value: '3' } });
    const other = { ...stay, confirmation: '87654321-1', adults: 1 };
    rerender(<SavedStayAmendEditor confirmation={other.confirmation} stay={other} onDraftChange={onDraftChange} />);
    expect((screen.getByLabelText('Requested adults') as HTMLInputElement).value).toBe('1');
    await waitFor(() => expect(onDraftChange).toHaveBeenLastCalledWith({ proposal: null, errors: ['Choose a change to the booking.'] }));
  });
  it('reports readback discrepancies without treating requested changes as saved', () => {
    const result = { threadId: 't', messageId: 'm', mailboxEmail: 'hotel@example.test', sourceHash: 'a',
      confirmation: stay.confirmation!, state: 'verified' as const,
      proposal: { confirmation: stay.confirmation!, changes: { adults: 3 } },
      readback: { arrival: stay.arrival, departure: stay.departure, adults: 2, children: 0, childAges: null, averageRate: '100.00', grandTotal: null },
      screenshotRef: { runId: 'r', name: 'after.png' } };
    expect(amendmentReadbackDifferences(result)).toHaveLength(1);
    render(<SavedStayAmendEditor confirmation={stay.confirmation!} stay={stay} result={result} />);
    expect(screen.getByText(/HMS read-back differs/)).toBeTruthy();
    expect(screen.queryByText('Saved in HMS.')).toBeNull();
  });
  it('treats a verified label without screenshot and fresh readback as needing a check', () => {
    const result = { threadId: 't', messageId: 'm', mailboxEmail: 'hotel@example.test', sourceHash: 'a',
      confirmation: stay.confirmation!, state: 'verified' as const,
      proposal: { confirmation: stay.confirmation!, changes: { adults: 3 } } };
    render(<SavedStayAmendEditor confirmation={stay.confirmation!} stay={stay} result={result} />);
    expect(screen.getByText(/Outcome needs checking/)).toBeTruthy();
  });
});
