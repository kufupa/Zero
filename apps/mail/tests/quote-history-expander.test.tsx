/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { QuoteHistoryExpander } from '../components/create/quote-history-expander';
import type { ParsedMessage } from '@/types';

// Mock useTimezone to return stable timezone
vi.mock('../hooks/use-timezone', () => ({
  useTimezone: () => 'Africa/Johannesburg',
}));

describe('QuoteHistoryExpander (Outlook Quoting Parity)', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  const mockMessage: ParsedMessage = {
    id: 'msg-123',
    sender: { name: 'John Doe', email: 'john@example.com' },
    to: [{ name: 'Jane Smith', email: 'jane@example.com' }],
    cc: [{ name: 'Support', email: 'support@example.com' }],
    subject: 'Room Reservation Confirmation',
    receivedOn: '2026-09-09T12:00:00.000Z',
    decodedBody: '<p>Thank you for your reservation!</p>',
    body: '<p>Thank you for your reservation!</p>',
  } as any;

  it('renders nothing when no replyToMessage is provided', () => {
    const { container } = render(<QuoteHistoryExpander replyToMessage={null} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders collapsed three-dots button with Outlook tooltip accessibility by default', () => {
    render(<QuoteHistoryExpander replyToMessage={mockMessage} />);

    const button = screen.getByRole('button', {
      name: /expand header and show message history/i,
    });
    expect(button).toBeDefined();
    expect(button.textContent).toContain('⋯');
    expect(screen.queryByText(/Message History/i)).toBeNull();
  });

  it('expands to reveal full Outlook headers and body preview on click', () => {
    render(<QuoteHistoryExpander replyToMessage={mockMessage} />);

    const button = screen.getByRole('button', {
      name: /expand header and show message history/i,
    });
    fireEvent.click(button);

    // Header title and action controls
    expect(screen.getByText(/Message History/i)).toBeDefined();
    expect(screen.getByText(/Hide history/i)).toBeDefined();
    expect(screen.getByText(/Remove quote/i)).toBeDefined();

    // Outlook headers
    expect(screen.getByText(/John Doe <john@example.com>/i)).toBeDefined();
    expect(screen.getByText(/Wednesday, September 9, 2026 2:00 PM/i)).toBeDefined();
    expect(screen.getByText(/Jane Smith <jane@example.com>/i)).toBeDefined();
    expect(screen.getByText(/Support <support@example.com>/i)).toBeDefined();
    expect(screen.getByText(/Room Reservation Confirmation/i)).toBeDefined();

    // Quoted body
    expect(screen.getByText(/Thank you for your reservation!/i)).toBeDefined();
  });

  it('collapses back to three-dots when "Hide history" is clicked', () => {
    render(<QuoteHistoryExpander replyToMessage={mockMessage} />);

    // Expand
    fireEvent.click(
      screen.getByRole('button', { name: /expand header and show message history/i }),
    );
    expect(screen.getByText(/Message History/i)).toBeDefined();

    // Hide
    fireEvent.click(screen.getByText(/Hide history/i));
    expect(screen.queryByText(/Message History/i)).toBeNull();
    expect(
      screen.getByRole('button', { name: /expand header and show message history/i }),
    ).toBeDefined();
  });

  it('handles "Remove quote" and "Undo" transitions via onExcludeChange callback', () => {
    const onExcludeChange = vi.fn();
    const { rerender } = render(
      <QuoteHistoryExpander
        replyToMessage={mockMessage}
        isExcluded={false}
        onExcludeChange={onExcludeChange}
      />,
    );

    // Expand and click Remove quote
    fireEvent.click(
      screen.getByRole('button', { name: /expand header and show message history/i }),
    );
    fireEvent.click(screen.getByText(/Remove quote/i));
    expect(onExcludeChange).toHaveBeenCalledWith(true);

    // Rerender with isExcluded = true
    rerender(
      <QuoteHistoryExpander
        replyToMessage={mockMessage}
        isExcluded={true}
        onExcludeChange={onExcludeChange}
      />,
    );

    expect(screen.getByText(/Quoted message removed from this reply/i)).toBeDefined();
    const undoButton = screen.getByText(/Undo/i);
    expect(undoButton).toBeDefined();

    fireEvent.click(undoButton);
    expect(onExcludeChange).toHaveBeenCalledWith(false);
  });
});
