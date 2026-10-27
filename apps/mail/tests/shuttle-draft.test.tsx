/**
 * @vitest-environment happy-dom
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ShuttleDraft } from '../components/quote-workflow/shuttle-draft';

const { createDraftMutate, sendMutate } = vi.hoisted(() => ({
  createDraftMutate: vi.fn(),
  sendMutate: vi.fn(),
}));

vi.mock('../providers/query-provider', () => ({
  trpcClient: {
    drafts: { create: { mutate: createDraftMutate } },
    mail: { send: { mutate: sendMutate } },
  },
}));

const provider = { provider: 'Jarat Tours', to: ['shuttle@example.test'] };

function fillDetails() {
  fireEvent.change(screen.getByLabelText('Service date'), { target: { value: '2026-11-21' } });
  fireEvent.change(screen.getByLabelText('Pickup location'), { target: { value: 'Hotel entrance' } });
  fireEvent.change(screen.getByLabelText('Drop-off location'), { target: { value: 'Airport' } });
  fireEvent.change(screen.getByLabelText('Pickup time'), { target: { value: '09:30' } });
  fireEvent.change(screen.getByLabelText('Flight'), { target: { value: 'SA123' } });
  fireEvent.change(screen.getByLabelText('Passengers'), { target: { value: '2' } });
  fireEvent.change(screen.getByLabelText('Booking reference'), { target: { value: 'RES-123' } });
}

beforeEach(() => {
  createDraftMutate.mockReset().mockResolvedValue({ id: 'draft-1' });
  sendMutate.mockReset();
});

afterEach(cleanup);

describe('shuttle request drafts', () => {
  it('saves staff-entered transfer details as a standalone unsent draft and note text', async () => {
    render(<ShuttleDraft config={provider} />);
    fillDetails();

    const note = screen.getByLabelText('Reservation note for HMS') as HTMLTextAreaElement;
    expect(note.value).toContain('Shuttle with Jarat Tours');
    expect(note.value).toContain('Flight: SA123');
    expect(screen.getByText('Copy this into the reservation note; it is not written to HMS.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Save unsent draft' }));

    await waitFor(() => expect(createDraftMutate).toHaveBeenCalledWith({
      id: null,
      threadId: null,
      replyToMessageId: null,
      to: 'shuttle@example.test',
      subject: 'Shuttle request — 2026-11-21',
      message: expect.stringContaining('SA123'),
    }));
    expect(createDraftMutate).toHaveBeenCalledTimes(1);
    expect(sendMutate).not.toHaveBeenCalled();
    expect(screen.getByRole('status').textContent).toContain('Saved as an unsent draft');
  });

  it('fails closed when no provider is configured', () => {
    render(<ShuttleDraft config={null} />);

    expect(screen.getByRole('status').textContent).toContain('not set up');
    expect(screen.queryByLabelText('Pickup location')).toBeNull();
    expect(createDraftMutate).not.toHaveBeenCalled();
  });

  it('shows a plain mailbox error when saving fails and keeps the draft unsent', async () => {
    createDraftMutate.mockRejectedValueOnce(new Error('INTERNAL_SERVER_ERROR: mail store unavailable'));
    render(<ShuttleDraft config={provider} />);
    fireEvent.change(screen.getByLabelText('Pickup location'), { target: { value: 'Hotel entrance' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save unsent draft' }));

    const message = await screen.findByRole('alert');
    expect(message.textContent).toContain('mailbox is busy or unavailable');
    expect(message.textContent).not.toContain('INTERNAL_SERVER_ERROR');
    expect(sendMutate).not.toHaveBeenCalled();
  });
});
