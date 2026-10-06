/**
 * @vitest-environment happy-dom
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import OutlookPanePage from '../app/(routes)/outlook-pane/page';

const { sendCommandMock, runStepMutateMock } = vi.hoisted(() => ({
  sendCommandMock: vi.fn(),
  runStepMutateMock: vi.fn(),
}));

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
      bodyText: 'Need 3 rooms 12-14 November 2026.',
      bodyHtml: '<p>Need 3 rooms 12-14 November 2026.</p>',
    },
    sendCommand: sendCommandMock,
    pairDevice: vi.fn(),
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
    },
  },
}));

describe('mounted pane step runner and current inputs', () => {
  beforeEach(() => {
    localStorage.setItem('nava_onboarding_completed', 'true');
    sendCommandMock.mockReset();
    runStepMutateMock.mockReset();
    runStepMutateMock.mockResolvedValue({
      status: 'integration_unavailable',
      reason: 'Live PMS search is not owned by this quoting UI.',
    });
  });

  afterEach(() => {
    localStorage.clear();
    cleanup();
  });

  it('runs the explicit step control with current inputs and inputRevision', async () => {
    render(<OutlookPanePage />);
    const perStep = await screen.findByRole('button', { name: /^Run Search availability/i });
    expect((perStep as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(perStep);
    await waitFor(() => expect(runStepMutateMock).toHaveBeenCalledTimes(1));
    const payload = runStepMutateMock.mock.calls[0]?.[0] as {
      stepId: string;
      inputRevision: number;
      inputs: Record<string, unknown>;
    };
    expect(payload.stepId).toMatch(/^quote-stay-/);
    expect(payload.inputRevision).toBe(1);
    expect(payload.inputs).toEqual(expect.objectContaining({ quoteRequestKey: expect.any(String) }));
  });

  it('replans the stay search after staff edit dates then sends the new request key', async () => {
    render(<OutlookPanePage />);
    const arrival = await screen.findByLabelText('Arrival');
    fireEvent.change(arrival, { target: { value: '2026-12-01' } });
    const departure = screen.getByLabelText('Departure');
    fireEvent.change(departure, { target: { value: '2026-12-03' } });
    const perStep = screen.getByRole('button', { name: /Run Search availability 2026-12-01 → 2026-12-03/i });
    fireEvent.click(perStep);
    await waitFor(() => expect(runStepMutateMock).toHaveBeenCalled());
    const payload = runStepMutateMock.mock.calls.at(-1)?.[0] as {
      stepId: string;
      inputRevision: number;
      inputs: { quoteRequestKey?: string };
    };
    expect(payload.stepId).toBe('quote-stay-2026-12-01:2026-12-03');
    expect(payload.inputRevision).toBeGreaterThan(1);
    expect(payload.inputs.quoteRequestKey).toBe('2026-12-01:2026-12-03');
  });
});
