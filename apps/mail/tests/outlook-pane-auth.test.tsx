/**
 * @vitest-environment happy-dom
 */
import { cleanup, render, screen } from '@testing-library/react';
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
});
