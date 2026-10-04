/** @vitest-environment happy-dom */
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { afterEach, describe, it, expect, vi } from 'vitest';
afterEach(cleanup);
const status = {
  version: 1 as const,
  sourceId: 'source',
  state: 'running' as const,
  capabilityRequirement: 'mailboxSync:1' as const,
  historyFrom: '2026-09-04T00:00:00Z',
  historyTo: '2026-10-04T00:00:00Z',
  timezone: 'Africa/Johannesburg',
  captureStartedAt: '2026-10-04T00:00:00Z',
  discoveredThrough: null,
  committedThrough: null,
  discovered: 10,
  retained: 4,
  committed: 2,
  gaps: 0,
  userPaused: false,
  resourcePauseReason: null,
};
describe('compact truthful Outlook sync progress', () => {
  it('prioritizes live status, distinguishes retained from canonical counts and exposes keyboard controls', async () => {
    const module = await import(
      /* @vite-ignore */ '../components/workstation/' + 'outlook-sync-progress'
    ).catch(() => null);
    expect(module, 'sync status component exists').not.toBeNull();
    if (!module) return;
    const onControl = vi.fn();
    render(
      <module.OutlookSyncProgress
        status={status}
        mailbox="shared@example.test"
        onControl={onControl}
      />,
    );
    expect(screen.getByRole('button', { name: /copies pending/i })).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: /copies pending/i }));
    expect(screen.getByText(/4 originals retained/i)).toBeDefined();
    expect(screen.getByText(/2 searchable/i)).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    expect(onControl).toHaveBeenCalledWith('pause');
  });
  it('keeps user Pause through resource recovery, disables Sync now and never announces 100% with gaps', async () => {
    const module = await import(
      /* @vite-ignore */ '../components/workstation/' + 'outlook-sync-progress'
    ).catch(() => null);
    expect(module).not.toBeNull();
    if (!module) return;
    render(
      <module.OutlookSyncProgress
        status={{ ...status, state: 'paused', userPaused: true, gaps: 2 }}
        mailbox="shared@example.test"
        onControl={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /sync paused/i }));
    expect((screen.getByRole('button', { name: 'Sync now' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(screen.queryByText(/100%/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Resume' })).toBeDefined();
  });
});

it('labels history only after full metadata inventory and live independently', async () => {
  const { OutlookSyncProgress } = await import('../components/workstation/outlook-sync-progress');
  render(
    <OutlookSyncProgress
      status={{
        ...status,
        history: { discoveryComplete: true, discovered: 10, retained: 4, committed: 2, gaps: 0 },
        live: { discovered: 0, retained: 0, committed: 0, gaps: 0 },
      }}
      mailbox="shared@example.test"
      onControl={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: /checking for new mail/i }));
  expect(screen.getByText('Copying 4 of 10')).toBeDefined();
});
