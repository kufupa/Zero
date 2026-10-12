/**
 * @vitest-environment happy-dom
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StayCard } from '../components/quote-workflow/requirement-card';
import type { StayGroupRequirement } from '../lib/quote-workflow/types';
import { ROOM_TYPE_CODES } from '../lib/quote-workflow/room-types';

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
    const meal = screen.getByLabelText('Meal plan') as HTMLSelectElement;
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

  it('marks values read from the email and defaulted meal plans', () => {
    renderStay([stay({ fields: { arrivalDate: 'extracted', adults: 'extracted', board: 'defaulted' } })]);
    expect(screen.getAllByText('from email').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('Default')).toBeTruthy();
  });

  it('shows the dates once for the stay, under Check-in and Check-out', () => {
    renderStay([stay(), stay({ id: 'g2' })]);
    expect(screen.getByText('Check-in')).toBeTruthy();
    expect(screen.getByText('Check-out')).toBeTruthy();
    expect(screen.getAllByText('Check-in')).toHaveLength(1);
  });

  it('preselects the exact room type projection and never guesses an ambiguous room label', () => {
    const { unmount } = renderStay([stay({ roomPreference: 'standard queen', roomTypeCode: 'STQN' })]);
    expect((screen.getByLabelText('Room type') as HTMLSelectElement).value).toBe('STQN');
    unmount();

    renderStay([stay({ roomPreference: 'double room', roomTypeSuggestions: ['STQN', 'SKNG'] })]);
    expect((screen.getByLabelText('Room type') as HTMLSelectElement).value).toBe('double room');
    expect(screen.getByText(/Email said .double room. → Standard Queen \(STQN\) or Standard King \(SKNG\)\?/)).toBeTruthy();
  });

  it('a rate-card room pick is the row room, so the select shows it over the projected room type', () => {
    renderStay([stay({ roomPreference: 'standard queen', roomTypeCode: 'STQN', roomCodes: ['SKNG'] })]);
    expect((screen.getByLabelText('Room type') as HTMLSelectElement).value).toBe('SKNG');
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
    const roomType = screen.getByLabelText('Room type') as HTMLSelectElement;
    expect([...roomType.options].map((option) => option.value)).toEqual(
      expect.arrayContaining([...ROOM_TYPE_CODES]),
    );
    expect(screen.getByText('1 room · 2 guests total')).toBeTruthy();
    expect(screen.getByText(/Email requested 4 rooms in total/)).toBeTruthy();
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
