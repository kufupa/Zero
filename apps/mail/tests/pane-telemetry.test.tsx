/**
 * @vitest-environment happy-dom
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HmsLinkActions } from '../components/quote-workflow/hms-link-actions';
import {
  bindPaneTelemetry,
  createPaneTelemetry,
  PANE_ACTION_BATCH_MAX,
  type PaneActionBatch,
  setPaneTelemetryScope,
  trackPaneAction,
} from '@/lib/quote-workflow/pane-telemetry';

const WORK_ITEM = '5f1c0a52-7c1e-4b8e-9d3a-2a6f0c1d9e11';

function pageHide() {
  window.dispatchEvent(new Event('pagehide'));
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  setPaneTelemetryScope(null);
});

describe('createPaneTelemetry', () => {
  it('sends each work item its queued actions in one call, on the interval', () => {
    vi.useFakeTimers();
    const send = vi.fn(async () => undefined);
    const telemetry = createPaneTelemetry(send, 1000);

    telemetry.track('wi-1', { type: 'pane.opened', surface: 'outlook' });
    telemetry.track('wi-1', { type: 'copy.confirmation' });
    telemetry.track('wi-2', { type: 'item.dismissed' });
    expect(send).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1000);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledWith({
      workItemId: 'wi-1',
      events: [{ type: 'pane.opened', surface: 'outlook' }, { type: 'copy.confirmation' }],
    });
    expect(send).toHaveBeenCalledWith({ workItemId: 'wi-2', events: [{ type: 'item.dismissed' }] });
  });

  it('splits a long queue into batches of at most the cap', () => {
    const batches: PaneActionBatch[] = [];
    const telemetry = createPaneTelemetry(async (batch) => {
      batches.push(batch);
    }, 60_000);
    for (let index = 0; index < PANE_ACTION_BATCH_MAX + 1; index += 1) {
      telemetry.track('wi-1', { type: 'pane.opened' });
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
    telemetry.track('wi-1', { type: 'pane.opened' });
    expect(() => telemetry.flush()).not.toThrow();

    const broken = createPaneTelemetry(thrown, 60_000);
    broken.track('wi-1', { type: 'pane.opened' });
    expect(() => broken.flush()).not.toThrow();

    await waitFor(() => expect(refused).toHaveBeenCalledTimes(1));
    expect(thrown).toHaveBeenCalledTimes(1);
  });
});

describe('pane telemetry wiring', () => {
  it('records Copy confirmation on the pane work item, and nothing without one', async () => {
    const mutate = vi.fn(async () => ({ recorded: 1 }));
    bindPaneTelemetry({ workItems: { recordActions: { mutate } } });
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn(async () => undefined) },
    });

    setPaneTelemetryScope({ workItemId: WORK_ITEM, surface: 'web' });
    render(<HmsLinkActions confirmation="64318608-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy confirmation' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy());
    pageHide();

    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate).toHaveBeenCalledWith({
      workItemId: WORK_ITEM,
      events: [{ type: 'copy.confirmation', surface: 'web' }],
    });

    mutate.mockClear();
    setPaneTelemetryScope(null);
    trackPaneAction({ type: 'pane.opened' });
    pageHide();
    expect(mutate).not.toHaveBeenCalled();
  });
});
