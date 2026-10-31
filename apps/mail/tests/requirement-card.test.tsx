/**
 * @vitest-environment happy-dom
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StayCard } from '../components/quote-workflow/requirement-card';
import { resolveNativeRoomCodes } from '../lib/quote-workflow/staff-quote-bind';
import {
  HRDAV_PROPERTY_CODE,
  HRDAV_ROOM_NAMES,
  type StayGroupRequirement,
} from '../lib/quote-workflow/types';
import { matchRoomType, ROOM_TYPE_CODES } from '../lib/quote-workflow/room-types';

afterEach(cleanup);

function stay(overrides: Partial<StayGroupRequirement> = {}): StayGroupRequirement {
  return {
    id: 'g1',
    arrivalDate: '2026-10-15',
    departureDate: '2026-10-17',
    quantity: 1,
    adults: 2,
    childrenAges: [],
    board: 'bb',
    specialRequests: [],
    fields: {},
    roomPreference: 'STQN',
    ...overrides,
  };
}

function renderStay(
  rows: StayGroupRequirement[],
  {
    index = 0,
    stayCount = 1,
    requestedRoomsTotal,
  }: { index?: number; stayCount?: number; requestedRoomsTotal?: number } = {},
) {
  const onPatch = vi.fn();
  const onStayAction = vi.fn();
  const onMealPlanChange = vi.fn();
  const rendered = render(
    <StayCard
      stayId="s1"
      rows={rows}
      index={index}
      stayCount={stayCount}
      requestedRoomsTotal={requestedRoomsTotal}
      onPatch={onPatch}
      onStayAction={onStayAction}
      onMealPlanChange={onMealPlanChange}
    />,
  );
  return { onPatch, onStayAction, onMealPlanChange, ...rendered };
}

function selectByLabel(label: string): HTMLSelectElement {
  const element = screen.getByLabelText(label);
  if (!(element instanceof HTMLSelectElement)) throw new Error(`${label} is not a select`);
  return element;
}

describe('StayCard rooms', () => {
  it('keeps adults as compact subtext until staff taps to edit', () => {
    const { onPatch } = renderStay([stay()]);
    fireEvent.click(screen.getByRole('button', { name: 'More: Rooms for stay 1, room 1' }));
    expect(onPatch).toHaveBeenLastCalledWith('g1', { quantity: 2 });
    expect(screen.getByText('2 adults per room')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Edit adults per room for stay 1, room 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'More: Adult guests per room for stay 1, room 1' }));
    expect(onPatch).toHaveBeenLastCalledWith('g1', { adults: 3 });
  });

  it('keeps adults per room between 1 and 9, the values a work item can save', () => {
    renderStay([stay({ id: 'g1', adults: 9 }), stay({ id: 'g2', adults: 1 })]);
    fireEvent.click(screen.getByRole('button', { name: 'Edit adults per room for stay 1, room 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit adults per room for stay 1, room 2' }));
    const more = screen.getByRole('button', { name: 'More: Adult guests per room for stay 1, room 1' });
    const fewer = screen.getByRole('button', { name: 'Fewer: Adult guests per room for stay 1, room 2' });
    expect((more as HTMLButtonElement).disabled).toBe(true);
    expect((fewer as HTMLButtonElement).disabled).toBe(true);
  });

  it('keeps the room-count stepper reachable by label', () => {
    const { onPatch } = renderStay([stay()]);
    const moreRooms = screen.getByRole('button', { name: 'More: Rooms for stay 1, room 1' });
    fireEvent.click(moreRooms);
    expect(onPatch).toHaveBeenLastCalledWith('g1', { quantity: 2 });
  });

  it('renders one optional meal-plan display filter per stay without patching the HMS room rows', () => {
    const { onPatch, onMealPlanChange } = renderStay([stay({ board: 'bb' }), stay({ id: 'g2', board: 'bb' })]);
    const meal = selectByLabel('Meal plan');
    expect(meal.tagName).toBe('SELECT');
    expect(meal.value).toBe('bb');
    expect(screen.getByText('Meal plan').parentElement?.textContent).not.toContain('*');
    fireEvent.change(meal, { target: { value: 'dinner_bb' } });
    expect(onMealPlanChange).toHaveBeenLastCalledWith('dinner_bb');
    expect(onPatch).not.toHaveBeenCalledWith('g1', { board: 'dinner_bb' });
    expect(screen.getAllByLabelText('Meal plan')).toHaveLength(1);
    expect(screen.getByText(/display filter does not change or send the HMS search/i)).toBeTruthy();
  });

  it('labels each stay as N of M', () => {
    renderStay([stay()], { index: 0, stayCount: 1 });
    expect(screen.getByRole('heading', { name: /Stay 1 of 1/ })).toBeTruthy();
    cleanup();
    renderStay([stay({ id: 'g2' })], { index: 1, stayCount: 2 });
    expect(screen.getByRole('heading', { name: /Stay 2 of 2/ })).toBeTruthy();
  });

  it('shows stay guidance as an info tooltip and keeps duplicate/remove actions wired', () => {
    const { onStayAction } = renderStay([
      stay(),
      stay({ id: 'g2', roomPreference: 'STWN' }),
    ]);
    const info = screen.getByRole('button', { name: 'Stay information' });
    expect(info.getAttribute('title')).toBe('One stay = one date range = one HMS booking.');
    expect(screen.queryByText(/Separate HMS booking/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Duplicate stay' })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Copy room' })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'Remove' })).toHaveLength(3);

    fireEvent.click(screen.getByTitle('Duplicate this stay with the same dates and rooms.'));
    expect(onStayAction).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: 'duplicate_stay', stayId: 's1', token: expect.any(String) }),
    );
    fireEvent.click(screen.getByTitle('Remove this stay and its room types.'));
    expect(onStayAction).toHaveBeenLastCalledWith({ type: 'remove_stay', stayId: 's1' });
    fireEvent.click(screen.getAllByTitle('Duplicate this room type and occupancy.')[0]!);
    expect(onStayAction).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: 'duplicate_row', groupId: 'g1', token: expect.any(String) }),
    );
    fireEvent.click(screen.getAllByTitle('Remove this room type.')[0]!);
    expect(onStayAction).toHaveBeenLastCalledWith({ type: 'remove_row', groupId: 'g1' });
  });

  it('marks values read from the email and defaulted meal plans', () => {
    renderStay([stay({ fields: { arrivalDate: 'extracted', adults: 'extracted', board: 'defaulted' } })]);
    expect(screen.getAllByText('from email').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('Default')).toBeTruthy();
  });

  it('lets staff set the child count explicitly and clears ages when confirming zero', () => {
    const { onPatch } = renderStay([
      stay({ childCount: 2, childrenAges: [6, 8], fields: { childAges: 'missing' } }),
    ]);
    const childCount = screen.getByLabelText('Children per room');
    expect((childCount as HTMLInputElement).value).toBe('2');
    fireEvent.change(childCount, { target: { value: '0' } });
    expect(onPatch).toHaveBeenLastCalledWith('g1', { childCount: 0, childrenAges: [] });
  });

  it('shows a stay-total allocation conflict and edits the stay total on every row', () => {
    const { onPatch } = renderStay([
      stay({ childrenTotal: 4, quantity: 1, childCount: 1, childrenAges: [6] }),
      stay({ id: 'g2', childrenTotal: 4, quantity: 2, childCount: 1, childrenAges: [8] }),
    ]);
    expect(screen.getByRole('alert').textContent).toMatch(/review the stated occupancy totals/i);
    const total = screen.getByLabelText('Children total');
    expect((total as HTMLInputElement).value).toBe('4');
    fireEvent.change(total, { target: { value: '3' } });
    expect(onPatch.mock.calls).toEqual([
      ['g1', { childrenTotal: 3 }],
      ['g2', { childrenTotal: 3 }],
    ]);
  });

  it('shows the stated adult total and warns before a contradictory allocation can be quoted', () => {
    renderStay([stay({ adultsTotal: 5, quantity: 2, adults: 3 })]);

    expect(screen.getByText(/Stated adults total: 5/)).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toMatch(/review the stated occupancy totals/i);
  });

  it('shows the dates once for the stay, under Check-in and Check-out', () => {
    renderStay([stay(), stay({ id: 'g2' })]);
    expect(screen.getByText('Check-in')).toBeTruthy();
    expect(screen.getByText('Check-out')).toBeTruthy();
    expect(screen.getAllByText('Check-in')).toHaveLength(1);
  });

  it('preselects confident email rooms and shows chips only for ambiguous terms', () => {
    const { unmount: unmountExact } = renderStay([
      stay({ roomPreference: 'standard queen', roomTypeCode: 'STQN' }),
    ]);
    expect(selectByLabel('Room type').value).toBe('STQN');
    unmountExact();

    const match = matchRoomType('Standard RoomQueen Bed');
    const { unmount: unmountResolved } = renderStay([
      stay({
        roomPreference: 'Standard RoomQueen Bed',
        roomTypeCode: match.code,
        roomTypeSuggestions: match.suggestions,
        fields: { roomPreference: 'extracted' },
      }),
    ]);
    const selectedRoom = selectByLabel('Room type');
    expect(selectedRoom.value).toBe('STQN');
    expect(screen.getByText('from email')).toBeTruthy();
    expect(
      [...selectedRoom.options].some((option) => option.textContent === 'Email request'),
    ).toBe(false);
    expect(screen.queryByRole('group', { name: 'Room type suggestions' })).toBeNull();
    unmountResolved();

    renderStay([
      stay({
        roomPreference: 'Single',
        roomTypeSuggestions: ['STWN', 'SKNG', 'EXKNG', 'SUITE'],
        fields: { roomPreference: 'extracted' },
      }),
    ]);
    const ambiguousRoom = selectByLabel('Room type');
    expect(ambiguousRoom.value).toBe('Single');
    expect(
      [...ambiguousRoom.options].some((option) => option.textContent === 'Email request'),
    ).toBe(true);
    expect(screen.getByText('from email')).toBeTruthy();
    expect(screen.getByText(/Email said 'Single' →/)).toBeTruthy();
    const suggestions = screen.getByRole('group', { name: 'Room type suggestions' });
    const optionButtons = within(suggestions).getAllByRole('button').filter((button) => button.getAttribute('aria-label') !== 'Choose other room type');
    expect(optionButtons.map((button) => button.textContent)).toEqual(['Standard Twin', 'Standard King', 'Executive King']);
    expect(within(suggestions).getByRole('button', { name: 'Choose other room type' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Suite' })).toBeNull();
  });

  it('matches room-name variants only when present in the active property config', () => {
    const renderConfigured = (
      roomTypes: NonNullable<ComponentProps<typeof StayCard>['roomTypes']>,
    ) => render(
      <StayCard
        stayId="s1"
        rows={[stay({ roomPreference: 'standard queen room' })]}
        index={0}
        stayCount={1}
        roomTypes={roomTypes}
        boards={['bb']}
      />,
    );

    renderConfigured([{ code: 'STQN', label: 'Standard Queen' }]);
    expect(selectByLabel('Room type').value).toBe('STQN');
    expect(screen.getByText('Standard Queen ×1')).toBeTruthy();

    cleanup();
    renderConfigured([{ code: 'JNRSUI', label: 'Junior Suite' }]);
    const unavailableRoom = selectByLabel('Room type');
    expect(unavailableRoom.value).toBe('standard queen room');
    expect([...unavailableRoom.options].map((option) => option.value)).not.toContain('STQN');
    expect(screen.getByText('Room type needed ×1')).toBeTruthy();
  });

  it('makes other… focus the full room-type select without changing the row', () => {
    const { onPatch } = renderStay([stay({ roomPreference: 'Single', roomTypeSuggestions: ['STWN', 'SKNG'] })]);
    const select = screen.getByLabelText('Room type');
    fireEvent.click(screen.getByRole('button', { name: 'Choose other room type' }));
    expect(document.activeElement).toBe(select);
    expect(onPatch).not.toHaveBeenCalled();
  });

  it('marks an unset room type as invalid and shortens its placeholder option', () => {
    renderStay([stay({ roomPreference: '', roomTypeCode: undefined })]);
    const select = selectByLabel('Room type');
    expect(select.getAttribute('aria-invalid')).toBe('true');
    expect(select.className).toMatch(/border-\[#c01823\]/);
    expect([...select.options].some((option) => option.textContent === 'Choose room type')).toBe(true);
  });

  it('a rate-card room pick is the row room, so the select shows it over the projected room type', () => {
    renderStay([stay({ roomPreference: 'standard queen', roomTypeCode: 'STQN', roomCodes: ['SKNG'] })]);
    expect(selectByLabel('Room type').value).toBe('SKNG');
  });

  it('choosing a room type in the select clears a rate-card pick and sets the row room', () => {
    const { onPatch } = renderStay([stay({ roomPreference: 'standard queen', roomTypeCode: 'STQN', roomCodes: ['SKNG'] })]);
    fireEvent.change(screen.getByLabelText('Room type'), { target: { value: 'STQN' } });
    expect(onPatch).toHaveBeenLastCalledWith(
      'g1',
      expect.objectContaining({ roomPreference: 'STQN', roomTypeCode: 'STQN', roomCodes: undefined }),
    );
  });

  it('lists every Centurion room type and shows room and guest totals plus the extracted room hint', () => {
    renderStay([stay()], { requestedRoomsTotal: 4 });
    const roomType = selectByLabel('Room type');
    expect([...roomType.options].map((option) => option.value)).toEqual(
      expect.arrayContaining([...ROOM_TYPE_CODES]),
    );
    expect(screen.getByText('1 room · 2 guests total')).toBeTruthy();
    expect(screen.getByText(/Email requested 4 rooms in total/)).toBeTruthy();
  });

  it('shows only the active hotel room and meal-plan choices', () => {
    const props: ComponentProps<typeof StayCard> = {
      stayId: 's1',
      rows: [stay({ roomPreference: '' })],
      index: 0,
      stayCount: 1,
      propertyCode: HRDAV_PROPERTY_CODE,
      roomTypes: [
        { code: 'JNRSUI', label: 'Junior Suite' },
        { code: 'EXKNGB', label: 'Executive King Balcony' },
        { code: 'EXKNGR', label: 'Executive King Round' },
        { code: 'EXKNGS', label: 'Executive King Square' },
        { code: 'DLXPAT', label: 'Deluxe Patio' },
        { code: 'DLXKNG', label: 'Deluxe King' },
        { code: 'ACCES', label: 'Accessible' },
        { code: 'STKNG', label: 'Standard King' },
        { code: 'STWN', label: 'Standard Twin' },
      ],
      boards: ['room_only', 'bb'],
    };
    render(<StayCard {...props} />);

    const roomType = screen.getByLabelText('Room type');
    const roomOptionValues = [...roomType.querySelectorAll('option')].map((option) => option.value);
    expect(roomOptionValues.slice(1)).toEqual([
      'JNRSUI', 'EXKNGB', 'EXKNGR', 'EXKNGS', 'DLXPAT', 'DLXKNG', 'ACCES', 'STKNG', 'STWN',
    ]);
    expect(roomOptionValues).not.toContain('STQN');
    expect(screen.getByRole('option', { name: 'Junior Suite' })).toBeTruthy();
    expect(screen.queryByRole('option', { name: 'JNRSUI' })).toBeNull();
    expect(screen.getByRole('option', { name: 'Standard Twin' })).toBeTruthy();
    expect(screen.queryByRole('option', { name: 'Standard Twin (STWN)' })).toBeNull();
    expect(screen.getByText('Room type needed ×1')).toBeTruthy();
    const mealPlan = screen.getByLabelText('Meal plan');
    expect([...mealPlan.querySelectorAll('option')].map((option) => option.value)).toEqual(['all', 'room_only', 'bb']);
  });

  it('normalizes an HRDAV room-name variant consistently in the picker and quote binder', () => {
    const roomTypes = Object.entries(HRDAV_ROOM_NAMES).map(([code, label]) => ({ code, label }));
    const unlistedPreference = 'standard twin room';
    const props: ComponentProps<typeof StayCard> = {
      stayId: 's1',
      rows: [stay({ roomPreference: unlistedPreference })],
      index: 0,
      stayCount: 1,
      propertyCode: HRDAV_PROPERTY_CODE,
      roomTypes,
      boards: ['room_only', 'bb'],
    };

    render(<StayCard {...props} />);

    const roomType = selectByLabel('Room type');
    expect(
      resolveNativeRoomCodes({ roomPreference: unlistedPreference, propertyCode: HRDAV_PROPERTY_CODE }),
    ).toEqual({ status: 'codes', codes: ['STWN'] });
    expect(roomType.value).toBe('STWN');
    expect(screen.queryByRole('option', { name: 'Email request' })).toBeNull();

    cleanup();
    const exactPreference = 'Standard Twin';
    render(<StayCard {...props} rows={[stay({ roomPreference: exactPreference })]} />);
    expect(selectByLabel('Room type').value).toBe('STWN');
    expect(
      resolveNativeRoomCodes({ roomPreference: exactPreference, propertyCode: HRDAV_PROPERTY_CODE }),
    ).toEqual({
      status: 'codes',
      codes: ['STWN'],
    });
  });

  it('uses a requested-room split header until room quantities are assigned', () => {
    renderStay(
      [stay({ quantity: undefined }), stay({ id: 'g2', quantity: undefined })],
      { requestedRoomsTotal: 30 },
    );
    expect(screen.getByText('30 rooms requested · split not set')).toBeTruthy();
    expect(screen.queryByText(/0 guests total/)).toBeNull();
  });

  it('hides children and special requests behind a per-row toggle, opening it for email values', () => {
    const { unmount } = renderStay([stay()]);
    expect(screen.queryByLabelText('Children ages')).toBeNull();
    expect(screen.queryByLabelText('Special requests')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '+ Children / requests' }));
    expect(screen.getByLabelText('Children ages')).toBeTruthy();
    expect(screen.getByLabelText('Special requests')).toBeTruthy();
    unmount();

    renderStay([stay({ childrenAges: [4], specialRequests: ['cot'] })]);
    expect(screen.getByLabelText('Children ages')).toBeTruthy();
    expect(screen.getByLabelText('Special requests')).toBeTruthy();
  });

  it('removes the per-row company or agency field', () => {
    renderStay([stay()]);
    expect(screen.queryByLabelText('Company or agency')).toBeNull();
  });
});

describe('StayCard: counts Nava did not find', () => {
  it('shows an unset adults value and lets staff start it at one from the inline editor', () => {
    const { onPatch } = renderStay([
      stay({ quantity: undefined, adults: undefined } as Partial<StayGroupRequirement>),
    ]);
    expect(screen.getByRole('group', { name: 'Rooms for stay 1, room 1' }).textContent).toContain('–');
    expect(screen.getByRole('button', { name: 'Fewer: Rooms for stay 1, room 1' })).toHaveProperty('disabled', true);
    expect(screen.getByText('Adults per room not set')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Edit adults per room for stay 1, room 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'More: Adult guests per room for stay 1, room 1' }));
    expect(onPatch).toHaveBeenLastCalledWith('g1', { adults: 1 });
  });
});
