/**
 * @vitest-environment happy-dom
 */
import {
  NeedsYouScreen,
  NeedsYouWebControl,
  useNeedsYou,
} from '../components/nava-pane/screens/needs-you';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaneBridge } from '../lib/workstation/pane-bridge-types';
import type { NeedsYouRow } from '../lib/quote-workflow/backend-bind';
import { NavaPane } from '../components/nava-pane/nava-pane';
import { trpcClient } from '../providers/query-provider';

const { listQuery, dismissMutate, pingMutate, silent } = vi.hoisted(() => {
  // A route this file does not exercise never answers, so the pane waits on it instead of failing.
  const silent = (): unknown =>
    new Proxy(() => new Promise<never>(() => {}), { get: () => silent() });
  return {
    listQuery: vi.fn(),
    dismissMutate: vi.fn(),
    pingMutate: vi.fn().mockResolvedValue({ status: 'ok', serverTime: '2026-10-09T12:00:00Z' }),
    silent,
  };
});

// Only the work-items list and dismiss routes, plus the ping the pane sends on mount.
vi.mock('../providers/query-provider', () => {
  const routes: Record<PropertyKey, unknown> = {
    workstation: { ping: { mutate: pingMutate } },
    get workItems() {
      return { list: { query: listQuery }, dismiss: { mutate: dismissMutate } };
    },
  };
  return {
    trpcClient: new Proxy(routes, {
      get: (target, key) => (key in target ? Reflect.get(target, key) : silent()),
    }),
  };
});

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

vi.mock('../lib/workstation/pane-release-watch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/workstation/pane-release-watch')>()),
  reloadPane: vi.fn(),
}));

vi.mock('../lib/auth-client', () => ({
  useSession: () => ({
    data: {
      user: { id: 'staff-1', email: 'ropperman@legacyhotels.co.za', name: 'R Opperman' },
      session: { id: 's-1' },
    },
    isLoading: false,
  }),
  signIn: { email: vi.fn() },
}));

vi.mock('../hooks/use-connections', () => ({
  useActiveConnection: () => ({
    data: { id: 'transport-1', email: 'ropperman@legacyhotels.co.za' },
    isLoading: false,
  }),
}));

vi.mock('@/hooks/use-pilot-capabilities', () => ({
  usePilotCapabilities: () => ({ paneSave: false }),
}));

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
  onOpenThread?: (threadId: string) => void;
}) {
  const list = useNeedsYou(
    client ?? { workItems: { list: { query: listQuery }, dismiss: { mutate: dismissMutate } } },
  );
  return <NeedsYouScreen list={list} host={host} onOpenThread={onOpenThread} />;
}

/** The screen with a button that starts a reload, so a test can hold one in flight across a dismiss. */
function ReloadingHarness() {
  const list = useNeedsYou({
    workItems: { list: { query: listQuery }, dismiss: { mutate: dismissMutate } },
  });
  return (
    <>
      <button type="button" onClick={list.reload}>
        Reload now
      </button>
      <NeedsYouScreen list={list} host="web" onOpenThread={() => {}} />
    </>
  );
}

// Same bridge values as the fake bridge in nava-pane-render.test.tsx, with no email selected.
const v4Capabilities = {
  bridgeProtocolVersion: 4,
  addinVersion: '1.0.12',
  outlookVersion: '16.0',
  runtime: 'Classic Outlook for Windows',
  newOutlookSupported: false,
  interactiveProfileRequired: true,
  maxPageSize: 200,
  maxFolderDepth: 64,
  maxFolderCount: 5000,
  maxFolderSnapshotItems: 5000,
  supportedActions: [
    'GET_CAPABILITIES',
    'GET_ACTIVE_EMAIL',
    'CREATE_REPLY_DRAFT',
    'ADD_ATTACHMENT_TO_DRAFT',
  ],
};

const fakeBridge = {
  isConnected: true,
  workstationInfo: { addinVersion: '1.0.12', bridgeProtocolVersion: 4, paired: true },
  capabilities: v4Capabilities,
  supportsAction: (action: string) => v4Capabilities.supportedActions.includes(action),
  activeEmail: null,
  sendCommand: vi.fn(async () => null),
  pairDevice: vi.fn(async () => {}),
} as unknown as PaneBridge;

beforeEach(() => {
  localStorage.setItem('nava_onboarding_completed', 'true');
  listQuery.mockReset();
  listQuery.mockResolvedValue(TWO_OPEN);
  dismissMutate.mockReset();
  dismissMutate.mockResolvedValue({ status: 'dismissed' });
});

afterEach(() => {
  localStorage.clear();
  cleanup();
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
    expect(items[1]!.textContent).toContain('Booking');
    expect(items[1]!.textContent).toContain('bookings@agency.example');
    expect(items[1]!.textContent).toContain('Confirm Labtest booking');
    expect(items[0]!.querySelector('time')?.getAttribute('datetime')).toBe(
      '2026-10-05T09:00:00.000Z',
    );
    expect(items[2]!.textContent).toContain('Amendment');
    expect(items[3]!.textContent).toContain('Voucher or POP');
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

  it('webmail opens the thread of a row', async () => {
    const onOpenThread = vi.fn();
    render(<Harness host="web" onOpenThread={onOpenThread} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Open Confirm booking' }));
    expect(onOpenThread).toHaveBeenCalledWith('thread-wi-2');
  });

  it('Outlook has no open action, and says how to find each email', async () => {
    render(<Harness host="outlook" />);

    expect(await screen.findByRole('heading', { name: 'Needs you (2)' })).toBeDefined();
    expect(screen.queryByRole('button', { name: /^Open/ })).toBeNull();
    expect(
      screen.getByText('Find each email in your Outlook inbox by its sender and subject.'),
    ).toBeDefined();
    expect(screen.getAllByText(/david@example\.com/).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('listitem')[0]!.querySelector('time')).not.toBeNull();
  });

  it('dismiss sends the item to the server, takes its row off, and reloads the list', async () => {
    listQuery.mockResolvedValueOnce(TWO_OPEN).mockResolvedValue([TWO_OPEN[1]!]);
    render(<Harness host="web" onOpenThread={() => {}} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss Rooms request' }));
    expect(screen.queryByRole('button', { name: 'Dismiss Rooms request' })).toBeNull();
    expect(dismissMutate).toHaveBeenCalledWith({ workItemId: 'wi-1' });
    expect(await screen.findByRole('heading', { name: 'Needs you (1)' })).toBeDefined();
    await waitFor(() => expect(listQuery).toHaveBeenCalledTimes(2));
  });

  it('a refused dismiss puts the item back on the list and says so', async () => {
    dismissMutate.mockRejectedValueOnce(new Error('refused'));
    render(<Harness host="web" onOpenThread={() => {}} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss Rooms request' }));
    expect(
      await screen.findByText("Couldn't dismiss that email. It is still on your list."),
    ).toBeDefined();
    expect(await screen.findByRole('button', { name: 'Dismiss Rooms request' })).toBeDefined();
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
    fireEvent.click(screen.getByRole('button', { name: 'Reload now' }));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss Rooms request' }));
    expect(await screen.findByRole('heading', { name: 'Needs you (1)' })).toBeDefined();
    await waitFor(() => expect(listQuery).toHaveBeenCalledTimes(3));

    await act(async () => {
      answerReload(TWO_OPEN);
    });
    expect(screen.getByRole('heading', { name: 'Needs you (1)' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Dismiss Rooms request' })).toBeNull();
  });

  it('a build without the list route reads as unavailable and does not throw', async () => {
    render(<Harness host="web" client={{}} />);

    expect(
      await screen.findByText('The Needs-you list is not available in this version yet.'),
    ).toBeDefined();
    expect(listQuery).not.toHaveBeenCalled();
  });
});

describe('Needs-you entry on the pane', () => {
  it('the Outlook pane opens the list from its entry, and Back returns to the quoting tool', async () => {
    render(<NavaPane bridge={fakeBridge} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Needs you (2)' }));
    expect(await screen.findByRole('heading', { name: 'Needs you (2)' })).toBeDefined();
    expect(
      screen.getByText('Find each email in your Outlook inbox by its sender and subject.'),
    ).toBeDefined();

    // The quoting tool stays mounted behind the list, so its state survives.
    expect(document.querySelector<HTMLElement>('main.nava-pane-scroll')?.style.display).toBe(
      'none',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Back to quotes' }));
    expect(screen.queryByRole('heading', { name: 'Needs you (2)' })).toBeNull();
    expect(await screen.findByRole('button', { name: 'Needs you (2)' })).toBeDefined();
    expect(document.querySelector<HTMLElement>('main.nava-pane-scroll')?.style.display).toBe('');
  });

  it('Back reloads the pane count, so a dismiss made on the list shows on the entry', async () => {
    render(<NavaPane bridge={fakeBridge} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Needs you (2)' }));
    listQuery.mockResolvedValue([TWO_OPEN[1]!]);
    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss Rooms request' }));
    await waitFor(() => expect(dismissMutate).toHaveBeenCalledWith({ workItemId: 'wi-1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Back to quotes' }));
    expect(await screen.findByRole('button', { name: 'Needs you (1)' })).toBeDefined();
  });

  it('the webmail pane opens a row thread through the webmail callback', async () => {
    const onOpenThread = vi.fn();
    render(<NavaPane bridge={fakeBridge} preview onOpenThread={onOpenThread} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Needs you (2)' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Open Rooms request' }));
    expect(onOpenThread).toHaveBeenCalledWith('thread-wi-1');
  });
});

describe('Needs-you webmail control', () => {
  it('the header button shows the count, opens the list in a dialog, and a row opens its thread and closes the dialog', async () => {
    const onOpenThread = vi.fn();
    render(<NeedsYouWebControl trpc={trpcClient} onOpenThread={onOpenThread} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Needs you (2)' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Open Rooms request' }));
    expect(onOpenThread).toHaveBeenCalledWith('thread-wi-1');
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Open Rooms request' })).toBeNull(),
    );
  });

  it('closing the dialog reloads the count, so a dismiss made inside it shows on the button', async () => {
    render(<NeedsYouWebControl trpc={trpcClient} onOpenThread={() => {}} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Needs you (2)' }));
    listQuery.mockResolvedValue([TWO_OPEN[1]!]);
    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss Rooms request' }));
    await waitFor(() => expect(dismissMutate).toHaveBeenCalledWith({ workItemId: 'wi-1' }));
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(await screen.findByRole('button', { name: 'Needs you (1)' })).toBeDefined();
  });

  it('the dialog Close button closes it, and the count reloads', async () => {
    render(<NeedsYouWebControl trpc={trpcClient} onOpenThread={() => {}} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Needs you (2)' }));
    listQuery.mockResolvedValue([TWO_OPEN[1]!]);
    fireEvent.click(await screen.findByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Close' })).toBeNull());
    expect(await screen.findByRole('button', { name: 'Needs you (1)' })).toBeDefined();
  });

  it('a full list reads 200+ on the webmail count', async () => {
    listQuery.mockResolvedValue(
      Array.from({ length: 200 }, (_, i) => row({ id: `wi-${i}`, subject: `Item ${i}` })),
    );
    render(<NeedsYouWebControl trpc={trpcClient} onOpenThread={() => {}} />);

    expect(await screen.findByRole('button', { name: 'Needs you (200+)' })).toBeDefined();
  });
});
