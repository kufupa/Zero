/**
 * @vitest-environment happy-dom
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RequirementCard } from '../components/quote-workflow/requirement-card';
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
    ...overrides,
  };
}

function renderCard(group: StayGroupRequirement, index = 0) {
  const onPatch = vi.fn();
  render(<RequirementCard group={group} index={index} onPatch={onPatch} />);
  return { onPatch };
}

describe('RequirementCard', () => {
  it('changes rooms and adults per room with the steppers', () => {
    const { onPatch } = renderCard(stay());
    fireEvent.click(screen.getByRole('button', { name: 'More: Rooms for stay 1' }));
    expect(onPatch).toHaveBeenLastCalledWith('g1', { quantity: 2 });
    fireEvent.click(screen.getByRole('button', { name: 'More: Adult guests per room for stay 1' }));
    expect(onPatch).toHaveBeenLastCalledWith('g1', { adults: 3 });
  });

  it('keeps the rooms and adults fields reachable by label', () => {
    const { onPatch } = renderCard(stay());
    fireEvent.change(screen.getByLabelText('Rooms'), { target: { value: '3' } });
    expect(onPatch).toHaveBeenLastCalledWith('g1', { quantity: 3 });
    fireEvent.change(screen.getByLabelText('Adults'), { target: { value: '4' } });
    expect(onPatch).toHaveBeenLastCalledWith('g1', { adults: 4 });
  });

  it('renders the meal plan as a required select', () => {
    const { onPatch } = renderCard(stay({ board: 'bb' }));
    const meal = screen.getByLabelText('Meal plan') as HTMLSelectElement;
    expect(meal.tagName).toBe('SELECT');
    expect(meal.value).toBe('bb');
    expect(screen.getByText('Meal plan').parentElement?.textContent).toContain('*');
    fireEvent.change(meal, { target: { value: 'dinner_bb' } });
    expect(onPatch).toHaveBeenLastCalledWith('g1', { board: 'dinner_bb' });
  });

  it('labels a stay after the first, and not the first', () => {
    renderCard(stay(), 0);
    expect(screen.queryByRole('heading', { name: 'Stay 1' })).toBeNull();
    cleanup();
    renderCard(stay({ id: 'g2' }), 1);
    expect(screen.getByRole('heading', { name: 'Stay 2' })).toBeTruthy();
  });

  it('marks values read from the email and defaulted meal plans', () => {
    renderCard(stay({ fields: { arrivalDate: 'extracted', adults: 'extracted', board: 'defaulted' } }));
    expect(screen.getAllByText('from email').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('Default')).toBeTruthy();
  });
});

describe('RequirementCard: counts Nava did not find', () => {
  it('shows a dash, not 0, for rooms and adults that are not entered, and + starts them at 1', () => {
    const { onPatch } = renderCard(stay({ quantity: undefined, adults: undefined } as Partial<StayGroupRequirement>));
    expect(screen.getByRole('group', { name: 'Rooms for stay 1' }).textContent).toContain('–');
    expect(screen.getByRole('button', { name: 'Fewer: Rooms for stay 1' })).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('button', { name: 'More: Adult guests per room for stay 1' }));
    expect(onPatch).toHaveBeenLastCalledWith('g1', { adults: 1 });
  });
});
