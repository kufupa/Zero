/** @vitest-environment happy-dom */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaneBridge } from '@/lib/workstation/pane-bridge-types';
import type { WorkstationEmailPayload } from '@/lib/workstation/bridge-protocol';
import { stubResizeObserverForMenus } from './helpers/pane-menu';
import OutlookPanePage from '../app/(routes)/outlook-pane/page';
import { WebPanePanel } from '@/components/nava-pane/web-pane-panel';

const state = vi.hoisted(() => ({ bridge: null as PaneBridge | null }));
vi.mock('@/lib/workstation/use-outlook-bridge', () => ({
  useOutlookBridge: () => state.bridge, reportBridgeFailure: vi.fn(),
}));
vi.mock('@/lib/workstation/web-pane-bridge', () => ({
  PREVIEW_ONLY_MESSAGE: 'Preview only: copy the reply or download the PDF.',
  useWebPreview: () => ({ selection: { status: 'ready', email: state.bridge?.activeEmail }, bridge: state.bridge }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock('@/lib/auth-client', () => ({
  useSession: () => ({ data: { user: { id: 'staff-1' }, session: { id: 'session-1' } }, isLoading: false }),
  signIn: { email: vi.fn() },
}));
vi.mock('@/hooks/use-connections', () => ({
  useActiveConnection: () => ({ data: { id: 'transport-1', email: 'staff@example.test' }, isLoading: false }),
}));
vi.mock('@/hooks/use-pilot-capabilities', () => ({ usePilotCapabilities: () => ({ paneSave: false }) }));
vi.mock('@/providers/query-provider', () => ({ trpcClient: {
  workstation: { ping: { mutate: vi.fn() } },
  quoteWorkflow: { analyseSelection: { mutate: async () => ({ status: 'ready', intent: 'quote', groups: [],
    secondaryAsks: [], alternatives: [], sourceRevision: 1 }) } },
} }));

beforeAll(stubResizeObserverForMenus);
beforeEach(() => { localStorage.clear(); localStorage.setItem('nava_onboarding_completed', 'true'); });
afterEach(() => { cleanup(); localStorage.clear(); state.bridge = null; });

const email = (entryId: string, storeId: string): WorkstationEmailPayload => ({
  entryId, storeId, internetMessageId: `<${entryId}@example.test>`, subject: 'Same subject',
  senderEmail: 'guest@example.test', senderName: 'Guest', receivedTime: '2026-11-02T10:00:00Z',
  bodyText: 'Example', bodyHtml: '<p>Example</p>',
});
function bridge(activeEmail: WorkstationEmailPayload): PaneBridge {
  return {
    isConnected: true, workstationInfo: { addinVersion: '1.0.17', bridgeProtocolVersion: 4 },
    capabilities: null, updateRequired: false, requiresRelogin: false, authorizationUnavailable: false,
    selectionOutsideMailbox: false, activeEmail, supportsAction: () => false,
    sendCommand: vi.fn().mockResolvedValue(null), pairDevice: vi.fn(), refreshAuthorization: vi.fn(),
    activateMailboxSync: vi.fn(),
  } as unknown as PaneBridge;
}
function expectIdentity(entryId: string, storeId: string) {
  const selection = screen.getByRole('region', { name: 'Selected email' });
  expect(selection.getAttribute('data-nava-entry-id')).toBe(entryId);
  expect(selection.getAttribute('data-nava-store-id')).toBe(storeId);
  expect(selection.getAttribute('data-nava-internet-message-id')).toBe(`<${entryId}@example.test>`);
}

describe('rendered identity through both pane surfaces', () => {
  it('updates Outlook selection without using subject as identity', () => {
    state.bridge = bridge(email('native-A', 'native-store'));
    const pane = render(<OutlookPanePage />);
    expectIdentity('native-A', 'native-store');
    state.bridge = bridge(email('native-B', 'native-store'));
    pane.rerender(<OutlookPanePage />);
    expectIdentity('native-B', 'native-store');
  });

  it('updates webmail selection without mixing its namespace with Outlook', () => {
    state.bridge = bridge(email('row-A', 'web-mailbox'));
    const pane = render(<WebPanePanel threadId="thread" />);
    expectIdentity('row-A', 'web-mailbox');
    state.bridge = bridge(email('row-B', 'web-mailbox'));
    pane.rerender(<WebPanePanel threadId="thread" />);
    expectIdentity('row-B', 'web-mailbox');
  });
});
