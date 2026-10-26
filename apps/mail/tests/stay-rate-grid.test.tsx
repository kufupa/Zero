/**
 * @vitest-environment happy-dom
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { StayRateGrid } from '../components/quote-workflow/stay-rate-grid';
import type { BarGridCell } from '../components/quote-workflow/rate-cards';
import type { RatePlanChoice } from '../components/quote-workflow/rate-plan-select';
import { draftMoney } from '../lib/quote-workflow/multi-option-draft';

afterEach(cleanup);

describe('StayRateGrid', () => {
  it('emits the clicked room/rate/board tuple and displays that cell’s price and inventory', () => {
    const onSelect = vi.fn();
    const cells: BarGridCell[] = [
      {
        groupId: 'stay-a',
        roomCode: 'STWN',
        roomLabel: 'Standard Twin',
        rateCode: 'RATE-1',
        rateLabel: 'Flexible',
        board: 'bb',
        boardLabel: 'Bed & breakfast',
        nightlyPriceMinor: 215_000,
        roomsLeft: 5,
      },
      {
        groupId: 'stay-a',
        roomCode: 'STWN',
        roomLabel: 'Standard Twin',
        rateCode: 'RATE-2',
        rateLabel: 'Flexible',
        board: 'bb',
        boardLabel: 'Bed & breakfast',
        nightlyPriceMinor: 197_500,
        roomsLeft: 2,
      },
      {
        groupId: 'stay-b',
        roomCode: 'STWN',
        roomLabel: 'Standard Twin',
        rateCode: 'RATE-2',
        rateLabel: 'Flexible',
        board: 'bb',
        boardLabel: 'Bed & breakfast',
        nightlyPriceMinor: 180_000,
        roomsLeft: 1,
      },
    ];

    render(
      <StayRateGrid
        groupId="stay-a"
        cells={cells}
        contractChecked={false}
        plans={[]}
        onSelect={onSelect}
      />,
    );

    const grid = screen.getByRole('group', { name: 'Room, rate and board choices' });
    const selectedCell = within(grid).getByRole('button', { name: /RATE-2/ });
    fireEvent.click(selectedCell);

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith({ roomCode: 'STWN', rateCode: 'RATE-2', board: 'bb' });
    expect(selectedCell.textContent).toContain(draftMoney(197_500));
    expect(within(selectedCell).getByText('Rooms left: 2')).toBeDefined();
    expect(screen.getByText(/reference only/i)).toBeDefined();
    expect(within(grid).queryByText(draftMoney(180_000))).toBeNull();
  });

  it('preserves rate category tags and warns until contract context is checked', () => {
    const onSelect = vi.fn();
    const cells: BarGridCell[] = [
      {
        groupId: 'stay-a',
        roomCode: 'ROOM1',
        roomLabel: 'Room One',
        rateCode: 'BAR',
        rateLabel: 'Best Available Rate',
        board: 'bb',
        boardLabel: 'Bed & breakfast',
        nightlyPriceMinor: null,
        roomsLeft: null,
        rateScope: 'public',
      },
      {
        groupId: 'stay-a',
        roomCode: 'ROOM1',
        roomLabel: 'Room One',
        rateCode: 'GOV1',
        rateLabel: 'Government plan',
        board: 'bb',
        boardLabel: 'Bed & breakfast',
        nightlyPriceMinor: null,
        roomsLeft: null,
        rateScope: 'unknown',
      },
      {
        groupId: 'stay-a',
        roomCode: 'ROOM1',
        roomLabel: 'Room One',
        rateCode: 'CON1',
        rateLabel: 'PRESET plan',
        board: 'bb',
        boardLabel: 'Bed & breakfast',
        nightlyPriceMinor: null,
        roomsLeft: null,
        rateScope: 'contextual',
      },
    ];
    const plans = [
      {
        code: 'GOV1',
        name: 'Government plan',
        board: 'bed_breakfast',
        government: true,
        category: 'government',
        readByNava: true,
      },
      {
        code: 'CON1',
        name: 'PRESET plan',
        board: 'bed_breakfast',
        contract: true,
        category: 'contract',
        readByNava: true,
      },
    ] satisfies RatePlanChoice[];
    const { rerender } = render(
      <StayRateGrid
        groupId="stay-a"
        cells={cells}
        contractChecked={false}
        plans={plans}
        onSelect={onSelect}
      />,
    );
    const grid = screen.getByRole('group', { name: 'Room, rate and board choices' });

    expect(screen.getByText('Public rates — contract not checked')).toBeDefined();
    expect(within(grid).getByText('Public')).toBeDefined();
    expect(within(grid).getByText('Government')).toBeDefined();
    expect(within(grid).queryByText('Contract')).toBeNull();

    rerender(
      <StayRateGrid
        groupId="stay-a"
        cells={cells}
        contractChecked={true}
        plans={plans}
        onSelect={onSelect}
      />,
    );

    expect(screen.queryByText('Public rates — contract not checked')).toBeNull();
    const checkedGrid = screen.getByRole('group', { name: 'Room, rate and board choices' });
    expect(within(checkedGrid).getByText('Contract')).toBeDefined();
  });
});
