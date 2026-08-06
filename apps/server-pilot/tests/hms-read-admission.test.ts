import { describe, expect, it, vi } from 'vitest';
import { CLEANUP_RESERVE_MS } from '../src/ai/run-ledger.js';
import {
  READ_BRANCH_WORST_CASE_COMPONENTS,
  READ_BRANCH_WORST_CASE_MS,
  admitReadBranch,
} from '../src/hms/read-admission.js';

describe('admitReadBranch', () => {
  it('documents worst-case components that sum to READ_BRANCH_WORST_CASE_MS', () => {
    const {
      QUEUE_WAIT_MS,
      LOGIN_MS,
      NAVIGATION_MS,
      READS_MS,
      CAPTURE_FINALIZE_MS,
      CLEANUP_RESERVE_MS: cleanup,
    } = READ_BRANCH_WORST_CASE_COMPONENTS;
    expect(cleanup).toBe(CLEANUP_RESERVE_MS);
    expect(
      QUEUE_WAIT_MS +
        LOGIN_MS +
        NAVIGATION_MS +
        READS_MS +
        CAPTURE_FINALIZE_MS +
        cleanup,
    ).toBe(READ_BRANCH_WORST_CASE_MS);
    expect(READ_BRANCH_WORST_CASE_MS).toBeLessThanOrEqual(150_000);
  });

  it('admits when remaining time covers worst case', () => {
    const now = new Date('2026-08-06T12:00:00.000Z');
    const deadlineAt = new Date(now.getTime() + READ_BRANCH_WORST_CASE_MS);
    expect(admitReadBranch({ deadlineAt, now })).toEqual({ ok: true });
  });

  it('rejects with DEADLINE_ADMISSION_REJECTED when remaining < worstCase', () => {
    const now = new Date('2026-08-06T12:00:00.000Z');
    const deadlineAt = new Date(now.getTime() + READ_BRANCH_WORST_CASE_MS - 1);
    expect(admitReadBranch({ deadlineAt, now })).toEqual({
      ok: false,
      code: 'DEADLINE_ADMISSION_REJECTED',
    });
  });

  it('rejects with RUN_DEADLINE when deadline already passed', () => {
    const now = new Date('2026-08-06T12:00:00.000Z');
    const deadlineAt = new Date(now.getTime() - 1);
    expect(admitReadBranch({ deadlineAt, now })).toEqual({
      ok: false,
      code: 'RUN_DEADLINE',
    });
  });

  it('honors explicit worstCaseMs override', () => {
    const now = new Date('2026-08-06T12:00:00.000Z');
    const deadlineAt = new Date(now.getTime() + 5_000);
    expect(
      admitReadBranch({ deadlineAt, now, worstCaseMs: 4_000 }),
    ).toEqual({ ok: true });
    expect(
      admitReadBranch({ deadlineAt, now, worstCaseMs: 5_001 }),
    ).toEqual({
      ok: false,
      code: 'DEADLINE_ADMISSION_REJECTED',
    });
  });
});

describe('createCandidateTools branch admission', () => {
  it('refuses first tool I/O when remaining < worst case', async () => {
    const { createCandidateTools, createMockCandidateSession } = await import(
      '../src/ai/candidate-draft-agent.js'
    );
    const findReservation = vi.fn(async () => ({
      status: 'ok' as const,
      draftReady: true,
      data: {
        matches: [
          {
            confirmationNumber: 'CONF-1',
            externalReference: null,
            guestName: 'Guest',
            arrivalDate: '2026-08-01',
            departureDate: '2026-08-03',
            reservationStatus: 'Confirmed',
            roomType: 'STD',
            ratePlan: null,
          },
        ],
        matchCount: 1,
        capped: false,
      },
      unresolvedFields: [] as string[],
      evidence: {
        kind: 'hms' as const,
        id: 'ev-1',
        toolId: 'hms_find_reservation',
        toolVersion: '1.2.0',
        propertyCode: 'CENTURION',
        observedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        claimKeys: ['reservation.status'],
        sourceHash: 'a'.repeat(64),
      },
    }));
    const now = new Date('2026-08-06T12:00:00.000Z');
    const session = createMockCandidateSession({
      readFence: {
        runId: 'run-1',
        claimOwner: 'owner',
        claimToken: 'token',
        deadlineAt: new Date(now.getTime() + READ_BRANCH_WORST_CASE_MS - 1),
      },
      readPlanKind: 'reservation',
      lookupCandidates: new Map([
        ['cand-1', { id: 'cand-1', kind: 'confirmation', value: 'CONF-1' }],
      ]),
      findReservation,
    });
    const reserve = vi.fn(async () => ({ total: 1 }));
    const bundle = createCandidateTools(session, {
      now: () => now,
      reserveReadAttempt: reserve,
    });
    await expect(
      bundle.tools.hms_find_reservation.execute!(
        { candidateId: 'cand-1' },
        { abortSignal: new AbortController().signal },
      ),
    ).rejects.toMatchObject({ code: 'DEADLINE_ADMISSION_REJECTED' });
    expect(reserve).not.toHaveBeenCalled();
    expect(findReservation).not.toHaveBeenCalled();
  });
});
