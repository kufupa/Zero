/**
 * @vitest-environment happy-dom
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import OutlookPanePage from '../app/(routes)/outlook-pane/page';
import { afterEach, describe, it, expect, vi } from 'vitest';

vi.mock('../lib/workstation/use-outlook-bridge', () => ({
  useOutlookBridge: () => ({
    isConnected: false,
    workstationInfo: null,
    activeEmail: null,
    sendCommand: vi.fn(),
  }),
}));

vi.mock('../lib/auth-client', () => ({
  useSession: () => ({
    data: null,
    isLoading: false,
  }),
  signIn: { email: vi.fn() },
}));

vi.mock('../hooks/use-connections', () => ({
  useActiveConnection: () => ({ data: null, isLoading: false }),
}));

vi.mock('../providers/query-provider', () => ({
  trpcClient: {
    workstation: {
      ping: { mutate: vi.fn() },
      quoteProposalPdf: { mutate: vi.fn() },
    },
    quoteWorkflow: {
      analyseSelection: {
        mutate: async () => ({
          status: 'ready' as const,
          intent: 'quote' as const,
          groups: [
            {
              id: 'g1',
              childrenAges: [],
              board: 'unknown' as const,
              quantity: 1,
              specialRequests: [],
              fields: {
                arrivalDate: 'missing' as const,
                departureDate: 'missing' as const,
                adults: 'missing' as const,
              },
            },
          ],
          secondaryAsks: [],
          alternatives: [],
          sourceRevision: 1,
        }),
      },
    },
  },
}));

describe('OutlookPanePage unauthenticated', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders compact pane sign-in instead of the mail inbox login page', () => {
    render(<OutlookPanePage />);
    expect(screen.getByText(/Nava Assistant Sign In/i)).toBeDefined();
    expect(screen.getByRole('button', { name: /sign in/i })).toBeDefined();
    expect(screen.queryByText(/Login with Nava/i)).toBeNull();
    expect(screen.queryByText(/Nava AI Reservationist/i)).toBeNull();
  });

  it('uses the light pane shell from the side-pane design', () => {
    const { container } = render(<OutlookPanePage />);
    const shell = container.firstElementChild as HTMLElement;
    expect(shell.className).toContain('bg-[#f1f3f6]');
    expect(shell.className).not.toContain('bg-slate-950');
  });

  it('keeps an app-owned show-password toggle after typing and blur', () => {
    render(<OutlookPanePage />);
    const password = screen.getByPlaceholderText('Password') as HTMLInputElement;
    expect(password.type).toBe('password');
    expect(password.className).toContain('[&::-ms-reveal]:hidden');

    fireEvent.change(password, { target: { value: 'secret123' } });
    fireEvent.blur(password);

    const show = screen.getByRole('button', { name: /show password/i });
    expect(show.getAttribute('type')).toBe('button');
    fireEvent.click(show);
    expect(password.type).toBe('text');

    fireEvent.click(screen.getByRole('button', { name: /hide password/i }));
    expect(password.type).toBe('password');
  });
});
