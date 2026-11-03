/**
 * @vitest-environment happy-dom
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebPanePanel } from '../components/nava-pane/web-pane-panel';
import NavaPreviewPage from '../app/(routes)/nava-preview/page';
import { navaSidePanelAtom } from '../store/navaSidePanel';
import { MailLayout } from '../components/mail/mail';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDefaultStore } from 'jotai';
import { readFileSync } from 'node:fs';

const mocks = vi.hoisted(() => ({
  threadId: null as string | null,
  sourceMessageId: null as string | null,
  previewQuery: 'thread=thread-7',
  setPreviewParams: vi.fn(),
  folder: 'inbox',
  searchListFolder: 'inbox',
  wide: true,
  useWebPreview: vi.fn(),
  setMailSelection: vi.fn(),
  setComposeState: vi.fn(),
  flushCompose: vi.fn(),
}));

// Vitest loads react-resizable-panels through the node export condition, and that build has no
// layout effects. Panels then never compute a layout, so collapse and keyboard resize have no
// sizes to act on. Load the browser build instead, which is what the app ships to browsers.
vi.mock('react-resizable-panels', async () => {
  const { createRequire } = await import('node:module');
  const { join } = await import('node:path');
  const nodeRequire = createRequire(import.meta.url);
  const packageJson = nodeRequire.resolve('react-resizable-panels/package.json');
  return nodeRequire(
    join(packageJson, '..', 'dist', 'react-resizable-panels.browser.development.cjs.js'),
  );
});

const readSource = (relativePath: string) =>
  readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), relativePath), 'utf8');

vi.mock('../lib/workstation/web-pane-bridge', () => ({
  useWebPreview: (args: { threadId: string; sourceThreadId?: string; sourceMessageId?: string; requireSelectedMessage?: boolean }) => mocks.useWebPreview(args),
}));

vi.mock('../components/nava-pane/nava-pane', () => ({
  NavaPane: ({ onOpenThread, webSelectedMessageId }: { onOpenThread?: (threadId: string, sourceMessageId?: string) => void;
    webSelectedMessageId?: string | null }) => (
    <div data-testid="nava-pane" data-web-selected-message={webSelectedMessageId ?? ''}>
      <button type="button" onClick={() => onOpenThread?.('thread-a', 'source-a')}>Open source A</button>
      <button type="button" onClick={() => onOpenThread?.('thread-b', 'source-b')}>Open source B</button>
      <button type="button" onClick={() => onOpenThread?.('thread-7')}>Open thread only</button>
    </div>
  ),
}));

vi.mock('@/lib/mail/compose-flush-registry', () => ({
  flushComposeBeforeLeave: () => mocks.flushCompose(),
}));

vi.mock('../components/mail/thread-display', () => ({
  ThreadDisplay: () => <div data-testid="thread-display" />,
}));

vi.mock('../components/mail/mail-list', () => ({
  MailList: () => <div data-testid="standard-mail-list" />,
}));
vi.mock('../components/mail/mail-search-bar', () => ({ MailSearchBar: () => null }));
vi.mock('../components/ui/sidebar-toggle', () => ({ SidebarToggle: () => null }));
vi.mock('@/components/mail/workflow-folder-done-button', () => ({
  WorkflowFolderDoneButton: () => null,
}));

vi.mock('../hooks/use-media-query', () => ({
  useMediaQuery: (query: string) => (query === '(min-width: 1024px)' ? mocks.wide : true),
}));
vi.mock('../hooks/use-mobile', () => ({ useIsMobile: () => false }));
vi.mock('../hooks/use-threads', () => ({
  useThreads: () => [
    { isFetching: false, refetch: vi.fn() },
    [],
    false,
    vi.fn(),
    { isValid: true, folder: mocks.searchListFolder },
  ],
}));
vi.mock('@/hooks/use-threads', () => ({
  useThreads: () => [
    { isFetching: false, refetch: vi.fn() },
    [],
    false,
    vi.fn(),
    { isValid: true, folder: mocks.searchListFolder },
  ],
}));
vi.mock('../hooks/use-connections', () => ({
  useActiveConnection: () => ({
    data: { id: 'transport-1', email: 'centurion@legacyhotels.co.za', providerId: 'custom' },
    isLoading: false,
  }),
}));
vi.mock('../hooks/use-categories', () => ({
  useCategorySettings: () => [],
  useDefaultCategoryId: () => 'Important',
}));
vi.mock('../hooks/use-category-ids', () => ({ default: () => [] }));
vi.mock('../lib/auth-client', () => ({
  useSession: () => ({ data: { user: { id: 'staff-1' } }, isPending: false }),
}));
vi.mock('../components/mail/use-mail', async () => {
  const { atom } = await import('jotai');
  return {
    useMail: () => [{ bulkSelected: [] }, vi.fn()],
    clearBulkSelectionAtom: atom(null, () => {}),
  };
});
vi.mock('react-router', () => ({
  Link: ({ to, children, ...rest }: { to: string; children?: React.ReactNode }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
  useNavigate: () => vi.fn(),
  useParams: () => ({ folder: mocks.folder }),
  useSearchParams: () => [new URLSearchParams(mocks.previewQuery), mocks.setPreviewParams],
}));
vi.mock('nuqs', () => ({
  parseAsString: {},
  useQueryState: (key: string) => [key === 'threadId' ? mocks.threadId : null, mocks.setComposeState],
  // DS2-S5 516304d2f: MailLayoutContent reads threadId + sourceMessageId together.
  useQueryStates: () => [{ threadId: mocks.threadId, sourceMessageId: mocks.sourceMessageId }, mocks.setMailSelection],
}));
vi.mock('react-hotkeys-hook', () => ({
  useHotkeys: vi.fn(),
  useHotkeysContext: () => ({ enableScope: vi.fn(), disableScope: vi.fn() }),
}));
vi.mock('@/paraglide/messages', () => ({
  m: new Proxy({}, { get: () => () => '' }),
}));
vi.mock('@/providers/query-provider', () => ({
  useTRPC: () => ({ mail: { listThreads: { queryOptions: (input: unknown) => input } } }),
  // The header's Needs-you control reads this list route for its live status.
  trpcClient: { workItems: { list: { query: async () => [] } } },
}));
vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({
    data: { threads: [{ id: 'thread-7', subject: 'Quote request', snippet: 'Please quote' }] },
    isLoading: false,
    isError: false,
  }),
  useInfiniteQuery: () => ({
    data: { pages: [] },
    isLoading: false,
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: vi.fn(),
  }),
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock('@/lib/auth-proxy', () => ({ authProxy: {} }));

const readyPreview = () => ({
  selection: {
    status: 'ready',
    email: {
      entryId: 'msg-1',
      storeId: 'transport-1',
      folderEntryId: 'thread',
      subject: 'Quote request',
      senderEmail: 'guest@example.com',
      senderName: 'Guest',
      to: 'centurion@legacyhotels.co.za',
      receivedTime: '2026-10-08T09:00:00.000Z',
      bodyText: 'Please quote 2 rooms.',
      internetMessageId: '<guest-1@example.com>',
    },
  },
  bridge: {},
});

/** The react-resizable-panels size of one panel, as the group renders it (`data-panel-size`). */
const panelSize = (panelId: string) =>
  document.querySelector(`[data-panel-id="${panelId}"]`)?.getAttribute('data-panel-size') ?? null;

const setNavaToggle = (open: boolean) => act(() => getDefaultStore().set(navaSidePanelAtom, open));

beforeEach(() => {
  localStorage.clear();
  mocks.threadId = null;
  mocks.sourceMessageId = null;
  mocks.previewQuery = 'thread=thread-7';
  mocks.setPreviewParams.mockReset();
  mocks.folder = 'inbox';
  mocks.searchListFolder = 'inbox';
  mocks.wide = true;
  mocks.setMailSelection.mockReset();
  mocks.setComposeState.mockReset();
  mocks.flushCompose.mockReset().mockResolvedValue(undefined);
  mocks.useWebPreview.mockReset();
  mocks.useWebPreview.mockImplementation(() => readyPreview());
  setNavaToggle(true);
});

afterEach(() => {
  cleanup();
});

describe('Nava pane beside the open thread', () => {
  it('renders the Nava pane for the open thread when wide, as a third pane', async () => {
    mocks.threadId = 'thread-42';
    render(<MailLayout />);

    expect(await screen.findByTestId('nava-pane')).toBeDefined();
    expect(screen.getByTestId('nava-pane').getAttribute('data-web-selected-message')).toBe('msg-1');
    expect(mocks.useWebPreview).toHaveBeenCalledWith({ threadId: 'thread-42', requireSelectedMessage: true });
    expect(document.querySelector('[data-preview-thread="thread-42"]')).not.toBeNull();
    expect(panelSize('mail-list-panel')).toBe('30.0');
    expect(panelSize('mail-thread-panel')).toBe('42.0');
    expect(panelSize('mail-nava-panel')).toBe('28.0');
  });

  it('does not vouch for the latest inbound in the generic viewer', () => {
    render(<WebPanePanel threadId="thread-42" />);
    expect(screen.getByTestId('nava-pane').getAttribute('data-web-selected-message')).toBe('');
  });

  it('passes the selected stored message through the pane on A/B/A changes', async () => {
    mocks.threadId = 'thread-42';
    mocks.sourceMessageId = 'message-a';
    const { rerender } = render(<MailLayout />);
    expect(await screen.findByTestId('nava-pane')).toBeDefined();
    expect(mocks.useWebPreview).toHaveBeenLastCalledWith({ threadId: 'thread-42', sourceMessageId: 'message-a', requireSelectedMessage: true });

    mocks.sourceMessageId = 'message-b';
    rerender(<MailLayout />);
    expect(mocks.useWebPreview).toHaveBeenLastCalledWith({ threadId: 'thread-42', sourceMessageId: 'message-b', requireSelectedMessage: true });

    mocks.sourceMessageId = 'message-a';
    rerender(<MailLayout />);
    expect(mocks.useWebPreview).toHaveBeenLastCalledWith({ threadId: 'thread-42', sourceMessageId: 'message-a', requireSelectedMessage: true });
  });

  it('keeps the latest work-item choice when compose flushes complete out of order', async () => {
    let finishA: (() => void) | undefined;
    let finishB: (() => void) | undefined;
    mocks.flushCompose
      .mockImplementationOnce(() => new Promise<void>((resolve) => { finishA = resolve; }))
      .mockImplementationOnce(() => new Promise<void>((resolve) => { finishB = resolve; }));
    mocks.threadId = 'thread-42';
    render(<MailLayout />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open source A' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open source B' }));
    await act(async () => { finishB?.(); });
    await waitFor(() => expect(mocks.setMailSelection).toHaveBeenCalledWith({ threadId: 'thread-b', sourceMessageId: 'source-b' }));
    await act(async () => { finishA?.(); });
    expect(mocks.setMailSelection).toHaveBeenCalledTimes(1);
  });

  it('does not let a pending work-item open undo a newer message choice or clear its draft', async () => {
    let finish!: () => void;
    mocks.flushCompose.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    mocks.threadId = 'thread-42';
    mocks.sourceMessageId = 'message-a';
    const { rerender } = render(<MailLayout />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open source A' }));
    mocks.sourceMessageId = 'message-b';
    rerender(<MailLayout />);
    await act(async () => { finish(); });
    expect(mocks.setMailSelection).not.toHaveBeenCalled();
    expect(mocks.setComposeState).not.toHaveBeenCalled();
  });

  it('is hidden when the toggle is off, and the two-pane layout is unchanged', () => {
    setNavaToggle(false);
    mocks.threadId = 'thread-42';
    render(<MailLayout />);

    expect(screen.queryByTestId('nava-pane')).toBeNull();
    expect(panelSize('mail-nava-panel')).toBeNull();
    expect(panelSize('mail-list-panel')).toBe('42.0');
    expect(panelSize('mail-thread-panel')).toBe('58.0');
  });

  it('closes when the toggle is switched off while a thread is open', async () => {
    mocks.threadId = 'thread-42';
    render(<MailLayout />);
    expect(await screen.findByTestId('nava-pane')).toBeDefined();

    setNavaToggle(false);

    expect(screen.queryByTestId('nava-pane')).toBeNull();
    expect(panelSize('mail-thread-panel')).toBe('58.0');
  });

  it('is hidden when no thread is open', () => {
    render(<MailLayout />);

    expect(screen.queryByTestId('nava-pane')).toBeNull();
    expect(panelSize('mail-nava-panel')).toBeNull();
    expect(panelSize('mail-thread-panel')).toBe('58.0');
  });

  it('is hidden below the wide breakpoint, where the thread takes the split alone', () => {
    mocks.threadId = 'thread-42';
    mocks.wide = false;
    render(<MailLayout />);

    expect(screen.queryByTestId('nava-pane')).toBeNull();
    // The thread is the only mounted panel, so it fills the group (flexGrow 1) with no handle.
    expect(panelSize('mail-list-panel')).toBeNull();
    expect(panelSize('mail-thread-panel')).toBe('1.0');
    expect(document.querySelectorAll('[data-panel-resize-handle-id]')).toHaveLength(0);
  });

  it('keeps a collapsed inbox collapsed when the Nava pane opens and closes', async () => {
    const { rerender } = render(<MailLayout />);
    fireEvent.click(screen.getByRole('button', { name: 'Hide inbox' }));
    expect(panelSize('mail-list-panel')).toBe('0.0');

    mocks.threadId = 'thread-42';
    rerender(<MailLayout />);
    expect(await screen.findByTestId('nava-pane')).toBeDefined();
    expect(panelSize('mail-list-panel')).toBe('0.0');
    expect(panelSize('mail-nava-panel')).toBe('28.0');

    mocks.threadId = null;
    rerender(<MailLayout />);
    expect(screen.queryByTestId('nava-pane')).toBeNull();
    expect(panelSize('mail-list-panel')).toBe('0.0');
    expect(panelSize('mail-thread-panel')).toBe('100.0');
  });

  it('resizes only the thread and Nava panes from the Nava handle while the inbox is collapsed', async () => {
    const { rerender } = render(<MailLayout />);
    fireEvent.click(screen.getByRole('button', { name: 'Hide inbox' }));
    mocks.threadId = 'thread-42';
    rerender(<MailLayout />);
    expect(await screen.findByTestId('nava-pane')).toBeDefined();

    // Handles pair with panels by DOM order. The hidden inbox handle stays mounted, so the
    // Nava handle is index 1 and moves width from the thread (left) to the Nava pane (right).
    const handles = document.querySelectorAll('[data-panel-resize-handle-id]');
    expect(handles).toHaveLength(2);
    fireEvent.keyDown(handles[1] as Element, { key: 'ArrowLeft' });

    expect(panelSize('mail-list-panel')).toBe('0.0');
    expect(panelSize('mail-thread-panel')).toBe('62.0');
    expect(panelSize('mail-nava-panel')).toBe('38.0');
  });
});

describe('workflow folder mail routing', () => {
  it('renders the standard mail list, thread view, and Nava pane', async () => {
    mocks.folder = 'quotes';
    mocks.searchListFolder = 'quotes';
    mocks.threadId = 'thread-42';

    render(<MailLayout />);

    expect(screen.getByTestId('standard-mail-list')).toBeDefined();
    expect(screen.getByTestId('thread-display')).toBeDefined();
    expect(await screen.findByTestId('nava-pane')).toBeDefined();
    expect(mocks.useWebPreview).toHaveBeenCalledWith({
      threadId: 'thread-42',
      sourceThreadId: 'thread-42',
      requireSelectedMessage: true,
    });
  });
});

describe('Nava toggle storage', () => {
  it('writes the toggle to localStorage under nava-side-panel', () => {
    setNavaToggle(false);
    expect(localStorage.getItem('nava-side-panel')).toBe('false');
    setNavaToggle(true);
    expect(localStorage.getItem('nava-side-panel')).toBe('true');
  });

  it('adds the thread toolbar toggle bound to that atom, shown from the wide breakpoint only', () => {
    const threadDisplaySource = readSource('../components/mail/thread-display.tsx');
    expect(threadDisplaySource).toContain(
      "import { navaSidePanelAtom } from '@/store/navaSidePanel';",
    );
    expect(threadDisplaySource).toContain(
      'const [navaSidePanelOpen, setNavaSidePanelOpen] = useAtom(navaSidePanelAtom);',
    );
    expect(threadDisplaySource).toMatch(
      /aria-pressed=\{navaSidePanelOpen\}[\s\S]*?>\s*Nava\s*<\/button>/,
    );
    expect(threadDisplaySource).toMatch(/className="hidden [^"]*lg:inline-flex/);
  });
});

describe('shared WebPanePanel', () => {
  it('shows the Message-ID status when the latest guest email cannot be bound', () => {
    mocks.useWebPreview.mockImplementation(() => ({
      selection: { status: 'unsynced', reason: 'no_message_id' },
      bridge: {},
    }));
    render(<WebPanePanel threadId="thread-9" />);

    expect(screen.getByRole('status').textContent).toContain('has no Message-ID');
    expect(document.querySelector('[data-preview-reason="no_message_id"]')).not.toBeNull();
  });

  it('nava-preview still renders WebPanePanel for the selected thread', async () => {
    render(<NavaPreviewPage />);

    expect(await screen.findByTestId('nava-pane')).toBeDefined();
    expect(document.querySelector('[data-preview-pane]')).not.toBeNull();
    expect(
      document.querySelector('[data-preview-status="ready"][data-preview-thread="thread-7"]'),
    ).not.toBeNull();
  });

  it('keeps a quote notice bound to its exact email in nava-preview', () => {
    mocks.previewQuery = 'thread=thread-a&sourceMessageId=source-a';
    const { rerender } = render(<NavaPreviewPage />);
    expect(mocks.useWebPreview).toHaveBeenLastCalledWith({
      threadId: 'thread-a', sourceMessageId: 'source-a', requireSelectedMessage: true,
    });
    expect(screen.getByRole('link', { name: 'Open in webmail' }).getAttribute('href'))
      .toBe('/mail/inbox?threadId=thread-a&sourceMessageId=source-a');

    fireEvent.click(screen.getByRole('button', { name: 'Open source B' }));
    expect(mocks.setPreviewParams).toHaveBeenCalledWith({ thread: 'thread-b', sourceMessageId: 'source-b' });
    mocks.previewQuery = 'thread=thread-b&sourceMessageId=source-b';
    rerender(<NavaPreviewPage />);
    expect(mocks.useWebPreview).toHaveBeenLastCalledWith({
      threadId: 'thread-b', sourceMessageId: 'source-b', requireSelectedMessage: true,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Open thread only' }));
    expect(mocks.setPreviewParams).toHaveBeenLastCalledWith({ thread: 'thread-7' });
    expect(screen.getByRole('link', { name: /Quote request/ }).getAttribute('href')).toBe('/nava-preview?thread=thread-7');
  });

  it('requires an unambiguous source even when a preview thread has no message parameter', () => {
    render(<NavaPreviewPage />);
    expect(mocks.useWebPreview).toHaveBeenLastCalledWith({ threadId: 'thread-7', requireSelectedMessage: true });
    expect(screen.getByRole('link', { name: 'Open in webmail' }).getAttribute('href'))
      .toBe('/mail/inbox?threadId=thread-7');
  });

  it('does not apply an orphan message parameter to the default thread', () => {
    mocks.previewQuery = 'sourceMessageId=source-a';
    render(<NavaPreviewPage />);
    expect(mocks.useWebPreview).toHaveBeenLastCalledWith({ threadId: 'thread-7', requireSelectedMessage: true });
  });

  it('the preview page imports WebPanePanel instead of keeping its own copy', () => {
    const pageSource = readSource('../app/(routes)/nava-preview/page.tsx');
    expect(pageSource).toContain(
      "import { WebPanePanel } from '@/components/nava-pane/web-pane-panel';",
    );
    expect(pageSource).toContain('<WebPanePanel');
    expect(pageSource).toContain('key={selectedId}');
    expect(pageSource).toContain('threadId={selectedId}');
    expect(pageSource).not.toContain('function PreviewPanel');
  });
});

describe('Needs-you link in the webmail list header', () => {
  it('hides the mail-list Needs you control while the rollout gate is off', async () => {
    mocks.threadId = 'thread-42';
    render(<MailLayout />);
    expect(await screen.findByTestId('nava-pane')).toBeDefined();
    expect(screen.queryByRole('button', { name: /Needs you/ })).toBeNull();
  });
});

// Last: these reset the module registry so the atom re-reads localStorage on load.
describe('Nava toggle on load', () => {
  it('reads a saved off state, and defaults to on when nothing is saved', async () => {
    localStorage.setItem('nava-side-panel', 'false');
    vi.resetModules();
    const saved = await import('../store/navaSidePanel');
    const savedJotai = await import('jotai');
    expect(savedJotai.getDefaultStore().get(saved.navaSidePanelAtom)).toBe(false);

    localStorage.removeItem('nava-side-panel');
    vi.resetModules();
    const fresh = await import('../store/navaSidePanel');
    const freshJotai = await import('jotai');
    expect(freshJotai.getDefaultStore().get(fresh.navaSidePanelAtom)).toBe(true);
  });
});
