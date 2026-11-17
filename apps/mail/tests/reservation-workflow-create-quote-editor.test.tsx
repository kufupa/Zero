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
      proposal: { content: { requests: [request] }, sourceClaims: [], annotations: [], issues: [] }, fieldOverrides: {}, fieldReviewRequirements: {},
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
      proposal: { content: { requests: [request] }, sourceClaims: [], annotations: [], issues: [] }, fieldOverrides: {}, fieldReviewRequirements: {}, staffReviews: {}, operationResults: [],
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

  it('lets staff keep related room groups together within separate quote options', () => {
    const root = '/proposal/content/requests/request-1/body', compositionPath = `${root}/quoteComposition`;
    const group = { arrival: '2027-01-01', departure: '2027-01-02', quantity: 1, roomCodes: [], ratePlan: null,
      mealPlan: 'bb', requestedMealPlan: 'bb', occupancy: { scope: 'per_room', adults: 1, childCount: 0, childAges: [] }, priceObservationRefs: [] };
    const request = { id: 'request-1', kind: 'quote', body: { groups: [1, 2, 3].map(id => ({ ...group, id: `group-${id}` })),
      parties: {}, client: {}, requestedMoney: [], outputIntent: { artifacts: [] } } };
    const draft: any = { generationId: 'generation', propertyCode: 'HRCEN', source: { messageId: 'message', sourceHash: 'hash' },
      proposal: { content: { requests: [request] }, sourceClaims: [], annotations: [], issues: [] }, fieldOverrides: {},
      fieldReviewRequirements: {}, staffReviews: {}, operationResults: [], observations: [] };
    const edit = vi.fn().mockResolvedValue(undefined);
    const editor: any = { source: { messageId: 'message' }, configuration: null, request,
      snapshot: { session: { draft }, operationResults: [] }, view: { busy: false, preview: false },
      commands: { edit, stageEdit: vi.fn(), setUncommitted: vi.fn(), lookup: vi.fn(), changeRows: vi.fn() } };
    const { rerender } = render(<QuoteEditor {...editor} />);
    fireEvent.click(screen.getByRole('button', { name: 'Each group is an option' }));
    const choice = edit.mock.calls.at(-1)![1];
    draft.fieldOverrides[compositionPath] = { state: 'set', value: choice };
    rerender(<QuoteEditor {...editor} />);
    fireEvent.change(screen.getByLabelText('Group 2 option'), { target: { value: 'option_1' } });
    expect(edit).toHaveBeenLastCalledWith(compositionPath, { kind: 'scenarios', scenarios: [
      { id: 'option_1', label: 'Option 1', groupIds: ['group-1', 'group-2'], evidenceRefs: [] },
      { id: 'option_3', label: 'Option 3', groupIds: ['group-3'], evidenceRefs: [] },
    ] });
  });

  it('asks staff before replacing a named requested rate', () => {
    const root = '/proposal/content/requests/request-1/body';
    const group = { id: 'group-1', arrival: '2027-01-01', departure: '2027-01-02', quantity: 1, roomCodes: [], ratePlan: null,
      mealPlan: 'bb', requestedMealPlan: 'bb', occupancy: { scope: 'per_room', adults: 1, childCount: 0, childAges: [] }, priceObservationRefs: [] };
    const request = { id: 'request-1', kind: 'quote', body: { groups: [group], parties: {}, client: {},
      requestedMoney: [], outputIntent: { artifacts: [] } } };
    const draft: any = { generationId: 'generation', propertyCode: 'HRCEN', source: { messageId: 'message', sourceHash: 'hash' },
      proposal: { content: { requests: [request] }, sourceClaims: [], annotations: [], issues: [
        { path: '/requests/request-1/body/groups', kind: 'quote_rate_code_not_projected' },
      ] }, fieldOverrides: {}, fieldReviewRequirements: {}, staffReviews: {}, operationResults: [], observations: [] };
    const edit = vi.fn().mockResolvedValue(undefined);
    const editor: any = { source: { messageId: 'message' }, configuration: null, request,
      snapshot: { session: { draft }, operationResults: [] }, view: { busy: false, preview: false },
      commands: { edit, stageEdit: vi.fn(), setUncommitted: vi.fn(), lookup: vi.fn(), changeRows: vi.fn() } };
    const { rerender } = render(<QuoteEditor {...editor} />);
    fireEvent.click(screen.getByRole('button', { name: 'Use another available rate' }));
    expect(edit).toHaveBeenCalledWith(`${root}/groups/0/ratePlan`, null, 'none');
    draft.fieldOverrides[`${root}/groups/0/ratePlan`] = { state: 'none' };
    rerender(<QuoteEditor {...editor} />);
    expect(screen.queryByRole('button', { name: 'Use another available rate' })).toBeNull();
  });
});
