/**
 * @vitest-environment happy-dom
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HmsLinkActions } from '../components/quote-workflow/hms-link-actions';
import { setMailCacheScope } from '@/lib/mail/mail-cache-scope';
import {
  bindPaneTelemetry,
  createPaneTelemetry,
  currentPaneOwner,
  PANE_ACTION_BATCH_MAX,
  type PaneActionBatch,
  type PaneOwner,
  setPaneTelemetryScope,
  trackPaneAction,
} from '@/lib/quote-workflow/pane-telemetry';

const WORK_ITEM = '5f1c0a52-7c1e-4b8e-9d3a-2a6f0c1d9e11';
const LANDING = 'https://hms.example.test/';
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

function owner(workItemId: string, transportId: string | null = 'mailbox-a'): PaneOwner {
  return { workItemId, transportId };
}

function pageHide() {
  window.dispatchEvent(new Event('pagehide'));
}

function setClipboard(value: unknown) {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value });
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  setClipboard(undefined);
  setPaneTelemetryScope(null);
  setMailCacheScope({ userId: null, activeTransportId: null });
});

describe('createPaneTelemetry', () => {
  it('sends each work item its queued actions in one call, under its mailbox, on the interval', () => {
    vi.useFakeTimers();
    const send = vi.fn(async () => undefined);
    const telemetry = createPaneTelemetry(send, 1000);

    telemetry.track(owner('wi-1'), { type: 'pane.opened', surface: 'outlook' });
    telemetry.track(owner('wi-1'), { type: 'copy.confirmation' });
    telemetry.track(owner('wi-2', 'mailbox-b'), { type: 'item.dismissed' });
    expect(send).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1000);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledWith({
      workItemId: 'wi-1',
      transportId: 'mailbox-a',
      events: [{ type: 'pane.opened', surface: 'outlook' }, { type: 'copy.confirmation' }],
    });
    expect(send).toHaveBeenCalledWith({
      workItemId: 'wi-2',
      transportId: 'mailbox-b',
      events: [{ type: 'item.dismissed' }],
    });
  });

  it('splits a long queue into batches of at most the cap', () => {
    const batches: PaneActionBatch[] = [];
    const telemetry = createPaneTelemetry(async (batch) => {
      batches.push(batch);
    }, 60_000);
    for (let index = 0; index < PANE_ACTION_BATCH_MAX + 1; index += 1) {
      telemetry.track(owner('wi-1'), { type: 'pane.opened' });
    }
    telemetry.flush();
    expect(batches.map((batch) => batch.events.length)).toEqual([PANE_ACTION_BATCH_MAX, 1]);
  });

  it('drops a refused or throwing send without throwing or leaving a rejection behind', async () => {
    const refused = vi.fn(() => Promise.reject(new Error('offline')));
    const thrown = vi.fn(() => {
      throw new Error('boom');
    });
    const telemetry = createPaneTelemetry(refused, 60_000);
    telemetry.track(owner('wi-1'), { type: 'pane.opened' });
    expect(() => telemetry.flush()).not.toThrow();

    const broken = createPaneTelemetry(thrown, 60_000);
    broken.track(owner('wi-1'), { type: 'pane.opened' });
    expect(() => broken.flush()).not.toThrow();

    await waitFor(() => expect(refused).toHaveBeenCalledTimes(1));
    expect(thrown).toHaveBeenCalledTimes(1);
  });
});

describe('pane telemetry wiring', () => {
  it('records Copy confirmation on the pane work item, and nothing without one', async () => {
    const mutate = vi.fn(async (_input: unknown, _opts?: unknown) => ({ recorded: 1 }));
    bindPaneTelemetry({ workItems: { recordActions: { mutate } } });
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn(async () => undefined) },
    });

    setPaneTelemetryScope({ workItemId: WORK_ITEM, transportId: 'mailbox-a', surface: 'web' });
    render(<HmsLinkActions confirmation="64318608-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy confirmation' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy());
    pageHide();

    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate).toHaveBeenCalledWith(
      { workItemId: WORK_ITEM, events: [{ type: 'copy.confirmation', surface: 'web' }] },
      { context: { activeTransportId: 'mailbox-a' } },
    );

    mutate.mockClear();
    setPaneTelemetryScope(null);
    trackPaneAction({ type: 'pane.opened' });
    pageHide();
    expect(mutate).not.toHaveBeenCalled();
  });

  it('sends a queued batch under the mailbox its work item lives in, even when the person switches mailbox first', () => {
    const mutate = vi.fn(async (_input: unknown, _opts?: unknown) => ({ recorded: 1 }));
    bindPaneTelemetry({ workItems: { recordActions: { mutate } } });
    setMailCacheScope({ userId: 'user-1', activeTransportId: 'mailbox-a' });
    setPaneTelemetryScope({ workItemId: WORK_ITEM, transportId: 'mailbox-a', surface: 'outlook' });
    trackPaneAction({ type: 'pane.opened' });

    setMailCacheScope({ userId: 'user-1', activeTransportId: 'mailbox-b' });
    pageHide();

    expect(mutate).toHaveBeenCalledWith(
      { workItemId: WORK_ITEM, events: [{ type: 'pane.opened', surface: 'outlook' }] },
      { context: { activeTransportId: 'mailbox-a' } },
    );
  });

  it('records an action that finishes later on the item it started on, and nothing when it started with none', () => {
    const mutate = vi.fn(async (_input: unknown, _opts?: unknown) => ({ recorded: 1 }));
    bindPaneTelemetry({ workItems: { recordActions: { mutate } } });
    setPaneTelemetryScope({ workItemId: 'wi-1', transportId: 'mailbox-a', surface: 'outlook' });
    const started = currentPaneOwner();
    setPaneTelemetryScope({ workItemId: 'wi-2', transportId: 'mailbox-a', surface: 'outlook' });

    trackPaneAction({ type: 'pdf.created', kind: 'option' }, started);
    trackPaneAction({ type: 'hms.lookup.finished', ms: 900 }, null);
    trackPaneAction({ type: 'item.dismissed' }, owner('wi-3', 'mailbox-b'));
    pageHide();

    expect(mutate).toHaveBeenCalledTimes(2);
    expect(mutate).toHaveBeenCalledWith(
      { workItemId: 'wi-1', events: [{ type: 'pdf.created', kind: 'option', surface: 'outlook' }] },
      { context: { activeTransportId: 'mailbox-a' } },
    );
    expect(mutate).toHaveBeenCalledWith(
      { workItemId: 'wi-3', events: [{ type: 'item.dismissed', surface: 'outlook' }] },
      { context: { activeTransportId: 'mailbox-b' } },
    );
  });

  it('records only the single confirmation copy action, without its value', async () => {
    const mutate = vi.fn(async (_input: unknown, _opts?: unknown) => ({ recorded: 1 }));
    const writeText = vi.fn(async () => undefined);
    bindPaneTelemetry({ workItems: { recordActions: { mutate } } });
    setClipboard({ writeText });
    setPaneTelemetryScope({ workItemId: WORK_ITEM, transportId: 'mailbox-a', surface: 'web' });

    render(<HmsLinkActions confirmation="64318608-1" />);
    expect(screen.getAllByRole('button', { name: 'Copy confirmation' })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Copy link' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Copy for HMS' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Copy confirmation' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Copied' })).toBeDefined());
    expect(writeText).toHaveBeenCalledWith('64318608-1');
    pageHide();

    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(1));
    expect(mutate).toHaveBeenCalledWith(
      {
        workItemId: WORK_ITEM,
        events: [
          { type: 'copy.confirmation', surface: 'web' },
        ],
      },
      { context: { activeTransportId: 'mailbox-a' } },
    );
    const recorded = JSON.stringify(mutate.mock.calls);
    expect(recorded).not.toContain('64318608-1');
  });

  it('records a confirmation copy that finishes after the pane moves on on the item it started on', async () => {
    const mutate = vi.fn(async (_input: unknown, _opts?: unknown) => ({ recorded: 1 }));
    let finishWrite: () => void = () => undefined;
    const writeText = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishWrite = () => resolve();
        }),
    );
    bindPaneTelemetry({ workItems: { recordActions: { mutate } } });
    setClipboard({ writeText });
    setPaneTelemetryScope({ workItemId: 'wi-1', transportId: 'mailbox-a', surface: 'web' });

    render(<HmsLinkActions confirmation="64318608-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy confirmation' }));
    setPaneTelemetryScope({ workItemId: 'wi-2', transportId: 'mailbox-a', surface: 'web' });
    finishWrite();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Copied' })).toBeDefined());
    pageHide();

    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate).toHaveBeenCalledWith(
      { workItemId: 'wi-1', events: [{ type: 'copy.confirmation', surface: 'web' }] },
      { context: { activeTransportId: 'mailbox-a' } },
    );
  });

  it('records a confirmation copy that finishes after the pane moves on on the item it started on', async () => {
    const mutate = vi.fn(async (_input: unknown, _opts?: unknown) => ({ recorded: 1 }));
    let finishWrite: () => void = () => undefined;
    const writeText = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishWrite = () => resolve();
        }),
    );
    bindPaneTelemetry({ workItems: { recordActions: { mutate } } });
    setClipboard({ writeText });
    setPaneTelemetryScope({ workItemId: 'wi-1', transportId: 'mailbox-a', surface: 'web' });

    render(<HmsLinkActions confirmation="64318608-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy confirmation' }));
    setPaneTelemetryScope({ workItemId: 'wi-2', transportId: 'mailbox-a', surface: 'web' });
    finishWrite();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Copied' })).toBeDefined());
    pageHide();

    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate).toHaveBeenCalledWith(
      { workItemId: 'wi-1', events: [{ type: 'copy.confirmation', surface: 'web' }] },
      { context: { activeTransportId: 'mailbox-a' } },
    );
  });
});
