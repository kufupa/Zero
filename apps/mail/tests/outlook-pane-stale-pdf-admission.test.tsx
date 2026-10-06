/**
 * @vitest-environment happy-dom
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import OutlookPanePage from '../app/(routes)/outlook-pane/page';
import {
  AUTHORISED_QUOTE_OFFERS,
  AUTHORISED_QUOTE_PDF,
  AUTHORISED_REPLY_HTML,
} from './helpers/authorised-quote-evidence';

const SECOND_OFFER = {
  ...AUTHORISED_QUOTE_OFFERS[0]!,
  id: 'auth-2',
  roomCode: 'STWN',
  roomLabel: 'Standard Twin',
  sourceRef: 'auth-src-2',
};

const { sendCommandMock, quotePdfMutateMock, runStepMutateMock } = vi.hoisted(() => ({
  sendCommandMock: vi.fn(),
  quotePdfMutateMock: vi.fn(),
  runStepMutateMock: vi.fn(),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve: (value: T) => resolve(value) };
}

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

vi.mock('../lib/workstation/use-outlook-bridge', () => ({
  useOutlookBridge: () => ({
    isConnected: true,
    workstationInfo: {
      workstationUser: 'ropperman',
      outlookEmail: 'ropperman@legacyhotels.co.za',
      outlookVersion: '16.0',
      addinVersion: '1.0.11',
      bridgeProtocolVersion: 4,
    },
    capabilities: {
      bridgeProtocolVersion: 4,
      addinVersion: '1.0.11',
      outlookVersion: '16.0',
      runtime: 'Classic Outlook for Windows',
      newOutlookSupported: false,
      interactiveProfileRequired: true,
      maxPageSize: 200,
      maxFolderDepth: 64,
      maxFolderCount: 5000,
      maxFolderSnapshotItems: 5000,
      supportedActions: ['CREATE_REPLY_DRAFT', 'ADD_ATTACHMENT_TO_DRAFT'],
    },
    supportsAction: (action: string) =>
      action === 'CREATE_REPLY_DRAFT' || action === 'ADD_ATTACHMENT_TO_DRAFT',
    requiresRelogin: false,
    activeEmail: {
      entryId: '001',
      storeId: 'store-1',
      folderEntryId: 'folder-inbox',
      subject: 'Suite Availability Request',
      senderEmail: 'guest@example.com',
      senderName: 'David Miller',
      receivedTime: '2026-09-17T12:00:00Z',
      bodyText: 'Need 3 rooms 12-14 November 2026.',
      bodyHtml: '<p>Need 3 rooms 12-14 November 2026.</p>',
    },
    sendCommand: sendCommandMock,
  }),
}));

vi.mock('../hooks/use-connections', () => ({
  useActiveConnection: () => ({
    data: { id: 'transport-shared', email: 'centurion@legacyhotels.co.za' },
    isLoading: false,
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

vi.mock('../providers/query-provider', () => ({
  trpcClient: {
    workstation: {
      ping: { mutate: vi.fn().mockResolvedValue({ status: 'ok' }) },
      quoteProposalPdf: { mutate: vi.fn() },
    },
    quoteWorkflow: {
      runStep: { mutate: (...args: unknown[]) => runStepMutateMock(...args) },
      qualifiedProposalPdf: { mutate: (...args: unknown[]) => quotePdfMutateMock(...args) },
    },
  },
}));

async function waitForAllocation(label: string) {
  return waitFor(() => {
    const match = screen.getAllByRole('button').find((element) => (element.textContent ?? '').includes(label));
    if (!match) throw new Error(`expected allocation ${label}`);
    return match;
  });
}

async function startPendingPdf() {
  render(<OutlookPanePage />);
  fireEvent.click(await screen.findByRole('button', { name: /^Run next$/i }));
  fireEvent.click(await waitForAllocation('Standard King'));
  fireEvent.click(screen.getByRole('button', { name: /Prepare quotation PDF/i }));
  await waitFor(() => expect(quotePdfMutateMock).toHaveBeenCalled());
}

async function assertNoNativeDraft() {
  expect(screen.queryByText(/Prepared PDF/i)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /Insert Draft in Outlook/i }));
  expect(sendCommandMock.mock.calls.filter((call) => call[0] === 'CREATE_REPLY_DRAFT')).toHaveLength(0);
}

describe('deferred quote PDF / unavailable cannot mutate a newer session', () => {
  beforeEach(() => {
    localStorage.setItem('nava_onboarding_completed', 'true');
    sendCommandMock.mockReset();
    sendCommandMock.mockResolvedValue({
      entryId: 'draft-1',
      storeId: 'store-1',
      folderEntryId: 'folder-drafts',
      displayed: true,
    });
    quotePdfMutateMock.mockReset();
    runStepMutateMock.mockReset();
    runStepMutateMock.mockResolvedValue({
      status: 'ok',
      offers: [AUTHORISED_QUOTE_OFFERS[0]!, SECOND_OFFER],
      reviewedReplyHtml: AUTHORISED_REPLY_HTML,
    });
  });

  afterEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    cleanup();
  });

  it('rejects a PDF that returns after the stay group is edited', async () => {
    const pending = deferred<typeof AUTHORISED_QUOTE_PDF>();
    quotePdfMutateMock.mockReturnValue(pending.promise);
    await startPendingPdf();
    fireEvent.change(screen.getByLabelText('Adults'), { target: { value: '4' } });
    await act(async () => {
      pending.resolve(AUTHORISED_QUOTE_PDF);
      await pending.promise;
    });
    await assertNoNativeDraft();
  });

  it('rejects a PDF that returns after the selected offer changes', async () => {
    const pending = deferred<typeof AUTHORISED_QUOTE_PDF>();
    quotePdfMutateMock.mockReturnValue(pending.promise);
    await startPendingPdf();
    fireEvent.click(await waitForAllocation('Standard Twin'));
    await act(async () => {
      pending.resolve(AUTHORISED_QUOTE_PDF);
      await pending.promise;
    });
    await assertNoNativeDraft();
  });

  it('rejects a late results_unavailable after the stay group is edited', async () => {
    const pending = deferred<{ status: 'integration_unavailable'; reason: string }>();
    runStepMutateMock.mockReturnValue(pending.promise);
    render(<OutlookPanePage />);
    fireEvent.click(await screen.findByRole('button', { name: /^Run next$/i }));
    fireEvent.change(screen.getByLabelText('Adults'), { target: { value: '4' } });
    await act(async () => {
      pending.resolve({ status: 'integration_unavailable', reason: 'stale unavailable' });
      await pending.promise;
    });
    expect(screen.queryByText('stale unavailable')).toBeNull();
    expect(screen.queryByText(/Prepared PDF/i)).toBeNull();
  });
});
