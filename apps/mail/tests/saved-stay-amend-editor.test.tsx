/** @vitest-environment happy-dom */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SavedStayAmendEditor } from '../components/quote-workflow/saved-stay-amend-editor';
import { initialSavedStayAmendDraft, savedStayAmendProposal, savedStayAmendReviewBasis, amendmentReadbackDifferences } from '../lib/quote-workflow/saved-stay-amendment';
import type { StayRecordWire } from '../lib/quote-workflow/amend-find';

const stay: StayRecordWire = { confirmation: '12345678-1', status: 'Reserved', firstName: 'Proof', lastName: 'Labtest',
  arrival: '2027-10-01', departure: '2027-10-03', nights: 2, adults: 2, children: 0, roomType: 'DLX', ratePlan: 'BAR',
  mealPlan: null, averageRate: '100.00', grandTotal: null, balance: null, sourceOfBusiness: null, guaranteeType: null,
  bookingAgency: null, organization: null };
const identity = { propertyCode: 'HRCEN', threadId: 't', messageId: 'm', mailboxEmail: 'hotel@example.test', sourceHash: 'a' };
const revision = 'extract-1';
const basis = savedStayAmendReviewBasis(stay, {}, revision);
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
    render(<SavedStayAmendEditor extractionRevision={revision} identity={identity} confirmation={stay.confirmation!} stay={stay} onDraftChange={onDraftChange} />);
    fireEvent.change(screen.getByLabelText('Requested adults'), { target: { value: '3' } });
    await waitFor(() => expect(onDraftChange).toHaveBeenLastCalledWith(expect.objectContaining({ identity, confirmation: stay.confirmation, proposal: { confirmation: stay.confirmation, changes: { adults: 3 } }, errors: [] })));
    expect(screen.getByText(/not saved to HMS/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /save|approve|preview/i })).toBeNull();
  });
  it('does not carry a draft onto a different confirmation', async () => {
    const onDraftChange = vi.fn();
    const { rerender } = render(<SavedStayAmendEditor extractionRevision={revision} identity={identity} confirmation={stay.confirmation!} stay={stay} onDraftChange={onDraftChange} />);
    fireEvent.change(screen.getByLabelText('Requested adults'), { target: { value: '3' } });
    const other = { ...stay, confirmation: '87654321-1', adults: 1 };
    rerender(<SavedStayAmendEditor extractionRevision={revision} identity={identity} confirmation={other.confirmation} stay={other} onDraftChange={onDraftChange} />);
    expect((screen.getByLabelText('Requested adults') as HTMLInputElement).value).toBe('1');
    await waitFor(() => expect(onDraftChange).toHaveBeenLastCalledWith(expect.objectContaining({ identity, confirmation: other.confirmation, proposal: null, errors: ['Choose a change to the booking.'] })));
  });
  it('keeps distinct drafts for the same confirmation across sources and properties', async () => {
    const onDraftChange = vi.fn();
    const { rerender } = render(<SavedStayAmendEditor extractionRevision={revision} identity={identity} confirmation={stay.confirmation!} stay={stay} onDraftChange={onDraftChange} />);
    fireEvent.change(screen.getByLabelText('Requested adults'), { target: { value: '3' } });
    const otherSource = { ...identity, messageId: 'other', sourceHash: 'other-hash' };
    rerender(<SavedStayAmendEditor extractionRevision={revision} identity={otherSource} confirmation={stay.confirmation!} stay={stay} onDraftChange={onDraftChange} />);
    expect((screen.getByLabelText('Requested adults') as HTMLInputElement).value).toBe('2');
    await waitFor(() => expect(onDraftChange).toHaveBeenLastCalledWith(expect.objectContaining({ identity: otherSource, confirmation: stay.confirmation, proposal: null, errors: ['Choose a change to the booking.'] })));
    expect(onDraftChange).toHaveBeenCalledWith(expect.objectContaining({ identity, confirmation: stay.confirmation, proposal: null, errors: ['The booking selection changed.'] }));
    fireEvent.change(screen.getByLabelText('Requested adults'), { target: { value: '4' } });
    const otherProperty = { ...identity, propertyCode: 'HRDAV' };
    rerender(<SavedStayAmendEditor extractionRevision={revision} identity={otherProperty} confirmation={stay.confirmation!} stay={stay} onDraftChange={onDraftChange} />);
    expect((screen.getByLabelText('Requested adults') as HTMLInputElement).value).toBe('2');
    rerender(<SavedStayAmendEditor extractionRevision={revision} identity={identity} confirmation={stay.confirmation!} stay={stay} onDraftChange={onDraftChange} />);
    expect((screen.getByLabelText('Requested adults') as HTMLInputElement).value).toBe('3');
    await waitFor(() => expect(onDraftChange).toHaveBeenLastCalledWith(expect.objectContaining({ identity, confirmation: stay.confirmation, proposal: { confirmation: stay.confirmation, changes: { adults: 3 } }, errors: [] })));
    rerender(<SavedStayAmendEditor extractionRevision={revision} identity={otherSource} confirmation={stay.confirmation!} stay={stay} onDraftChange={onDraftChange} />);
    expect((screen.getByLabelText('Requested adults') as HTMLInputElement).value).toBe('4');
  });
  it('holds an untouched draft when the HMS preimage changes, then rebases it on review', async () => {
    const onDraftChange = vi.fn();
    const { rerender } = render(<SavedStayAmendEditor extractionRevision={revision} identity={identity} confirmation={stay.confirmation!} stay={stay} onDraftChange={onDraftChange} />);
    const refreshed = { ...stay, adults: 3 };
    rerender(<SavedStayAmendEditor extractionRevision={revision} identity={identity} confirmation={stay.confirmation!} stay={refreshed} onDraftChange={onDraftChange} />);
    expect((screen.getByLabelText('Requested adults') as HTMLInputElement).value).toBe('2');
    expect(screen.getByText(/Booking or email details changed/)).toBeTruthy();
    await waitFor(() => expect(onDraftChange).toHaveBeenLastCalledWith(expect.objectContaining({ proposal: null })));
    fireEvent.click(screen.getByRole('button', { name: 'Update untouched entries' }));
    expect((screen.getByLabelText('Requested adults') as HTMLInputElement).value).toBe('3');
    await waitFor(() => expect(onDraftChange).toHaveBeenLastCalledWith(expect.objectContaining({ proposal: null, errors: ['Choose a change to the booking.'] })));
  });
  it('holds changed requested dates and rebases untouched values without overwriting staff edits', async () => {
    const onDraftChange = vi.fn();
    const { rerender } = render(<SavedStayAmendEditor extractionRevision={revision} identity={identity} confirmation={stay.confirmation!} stay={stay}
      requestedArrival="2027-10-02" requestedDeparture="2027-10-06" onDraftChange={onDraftChange} />);
    fireEvent.change(screen.getByLabelText('Requested departure'), { target: { value: '2027-10-07' } });
    fireEvent.change(screen.getByLabelText('Requested adults'), { target: { value: '4' } });
    rerender(<SavedStayAmendEditor extractionRevision={revision} identity={identity} confirmation={stay.confirmation!} stay={{ ...stay, adults: 3 }}
      requestedArrival="2027-10-03" requestedDeparture="2027-10-08" onDraftChange={onDraftChange} />);
    await waitFor(() => expect(onDraftChange).toHaveBeenLastCalledWith(expect.objectContaining({ proposal: null })));
    fireEvent.change(screen.getByLabelText('Requested adults'), { target: { value: '5' } });
    expect(onDraftChange).toHaveBeenLastCalledWith(expect.objectContaining({ proposal: null }));
    fireEvent.click(screen.getByRole('button', { name: 'Update untouched entries' }));
    expect((screen.getByLabelText('Requested arrival') as HTMLInputElement).value).toBe('2027-10-03');
    expect((screen.getByLabelText('Requested departure') as HTMLInputElement).value).toBe('2027-10-07');
    expect((screen.getByLabelText('Requested adults') as HTMLInputElement).value).toBe('5');
    await waitFor(() => expect(onDraftChange).toHaveBeenLastCalledWith(expect.objectContaining({ proposal: {
      confirmation: stay.confirmation, changes: { arrival: '2027-10-03', departure: '2027-10-07', adults: 5 },
    }, errors: [] })));
  });
  it('holds an independently changed requested date on the same source', async () => {
    const onDraftChange = vi.fn();
    const { rerender } = render(<SavedStayAmendEditor extractionRevision={revision} identity={identity} confirmation={stay.confirmation!} stay={stay}
      requestedDeparture="2027-10-04" onDraftChange={onDraftChange} />);
    rerender(<SavedStayAmendEditor extractionRevision={revision} identity={identity} confirmation={stay.confirmation!} stay={stay}
      requestedDeparture="2027-10-05" onDraftChange={onDraftChange} />);
    await waitFor(() => expect(onDraftChange).toHaveBeenLastCalledWith(expect.objectContaining({ proposal: null })));
    fireEvent.click(screen.getByRole('button', { name: 'Update untouched entries' }));
    expect((screen.getByLabelText('Requested departure') as HTMLInputElement).value).toBe('2027-10-05');
    expect(onDraftChange).toHaveBeenLastCalledWith(expect.objectContaining({ proposal: {
      confirmation: stay.confirmation, changes: { departure: '2027-10-05' },
    } }));
  });
  it('compares the entire stay by value, including non-occupancy changes', async () => {
    const onDraftChange = vi.fn();
    const { rerender } = render(<SavedStayAmendEditor extractionRevision={revision} identity={identity} confirmation={stay.confirmation!} stay={stay} onDraftChange={onDraftChange} />);
    rerender(<SavedStayAmendEditor extractionRevision={revision} identity={identity} confirmation={stay.confirmation!} stay={{ ...stay }} onDraftChange={onDraftChange} />);
    expect(screen.queryByText(/Booking or email details changed/)).toBeNull();
    rerender(<SavedStayAmendEditor extractionRevision={revision} identity={identity} confirmation={stay.confirmation!} stay={{ ...stay, ratePlan: 'NEW' }} onDraftChange={onDraftChange} />);
    expect(screen.getByText(/Booking or email details changed/)).toBeTruthy();
    await waitFor(() => expect(onDraftChange).toHaveBeenLastCalledWith(expect.objectContaining({ proposal: null })));
  });
  it('keeps a cached edited draft on hold if its preimage changes while another source is selected', async () => {
    const onDraftChange = vi.fn();
    const { rerender } = render(<SavedStayAmendEditor extractionRevision={revision} identity={identity} confirmation={stay.confirmation!} stay={stay} onDraftChange={onDraftChange} />);
    fireEvent.change(screen.getByLabelText('Requested adults'), { target: { value: '4' } });
    const other = { ...identity, messageId: 'other', sourceHash: 'other-hash' };
    rerender(<SavedStayAmendEditor extractionRevision={revision} identity={other} confirmation={stay.confirmation!} stay={stay} onDraftChange={onDraftChange} />);
    rerender(<SavedStayAmendEditor extractionRevision={revision} identity={identity} confirmation={stay.confirmation!} stay={{ ...stay, adults: 3 }} onDraftChange={onDraftChange} />);
    expect((screen.getByLabelText('Requested adults') as HTMLInputElement).value).toBe('4');
    expect(screen.getByText(/Booking or email details changed/)).toBeTruthy();
    await waitFor(() => expect(onDraftChange).toHaveBeenLastCalledWith(expect.objectContaining({ proposal: null })));
    fireEvent.click(screen.getByRole('button', { name: 'Update untouched entries' }));
    expect((screen.getByLabelText('Requested adults') as HTMLInputElement).value).toBe('4');
  });
  it('binds callbacks to the current extraction revision and holds on revision changes', async () => {
    const onDraftChange = vi.fn();
    const { rerender } = render(<SavedStayAmendEditor extractionRevision={revision} identity={identity} confirmation={stay.confirmation!} stay={stay} onDraftChange={onDraftChange} />);
    await waitFor(() => expect(onDraftChange).toHaveBeenLastCalledWith(expect.objectContaining({ extractionRevision: revision, basis })));
    fireEvent.change(screen.getByLabelText('Requested adults'), { target: { value: '4' } });
    rerender(<SavedStayAmendEditor extractionRevision="extract-2" identity={identity} confirmation={stay.confirmation!} stay={stay} onDraftChange={onDraftChange} />);
    const nextBasis = savedStayAmendReviewBasis(stay, {}, 'extract-2');
    await waitFor(() => expect(onDraftChange).toHaveBeenLastCalledWith(expect.objectContaining({ extractionRevision: 'extract-2', basis: nextBasis, proposal: null })));
    expect((screen.getByLabelText('Requested adults') as HTMLInputElement).value).toBe('4');
    fireEvent.click(screen.getByRole('button', { name: 'Update untouched entries' }));
    expect(onDraftChange).toHaveBeenLastCalledWith(expect.objectContaining({ extractionRevision: 'extract-2', basis: nextBasis,
      proposal: { confirmation: stay.confirmation, changes: { adults: 4 } } }));
  });
  it('holds editing when property or source identity is missing', async () => {
    const onDraftChange = vi.fn();
    render(<SavedStayAmendEditor extractionRevision={revision} identity={{ ...identity, propertyCode: '' }} confirmation={stay.confirmation!} stay={stay} onDraftChange={onDraftChange} />);
    expect(screen.getByText(/Select the property, email, booking and current request first/)).toBeTruthy();
    expect(screen.queryByLabelText('Requested adults')).toBeNull();
    await waitFor(() => expect(onDraftChange).toHaveBeenLastCalledWith(expect.objectContaining({ identity: { ...identity, propertyCode: '' }, confirmation: stay.confirmation, proposal: null, errors: ['Select the property, email, booking and current request first.'] })));
  });
  it('holds editing without an extraction revision', async () => {
    const onDraftChange = vi.fn();
    render(<SavedStayAmendEditor extractionRevision="" identity={identity} confirmation={stay.confirmation!} stay={stay} onDraftChange={onDraftChange} />);
    expect(screen.queryByLabelText('Requested adults')).toBeNull();
    await waitFor(() => expect(onDraftChange).toHaveBeenLastCalledWith(expect.objectContaining({ basis: null, proposal: null })));
  });
  it('reports readback discrepancies and distinguishes a previous proposal from current entries', () => {
    const result = { extractionRevision: revision, basis, propertyCode: 'HRCEN', threadId: 't', messageId: 'm', mailboxEmail: 'hotel@example.test', sourceHash: 'a',
      confirmation: stay.confirmation!, state: 'verified' as const,
      proposal: { confirmation: stay.confirmation!, changes: { adults: 3 } },
      readback: { arrival: stay.arrival, departure: stay.departure, adults: 2, children: 0, childAges: null, averageRate: '100.00', grandTotal: null },
      screenshotRef: { runId: 'r', name: 'after.png' } };
    const resultContext = { source: { threadId: 't', messageId: 'm', mailboxEmail: 'hotel@example.test', sourceHash: 'a' },
      extractionRevision: revision, basis, submittedProposal: result.proposal };
    expect(amendmentReadbackDifferences(result)).toHaveLength(1);
    render(<SavedStayAmendEditor extractionRevision={revision} identity={identity} confirmation={stay.confirmation!} stay={stay} result={result} resultContext={resultContext} />);
    expect(screen.getByText(/HMS read-back differs/)).toBeTruthy();
    expect(screen.getByText(/Previous HMS attempt/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Requested adults'), { target: { value: '3' } });
    expect(screen.queryByText(/Previous HMS attempt/)).toBeNull();
    expect(screen.queryByText('Saved in HMS.')).toBeNull();
  });
  it('hides results for a different source or submitted proposal even when confirmation matches', () => {
    const result = { extractionRevision: revision, basis, propertyCode: 'HRCEN', threadId: 't', messageId: 'm', mailboxEmail: 'hotel@example.test', sourceHash: 'a',
      confirmation: stay.confirmation!, state: 'needs_check' as const,
      proposal: { confirmation: stay.confirmation!, changes: { adults: 3 } } };
    const source = { threadId: 't', messageId: 'm', mailboxEmail: 'hotel@example.test', sourceHash: 'a' };
    const contexts = [
      null,
      ...(['threadId', 'messageId', 'mailboxEmail', 'sourceHash'] as const).map((key) =>
        ({ source: { ...source, [key]: 'different' }, extractionRevision: revision, basis, submittedProposal: result.proposal })),
      { source: { ...source, sourceHash: '' }, extractionRevision: revision, basis, submittedProposal: result.proposal },
      { source, extractionRevision: 'different', basis, submittedProposal: result.proposal },
      { source, extractionRevision: revision, basis: 'different', submittedProposal: result.proposal },
      { source, extractionRevision: revision, basis, submittedProposal: { confirmation: stay.confirmation!, changes: { adults: 4 } } },
    ];
    for (const resultContext of contexts) {
      const view = render(<SavedStayAmendEditor extractionRevision={revision} identity={identity} confirmation={stay.confirmation!} stay={stay} result={result} resultContext={resultContext} />);
      expect(screen.queryByText(/HMS outcome is not confirmed/)).toBeNull();
      view.unmount();
    }
    render(<SavedStayAmendEditor extractionRevision={revision} identity={{ ...identity, propertyCode: 'HRDAV' }} confirmation={stay.confirmation!} stay={stay}
      result={result} resultContext={{ source, extractionRevision: revision, basis, submittedProposal: result.proposal }} />);
    expect(screen.queryByText(/HMS outcome is not confirmed/)).toBeNull();
  });
  it('does not match a result with a missing revision or review basis', () => {
    const source = { threadId: 't', messageId: 'm', mailboxEmail: 'hotel@example.test', sourceHash: 'a' };
    const proposal = { confirmation: stay.confirmation!, changes: { adults: 3 } };
    for (const missing of [{ extractionRevision: '', basis }, { extractionRevision: revision, basis: '' }]) {
      const result = { propertyCode: 'HRCEN', ...source, ...missing, confirmation: stay.confirmation!, state: 'needs_check' as const, proposal };
      const view = render(<SavedStayAmendEditor extractionRevision={revision} identity={identity} confirmation={stay.confirmation!} stay={stay}
        result={result} resultContext={{ source, ...missing, submittedProposal: proposal }} />);
      expect(screen.queryByText(/HMS outcome is not confirmed/)).toBeNull();
      view.unmount();
    }
  });
  it('keeps an uncertain attempt visible as previous after the extraction revision changes', () => {
    const result = { extractionRevision: revision, basis, ...identity,
      confirmation: stay.confirmation!, state: 'needs_check' as const,
      proposal: { confirmation: stay.confirmation!, changes: { adults: 3 } } };
    const resultContext = { source: identity, extractionRevision: revision, basis, submittedProposal: result.proposal };
    render(<SavedStayAmendEditor extractionRevision="extract-2" identity={identity} confirmation={stay.confirmation!} stay={stay} result={result} resultContext={resultContext} />);
    expect(screen.getByText(/Previous HMS attempt/)).toBeTruthy();
    expect(screen.getByText(/HMS outcome is not confirmed/)).toBeTruthy();
  });
  it('keeps an uncertain prior result visible without suggesting another save', () => {
    const result = { extractionRevision: revision, basis, propertyCode: 'HRCEN', threadId: 't', messageId: 'm', mailboxEmail: 'hotel@example.test', sourceHash: 'a',
      confirmation: stay.confirmation!, state: 'verified' as const,
      proposal: { confirmation: stay.confirmation!, changes: { adults: 3 } } };
    const resultContext = { source: { threadId: 't', messageId: 'm', mailboxEmail: 'hotel@example.test', sourceHash: 'a' },
      extractionRevision: revision, basis, submittedProposal: result.proposal };
    render(<SavedStayAmendEditor extractionRevision={revision} identity={identity} confirmation={stay.confirmation!} stay={stay} result={result} resultContext={resultContext} />);
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
