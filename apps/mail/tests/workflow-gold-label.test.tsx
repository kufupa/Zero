/**
 * @vitest-environment happy-dom
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MailAction } from '../lib/workflow-action-labels';

const mocks = vi.hoisted(() => ({
  sourceResult: {
    status: 'ready' as const,
    messageId: 'db-message-1',
    threadId: 'thread-1',
    sourceHash: 'source-hash',
  },
  sourceInputs: [] as Array<{ internetMessageId: string }>,
  ownerActionResult: null as MailAction | null,
  ownerActionInputs: [] as Array<{ messageId: string }>,
  saveActionLabel: vi.fn(async (input: { messageId: string; action: string }) => ({
    action: input.action,
    markedAt: new Date('2026-10-14T12:00:00.000Z'),
  })),
}));

vi.mock('@/providers/query-provider', () => ({
  useTRPC: () => ({
    mail: {
      listThreads: { infiniteQueryKey: () => ['mail', 'listThreads'] },
    },
    workstation: {
      staffQuoteSource: {
        queryOptions: (input: { internetMessageId: string }, options: Record<string, unknown> = {}) => {
          mocks.sourceInputs.push(input);
          return {
            queryKey: ['workstation', 'staffQuoteSource', input.internetMessageId],
            queryFn: async () => mocks.sourceResult,
            ...options,
          };
        },
      },
    },
    workflowFolders: {
      getOwnerActionLabel: {
        queryOptions: (input: { messageId: string }, options: Record<string, unknown> = {}) => {
          mocks.ownerActionInputs.push(input);
          return {
            queryKey: ['workflowFolders', 'getOwnerActionLabel', input.messageId],
            queryFn: async () => mocks.ownerActionResult,
            ...options,
          };
        },
        queryKey: () => ['workflowFolders', 'getOwnerActionLabel'],
      },
      setActionLabel: {
        mutationOptions: (options: Record<string, unknown> = {}) => ({
          mutationKey: ['workflowFolders', 'setActionLabel'],
          mutationFn: mocks.saveActionLabel,
          ...options,
        }),
      },
      summary: { queryKey: () => ['workflowFolders', 'summary'] },
      list: { infiniteQueryKey: () => ['workflowFolders', 'list'] },
      thread: { queryKey: () => ['workflowFolders', 'thread'] },
    },
  }),
}));

import { WorkflowGoldLabel } from '../components/quote-workflow/workflow-gold-label';

function renderGoldLabel(
  initialAction: MailAction = 'quote_availability',
  onIntentChange?: (intent: 'quote' | 'create_booking') => void,
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <WorkflowGoldLabel
        internetMessageId='<internet-message-1@example.invalid>'
        initialAction={initialAction}
        onIntentChange={onIntentChange}
      />
    </QueryClientProvider>,
  );
}

afterEach(() => cleanup());
beforeEach(() => {
  mocks.sourceInputs.length = 0;
  mocks.ownerActionInputs.length = 0;
  mocks.ownerActionResult = null;
  mocks.saveActionLabel.mockClear();
});

describe('WorkflowGoldLabel', () => {
  it('switches a cancellation reading to the quote workflow when the owner picks Quote', async () => {
    const onIntentChange = vi.fn();
    renderGoldLabel('cancel', onIntentChange);

    const picker = await screen.findByRole('combobox', { name: 'Nava reads this as' });
    fireEvent.change(picker, { target: { value: 'quote_availability' } });

    expect(onIntentChange).toHaveBeenCalledWith('quote');
  });

  it('restores an existing owner label and saved indicator when the message is reopened', async () => {
    mocks.ownerActionResult = 'cancel';
    renderGoldLabel();

    const picker = await screen.findByRole('combobox', { name: 'Nava reads this as' }) as HTMLSelectElement;
    await waitFor(() => expect(picker.value).toBe('cancel'));

    expect(screen.getByText('Saved as gold · Cancellation')).toBeDefined();
    expect(mocks.ownerActionInputs).toContainEqual({ messageId: 'db-message-1' });
  });

  it('offers every action and saves the synced message id and selected gold label', async () => {
    renderGoldLabel();

    const picker = await screen.findByRole('combobox', { name: 'Nava reads this as' }) as HTMLSelectElement;
    expect(Array.from(picker.options).map(({ value, text }) => [value, text])).toEqual([
      ['no_action', 'Not for Nava'],
      ['quote_availability', 'Quote'],
      ['new_booking', 'New booking'],
      ['amend', 'Amendment'],
      ['cancel', 'Cancellation'],
      ['payment_proof', 'Payment proof'],
      ['billing', 'Billing'],
      ['group_event', 'Group/event'],
      ['other_actionable', 'Other to do'],
    ]);
    expect(mocks.sourceInputs.some((input) => input.internetMessageId === '<internet-message-1@example.invalid>')).toBe(true);

    await waitFor(() => expect((screen.getByRole('button', { name: 'Save as gold' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.change(picker, { target: { value: 'cancel' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save as gold' }));

    expect(await screen.findByText('Saved as gold · Cancellation')).toBeDefined();
    expect(mocks.saveActionLabel).toHaveBeenCalledWith({ messageId: 'db-message-1', action: 'cancel' });
  });

  it('invalidates the normal thread list after saving a folder correction', async () => {
    const invalidateQueries = vi.spyOn(QueryClient.prototype, 'invalidateQueries');
    try {
      renderGoldLabel();
      await waitFor(() =>
        expect((screen.getByRole('button', { name: 'Save as gold' }) as HTMLButtonElement).disabled).toBe(false),
      );
      fireEvent.click(screen.getByRole('button', { name: 'Save as gold' }));
      await screen.findByText('Saved as gold · Quote');
      await waitFor(() =>
        expect(invalidateQueries).toHaveBeenCalledWith({
          queryKey: ['mail', 'listThreads'],
        }),
      );
    } finally {
      invalidateQueries.mockRestore();
    }
  });

  it('lets the owner replace a saved gold label', async () => {
    renderGoldLabel();
    const picker = await screen.findByRole('combobox', { name: 'Nava reads this as' }) as HTMLSelectElement;
    const saveButton = screen.getByRole('button', { name: 'Save as gold' });
    await waitFor(() => expect((saveButton as HTMLButtonElement).disabled).toBe(false));

    fireEvent.change(picker, { target: { value: 'cancel' } });
    fireEvent.click(saveButton);
    expect(await screen.findByText('Saved as gold · Cancellation')).toBeDefined();

    fireEvent.change(picker, { target: { value: 'quote_availability' } });
    fireEvent.click(saveButton);
    expect(await screen.findByText('Saved as gold · Quote')).toBeDefined();
    expect(mocks.saveActionLabel).toHaveBeenNthCalledWith(2, {
      messageId: 'db-message-1',
      action: 'quote_availability',
    });
  });

  it('keeps Save as gold and does not add a Done chip', async () => {
    renderGoldLabel();
    expect(await screen.findByRole('button', { name: 'Save as gold' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Done — rest are fine' })).toBeNull();
    expect(screen.queryByText(/Done — rest are fine/)).toBeNull();
    expect(screen.queryByTestId('gold-chip')).toBeNull();
  });
});
