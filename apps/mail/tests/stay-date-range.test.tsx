/**
 * @vitest-environment happy-dom
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StayDateRange } from '../components/quote-workflow/stay-date-range';

afterEach(cleanup);

function renderRange(props: Partial<Parameters<typeof StayDateRange>[0]> = {}) {
  const onChange = vi.fn();
  render(<StayDateRange arrival="2026-10-15" departure="2026-10-17" onChange={onChange} {...props} />);
  return { onChange };
}

function openCalendar() {
  fireEvent.click(screen.getByRole('button', { name: /change dates/i }));
}

/** A day cell in the open calendar, by its number. */
function dayButton(day: number): HTMLElement {
  const match = Array.from(document.querySelectorAll<HTMLButtonElement>('button[name="day"]')).find(
    (button) => button.textContent === String(day),
  );
  if (!match) throw new Error(`no day ${day} in the calendar`);
  return match;
}

describe('StayDateRange', () => {
  it('shows both dates as tiles and the nights between them', () => {
    renderRange();
    expect(screen.getByRole('button', { name: /check-in/i }).textContent).toContain('Thu 15 Oct 2026');
    expect(screen.getByRole('button', { name: /check-out/i }).textContent).toContain('Sat 17 Oct 2026');
    expect(screen.getByText('2 nights', { selector: 'span' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '1 night' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '7 nights' })).toBeTruthy();
  });

  it('uses the singular for one night and flags a departure before arrival', () => {
    const { unmount } = render(
      <StayDateRange arrival="2026-10-15" departure="2026-10-16" onChange={vi.fn()} />,
    );
    expect(screen.getByText('1 night', { selector: 'span' })).toBeTruthy();
    unmount();
    render(<StayDateRange arrival="2026-10-17" departure="2026-10-15" onChange={vi.fn()} />);
    expect(screen.getByText('Check the dates')).toBeTruthy();
  });

  it('asks for both dates when they are missing', () => {
    renderRange({ arrival: '', departure: '' });
    expect(screen.getByText('Pick both dates')).toBeTruthy();
    expect(screen.getAllByText('Pick a date')).toHaveLength(2);
  });

  it('opens the calendar on the arrival month, not today', () => {
    renderRange({ arrival: '2026-03-10', departure: '2026-03-12' });
    openCalendar();
    expect(screen.getByText('March 2026')).toBeTruthy();
  });

  it('moves between months with its own header', () => {
    renderRange({ arrival: '2026-03-10', departure: '2026-03-12' });
    openCalendar();
    fireEvent.click(screen.getByRole('button', { name: 'Next month' }));
    expect(screen.getByText('April 2026')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Previous month' }));
    fireEvent.click(screen.getByRole('button', { name: 'Previous month' }));
    expect(screen.getByText('February 2026')).toBeTruthy();
  });

  it('sets the departure from a calendar click after the arrival', () => {
    const { onChange } = renderRange({ arrival: '2026-10-10', departure: '' });
    openCalendar();
    fireEvent.click(dayButton(14));
    expect(onChange).toHaveBeenLastCalledWith({ departureDate: '2026-10-14' });
  });

  it('moves the arrival from its tile and keeps a departure that is still after it', () => {
    const { onChange } = renderRange({ arrival: '2026-10-10', departure: '2026-10-14' });
    fireEvent.click(screen.getByRole('button', { name: /check-in/i }));
    fireEvent.click(dayButton(12));
    expect(onChange).toHaveBeenLastCalledWith({ arrivalDate: '2026-10-12', departureDate: '2026-10-14' });
  });

  it('clears a departure that the new arrival passes', () => {
    const { onChange } = renderRange({ arrival: '2026-10-10', departure: '2026-10-14' });
    fireEvent.click(screen.getByRole('button', { name: /check-in/i }));
    fireEvent.click(dayButton(16));
    expect(onChange).toHaveBeenLastCalledWith({ arrivalDate: '2026-10-16', departureDate: '' });
  });

  it('sets the departure from a quick night pill without first opening the calendar', () => {
    const { onChange } = renderRange();
    fireEvent.click(screen.getByRole('button', { name: '3 nights' }));
    expect(onChange).toHaveBeenLastCalledWith({ departureDate: '2026-10-18' });
  });

  it('keeps the typed date inputs reachable by label', () => {
    const { onChange } = renderRange();
    fireEvent.change(screen.getByLabelText('Departure'), { target: { value: '2026-10-19' } });
    expect(onChange).toHaveBeenLastCalledWith({ departureDate: '2026-10-19' });
    fireEvent.change(screen.getByLabelText('Arrival'), { target: { value: '2026-10-13' } });
    expect(onChange).toHaveBeenLastCalledWith({ arrivalDate: '2026-10-13' });
  });

  it('marks a date read from the email', () => {
    renderRange({ provenance: { arrival: 'extracted' } });
    expect(screen.getByText('from email')).toBeTruthy();
  });
});
