/**
 * @vitest-environment happy-dom
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readShuttleProviderConfig } from '../../server-pilot/src/ai/shuttle-draft.js';
import { ShuttleDraft } from '../components/quote-workflow/shuttle-draft';

const { createDraftCommand } = vi.hoisted(() => ({ createDraftCommand: vi.fn() }));

const provider = { provider: 'Jarat Tours', to: ['shuttle@example.test'] };
const storeId = 'store-1';
const savedDraftLocation = {
  entryId: 'outlook-draft-1',
  storeId,
  folderEntryId: 'drafts-folder',
  folderName: 'Drafts',
  displayed: false,
};
const nativeDraftBridge = {
  sendCommand: createDraftCommand as never,
  supportsAction: () => true,
};
const malformedProviderSettings: Array<[string, unknown]> = [
  ['mixed valid and invalid recipients', { provider: 'Jarat Tours', to: ['shuttle@example.test', 'bad-address'] }],
  ['empty recipients', { provider: 'Jarat Tours', to: [] }],
  ['non-array recipients', { provider: 'Jarat Tours', to: 'shuttle@example.test' }],
  ['non-string recipient', { provider: 'Jarat Tours', to: ['shuttle@example.test', 7] }],
  ['recipient with a list separator', { provider: 'Jarat Tours', to: ['desk;shuttle@example.test'] }],
  ['recipient with a control character', { provider: 'Jarat Tours', to: ['desk\u0000@example.test'] }],
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

function openDraftForm() {
  fireEvent.click(screen.getByRole('button', { name: 'Draft shuttle request' }));
}

beforeEach(() => {
  createDraftCommand.mockReset().mockResolvedValue(savedDraftLocation);
});

afterEach(cleanup);

describe('shuttle request drafts', () => {
  it('saves staff-entered transfer details as a standalone Outlook draft and note text', async () => {
    render(
      <ShuttleDraft
        bridge={nativeDraftBridge}
        config={provider}
        storeId={storeId}
      />,
    );
    openDraftForm();
    fillDetails();

    const note = screen.getByLabelText('Reservation note for HMS') as HTMLTextAreaElement;
    expect(note.value).toContain('Shuttle with Jarat Tours');
    expect(note.value).toContain('Flight: SA123');
    expect(screen.getByText('Copy this into the reservation note; it is not written to HMS.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Save unsent draft' }));

    await waitFor(() => expect(createDraftCommand).toHaveBeenCalledWith(
      'CREATE_DRAFT',
      expect.objectContaining({
        operationId: expect.stringMatching(/^op_\d+_[0-9a-f]{32}$/i),
        storeId,
        to: 'shuttle@example.test',
        subject: 'Shuttle request — 2026-11-21',
        htmlBody: expect.stringMatching(/Hotel &lt;main&gt;[\s\S]*SA123/),
        openInComposer: false,
      }),
    ));
    expect(createDraftCommand).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status').textContent).toContain('Saved as an unsent Outlook draft');
  });

  it('renders nothing when no provider is configured', () => {
    const { container } = render(<ShuttleDraft config={null} />);

    expect(container.firstChild).toBeNull();
    expect(screen.queryByText(/not set up/i)).toBeNull();
    expect(createDraftCommand).not.toHaveBeenCalled();
  });

  it('keeps transfer details collapsed until staff open the shuttle request', () => {
    render(<ShuttleDraft config={provider} />);

    expect(screen.queryByLabelText('Service date')).toBeNull();
    openDraftForm();
    expect(screen.getByLabelText('Service date')).toBeTruthy();
  });

  it('prefills service date from stay arrival', () => {
    render(<ShuttleDraft config={provider} arrivalDate="2026-11-21" />);
    openDraftForm();

    expect((screen.getByLabelText('Service date') as HTMLInputElement).value).toBe('2026-11-21');
    expect((screen.getByLabelText('Pickup location') as HTMLInputElement).value).toBe('');
  });

  it('does not fall back to a Zero draft when Outlook draft creation is unavailable', () => {
    render(
      <ShuttleDraft
        bridge={{ ...nativeDraftBridge, supportsAction: () => false }}
        config={provider}
        storeId={storeId}
      />,
    );
    openDraftForm();

    expect(screen.getByRole('status').textContent).toContain('Outlook draft creation is not available');
    expect(screen.getByRole('button', { name: 'Save unsent draft' }).hasAttribute('disabled')).toBe(true);
    expect(createDraftCommand).not.toHaveBeenCalled();
  });

  it.each(malformedProviderSettings)('rejects %s shuttle settings', (_caseName, settings) => {
    expect(readShuttleProviderConfig(settings)).toBeNull();
  });

  it('locks transfer details while saving the unsent draft', async () => {
    let completeSave = () => {};
    createDraftCommand.mockImplementationOnce(() => new Promise((resolve) => {
      completeSave = () => resolve(savedDraftLocation);
    }));
    render(
      <ShuttleDraft
        bridge={nativeDraftBridge}
        config={provider}
        storeId={storeId}
      />,
    );
    openDraftForm();
    const pickup = screen.getByLabelText('Pickup location') as HTMLInputElement;
    fireEvent.change(pickup, { target: { value: 'Hotel entrance' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save unsent draft' }));

    await waitFor(() => expect(pickup.disabled).toBe(true));
    await act(async () => completeSave());
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Saved as an unsent Outlook draft'));
  });

  it('shows a plain mailbox error when saving fails and keeps the draft unsent', async () => {
    createDraftCommand.mockRejectedValueOnce(new Error('DRAFT_OUTLOOK_SECRET: mailbox unavailable'));
    render(
      <ShuttleDraft
        bridge={nativeDraftBridge}
        config={provider}
        storeId={storeId}
      />,
    );
    openDraftForm();
    fireEvent.change(screen.getByLabelText('Pickup location'), { target: { value: 'Hotel entrance' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save unsent draft' }));

    const message = await screen.findByRole('alert');
    expect(message.textContent).toContain('Outlook is busy or unavailable');
    expect(message.textContent).toContain('may have been saved');
    expect(message.textContent).not.toContain('DRAFT_OUTLOOK_SECRET');
    expect(createDraftCommand.mock.calls.map(([action]) => action)).toEqual(['CREATE_DRAFT']);
  });

  it('reuses the operation id when staff retry an unconfirmed save', async () => {
    createDraftCommand
      .mockRejectedValueOnce(new Error('Outlook command timed out'))
      .mockResolvedValueOnce(savedDraftLocation);
    render(
      <ShuttleDraft
        bridge={nativeDraftBridge}
        config={provider}
        storeId={storeId}
      />,
    );
    openDraftForm();
    fireEvent.change(screen.getByLabelText('Pickup location'), { target: { value: 'Hotel entrance' } });

    fireEvent.click(screen.getByRole('button', { name: 'Save unsent draft' }));
    await screen.findByRole('alert');
    expect((screen.getByLabelText('Pickup location') as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Save unsent draft' }));

    await waitFor(() => expect(createDraftCommand).toHaveBeenCalledTimes(2));
    expect(createDraftCommand.mock.calls[0]?.[1]).toMatchObject({ operationId: expect.any(String) });
    expect(createDraftCommand.mock.calls[1]?.[1].operationId)
      .toBe(createDraftCommand.mock.calls[0]?.[1].operationId);
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Saved as an unsent Outlook draft'));
  });

  it('keeps the details when staff confirm no draft exists and retry with a fresh id', async () => {
    createDraftCommand
      .mockRejectedValueOnce(new Error('Outlook command timed out'))
      .mockResolvedValueOnce(savedDraftLocation);
    render(
      <ShuttleDraft
        bridge={nativeDraftBridge}
        config={provider}
        storeId={storeId}
      />,
    );
    openDraftForm();
    const pickup = screen.getByLabelText('Pickup location') as HTMLInputElement;
    fireEvent.change(pickup, { target: { value: 'Hotel entrance' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save unsent draft' }));

    await screen.findByRole('alert');
    expect(pickup.disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', {
      name: 'I checked Outlook Drafts; no draft found — retry with a new ID',
    }));

    expect(pickup.disabled).toBe(false);
    expect(pickup.value).toBe('Hotel entrance');
    fireEvent.click(screen.getByRole('button', { name: 'Save unsent draft' }));

    await waitFor(() => expect(createDraftCommand).toHaveBeenCalledTimes(2));
    const firstOperationId = createDraftCommand.mock.calls[0]?.[1].operationId;
    const secondOperationId = createDraftCommand.mock.calls[1]?.[1].operationId;
    expect(secondOperationId).not.toBe(firstOperationId);
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Saved as an unsent Outlook draft'));
  });
});
