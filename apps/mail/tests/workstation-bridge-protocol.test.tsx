/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import {
  parseBridgeMessage,
  createBridgeRequest,
  BRIDGE_PROTOCOL_VERSION,
  type WorkstationEmailPayload,
} from '../lib/workstation/bridge-protocol';
import { useOutlookBridge } from '../lib/workstation/use-outlook-bridge';

describe('Workstation Bridge Protocol', () => {
  it('serializes a GET_ACTIVE_EMAIL request with protocol version', () => {
    const req = createBridgeRequest('GET_ACTIVE_EMAIL', {});
    expect(req.action).toBe('GET_ACTIVE_EMAIL');
    expect(req.version).toBe(BRIDGE_PROTOCOL_VERSION);
    expect(typeof req.requestId).toBe('string');
    expect(req.requestId.startsWith('req_')).toBe(true);
  });

  it('parses a valid email payload from C# bridge with headers', () => {
    const raw = JSON.stringify({
      requestId: 'req-123',
      version: 1,
      success: true,
      data: {
        entryId: '000000001',
        subject: 'Reservation Inquiry for Oct 12-15',
        senderEmail: 'guest@example.com',
        senderName: 'John Smith',
        receivedTime: '2026-09-17T14:30:00Z',
        bodyText: 'Do you have 2 luxury suites available?',
        bodyHtml: '<p>Do you have 2 luxury suites available?</p>',
        conversationId: 'conv-99',
        internetMessageId: '<msg123@guest.com>',
      } satisfies WorkstationEmailPayload,
    });

    const parsed = parseBridgeMessage<WorkstationEmailPayload>(raw);
    expect(parsed.success).toBe(true);
    expect(parsed.data?.subject).toContain('Reservation Inquiry');
    expect(parsed.data?.internetMessageId).toBe('<msg123@guest.com>');
  });

  it('rejects malformed payloads gracefully without throwing', () => {
    const parsed = parseBridgeMessage('invalid-json');
    expect(parsed.success).toBe(false);
    expect(parsed.error).toBeDefined();
  });
});

function BridgeProbe() {
  const { isConnected, activeEmail } = useOutlookBridge();
  return (
    <div>
      <span data-testid="connected">{isConnected ? 'yes' : 'no'}</span>
      <span data-testid="subject">{activeEmail?.subject ?? ''}</span>
    </div>
  );
}

describe('useOutlookBridge selection events', () => {
  const listeners = new Map<string, Array<(event: { data: unknown }) => void>>();

  beforeEach(() => {
    listeners.clear();
    window.chrome = {
      webview: {
        postMessage: vi.fn(),
        addEventListener: (type, listener) => {
          const bucket = listeners.get(type) ?? [];
          bucket.push(listener);
          listeners.set(type, bucket);
        },
        removeEventListener: (type, listener) => {
          const bucket = listeners.get(type) ?? [];
          listeners.set(
            type,
            bucket.filter((item) => item !== listener),
          );
        },
      },
    };
  });

  afterEach(() => {
    cleanup();
    delete window.chrome;
  });

  it('updates active email on ON_SELECTION_CHANGED events with evt_ ids', async () => {
    render(<BridgeProbe />);

    const payload: WorkstationEmailPayload = {
      entryId: '001',
      subject: 'Suite Availability Request',
      senderEmail: 'guest@example.com',
      senderName: 'David Miller',
      receivedTime: '2026-09-17T12:00:00Z',
      bodyText: 'We need 3 rooms for 4 nights.',
      bodyHtml: '<p>We need 3 rooms for 4 nights.</p>',
      internetMessageId: '<msg@guest.com>',
    };

    act(() => {
      for (const listener of listeners.get('message') ?? []) {
        listener({
          data: JSON.stringify({
            requestId: 'evt_selection_1',
            version: 1,
            action: 'ON_SELECTION_CHANGED',
            success: true,
            data: payload,
          }),
        });
      }
    });

    await waitFor(() => {
      expect(screen.getByTestId('subject').textContent).toBe('Suite Availability Request');
    });

    act(() => {
      for (const listener of listeners.get('message') ?? []) {
        listener({
          data: JSON.stringify({
            requestId: 'evt_selection_cleared',
            version: 1,
            action: 'ON_SELECTION_CHANGED',
            success: true,
            data: null,
          }),
        });
      }
    });

    await waitFor(() => {
      expect(screen.getByTestId('subject').textContent).toBe('');
    });
  });
});
