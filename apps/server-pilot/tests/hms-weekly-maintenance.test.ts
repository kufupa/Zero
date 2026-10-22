import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HMS_MAINTENANCE_FAILURE_CLASS,
  HMS_WEEKLY_MAINTENANCE_LAST_ERROR,
  hmsWeeklyMaintenanceHooks,
  isHmsWeeklyMaintenanceWindow,
  resetHmsWeeklyMaintenanceHooks,
  shouldPauseHmsJobsForWeeklyMaintenance,
} from '../src/hms/hms-weekly-maintenance.js';
import { executeHmsJob } from '../src/ai/hms-jobs.js';
import { markAiRunRetry, type AiWorkflowRun } from '../src/ai/run-ledger.js';
import type { DB } from '../src/db/client.js';

vi.mock('../src/ai/run-ledger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/ai/run-ledger.js')>();
  return {
    ...actual,
    markAiRunRetry: vi.fn(actual.markAiRunRetry),
  };
});

const WEDNESDAY_IN_WINDOW = new Date('2026-10-21T11:00:00Z');
const WEDNESDAY_BEFORE = new Date('2026-10-21T09:59:00Z');
const WEDNESDAY_AT_END = new Date('2026-10-21T13:30:00Z');
const WEDNESDAY_LAST_MINUTE = new Date('2026-10-21T13:29:00Z');
const THURSDAY_SAME_HOUR = new Date('2026-10-22T11:00:00Z');

afterEach(() => {
  resetHmsWeeklyMaintenanceHooks();
  vi.mocked(markAiRunRetry).mockReset();
});

describe('Wednesday HMS maintenance window', () => {
  it('covers Wednesday 10:00 UTC inclusive through 13:30 UTC exclusive', () => {
    expect(isHmsWeeklyMaintenanceWindow(new Date('2026-10-21T10:00:00Z'))).toBe(true);
    expect(isHmsWeeklyMaintenanceWindow(WEDNESDAY_IN_WINDOW)).toBe(true);
    expect(isHmsWeeklyMaintenanceWindow(WEDNESDAY_LAST_MINUTE)).toBe(true);
    expect(isHmsWeeklyMaintenanceWindow(WEDNESDAY_BEFORE)).toBe(false);
    expect(isHmsWeeklyMaintenanceWindow(WEDNESDAY_AT_END)).toBe(false);
    expect(isHmsWeeklyMaintenanceWindow(THURSDAY_SAME_HOUR)).toBe(false);
    expect(isHmsWeeklyMaintenanceWindow(new Date('2026-10-20T11:00:00Z'))).toBe(false);
  });
});

describe('pause and resume', () => {
  it('pauses only when the window is open and HMS is unreachable', async () => {
    hmsWeeklyMaintenanceHooks.now = () => WEDNESDAY_IN_WINDOW;
    hmsWeeklyMaintenanceHooks.reachable = async () => false;
    expect(await shouldPauseHmsJobsForWeeklyMaintenance()).toBe(true);
  });

  it('resumes in the window once the reachability probe passes', async () => {
    hmsWeeklyMaintenanceHooks.now = () => WEDNESDAY_IN_WINDOW;
    hmsWeeklyMaintenanceHooks.reachable = async () => false;
    expect(await shouldPauseHmsJobsForWeeklyMaintenance()).toBe(true);
    hmsWeeklyMaintenanceHooks.reachable = async () => true;
    expect(await shouldPauseHmsJobsForWeeklyMaintenance()).toBe(false);
  });

  it('does not pause outside the window even when HMS is unreachable', async () => {
    hmsWeeklyMaintenanceHooks.now = () => THURSDAY_SAME_HOUR;
    hmsWeeklyMaintenanceHooks.reachable = async () => false;
    expect(await shouldPauseHmsJobsForWeeklyMaintenance()).toBe(false);
  });

  it('treats a probe throw during the window as unreachable', async () => {
    hmsWeeklyMaintenanceHooks.now = () => WEDNESDAY_IN_WINDOW;
    hmsWeeklyMaintenanceHooks.reachable = async () => {
      throw new Error('probe failed');
    };
    expect(await shouldPauseHmsJobsForWeeklyMaintenance()).toBe(true);
  });
});

function runningPartyRun(attempts: number): AiWorkflowRun {
  return {
    id: 'run-maintenance-1',
    transportId: 'transport-1',
    threadId: 'thread-1',
    triggerMessageId: 'msg-1',
    state: 'running',
    attempts,
    lastError: null,
    failureClass: null,
    priority: 10,
    readRequest: { kind: 'party', name: 'Acme Agency', matchVersion: 2 },
    metrics: { userId: 'user-1' },
    createdAt: new Date('2026-10-21T10:30:00Z'),
  } as AiWorkflowRun;
}

describe('executeHmsJob pause', () => {
  it('requeues without burning attempts or dead-lettering', async () => {
    hmsWeeklyMaintenanceHooks.now = () => WEDNESDAY_IN_WINDOW;
    hmsWeeklyMaintenanceHooks.reachable = async () => false;
    vi.mocked(markAiRunRetry).mockResolvedValue({ id: 'run-maintenance-1' } as never);

    const run = runningPartyRun(2);
    const fence = {
      runId: run.id,
      claimOwner: 'hms-ai-worker-111',
      claimToken: 'token-1',
      deadlineAt: new Date('2026-10-21T12:00:00Z'),
    };

    await expect(
      executeHmsJob({ run, fence, db: {} as DB }),
    ).resolves.toBe('retry_wait');

    expect(markAiRunRetry).toHaveBeenCalledTimes(1);
    expect(vi.mocked(markAiRunRetry).mock.calls[0]?.[0]).toMatchObject({
      runId: run.id,
      attempts: 2,
      failureClass: HMS_MAINTENANCE_FAILURE_CLASS,
      lastError: HMS_WEEKLY_MAINTENANCE_LAST_ERROR,
    });
  });
});
