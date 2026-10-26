/**
 * @vitest-environment happy-dom
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import OutlookPanePage from '../app/(routes)/outlook-pane/page';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

vi.mock('../lib/workstation/use-outlook-bridge', () => ({
  useOutlookBridge: () => ({
    isConnected: true,
    workstationInfo: {
      addinVersion: '1.0.12',
      bridgeProtocolVersion: 4,
      paired: true,
      outlookVersion: '16.0',
    },
    capabilities: {
      bridgeProtocolVersion: 4,
      supportedActions: ['CREATE_REPLY_DRAFT', 'ADD_ATTACHMENT_TO_DRAFT', 'GET_ACTIVE_EMAIL'],
    },
    supportsAction: (action: string) =>
      action === 'CREATE_REPLY_DRAFT' || action === 'ADD_ATTACHMENT_TO_DRAFT',
    activeEmail: {
      entryId: '001',
      storeId: 'store-1',
      folderEntryId: 'folder-inbox',
      subject: 'Suite Availability Request',
      senderEmail: 'guest@example.com',
      senderName: 'David Miller',
      receivedTime: '2026-09-17T12:00:00Z',
      bodyText: 'CIDB needs 3 rooms for 4 nights.',
      bodyHtml: '<p>We need 3 rooms for 4 nights.</p>',
    },
    sendCommand: vi.fn(),
    pairDevice: vi.fn(),
  }),
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
    data: { id: 'transport-1', email: 'centurion@legacyhotels.co.za' },
    isLoading: false,
  }),
}));

// The amend panel reads the pilot capabilities hook; the pane default is paneSave off.
vi.mock('@/hooks/use-pilot-capabilities', () => ({
  usePilotCapabilities: () => ({ paneSave: false }),
}));

vi.mock('../providers/query-provider', () => ({
  trpcClient: {
    workstation: {
      ping: { mutate: vi.fn().mockResolvedValue({ status: 'ok' }) },
      quoteProposalPdf: { mutate: vi.fn() },
    },
    quoteWorkflow: {
      // 12f451bd6 (#536) loads mailbox pane choices via rateCatalogue.query on mount.
      rateCatalogue: {
        query: async () => ({
          transportId: 'transport-1',
          propertyCode: 'HRCEN',
          roomTypes: [],
          ratePlans: [],
          boards: [],
          overrideRateCodes: [],
          eventRateCodes: [],
        }),
      },
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
              fields: { arrivalDate: 'missing' as const, departureDate: 'missing' as const, adults: 'missing' as const },
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

describe('mounted Outlook pane quoting path at 380px', () => {
  beforeEach(() => {
    localStorage.setItem('nava_onboarding_completed', 'true');
  });
  afterEach(() => cleanup());

  it('has no September RATE_TABLE search UI and does not synthesize HITL money', async () => {
    const { container } = render(
      <div id="mounted-outlook-pane" style={{ width: 380, maxWidth: 380 }}>
        <OutlookPanePage />
      </div>,
    );
    expect(container.querySelector('#mounted-outlook-pane')).not.toBeNull();
    expect(screen.queryByText(/September 2026/i)).toBeNull();
    expect(screen.queryByText(/^Change Dates$/)).toBeNull();
    expect(screen.queryByText(/NCOR1B/i)).toBeNull();
    expect(screen.queryByText(/R2,150\.00/)).toBeNull();
    // The HMS search button is now "Search availability" (the old Get rates button). Exactly one, no second search UI.
    expect(screen.getAllByRole('button', { name: /^Search availability$/i })).toHaveLength(1);
    expect(await screen.findByRole('button', { name: /^Search availability$/i })).toBeDefined();

    // Get rates waits for a room type on every row; the email gave none.
    fireEvent.change(screen.getByLabelText('Room type'), { target: { value: 'STQN' } });
    fireEvent.click(screen.getByRole('button', { name: /^Search availability$/i }));
    // The rebuilt stay gate checks dates before the search runs, so Search stays off and shows this reason.
    await waitFor(() => {
      expect(screen.getAllByText(/not available here|no room options|not owned by this quoting UI|not ready yet|not connected to this pane|Add arrival and departure dates first/i).length).toBeGreaterThan(0);
    });
    expect(screen.queryByText(/Allocation/)).toBeNull();
    expect(screen.getByRole('button', { name: /Draft quotation into email reply/i })).toBeDefined();
    expect(screen.queryByText(/September 2026/i)).toBeNull();
    expect(screen.queryByText(/NCOR1B/i)).toBeNull();

    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"/><title>Mounted OutlookPanePage 380px</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; }
  #mounted-outlook-pane { width: 380px; max-width: 380px; }
</style></head><body>${container.innerHTML}</body></html>`;
    const outDir = path.join(process.cwd(), 'tests', 'browser-quote-workflow');
    mkdirSync(outDir, { recursive: true });
    writeFileSync(path.join(outDir, 'mounted-pane.html'), html);
    expect(html).not.toMatch(/September 2026/);
    expect(html).not.toMatch(/NCOR1B/);
  });
});
