/**
 * @vitest-environment happy-dom
 */
import {
  canSearchVoucher,
  VOUCHER_COPY,
  voucherFindClientFromTrpc,
  voucherGuestLine,
  type VoucherFindReply,
} from '../lib/quote-workflow/voucher-find';
import {
  formatStayDate,
  noSearchMatchCopy,
  type GuestSearchReply,
} from '../lib/quote-workflow/amend-find';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { VoucherFindCard } from '../components/quote-workflow/voucher-find-card';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => cleanup());

const VOUCHER: VoucherFindReply = {
  status: 'voucher',
  messageId: 'm1',
  guest: { lastName: 'Smith', arrival: '2026-11-12' },
  file: {
    id: 'att-1',
    filename: 'Smith_VCH_1879000.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 100,
  },
};

const SMITH_ROW = {
  confirmation: '57291630-1',
  lastName: 'Smith',
  firstName: 'John',
  status: 'Reserved',
  arrival: '2026-11-12',
  departure: '2026-11-14',
};

// The trpc client the pane passes in: the voucher check, the existing guest search, and nothing else.
function fakeTrpc(options: { reply: VoucherFindReply; search?: GuestSearchReply }) {
  const voucherFind = vi.fn(async (_input: { internetMessageId: string }) => options.reply);
  const searchGuest = vi.fn(
    async (_input: { lastName: string; arrival: string; departure?: string }) =>
      options.search ?? { outcome: 'ok', rows: [SMITH_ROW], screenshots: [], runId: null },
  );
  return {
    trpc: {
      quoteWorkflow: { voucherFind: { query: voucherFind } },
      paneStayLookup: { searchGuest: { mutate: searchGuest } },
    },
    voucherFind,
    searchGuest,
  };
}

describe('voucher find card: what shows', () => {
  it('renders nothing when the email is not a voucher or is not synced', async () => {
    for (const reply of [{ status: 'not_voucher' as const }, { status: 'unsynced' as const }]) {
      const { trpc } = fakeTrpc({ reply });
      const { container, unmount } = render(
        <VoucherFindCard internetMessageId="abc@host" trpc={trpc} download={vi.fn()} />,
      );
      await waitFor(() => expect(container.querySelector('section')).toBeNull());
      expect(container.textContent).toBe('');
      unmount();
    }
  });

  it('shows the guest and arrival Luna read, with the save action and the file name', async () => {
    const { trpc } = fakeTrpc({ reply: VOUCHER });
    render(<VoucherFindCard internetMessageId="abc@host" trpc={trpc} download={vi.fn()} />);
    expect(await screen.findByRole('button', { name: VOUCHER_COPY.search })).toBeTruthy();
    expect(screen.getByText(`Guest Smith · arriving ${formatStayDate('2026-11-12')}`)).toBeTruthy();
    expect(screen.getByRole('button', { name: VOUCHER_COPY.save })).toBeTruthy();
    expect(screen.getByText('Smith_VCH_1879000.pdf')).toBeTruthy();
  });

  it('says what it could not read and offers no search when the surname or arrival is missing', async () => {
    const { trpc: noName } = fakeTrpc({
      reply: { ...VOUCHER, guest: { lastName: null, arrival: '2026-11-12' } },
    });
    const first = render(
      <VoucherFindCard internetMessageId="abc@host" trpc={noName} download={vi.fn()} />,
    );
    expect(await screen.findByText(VOUCHER_COPY.missingGuest)).toBeTruthy();
    expect(screen.queryByRole('button', { name: VOUCHER_COPY.search })).toBeNull();
    first.unmount();

    const { trpc: noArrival } = fakeTrpc({
      reply: { ...VOUCHER, guest: { lastName: 'Smith', arrival: null } },
    });
    render(<VoucherFindCard internetMessageId="abc@host" trpc={noArrival} download={vi.fn()} />);
    expect(await screen.findByText(VOUCHER_COPY.missingArrival)).toBeTruthy();
    expect(screen.queryByRole('button', { name: VOUCHER_COPY.search })).toBeNull();
  });

  it('a new email clears the card before its own answer arrives', async () => {
    const { trpc } = fakeTrpc({ reply: VOUCHER });
    const { rerender, container } = render(
      <VoucherFindCard internetMessageId="first@host" trpc={trpc} download={vi.fn()} />,
    );
    expect(await screen.findByRole('button', { name: VOUCHER_COPY.search })).toBeTruthy();
    rerender(<VoucherFindCard internetMessageId={null} trpc={trpc} download={vi.fn()} />);
    await waitFor(() => expect(container.querySelector('section')).toBeNull());
  });
});

describe('voucher find card: the existing search', () => {
  it('runs the guest search only on click, with the surname and arrival, and shows each row with its own HMS actions', async () => {
    const { trpc, searchGuest } = fakeTrpc({ reply: VOUCHER });
    render(<VoucherFindCard internetMessageId="abc@host" trpc={trpc} download={vi.fn()} />);
    await screen.findByRole('button', { name: VOUCHER_COPY.search });
    expect(searchGuest).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: VOUCHER_COPY.search }));
    await waitFor(() => expect(screen.getByText('John Smith · 57291630-1')).toBeTruthy());
    expect(searchGuest).toHaveBeenCalledTimes(1);
    expect(searchGuest).toHaveBeenCalledWith({ lastName: 'Smith', arrival: '2026-11-12' });
    expect(screen.getByRole('button', { name: 'Copy confirmation' })).toBeTruthy();
  });

  it('reads a booking number only from HMS rows, never from the voucher text', async () => {
    const reply: VoucherFindReply = {
      ...VOUCHER,
      guest: { lastName: 'Smith', arrival: '2026-11-12' },
    };
    const { trpc, searchGuest } = fakeTrpc({
      reply,
      search: { outcome: 'ok', rows: [], screenshots: [], runId: null },
    });
    render(<VoucherFindCard internetMessageId="abc@host" trpc={trpc} download={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: VOUCHER_COPY.search }));
    await waitFor(() =>
      expect(screen.getByText(noSearchMatchCopy('Smith', '2026-11-12'))).toBeTruthy(),
    );
    // The voucher reference 1879000 in the file name is not a booking, so no copy action appears.
    expect(screen.queryByRole('button', { name: 'Copy confirmation' })).toBeNull();
    expect(searchGuest).toHaveBeenCalledTimes(1);
  });

  it('shows a plain failure when the search call fails', async () => {
    const { trpc } = fakeTrpc({ reply: VOUCHER });
    trpc.paneStayLookup.searchGuest.mutate = vi.fn(async () => {
      throw new Error('socket closed');
    });
    render(<VoucherFindCard internetMessageId="abc@host" trpc={trpc} download={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: VOUCHER_COPY.search }));
    expect(await screen.findByText(/could not read the HMS search/i)).toBeTruthy();
  });
});

describe('voucher find card: saving the file', () => {
  it('downloads the voucher file by its attachment id, and says to upload it in HMS Documents', async () => {
    const download = vi.fn(async () => {});
    const { trpc } = fakeTrpc({ reply: VOUCHER });
    render(<VoucherFindCard internetMessageId="abc@host" trpc={trpc} download={download} />);
    fireEvent.click(await screen.findByRole('button', { name: VOUCHER_COPY.save }));
    expect(await screen.findByText(VOUCHER_COPY.saved)).toBeTruthy();
    expect(download).toHaveBeenCalledWith({
      messageId: 'm1',
      attachmentId: 'att-1',
      filename: 'Smith_VCH_1879000.pdf',
      mimeType: 'application/pdf',
      size: 100,
    });
  });

  it('says so when the download fails', async () => {
    const download = vi.fn(async () => {
      throw new Error('Failed to fetch attachment: 403');
    });
    const { trpc } = fakeTrpc({ reply: VOUCHER });
    render(<VoucherFindCard internetMessageId="abc@host" trpc={trpc} download={download} />);
    fireEvent.click(await screen.findByRole('button', { name: VOUCHER_COPY.save }));
    expect(await screen.findByText(VOUCHER_COPY.saveFailed)).toBeTruthy();
  });

  it('offers no save action when the email has no file', async () => {
    const { trpc } = fakeTrpc({ reply: { ...VOUCHER, file: null } });
    render(<VoucherFindCard internetMessageId="abc@host" trpc={trpc} download={vi.fn()} />);
    expect(await screen.findByText(VOUCHER_COPY.noFile)).toBeTruthy();
    expect(screen.queryByRole('button', { name: VOUCHER_COPY.save })).toBeNull();
  });
});

describe('voucher find bind and copy', () => {
  it('binds quoteWorkflow.voucherFind off a tRPC client, and null when the route is missing', async () => {
    const { trpc, voucherFind } = fakeTrpc({ reply: VOUCHER });
    const client = voucherFindClientFromTrpc(trpc);
    expect(client).not.toBeNull();
    await expect(client!.check({ internetMessageId: 'abc@host' })).resolves.toEqual(VOUCHER);
    expect(voucherFind).toHaveBeenCalledWith({ internetMessageId: 'abc@host' });
    expect(voucherFindClientFromTrpc({})).toBeNull();
  });

  it('names only what Luna read, and allows a search only with both a surname and an arrival', () => {
    expect(voucherGuestLine({ lastName: 'Smith', arrival: '2026-11-12' })).toBe(
      `Guest Smith · arriving ${formatStayDate('2026-11-12')}`,
    );
    expect(voucherGuestLine({ lastName: null, arrival: null })).toBeNull();
    expect(canSearchVoucher({ lastName: 'Smith', arrival: '2026-11-12' })).toBe(true);
    expect(canSearchVoucher({ lastName: 'Smith', arrival: null })).toBe(false);
    expect(canSearchVoucher({ lastName: null, arrival: '2026-11-12' })).toBe(false);
  });
});
