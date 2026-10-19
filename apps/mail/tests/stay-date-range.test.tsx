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

function nightsSelect(): HTMLSelectElement {
  const element = screen.getByLabelText('Nights');
  if (!(element instanceof HTMLSelectElement)) throw new Error('Nights is not a select');
  return element;
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
  it('shows both dates and offers a nights select instead of quick chips', () => {
    renderRange();
    expect(screen.getByRole('button', { name: /check-in/i }).textContent).toContain('Thu 15 Oct 2026');
    expect(screen.getByRole('button', { name: /check-out/i }).textContent).toContain('Sat 17 Oct 2026');
    expect((nightsSelect()).value).toBe('2');
    expect(screen.queryByRole('button', { name: '1 night' })).toBeNull();
    expect(screen.queryByRole('button', { name: '7 nights' })).toBeNull();
  });

  it('uses the singular for one night and flags a departure before arrival', () => {
    const { unmount } = render(
      <StayDateRange arrival="2026-10-15" departure="2026-10-16" onChange={vi.fn()} />,
    );
    expect(nightsSelect().value).toBe('1');
    unmount();
    render(<StayDateRange arrival="2026-10-17" departure="2026-10-15" onChange={vi.fn()} />);
    expect(screen.getByText('Check the dates')).toBeTruthy();
  });

  it('shows empty date tiles and disables nights until arrival is set', () => {
    renderRange({ arrival: '', departure: '' });
    expect(screen.getAllByText('Pick a date')).toHaveLength(2);
    expect(nightsSelect().disabled).toBe(true);
    expect(nightsSelect().selectedIndex).toBe(0);
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

  it('starts calendar selection with an arrival date', () => {
    const { onChange } = renderRange({ arrival: '2026-10-10', departure: '' });
    openCalendar();
    fireEvent.click(dayButton(14));
    expect(onChange).toHaveBeenLastCalledWith({ arrivalDate: '2026-10-14', departureDate: '' });
  });

  it('starts a new range after a complete range and resets again on the third click', () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <StayDateRange arrival="2026-10-15" departure="2026-10-17" onChange={onChange} />,
    );
    openCalendar();
    fireEvent.click(dayButton(20));
    expect(onChange).toHaveBeenLastCalledWith({ arrivalDate: '2026-10-20', departureDate: '' });
    rerender(<StayDateRange arrival="2026-10-20" departure="" onChange={onChange} />);

    fireEvent.click(dayButton(23));
    expect(onChange).toHaveBeenLastCalledWith({ departureDate: '2026-10-23' });
    rerender(<StayDateRange arrival="2026-10-20" departure="2026-10-23" onChange={onChange} />);

    fireEvent.click(dayButton(25));
    expect(onChange).toHaveBeenLastCalledWith({ arrivalDate: '2026-10-25', departureDate: '' });
  });

  it('restarts arrival when a second click is not later', () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <StayDateRange arrival="" departure="" onChange={onChange} />,
    );
    openCalendar();
    fireEvent.click(dayButton(20));
    expect(onChange).toHaveBeenLastCalledWith({ arrivalDate: '2026-10-20', departureDate: '' });
    rerender(<StayDateRange arrival="2026-10-20" departure="" onChange={onChange} />);

    fireEvent.click(dayButton(18));
    expect(onChange).toHaveBeenLastCalledWith({ arrivalDate: '2026-10-18', departureDate: '' });
  });

  it('clears a departure that the new arrival passes', () => {
    const { onChange } = renderRange({ arrival: '2026-10-10', departure: '2026-10-14' });
    fireEvent.click(screen.getByRole('button', { name: /check-in/i }));
    fireEvent.click(dayButton(16));
    expect(onChange).toHaveBeenLastCalledWith({ arrivalDate: '2026-10-16', departureDate: '' });
  });

  it('sets departure from arrival plus selected nights', () => {
    const { onChange } = renderRange();
    const nights = nightsSelect();
    expect(nights.options[0]?.textContent).toBe('Select');
    expect([...nights.options].slice(1).map((option) => option.value)).toEqual([
      '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13', '14',
    ]);
    fireEvent.change(nights, { target: { value: '5' } });
    expect(onChange).toHaveBeenLastCalledWith({ departureDate: '2026-10-20' });
  });

  it('starts a new calendar range after Nights completes the stay', () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <StayDateRange arrival="2026-10-15" departure="2026-10-17" onChange={onChange} />,
    );
    openCalendar();
    fireEvent.click(dayButton(20));
    expect(onChange).toHaveBeenLastCalledWith({ arrivalDate: '2026-10-20', departureDate: '' });
    rerender(<StayDateRange arrival="2026-10-20" departure="" onChange={onChange} />);

    fireEvent.change(nightsSelect(), { target: { value: '3' } });
    expect(onChange).toHaveBeenLastCalledWith({ departureDate: '2026-10-23' });
    rerender(<StayDateRange arrival="2026-10-20" departure="2026-10-23" onChange={onChange} />);

    fireEvent.click(dayButton(25));
    expect(onChange).toHaveBeenLastCalledWith({ arrivalDate: '2026-10-25', departureDate: '' });
  });

  it('includes the current stay length when it exceeds fourteen nights', () => {
    renderRange({ arrival: '2026-10-15', departure: '2026-11-05' });
    const nights = nightsSelect();
    expect(nights.value).toBe('21');
    expect([...nights.options].map((option) => option.value)).toContain('21');
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
