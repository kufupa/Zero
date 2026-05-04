import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { useDraft } from '../hooks/use-drafts';
import { useTemplates } from '../hooks/use-templates';
import { useThreadNotes } from '../hooks/use-notes';
import { useSummary } from '../hooks/use-summary';
import { RecipientAutosuggest } from '../components/ui/recipient-autosuggest';
import { resolveCommandPaletteSearchQuery } from '../components/context/command-palette-context';
import { resolveMailDisplayWebSearch } from '../components/mail/mail-display';
import { createLabelInThreadContext } from '../components/context/thread-context';
import { deleteLabelInSidebarContext } from '../components/context/label-sidebar-context';
import { handleGeneralSettingsSave } from '../app/(routes)/settings/general/page';
import {
  aiGenerateSummaryQueryKey,
  draftsGetQueryKey,
  mailSettingsQueryKey,
  mailSuggestRecipientsQueryKey,
  notesListQueryKey,
  templatesListQueryKey,
} from '../lib/api/query-options';
import { persistTrustedSender } from '../components/mail/mail-content';
import { runDisconnectConnection, runReconnectConnection } from '../app/(routes)/settings/connections/page';
import { runDeleteAccount } from '../app/(routes)/settings/danger-zone/page';
import { runForceSyncAction } from '../components/ui/nav-user';
import { default as useDeleteFn } from '../hooks/driver/use-delete';
import { useUndoSend } from '../hooks/use-undo-send';
import {
  demoAiCompose,
  demoCreateLabel,
  demoDeleteLabel,
  demoDeleteNote,
  demoDeleteTemplate,
  demoGenerateEmailSubject,
  demoReorderNotes,
  demoSendEmail,
  demoUpsertDraft,
  demoUpsertNote,
  demoUpsertTemplate,
  demoUpdateNote,
} from '../lib/demo/local-actions';
import { useLabels } from '../hooks/use-labels';
import { getDemoStore, resetDemoStoreForTests } from '../lib/demo/local-store';

const useQueryMock = vi.fn();
const useTRPCMock = vi.fn();
const useSessionMock = vi.fn();
const useActiveConnectionMock = vi.fn();
const isFrontendOnlyDemoMock = vi.fn();
const useControllerMock = vi.fn();
const listDemoRecipientSuggestionsMock = vi.fn();
const getDemoDraftMock = vi.fn();
const listDemoNotesMock = vi.fn();
const listDemoTemplatesMock = vi.fn();
const useMutationMock = vi.fn();
const useMailMock = vi.fn();
const useThreadsMock = vi.fn();
const useStatsMock = vi.fn();
const useBackgroundQueueMock = vi.fn();
const deleteThreadMock = vi.fn();
const unsendEmailMock = vi.fn();
const toastPromiseMock = vi.fn((promise: Promise<unknown>, options?: { finally?: () => Promise<void> | void }) => {
  return Promise.resolve(promise).finally(() => options?.finally?.());
});
const toastSuccessMock = vi.fn();
const toastInfoMock = vi.fn();
const toastErrorMock = vi.fn();
const demoUnsendEmailMock = vi.fn();
const refetchThreadsMock = vi.fn();
const refetchStatsMock = vi.fn();
const setMailMock = vi.fn();
const addToQueueMock = vi.fn();

const stateQueue: unknown[] = [];
const setStateQueue = (values: unknown[]) => {
  stateQueue.splice(0, stateQueue.length, ...values);
};

let trpc: ReturnType<typeof makeTrpc>;

vi.mock('@tanstack/react-query', () => ({
  useQuery: (...args: unknown[]) => useQueryMock(...args),
  useMutation: () => useMutationMock(),
}));

vi.mock('@/components/mail/optimistic-thread-state', () => ({
  useOptimisticThreadState: vi.fn(),
}));
vi.mock('@/components/labels/label-dialog', () => ({
  LabelDialog: () => null,
}));
vi.mock('@/components/mail/snooze-dialog', () => ({
  SnoozeDialog: () => null,
}));
vi.mock('@/lib/thread-actions', () => ({}));
vi.mock('@/lib/utils', () => ({
  FOLDERS: { INBOX: 'inbox', SPAM: 'spam', BIN: 'bin', ARCHIVE: 'archive' },
  LABELS: { INBOX: 'inbox', SPAM: 'spam', TRASH: 'trash' },
}));
vi.mock('@/config/navigation', () => ({
  navigationConfig: {},
}));
vi.mock('@/paraglide/messages', () => ({
  m: new Proxy(
    {},
    {
      get: (_target, property) => {
        if (typeof property === 'symbol') return () => '';

        return () => String(property);
      },
    },
  ),
}));
vi.mock('@/types', () => ({ Label: {} }));
vi.mock('@/lib/mail/reply-compose-context', () => ({
  openReplyComposeContext: vi.fn(),
}));
vi.mock('@/lib/demo/local-actions', () => ({
  demoCreateLabel: vi.fn(),
}));
vi.mock('@/hooks/use-threads', () => ({
  useThread: () => ({ data: null }),
  useThreads: () => ({ data: [] }),
}));
vi.mock('@/hooks/use-optimistic-actions', () => ({
  useOptimisticActions: () => ({ optimisticToggleLabel: vi.fn() }),
}));

const trpcAdapterHolder: { ref: unknown } = { ref: null };

vi.mock('@/lib/api/client', async () => {
  const { createLegacyTrpcAdapter } = await import('../lib/api/adapters/legacy-trpc');
  return {
    getFrontendApi: () => {
      const client = trpcAdapterHolder.ref;
      if (!client) {
        throw new Error('demo-backend-guards: trpcAdapterHolder.ref not set before getFrontendApi()');
      }
      return createLegacyTrpcAdapter(client as never);
    },
  };
});

vi.mock('@/providers/query-provider', () => ({
  useTRPC: () => useTRPCMock(),
}));

vi.mock('sonner', () => ({
  toast: {
    promise: (...args: unknown[]) => toastPromiseMock(...args),
    success: (...args: unknown[]) => toastSuccessMock(...args),
    info: (...args: unknown[]) => toastInfoMock(...args),
    error: (...args: unknown[]) => toastErrorMock(...args),
  },
}));

vi.mock('@/lib/auth-client', () => ({
  useSession: () => useSessionMock(),
}));

vi.mock('@/lib/demo/runtime', () => ({
  isFrontendOnlyDemo: () => isFrontendOnlyDemoMock(),
}));
vi.mock('../lib/demo/runtime', () => ({
  isFrontendOnlyDemo: () => isFrontendOnlyDemoMock(),
}));

vi.mock('../hooks/use-connections', () => ({
  useActiveConnection: () => useActiveConnectionMock(),
}));

vi.mock('@/hooks/ui/use-background-queue', () => ({
  default: () => useBackgroundQueueMock(),
}));

vi.mock('@/components/mail/use-mail', () => ({
  useMail: () => useMailMock(),
}));

vi.mock('@/lib/email-utils', () => ({
  isSendResult: vi.fn(() => true),
}));

vi.mock('@/hooks/use-threads', () => ({
  useThreads: () => useThreadsMock(),
}));

vi.mock('@/hooks/use-stats', () => ({
  useStats: () => useStatsMock(),
}));

vi.mock('@/lib/demo/local-actions', async () => {
  const actual = await vi.importActual<typeof import('../lib/demo/local-actions')>('../lib/demo/local-actions');
  return {
    ...actual,
    demoUnsendEmail: (...args: unknown[]) => demoUnsendEmailMock(...args),
  };
});

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react');

  return {
    ...actual,
    useState: (initial: unknown) => {
      const value = stateQueue.length
        ? stateQueue.shift()
        : typeof initial === 'function'
          ? initial()
          : initial;
      return [value, vi.fn()];
    },
    useRef: (value: unknown) => ({ current: value }),
    useCallback: (callback: unknown) => callback,
    useMemo: (callback: any) => callback(),
  };
});

vi.mock('react-hook-form', async () => {
  const actual = await vi.importActual<typeof import('react-hook-form')>('react-hook-form');
  return {
    ...actual,
    useController: () => useControllerMock(),
  };
});

vi.mock('@/hooks/use-debounce', () => ({
  useDebounce: (callback: (query: string) => void) => callback,
}));

vi.mock('@/lib/utils', () => ({
  cn: (...values: unknown[]) => values.filter(Boolean).join(' '),
}));

vi.mock('@/lib/demo/local-suggestions', () => ({
  listDemoRecipientSuggestions: (...args: unknown[]) => listDemoRecipientSuggestionsMock(...args),
}));

vi.mock('@/lib/demo/local-store', async () => {
  const actual = await vi.importActual<typeof import('../lib/demo/local-store')>('../lib/demo/local-store');
  return {
    ...actual,
    getDemoDraft: (...args: unknown[]) => getDemoDraftMock(...args),
    listDemoNotes: (...args: unknown[]) => listDemoNotesMock(...args),
    listDemoTemplates: (...args: unknown[]) => listDemoTemplatesMock(...args),
  };
});

function makeTrpc() {
  return {
    connections: {
      list: {
        query: vi.fn(async () => ({ connections: [] })),
        queryOptions: vi.fn(),
      },
      getDefault: {
        query: vi.fn(async () => null),
        queryOptions: vi.fn(),
      },
      setDefault: {
        mutationOptions: vi.fn(() => ({ mutationFn: vi.fn(async () => ({})) })),
      },
      delete: { mutationOptions: vi.fn() },
    },
    drafts: {
      get: {
        queryOptions: vi.fn((input: { id: string }, options: Record<string, unknown> = {}) => ({
          queryKey: ['drafts', 'get', input.id],
          queryFn: vi.fn(),
          ...options,
        })),
        query: vi.fn(async (input: { id: string }) => ({ id: input.id })),
      },
      delete: {
        mutationOptions: vi.fn(),
        mutate: vi.fn(async () => ({ success: true })),
      },
    },
    labels: {
      list: {
        queryOptions: vi.fn((options: Record<string, unknown> = {}) => ({
          queryKey: ['labels', 'list'],
          queryFn: vi.fn(),
          ...options,
        })),
        query: vi.fn(async () => []),
      },
      create: {
        mutationOptions: vi.fn(),
      },
      delete: {
        mutationOptions: vi.fn(),
      },
    },
    notes: {
      list: {
        query: vi.fn(async () => ({ notes: [] })),
        queryOptions: vi.fn((input: { threadId: string }, options: Record<string, unknown> = {}) => ({
          queryKey: ['notes', 'list', input.threadId],
          queryFn: vi.fn(),
          ...options,
        })),
      },
    },
    templates: {
      list: {
        queryOptions: vi.fn((_input: unknown, options: Record<string, unknown> = {}) => ({
          queryKey: ['templates', 'list'],
          queryFn: vi.fn(),
          ...options,
        })),
        query: vi.fn(async () => ({ templates: [] })),
      },
    },
    mail: {
      listThreads: {
        query: vi.fn(async () => ({ threads: [], nextPageToken: null as string | null })),
      },
      get: {
        query: vi.fn(async () => ({ messages: [], latest: undefined })),
      },
      getMessageAttachments: {
        query: vi.fn(async () => []),
      },
      processEmailContent: {
        mutate: vi.fn(async (input: { html: string }) => ({
          processedHtml: input.html,
          hasBlockedImages: false,
        })),
      },
      forceSync: {
        mutationOptions: vi.fn(() => ({ mutationFn: vi.fn(async () => ({})) })),
      },
      delete: {
        mutationOptions: vi.fn(),
        mutate: vi.fn(async () => undefined),
      },
      markAsRead: { mutate: vi.fn(async () => ({})) },
      markAsUnread: { mutate: vi.fn(async () => ({})) },
      toggleStar: { mutate: vi.fn(async () => ({})) },
      toggleImportant: { mutate: vi.fn(async () => ({})) },
      bulkDelete: { mutate: vi.fn(async () => ({})) },
      snoozeThreads: { mutate: vi.fn(async () => ({})) },
      unsnoozeThreads: { mutate: vi.fn(async () => ({})) },
      modifyLabels: { mutate: vi.fn(async () => ({})) },
      suggestRecipients: {
        query: vi.fn(async () => []),
        queryOptions: vi.fn((input: { query: string; limit: number }, options: Record<string, unknown> = {}) => ({
          queryKey: ['mail', 'suggestRecipients', input.query, input.limit],
          queryFn: vi.fn(),
          ...options,
        })),
      },
      verifyEmail: {
        query: vi.fn(async () => ({ isVerified: false })),
        queryOptions: vi.fn((input: { id: string }, options: Record<string, unknown> = {}) => ({
          queryKey: ['mail', 'verifyEmail', input.id],
          queryFn: vi.fn(),
          ...options,
        })),
      },
      unsend: {
        mutationOptions: vi.fn(),
        mutate: vi.fn(async () => ({ success: true })),
      },
    },
  ai: {
    webSearch: {
      mutationOptions: vi.fn((options: Record<string, unknown> = {}) => ({
        mutationFn: vi.fn(async (input: { query: string }) => ({
          text: `Backend web search for ${input.query}`,
          sources: [{ id: 'source-1', title: 'Backend source', url: 'https://example.com' }],
        })),
        ...options,
      })),
    },
  },
  brain: {
    generateSummary: {
      queryOptions: vi.fn((input: { threadId: string }, options: Record<string, unknown> = {}) => ({
        queryKey: ['brain', 'generateSummary', input.threadId],
        queryFn: vi.fn(async () => ({
          data: {
            short: `Backend summary for thread ${input.threadId}`,
            long: `Backend long summary for thread ${input.threadId}`,
          },
        })),
        ...options,
      })),
      query: vi.fn(async (input: { threadId: string }) => ({
        data: {
          short: `Backend summary for thread ${input.threadId}`,
          long: `Backend long summary for thread ${input.threadId}`,
        },
      })),
    },
    getState: {
      queryOptions: vi.fn((options: Record<string, unknown> = {}) => ({
        queryKey: ['brain', 'getState'],
        queryFn: vi.fn(),
        ...options,
      })),
      query: vi.fn(async () => ({ enabled: true })),
    },
  },
  bimi: {
    getByEmail: {
      query: vi.fn(async () => null),
      queryOptions: vi.fn((input: { email: string }, options: Record<string, unknown> = {}) => ({
        queryKey: ['bimi', 'getByEmail', input.email],
        queryFn: vi.fn(),
        ...options,
      })),
    },
  },
  };
}

beforeEach(() => {
  trpc = makeTrpc();
  trpcAdapterHolder.ref = trpc;
  isFrontendOnlyDemoMock.mockReturnValue(true);
  useTRPCMock.mockReturnValue(trpc);
  useMutationMock.mockReturnValue({ mutateAsync: deleteThreadMock });
  useMailMock.mockReturnValue([{ bulkSelected: [] }, setMailMock]);
  useThreadsMock.mockReturnValue([{ refetch: refetchThreadsMock }]);
  useStatsMock.mockReturnValue({ refetch: refetchStatsMock });
  useBackgroundQueueMock.mockReturnValue({ addToQueue: addToQueueMock });
  trpc.mail.delete.mutationOptions.mockReturnValue({ endpoint: 'mail.delete' });
  trpc.mail.unsend.mutationOptions.mockReturnValue({ endpoint: 'mail.unsend' });
  useSessionMock.mockReturnValue({ data: { user: { id: 'demo-user' } } });
  useActiveConnectionMock.mockReturnValue({ data: { id: 'demo-connection' } });
  useControllerMock.mockReturnValue({
    field: {
      value: [],
      onChange: vi.fn(),
    },
  });
  listDemoRecipientSuggestionsMock.mockReturnValue([
    {
      email: 'demo-recipient@example.com',
      displayText: 'Demo Recipient <demo-recipient@example.com>',
    },
  ]);
  getDemoDraftMock.mockReturnValue({
    id: 'draft-123',
    subject: '',
    to: '',
    cc: '',
    bcc: '',
    updatedAt: new Date().toISOString(),
  });
  listDemoNotesMock.mockReturnValue([]);
  listDemoTemplatesMock.mockReturnValue([]);
  useQueryMock.mockImplementation(
    (queryOptions?: { enabled?: unknown; queryFn?: () => Promise<unknown> | unknown; initialData?: unknown }) => {
      if (queryOptions?.enabled && queryOptions.queryFn) {
        queryOptions.queryFn();
      }

      return {
        data: queryOptions?.initialData,
        isLoading: false,
      };
    },
  );
  useQueryMock.mockClear();
  useTRPCMock.mockClear();
  useSessionMock.mockClear();
  useActiveConnectionMock.mockClear();
  useControllerMock.mockClear();
  isFrontendOnlyDemoMock.mockClear();
  getDemoDraftMock.mockClear();
  listDemoNotesMock.mockClear();
  listDemoTemplatesMock.mockClear();
  listDemoRecipientSuggestionsMock.mockClear();
  useMutationMock.mockClear();
  useMailMock.mockClear();
  useThreadsMock.mockClear();
  useStatsMock.mockClear();
  useBackgroundQueueMock.mockClear();
  deleteThreadMock.mockClear();
  unsendEmailMock.mockClear();
  toastPromiseMock.mockClear();
  toastSuccessMock.mockClear();
  toastInfoMock.mockClear();
  toastErrorMock.mockClear();
  demoUnsendEmailMock.mockClear();
  refetchThreadsMock.mockClear();
  refetchStatsMock.mockClear();
  setMailMock.mockClear();
  addToQueueMock.mockClear();
  trpc.mail.delete.mutationOptions.mockClear();
  trpc.mail.unsend.mutationOptions.mockClear();
  trpc.labels.create.mutationOptions.mockClear();
  trpc.labels.delete.mutationOptions.mockClear();
  trpc.labels.list.queryOptions.mockClear();
  trpc.ai.webSearch.mutationOptions.mockClear();
  trpc.brain.generateSummary.queryOptions.mockClear();
  trpc.brain.getState.queryOptions.mockClear();
  (globalThis as { React?: typeof React }).React = React;
  setStateQueue(['', false, -1, false, '']);
  resetDemoStoreForTests();
});

describe('demo backend guard coverage', () => {
  it('uses local draft reads for useDraft when frontend-only demo mode is active', () => {
    useDraft('draft-123');

    expect(useQueryMock).toHaveBeenCalledTimes(1);
    const draftQuery = useQueryMock.mock.calls[0]?.[0] as { queryKey: unknown[] };

    expect(draftQuery.queryKey).toEqual(['demo', 'drafts', 'get', 'draft-123']);
    expect(trpc.drafts.get.queryOptions).not.toHaveBeenCalled();
  });

  it('normalizes demo draft payload for consumer compatibility', async () => {
    const updatedAt = '2026-01-01T00:00:00.000Z';
    getDemoDraftMock.mockReturnValue({
      id: 'draft-123',
      subject: '  Hotel Follow Up  ',
      body: 'Draft content',
      to: 'Alice <alice@example.com>, bob@example.com; Carol <carol@example.com>',
      cc: 'Dana <dana@example.com>',
      bcc: 'dana@example.com',
      updatedAt,
      threadId: 'thread-abc',
      userId: 'user-1',
      createdAt: '2026-01-01T00:00:00.000Z',
    });

    useDraft('draft-123');

    const draftQuery = useQueryMock.mock.calls[0]?.[0] as {
      queryFn?: () => Promise<{
        id: string;
        subject?: string;
        content?: string;
        to?: string[];
        cc?: string[];
        bcc?: string[];
        rawMessage?: { internalDate?: string | null };
      } | undefined>;
    };
    const queryFn = draftQuery.queryFn;
    expect(queryFn).toBeDefined();

    expect(await queryFn!()).toEqual({
      id: 'draft-123',
      subject: 'Hotel Follow Up',
      content: 'Draft content',
      to: ['alice@example.com', 'bob@example.com', 'carol@example.com'],
      cc: ['dana@example.com'],
      bcc: ['dana@example.com'],
      rawMessage: { internalDate: String(new Date(updatedAt).getTime()) },
    });
  });

  it('uses backend draft query when frontend-only demo mode is disabled', () => {
    isFrontendOnlyDemoMock.mockReturnValue(false);
    useDraft('draft-123');

    expect(useQueryMock).toHaveBeenCalledTimes(1);
    const draftQuery = useQueryMock.mock.calls[0]?.[0] as {
      queryKey: unknown[];
      queryFn?: () => unknown;
    };
    expect(trpc.drafts.get.queryOptions).not.toHaveBeenCalled();
    expect(draftQuery.queryKey).toEqual(draftsGetQueryKey({ mode: 'legacy', accountId: null }, { id: 'draft-123' }));
    expect(typeof draftQuery.queryFn).toBe('function');
    expect(getDemoDraftMock).not.toHaveBeenCalled();
  });

  it('uses local template reads for useTemplates when frontend-only demo mode is active', () => {
    useTemplates();

    expect(useQueryMock).toHaveBeenCalledTimes(1);
    const templateQuery = useQueryMock.mock.calls[0]?.[0] as { queryKey: unknown[] };

    expect(templateQuery.queryKey).toEqual(['demo', 'templates']);
    expect(trpc.templates.list.queryOptions).not.toHaveBeenCalled();
  });

  it('uses backend template query when frontend-only demo mode is disabled', () => {
    isFrontendOnlyDemoMock.mockReturnValue(false);
    useTemplates();

    expect(useQueryMock).toHaveBeenCalledTimes(1);
    const templateQuery = useQueryMock.mock.calls[0]?.[0] as {
      queryKey: unknown[];
      queryFn?: () => unknown;
    };
    expect(trpc.templates.list.queryOptions).not.toHaveBeenCalled();
    expect(templateQuery.queryKey).toEqual(templatesListQueryKey({ mode: 'legacy', accountId: null }));
    expect(typeof templateQuery.queryFn).toBe('function');
    expect(listDemoTemplatesMock).not.toHaveBeenCalled();
  });

  it('uses local command-palette search expansion in demo mode', async () => {
    const backendGenerateSearchQuery = vi.fn(async (input: { query: string }) => ({
      query: `${input.query} (backend)`,
    }));

    const result = await resolveCommandPaletteSearchQuery({
      query: 'follow up client',
      isFrontendOnlyDemoMode: true,
      generateSearchQuery: backendGenerateSearchQuery,
    });

    expect(backendGenerateSearchQuery).not.toHaveBeenCalled();
    expect(result.query).toBe('follow up client');
  });

  it('keeps demo command-palette expansion deterministic for empty/whitespace query input', async () => {
    const backendGenerateSearchQuery = vi.fn(async (input: { query: string }) => ({
      query: `${input.query} (backend)`,
    }));

    const result = await resolveCommandPaletteSearchQuery({
      query: '   ',
      isFrontendOnlyDemoMode: true,
      generateSearchQuery: backendGenerateSearchQuery,
    });

    expect(backendGenerateSearchQuery).not.toHaveBeenCalled();
    expect(result.query).toBe('query');
  });

  it('keeps demo command-palette expansion deterministic for trimmed punctuation-heavy query', async () => {
    const backendGenerateSearchQuery = vi.fn(async (input: { query: string }) => ({
      query: `${input.query} (backend)`,
    }));
    const longQuery = `   !!!???%%${'x'.repeat(96)}&&& spaced query!!!   `;

    const resultA = await resolveCommandPaletteSearchQuery({
      query: longQuery,
      isFrontendOnlyDemoMode: true,
      generateSearchQuery: backendGenerateSearchQuery,
    });
    const resultB = await resolveCommandPaletteSearchQuery({
      query: longQuery,
      isFrontendOnlyDemoMode: true,
      generateSearchQuery: backendGenerateSearchQuery,
    });

    expect(resultA).toEqual(resultB);
    expect(resultA.query).toBe(`!!!???%%${'x'.repeat(96)}&&& spaced query!!!`);
  });

  it('uses backend command-palette expansion when frontend-only demo mode is disabled', async () => {
    const backendGenerateSearchQuery = vi.fn(async (input: { query: string }) => ({
      query: `${input.query} (backend)`,
    }));

    const result = await resolveCommandPaletteSearchQuery({
      query: 'follow up client',
      isFrontendOnlyDemoMode: false,
      generateSearchQuery: backendGenerateSearchQuery,
    });

    expect(backendGenerateSearchQuery).toHaveBeenCalledWith({ query: 'follow up client' });
    expect(result.query).toBe('follow up client (backend)');
  });

  it('uses local web-search fallback in mail-display web search mode', async () => {
    const backendWebSearch = vi.fn(async (input: { query: string }) => ({
      text: `Backend web search for ${input.query}`,
      sources: [
        {
          id: 'source-1',
          title: 'Backend source',
          url: 'https://example.com',
        },
      ],
    }));

    const result = await resolveMailDisplayWebSearch({
      query: 'paypal',
      isFrontendOnlyDemoMode: true,
      webSearch: backendWebSearch,
    });

    expect(backendWebSearch).not.toHaveBeenCalled();
    expect(result).toEqual({
      text: 'Demo web search results for: paypal',
      sources: [],
    });
  });

  it('keeps mail-display web-search demo fallback deterministic for empty/whitespace query input', async () => {
    const backendWebSearch = vi.fn(async (input: { query: string }) => ({
      text: `Backend web search for ${input.query}`,
      sources: [{ id: 'source-1', title: 'Backend source', url: 'https://example.com' }],
    }));

    const result = await resolveMailDisplayWebSearch({
      query: '   ',
      isFrontendOnlyDemoMode: true,
      webSearch: backendWebSearch,
    });

    expect(backendWebSearch).not.toHaveBeenCalled();
    expect(result.text).toBe('Demo web search results for: query');
    expect(result.sources).toEqual([]);
  });

  it('keeps mail-display web-search demo fallback stable for long punctuation-heavy input', async () => {
    const backendWebSearch = vi.fn(async (input: { query: string }) => ({
      text: `Backend web search for ${input.query}`,
      sources: [{ id: 'source-1', title: 'Backend source', url: 'https://example.com' }],
    }));
    const longQuery = `   !!!***${'?'.repeat(120)}%%% demo query!!!   `;

    const first = await resolveMailDisplayWebSearch({
      query: longQuery,
      isFrontendOnlyDemoMode: true,
      webSearch: backendWebSearch,
    });
    const second = await resolveMailDisplayWebSearch({
      query: longQuery,
      isFrontendOnlyDemoMode: true,
      webSearch: backendWebSearch,
    });

    expect(first).toEqual(second);
    expect(first.text).toBe(`Demo web search results for: !!!***${'?'.repeat(120)}%%% demo query!!!`);
    expect(first.sources).toEqual([]);
  });

  it('uses backend web search query for mail-display web-search when demo mode is disabled', async () => {
    const backendWebSearch = vi.fn(async (input: { query: string }) => ({
      text: `Backend web search for ${input.query}`,
      sources: [
        {
          id: 'source-1',
          title: 'Backend source',
          url: 'https://example.com',
        },
      ],
    }));

    const result = await resolveMailDisplayWebSearch({
      query: 'paypal',
      isFrontendOnlyDemoMode: false,
      webSearch: backendWebSearch,
    });

    expect(backendWebSearch).toHaveBeenCalledWith({ query: 'paypal' });
    expect(result).toEqual({
      text: 'Backend web search for paypal',
      sources: [
        {
          id: 'source-1',
          title: 'Backend source',
          url: 'https://example.com',
        },
      ],
    });
  });

  it('uses local notes reads for useThreadNotes when frontend-only demo mode is active', () => {
    useThreadNotes('thread-456');

    expect(useQueryMock).toHaveBeenCalledTimes(1);
    const noteQuery = useQueryMock.mock.calls[0]?.[0] as { queryKey: unknown[] };

    expect(noteQuery.queryKey).toEqual(['demo', 'notes', 'thread-456']);
    expect(trpc.notes.list.queryOptions).not.toHaveBeenCalled();
  });

  it('uses local summary generation in demo mode for useSummary', async () => {
    useSummary('thread-summary');

    expect(trpc.brain.generateSummary.queryOptions).not.toHaveBeenCalled();
    expect(useQueryMock).toHaveBeenCalledTimes(1);
    const summaryQuery = useQueryMock.mock.calls[0]?.[0] as {
      queryKey: unknown[];
      queryFn?: () => Promise<{ data: { short: string; long: string } }>;
    };
    expect(summaryQuery.queryKey).toEqual(['demo', 'brain', 'generateSummary', 'thread-summary']);
    expect(typeof summaryQuery.queryFn).toBe('function');

    const summaryData = await summaryQuery.queryFn!();
    expect(summaryData).toEqual({
      data: {
        short: 'Demo summary for thread thread-summary.',
        long: 'Demo summary for thread thread-summary without backend data.',
      },
    });
  });

  it('uses backend summary query when frontend-only demo mode is disabled', () => {
    isFrontendOnlyDemoMock.mockReturnValue(false);
    useSummary('thread-live');

    expect(trpc.brain.generateSummary.queryOptions).not.toHaveBeenCalled();
    expect(useQueryMock).toHaveBeenCalledTimes(1);
    const summaryQuery = useQueryMock.mock.calls[0]?.[0] as {
      queryKey: unknown[];
      queryFn?: () => Promise<{ data: { short: string; long: string } }>;
    };
    expect(summaryQuery.queryKey).toEqual(
      aiGenerateSummaryQueryKey({ mode: 'legacy', accountId: null }, 'thread-live'),
    );
    expect(typeof summaryQuery.queryFn).toBe('function');
    expect(trpc.ai.webSearch.mutationOptions).not.toHaveBeenCalled();
  });

  it('uses backend notes query when frontend-only demo mode is disabled', () => {
    isFrontendOnlyDemoMock.mockReturnValue(false);
    useThreadNotes('thread-456');

    expect(useQueryMock).toHaveBeenCalledTimes(1);
    const notesQuery = useQueryMock.mock.calls[0]?.[0] as {
      queryKey: unknown[];
      queryFn?: () => unknown;
    };
    expect(notesQuery.queryKey).toEqual(
      notesListQueryKey({ mode: 'legacy', accountId: null }, { threadId: 'thread-456' }),
    );
    expect(typeof notesQuery.queryFn).toBe('function');
    expect(listDemoNotesMock).not.toHaveBeenCalled();
  });

  it('keeps recipient autosuggest backend query disabled in frontend-only demo mode', () => {
    RecipientAutosuggest({
      control: {},
      name: 'recipients',
      placeholder: 'Enter email',
    });

    expect(useQueryMock).toHaveBeenCalledTimes(1);
    const suggestionQuery = useQueryMock.mock.calls[0]?.[0] as { queryKey: unknown[]; enabled: boolean };

    expect(suggestionQuery.queryKey[0]).toBe('demo');
    expect(suggestionQuery.enabled).toBe(false);
    expect(listDemoRecipientSuggestionsMock).not.toHaveBeenCalled();
  });

  it('uses local recipient suggestions when typing in frontend-only demo mode', () => {
    setStateQueue(['', false, -1, false, 'alice']);

    RecipientAutosuggest({
      control: {},
      name: 'recipients',
      placeholder: 'Enter email',
    });

    expect(useQueryMock).toHaveBeenCalledTimes(1);
    expect(listDemoRecipientSuggestionsMock).toHaveBeenCalledWith('alice', 10);
  });

  it('uses backend recipient suggestion query when frontend-only demo mode is disabled', () => {
    isFrontendOnlyDemoMock.mockReturnValue(false);
    setStateQueue(['', false, -1, false, 'alice']);

    RecipientAutosuggest({
      control: {},
      name: 'recipients',
      placeholder: 'Enter email',
    });

    expect(useQueryMock).toHaveBeenCalledTimes(1);
    const autosuggestQuery = useQueryMock.mock.calls[0]?.[0] as {
      queryKey: unknown[];
      queryFn?: () => unknown;
    };
    expect(autosuggestQuery.queryKey).toEqual(
      mailSuggestRecipientsQueryKey({ mode: 'legacy', accountId: null }, { query: 'alice', limit: 10 }),
    );
    expect(typeof autosuggestQuery.queryFn).toBe('function');
    expect(listDemoRecipientSuggestionsMock).not.toHaveBeenCalled();
  });

  it('does not call backend delete in demo mode and applies local delete flow', async () => {
    isFrontendOnlyDemoMock.mockReturnValue(true);
    useMutationMock.mockImplementation(() => ({ mutateAsync: deleteThreadMock }));
    deleteThreadMock.mockResolvedValue(undefined);
    const deleteHook = useDeleteFn();

    await deleteHook.mutate('thread-demo');

    expect(addToQueueMock).toHaveBeenCalledWith('thread-demo');
    expect(deleteThreadMock).not.toHaveBeenCalled();
    expect(trpc.mail.delete.mutationOptions).not.toHaveBeenCalled();
    expect(refetchThreadsMock).toHaveBeenCalled();
    expect(refetchStatsMock).toHaveBeenCalled();
    expect(setMailMock).toHaveBeenCalled();
    expect(toastPromiseMock).toHaveBeenCalledTimes(1);
  });

  it('uses backend delete when not in demo mode', async () => {
    isFrontendOnlyDemoMock.mockReturnValue(false);
    useMutationMock.mockImplementation(() => ({ mutateAsync: deleteThreadMock }));
    deleteThreadMock.mockResolvedValue(undefined);
    const deleteHook = useDeleteFn();

    await deleteHook.mutate('thread-live');

    expect(deleteThreadMock).toHaveBeenCalledWith({ id: 'thread-live' });
    expect(refetchThreadsMock).toHaveBeenCalled();
    expect(refetchStatsMock).toHaveBeenCalled();
    expect(toastPromiseMock).toHaveBeenCalledTimes(1);
  });

  it('uses local unsend helper in demo mode for undo', async () => {
    isFrontendOnlyDemoMock.mockReturnValue(true);
    useMutationMock.mockImplementation(() => ({ mutateAsync: unsendEmailMock }));
    demoUnsendEmailMock.mockResolvedValue({ success: true });
    let capturedUndoAction: (() => Promise<void> | void) | undefined;
    toastSuccessMock.mockImplementation((_message: string, options?: { action?: { onClick: () => Promise<void> | void } }) => {
      capturedUndoAction = options?.action?.onClick;
      return undefined;
    });

    const { handleUndoSend } = useUndoSend();
    handleUndoSend(
      { messageId: 'message-demo', sendAt: Date.now() + 15_000 },
      { settings: { undoSendEnabled: true } as never },
    );

    expect(capturedUndoAction).toBeDefined();
    await capturedUndoAction?.();

    expect(demoUnsendEmailMock).toHaveBeenCalledWith({ messageId: 'message-demo' });
    expect(unsendEmailMock).not.toHaveBeenCalled();
  });

  it('uses backend unsend mutation when not in demo mode', async () => {
    isFrontendOnlyDemoMock.mockReturnValue(false);
    useMutationMock.mockImplementation(() => ({ mutateAsync: unsendEmailMock }));
    unsendEmailMock.mockResolvedValue({ success: true });
    let capturedUndoAction: (() => Promise<void> | void) | undefined;
    toastSuccessMock.mockImplementation((_message: string, options?: { action?: { onClick: () => Promise<void> | void } }) => {
      capturedUndoAction = options?.action?.onClick;
      return undefined;
    });

    const { handleUndoSend } = useUndoSend();
    handleUndoSend(
      { messageId: 'message-live', sendAt: Date.now() + 15_000 },
      { settings: { undoSendEnabled: true } as never },
    );

    expect(capturedUndoAction).toBeDefined();
    await capturedUndoAction?.();

    expect(unsendEmailMock).toHaveBeenCalledWith({ messageId: 'message-live' });
    expect(demoUnsendEmailMock).not.toHaveBeenCalled();
  });

  it('uses local label reads for useLabels in demo mode', () => {
    useLabels();

    expect(trpc.labels.list.queryOptions).not.toHaveBeenCalled();
    const demoLabelCall = useQueryMock.mock.calls.find(
      (call) => (call[0] as { queryKey?: unknown[] } | undefined)?.queryKey?.[0] === 'demo',
    )?.[0] as { queryKey: unknown[]; enabled?: boolean } | undefined;
    const backendLabelCall = useQueryMock.mock.calls.find((call) => {
      const k = (call[0] as { queryKey?: unknown[] } | undefined)?.queryKey;
      return Array.isArray(k) && k[0] === 'frontendApi' && k[3] === 'labels' && k[4] === 'list';
    })?.[0] as { queryKey: unknown[]; enabled?: boolean } | undefined;
    expect(demoLabelCall?.queryKey).toEqual(['demo', 'labels']);
    expect(backendLabelCall?.enabled).toBe(false);
  });

  it('uses backend label reads for useLabels when frontend-only demo mode is disabled', () => {
    isFrontendOnlyDemoMock.mockReturnValue(false);
    useLabels();

    expect(trpc.labels.list.queryOptions).not.toHaveBeenCalled();
    const live = useQueryMock.mock.calls.find((call) => {
      const k = (call[0] as { queryKey?: unknown[]; enabled?: boolean } | undefined)?.queryKey;
      return Array.isArray(k) && k[0] === 'frontendApi' && k[3] === 'labels' && k[4] === 'list';
    })?.[0] as { enabled?: boolean; staleTime?: number } | undefined;
    expect(live?.enabled).toBe(true);
    expect(live?.staleTime).toBe(1000 * 60 * 60);
  });

  it('uses local label actions in demo mode (thread/context create path)', async () => {
    const created = await demoCreateLabel({
      name: 'demo label',
      color: { backgroundColor: '#202020', textColor: '#FFFFFF' },
    });
    const deleted = await demoDeleteLabel(created.id);

    expect(created.name).toBe('demo label');
    expect(deleted).toEqual({ success: true });
    expect(await demoDeleteLabel(created.id)).toEqual({ success: false });
  });

  it('creates and removes template data locally in demo mode', async () => {
    const template = await demoUpsertTemplate({
      name: 'Reply Later',
      subject: 'Follow up',
      body: 'Here is a quick update.',
    });
    const deleteResult = await demoDeleteTemplate(template.id);
    const doubleDeleteResult = await demoDeleteTemplate(template.id);

    expect(template.id).toMatch(/^template-/);
    expect(deleteResult).toEqual({ success: true });
    expect(doubleDeleteResult).toEqual({ success: false });
  });

  it('writes note CRUD and reorder mutations locally in demo mode', async () => {
    const created = await demoUpsertNote({
      threadId: 'thread-notes',
      content: 'Initial note',
      color: 'blue',
      isPinned: false,
      order: 1,
    });

    const updated = await demoUpdateNote(created.id, {
      content: 'Updated note',
      isPinned: true,
      order: 2,
    });
    const reorder = await demoReorderNotes([
      {
        id: created.id,
        order: 2,
        isPinned: true,
      },
    ]);
    const deleted = await demoDeleteNote(created.id);
    const doubleDelete = await demoDeleteNote(created.id);

    expect(created.content).toBe('Initial note');
    expect(updated.note?.content).toBe('Updated note');
    expect(Array.isArray(reorder.notes)).toBe(true);
    expect(reorder.notes[0]?.id).toBe(created.id);
    expect(deleted).toEqual({ success: true });
    expect(doubleDelete).toEqual({ success: false });
  });

  it('uses local compose helper behavior in demo mode for send/draft/AI paths', async () => {
    const draft = await demoUpsertDraft({
      threadId: 'thread-compose',
      subject: 'Subject',
      body: 'Body',
    });
    const sendNow = await demoSendEmail({ scheduleAt: undefined });
    const sendQueued = await demoSendEmail({ scheduleAt: new Date('2026-01-01T00:00:00Z').toISOString() });
    const ai = await demoAiCompose({ prompt: 'Draft a concise follow-up message.' });
    const generated = await demoGenerateEmailSubject({ message: 'Quarterly planning update for Q3' });

    expect(draft.id).toBeTruthy();
    expect(sendNow).toEqual({ success: true });
    expect(sendQueued.queued).toBe(true);
    expect(typeof sendQueued.messageId).toBe('string');
    expect(ai.newBody).toContain('Draft a concise follow-up message.');
    expect(generated.subject).toBe('Quarterly planning update for Q3');
  });

  it('keeps demo label/toast create/delete paths local and side-effect free', async () => {
    isFrontendOnlyDemoMock.mockReturnValue(true);

    const createResult = await demoCreateLabel({
      name: 'Sidebar label',
      color: { backgroundColor: '#1a2b3c', textColor: '#ffffff' },
      type: 'user',
    });

    expect(createResult.type).toBe('user');
    expect(createResult.id).toBeTruthy();
    expect(await demoDeleteLabel(createResult.id)).toEqual({ success: true });
  });

  it('persists a new label in demo when thread context create handler runs', async () => {
    isFrontendOnlyDemoMock.mockReturnValue(true);
    const setCreateLabelOpen = vi.fn();
    const refetchLabels = vi.fn(async () => ({ success: true }));

    await createLabelInThreadContext({
      data: {
        id: 'label-ui-created',
        name: 'Thread Demo Label',
        color: {
          backgroundColor: '#102030',
          textColor: '#eef',
        },
        type: 'user',
      },
      isFrontendOnlyDemoMode: true,
      setCreateLabelOpen,
      createLabel: async (payload) => demoCreateLabel(payload),
      refetchLabels,
      labelsSuccessMessage: 'Label saved in demo',
      labelsSavingMessage: 'Saving demo label',
      labelsSaveErrorMessage: 'Demo label save failed',
      onError: vi.fn(),
    });

    const labels = getDemoStore().labels;
    expect(Object.values(labels).some((label) => label.name === 'Thread Demo Label')).toBe(true);
    expect(refetchLabels).toHaveBeenCalledTimes(1);
    expect(setCreateLabelOpen).toHaveBeenCalledWith(false);
    expect(toastSuccessMock).toHaveBeenCalledWith('Label saved in demo');
    expect(toastPromiseMock).not.toHaveBeenCalled();
  });

  it('calls backend label mutation in non-demo thread context create flow', async () => {
    const createLabelMock = vi.fn(async () => ({ id: 'backend-label-id', name: 'Backend Label' }));
    const setCreateLabelOpen = vi.fn();
    const refetchLabels = vi.fn(async () => ({ success: true }));

    await createLabelInThreadContext({
      data: {
        id: 'label-ui-created',
        name: 'Thread Backend Label',
        color: {
          backgroundColor: '#203040',
          textColor: '#fefefe',
        },
        type: 'user',
      },
      isFrontendOnlyDemoMode: false,
      setCreateLabelOpen,
      createLabel: createLabelMock,
      refetchLabels,
      labelsSuccessMessage: 'Label saved',
      labelsSavingMessage: 'Saving label',
      labelsSaveErrorMessage: 'Failed to save label',
      onError: vi.fn(),
    });

    expect(createLabelMock).toHaveBeenCalledTimes(1);
    expect(createLabelMock).toHaveBeenCalledWith({
      name: 'Thread Backend Label',
      color: {
        backgroundColor: '#203040',
        textColor: '#fefefe',
      },
      type: 'user',
    });
    expect(refetchLabels).toHaveBeenCalledTimes(1);
    expect(setCreateLabelOpen).toHaveBeenCalledWith(false);
    expect(toastPromiseMock).toHaveBeenCalledTimes(1);
    expect(toastSuccessMock).not.toHaveBeenCalledWith('Label saved');
  });

  it('removes a label from demo storage in label-sidebar delete demo flow', async () => {
    isFrontendOnlyDemoMock.mockReturnValue(true);
    const setDeleteDialogOpen = vi.fn();
    const deleteRefetch = vi.fn(async () => ({ success: true }));
    const created = await demoCreateLabel({ name: 'Sidebar Demo Label', type: 'user' });

    await deleteLabelInSidebarContext({
      labelId: created.id,
      isFrontendOnlyDemoMode: true,
      setDeleteDialogOpen,
      deleteLabel: async ({ id }) => demoDeleteLabel(id),
      refetchLabels: deleteRefetch,
      labelsSuccessMessage: 'Label deleted in demo',
      errorMessage: 'Delete failed',
      onError: vi.fn(),
    });

    const labels = getDemoStore().labels;
    expect(labels[created.id]).toBeUndefined();
    expect(deleteRefetch).toHaveBeenCalledTimes(1);
    expect(setDeleteDialogOpen).toHaveBeenCalledWith(false);
    expect(toastSuccessMock).toHaveBeenCalledWith('Label deleted in demo');
    expect(toastPromiseMock).not.toHaveBeenCalled();
  });

  it('routes non-demo sidebar delete through mutation toast flow', async () => {
    const deleteLabelMock = vi.fn(async () => ({ success: true }));
    const setDeleteDialogOpen = vi.fn();
    const deleteRefetch = vi.fn(async () => ({ success: true }));

    await deleteLabelInSidebarContext({
      labelId: 'server-label-id',
      isFrontendOnlyDemoMode: false,
      setDeleteDialogOpen,
      deleteLabel: async ({ id }) => deleteLabelMock(id),
      refetchLabels: deleteRefetch,
      labelsSuccessMessage: 'Label deleted on server',
      errorMessage: 'Delete failed',
      onError: vi.fn(),
    });

    expect(deleteLabelMock).toHaveBeenCalledWith('server-label-id');
    expect(toastPromiseMock).toHaveBeenCalledTimes(1);
    expect(deleteRefetch).toHaveBeenCalledTimes(1);
    expect(setDeleteDialogOpen).toHaveBeenCalledWith(false);
  });

  it('routes general settings save to local persistence in frontend-only demo mode', async () => {
    const currentSettings = {
      language: 'en',
      timezone: 'UTC',
      dynamicContent: false,
      customPrompt: '',
      zeroSignature: true,
      defaultEmailAlias: 'centurion@legacyhotels.co.za',
      animations: false,
      trustedSenders: ['noreply@example.com'],
      externalImages: true,
      autoRead: true,
      undoSendEnabled: false,
      imageCompression: 'medium',
      colorTheme: 'system',
      categories: [],
    } as const;
    const nextValues = {
      ...currentSettings,
      timezone: 'America/New_York',
      customPrompt: 'demo-mode-save',
    } as const;

    const queryDataMock = vi.fn();
    const demoSetSettingsMock = vi.fn(async () => ({ ...currentSettings, ...nextValues }));
    const saveUserSettingsMock = vi.fn(async () => ({ success: true }));
    const refetchSettingsMock = vi.fn(async () => ({ success: true }));

    await handleGeneralSettingsSave({
      values: nextValues as never,
      data: { settings: currentSettings },
      isFrontendOnlyDemo: true,
      queryClient: { setQueryData: queryDataMock },
      saveUserSettings: saveUserSettingsMock,
      demoSetSettings: demoSetSettingsMock,
      refetchSettings: refetchSettingsMock,
      settingsQueryKey: ['settings', 'get'],
    });

    expect(saveUserSettingsMock).not.toHaveBeenCalled();
    expect(demoSetSettingsMock).toHaveBeenCalledWith({ ...currentSettings, ...nextValues });
    expect(queryDataMock).toHaveBeenCalledWith(['demo', 'settings'], expect.any(Function));
    const update = queryDataMock.mock.calls[0]?.[1] as (updater?: { settings?: typeof currentSettings }) => unknown;
    expect(typeof update).toBe('function');
    expect(update({ settings: currentSettings })).toEqual({
      settings: {
        ...currentSettings,
        ...nextValues,
      },
    });
  });

  it('calls backend settings save when demo mode is not active', async () => {
    const currentSettings = {
      language: 'en',
      timezone: 'UTC',
      dynamicContent: false,
      customPrompt: '',
      zeroSignature: true,
      defaultEmailAlias: 'centurion@legacyhotels.co.za',
      animations: false,
      trustedSenders: ['noreply@example.com'],
      externalImages: true,
      autoRead: true,
      undoSendEnabled: false,
      imageCompression: 'medium',
      colorTheme: 'system',
      categories: [],
    } as const;
    const nextValues = {
      ...currentSettings,
      customPrompt: 'backend-save',
    } as const;

    const queryDataMock = vi.fn();
    const demoSetSettingsMock = vi.fn(async () => ({ ...currentSettings, ...nextValues }));
    const saveUserSettingsMock = vi.fn(async () => ({ success: true }));
    const refetchSettingsMock = vi.fn(async () => ({ success: true }));

    const legacySettingsKey = mailSettingsQueryKey({ mode: 'legacy', accountId: null });

    await handleGeneralSettingsSave({
      values: nextValues as never,
      data: { settings: currentSettings },
      isFrontendOnlyDemo: false,
      queryClient: { setQueryData: queryDataMock },
      saveUserSettings: saveUserSettingsMock,
      demoSetSettings: demoSetSettingsMock,
      refetchSettings: refetchSettingsMock,
      settingsQueryKey: legacySettingsKey,
    });

    expect(demoSetSettingsMock).not.toHaveBeenCalled();
    expect(saveUserSettingsMock).toHaveBeenCalledWith(nextValues as never);
    expect(queryDataMock).toHaveBeenCalledWith(legacySettingsKey, expect.any(Function));
    expect(refetchSettingsMock).toHaveBeenCalledTimes(1);
  });

  it('persists trusted sender locally in demo mode instead of backend call', async () => {
    const data = {
      settings: {
        language: 'en',
        timezone: 'UTC',
        dynamicContent: false,
        customPrompt: '',
        zeroSignature: true,
        defaultEmailAlias: 'centurion@legacyhotels.co.za',
        animations: false,
        trustedSenders: [],
        externalImages: true,
        autoRead: true,
        undoSendEnabled: false,
        imageCompression: 'medium',
        colorTheme: 'system',
        categories: [],
      },
    } as const;

    const demoSetSettingsMock = vi.fn(async () => ({ ...data.settings, trustedSenders: ['alice@example.com'] }));
    const saveUserSettingsMock = vi.fn(async () => ({ success: true }));

    const mode = await persistTrustedSender({
      senderEmail: 'alice@example.com',
      data,
      isFrontendOnlyDemo: true,
      saveUserSettings: saveUserSettingsMock as never,
      demoSetSettings: demoSetSettingsMock as never,
    });

    expect(mode).toBe('demo');
    expect(demoSetSettingsMock).toHaveBeenCalledWith({
      ...data.settings,
      trustedSenders: ['alice@example.com'],
    });
    expect(saveUserSettingsMock).not.toHaveBeenCalled();
  });

  it('uses backend trusted sender save path when demo mode is not active', async () => {
    const data = {
      settings: {
        language: 'en',
        timezone: 'UTC',
        dynamicContent: false,
        customPrompt: '',
        zeroSignature: true,
        defaultEmailAlias: 'centurion@legacyhotels.co.za',
        animations: false,
        trustedSenders: ['existing@example.com'],
        externalImages: true,
        autoRead: true,
        undoSendEnabled: false,
        imageCompression: 'medium',
        colorTheme: 'system',
        categories: [],
      },
    } as const;

    const demoSetSettingsMock = vi.fn(async () => ({ ...data.settings, trustedSenders: ['existing@example.com', 'alice@example.com'] }));
    const saveUserSettingsMock = vi.fn(async () => ({ success: true }));

    const mode = await persistTrustedSender({
      senderEmail: 'alice@example.com',
      data,
      isFrontendOnlyDemo: false,
      saveUserSettings: saveUserSettingsMock as never,
      demoSetSettings: demoSetSettingsMock as never,
    });

    expect(mode).toBe('backend');
    expect(saveUserSettingsMock).toHaveBeenCalledWith({
      ...data.settings,
      trustedSenders: ['existing@example.com', 'alice@example.com'],
    } as never);
    expect(demoSetSettingsMock).not.toHaveBeenCalled();
  });

  it('blocks destructive force sync in demo mode and keeps backend no-op', async () => {
    const runForceSyncMock = vi.fn(async () => undefined);
    const blockedToast = vi.fn();

    await runForceSyncAction({
      isFrontendOnlyDemo: true,
      runForceSync: runForceSyncMock,
      onBlocked: blockedToast,
    });

    expect(blockedToast).toHaveBeenCalledTimes(1);
    expect(runForceSyncMock).not.toHaveBeenCalled();
  });

  it('calls backend force sync when demo mode is not active', async () => {
    const runForceSyncMock = vi.fn(async () => ({ success: true }));

    await runForceSyncAction({
      isFrontendOnlyDemo: false,
      runForceSync: runForceSyncMock,
      onBlocked: vi.fn(),
    });

    expect(runForceSyncMock).toHaveBeenCalledTimes(1);
  });

  it('blocks account delete in demo mode and skips backend delete mutation', async () => {
    const deleteAccountMock = vi.fn();
    const onDeleteSuccess = vi.fn();
    const onDeleteError = vi.fn();
    const onSettled = vi.fn();
    const onBlocked = vi.fn();

    const mode = await runDeleteAccount({
      confirmText: 'DELETE',
      isFrontendOnlyDemo: true,
      onBlocked,
      onConfirmError: () => {},
      deleteAccount: deleteAccountMock as never,
      onDeleteSuccess,
      onDeleteError,
      onSettled,
    });

    expect(mode).toBe('blocked');
    expect(onBlocked).toHaveBeenCalledTimes(1);
    expect(deleteAccountMock).not.toHaveBeenCalled();
    expect(onDeleteSuccess).not.toHaveBeenCalled();
    expect(onDeleteError).not.toHaveBeenCalled();
    expect(onSettled).not.toHaveBeenCalled();
  });

  it('invokes backend account delete flow when not in demo mode', async () => {
    const onDeleteSuccess = vi.fn(async () => undefined);
    const onDeleteError = vi.fn();
    const onSettled = vi.fn();

    const deleteAccountMock = vi.fn(async (_input: void, callbacks?: { onSuccess?: (value: { success?: boolean; message?: string }) => Promise<void> | void; onError?: (error: unknown) => void; onSettled?: () => void }) => {
      await callbacks?.onSuccess?.({ success: true, message: 'deleted' } as never);
      callbacks?.onSettled?.();
      return { success: true, message: 'deleted' };
    });

    const mode = await runDeleteAccount({
      confirmText: 'DELETE',
      isFrontendOnlyDemo: false,
      onBlocked: vi.fn(),
      onConfirmError: () => {},
      deleteAccount: deleteAccountMock as never,
      onDeleteSuccess,
      onDeleteError,
      onSettled,
    });

    expect(mode).toBe('backend');
    expect(deleteAccountMock).toHaveBeenCalledTimes(1);
    expect(onDeleteSuccess).toHaveBeenCalledWith({ success: true, message: 'deleted' });
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it('blocks connection disconnect in demo mode and skips backend deletion', async () => {
    const deleteConnectionMock = vi.fn(async () => ({ success: true }));
    const onSuccess = vi.fn();
    const onError = vi.fn();
    const refetchConnections = vi.fn();
    const refetchSession = vi.fn();
    const invalidateThreads = vi.fn();
    const blocked = vi.fn();

    const mode = await runDisconnectConnection({
      connectionId: 'connection-demo',
      isFrontendOnlyDemo: true,
      deleteConnection: deleteConnectionMock as never,
      onBlocked: blocked,
      onSuccess,
      onError,
      refetchConnections,
      refetchSession,
      invalidateThreads,
    });

    expect(mode).toBe('blocked');
    expect(blocked).toHaveBeenCalledTimes(1);
    expect(deleteConnectionMock).not.toHaveBeenCalled();
    expect(refetchConnections).not.toHaveBeenCalled();
    expect(refetchSession).not.toHaveBeenCalled();
    expect(invalidateThreads).not.toHaveBeenCalled();
  });

  it('performs backend connection disconnect when demo mode is not active', async () => {
    const deleteConnectionMock = vi.fn(async () => ({ success: true }));
    const onSuccess = vi.fn();
    const onError = vi.fn();
    const refetchConnections = vi.fn();
    const refetchSession = vi.fn();
    const invalidateThreads = vi.fn();

    const mode = await runDisconnectConnection({
      connectionId: 'connection-live',
      isFrontendOnlyDemo: false,
      deleteConnection: deleteConnectionMock as never,
      onBlocked: vi.fn(),
      onSuccess,
      onError,
      refetchConnections,
      refetchSession,
      invalidateThreads,
    });

    expect(mode).toBe('backend');
    expect(deleteConnectionMock).toHaveBeenCalledWith({ connectionId: 'connection-live' }, expect.objectContaining({ onError }));
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(refetchConnections).toHaveBeenCalledTimes(1);
    expect(refetchSession).toHaveBeenCalledTimes(1);
    expect(invalidateThreads).toHaveBeenCalledTimes(1);
  });

  it('blocks reconnect flow in demo mode for external connection actions', async () => {
    const linkSocial = vi.fn();
    const blocked = vi.fn();

    const mode = await runReconnectConnection({
      isFrontendOnlyDemo: true,
      provider: 'gmail',
      callbackURL: 'https://example.com/settings/connections',
      linkSocial: linkSocial as never,
      onBlocked: blocked,
    });

    expect(mode).toBe('blocked');
    expect(blocked).toHaveBeenCalledTimes(1);
    expect(linkSocial).not.toHaveBeenCalled();
  });

  it('calls backend reconnect flow when demo mode is not active', async () => {
    const linkSocial = vi.fn(async () => ({ success: true }));
    const blocked = vi.fn();

    const mode = await runReconnectConnection({
      isFrontendOnlyDemo: false,
      provider: 'google',
      callbackURL: 'https://example.com/settings/connections',
      linkSocial: linkSocial as never,
      onBlocked: blocked,
    });

    expect(mode).toBe('backend');
    expect(linkSocial).toHaveBeenCalledWith({
      provider: 'google',
      callbackURL: 'https://example.com/settings/connections',
    });
    expect(blocked).not.toHaveBeenCalled();
  });
});
