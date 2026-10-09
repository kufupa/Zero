/**
 * @vitest-environment happy-dom
 */
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { NavaPane } from '../components/nava-pane/nava-pane';
import type { PaneBridge } from '../lib/workstation/pane-bridge-types';
import { AUTHORISED_QUOTE_OFFERS, AUTHORISED_QUOTE_PDF, AUTHORISED_REPLY_HTML } from './helpers/authorised-quote-evidence';

// State the mocks below read. Defaults match outlook-pane-render.test.tsx.
const { quotePdfMutate, sendCommandMock, bridgeMockState } = vi.hoisted(() => ({
  quotePdfMutate: vi.fn().mockResolvedValue({
    fileName: 'Quote - CIDB 15-17 Sep.pdf',
    pdfBase64: 'JVBERw==',
  }),
  sendCommandMock: vi.fn(async (action: string): Promise<unknown> => {
    if (action === 'GET_ACTIVE_EMAIL') return { entryId: '001', storeId: 'store-1', folderEntryId: 'folder-inbox' };
    if (action === 'ADD_ATTACHMENT_TO_DRAFT') return { attached: true };
    return {
      entryId: 'draft-default',
      storeId: 'store-1',
      folderEntryId: 'folder-drafts',
      folderName: 'Drafts',
      displayed: true,
    };
  }),
  bridgeMockState: {
    userId: 'staff-1',
    sessionId: 'session-1',
    transportId: 'transport-1',
    holdStaffQuote: false,
    releaseStaffQuote: null as null | (() => void),
    hmsQueueStatus: null as null | Record<string, unknown>,
    hmsQueueReads: 0,
    staffQuoteRunId: null as null | string,
    staffQuoteScreenshots: [] as string[],
    screenshotReads: [] as string[],
  },
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

const v4Capabilities = {
  bridgeProtocolVersion: 4,
  addinVersion: '1.0.12',
  outlookVersion: '16.0',
  runtime: 'Classic Outlook for Windows',
  newOutlookSupported: false,
  interactiveProfileRequired: true,
  maxPageSize: 200,
  maxFolderDepth: 64,
  maxFolderCount: 5000,
  maxFolderSnapshotItems: 5000,
  supportedActions: [
    'GET_CAPABILITIES',
    'GET_ACTIVE_EMAIL',
    'CREATE_REPLY_DRAFT',
    'ADD_ATTACHMENT_TO_DRAFT',
  ],
};

// Same bridge values as the useOutlookBridge mock in outlook-pane-render.test.tsx.
const fakeBridge = {
  isConnected: true,
  workstationInfo: { addinVersion: '1.0.12', bridgeProtocolVersion: 4, paired: true },
  capabilities: v4Capabilities,
  supportsAction: (action: string) => v4Capabilities.supportedActions.includes(action),
  activeEmail: {
    entryId: '001',
    storeId: 'store-1',
    folderEntryId: 'folder-inbox',
    subject: 'Suite Availability Request',
    senderEmail: 'guest@example.com',
    senderName: 'David Miller',
    receivedTime: '2026-09-17T12:00:00Z',
    internetMessageId: '<quote-request@example.invalid>',
    bodyText: 'CIDB needs 3 rooms for 4 nights.',
    bodyHtml: '<p>We need 3 rooms for 4 nights.</p>',
  },
  sendCommand: sendCommandMock,
  pairDevice: vi.fn(async () => {}),
} as unknown as PaneBridge;

vi.mock('../lib/auth-client', () => ({
  useSession: () => ({
    data: {
      user: { id: bridgeMockState.userId, email: 'ropperman@legacyhotels.co.za', name: 'R Opperman' },
      session: { id: bridgeMockState.sessionId },
    },
    isLoading: false,
  }),
  signIn: { email: vi.fn() },
}));

vi.mock('../hooks/use-connections', () => ({
  useActiveConnection: () => ({
    data: { id: bridgeMockState.transportId, email: 'ropperman@legacyhotels.co.za' },
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
      quoteProposalPdf: { mutate: quotePdfMutate },
      staffQuoteSource: {
        query: async () => ({ status: 'ready', messageId: 'mail-1', threadId: 'thread-1', sourceHash: 'ab'.repeat(32) }),
      },
      executeStaffQuote: {
        mutate: async (input: { selectionEpoch: number; inputRevision: number; groups: Array<{ arrivalDate: string; departureDate: string }> }) => {
          if (bridgeMockState.holdStaffQuote) {
            await new Promise<void>((resolve) => {
              bridgeMockState.releaseStaffQuote = resolve;
            });
          }
          return {
            status: 'ready', workflowRunId: 'run-1', revisionRef: 'rev-auth', messageId: 'mail-1', threadId: 'thread-1', factRefs: [],
            selectionEpoch: input.selectionEpoch, inputRevision: input.inputRevision, inputDigest: 'digest', totalMinor: 272000, currency: 'ZAR',
            arrivalDate: input.groups[0]?.arrivalDate, departureDate: input.groups[0]?.departureDate, description: 'Selected allocation',
            runId: bridgeMockState.staffQuoteRunId,
            screenshots: [...bridgeMockState.staffQuoteScreenshots],
          };
        },
      },
      hmsQueueStatus: {
        query: async () => {
          bridgeMockState.hmsQueueReads += 1;
          return bridgeMockState.hmsQueueStatus ?? { state: 'idle', message: '' };
        },
      },
      quoteRunScreenshot: {
        query: async ({ name }: { runId: string; name: string }) => {
          bridgeMockState.screenshotReads.push(name);
          return {
            status: 'ready',
            name,
            mimeType: 'image/png',
            sizeBytes: 16,
            dataUrl: `data:image/png;base64,SHOT-${name}`,
          };
        },
      },
      qualifiedQuoteProposalPdf: { mutate: async () => AUTHORISED_QUOTE_PDF },
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
              fields: { arrivalDate: 'missing' as const, departureDate: 'missing' as const, adults: 'missing' as const },
            },
          ],
          secondaryAsks: [],
          alternatives: [],
          sourceRevision: 1,
        }),
      },
      runStep: {
        mutate: async () => ({
          status: 'ok',
          offers: AUTHORISED_QUOTE_OFFERS,
          reviewedReplyHtml: AUTHORISED_REPLY_HTML,
        }),
      },
      qualifiedProposalPdf: {
        mutate: async () => AUTHORISED_QUOTE_PDF,
      },
    },
  },
}));

describe('NavaPane', () => {
  beforeEach(() => {
    localStorage.setItem('nava_onboarding_completed', 'true');
  });

  afterEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    cleanup();
  });

  it('renders the header, main body and footer landmarks from a bridge prop alone', () => {
    const { container } = render(<NavaPane bridge={fakeBridge} />);
    expect(container.querySelector('header')?.textContent).toContain('Nava AI Reservationist');
    expect(container.querySelector('main')).not.toBeNull();
    expect(container.querySelector('footer')?.textContent).toContain('Pilot feedback');
  });
});
