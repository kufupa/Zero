import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { DB } from '../src/db/client.js';
import {
  aiDraftGeneration,
  aiWorkflowRun,
  mailDraft,
  mailThread,
  message,
} from '../src/db/schema/mail.js';
import { TRANSPORT_ID } from '../src/db/seed.js';
import { computeThreadStateVersion } from '../src/ai/thread-context.js';
import {
  assertThreadStateVersionFresh,
  ThreadStateStaleError,
} from '../src/ai/drafts.js';
import {
  RESERVATION_EVIDENCE_TTL_MS,
  QUOTE_EVIDENCE_TTL_MS,
} from '../src/hms/adapter.js';
import {
  buildHmsRefreshIdempotencyKey,
  evaluateHmsCandidateFreshness,
  evaluateHmsEvidenceFreshness,
  isHmsEnrichedGeneration,
  loadHmsCandidateState,
  enqueueHmsCandidateRefresh,
  HMS_CANDIDATE_TOOLSET_VERSION,
} from '../src/trpc/routes/drafts.js';
import {
  TEST_DB_AVAILABLE,
  probeTestDb,
  withSeededTestDb,
} from './helpers/test-db';
import { appRouter } from '../src/trpc/router.js';
import { resolveMailboxContext } from '../src/trpc/context.js';

const reachable = await probeTestDb();

function sha(s: string) {
  return createHash('sha256').update(s).digest('hex');
}

function hmsEvidence(partial: Record<string, unknown> = {}) {
  return {
    kind: 'hms' as const,
    id: 'ev-1',
    toolId: 'hms_quote_stay',
    toolVersion: '1',
    propertyCode: 'CEN',
    observedAt: '2026-07-30T12:00:00.000Z',
    expiresAt: '2026-07-30T12:15:00.000Z',
    claimKeys: ['rate'],
    sourceHash: sha('seed'),
    ...partial,
  };
}

function mailEvidence(partial: Record<string, unknown> = {}) {
  return {
    kind: 'mail_attachment' as const,
    id: 'ev-mail-1',
    toolId: 'mail_read_artifact' as const,
    toolVersion: '1',
    attachmentId: 'att-1',
    observedAt: '2026-07-30T12:00:00.000Z',
    sourceHash: sha('attachment-body'),
    claimKeys: ['attachment.text'],
    ...partial,
  };
}

describe('HMS candidate freshness helpers', () => {
  it('builds refresh idempotency key with thread + toolset versions', () => {
    expect(
      buildHmsRefreshIdempotencyKey({
        transportId: 't1',
        threadId: 'th1',
        threadStateVersion: 'abc',
      }),
    ).toBe(`hms-refresh:t1:th1:abc:${HMS_CANDIDATE_TOOLSET_VERSION}`);
  });

  it('treats off-mode skeleton generations as not HMS-enriched', () => {
    expect(
      isHmsEnrichedGeneration({
        outcome: null,
        threadStateVersion: null,
        evidence: [],
      }),
    ).toBe(false);
    expect(
      isHmsEnrichedGeneration({
        outcome: 'candidate',
        threadStateVersion: 'v1',
        evidence: [hmsEvidence()],
      }),
    ).toBe(true);
  });

  it('marks expired 15-minute rate/inventory evidence stale', () => {
    const observedAt = Date.parse('2026-07-30T12:00:00.000Z');
    const expiresAt = new Date(observedAt + QUOTE_EVIDENCE_TTL_MS).toISOString();
    const fresh = evaluateHmsEvidenceFreshness({
      evidence: [hmsEvidence({ expiresAt, toolId: 'hms_quote_stay' })],
      now: new Date(observedAt + QUOTE_EVIDENCE_TTL_MS - 1_000),
    });
    const stale = evaluateHmsEvidenceFreshness({
      evidence: [hmsEvidence({ expiresAt, toolId: 'hms_quote_stay' })],
      now: new Date(observedAt + QUOTE_EVIDENCE_TTL_MS + 1_000),
    });
    expect(fresh).toBe('fresh');
    expect(stale).toBe('stale_evidence');
  });

  it('applies reservation TTL per field policy (shorter than quote)', () => {
    expect(RESERVATION_EVIDENCE_TTL_MS).toBeLessThan(QUOTE_EVIDENCE_TTL_MS);
    const observedAt = Date.parse('2026-07-30T12:00:00.000Z');
    const expiresAt = new Date(observedAt + RESERVATION_EVIDENCE_TTL_MS).toISOString();
    expect(
      evaluateHmsEvidenceFreshness({
        evidence: [hmsEvidence({ expiresAt, toolId: 'hms_find_reservation' })],
        now: new Date(observedAt + RESERVATION_EVIDENCE_TTL_MS + 1),
      }),
    ).toBe('stale_evidence');
  });

  it('marks attachment hash change stale', () => {
    const evidence = [mailEvidence()];
    expect(
      evaluateHmsEvidenceFreshness({
        evidence,
        attachmentSourceHashes: new Map([['att-1', sha('attachment-body')]]),
      }),
    ).toBe('fresh');
    expect(
      evaluateHmsEvidenceFreshness({
        evidence,
        attachmentSourceHashes: new Map([['att-1', sha('changed')]]),
      }),
    ).toBe('stale_evidence');
  });

  it('marks thread version mismatch stale_thread', () => {
    expect(
      evaluateHmsCandidateFreshness({
        threadStateVersion: 'v1',
        liveThreadStateVersion: 'v2',
        evidence: [hmsEvidence({ expiresAt: '2099-01-01T00:00:00.000Z' })],
      }),
    ).toBe('stale_thread');
  });

  it('new message during Refresh prevents final commit via thread version fence', () => {
    const v0 = computeThreadStateVersion({
      messages: [
        { id: 'm1', direction: 'inbound', timestamp: '2026-07-30T10:00:00.000Z' },
      ],
      latestDraftRevisionId: null,
    });
    const v1 = computeThreadStateVersion({
      messages: [
        { id: 'm1', direction: 'inbound', timestamp: '2026-07-30T10:00:00.000Z' },
        { id: 'm2', direction: 'inbound', timestamp: '2026-07-30T10:05:00.000Z' },
      ],
      latestDraftRevisionId: null,
    });
    expect(() => assertThreadStateVersionFresh(v0, v1)).toThrow(ThreadStateStaleError);
  });
});

describe.skipIf(!TEST_DB_AVAILABLE || !reachable)('HMS candidate state (DB)', () => {
  async function seedThread(db: DB) {
    const threadId = randomUUID();
    const parentMessageId = randomUUID();
    await db.insert(mailThread).values({
      id: threadId,
      transportId: TRANSPORT_ID,
      threadRootId: `<${threadId}@example.com>`,
      subject: 'Booking',
      snippet: 'Need help',
      latestMessageAt: new Date('2026-07-30T10:00:00Z'),
    });
    await db.insert(message).values({
      id: parentMessageId,
      transportId: TRANSPORT_ID,
      threadId,
      direction: 'inbound',
      fromAddress: 'guest@example.com',
      toAddresses: ['nava@example.com'],
      subject: 'Booking',
      textBody: 'Need help',
      receivedAt: new Date('2026-07-30T10:00:00Z'),
    });
    const mailbox = await resolveMailboxContext('user-navaai', undefined, db);
    const sessionUser = { id: 'user-navaai', email: '', name: null };
    const dbClientModule = await import('../src/db/client.js');
    dbClientModule.__setDbForTests({ db, conn: null as never });
    const caller = appRouter.createCaller({
      auth: null as never,
      reqHeaders: new Headers(),
      sessionUser,
      ...mailbox,
    });
    return { caller, threadId, parentMessageId, db };
  }

  it('keeps prior candidate visible during queued Refresh', async () => {
    await withSeededTestDb(async (db) => {
      const { caller, threadId, parentMessageId } = await seedThread(db);
      const generationId = randomUUID();
      const draftId = randomUUID();
      const threadStateVersion = computeThreadStateVersion({
        messages: [
          {
            id: parentMessageId,
            direction: 'inbound',
            timestamp: '2026-07-30T10:00:00.000Z',
          },
        ],
        latestDraftRevisionId: null,
      });
      await db.insert(aiDraftGeneration).values({
        id: generationId,
        transportId: TRANSPORT_ID,
        threadId,
        requestedByUserId: 'user-navaai',
        contextMessageIds: [parentMessageId],
        model: 'test',
        promptVersion: 'draft-v1',
        outcome: 'candidate',
        threadStateVersion,
        evidence: [hmsEvidence({ expiresAt: '2099-01-01T00:00:00.000Z' })],
      });
      await db.insert(mailDraft).values({
        id: draftId,
        transportId: TRANSPORT_ID,
        threadId,
        createdByUserId: 'user-navaai',
        status: 'candidate',
        origin: 'ai',
        generationId,
        replyToMessageId: parentMessageId,
        toAddresses: ['guest@example.com'],
        subject: 'Re: Booking',
        textBody: 'Prior candidate',
      });

      const refresh = await caller.ai.refreshHmsCandidate({ threadId });
      const state = await caller.ai.hmsCandidateState({ threadId });

      expect(refresh.runId).toBeTruthy();
      expect(state.visibleCandidate?.id).toBe(draftId);
      expect(state.visibleCandidate?.content).toContain('Prior candidate');
      expect(state.activeRun?.id).toBe(refresh.runId);
      expect(state.activeRun?.state).toBe('queued');
      expect(state.outcome).toBe('candidate');
    });
  });

  it('atomic new success replaces visible candidate with newest', async () => {
    await withSeededTestDb(async (db) => {
      const { threadId, parentMessageId } = await seedThread(db);
      const olderGen = randomUUID();
      const newerGen = randomUUID();
      const olderDraft = randomUUID();
      const newerDraft = randomUUID();
      const threadStateVersion = computeThreadStateVersion({
        messages: [
          {
            id: parentMessageId,
            direction: 'inbound',
            timestamp: '2026-07-30T10:00:00.000Z',
          },
        ],
        latestDraftRevisionId: null,
      });
      await db.insert(aiDraftGeneration).values([
        {
          id: olderGen,
          transportId: TRANSPORT_ID,
          threadId,
          requestedByUserId: 'user-navaai',
          contextMessageIds: [parentMessageId],
          model: 'test',
          promptVersion: 'draft-v1',
          outcome: 'candidate',
          threadStateVersion,
          evidence: [hmsEvidence({ expiresAt: '2099-01-01T00:00:00.000Z' })],
          createdAt: new Date('2026-07-30T10:01:00Z'),
        },
        {
          id: newerGen,
          transportId: TRANSPORT_ID,
          threadId,
          requestedByUserId: 'user-navaai',
          contextMessageIds: [parentMessageId],
          model: 'test',
          promptVersion: 'draft-v1',
          outcome: 'candidate',
          threadStateVersion,
          evidence: [hmsEvidence({ expiresAt: '2099-01-01T00:00:00.000Z' })],
          createdAt: new Date('2026-07-30T10:02:00Z'),
        },
      ]);
      await db.insert(mailDraft).values([
        {
          id: olderDraft,
          transportId: TRANSPORT_ID,
          threadId,
          createdByUserId: 'user-navaai',
          status: 'candidate',
          origin: 'ai',
          generationId: olderGen,
          replyToMessageId: parentMessageId,
          toAddresses: ['guest@example.com'],
          subject: 'Re: Booking',
          textBody: 'Older',
          updatedAt: new Date('2026-07-30T10:01:00Z'),
        },
        {
          id: newerDraft,
          transportId: TRANSPORT_ID,
          threadId,
          createdByUserId: 'user-navaai',
          status: 'candidate',
          origin: 'ai',
          generationId: newerGen,
          replyToMessageId: parentMessageId,
          toAddresses: ['guest@example.com'],
          subject: 'Re: Booking',
          textBody: 'Newest',
          updatedAt: new Date('2026-07-30T10:02:00Z'),
        },
      ]);

      const state = await loadHmsCandidateState({
        db,
        transportId: TRANSPORT_ID,
        threadId,
      });
      expect(state.visibleCandidate?.id).toBe(newerDraft);
      expect(state.visibleCandidate?.content).toBe('Newest');
    });
  });

  it('later inbound marks candidate stale_thread', async () => {
    await withSeededTestDb(async (db) => {
      const { caller, threadId, parentMessageId } = await seedThread(db);
      const generationId = randomUUID();
      const draftId = randomUUID();
      const threadStateVersion = computeThreadStateVersion({
        messages: [
          {
            id: parentMessageId,
            direction: 'inbound',
            timestamp: '2026-07-30T10:00:00.000Z',
          },
        ],
        latestDraftRevisionId: null,
      });
      await db.insert(aiDraftGeneration).values({
        id: generationId,
        transportId: TRANSPORT_ID,
        threadId,
        requestedByUserId: 'user-navaai',
        contextMessageIds: [parentMessageId],
        model: 'test',
        promptVersion: 'draft-v1',
        outcome: 'candidate',
        threadStateVersion,
        evidence: [hmsEvidence({ expiresAt: '2099-01-01T00:00:00.000Z' })],
      });
      await db.insert(mailDraft).values({
        id: draftId,
        transportId: TRANSPORT_ID,
        threadId,
        createdByUserId: 'user-navaai',
        status: 'candidate',
        origin: 'ai',
        generationId,
        replyToMessageId: parentMessageId,
        toAddresses: ['guest@example.com'],
        subject: 'Re: Booking',
        textBody: 'Candidate',
      });
      await db.insert(message).values({
        id: randomUUID(),
        transportId: TRANSPORT_ID,
        threadId,
        direction: 'inbound',
        fromAddress: 'guest@example.com',
        toAddresses: ['nava@example.com'],
        subject: 'Booking',
        textBody: 'Follow-up',
        receivedAt: new Date('2026-07-30T10:10:00Z'),
      });

      const state = await caller.ai.hmsCandidateState({ threadId });
      expect(state.freshness).toBe('stale_thread');
      expect(state.visibleCandidate?.isStale).toBe(true);
    });
  });

  it('concurrent Refresh idempotency returns same run', async () => {
    await withSeededTestDb(async (db) => {
      const { caller, threadId } = await seedThread(db);
      const first = await caller.ai.refreshHmsCandidate({ threadId });
      const second = await caller.ai.refreshHmsCandidate({ threadId });
      expect(second.runId).toBe(first.runId);
      expect(second.idempotencyKey).toBe(first.idempotencyKey);
      expect(second.idempotencyKey.startsWith('hms-refresh:')).toBe(true);

      const runs = await db
        .select()
        .from(aiWorkflowRun)
        .where(
          and(
            eq(aiWorkflowRun.transportId, TRANSPORT_ID),
            eq(aiWorkflowRun.threadId, threadId),
            eq(aiWorkflowRun.runKind, 'candidate_draft'),
          ),
        );
      expect(runs).toHaveLength(1);
    });
  });

  it('failed Refresh still exposes prior candidate without active run', async () => {
    await withSeededTestDb(async (db) => {
      const { threadId, parentMessageId } = await seedThread(db);
      const generationId = randomUUID();
      const draftId = randomUUID();
      const runId = randomUUID();
      const threadStateVersion = computeThreadStateVersion({
        messages: [
          {
            id: parentMessageId,
            direction: 'inbound',
            timestamp: '2026-07-30T10:00:00.000Z',
          },
        ],
        latestDraftRevisionId: null,
      });
      await db.insert(aiDraftGeneration).values({
        id: generationId,
        transportId: TRANSPORT_ID,
        threadId,
        requestedByUserId: 'user-navaai',
        contextMessageIds: [parentMessageId],
        model: 'test',
        promptVersion: 'draft-v1',
        outcome: 'candidate',
        threadStateVersion,
        evidence: [hmsEvidence({ expiresAt: '2099-01-01T00:00:00.000Z' })],
      });
      await db.insert(mailDraft).values({
        id: draftId,
        transportId: TRANSPORT_ID,
        threadId,
        createdByUserId: 'user-navaai',
        status: 'candidate',
        origin: 'ai',
        generationId,
        replyToMessageId: parentMessageId,
        toAddresses: ['guest@example.com'],
        subject: 'Re: Booking',
        textBody: 'Still visible',
      });
      await db.insert(aiWorkflowRun).values({
        id: runId,
        transportId: TRANSPORT_ID,
        threadId,
        triggerMessageId: parentMessageId,
        runKind: 'candidate_draft',
        idempotencyKey: `hms-refresh-fail:${runId}`,
        modelId: 'test',
        promptVersion: 'draft-v1',
        state: 'dead_letter',
        executorLane: 'hms',
        lastError: 'boom',
      });

      const state = await loadHmsCandidateState({
        db,
        transportId: TRANSPORT_ID,
        threadId,
      });
      expect(state.visibleCandidate?.id).toBe(draftId);
      expect(state.activeRun).toBeNull();
      expect(JSON.stringify(state)).not.toContain('boom');
      expect(JSON.stringify(state)).not.toContain('lastError');
    });
  });

  it('enqueue helper returns same run for identical thread state', async () => {
    await withSeededTestDb(async (db) => {
      const { threadId, parentMessageId } = await seedThread(db);
      const a = await enqueueHmsCandidateRefresh({
        db,
        transportId: TRANSPORT_ID,
        threadId,
        triggerMessageId: parentMessageId,
        requestedByUserId: 'user-navaai',
      });
      const b = await enqueueHmsCandidateRefresh({
        db,
        transportId: TRANSPORT_ID,
        threadId,
        triggerMessageId: parentMessageId,
        requestedByUserId: 'user-navaai',
      });
      expect(b.runId).toBe(a.runId);
    });
  });
});
