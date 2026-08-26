/**
 * @vitest-environment happy-dom
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { act, type ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MailContent } from '../components/mail/mail-content';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  frontendOnlyDemo: false,
  processEmailContent: vi.fn(),
  saveUserSettings: vi.fn(),
  refetchSettings: vi.fn(),
}));

const themeMocks = vi.hoisted(() => ({
  resolvedTheme: 'light' as 'light' | 'dark' | undefined,
}));

vi.mock('next-themes', () => ({
  useTheme: () => ({ resolvedTheme: themeMocks.resolvedTheme }),
}));

vi.mock('@/hooks/use-settings', () => ({
  useSettings: () => ({
    data: {
      settings: {
        externalImages: false,
        trustedSenders: [],
      },
    },
    refetch: mocks.refetchSettings,
  }),
}));

vi.mock('@/lib/demo/runtime', () => ({
  isFrontendOnlyDemo: () => mocks.frontendOnlyDemo,
}));

vi.mock('@/paraglide/messages', () => ({
  m: new Proxy(
    {},
    {
      get: () => () => '',
    },
  ),
}));

vi.mock('@/providers/query-provider', () => ({
  useTRPC: () => ({
    mail: {
      processEmailContent: {
        mutationOptions: () => ({
          mutationFn: mocks.processEmailContent,
        }),
      },
    },
    settings: {
      save: {
        mutationOptions: () => ({
          mutationFn: mocks.saveUserSettings,
        }),
      },
    },
  }),
}));

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
  },
}));

const RAW_HTML = '<p data-raw-email="true">Unprocessed mail</p><script>window.bad = true</script>';
const SECOND_RAW_HTML = '<p data-second-raw-email="true">New message</p>';
const PROCESSED_HTML = '<p data-processed-email="true">Processed message</p>';
const SECOND_PROCESSED_HTML =
  '<p data-second-processed-email="true">Updated processed message</p>';

type ProcessedResult = {
  processedHtml: string;
  hasBlockedImages: boolean;
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, resolve, reject };
}

const queryClients: QueryClient[] = [];

function renderMailContent(props: Partial<ComponentProps<typeof MailContent>> = {}) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: 1,
        retryDelay: 250,
      },
    },
  });
  queryClients.push(queryClient);

  const renderResult = render(
    <QueryClientProvider client={queryClient}>
      <MailContent id="message-42" html={RAW_HTML} senderEmail="reader@example.test" {...props} />
    </QueryClientProvider>,
  );

  return { ...renderResult, queryClient };
}

function renderedHost() {
  return document.querySelector<HTMLElement>('.mail-content');
}

async function waitForProcessingCallCount(count: number) {
  await waitFor(() => {
    expect(mocks.processEmailContent).toHaveBeenCalledTimes(count);
  });
}

beforeEach(() => {
  themeMocks.resolvedTheme = 'light';
  mocks.frontendOnlyDemo = false;
  mocks.processEmailContent.mockReset();
  mocks.saveUserSettings.mockReset();
  mocks.refetchSettings.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  for (const queryClient of queryClients) queryClient.clear();
  queryClients.length = 0;
});

describe('MailContent processing states', () => {
  it('announces pending processing without mounting a Shadow DOM host', () => {
    const pending = deferred<ProcessedResult>();
    mocks.processEmailContent.mockReturnValue(pending.promise);

    renderMailContent();

    expect(screen.getByRole('status').textContent).toContain('Loading message content');
    expect(renderedHost()).toBeNull();
    expect(document.body.innerHTML).not.toContain('data-raw-email');
  });

  it('does not automatically retry after the delayed default retry window', async () => {
    mocks.processEmailContent.mockRejectedValue(new Error('processing failed'));

    renderMailContent();
    await waitForProcessingCallCount(1);
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(mocks.processEmailContent).toHaveBeenCalledTimes(1);
  });

  it('requires manual retry before mounting only processed HTML', async () => {
    const initialRequest = deferred<ProcessedResult>();
    const retryRequest = deferred<ProcessedResult>();
    mocks.processEmailContent
      .mockReturnValueOnce(initialRequest.promise)
      .mockReturnValueOnce(retryRequest.promise);

    renderMailContent();
    await waitForProcessingCallCount(1);

    await act(async () => {
      initialRequest.reject(new Error('backend details must stay hidden'));
      await Promise.resolve();
    });

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Unable to load message content safely');
    expect(alert.textContent).not.toContain('backend details');
    expect(mocks.processEmailContent).toHaveBeenCalledTimes(1);
    expect(renderedHost()).toBeNull();

    const retryButton = screen.getByRole('button', { name: 'Retry message content' });
    if (!(retryButton instanceof HTMLButtonElement)) {
      throw new Error('Retry message content must be a button');
    }
    retryButton.focus();
    fireEvent.click(retryButton);
    await waitForProcessingCallCount(2);

    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toContain('Retrying message content');
      expect(retryButton.disabled).toBe(true);
      expect(retryButton.getAttribute('aria-busy')).toBe('true');
      expect(renderedHost()).toBeNull();
    });
    expect(document.activeElement).toBe(retryButton);
    expect(mocks.processEmailContent).toHaveBeenNthCalledWith(2, {
      html: RAW_HTML,
      messageId: 'message-42',
      shouldLoadImages: false,
      theme: 'light',
    });

    await act(async () => {
      retryRequest.resolve({
        processedHtml: PROCESSED_HTML,
        hasBlockedImages: false,
      });
      await Promise.resolve();
    });

    await waitFor(() => {
      const host = renderedHost();
      expect(host?.shadowRoot?.querySelector('[data-processed-email="true"]')?.textContent).toBe(
        'Processed message',
      );
    });
    expect(renderedHost()?.shadowRoot?.innerHTML).not.toContain('data-raw-email');
  });

  it('moves focus to message content after a manual retry succeeds', async () => {
    const initialRequest = deferred<ProcessedResult>();
    const retryRequest = deferred<ProcessedResult>();
    mocks.processEmailContent
      .mockReturnValueOnce(initialRequest.promise)
      .mockReturnValueOnce(retryRequest.promise);

    renderMailContent();
    await waitForProcessingCallCount(1);

    await act(async () => {
      initialRequest.reject(new Error('processing failed'));
      await Promise.resolve();
    });

    const retryButton = await screen.findByRole('button', { name: 'Retry message content' });
    retryButton.focus();
    fireEvent.click(retryButton);
    await waitForProcessingCallCount(2);

    await act(async () => {
      retryRequest.resolve({
        processedHtml: PROCESSED_HTML,
        hasBlockedImages: false,
      });
      await Promise.resolve();
    });

    await waitFor(() => {
      const host = renderedHost();
      expect(host?.shadowRoot?.querySelector('[data-processed-email="true"]')).not.toBeNull();
      expect(document.activeElement).toBe(host);
      expect(document.activeElement).not.toBe(document.body);
      expect(document.activeElement).not.toBe(retryButton);
    });
  });

  it('does not steal focus when a user leaves a successful manual retry', async () => {
    const initialRequest = deferred<ProcessedResult>();
    const retryRequest = deferred<ProcessedResult>();
    mocks.processEmailContent
      .mockReturnValueOnce(initialRequest.promise)
      .mockReturnValueOnce(retryRequest.promise);
    const externalControl = document.createElement('button');
    document.body.appendChild(externalControl);

    try {
      renderMailContent();
      await waitForProcessingCallCount(1);

      await act(async () => {
        initialRequest.reject(new Error('processing failed'));
        await Promise.resolve();
      });

      fireEvent.click(await screen.findByRole('button', { name: 'Retry message content' }));
      await waitForProcessingCallCount(2);
      externalControl.focus();

      await act(async () => {
        retryRequest.resolve({
          processedHtml: PROCESSED_HTML,
          hasBlockedImages: false,
        });
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(renderedHost()?.shadowRoot?.querySelector('[data-processed-email="true"]')).not.toBeNull();
      });
      expect(document.activeElement).toBe(externalControl);
    } finally {
      externalControl.remove();
    }
  });

  it('does not move focus after a failed manual retry when the same message reprocesses', async () => {
    const initialRequest = deferred<ProcessedResult>();
    const failedRetry = deferred<ProcessedResult>();
    mocks.processEmailContent
      .mockReturnValueOnce(initialRequest.promise)
      .mockReturnValueOnce(failedRetry.promise)
      .mockResolvedValueOnce({
        processedHtml: PROCESSED_HTML,
        hasBlockedImages: false,
      });

    const { queryClient, rerender } = renderMailContent();
    await waitForProcessingCallCount(1);

    await act(async () => {
      initialRequest.reject(new Error('initial processing failed'));
      await Promise.resolve();
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Retry message content' }));
    await waitForProcessingCallCount(2);

    await act(async () => {
      failedRetry.reject(new Error('manual retry failed'));
      await Promise.resolve();
    });
    await screen.findByRole('alert');

    const externalControl = document.createElement('button');
    externalControl.setAttribute('data-external-focus', 'true');
    document.body.appendChild(externalControl);
    externalControl.focus();

    rerender(
      <QueryClientProvider client={queryClient}>
        <MailContent id="message-42" html={SECOND_RAW_HTML} senderEmail="reader@example.test" />
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(renderedHost()?.shadowRoot?.querySelector('[data-processed-email="true"]')).not.toBeNull();
      expect(mocks.processEmailContent).toHaveBeenCalledTimes(3);
    });
    expect(document.activeElement).toBe(externalControl);
    externalControl.remove();
  });

  it('does not move focus on an ordinary initial success', async () => {
    const initialRequest = deferred<ProcessedResult>();
    mocks.processEmailContent.mockReturnValue(initialRequest.promise);
    const priorFocus = document.createElement('button');
    document.body.appendChild(priorFocus);
    priorFocus.focus();

    renderMailContent();
    await waitForProcessingCallCount(1);

    await act(async () => {
      initialRequest.resolve({
        processedHtml: PROCESSED_HTML,
        hasBlockedImages: false,
      });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(renderedHost()?.shadowRoot?.querySelector('[data-processed-email="true"]')).not.toBeNull();
    });
    expect(document.activeElement).toBe(priorFocus);
    priorFocus.remove();
  });

  it('reprocesses when a message keeps its ID but receives new source HTML', async () => {
    const nextRequest = deferred<ProcessedResult>();
    mocks.processEmailContent
      .mockResolvedValueOnce({
        processedHtml: PROCESSED_HTML,
        hasBlockedImages: false,
      })
      .mockReturnValueOnce(nextRequest.promise);

    const { queryClient, rerender } = renderMailContent();

    await waitFor(() => {
      expect(renderedHost()?.shadowRoot?.querySelector('[data-processed-email="true"]')).not.toBeNull();
    });

    rerender(
      <QueryClientProvider client={queryClient}>
        <MailContent id="message-42" html={SECOND_RAW_HTML} senderEmail="reader@example.test" />
      </QueryClientProvider>,
    );

    expect(screen.getByRole('status').textContent).toContain('Loading message content');
    expect(renderedHost()).toBeNull();
    await waitFor(() => {
      expect(mocks.processEmailContent).toHaveBeenNthCalledWith(2, {
        html: SECOND_RAW_HTML,
        messageId: 'message-42',
        shouldLoadImages: false,
        theme: 'light',
      });
    });

    const processedContentQueries = queryClient
      .getQueryCache()
      .getAll()
      .filter(
        (query) =>
          query.queryKey[0] === 'email-content-v3' &&
          query.queryKey[1] === 'message-42' &&
          typeof query.queryKey[2] === 'string',
      );
    expect(processedContentQueries).toHaveLength(2);
    for (const query of processedContentQueries) {
      expect(query.queryKey).toEqual([
        'email-content-v3',
        'message-42',
        expect.any(String),
        false,
        'light',
      ]);
    }
    const contentDigests = processedContentQueries.map((query) => query.queryKey[2]);
    expect(new Set(contentDigests).size).toBe(2);
    expect(contentDigests).not.toContain(RAW_HTML);
    expect(contentDigests).not.toContain(SECOND_RAW_HTML);
  });

  it('shows updated same-ID source while a stale manual retry remains pending', async () => {
    const initialRequest = deferred<ProcessedResult>();
    const staleRetry = deferred<ProcessedResult>();
    mocks.processEmailContent
      .mockReturnValueOnce(initialRequest.promise)
      .mockReturnValueOnce(staleRetry.promise)
      .mockResolvedValueOnce({
        processedHtml: SECOND_PROCESSED_HTML,
        hasBlockedImages: false,
      });

    const { queryClient, rerender } = renderMailContent();
    await waitForProcessingCallCount(1);

    await act(async () => {
      initialRequest.reject(new Error('initial processing failed'));
      await Promise.resolve();
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Retry message content' }));
    await waitForProcessingCallCount(2);

    rerender(
      <QueryClientProvider client={queryClient}>
        <MailContent id="message-42" html={SECOND_RAW_HTML} senderEmail="reader@example.test" />
      </QueryClientProvider>,
    );

    await waitForProcessingCallCount(3);
    await waitFor(() => {
      expect(
        renderedHost()?.shadowRoot?.querySelector('[data-second-processed-email="true"]')?.textContent,
      ).toBe('Updated processed message');
    });
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('withholds prior message output while a new message starts processing', async () => {
    const nextRequest = deferred<ProcessedResult>();
    mocks.processEmailContent
      .mockResolvedValueOnce({
        processedHtml: PROCESSED_HTML,
        hasBlockedImages: false,
      })
      .mockReturnValueOnce(nextRequest.promise);

    const { queryClient, rerender } = renderMailContent();

    await waitFor(() => {
      expect(renderedHost()?.shadowRoot?.innerHTML).toContain('data-processed-email');
    });

    rerender(
      <QueryClientProvider client={queryClient}>
        <MailContent id="message-43" html={SECOND_RAW_HTML} senderEmail="reader@example.test" />
      </QueryClientProvider>,
    );

    expect(screen.getByRole('status').textContent).toContain('Loading message content');
    expect(renderedHost()).toBeNull();
  });

  it('does not carry a previous failure into the next message', async () => {
    const firstRequest = deferred<ProcessedResult>();
    const nextRequest = deferred<ProcessedResult>();
    mocks.processEmailContent
      .mockReturnValueOnce(firstRequest.promise)
      .mockReturnValueOnce(nextRequest.promise);

    const { queryClient, rerender } = renderMailContent();
    await waitForProcessingCallCount(1);

    await act(async () => {
      firstRequest.reject(new Error('processing failed'));
      await Promise.resolve();
    });
    await screen.findByRole('alert');

    rerender(
      <QueryClientProvider client={queryClient}>
        <MailContent id="message-43" html={SECOND_RAW_HTML} senderEmail="reader@example.test" />
      </QueryClientProvider>,
    );

    expect(screen.getByRole('status').textContent).toContain('Loading message content');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(renderedHost()).toBeNull();
  });

  it('processes mail onto a theme-following host in dark mode', async () => {
    themeMocks.resolvedTheme = 'dark';
    mocks.processEmailContent.mockResolvedValue({
      processedHtml:
        '<table bgcolor="#FFFFFF"><tr><td><span data-legacy-mail="true">Readable</span></td></tr></table>',
      hasBlockedImages: false,
    });

    renderMailContent();

    await waitFor(() => {
      expect(mocks.processEmailContent).toHaveBeenCalledWith({
        html: RAW_HTML,
        messageId: 'message-42',
        shouldLoadImages: false,
        theme: 'dark',
      });
      expect(renderedHost()?.shadowRoot?.querySelector('[data-legacy-mail="true"]')?.textContent).toBe(
        'Readable',
      );
    });

    const host = renderedHost();
    expect(host?.className).toContain('bg-background');
    expect(host?.className).toContain('text-foreground');
    expect(host?.className).not.toContain('dark:text-white');
    expect(host?.style.getPropertyValue('background-color')).not.toBe('#ffffff');
    expect(host?.style.getPropertyValue('color')).not.toBe('#000000');
    expect(host?.style.getPropertyValue('color-scheme')).toBe('');
    expect(host?.style.getPropertyValue('forced-color-adjust')).toBe('');
  });

  it('keeps frontend-only demo on its local rendering path', async () => {
    mocks.frontendOnlyDemo = true;

    renderMailContent({
      html: '<p data-demo-mail="true">Demo message</p><script>window.bad = true</script>',
    });

    await waitFor(() => {
      expect(renderedHost()?.shadowRoot?.querySelector('[data-demo-mail="true"]')?.textContent).toBe(
        'Demo message',
      );
    });
    expect(mocks.processEmailContent).not.toHaveBeenCalled();
    expect(renderedHost()?.className).toContain('bg-background');
    expect(renderedHost()?.className).toContain('text-foreground');
    expect(renderedHost()?.style.getPropertyValue('background-color')).not.toBe('#ffffff');
    expect(renderedHost()?.style.getPropertyValue('color')).not.toBe('#000000');
    expect(renderedHost()?.style.getPropertyValue('color-scheme')).toBe('');
  });
});
