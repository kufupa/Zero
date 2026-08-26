/**
 * @vitest-environment happy-dom
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { type ComponentProps } from 'react';
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

function expectThemeFollowingHost(host: HTMLElement | null) {
  expect(host?.className).toContain('bg-background');
  expect(host?.className).toContain('text-foreground');
  expect(host?.className).not.toContain('dark:text-white');
  expect(host?.style.getPropertyValue('background-color')).not.toBe('#ffffff');
  expect(host?.style.getPropertyValue('color')).not.toBe('#000000');
  expect(host?.style.getPropertyValue('color-scheme')).toBe('');
  expect(host?.style.getPropertyValue('forced-color-adjust')).toBe('');
}

beforeEach(() => {
  themeMocks.resolvedTheme = 'light';
  mocks.frontendOnlyDemo = false;
  mocks.processEmailContent.mockReset();
  mocks.saveUserSettings.mockReset();
  mocks.refetchSettings.mockReset();
});

afterEach(() => {
  cleanup();
  for (const queryClient of queryClients) queryClient.clear();
  queryClients.length = 0;
});

describe('MailContent client fallback hotfix', () => {
  it('renders client-resolved raw HTML without calling processEmailContent', async () => {
    renderMailContent();

    await waitFor(() => {
      expect(renderedHost()?.shadowRoot?.querySelector('[data-raw-email="true"]')?.textContent).toBe(
        'Unprocessed mail',
      );
    });
    expect(mocks.processEmailContent).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(/Unable to load message content safely/i)).toBeNull();
    expect(renderedHost()?.shadowRoot?.innerHTML).not.toContain('<script');
  });

  it('updates same-ID source HTML without a loading gate', async () => {
    const { queryClient, rerender } = renderMailContent();

    await waitFor(() => {
      expect(renderedHost()?.shadowRoot?.querySelector('[data-raw-email="true"]')).not.toBeNull();
    });

    rerender(
      <QueryClientProvider client={queryClient}>
        <MailContent id="message-42" html={SECOND_RAW_HTML} senderEmail="reader@example.test" />
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(
        renderedHost()?.shadowRoot?.querySelector('[data-second-raw-email="true"]')?.textContent,
      ).toBe('New message');
    });
    expect(screen.queryByRole('status')).toBeNull();
    expect(mocks.processEmailContent).not.toHaveBeenCalled();
  });

  it('paints a theme-following host instead of a light-paper surface', async () => {
    renderMailContent();

    await waitFor(() => {
      expect(renderedHost()?.shadowRoot?.querySelector('[data-raw-email="true"]')).not.toBeNull();
    });

    expectThemeFollowingHost(renderedHost());
  });

  it('renders mail onto a theme-following host in dark mode', async () => {
    themeMocks.resolvedTheme = 'dark';

    renderMailContent({
      html: '<table bgcolor="#FFFFFF"><tr><td><span data-legacy-mail="true">Readable</span></td></tr></table>',
    });

    await waitFor(() => {
      expect(renderedHost()?.shadowRoot?.querySelector('[data-legacy-mail="true"]')?.textContent).toBe(
        'Readable',
      );
    });

    expect(mocks.processEmailContent).not.toHaveBeenCalled();
    expectThemeFollowingHost(renderedHost());
    expect(renderedHost()?.shadowRoot?.innerHTML).toContain('data-nava-mail-paper');
  });

  it('prepends paper neutralize CSS in dark theme and rewrites shadow when theme flips', async () => {
    const { queryClient, rerender } = renderMailContent({
      html: '<p data-plain-mail="true">Hello</p>',
    });
    await waitFor(() => {
      expect(renderedHost()?.shadowRoot?.querySelector('[data-plain-mail="true"]')?.textContent).toBe(
        'Hello',
      );
    });
    expect(renderedHost()?.shadowRoot?.innerHTML).not.toContain('data-nava-mail-paper');

    themeMocks.resolvedTheme = 'dark';
    rerender(
      <QueryClientProvider client={queryClient}>
        <MailContent
          id="message-42"
          html={'<p data-plain-mail="true">Hello</p>'}
          senderEmail="reader@example.test"
        />
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(renderedHost()?.shadowRoot?.innerHTML).toContain('data-nava-mail-paper');
      expect(renderedHost()?.shadowRoot?.querySelector('[data-plain-mail="true"]')?.textContent).toBe(
        'Hello',
      );
    });
    expect(mocks.processEmailContent).not.toHaveBeenCalled();
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
    expectThemeFollowingHost(renderedHost());
  });
});
