/**
 * @vitest-environment happy-dom
 */
import {
  NeedsYouEntry,
  NeedsYouScreen,
  NeedsYouWebControl,
  NEEDS_YOU_UNDO_MS,
  useNeedsYou,
} from '../components/nava-pane/screens/needs-you';
import {
  WorkItemFieldProvenance,
  type WorkItemFieldProvenanceEntry,
} from '../components/nava-pane/screens/work-item-field-provenance';
import { WorkItemHistoryControls } from '../components/nava-pane/screens/work-item-history-controls';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { unmaskedPii } from './helpers/pii-marks';
import type { NeedsYouRow } from '../lib/quote-workflow/backend-bind';
import { setMailCacheScope } from '../lib/mail/mail-cache-scope';
import {
  shouldAutoScrollToLatestMessage,
  shouldSuppressLatestAutoScroll,
  useExactSourceMessageSelection,
} from '../lib/mail/source-message-navigation';

const { listQuery, dismissMutate, toastMock, toastDismissMock } = vi.hoisted(() => {
  return {
    listQuery: vi.fn(),
    dismissMutate: vi.fn(),
    toastMock: vi.fn(),
    toastDismissMock: vi.fn(),
  };
});

vi.mock('sonner', () => ({
  toast: Object.assign(toastMock, {
    dismiss: toastDismissMock,
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
  }),
}));

const needsYouClient = {
  workItems: { list: { query: listQuery }, dismiss: { mutate: dismissMutate } },
};

function row(overrides: Partial<NeedsYouRow> & Pick<NeedsYouRow, 'id'>): NeedsYouRow {
  return {
    kind: 'quote',
    status: 'needs_you',
    chip: 'needs_you',
    threadId: `thread-${overrides.id}`,
    sender: 'david@example.com',
    subject: 'Rooms request',
    receivedAt: new Date('2026-10-05T09:00:00Z'),
    ...overrides,
  };
}

const TWO_OPEN = [
  row({ id: 'wi-1', subject: 'Rooms request' }),
  row({
    id: 'wi-2',
    subject: 'Confirm booking',
    kind: 'booking',
    status: 'review',
    chip: 'review',
    sender: 'bookings@agency.example',
  }),
];

/** The screen with its list hook, as the pane and the webmail dialog mount it. */
function Harness({
  host,
  client,
  onOpenThread,
}: {
  host: 'web' | 'outlook';
  client?: unknown;
  onOpenThread?: (threadId: string, ...sourceMessageId: string[]) => void;
}) {
  const list = useNeedsYou(client ?? needsYouClient);
  return <NeedsYouScreen list={list} host={host} onOpenThread={onOpenThread} />;
}

function ControlsHarness() {
  const list = useNeedsYou(needsYouClient);
  return (
    <>
      <NeedsYouEntry list={list} onOpen={() => {}} />
      <NeedsYouScreen list={list} host="web" />
      <NeedsYouWebControl trpc={needsYouClient} onOpenThread={() => {}} />
    </>
  );
}

/** The screen with a button that starts a reload, so a test can hold one in flight across a dismiss. */
function ReloadingHarness() {
  const list = useNeedsYou(needsYouClient);
  return (
    <>
      <button type="button" onClick={list.reload}>
        Reload now
      </button>
      <NeedsYouScreen list={list} host="web" onOpenThread={() => {}} />
    </>
  );
}

function ExactSourceMessageReader({
  sourceMessageId,
  messages,
}: {
  sourceMessageId: string;
  messages: { id: string }[];
}) {
  const selectedMessageRef = useExactSourceMessageSelection(sourceMessageId, messages);
  return (
    <>
      <input data-testid="reply-editor" />
      {messages.map((message) => {
        const selected = message.id === sourceMessageId;
        return (
          <div
            key={message.id}
            ref={selected ? selectedMessageRef : undefined}
            tabIndex={selected ? -1 : undefined}
            aria-current={selected || undefined}
            data-selected-source-message={selected ? '' : undefined}
          />
        );
      })}
    </>
  );
}

beforeEach(() => {
  localStorage.setItem('nava_onboarding_completed', 'true');
  setMailCacheScope({ userId: null, activeTransportId: null });
  listQuery.mockReset();
  listQuery.mockResolvedValue(TWO_OPEN);
  dismissMutate.mockReset();
  dismissMutate.mockResolvedValue({ status: 'dismissed' });
  toastMock.mockReset();
  toastMock.mockReturnValue('needs-you-dismissal');
  toastDismissMock.mockReset();
});

afterEach(() => {
  localStorage.clear();
  cleanup();
  setMailCacheScope({ userId: null, activeTransportId: null });
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('Needs-you list', () => {
  it('shows each open item with its kind, sender, subject, received time and chip, in the order the list sends', async () => {
    listQuery.mockResolvedValue([
      row({ id: 'wi-1', chip: 'needs_you', subject: 'Rooms request' }),
      row({
        id: 'wi-2',
        chip: 'review',
        status: 'review',
        kind: 'booking',
        sender: 'bookings@agency.example',
        subject: 'Confirm Labtest booking',
        receivedAt: new Date('2026-10-06T10:30:00Z'),
      }),
      row({ id: 'wi-3', chip: 'queued', kind: 'amendment', subject: 'Move my dates' }),
      row({ id: 'wi-4', chip: 'in_hms', kind: 'voucher_pop', subject: 'Voucher for the group' }),
    ]);
    render(<Harness host="web" onOpenThread={() => {}} />);

    expect(await screen.findByRole('heading', { name: 'Needs you (4)' })).toBeDefined();
    const items = screen.getAllByRole('listitem');
    expect(items.map((item) => item.querySelector('[data-chip]')?.textContent)).toEqual([
      'Needs you',
      'Review',
      'Queued',
      'In HMS',
    ]);
    expect(items[1]!.textContent).toContain('New booking');
    expect(items[1]!.textContent).toContain('bookings@agency.example');
    expect(items[1]!.textContent).toContain('Confirm Labtest booking');
    expect(items[0]!.querySelector('time')?.getAttribute('datetime')).toBe(
      '2026-10-05T09:00:00.000Z',
    );
    expect(items[2]!.textContent).toContain('Amendment');
    expect(items[3]!.textContent).toContain('Payment');
    expect(listQuery).toHaveBeenCalledWith({ limit: 200, statuses: ['needs_you', 'review'] });
  });

  it('shows the one-line reopen reason on an open item', async () => {
    listQuery.mockResolvedValue([
      Object.assign(row({ id: 'wi-reopen', subject: 'Rooms request' }), {
        reopenReason: "said they'd come back with rates",
      }),
    ]);
    render(<Harness host="web" onOpenThread={() => {}} />);
    expect(await screen.findByText("said they'd come back with rates")).toBeDefined();
  });

  it('says All caught up when nothing is open', async () => {
    listQuery.mockResolvedValue([]);
    render(<Harness host="web" onOpenThread={() => {}} />);

    expect(await screen.findByText('All caught up')).toBeDefined();
    expect(screen.getByRole('heading', { name: 'Needs you (0)' })).toBeDefined();
    expect(screen.queryAllByRole('listitem')).toHaveLength(0);
  });

  it('a full list reads 200+ on the heading', async () => {
    listQuery.mockResolvedValue(
      Array.from({ length: 200 }, (_, i) => row({ id: `wi-${i}`, subject: `Item ${i}` })),
    );
    render(<Harness host="web" onOpenThread={() => {}} />);

    expect(await screen.findByRole('heading', { name: 'Needs you (200+)' })).toBeDefined();
  });

  it('shows a loading line, then a failed load with a retry that loads the list', async () => {
    listQuery.mockRejectedValueOnce(new Error('network down')).mockResolvedValue(TWO_OPEN);
    render(<Harness host="web" onOpenThread={() => {}} />);

    expect(screen.getByRole('status').textContent).toBe('Loading…');
    expect((await screen.findByRole('alert')).textContent).toContain("Couldn't load the list.");
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: 'Needs you (2)' })).toBeDefined();
  });

  it('webmail passes the exact source message ID with its thread ID', async () => {
    const onOpenThread = vi.fn();
    listQuery.mockResolvedValue([
      row({ id: 'wi-exact', threadId: 'thread-exact', sourceMessageId: 'message-exact' }),
    ]);
    render(<Harness host="web" onOpenThread={onOpenThread} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Open Rooms request' }));
    expect(onOpenThread).toHaveBeenCalledOnce();
    expect(onOpenThread).toHaveBeenCalledWith('thread-exact', 'message-exact');
  });

  it('webmail offers manual search instead of opening a thread without its exact source ID', async () => {
    const onOpenThread = vi.fn();
    listQuery.mockResolvedValue([
      row({ id: 'wi-no-source', threadId: 'thread-no-source', sourceMessageId: null }),
    ]);
    render(<Harness host="web" onOpenThread={onOpenThread} />);

    expect(await screen.findByText('Find this email in webmail by its sender and subject.')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Open Rooms request' })).toBeNull();
    expect(onOpenThread).not.toHaveBeenCalled();
  });

  it('Outlook opens only the exact native entry ID when its host API is available', async () => {
    const displayMessageForm = vi.fn();
    vi.stubGlobal('Office', { context: { mailbox: { displayMessageForm } } });
    listQuery.mockResolvedValue([
      row({ id: 'wi-outlook', outlookEntryId: 'outlook-entry-exact' }),
    ]);
    render(<Harness host="outlook" />);

    fireEvent.click(await screen.findByRole('button', { name: 'Open Rooms request' }));
    expect(displayMessageForm).toHaveBeenCalledOnce();
    expect(displayMessageForm).toHaveBeenCalledWith('outlook-entry-exact');
  });

  it('Outlook offers manual search when its host API or exact entry ID is unavailable', async () => {
    vi.stubGlobal('Office', { context: { mailbox: {} } });
    listQuery.mockResolvedValue([
      row({ id: 'wi-no-api', outlookEntryId: 'outlook-entry-no-api' }),
    ]);
    const { unmount } = render(<Harness host="outlook" />);

    expect(
      await screen.findByText('Find each email in your Outlook inbox by its sender and subject.'),
    ).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Open Rooms request' })).toBeNull();

    unmount();
    vi.stubGlobal('Office', { context: { mailbox: { displayMessageForm: vi.fn() } } });
    listQuery.mockResolvedValue([row({ id: 'wi-no-entry', outlookEntryId: null })]);
    render(<Harness host="outlook" />);
    expect(
      await screen.findByText('Find each email in your Outlook inbox by its sender and subject.'),
    ).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Open Rooms request' })).toBeNull();
  });

  it('offers Undo before saving a dismissal, and Undo restores the row without a server write', async () => {
    render(<Harness host="web" onOpenThread={() => {}} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss Rooms request' }));
    expect(screen.queryByRole('button', { name: 'Dismiss Rooms request' })).toBeNull();
    expect(await screen.findByRole('heading', { name: 'Needs you (1)' })).toBeDefined();
    expect(dismissMutate).not.toHaveBeenCalled();
    const options = toastMock.mock.calls.at(-1)?.[1] as {
      action?: { label: string; onClick: () => void };
    };
    expect(options.action?.label).toBe('Undo');
    act(() => options.action?.onClick());
    expect(await screen.findByRole('heading', { name: 'Needs you (2)' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Dismiss Rooms request' })).toBeDefined();
    expect(dismissMutate).not.toHaveBeenCalled();
  });

  it('Undo after a mailbox switch re-reads the list instead of restoring the row into the other mailbox', async () => {
    setMailCacheScope({ userId: 'staff-1', activeTransportId: 'transport-a' });
    try {
      render(<Harness host="web" onOpenThread={() => {}} />);
      fireEvent.click(await screen.findByRole('button', { name: 'Dismiss Rooms request' }));
      setMailCacheScope({ userId: 'staff-1', activeTransportId: 'transport-b' });
      listQuery.mockResolvedValue([row({ id: 'wi-b', subject: 'Mailbox B request' })]);
      const calls = listQuery.mock.calls.length;
      const options = toastMock.mock.calls.at(-1)?.[1] as { action?: { onClick: () => void } };
      act(() => options.action?.onClick());

      expect(await screen.findByRole('button', { name: 'Dismiss Mailbox B request' })).toBeDefined();
      expect(screen.queryByRole('button', { name: 'Dismiss Rooms request' })).toBeNull();
      expect(listQuery.mock.calls.length).toBeGreaterThan(calls);
      expect(dismissMutate).not.toHaveBeenCalled();
    } finally {
      setMailCacheScope({ userId: null, activeTransportId: null });
    }
  });

  it('flushes pending dismissal on unmount before thread switch', async () => {
    const { unmount } = render(<Harness host="web" onOpenThread={() => {}} />);
    const dismiss = await screen.findByRole('button', { name: 'Dismiss Rooms request' });
    vi.useFakeTimers();
    fireEvent.click(dismiss);
    const options = toastMock.mock.calls.at(-1)?.[1] as {
      action?: { onClick: () => void };
    };

    act(() => unmount());

    expect(dismissMutate).toHaveBeenCalledTimes(1);
    expect(toastDismissMock).toHaveBeenCalledWith('needs-you-dismissal');
    act(() => options.action?.onClick());
    expect(dismissMutate).toHaveBeenCalledTimes(1);
  });

  it('sends a delayed dismissal under the mailbox active when it was dismissed', async () => {
    setMailCacheScope({ userId: 'staff-1', activeTransportId: 'transport-a' });
    try {
      render(<Harness host="web" onOpenThread={() => {}} />);
      const dismiss = await screen.findByRole('button', { name: 'Dismiss Rooms request' });
      vi.useFakeTimers();
      fireEvent.click(dismiss);
      setMailCacheScope({ userId: 'staff-1', activeTransportId: 'transport-b' });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(NEEDS_YOU_UNDO_MS);
      });

      expect(dismissMutate).toHaveBeenCalledWith(
        { workItemId: 'wi-1' },
        { context: { activeTransportId: 'transport-a' } },
      );
    } finally {
      setMailCacheScope({ userId: null, activeTransportId: null });
    }
  });

  it('saves the dismissal after the Undo window and refreshes both filters', async () => {
    const dismissed = row({ id: 'wi-1', status: 'dismissed', subject: 'Rooms request' });
    listQuery
      .mockResolvedValueOnce(TWO_OPEN)
      .mockImplementation(async (input: { statuses?: string[] }) =>
        input.statuses?.[0] === 'done' ? [dismissed] : [TWO_OPEN[1]!],
      );
    render(<Harness host="web" onOpenThread={() => {}} />);
    const dismiss = await screen.findByRole('button', { name: 'Dismiss Rooms request' });
    vi.useFakeTimers();
    fireEvent.click(dismiss);
    expect(dismissMutate).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(NEEDS_YOU_UNDO_MS);
    });
    expect(dismissMutate).toHaveBeenCalledWith({ workItemId: 'wi-1' });
    expect(listQuery).toHaveBeenCalledTimes(3);
    expect(listQuery).toHaveBeenNthCalledWith(2, { limit: 200, statuses: ['needs_you', 'review'] });
    expect(listQuery).toHaveBeenNthCalledWith(3, { limit: 200, statuses: ['done', 'dismissed'] });
    expect(screen.getByRole('heading', { name: 'Needs you (1)' })).toBeDefined();

    vi.useRealTimers();
    fireEvent.click(screen.getByRole('button', { name: 'Finished' }));
    const finishedList = await screen.findByRole('list', { name: 'Finished items' });
    expect(finishedList.textContent).toContain('Rooms request');
  });

  it('a refused dismissal puts the item back on the list and says so', async () => {
    dismissMutate.mockRejectedValueOnce(new Error('refused'));
    render(<Harness host="web" onOpenThread={() => {}} />);

    const dismiss = await screen.findByRole('button', { name: 'Dismiss Rooms request' });
    vi.useFakeTimers();
    fireEvent.click(dismiss);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(NEEDS_YOU_UNDO_MS);
    });
    expect(
      screen.getByText("Couldn't dismiss that email. It is back on your list."),
    ).toBeDefined();
    expect(screen.getByRole('button', { name: 'Dismiss Rooms request' })).toBeDefined();
  });

  it('a reload still in flight when a dismiss commits cannot bring the row back', async () => {
    render(<ReloadingHarness />);
    expect(await screen.findByRole('heading', { name: 'Needs you (2)' })).toBeDefined();

    // The reload waits. The load after the dismiss answers at once, so the waiting reload lands last.
    let answerReload: (rows: NeedsYouRow[]) => void = () => {};
    listQuery
      .mockImplementationOnce(
        () =>
          new Promise<NeedsYouRow[]>((resolve) => {
            answerReload = resolve;
          }),
      )
      .mockResolvedValueOnce([TWO_OPEN[1]!]);
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole('button', { name: 'Reload now' }));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss Rooms request' }));
    expect(screen.getByRole('heading', { name: 'Needs you (1)' })).toBeDefined();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(NEEDS_YOU_UNDO_MS);
    });
    expect(listQuery).toHaveBeenCalledTimes(4);

    await act(async () => {
      answerReload(TWO_OPEN);
    });
    expect(screen.getByRole('heading', { name: 'Needs you (1)' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Dismiss Rooms request' })).toBeNull();
  });

  it('a build without the list route reads as unavailable and does not throw', async () => {
    render(<Harness host="web" client={{}} />);

    expect(await screen.findByText(/Needs-you isn't available for this mailbox/)).toBeDefined();
    expect(listQuery).not.toHaveBeenCalled();
  });

  it('filters Finished from server-backed done and dismissed statuses', async () => {
    const finished = row({ id: 'wi-done', status: 'done', subject: 'Completed quote' });
    listQuery.mockResolvedValueOnce(TWO_OPEN).mockResolvedValueOnce([finished]);
    render(<Harness host="web" onOpenThread={() => {}} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Finished' }));

    const finishedList = await screen.findByRole('list', { name: 'Finished items' });
    expect(finishedList.textContent).toContain('Completed quote');
    expect(listQuery).toHaveBeenNthCalledWith(2, {
      limit: 200,
      statuses: ['done', 'dismissed'],
    });
    expect(screen.getByRole('heading', { name: 'Needs you (2)' })).toBeDefined();
    expect(screen.getByText('Finished', { selector: '[data-chip]' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Dismiss Completed quote' })).toBeNull();
  });
});

describe('Work item history controls', () => {
  it('binds actions to the refreshed J1 revision and disables them at its boundaries', () => {
    const props = {
      workItemId: 'work-item-1',
      onUndo: vi.fn(),
      onRedo: vi.fn(),
    };
    const { rerender } = render(
      <WorkItemHistoryControls {...props} serverCursor={null} />,
    );

    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Redo' })).toBeNull();

    rerender(
      <WorkItemHistoryControls
        {...props}
        serverCursor={{ revision: 0, revisionHead: 2 }}
      />,
    );
    expect(
      (screen.getByRole('button', { name: 'Undo' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole('button', { name: 'Redo' }) as HTMLButtonElement).disabled,
    ).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Redo' }));
    expect(props.onRedo).toHaveBeenCalledWith(props.workItemId, 0);
    expect(props.onUndo).not.toHaveBeenCalled();

    rerender(
      <WorkItemHistoryControls
        {...props}
        serverCursor={{ revision: 2, revisionHead: 2 }}
      />,
    );
    expect(
      (screen.getByRole('button', { name: 'Undo' }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(
      (screen.getByRole('button', { name: 'Redo' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(props.onUndo).toHaveBeenCalledWith(props.workItemId, 2);

    rerender(
      <WorkItemHistoryControls
        {...props}
        pending
        serverCursor={{ revision: 1, revisionHead: 2 }}
      />,
    );
    const undo = screen.getByRole('button', { name: 'Undo' }) as HTMLButtonElement;
    const redo = screen.getByRole('button', { name: 'Redo' }) as HTMLButtonElement;
    expect(undo.disabled).toBe(true);
    expect(redo.disabled).toBe(true);
    fireEvent.click(undo);
    fireEvent.click(redo);
    expect(props.onUndo).toHaveBeenCalledTimes(1);
    expect(props.onRedo).toHaveBeenCalledTimes(1);
  });
});

describe('Needs-you rows mark guest details for the preview gate (H6b)', () => {
  it('marks each row subject and sender with data-pii', async () => {
    listQuery.mockResolvedValue([row({ id: 'wi-1', sender: 'Priya Naidoo', subject: 'Booking for Mr Fixturemann' })]);
    const { container } = render(<Harness host="web" onOpenThread={() => {}} />);
    await screen.findAllByText('Booking for Mr Fixturemann');
    expect(unmaskedPii(container, ['Fixturemann', 'Priya Naidoo'])).toEqual([]);
  });
});

describe('Needs-you controls', () => {
  it('hides both entry controls by default while keeping the list and Dismiss action available', async () => {
    render(<ControlsHarness />);

    expect(await screen.findByRole('heading', { name: 'Needs you (2)' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Needs you (2)' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Dismiss Rooms request' })).toBeDefined();
  });
});

describe('webmail exact-message reader selection', () => {
  it('does not schedule a competing latest-message scroll for an exact source selection', () => {
    expect(
      shouldAutoScrollToLatestMessage({
        demo: false,
        suppressLatestAutoScroll: shouldSuppressLatestAutoScroll('message-exact'),
        isLastEmail: true,
        totalEmails: 6,
      }),
    ).toBe(false);
    expect(
      shouldAutoScrollToLatestMessage({
        demo: false,
        isLastEmail: true,
        totalEmails: 6,
      }),
    ).toBe(true);
  });

  it('focuses and scrolls to the exact source once; new mail does not steal reply-editor focus', () => {
    const previousScrollIntoView = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      'scrollIntoView',
    );
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    });
    const message = (id: string) => ({ id });
    const messages = [message('message-exact'), message('message-latest')];
    const props = {
      sourceMessageId: 'message-exact',
    };

    try {
      const { container, rerender } = render(<ExactSourceMessageReader {...props} messages={messages} />);
      const selectedMessage = container.querySelector('[data-selected-source-message]');
      expect(selectedMessage?.getAttribute('aria-current')).toBe('true');
      expect(document.activeElement).toBe(selectedMessage);
      expect(scrollIntoView).toHaveBeenCalledOnce();
      expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' });

      const replyEditor = screen.getByTestId('reply-editor') as HTMLInputElement;
      replyEditor.focus();
      rerender(<ExactSourceMessageReader {...props} messages={[...messages, message('message-new')]} />);

      expect(document.activeElement).toBe(replyEditor);
      expect(scrollIntoView).toHaveBeenCalledOnce();
    } finally {
      if (previousScrollIntoView) {
        Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', previousScrollIntoView);
      } else {
        Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
      }
    }
  });
});

describe('Needs-you field provenance (DS4-H2)', () => {
  it('follows AI, staff edit and reset-to-AI source/value through reopen', () => {
    const ai = { source: 'ai', value: '2027-04-14' } satisfies WorkItemFieldProvenanceEntry;
    const edited = { source: 'staff', value: '2027-04-15' } satisfies WorkItemFieldProvenanceEntry;
    const unknown = { source: 'unknown', value: '2027-04-14' } satisfies WorkItemFieldProvenanceEntry;
    const marker = (value: string, provenance?: WorkItemFieldProvenanceEntry) => (
      <label>
        Arrival
        <input readOnly value={value} />
        <WorkItemFieldProvenance fieldValue={value} provenance={provenance} />
      </label>
    );

    const view = render(marker(ai.value, ai));
    expect(screen.getByText('AI')).toBeDefined();

    view.rerender(marker(edited.value, edited));
    expect(screen.getByText('Edited')).toBeDefined();
    expect(screen.queryByText('AI')).toBeNull();

    const resetValue = ai.value;
    view.rerender(marker(resetValue, ai));
    expect(screen.getByText('AI')).toBeDefined();

    view.unmount();
    const reopened = render(marker(resetValue, ai));
    expect(screen.getByText('AI')).toBeDefined();

    reopened.rerender(marker(resetValue, unknown));
    expect(screen.queryByText('AI')).toBeNull();
    expect(screen.queryByText('Edited')).toBeNull();
    reopened.rerender(marker(edited.value, ai));
    expect(screen.queryByText('AI')).toBeNull();
  });
});
