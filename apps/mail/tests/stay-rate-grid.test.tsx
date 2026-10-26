/**
 * @vitest-environment happy-dom
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { StayRateGrid } from '../components/quote-workflow/stay-rate-grid';
import type { BarGridCell } from '../components/quote-workflow/rate-cards';
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

    render(<StayRateGrid groupId="stay-a" cells={cells} onSelect={onSelect} />);

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
});
