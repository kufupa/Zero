/** @vitest-environment happy-dom */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QuoteEditor } from '../components/reservation-pane/editors/quote-editor';
import { CreateEditor } from '../components/reservation-pane/editors/create-editor';

afterEach(cleanup);

describe('Quote review context', () => {
  it('shows the Create room request and warns without truncating a long booker name', () => {
    const request = { id: 'request-1', kind: 'create', body: { shared: { bookerName: 'N'.repeat(51),
      requestedRoomDescription: 'Quiet room' }, dateSections: [], allocations: [] } };
    const draft: any = { generationId: 'generation', propertyCode: 'HRCEN', source: { messageId: 'message' },
      proposal: { content: { requests: [request] }, sourceClaims: [], annotations: [] }, fieldOverrides: {}, fieldReviewRequirements: {},
      staffReviews: {}, observations: [], operationResults: [] };
    const editor: any = { source: { messageId: 'message', sender: '' }, configuration: null, request,
      snapshot: { session: { draft }, operationResults: [], fields: {}, issues: [], preparationViews: [] },
      view: { busy: false, preview: false }, commands: { edit: vi.fn().mockResolvedValue(undefined), stageEdit: vi.fn(),
        setUncommitted: vi.fn(), lookup: vi.fn(), changeRows: vi.fn() } };
    render(<CreateEditor {...editor} />);
    expect((screen.getByLabelText('Room Request') as HTMLInputElement).value).toBe('Quiet room');
    const booker = screen.getByLabelText('Booker name') as HTMLInputElement;
    expect(booker.value).toBe('N'.repeat(51));
    expect(booker.maxLength).toBe(300);
    expect(screen.getByRole('alert').textContent).toContain('at most 50 characters');
  });
  it('keeps comma-containing names as individual rows and leaves current pricing current', () => {
    const bodyPath = '/proposal/content/requests/request-1/body';
    const group = { id: 'group-1', arrival: '2027-01-01', departure: '2027-01-02', quantity: 1,
      guestNames: ['Smith, Jane'], requestedRoomDescription: 'Quiet room', roomCodes: ['STD'], ratePlan: 'BAR',
      mealPlan: 'bb', requestedMealPlan: 'bb', occupancy: { scope: 'per_room', adults: 1, childCount: 0, childAges: [] }, priceObservationRefs: [] };
    const request = { id: 'request-1', kind: 'quote', body: { groups: [group], guestNames: ['Doe, Sam'],
      parties: {}, client: {}, requestedMoney: [], outputIntent: { artifacts: [] } } };
    const draft: any = { generationId: 'generation', propertyCode: 'HRCEN', source: { messageId: 'message', sourceHash: 'hash' },
      proposal: { content: { requests: [request] }, sourceClaims: [], annotations: [] }, fieldOverrides: {}, fieldReviewRequirements: {}, staffReviews: {}, operationResults: [],
      observations: [{ kind: 'rate_availability', generationId: 'generation', propertyCode: 'HRCEN', sourceMessageId: 'message',
        status: 'complete', coverage: { complete: true }, criteria: { sourceHash: 'hash', workflow: 'quote', requestId: 'request-1' },
        result: { freshUntil: new Date(Date.now() + 60_000).toISOString(), inputOverrides: {},
          revision: { groups: [{ id: 'group-1', arrivalDate: group.arrival, departureDate: group.departure,
            quantity: 1, adults: 1, children: 0, childAges: [], roomCode: 'STD', rateCode: 'BAR' }] } } }] };
    const edit = vi.fn().mockResolvedValue(undefined);
    const editor: any = { source: { messageId: 'message' }, configuration: null, request,
      snapshot: { session: { draft }, operationResults: [] }, view: { busy: false, preview: false },
      commands: { edit, stageEdit: vi.fn(), setUncommitted: vi.fn(), lookup: vi.fn(), changeRows: vi.fn() } };
    const { rerender } = render(<QuoteEditor {...editor} />);
    expect(screen.getByText('Current Infor quote')).toBeDefined();
    const rosters = screen.getAllByText('Guest roster (review context only)').map(item => item.parentElement!);
    const groupName = within(rosters[1]!).getByLabelText('Guest 1');
    fireEvent.change(groupName, { target: { value: 'Smith, Jane A' } });
    fireEvent.blur(groupName);
    expect(edit).toHaveBeenCalledWith(`${bodyPath}/groups/0/guestNames`, ['Smith, Jane A']);
    draft.fieldOverrides[`${bodyPath}/groups/0/guestNames`] = { state: 'set', value: ['Smith, Jane A'] };
    draft.fieldOverrides[`${bodyPath}/guestNames`] = { state: 'set', value: ['Doe, Sam'] };
    draft.fieldOverrides[`${bodyPath}/groups/0/requestedRoomDescription`] = { state: 'set', value: 'Quiet room' };
    rerender(<QuoteEditor {...editor} />);
    expect(screen.getByText('Current Infor quote')).toBeDefined();
    expect(screen.getByLabelText('Room Request (review context)')).toBeDefined();
    draft.observations[0].status = 'partial';
    Object.assign(draft.observations[0].result, { sourceHash: 'hash', quoteDiagnostics: [{}], requestedGroups: [{
      id: 'group-1', arrivalDate: group.arrival, departureDate: group.departure, quantity: 1, adults: 1,
      mealPlan: 'bb', childrenAges: [], roomCodes: ['STD'], rateCode: 'BAR' }] });
    rerender(<QuoteEditor {...editor} />);
    expect(screen.getByText('Current Infor availability')).toBeDefined();
    fireEvent.click(within(rosters[0]!).getByRole('button', { name: '+ Add guest' }));
    expect(edit).toHaveBeenCalledWith(`${bodyPath}/guestNames`, ['Doe, Sam', '']);
  });
});
