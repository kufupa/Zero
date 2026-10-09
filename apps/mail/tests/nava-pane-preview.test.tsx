/**
 * @vitest-environment happy-dom
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaneBridge } from '../lib/workstation/pane-bridge-types';
import { cleanup, render, screen } from '@testing-library/react';
import { NavaPane } from '../components/nava-pane/nava-pane';
import { openPaneMenu, stubResizeObserverForMenus } from './helpers/pane-menu';

beforeAll(stubResizeObserverForMenus);

const { pingMutateMock, sendCommandMock } = vi.hoisted(() => ({
  pingMutateMock: vi.fn().mockResolvedValue({
    status: 'ok',
    serverTime: '2026-10-09T03:00:00.000Z',
  }),
  sendCommandMock: vi.fn().mockResolvedValue({ success: true }),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

vi.mock('../lib/auth-client', () => ({
  useSession: () => ({
    data: {
      user: { id: 'staff-1', email: 'ropperman@legacyhotels.co.za', name: 'R Opperman' },
      session: { id: 'session-1' },
    },
    isLoading: false,
  }),
  signIn: { email: vi.fn() },
}));

vi.mock('../hooks/use-connections', () => ({
  useActiveConnection: () => ({
    data: { id: 'transport-1', email: 'ropperman@legacyhotels.co.za' },
    isLoading: false,
  }),
}));

vi.mock('@/hooks/use-pilot-capabilities', () => ({
  usePilotCapabilities: () => ({ paneSave: false }),
}));

vi.mock('../providers/query-provider', () => ({
  trpcClient: {
    workstation: { ping: { mutate: pingMutateMock } },
    quoteWorkflow: {
      analyseSelection: {
        mutate: async () => ({
          status: 'ready' as const,
          intent: 'quote' as const,
          groups: [],
          secondaryAsks: [],
          alternatives: [],
          sourceRevision: 1,
        }),
      },
    },
  },
}));

const activeEmail = {
  entryId: '001',
  storeId: 'store-1',
  subject: 'Suite Availability Request',
  senderEmail: 'guest@example.com',
  senderName: 'David Miller',
  receivedTime: '2026-09-17T12:00:00Z',
  bodyText: 'CIDB needs 3 rooms for 4 nights.',
  bodyHtml: '<p>CIDB needs 3 rooms for 4 nights.</p>',
};

function bridge(): PaneBridge {
  return {
    isConnected: true,
    workstationInfo: { addinVersion: '1.0.17', bridgeProtocolVersion: 4 },
    capabilities: null,
    updateRequired: false,
    requiresRelogin: false,
    authorizationUnavailable: false,
    selectionOutsideMailbox: false,
    activeEmail,
    supportsAction: () => true,
    sendCommand: sendCommandMock,
    pairDevice: vi.fn(),
    refreshAuthorization: vi.fn(),
    activateMailboxSync: vi.fn(),
  } as unknown as PaneBridge;
}

describe('NavaPane preview mode', () => {
  beforeEach(() => {
    localStorage.clear();
    pingMutateMock.mockClear();
    sendCommandMock.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  it('starts on the quoting tool with fresh storage, with no onboarding and no automatic ping', async () => {
    render(<NavaPane bridge={bridge()} preview />);
    expect(screen.queryByText(/Welcome to Nava/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /Confirm Account & Connect/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /1\. Welcome/i })).toBeNull();
    await openPaneMenu();
    expect(await screen.findByRole('menuitem', { name: /Run system check/i })).toBeDefined();
    expect(pingMutateMock).not.toHaveBeenCalled();
  });

  it('keeps the onboarding start for Outlook when preview is not set', () => {
    render(<NavaPane bridge={bridge()} />);
    expect(screen.getByText(/Welcome to Nava/i)).toBeDefined();
    expect(screen.getByRole('button', { name: /Confirm Account & Connect/i })).toBeDefined();
  });
});
