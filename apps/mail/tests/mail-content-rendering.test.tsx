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

beforeEach(() => {
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

  it('keeps light-paper surface styles', async () => {
    renderMailContent();

    await waitFor(() => {
      expect(renderedHost()?.shadowRoot?.querySelector('[data-raw-email="true"]')).not.toBeNull();
    });

    const host = renderedHost();
    expect(host?.style.getPropertyValue('background-color')).toBe('#ffffff');
    expect(host?.style.getPropertyValue('color')).toBe('#000000');
    expect(host?.style.getPropertyValue('color-scheme')).toBe('light');
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
});
