/**
 * @vitest-environment happy-dom
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getDefaultStore } from 'jotai';
import { WORKFLOW_FOLDER_NAV_ITEMS } from '../config/workflow-folders';
import { navaSidePanelAtom } from '../store/navaSidePanel';

const workflowFolderIds = WORKFLOW_FOLDER_NAV_ITEMS.map((item) => item.id);

const mocks = vi.hoisted(() => ({
  folder: 'quotes',
  threadId: 'thread-quotes',
  listThreadInputs: [] as Array<Record<string, unknown>>,
  workflowRows: [] as Array<{ folder: string; threadId: string }>,
  mailThreads: [] as Array<Record<string, unknown>>,
}));

for (const folder of workflowFolderIds) {
  const threadId = `thread-${folder}`;
  mocks.workflowRows.push({ folder, threadId });
  mocks.mailThreads.push({
    id: threadId,
    transportId: 'transport-1',
    subject: `${folder} workflow thread`,
    snippet: `${folder} request`,
    isArchived: false,
    isStarred: false,
    isRead: false,
    labelIds: [],
    snoozedUntil: null,
    trashedAt: null,
    latestMessageAt: new Date('2026-10-15T10:00:00.000Z'),
    updatedAt: new Date('2026-10-15T10:00:00.000Z'),
  });
}

vi.mock('react-resizable-panels', async () => {
  const { createRequire } = await import('node:module');
  const { join } = await import('node:path');
  const nodeRequire = createRequire(import.meta.url);
  const packageJson = nodeRequire.resolve('react-resizable-panels/package.json');
  return nodeRequire(
    join(packageJson, '..', 'dist', 'react-resizable-panels.browser.development.cjs.js'),
  );
});

vi.mock('../components/mail/mail-list', async () => {
  const { useThreads } = await vi.importActual<typeof import('../hooks/use-threads')>(
    '../hooks/use-threads',
  );

  return {
    MailList: () => {
      const [, threads] = useThreads();
      return (
        <div data-testid="normal-mail-list">
          {threads.map((thread) => (
            <div key={thread.id}>{thread.subject}</div>
          ))}
        </div>
      );
    },
  };
});

vi.mock('../components/mail/thread-display', () => ({
  ThreadDisplay: () => <div data-testid="thread-display" />,
}));
vi.mock('../components/mail/mail-search-bar', () => ({ MailSearchBar: () => null }));
vi.mock('../components/ui/sidebar-toggle', () => ({ SidebarToggle: () => null }));
vi.mock('../components/nava-pane/web-pane-panel', () => ({
  WebPanePanel: ({ threadId, sourceThreadId, goldLabelEnabled }: {
    threadId: string;
    sourceThreadId?: string;
    goldLabelEnabled?: boolean;
  }) => (
    <div
      data-testid="nava-pane"
      data-thread-id={threadId}
      data-source-thread-id={sourceThreadId}
      data-gold-label-enabled={goldLabelEnabled}
    />
  ),
}));
vi.mock('../components/nava-pane/screens/needs-you', () => ({ NeedsYouWebControl: () => null }));
vi.mock('../components/quote-workflow/hms-job-notices', () => ({
  HmsJobNoticeBanner: () => null,
  HmsJobNoticeProvider: ({ children }: PropsWithChildren) => children,
  HmsJobRunningChip: () => null,
}));
vi.mock('../components/mail/use-mail', async () => {
  const { atom } = await import('jotai');
  return {
    useMail: () => [{ bulkSelected: [] }, vi.fn()],
    clearBulkSelectionAtom: atom(null, () => {}),
  };
});

vi.mock('../hooks/use-labels-search', () => ({ default: () => ({ labels: [] }) }));
vi.mock('../hooks/use-category-ids', () => ({ default: () => ({ categoryIds: [] }) }));
vi.mock('../hooks/use-categories', () => ({
  useCategorySettings: () => [],
  useDefaultCategoryId: () => 'Important',
}));
vi.mock('../hooks/use-labels', () => ({ useLabels: () => ({ userLabels: [] }) }));
vi.mock('../hooks/use-connections', () => ({
  useActiveConnection: () => ({
    data: { id: 'transport-1', email: 'centurion@legacyhotels.co.za', providerId: 'custom' },
    isLoading: false,
  }),
}));
vi.mock('../lib/auth-client', () => ({
  useSession: () => ({ data: { user: { id: 'staff-1' } }, isPending: false }),
}));
vi.mock('../lib/demo/runtime', () => ({ isFrontendOnlyDemo: () => false }));
vi.mock('../hooks/use-search-value', () => ({
  useSearchValue: () => [
    { value: '', highlight: '', scope: 'folder', filters: [], resetVersion: 0 },
    vi.fn(),
  ],
}));

vi.mock('../providers/query-provider', () => ({
  useTRPC: () => ({
    drafts: {
      list: {
        infiniteQueryOptions: (_input: unknown, options: Record<string, unknown> = {}) => ({
          queryKey: ['drafts', 'list'],
          queryFn: async () => ({ threads: [], nextPageToken: null }),
          initialPageParam: '',
          ...options,
        }),
      },
    },
    mail: {
      listThreads: {
        infiniteQueryOptions: (input: Record<string, any>, options: Record<string, any> = {}) => {
          mocks.listThreadInputs.push(input);
          return {
            queryKey: ['mail', 'listThreads', input],
            queryFn: async () => {
              const folderThreadIds = new Set(mocks.workflowRows
                .filter((row) => row.folder === input.workflowFolder)
                .map((row) => row.threadId));
              return {
                threads: input.workflowFolder
                  ? mocks.mailThreads.filter((thread) => folderThreadIds.has(String(thread.id)))
                  : mocks.mailThreads,
                nextPageToken: null,
              };
            },
            initialPageParam: '',
            ...options,
          };
        },
      },
    },
  }),
  trpcClient: { workItems: { list: { query: async () => [] } } },
}));

vi.mock('react-router', () => ({
  useNavigate: () => vi.fn(),
  useParams: () => ({ folder: mocks.folder }),
}));
vi.mock('nuqs', () => ({
  useQueryState: (key: string) => [key === 'threadId' ? mocks.threadId : null, vi.fn()],
}));
vi.mock('react-hotkeys-hook', () => ({
  useHotkeys: vi.fn(),
  useHotkeysContext: () => ({ enableScope: vi.fn(), disableScope: vi.fn() }),
}));
vi.mock('../hooks/use-media-query', () => ({ useMediaQuery: () => true }));
vi.mock('../hooks/use-mobile', () => ({ useIsMobile: () => false }));
vi.mock('../paraglide/messages', () => ({ m: new Proxy({}, { get: () => () => '' }) }));

import { MailLayout } from '../components/mail/mail';

const queryClients: QueryClient[] = [];

function renderMailLayout() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  queryClients.push(client);
  const wrapper = ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  getDefaultStore().set(navaSidePanelAtom, true);
  return render(<MailLayout />, { wrapper });
}

afterEach(() => {
  cleanup();
  for (const client of queryClients.splice(0)) client.clear();
  mocks.listThreadInputs.length = 0;
});

describe('workflow folders in the normal mail layout', () => {
  it.each(workflowFolderIds)(
    'shows only %s threads in the normal list, with the thread and Nava pane but no desk',
    async (folder) => {
      mocks.folder = folder;
      mocks.threadId = `thread-${folder}`;
      renderMailLayout();

      expect(await screen.findByText(`${folder} workflow thread`)).toBeDefined();
      for (const otherFolder of workflowFolderIds.filter((item) => item !== folder)) {
        expect(screen.queryByText(`${otherFolder} workflow thread`)).toBeNull();
      }
      expect(screen.getByTestId('normal-mail-list').children).toHaveLength(1);
      expect(screen.getByTestId('thread-display')).toBeDefined();
      expect(screen.getByTestId('nava-pane').getAttribute('data-source-thread-id')).toBe(
        `thread-${folder}`,
      );
      expect(screen.getByTestId('nava-pane').getAttribute('data-gold-label-enabled')).toBe('true');
      expect(screen.queryByRole('heading', { name: 'Quote Desk' })).toBeNull();
      expect(mocks.listThreadInputs).toContainEqual(
        expect.objectContaining({ workflowFolder: folder }),
      );
    },
  );
});
