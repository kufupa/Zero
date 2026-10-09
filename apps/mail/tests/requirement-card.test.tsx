/**
 * @vitest-environment happy-dom
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StayCard } from '../components/quote-workflow/requirement-card';
import type { StayGroupRequirement } from '../lib/quote-workflow/types';

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

function renderStay(rows: StayGroupRequirement[], { index = 0, stayCount = 1 } = {}) {
  const onPatch = vi.fn();
  const onStayAction = vi.fn();
  render(
    <StayCard stayId="s1" rows={rows} index={index} stayCount={stayCount} onPatch={onPatch} onStayAction={onStayAction} />,
  );
  return { onPatch, onStayAction };
}

describe('StayCard rooms', () => {
  it('changes rooms and adults per room with the steppers', () => {
    const { onPatch } = renderStay([stay()]);
    fireEvent.click(screen.getByRole('button', { name: 'More: Rooms for stay 1, room 1' }));
    expect(onPatch).toHaveBeenLastCalledWith('g1', { quantity: 2 });
    fireEvent.click(screen.getByRole('button', { name: 'More: Adult guests per room for stay 1, room 1' }));
    expect(onPatch).toHaveBeenLastCalledWith('g1', { adults: 3 });
  });

  it('keeps the rooms and adults fields reachable by label', () => {
    const { onPatch } = renderStay([stay()]);
    fireEvent.change(screen.getByLabelText('Rooms'), { target: { value: '3' } });
    expect(onPatch).toHaveBeenLastCalledWith('g1', { quantity: 3 });
    fireEvent.change(screen.getByLabelText('Adults'), { target: { value: '4' } });
    expect(onPatch).toHaveBeenLastCalledWith('g1', { adults: 4 });
  });

  it('renders the meal plan as a required select', () => {
    const { onPatch } = renderStay([stay({ board: 'bb' })]);
    const meal = screen.getByLabelText('Meal plan') as HTMLSelectElement;
    expect(meal.tagName).toBe('SELECT');
    expect(meal.value).toBe('bb');
    expect(screen.getByText('Meal plan').parentElement?.textContent).toContain('*');
    fireEvent.change(meal, { target: { value: 'dinner_bb' } });
    expect(onPatch).toHaveBeenLastCalledWith('g1', { board: 'dinner_bb' });
  });

  it('names a stay only when the request has more than one', () => {
    renderStay([stay()], { index: 0, stayCount: 1 });
    expect(screen.queryByRole('heading', { name: 'Stay 1' })).toBeNull();
    cleanup();
    renderStay([stay({ id: 'g2' })], { index: 1, stayCount: 2 });
    expect(screen.getByRole('heading', { name: 'Stay 2' })).toBeTruthy();
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
});

describe('StayCard: counts Nava did not find', () => {
  it('shows a dash, not 0, for rooms and adults that are not entered, and + starts them at 1', () => {
    const { onPatch } = renderStay([
      stay({ quantity: undefined, adults: undefined } as Partial<StayGroupRequirement>),
    ]);
    expect(screen.getByRole('group', { name: 'Rooms for stay 1, room 1' }).textContent).toContain('–');
    expect(screen.getByRole('button', { name: 'Fewer: Rooms for stay 1, room 1' })).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('button', { name: 'More: Adult guests per room for stay 1, room 1' }));
    expect(onPatch).toHaveBeenLastCalledWith('g1', { adults: 1 });
  });
});
