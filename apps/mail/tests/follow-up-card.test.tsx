/**
 * @vitest-environment happy-dom
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FollowUpCard } from '../components/nava-pane/blocks/follow-up-card';
import type { FollowUp } from '../lib/quote-workflow/follow-up';
import type { PaneBridge } from '../lib/workstation/pane-bridge-types';

const { findQuery, useMutate, dismissMutate, setCompose } = vi.hoisted(() => ({
  findQuery: vi.fn(),
  useMutate: vi.fn(),
  dismissMutate: vi.fn(),
  setCompose: vi.fn(),
}));

vi.mock('nuqs', () => ({
  parseAsString: {},
  useQueryStates: () => [{}, setCompose],
}));

const trpc = {
  workItems: {
    followUpByMessage: { query: findQuery },
    useFollowUp: { mutate: useMutate },
    dismissFollowUp: { mutate: dismissMutate },
  },
};

const SUGGESTED: FollowUp = {
  state: 'suggested',
  id: 'quote-followup:out-1',
  subject: 'Re: Rooms request',
  htmlBody: '<p>Hello, following up on our quote.</p><script>window.navaHacked = true</script>',
  replyToMessageId: 'out-1',
};
const IN_REPLY: FollowUp = { ...SUGGESTED, state: 'in_reply' };

const SECTION = 'Follow-up suggested (no reply in 3 business days)';
const USE = 'Use this follow-up';
const INSERT = 'Insert draft in Outlook';

const activeEmail = {
  entryId: '001',
  storeId: 'store-1',
  folderEntryId: 'folder-1',
  subject: 'Rooms request',
  senderEmail: 'guest@example.com',
  senderName: 'Guest',
  receivedTime: '2026-10-07T12:00:00Z',
  bodyText: 'Please quote.',
  internetMessageId: '<q1@example.com>',
};

function bridgeWith({ canInsert = true }: { canInsert?: boolean } = {}) {
  const sendCommand = vi.fn().mockResolvedValue({
    entryId: 'draft-1',
    storeId: 'store-1',
    folderEntryId: 'drafts',
    folderName: 'Drafts',
  });
  const bridge = {
    activeEmail,
    sendCommand,
    supportsAction: (action: string) => action === 'CREATE_REPLY_DRAFT' && canInsert,
  } as unknown as Pick<PaneBridge, 'activeEmail' | 'sendCommand' | 'supportsAction'>;
  return { bridge, sendCommand };
}

/** A tRPC error as the client throws it: the procedure's code on data.code. */
function trpcError(code: string) {
  return Object.assign(new Error(code), { data: { code } });
}

function renderCard(bridge: ReturnType<typeof bridgeWith>['bridge'], preview = false) {
  return render(<FollowUpCard bridge={bridge} preview={preview} trpc={trpc} />);
}

/** Lets the card's pending lookup settle, so a null answer is seen as rendered nothing. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  vi.resetAllMocks();
});

afterEach(() => {
  cleanup();
});

describe('follow-up card', () => {
  it('renders nothing when the thread has no follow-up', async () => {
    findQuery.mockResolvedValue(null);
    const { container } = renderCard(bridgeWith().bridge);
    await settle();
    expect(findQuery).toHaveBeenCalledWith({ internetMessageId: '<q1@example.com>' });
    expect(container.innerHTML).toBe('');
  });

  it('renders nothing when the server route is missing', async () => {
    const { bridge } = bridgeWith();
    const { container } = render(<FollowUpCard bridge={bridge} trpc={{}} />);
    await settle();
    expect(findQuery).not.toHaveBeenCalled();
    expect(container.innerHTML).toBe('');
  });

  it('shows the suggestion with a sanitised preview and its two actions', async () => {
    findQuery.mockResolvedValue(SUGGESTED);
    renderCard(bridgeWith().bridge);
    const section = await screen.findByRole('region', { name: SECTION });
    expect(within(section).getByText('Hello, following up on our quote.')).toBeTruthy();
    expect(section.querySelector('script')).toBeNull();
    expect(within(section).getByRole('button', { name: USE })).toBeTruthy();
    expect(within(section).getByRole('button', { name: 'Dismiss' })).toBeTruthy();
  });

  it('Outlook: using the follow-up makes it the draft, then inserts it into Outlook Drafts', async () => {
    findQuery.mockResolvedValue(SUGGESTED);
    useMutate.mockResolvedValue(IN_REPLY);
    const { bridge, sendCommand } = bridgeWith();
    renderCard(bridge);
    fireEvent.click(await screen.findByRole('button', { name: USE }));
    fireEvent.click(await screen.findByRole('button', { name: INSERT }));
    expect(await screen.findByText('Draft inserted in Outlook Drafts.')).toBeTruthy();
    expect(useMutate).toHaveBeenCalledWith({ draftId: 'quote-followup:out-1', replaceActive: false });
    expect(sendCommand).toHaveBeenCalledWith(
      'CREATE_REPLY_DRAFT',
      expect.objectContaining({
        entryId: '001',
        storeId: 'store-1',
        folderEntryId: 'folder-1',
        replyAll: false,
        openInComposer: false,
        htmlBody: expect.stringContaining('Hello, following up on our quote.'),
      }),
    );
    expect(sendCommand.mock.calls[0]?.[1].htmlBody).not.toContain('<script');
  });

  it('asks before replacing a draft already open on the thread, and replaces only on confirm', async () => {
    findQuery.mockResolvedValue(SUGGESTED);
    useMutate
      .mockRejectedValueOnce(trpcError('CONFLICT'))
      .mockResolvedValueOnce(IN_REPLY);
    renderCard(bridgeWith().bridge);
    fireEvent.click(await screen.findByRole('button', { name: USE }));
    expect(await screen.findByText('Replace current draft?')).toBeTruthy();
    expect(useMutate).toHaveBeenLastCalledWith({ draftId: 'quote-followup:out-1', replaceActive: false });
    fireEvent.click(screen.getByRole('button', { name: 'Replace current draft' }));
    expect(await screen.findByRole('button', { name: INSERT })).toBeTruthy();
    expect(useMutate).toHaveBeenLastCalledWith({ draftId: 'quote-followup:out-1', replaceActive: true });
  });

  it('keeping the current draft leaves the suggestion open', async () => {
    findQuery.mockResolvedValue(SUGGESTED);
    useMutate.mockRejectedValueOnce(trpcError('CONFLICT'));
    renderCard(bridgeWith().bridge);
    fireEvent.click(await screen.findByRole('button', { name: USE }));
    fireEvent.click(await screen.findByRole('button', { name: 'Keep current draft' }));
    expect(await screen.findByRole('button', { name: USE })).toBeTruthy();
    expect(useMutate).toHaveBeenCalledTimes(1);
  });

  it('dismiss removes the card', async () => {
    findQuery.mockResolvedValue(SUGGESTED);
    dismissMutate.mockResolvedValue({ status: 'dismissed' });
    const { container } = renderCard(bridgeWith().bridge);
    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(container.innerHTML).toBe(''));
    expect(dismissMutate).toHaveBeenCalledWith({ draftId: 'quote-followup:out-1' });
  });

  it('says so when the follow-up was already gone, and offers no action', async () => {
    findQuery.mockResolvedValue(SUGGESTED);
    useMutate.mockRejectedValueOnce(trpcError('NOT_FOUND'));
    renderCard(bridgeWith().bridge);
    fireEvent.click(await screen.findByRole('button', { name: USE }));
    expect(await screen.findByText(/no longer open/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: USE })).toBeNull();
  });

  it('Outlook: an insert Outlook does not confirm says to check Drafts', async () => {
    findQuery.mockResolvedValue(IN_REPLY);
    const { bridge, sendCommand } = bridgeWith();
    sendCommand.mockRejectedValueOnce(new Error('bridge timeout'));
    renderCard(bridge);
    fireEvent.click(await screen.findByRole('button', { name: INSERT }));
    expect(await screen.findByText(/Check Outlook Drafts/)).toBeTruthy();
  });

  it('webmail: a used follow-up opens in the reply box and never calls Outlook', async () => {
    findQuery.mockResolvedValue(IN_REPLY);
    const { bridge, sendCommand } = bridgeWith({ canInsert: false });
    renderCard(bridge, true);
    fireEvent.click(await screen.findByRole('button', { name: 'Open in reply box' }));
    expect(setCompose).toHaveBeenCalledWith({
      mode: 'reply',
      activeReplyId: '001',
      draftId: 'quote-followup:out-1',
    });
    expect(sendCommand).not.toHaveBeenCalled();
  });
});
