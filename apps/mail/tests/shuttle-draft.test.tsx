/**
 * @vitest-environment happy-dom
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readShuttleProviderConfig } from '../../server-pilot/src/ai/shuttle-draft.js';
import { ShuttleDraft } from '../components/quote-workflow/shuttle-draft';

const { createDraftMutate, sendMutate, invalidateQueries } = vi.hoisted(() => ({
  createDraftMutate: vi.fn(),
  sendMutate: vi.fn(),
  invalidateQueries: vi.fn(),
}));

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries }),
}));

vi.mock('../providers/query-provider', () => ({
  trpcClient: {
    drafts: { create: { mutate: createDraftMutate } },
    mail: { send: { mutate: sendMutate } },
  },
  useTRPC: () => ({
    drafts: { list: { queryKey: () => ['drafts', 'list'] } },
    mail: { unreadCounts: { queryKey: () => ['mail', 'unreadCounts'] } },
  }),
}));

const provider = { provider: 'Jarat Tours', to: ['shuttle@example.test'] };
const transportId = 'transport-1';
const malformedProviderSettings: Array<[string, unknown]> = [
  ['mixed valid and invalid recipients', { provider: 'Jarat Tours', to: ['shuttle@example.test', 'bad-address'] }],
  ['empty recipients', { provider: 'Jarat Tours', to: [] }],
  ['non-array recipients', { provider: 'Jarat Tours', to: 'shuttle@example.test' }],
  ['non-string recipient', { provider: 'Jarat Tours', to: ['shuttle@example.test', 7] }],
  ['empty provider', { provider: '  ', to: ['shuttle@example.test'] }],
  ['provider with a control character', { provider: 'Jarat\nTours', to: ['shuttle@example.test'] }],
];

function fillDetails() {
  fireEvent.change(screen.getByLabelText('Service date'), { target: { value: '2026-11-21' } });
  fireEvent.change(screen.getByLabelText('Pickup location'), { target: { value: 'Hotel <main>' } });
  fireEvent.change(screen.getByLabelText('Drop-off location'), { target: { value: 'Airport' } });
  fireEvent.change(screen.getByLabelText('Pickup time'), { target: { value: '09:30' } });
  fireEvent.change(screen.getByLabelText('Flight'), { target: { value: 'SA123' } });
  fireEvent.change(screen.getByLabelText('Passengers'), { target: { value: '2' } });
  fireEvent.change(screen.getByLabelText('Booking reference'), { target: { value: 'RES-123' } });
}

beforeEach(() => {
  createDraftMutate.mockReset().mockResolvedValue({ id: 'draft-1' });
  sendMutate.mockReset();
  invalidateQueries.mockReset().mockResolvedValue(undefined);
});

afterEach(cleanup);

describe('shuttle request drafts', () => {
  it('saves staff-entered transfer details as a standalone unsent draft and note text', async () => {
    render(<ShuttleDraft config={provider} transportId={transportId} />);
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
      message: expect.stringMatching(/Hotel &lt;main&gt;[\s\S]*SA123/),
    }, { context: { activeTransportId: transportId } }));
    expect(createDraftMutate).toHaveBeenCalledTimes(1);
    expect(sendMutate).not.toHaveBeenCalled();
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['drafts', 'list'] });
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['mail', 'unreadCounts'] });
    expect(screen.getByRole('status').textContent).toContain('Saved as an unsent draft');
  });

  it('fails closed when no provider is configured', () => {
    render(<ShuttleDraft config={null} transportId={transportId} />);

    expect(screen.getByRole('status').textContent).toContain('not set up');
    expect(screen.queryByLabelText('Pickup location')).toBeNull();
    expect(createDraftMutate).not.toHaveBeenCalled();
  });

  it.each(malformedProviderSettings)('rejects %s shuttle settings', (_caseName, settings) => {
    expect(readShuttleProviderConfig(settings)).toBeNull();
  });

  it('locks transfer details while saving the unsent draft', async () => {
    let completeSave = () => {};
    createDraftMutate.mockImplementationOnce(() => new Promise((resolve) => {
      completeSave = () => resolve({ id: 'draft-1' });
    }));
    render(<ShuttleDraft config={provider} transportId={transportId} />);
    const pickup = screen.getByLabelText('Pickup location') as HTMLInputElement;
    fireEvent.change(pickup, { target: { value: 'Hotel entrance' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save unsent draft' }));

    await waitFor(() => expect(pickup.disabled).toBe(true));
    await act(async () => completeSave());
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Saved as an unsent draft'));
  });

  it('shows a plain mailbox error when saving fails and keeps the draft unsent', async () => {
    createDraftMutate.mockRejectedValueOnce(new Error('INTERNAL_SERVER_ERROR: mail store unavailable'));
    render(<ShuttleDraft config={provider} transportId={transportId} />);
    fireEvent.change(screen.getByLabelText('Pickup location'), { target: { value: 'Hotel entrance' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save unsent draft' }));

    const message = await screen.findByRole('alert');
    expect(message.textContent).toContain('mailbox is busy or unavailable');
    expect(message.textContent).not.toContain('INTERNAL_SERVER_ERROR');
    expect(sendMutate).not.toHaveBeenCalled();
  });
});
