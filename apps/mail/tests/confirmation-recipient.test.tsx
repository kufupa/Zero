/**
 * @vitest-environment happy-dom
 */
import { useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearSavedConfirmation,
  ConfirmationSourcesBridge,
  ConfirmationSourcesProvider,
  type ConfirmationSources,
} from '../components/quote-workflow/confirmation-recipient';
import { QuoteBookingHost } from '../components/quote-workflow/quote-booking-host';
import type { StoredContact } from '../lib/quote-workflow/backend-bind';
import type { PaneStayClient, PaneStayResult } from '../lib/quote-workflow/pane-stay-bind';
import {
  emptyStaffQuoteHeader,
  type BookingDraftReady,
  type QuoteSession,
  type StayGroupRequirement,
} from '../lib/quote-workflow/types';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

const settingsDouble = vi.hoisted(() => ({
  get: vi.fn(async () => ({ settings: { confirmation: { mode: 'self' as const }, language: 'en' } })),
  save: vi.fn(async (_input: unknown) => ({ success: true })),
  queries: [] as Array<{
    queryKey: unknown[];
    state: { data?: { settings?: Record<string, unknown> } };
  }>,
}));

vi.mock('@/providers/query-provider', () => ({
  trpcClient: {
    settings: {
      get: { query: () => settingsDouble.get() },
      save: { mutate: (input: unknown) => settingsDouble.save(input) },
    },
  },
  getQueryClient: () => ({
    getQueryCache: () => ({ getAll: () => settingsDouble.queries }),
    setQueryData: (queryKey: unknown[], data: { settings?: Record<string, unknown> }) => {
      const found = settingsDouble.queries.find((query) => query.queryKey === queryKey);
      if (found) found.state.data = data;
    },
  }),
}));

afterEach(() => {
  cleanup();
  clearSavedConfirmation();
  settingsDouble.get.mockReset();
  settingsDouble.save.mockReset();
  settingsDouble.queries.splice(0, settingsDouble.queries.length);
});

const STAFF = 'staff@example.invalid';
const CLIENT = 'guest@example.invalid';
const OTHER = 'desk@example.invalid';

const contact: StoredContact = {
  name: 'Guest Contact',
  company: null,
  endClient: null,
  email: CLIENT,
  phone: null,
};

const group = {
  id: 'g1',
  arrivalDate: '2026-11-12',
  departureDate: '2026-11-14',
  quantity: 1,
  adults: 1,
  childrenAges: [],
  board: 'bb',
  specialRequests: [],
  fields: { arrivalDate: 'extracted', departureDate: 'extracted', adults: 'extracted' },
} as StayGroupRequirement;

function draft(): BookingDraftReady {
  return {
    draft: {
      rooms: [
        {
          groupId: 'g1',
          roomIndex: 1,
          request: {
            arrival: '2026-11-12',
            departure: '2026-11-14',
            adults: 1,
            childAges: [],
            roomType: 'STQN',
            ratePlan: 'TAXYZ',
            firstName: 'Ada',
            lastName: 'Lovelace',
            track: 'COR',
            sourceOfBusiness: 'E-Mail',
            guaranteeType: 'Confirmation Received',
          },
          schemaErrors: [],
        },
      ],
      rateCheck: [],
      missing: [],
      flags: [],
    },
    options: {
      track: ['BAR', 'COR'],
      sourceOfBusiness: ['Travel Agent', 'E-Mail'],
      guaranteeType: ['Guaranteed By Agent', 'Confirmation Received'],
      roomType: ['STQN'],
    },
    messageId: 'mail-1',
    selectionEpoch: 1,
    inputRevision: 1,
    revisionRef: 'rev-1',
  };
}

function session(): QuoteSession {
  return {
    binding: {
      transportId: 't1',
      storeId: 'store',
      folderEntryId: 'inbox',
      entryId: 'e1',
      selectionEpoch: 1,
      scopeEpoch: 1,
    },
    groups: [group],
    bookingDrafts: { '2026-11-12:2026-11-14': draft() },
    staffHeader: emptyStaffQuoteHeader(),
    staffQuotes: {},
    staffSource: null,
    offers: [],
  } as unknown as QuoteSession;
}

const PREVIEW_OK: PaneStayResult = {
  status: 'ok',
  outcome: 'previewed',
  previewDigest: 'ab'.repeat(32),
  runId: 'run-1',
  screenshots: [],
};

function pane() {
  const preview = vi.fn<PaneStayClient['preview']>().mockResolvedValue(PREVIEW_OK);
  const commit = vi.fn<PaneStayClient['commit']>().mockResolvedValue({
    status: 'ok',
    outcome: 'committed',
    confirmationNumber: '10001-1',
    runId: 'run-1',
    screenshots: [],
  });
  const client: PaneStayClient = {
    preview,
    commit,
    screenshot: vi.fn(async () => null),
    mode: () => 'on',
  };
  return { client, preview, commit };
}

function renderHost(
  sources: ConfirmationSources,
  onSaveDefault?: (setting: { mode: 'self' | 'client' | 'custom'; address?: string }) => Promise<void>,
) {
  const api = pane();
  render(
    <ConfirmationSourcesProvider value={sources}>
      <QuoteBookingHost
        session={session()}
        paneSave={api.client}
        contact={contact}
        onSaveDefault={onSaveDefault}
      />
    </ConfirmationSourcesProvider>,
  );
  return api;
}

describe('confirmation recipient', () => {
  it('prefills the saved choice and sends the edited recipient on create', async () => {
    const { preview, commit } = renderHost({
      userEmail: STAFF,
      setting: { mode: 'client' },
    });
    const select = screen.getByLabelText('Send HMS confirmation to') as unknown as HTMLSelectElement;
    expect(select.value).toBe('client');
    expect(screen.getByRole('option', { name: `Me (${STAFF})` })).toBeDefined();
    expect(screen.getByRole('option', { name: `Client (${CLIENT})` })).toBeDefined();
    expect(screen.getByRole('option', { name: 'Other…' })).toBeDefined();
    expect(screen.getByText('HMS sends this confirmation. Nava does not send mail.')).toBeDefined();

    fireEvent.change(select, { target: { value: 'self' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview in HMS' }));
    await waitFor(() => expect(preview).toHaveBeenCalledTimes(1));
    expect(preview.mock.calls[0]?.[0]).toMatchObject({
      confirmationRecipient: { mode: 'self', address: STAFF },
    });

    fireEvent.change(select, { target: { value: 'custom' } });
    fireEvent.change(screen.getByLabelText('Other confirmation email'), { target: { value: OTHER } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview in HMS' }));
    await waitFor(() => expect(preview).toHaveBeenCalledTimes(2));
    expect(preview.mock.calls[1]?.[0]).toMatchObject({
      confirmationRecipient: { mode: 'custom', address: OTHER },
    });
    const book = screen.getByRole('button', { name: 'Create provisional booking' }) as HTMLButtonElement;
    await waitFor(() => expect(book.disabled).toBe(false));
    fireEvent.click(book);
    await waitFor(() => expect(commit).toHaveBeenCalledTimes(1));
    expect(commit.mock.calls[0]?.[0]).toMatchObject({
      confirmationRecipient: { mode: 'custom', address: OTHER },
    });
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('fails closed when the chosen address is missing', () => {
    const missingSelf = renderHost({ userEmail: '', setting: { mode: 'self' } });
    expect(screen.getByRole('alert').textContent).toContain('not set up');
    expect((screen.getByRole('button', { name: 'Preview in HMS' }) as HTMLButtonElement).disabled).toBe(true);
    expect(missingSelf.preview).not.toHaveBeenCalled();

    cleanup();
    const missingClient = pane();
    render(
      <ConfirmationSourcesProvider value={{ userEmail: STAFF, setting: { mode: 'client' } }}>
        <QuoteBookingHost
          session={session()}
          paneSave={missingClient.client}
          contact={{ ...contact, email: null }}
        />
      </ConfirmationSourcesProvider>,
    );
    expect(screen.getByRole('alert').textContent).toContain('not found');
    expect((screen.getByRole('button', { name: 'Preview in HMS' }) as HTMLButtonElement).disabled).toBe(true);
    expect(missingClient.preview).not.toHaveBeenCalled();
  });

  it('uses an explicit pick when the saved choice is unreadable or the read fails', async () => {
    const invalid = renderHost({ userEmail: STAFF, setting: null, invalidSetting: true });
    expect(screen.getByRole('alert').textContent).toContain('not set up');
    expect((screen.getByRole('button', { name: 'Preview in HMS' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Send HMS confirmation to'), { target: { value: 'self' } });
    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'Preview in HMS' }) as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Preview in HMS' }));
    await waitFor(() => expect(invalid.preview).toHaveBeenCalledTimes(1));
    expect(invalid.preview.mock.calls[0]?.[0]).toMatchObject({
      confirmationRecipient: { mode: 'self', address: STAFF },
    });

    cleanup();
    const failed = renderHost({ userEmail: STAFF, setting: { mode: 'client' }, load: 'failed' });
    expect(screen.getByRole('alert').textContent).toContain('not set up');
    fireEvent.change(screen.getByLabelText('Send HMS confirmation to'), { target: { value: 'client' } });
    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'Preview in HMS' }) as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Preview in HMS' }));
    await waitFor(() => expect(failed.preview).toHaveBeenCalledTimes(1));
    expect(failed.preview.mock.calls[0]?.[0]).toMatchObject({
      confirmationRecipient: { mode: 'client', address: CLIENT },
    });
  });

  it('saves only the confirmation choice as the user default', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    renderHost({ userEmail: STAFF, setting: { mode: 'client' } }, save);
    fireEvent.click(screen.getByRole('button', { name: 'Make this my default' }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0]?.[0]).toEqual({ mode: 'client' });
    expect(screen.getByRole('button', { name: 'Saved as your default' })).toBeDefined();
  });

  it('does not mark a newer choice saved when an older save finishes', async () => {
    let release: () => void = () => {};
    const save = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    renderHost({ userEmail: STAFF, setting: { mode: 'client' } }, save);
    fireEvent.click(screen.getByRole('button', { name: 'Make this my default' }));
    fireEvent.change(screen.getByLabelText('Send HMS confirmation to'), { target: { value: 'self' } });
    release();
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('button', { name: 'Saved as your default' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Make this my default' })).toBeDefined();
  });

  it('shows the saved default on the next booking in the same pane', async () => {
    settingsDouble.get.mockResolvedValue({
      settings: { confirmation: { mode: 'self' }, language: 'en' },
    });
    settingsDouble.queries.push({
      queryKey: [['settings', 'get']],
      state: { data: { settings: { confirmation: { mode: 'self' }, language: 'en' } } },
    });
    const api = pane();
    function Pane() {
      const [ticket, setTicket] = useState(1);
      return (
        <ConfirmationSourcesBridge userEmail={STAFF}>
          <button type="button" onClick={() => setTicket((next) => next + 1)}>
            Next booking
          </button>
          <QuoteBookingHost key={ticket} session={session()} paneSave={api.client} contact={contact} />
        </ConfirmationSourcesBridge>
      );
    }
    render(<Pane />);
    await waitFor(() => {
      expect((screen.getByLabelText('Send HMS confirmation to') as unknown as HTMLSelectElement).value).toBe(
        'self',
      );
    });
    fireEvent.change(screen.getByLabelText('Send HMS confirmation to'), { target: { value: 'client' } });
    fireEvent.click(screen.getByRole('button', { name: 'Make this my default' }));
    await waitFor(() => expect(settingsDouble.save).toHaveBeenCalledTimes(1));
    expect(settingsDouble.save.mock.calls[0]?.[0]).toEqual({ confirmation: { mode: 'client' } });
    expect(settingsDouble.queries[0]?.state.data?.settings).toMatchObject({
      language: 'en',
      confirmation: { mode: 'client' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Next booking' }));
    await waitFor(() => {
      expect((screen.getByLabelText('Send HMS confirmation to') as unknown as HTMLSelectElement).value).toBe(
        'client',
      );
    });
  });
});
