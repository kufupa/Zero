/**
 * @vitest-environment happy-dom
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MailContent } from '../components/mail/mail-content';
import { type ComponentProps } from 'react';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  frontendOnlyDemo: false,
  externalImages: false,
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
        externalImages: mocks.externalImages,
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
  mocks.externalImages = false;
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
      expect(renderedHost()?.shadowRoot?.querySelector('p')?.textContent).toBe('Unprocessed mail');
    });
    expect(mocks.processEmailContent).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(/Unable to load message content safely/i)).toBeNull();
    expect(renderedHost()?.shadowRoot?.innerHTML).not.toContain('<script');
  });

  it('removes executable HTML attributes and URLs before rendering mail in the shadow DOM', async () => {
    renderMailContent({
      html: '<p onclick="window.compromised = true">Visible</p><img src="https://tracker.example/pixel" onerror="window.compromised = true"><a href="javascript:window.compromised = true">Details</a>',
    });

    await waitFor(() => {
      const root = renderedHost()?.shadowRoot;
      expect(root?.querySelector('p')?.textContent).toBe('Visible');
      expect(root?.querySelector('a')?.textContent).toBe('Details');
    });

    const root = renderedHost()?.shadowRoot;
    expect(root?.querySelector('[onclick], [onerror]')).toBeNull();
    expect(root?.querySelector('img')?.getAttribute('src')).not.toBe(
      'https://tracker.example/pixel',
    );
    expect(root?.querySelector('a')?.getAttribute('href') ?? '').not.toMatch(/^javascript:/i);
  });

  it('loads remote email images when the user has explicitly enabled them', async () => {
    mocks.externalImages = true;
    renderMailContent({ html: '<img src="https://images.example/hotel.jpg" alt="Hotel" />' });

    await waitFor(() => {
      expect(renderedHost()?.shadowRoot?.querySelector('img')?.getAttribute('src')).toBe(
        'https://images.example/hotel.jpg',
      );
    });
  });

  it('updates same-ID source HTML without a loading gate', async () => {
    const { queryClient, rerender } = renderMailContent();

    await waitFor(() => {
      expect(renderedHost()?.shadowRoot?.querySelector('p')?.textContent).toBe('Unprocessed mail');
    });

    rerender(
      <QueryClientProvider client={queryClient}>
        <MailContent id="message-42" html={SECOND_RAW_HTML} senderEmail="reader@example.test" />
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(renderedHost()?.shadowRoot?.querySelector('p')?.textContent).toBe('New message');
    });
    expect(screen.queryByRole('status')).toBeNull();
    expect(mocks.processEmailContent).not.toHaveBeenCalled();
  });

  it('paints a theme-following host instead of a light-paper surface', async () => {
    renderMailContent();

    await waitFor(() => {
      expect(renderedHost()?.shadowRoot?.querySelector('p')?.textContent).toBe('Unprocessed mail');
    });

    expectThemeFollowingHost(renderedHost());
  });

  it('renders mail onto a theme-following host in dark mode', async () => {
    themeMocks.resolvedTheme = 'dark';

    renderMailContent({
      html: '<table bgcolor="#FFFFFF"><tr><td><span data-legacy-mail="true">Readable</span></td></tr></table>',
    });

    await waitFor(() => {
      expect(renderedHost()?.shadowRoot?.querySelector('span')?.textContent).toBe('Readable');
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
      expect(renderedHost()?.shadowRoot?.querySelector('p')?.textContent).toBe('Hello');
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
      expect(renderedHost()?.shadowRoot?.querySelector('p')?.textContent).toBe('Hello');
    });
    expect(mocks.processEmailContent).not.toHaveBeenCalled();
  });

  it('injects style tag into shadow root for typography and color protection', async () => {
    renderMailContent({
      html: '<div class="guestrevu-content"><p>Survey feedback</p></div>',
    });

    await waitFor(() => {
      const style = renderedHost()?.shadowRoot?.querySelector('style[data-nava-mail-font="1"]');
      expect(style).not.toBeNull();
      expect(style?.textContent).toContain(':host');
      expect(style?.textContent).toContain('Calibri, Arial, sans-serif');
      expect(style?.textContent).toContain('color: #000000');
    });
  });

  it('keeps frontend-only demo on its local rendering path', async () => {
    mocks.frontendOnlyDemo = true;

    renderMailContent({
      html: '<p data-demo-mail="true">Demo message</p><script>window.bad = true</script>',
    });

    await waitFor(() => {
      expect(renderedHost()?.shadowRoot?.querySelector('p')?.textContent).toBe('Demo message');
    });
    expect(mocks.processEmailContent).not.toHaveBeenCalled();
    expectThemeFollowingHost(renderedHost());
  });
});
