/**
 * @vitest-environment happy-dom
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
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
  wide: true,
  useWebPreview: vi.fn(),
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
  useWebPreview: (args: { threadId: string }) => mocks.useWebPreview(args),
}));

vi.mock('../components/nava-pane/nava-pane', () => ({
  NavaPane: () => <div data-testid="nava-pane" />,
}));

vi.mock('../components/mail/thread-display', () => ({
  ThreadDisplay: () => <div data-testid="thread-display" />,
}));

vi.mock('../components/mail/mail-list', () => ({ MailList: () => null }));
vi.mock('../components/mail/mail-search-bar', () => ({ MailSearchBar: () => null }));
vi.mock('../components/ui/sidebar-toggle', () => ({ SidebarToggle: () => null }));

vi.mock('../hooks/use-media-query', () => ({
  useMediaQuery: (query: string) => (query === '(min-width: 1024px)' ? mocks.wide : true),
}));
vi.mock('../hooks/use-mobile', () => ({ useIsMobile: () => false }));
vi.mock('../hooks/use-threads', () => ({
  useThreads: () => [{ isFetching: false, refetch: vi.fn() }, []],
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
  useParams: () => ({ folder: 'inbox' }),
  useSearchParams: () => [new URLSearchParams('thread=thread-7')],
}));
vi.mock('nuqs', () => ({
  useQueryState: (key: string) => [key === 'threadId' ? mocks.threadId : null, vi.fn()],
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
}));
vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({
    data: { threads: [{ id: 'thread-7', subject: 'Quote request', snippet: 'Please quote' }] },
    isLoading: false,
    isError: false,
  }),
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
  mocks.wide = true;
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
    expect(mocks.useWebPreview).toHaveBeenCalledWith({ threadId: 'thread-42' });
    expect(document.querySelector('[data-preview-thread="thread-42"]')).not.toBeNull();
    expect(panelSize('mail-list-panel')).toBe('30.0');
    expect(panelSize('mail-thread-panel')).toBe('42.0');
    expect(panelSize('mail-nava-panel')).toBe('28.0');
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

  it('the preview page imports WebPanePanel instead of keeping its own copy', () => {
    const pageSource = readSource('../app/(routes)/nava-preview/page.tsx');
    expect(pageSource).toContain(
      "import { WebPanePanel } from '@/components/nava-pane/web-pane-panel';",
    );
    expect(pageSource).toContain('<WebPanePanel key={selectedId} threadId={selectedId} />');
    expect(pageSource).not.toContain('function PreviewPanel');
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
