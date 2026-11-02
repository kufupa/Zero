/** @vitest-environment happy-dom */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { BatchRoomInclusion } from '../components/quote-workflow/batch-room-inclusion';

afterEach(cleanup);

const rooms = [
  { id: 'row-a:1', label: 'Queen room · Guest A' },
  { id: 'row-b:1', label: 'Twin room · Guest B' },
  { id: 'row-b:2', label: 'Twin room · Guest C' },
];

it('reports inclusion changes in original allocation order and drops stale identities', () => {
  const onChange = vi.fn();
  const { rerender } = render(<BatchRoomInclusion rooms={rooms} included={['row-b:1', 'removed']} disabled={false} onChange={onChange} />);
  fireEvent.click(screen.getByRole('checkbox', { name: /Queen room/ }));
  expect(onChange).toHaveBeenLastCalledWith(['row-a:1', 'row-b:1']);
  rerender(<BatchRoomInclusion rooms={rooms} included={['row-a:1', 'row-b:1']} disabled={false} onChange={onChange} />);
  fireEvent.click(screen.getByRole('checkbox', { name: /Twin room · Guest B/ }));
  expect(onChange).toHaveBeenLastCalledWith(['row-a:1']);
});

it('locks all inclusion controls while a booking is active', () => {
  const onChange = vi.fn();
  render(<BatchRoomInclusion rooms={rooms} included={['row-a:1']} disabled onChange={onChange} />);
  const checkboxes = screen.getAllByRole('checkbox');
  expect(checkboxes).toHaveLength(3);
  for (const box of checkboxes) expect((box as HTMLInputElement).disabled).toBe(true);
  fireEvent.click(checkboxes[0]!);
  expect(onChange).not.toHaveBeenCalled();
});

it('holds duplicate or missing allocation identifiers instead of merging rooms', () => {
  const onChange = vi.fn();
  const { rerender } = render(<BatchRoomInclusion rooms={[rooms[0]!, rooms[0]!]} included={[]} disabled={false} onChange={onChange} />);
  expect(screen.getByRole('alert').textContent).toMatch(/need checking/);
  expect(screen.queryByRole('checkbox')).toBeNull();
  rerender(<BatchRoomInclusion rooms={[{ id: '', label: 'Unknown room' }]} included={[]} disabled={false} onChange={onChange} />);
  expect(screen.getByRole('alert').textContent).toMatch(/need checking/);
  expect(onChange).not.toHaveBeenCalled();
});
