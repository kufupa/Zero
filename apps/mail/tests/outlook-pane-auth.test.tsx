/**
 * @vitest-environment happy-dom
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import OutlookPanePage from '../app/(routes)/outlook-pane/page';
import { afterEach, describe, it, expect, vi } from 'vitest';

const { signInEmail } = vi.hoisted(() => ({ signInEmail: vi.fn() }));

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
  signIn: { email: signInEmail },
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

  it('keeps the password and toggle usable after a failed sign-in', async () => {
    signInEmail.mockResolvedValueOnce({ error: { message: 'Invalid email or password' } });
    render(<OutlookPanePage />);
    fireEvent.change(screen.getByPlaceholderText('Email'), {
      target: { value: 'staff@example.com' },
    });
    const password = screen.getByPlaceholderText('Password') as HTMLInputElement;
    fireEvent.change(password, { target: { value: 'secret123' } });
    fireEvent.click(screen.getByRole('button', { name: /show password/i }));

    fireEvent.click(screen.getByRole('button', { name: /^sign in$/i }));
    await waitFor(() => expect(signInEmail).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: /^sign in$/i }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );

    expect(password.value).toBe('secret123');
    expect(password.type).toBe('text');
    fireEvent.click(screen.getByRole('button', { name: /hide password/i }));
    expect(password.type).toBe('password');
    expect(screen.getByRole('button', { name: /show password/i })).toBeDefined();
  });
});
