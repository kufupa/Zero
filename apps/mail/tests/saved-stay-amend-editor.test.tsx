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
const identity = { propertyCode: 'HRCEN', threadId: 't', messageId: 'm', mailboxEmail: 'hotel@example.test', sourceHash: 'a' };
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
    render(<SavedStayAmendEditor identity={identity} confirmation={stay.confirmation!} stay={stay} onDraftChange={onDraftChange} />);
    fireEvent.change(screen.getByLabelText('Requested adults'), { target: { value: '3' } });
    await waitFor(() => expect(onDraftChange).toHaveBeenLastCalledWith({ identity, confirmation: stay.confirmation, proposal: { confirmation: stay.confirmation, changes: { adults: 3 } }, errors: [] }));
    expect(screen.getByText(/not saved to HMS/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /save|approve|preview/i })).toBeNull();
  });
  it('does not carry a draft onto a different confirmation', async () => {
    const onDraftChange = vi.fn();
    const { rerender } = render(<SavedStayAmendEditor identity={identity} confirmation={stay.confirmation!} stay={stay} onDraftChange={onDraftChange} />);
    fireEvent.change(screen.getByLabelText('Requested adults'), { target: { value: '3' } });
    const other = { ...stay, confirmation: '87654321-1', adults: 1 };
    rerender(<SavedStayAmendEditor identity={identity} confirmation={other.confirmation} stay={other} onDraftChange={onDraftChange} />);
    expect((screen.getByLabelText('Requested adults') as HTMLInputElement).value).toBe('1');
    await waitFor(() => expect(onDraftChange).toHaveBeenLastCalledWith({ identity, confirmation: other.confirmation, proposal: null, errors: ['Choose a change to the booking.'] }));
  });
  it('keeps distinct drafts for the same confirmation across sources and properties', async () => {
    const onDraftChange = vi.fn();
    const { rerender } = render(<SavedStayAmendEditor identity={identity} confirmation={stay.confirmation!} stay={stay} onDraftChange={onDraftChange} />);
    fireEvent.change(screen.getByLabelText('Requested adults'), { target: { value: '3' } });
    const otherSource = { ...identity, messageId: 'other', sourceHash: 'other-hash' };
    rerender(<SavedStayAmendEditor identity={otherSource} confirmation={stay.confirmation!} stay={stay} onDraftChange={onDraftChange} />);
    expect((screen.getByLabelText('Requested adults') as HTMLInputElement).value).toBe('2');
    await waitFor(() => expect(onDraftChange).toHaveBeenLastCalledWith({ identity: otherSource, confirmation: stay.confirmation, proposal: null, errors: ['Choose a change to the booking.'] }));
    expect(onDraftChange).toHaveBeenCalledWith({ identity, confirmation: stay.confirmation, proposal: null, errors: ['The booking selection changed.'] });
    fireEvent.change(screen.getByLabelText('Requested adults'), { target: { value: '4' } });
    const otherProperty = { ...identity, propertyCode: 'HRDAV' };
    rerender(<SavedStayAmendEditor identity={otherProperty} confirmation={stay.confirmation!} stay={stay} onDraftChange={onDraftChange} />);
    expect((screen.getByLabelText('Requested adults') as HTMLInputElement).value).toBe('2');
    rerender(<SavedStayAmendEditor identity={identity} confirmation={stay.confirmation!} stay={stay} onDraftChange={onDraftChange} />);
    expect((screen.getByLabelText('Requested adults') as HTMLInputElement).value).toBe('3');
    await waitFor(() => expect(onDraftChange).toHaveBeenLastCalledWith({ identity, confirmation: stay.confirmation, proposal: { confirmation: stay.confirmation, changes: { adults: 3 } }, errors: [] }));
    rerender(<SavedStayAmendEditor identity={otherSource} confirmation={stay.confirmation!} stay={stay} onDraftChange={onDraftChange} />);
    expect((screen.getByLabelText('Requested adults') as HTMLInputElement).value).toBe('4');
  });
  it('holds editing when property or source identity is missing', async () => {
    const onDraftChange = vi.fn();
    render(<SavedStayAmendEditor identity={{ ...identity, propertyCode: '' }} confirmation={stay.confirmation!} stay={stay} onDraftChange={onDraftChange} />);
    expect(screen.getByText(/Select the property, email and booking first/)).toBeTruthy();
    expect(screen.queryByLabelText('Requested adults')).toBeNull();
    await waitFor(() => expect(onDraftChange).toHaveBeenLastCalledWith({ identity: { ...identity, propertyCode: '' }, confirmation: stay.confirmation, proposal: null, errors: ['Select the property, email and booking first.'] }));
  });
  it('reports readback discrepancies and distinguishes a previous proposal from current entries', () => {
    const result = { propertyCode: 'HRCEN', threadId: 't', messageId: 'm', mailboxEmail: 'hotel@example.test', sourceHash: 'a',
      confirmation: stay.confirmation!, state: 'verified' as const,
      proposal: { confirmation: stay.confirmation!, changes: { adults: 3 } },
      readback: { arrival: stay.arrival, departure: stay.departure, adults: 2, children: 0, childAges: null, averageRate: '100.00', grandTotal: null },
      screenshotRef: { runId: 'r', name: 'after.png' } };
    const resultContext = { source: { threadId: 't', messageId: 'm', mailboxEmail: 'hotel@example.test', sourceHash: 'a' },
      submittedProposal: result.proposal };
    expect(amendmentReadbackDifferences(result)).toHaveLength(1);
    render(<SavedStayAmendEditor identity={identity} confirmation={stay.confirmation!} stay={stay} result={result} resultContext={resultContext} />);
    expect(screen.getByText(/HMS read-back differs/)).toBeTruthy();
    expect(screen.getByText(/Previous HMS attempt/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Requested adults'), { target: { value: '3' } });
    expect(screen.queryByText(/Previous HMS attempt/)).toBeNull();
    expect(screen.queryByText('Saved in HMS.')).toBeNull();
  });
  it('hides results for a different source or submitted proposal even when confirmation matches', () => {
    const result = { propertyCode: 'HRCEN', threadId: 't', messageId: 'm', mailboxEmail: 'hotel@example.test', sourceHash: 'a',
      confirmation: stay.confirmation!, state: 'needs_check' as const,
      proposal: { confirmation: stay.confirmation!, changes: { adults: 3 } } };
    const source = { threadId: 't', messageId: 'm', mailboxEmail: 'hotel@example.test', sourceHash: 'a' };
    const contexts = [
      null,
      ...(['threadId', 'messageId', 'mailboxEmail', 'sourceHash'] as const).map((key) =>
        ({ source: { ...source, [key]: 'different' }, submittedProposal: result.proposal })),
      { source: { ...source, sourceHash: '' }, submittedProposal: result.proposal },
      { source, submittedProposal: { confirmation: stay.confirmation!, changes: { adults: 4 } } },
    ];
    for (const resultContext of contexts) {
      const view = render(<SavedStayAmendEditor identity={identity} confirmation={stay.confirmation!} stay={stay} result={result} resultContext={resultContext} />);
      expect(screen.queryByText(/HMS outcome is not confirmed/)).toBeNull();
      view.unmount();
    }
    render(<SavedStayAmendEditor identity={{ ...identity, propertyCode: 'HRDAV' }} confirmation={stay.confirmation!} stay={stay}
      result={result} resultContext={{ source, submittedProposal: result.proposal }} />);
    expect(screen.queryByText(/HMS outcome is not confirmed/)).toBeNull();
  });
  it('keeps an uncertain prior result visible without suggesting another save', () => {
    const result = { propertyCode: 'HRCEN', threadId: 't', messageId: 'm', mailboxEmail: 'hotel@example.test', sourceHash: 'a',
      confirmation: stay.confirmation!, state: 'verified' as const,
      proposal: { confirmation: stay.confirmation!, changes: { adults: 3 } } };
    const resultContext = { source: { threadId: 't', messageId: 'm', mailboxEmail: 'hotel@example.test', sourceHash: 'a' },
      submittedProposal: result.proposal };
    render(<SavedStayAmendEditor identity={identity} confirmation={stay.confirmation!} stay={stay} result={result} resultContext={resultContext} />);
    expect(screen.getByText(/HMS outcome is not confirmed/)).toBeTruthy();
    expect(screen.getByText(/Do not make another change to this booking/)).toBeTruthy();
    expect(screen.getByText(/previous session are safe/)).toBeTruthy();
    expect(screen.getByText(/Previous HMS attempt/)).toBeTruthy();
    expect(screen.queryByText(/Save the change in HMS for now/)).toBeNull();
    fireEvent.change(screen.getByLabelText('Requested adults'), { target: { value: '4' } });
    expect(screen.getByText(/HMS outcome is not confirmed/)).toBeTruthy();
    expect(screen.getByText(/Previous HMS attempt/)).toBeTruthy();
  });
});
