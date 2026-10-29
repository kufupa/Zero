import {
  aiDraftGeneration,
  aiWorkflowRun,
  mailDraft,
  mailDraftRevision,
  mailThread,
  message,
  outboundSendQueue,
} from '../src/db/schema/mail.js';
import {
  __forceSendAtPastForTests,
  __setOutboundAttemptFenceHookForTests,
  flushDue,
} from '../src/mail/send/outbound-queue.js';
import { __setSmtpTransportForTests, type SmtpTransport } from '../src/mail/send/smtp.js';
import { TEST_DB_AVAILABLE, probeTestDb, withSeededTestDb } from './helpers/test-db';
import { __setDraftCreateConflictHookForTests } from '../src/trpc/routes/drafts.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { copyFileSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import * as draftApprovalModule from '../src/ai/draft-approval.js';
import { loadLiveThreadStateVersion } from '../src/ai/drafts.js';
import { quoteSourceBusyError } from '../src/hms/quote-source-contention.js';
import { callerFor } from './helpers/trpc-caller';
import { TRANSPORT_ID } from '../src/db/seed.js';
import type { DB } from '../src/db/client.js';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const reachable = await probeTestDb();

const previousUndoSendSeconds = process.env.UNDO_SEND_SECONDS;
const previousSelfBcc = process.env.MAIL_SELF_BCC;
const initialModelRoute = process.env.AI_MODEL_ROUTE;
const initialDraftConfig = process.env.AI_APPROVED_LOCAL_DRAFT_CONFIG;
const initialDraftsEnabled = process.env.AI_DRAFTS_ENABLED;
const initialSigningSecret = process.env.BETTER_AUTH_SECRET;

const TRUSTED_DRAFT_MODULE = new URL('./fixtures/u6-approved-local-draft.cjs', import.meta.url)
  .pathname;
const TRUSTED_DRAFT_ROUTE = {
  routeId: 'u6-configured-draft-route',
  modelId: 'u6-configured-draft-model',
  purpose: 'draft' as const,
  protocol: 'in_process' as const,
  access: 'current_app' as const,
  egress: 'none' as const,
  retention: 'bounded' as const,
  usage: 'reported' as const,
};
const TRUSTED_DRAFT_RELEASE = {
  releaseId: 'u6-stale-conflict-release-a',
  releaseVersion: '2026.09.10.1',
  sourceRevision: 'u6-stale-conflict-source-a',
  fingerprint: 'd'.repeat(64),
  purpose: 'draft' as const,
  capabilityFamilyVersions: { draft: 'u6-draft-v1' },
  issuedAt: '2026-09-01T00:00:00.000Z',
  expiresAt: '2099-01-01T00:00:00.000Z',
  withdrawn: false,
};

function trustedDraftConfig(): string {
  return JSON.stringify({
    module: TRUSTED_DRAFT_MODULE,
    route: TRUSTED_DRAFT_ROUTE,
    release: TRUSTED_DRAFT_RELEASE,
  });
}

async function insertTrustedCandidateRun(
  db: DB,
  input: { generationId: string; threadId: string; triggerMessageId: string },
): Promise<void> {
  const runId = randomUUID();
  await db.insert(aiWorkflowRun).values({
    id: runId,
    transportId: TRANSPORT_ID,
    threadId: input.threadId,
    triggerMessageId: input.triggerMessageId,
    runKind: 'candidate_draft',
    idempotencyKey: `u6-trusted-candidate:${runId}`,
    modelId: TRUSTED_DRAFT_ROUTE.modelId,
    promptVersion: 'draft-v1',
    state: 'succeeded',
    executorLane: 'default',
    generationId: input.generationId,
    metrics: { routeBinding: { ...TRUSTED_DRAFT_ROUTE, release: TRUSTED_DRAFT_RELEASE } },
    finishedAt: new Date(),
  });
}

async function seedIdlessConflictDraft(db: DB): Promise<{
  threadId: string;
  draftId: string;
}> {
  const threadId = randomUUID();
  const draftId = randomUUID();
  await db.insert(mailThread).values({
    id: threadId,
    transportId: TRANSPORT_ID,
    threadRootId: `<${threadId}@example.com>`,
    subject: 'Booking',
    snippet: 'Please confirm',
    latestMessageAt: new Date('2026-09-10T10:00:00Z'),
  });
  await db.insert(mailDraft).values({
    id: draftId,
    transportId: TRANSPORT_ID,
    threadId,
    createdByUserId: 'user-navaai',
    status: 'active',
    origin: 'manual',
    toAddresses: ['guest@example.com'],
    subject: 'Re: Booking',
    textBody: 'Original body',
    htmlBody: '<p>Original body</p>',
  });
  return { threadId, draftId };
}

afterEach(() => {
  vi.restoreAllMocks();
  __setDraftCreateConflictHookForTests(null);
  __setOutboundAttemptFenceHookForTests(null);
  __setSmtpTransportForTests(null);
  if (previousUndoSendSeconds === undefined) delete process.env.UNDO_SEND_SECONDS;
  else process.env.UNDO_SEND_SECONDS = previousUndoSendSeconds;
  if (previousSelfBcc === undefined) delete process.env.MAIL_SELF_BCC;
  else process.env.MAIL_SELF_BCC = previousSelfBcc;
  if (initialModelRoute === undefined) delete process.env.AI_MODEL_ROUTE;
  else process.env.AI_MODEL_ROUTE = initialModelRoute;
  if (initialDraftConfig === undefined) delete process.env.AI_APPROVED_LOCAL_DRAFT_CONFIG;
  else process.env.AI_APPROVED_LOCAL_DRAFT_CONFIG = initialDraftConfig;
  if (initialDraftsEnabled === undefined) delete process.env.AI_DRAFTS_ENABLED;
  else process.env.AI_DRAFTS_ENABLED = initialDraftsEnabled;
  if (initialSigningSecret === undefined) delete process.env.BETTER_AUTH_SECRET;
  else process.env.BETTER_AUTH_SECRET = initialSigningSecret;
});

beforeEach(() => {
  process.env.AI_DRAFTS_ENABLED = 'true';
  process.env.AI_MODEL_ROUTE = 'approved-local';
  process.env.AI_APPROVED_LOCAL_DRAFT_CONFIG = trustedDraftConfig();
  process.env.BETTER_AUTH_SECRET = 'synthetic-draft-approval-test-secret';
});

describe.skipIf(!TEST_DB_AVAILABLE || !reachable)('stale draft conflict', () => {
  it('records an edited revision when an id-less threaded save resolves an active conflict', async () => {
    await withSeededTestDb(async (db) => {
      const threadId = randomUUID();
      const draftId = randomUUID();
      await db.insert(mailThread).values({
        id: threadId,
        transportId: TRANSPORT_ID,
        threadRootId: `<${threadId}@example.com>`,
        subject: 'Booking',
        snippet: 'Please confirm',
        latestMessageAt: new Date('2026-09-10T10:00:00Z'),
      });
      await db.insert(mailDraft).values({
        id: draftId,
        transportId: TRANSPORT_ID,
        threadId,
        createdByUserId: 'user-navaai',
        status: 'active',
        origin: 'manual',
        toAddresses: ['guest@example.com'],
        subject: 'Re: Booking',
        textBody: 'Original body',
        htmlBody: '<p>Original body</p>',
      });

      const caller = await callerFor('user-navaai', {
        db,
        requestedTransportId: TRANSPORT_ID,
      });
      await expect(
        caller.drafts.create({
          id: null,
          threadId,
          to: 'guest@example.com',
          subject: 'Re: Booking',
          message: '<p>Edited body</p>',
          body: '<p>Edited body</p>',
          attachments: [],
        }),
      ).resolves.toEqual({ id: draftId });

      const [draft] = await db
        .select({ textBody: mailDraft.textBody, htmlBody: mailDraft.htmlBody })
        .from(mailDraft)
        .where(eq(mailDraft.id, draftId));
      expect(draft).toEqual({ textBody: '<p>Edited body</p>', htmlBody: '<p>Edited body</p>' });
      const [revision] = await db
        .select({ kind: mailDraftRevision.kind, textBody: mailDraftRevision.textBody })
        .from(mailDraftRevision)
        .where(eq(mailDraftRevision.draftId, draftId));
      expect(revision).toEqual({ kind: 'edited', textBody: '<p>Edited body</p>' });
    });
  }, 30000);

  it('rejects an id-less conflict save after the actual draft is enqueued', async () => {
    await withSeededTestDb(async (db) => {
      process.env.UNDO_SEND_SECONDS = '30';
      process.env.MAIL_SELF_BCC = 'false';
      const { threadId, draftId } = await seedIdlessConflictDraft(db);
      const caller = await callerFor('user-navaai', {
        db,
        requestedTransportId: TRANSPORT_ID,
      });
      let queuedMessageId: string | undefined;
      __setDraftCreateConflictHookForTests(async () => {
        const queued = await caller.mail.send({
          threadId,
          draftId,
          to: ['guest@example.com'],
          subject: 'Re: Booking',
          message: '<p>Original body</p>',
        });
        expect(queued).toMatchObject({ queued: true });
        queuedMessageId = queued.messageId;
      });

      await expect(
        caller.drafts.create({
          id: null,
          threadId,
          to: 'guest@example.com',
          subject: 'Re: Booking edited',
          message: '<p>Edited after enqueue</p>',
          body: '<p>Edited after enqueue</p>',
          attachments: [],
        }),
      ).rejects.toMatchObject({ code: 'CONFLICT', message: 'DRAFT_SEND_CLAIMED' });

      expect(queuedMessageId).toBeTruthy();
      const [draft] = await db
        .select({
          status: mailDraft.status,
          isSent: mailDraft.isSent,
          htmlBody: mailDraft.htmlBody,
        })
        .from(mailDraft)
        .where(eq(mailDraft.id, draftId));
      expect(draft).toEqual({
        status: 'sent',
        isSent: true,
        htmlBody: '<p>Original body</p>',
      });
      const editedRevisions = await db
        .select({ id: mailDraftRevision.id })
        .from(mailDraftRevision)
        .where(and(eq(mailDraftRevision.draftId, draftId), eq(mailDraftRevision.kind, 'edited')));
      expect(editedRevisions).toHaveLength(0);
      const [queue] = await db
        .select({ status: outboundSendQueue.status })
        .from(outboundSendQueue)
        .where(eq(outboundSendQueue.messageId, queuedMessageId!));
      expect(queue?.status).toBe('pending');
    });
  }, 30000);

  it('rejects an id-less conflict save after one unknown SMTP attempt', async () => {
    await withSeededTestDb(async (db) => {
      process.env.UNDO_SEND_SECONDS = '0';
      process.env.MAIL_SELF_BCC = 'false';
      const { threadId, draftId } = await seedIdlessConflictDraft(db);
      const caller = await callerFor('user-navaai', {
        db,
        requestedTransportId: TRANSPORT_ID,
      });
      const smtpSend = vi
        .fn<SmtpTransport['send']>()
        .mockRejectedValue(new Error('synthetic idless SMTP outcome unknown'));
      __setSmtpTransportForTests({ kind: 'fake', send: smtpSend });
      let attemptResult: unknown;
      __setDraftCreateConflictHookForTests(async () => {
        attemptResult = await caller.mail.send({
          threadId,
          draftId,
          to: ['guest@example.com'],
          subject: 'Re: Booking',
          message: '<p>Original body</p>',
        });
      });

      await expect(
        caller.drafts.create({
          id: null,
          threadId,
          to: 'guest@example.com',
          subject: 'Re: Booking edited',
          message: '<p>Edited after attempt</p>',
          body: '<p>Edited after attempt</p>',
          attachments: [],
        }),
      ).rejects.toMatchObject({ code: 'CONFLICT', message: 'DRAFT_SEND_CLAIMED' });

      expect(attemptResult).toMatchObject({ sent: false, delivery: 'unknown' });
      expect(smtpSend).toHaveBeenCalledTimes(1);
      const [draft] = await db
        .select({
          status: mailDraft.status,
          isSent: mailDraft.isSent,
          htmlBody: mailDraft.htmlBody,
        })
        .from(mailDraft)
        .where(eq(mailDraft.id, draftId));
      expect(draft).toEqual({
        status: 'sent',
        isSent: true,
        htmlBody: '<p>Original body</p>',
      });
      const editedRevisions = await db
        .select({ id: mailDraftRevision.id })
        .from(mailDraftRevision)
        .where(and(eq(mailDraftRevision.draftId, draftId), eq(mailDraftRevision.kind, 'edited')));
      expect(editedRevisions).toHaveLength(0);
      const [queue] = await db
        .select({ status: outboundSendQueue.status, lastError: outboundSendQueue.lastError })
        .from(outboundSendQueue)
        .where(eq(outboundSendQueue.transportId, TRANSPORT_ID));
      expect(queue?.status).toBe('sending');
      expect(queue?.lastError).toContain('SMTP_DELIVERY_OUTCOME_UNKNOWN');
    });
  }, 30000);

  it('rejects an AI approval when the succeeded run has no trusted route release', async () => {
    const previousModelRoute = process.env.AI_MODEL_ROUTE;
    const previousDraftConfig = process.env.AI_APPROVED_LOCAL_DRAFT_CONFIG;
    delete process.env.AI_MODEL_ROUTE;
    delete process.env.AI_APPROVED_LOCAL_DRAFT_CONFIG;
    try {
      await withSeededTestDb(async (db) => {
        const threadId = randomUUID();
        const parentMessageId = randomUUID();
        const draftId = randomUUID();
        const generationId = randomUUID();
        const runId = randomUUID();
        const revisionId = randomUUID();
        const body = '<p>Legacy approval body</p>';
        const evidence = {
          kind: 'hms' as const,
          id: `evidence-${generationId}`,
          toolId: 'hms_quote_stay',
          toolVersion: '1',
          propertyCode: 'HRCEN',
          observedAt: '2026-09-09T10:00:00.000Z',
          expiresAt: '2099-01-01T00:00:00.000Z',
          claimKeys: ['rate'],
          sourceHash: '1'.repeat(64),
          scopeVerified: true,
        };
        await db.insert(mailThread).values({
          id: threadId,
          transportId: TRANSPORT_ID,
          threadRootId: `<${threadId}@example.com>`,
          subject: 'Booking',
          snippet: 'Legacy approval',
          latestMessageAt: new Date('2026-09-10T10:00:00Z'),
        });
        await db.insert(message).values({
          id: parentMessageId,
          transportId: TRANSPORT_ID,
          threadId,
          direction: 'inbound',
          fromAddress: 'guest@example.com',
          toAddresses: ['nava@example.com'],
          subject: 'Booking',
          textBody: 'Please confirm the reservation.',
          receivedAt: new Date('2026-09-10T10:00:00Z'),
        });
        const threadStateVersion = await loadLiveThreadStateVersion(db, {
          transportId: TRANSPORT_ID,
          threadId,
        });
        await db.insert(aiDraftGeneration).values({
          id: generationId,
          transportId: TRANSPORT_ID,
          threadId,
          requestedByUserId: 'user-navaai',
          contextMessageIds: [parentMessageId],
          model: 'legacy-route-model',
          promptVersion: 'draft-v1',
          status: 'succeeded',
          outcome: 'candidate',
          threadStateVersion,
          evidence: [evidence],
        });
        await db.insert(mailDraft).values({
          id: draftId,
          transportId: TRANSPORT_ID,
          threadId,
          createdByUserId: 'user-navaai',
          status: 'active',
          origin: 'ai',
          generationId,
          replyToMessageId: parentMessageId,
          toAddresses: ['guest@example.com'],
          subject: 'Re: Booking',
          textBody: 'Legacy approval body',
          htmlBody: body,
        });
        await db.insert(mailDraftRevision).values({
          id: revisionId,
          draftId,
          generationId,
          actorUserId: 'user-navaai',
          kind: 'ai_generated',
          toAddresses: ['guest@example.com'],
          ccAddresses: [],
          bccAddresses: [],
          subject: 'Re: Booking',
          textBody: 'Legacy approval body',
          htmlBody: body,
          attachments: [],
        });
        const coarseRoute = {
          routeId: 'legacy-coarse-route',
          modelId: 'legacy-coarse-model',
          purpose: 'draft' as const,
          protocol: 'in_process' as const,
          access: 'current_app' as const,
          egress: 'none' as const,
          retention: 'bounded' as const,
          usage: 'reported' as const,
        };
        await db.insert(aiWorkflowRun).values({
          id: runId,
          transportId: TRANSPORT_ID,
          threadId,
          triggerMessageId: parentMessageId,
          runKind: 'candidate_draft',
          idempotencyKey: `u6-legacy-route:${runId}`,
          modelId: 'legacy-route-model',
          promptVersion: 'draft-v1',
          state: 'succeeded',
          executorLane: 'default',
          generationId,
          metrics: { routeBinding: coarseRoute },
          finishedAt: new Date(),
        });

        const caller = await callerFor('user-navaai', {
          db,
          requestedTransportId: TRANSPORT_ID,
        });
        await expect(
          caller.drafts.approve({
            draftId,
            subject: 'Re: Booking',
            html: body,
            text: '',
            to: ['guest@example.com'],
            cc: [],
            bcc: [],
            attachments: [],
          }),
        ).rejects.toMatchObject({ code: 'CONFLICT', message: 'DRAFT_APPROVAL_INVALID' });

        // A generation with no succeeded candidate run is equally unable to
        // establish trusted AI provenance; do not let the server signer turn
        // the legacy draft into an approval.
        await db
          .update(aiWorkflowRun)
          .set({ state: 'dead_letter' })
          .where(eq(aiWorkflowRun.id, runId));
        await expect(
          caller.drafts.approve({
            draftId,
            subject: 'Re: Booking',
            html: body,
            text: '',
            to: ['guest@example.com'],
            cc: [],
            bcc: [],
            attachments: [],
          }),
        ).rejects.toMatchObject({ code: 'CONFLICT', message: 'DRAFT_APPROVAL_INVALID' });
        await db
          .update(aiWorkflowRun)
          .set({ state: 'succeeded' })
          .where(eq(aiWorkflowRun.id, runId));
      });
    } finally {
      if (previousModelRoute === undefined) delete process.env.AI_MODEL_ROUTE;
      else process.env.AI_MODEL_ROUTE = previousModelRoute;
      if (previousDraftConfig === undefined) delete process.env.AI_APPROVED_LOCAL_DRAFT_CONFIG;
      else process.env.AI_APPROVED_LOCAL_DRAFT_CONFIG = previousDraftConfig;
    }
  }, 30000);

  it('rejects stale draft send until caller confirms, then writes sent revision', async () => {
    await withSeededTestDb(async (db) => {
      process.env.UNDO_SEND_SECONDS = '0';
      const threadId = randomUUID();
      const parentMessageId = randomUUID();
      const newerMessageId = randomUUID();
      const draftId = randomUUID();

      await db.insert(mailThread).values({
        id: threadId,
        transportId: TRANSPORT_ID,
        threadRootId: `<${threadId}@example.com>`,
        subject: 'Booking',
        snippet: 'New reply',
        latestMessageAt: new Date('2026-07-06T10:05:00Z'),
      });
      await db.insert(message).values([
        {
          id: parentMessageId,
          transportId: TRANSPORT_ID,
          threadId,
          direction: 'inbound',
          fromAddress: 'guest@example.com',
          toAddresses: ['nava@example.com'],
          subject: 'Booking',
          textBody: 'First message',
          receivedAt: new Date('2026-07-06T10:00:00Z'),
        },
        {
          id: newerMessageId,
          transportId: TRANSPORT_ID,
          threadId,
          direction: 'inbound',
          fromAddress: 'guest@example.com',
          toAddresses: ['nava@example.com'],
          subject: 'Booking',
          textBody: 'New reply',
          receivedAt: new Date('2026-07-06T10:05:00Z'),
        },
      ]);
      await db.insert(mailDraft).values({
        id: draftId,
        transportId: TRANSPORT_ID,
        threadId,
        createdByUserId: 'user-navaai',
        status: 'active',
        origin: 'manual',
        replyToMessageId: parentMessageId,
        toAddresses: ['guest@example.com'],
        subject: 'Re: Booking',
        textBody: 'Old draft',
        htmlBody: '<p>Old draft</p>',
      });

      const { mail } = await callerFor('user-navaai', {
        db,
        requestedTransportId: TRANSPORT_ID,
      });
      await expect(
        mail.send({
          threadId,
          draftId,
          to: ['guest@example.com'],
          subject: 'Re: Booking',
          message: '<p>Old draft</p>',
        }),
      ).rejects.toMatchObject({ code: 'CONFLICT', message: 'STALE_DRAFT' });

      await expect(
        mail.send({
          threadId,
          draftId,
          to: ['guest@example.com'],
          subject: 'Re: Booking',
          message: '<p>Old draft</p>',
          confirmStaleDraft: true,
        }),
      ).resolves.toMatchObject({ sent: true });

      const revisions = await db.select().from(mailDraftRevision);
      expect(revisions.some((revision) => revision.kind === 'sent')).toBe(true);
    });
  });

  it('never allows stale HMS AI send override via confirmStaleDraft', async () => {
    await withSeededTestDb(async (db) => {
      const threadId = randomUUID();
      const parentMessageId = randomUUID();
      const draftId = randomUUID();
      const generationId = randomUUID();

      await db.insert(mailThread).values({
        id: threadId,
        transportId: TRANSPORT_ID,
        threadRootId: `<${threadId}@example.com>`,
        subject: 'Booking',
        snippet: 'Need help',
        latestMessageAt: new Date('2026-07-06T10:00:00Z'),
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
        receivedAt: new Date('2026-07-06T10:00:00Z'),
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
        threadStateVersion: 'not-the-live-version',
        evidence: [
          {
            kind: 'hms',
            id: 'ev-1',
            toolId: 'hms_quote_stay',
            toolVersion: '1',
            propertyCode: 'CEN',
            observedAt: '2026-07-06T10:00:00.000Z',
            expiresAt: '2099-01-01T00:00:00.000Z',
            claimKeys: ['rate'],
            sourceHash: 'b'.repeat(64),
          },
        ],
      });
      await db.insert(mailDraft).values({
        id: draftId,
        transportId: TRANSPORT_ID,
        threadId,
        createdByUserId: 'user-navaai',
        status: 'active',
        origin: 'ai',
        generationId,
        replyToMessageId: parentMessageId,
        toAddresses: ['guest@example.com'],
        subject: 'Re: Booking',
        textBody: 'HMS draft',
        htmlBody: '<p>HMS draft</p>',
      });

      const { mail } = await callerFor('user-navaai', {
        db,
        requestedTransportId: TRANSPORT_ID,
      });
      await expect(
        mail.send({
          threadId,
          draftId,
          to: ['guest@example.com'],
          subject: 'Re: Booking',
          message: '<p>HMS draft</p>',
          confirmStaleDraft: true,
        }),
      ).rejects.toMatchObject({
        code: 'CONFLICT',
        message: 'STALE_AI_DRAFT',
      });
    });
  });

  it('off-mode skeleton AI send never bypasses approval with confirmStaleDraft', async () => {
    await withSeededTestDb(async (db) => {
      const threadId = randomUUID();
      const parentMessageId = randomUUID();
      const newerMessageId = randomUUID();
      const draftId = randomUUID();
      const generationId = randomUUID();

      await db.insert(mailThread).values({
        id: threadId,
        transportId: TRANSPORT_ID,
        threadRootId: `<${threadId}@example.com>`,
        subject: 'Booking',
        snippet: 'New reply',
        latestMessageAt: new Date('2026-07-06T10:05:00Z'),
      });
      await db.insert(message).values([
        {
          id: parentMessageId,
          transportId: TRANSPORT_ID,
          threadId,
          direction: 'inbound',
          fromAddress: 'guest@example.com',
          toAddresses: ['nava@example.com'],
          subject: 'Booking',
          textBody: 'First',
          receivedAt: new Date('2026-07-06T10:00:00Z'),
        },
        {
          id: newerMessageId,
          transportId: TRANSPORT_ID,
          threadId,
          direction: 'inbound',
          fromAddress: 'guest@example.com',
          toAddresses: ['nava@example.com'],
          subject: 'Booking',
          textBody: 'Newer',
          receivedAt: new Date('2026-07-06T10:05:00Z'),
        },
      ]);
      await db.insert(aiDraftGeneration).values({
        id: generationId,
        transportId: TRANSPORT_ID,
        threadId,
        requestedByUserId: 'user-navaai',
        contextMessageIds: [parentMessageId],
        model: 'test',
        promptVersion: 'draft-v1',
      });
      await db.insert(mailDraft).values({
        id: draftId,
        transportId: TRANSPORT_ID,
        threadId,
        createdByUserId: 'user-navaai',
        status: 'active',
        origin: 'ai',
        generationId,
        replyToMessageId: parentMessageId,
        toAddresses: ['guest@example.com'],
        subject: 'Re: Booking',
        textBody: 'Skeleton',
        htmlBody: '<p>Skeleton</p>',
      });

      const { mail } = await callerFor('user-navaai', {
        db,
        requestedTransportId: TRANSPORT_ID,
      });
      await expect(
        mail.send({
          threadId,
          draftId,
          to: ['guest@example.com'],
          subject: 'Re: Booking',
          message: '<p>Skeleton</p>',
        }),
      ).rejects.toMatchObject({ code: 'CONFLICT', message: 'DRAFT_APPROVAL_REQUIRED' });

      await expect(
        mail.send({
          threadId,
          draftId,
          to: ['guest@example.com'],
          subject: 'Re: Booking',
          message: '<p>Skeleton</p>',
          confirmStaleDraft: true,
        }),
      ).rejects.toMatchObject({ code: 'CONFLICT', message: 'DRAFT_APPROVAL_REQUIRED' });
    });
  });

  it('requires explicit approval and rechecks it at the real queue transmission boundary', async () => {
    await withSeededTestDb(async (db) => {
      process.env.UNDO_SEND_SECONDS = '0';
      process.env.MAIL_SELF_BCC = 'false';
      const threadId = randomUUID();
      const parentMessageId = randomUUID();
      const draftId = randomUUID();
      const generationId = randomUUID();
      const body = '<p>Approved guest reply</p>';
      const evidence = {
        kind: 'hms' as const,
        id: `evidence-${generationId}`,
        toolId: 'hms_quote_stay',
        toolVersion: '1',
        propertyCode: 'HRCEN',
        observedAt: '2026-07-06T10:00:00.000Z',
        expiresAt: '2099-01-01T00:00:00.000Z',
        claimKeys: ['rate'],
        sourceHash: 'a'.repeat(64),
        scopeVerified: true,
      };

      await db.insert(mailThread).values({
        id: threadId,
        transportId: TRANSPORT_ID,
        threadRootId: `<${threadId}@example.com>`,
        subject: 'Booking',
        snippet: 'Need help',
        latestMessageAt: new Date('2026-07-06T10:00:00Z'),
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
        receivedAt: new Date('2026-07-06T10:00:00Z'),
      });
      const threadStateVersion = await loadLiveThreadStateVersion(db, {
        transportId: TRANSPORT_ID,
        threadId,
      });
      await db.insert(aiDraftGeneration).values({
        id: generationId,
        transportId: TRANSPORT_ID,
        threadId,
        requestedByUserId: 'user-navaai',
        contextMessageIds: [parentMessageId],
        model: 'approved-local-test',
        promptVersion: 'draft-v1',
        status: 'succeeded',
        outcome: 'candidate',
        threadStateVersion,
        evidence: [evidence],
      });
      await db.insert(mailDraft).values({
        id: draftId,
        transportId: TRANSPORT_ID,
        threadId,
        createdByUserId: 'user-navaai',
        status: 'active',
        origin: 'ai',
        generationId,
        replyToMessageId: parentMessageId,
        toAddresses: ['guest@example.com'],
        subject: 'Re: Booking',
        textBody: 'Candidate',
        htmlBody: body,
      });
      const revisionId = randomUUID();
      await db.insert(mailDraftRevision).values({
        id: revisionId,
        draftId,
        generationId,
        actorUserId: 'user-navaai',
        kind: 'ai_generated',
        toAddresses: ['guest@example.com'],
        ccAddresses: [],
        bccAddresses: [],
        subject: 'Re: Booking',
        textBody: 'Candidate',
        htmlBody: body,
        attachments: [],
      });
      await insertTrustedCandidateRun(db, {
        generationId,
        threadId,
        triggerMessageId: parentMessageId,
      });

      const caller = await callerFor('user-navaai', {
        db,
        requestedTransportId: TRANSPORT_ID,
      });
      await expect(
        caller.mail.send({
          threadId,
          draftId,
          to: ['guest@example.com'],
          subject: 'Re: Booking',
          message: body,
        }),
      ).rejects.toMatchObject({ code: 'CONFLICT', message: 'DRAFT_APPROVAL_REQUIRED' });

      const approval = await caller.drafts.approve({
        draftId,
        subject: 'Re: Booking',
        html: body,
        text: '',
        to: ['guest@example.com'],
        cc: [],
        bcc: [],
        attachments: [],
      });
      const smtpSend = vi.fn<SmtpTransport['send']>().mockResolvedValue({
        messageId: 'approved@zero.test',
        accepted: ['guest@example.com'],
        rejected: [],
      });
      __setSmtpTransportForTests({ kind: 'fake', send: smtpSend });

      const result = await caller.mail.send({
        threadId,
        draftId,
        to: ['guest@example.com'],
        subject: 'Re: Booking',
        message: body,
        draftApproval: approval,
      });
      expect(result).toMatchObject({ sent: true, delivery: 'full' });
      expect(smtpSend).toHaveBeenCalledTimes(1);

      const [queue] = await db
        .select()
        .from(outboundSendQueue)
        .where(
          and(
            eq(outboundSendQueue.messageId, result.messageId),
            eq(outboundSendQueue.transportId, TRANSPORT_ID),
          ),
        )
        .limit(1);
      expect(queue?.status).toBe('sent');
      expect(queue?.smtpPayload).toMatchObject({ draftApproval: approval });
    });
  }, 30000);

  it.each([
    ['preflight', 0, false], ['claim', 0, false],
    ['preflight', 30, false], ['claim', 30, false], ['claim', 30, true],
  ] as const)('defers a busy %s with undo=%i and rechecks changed=%s', async (phase, undo, changed) => {
    await withSeededTestDb(async (db) => {
      process.env.UNDO_SEND_SECONDS = String(undo);
      process.env.MAIL_SELF_BCC = 'false';
      const threadId = randomUUID(), parentMessageId = randomUUID(), draftId = randomUUID();
      const generationId = randomUUID(), revisionId = randomUUID(), body = '<p>Approved guest reply</p>';
      const evidence = { kind: 'hms' as const, id: `evidence-${generationId}`, toolId: 'hms_quote_stay',
        toolVersion: '1', propertyCode: 'HRCEN', observedAt: '2026-07-06T10:00:00.000Z',
        expiresAt: '2099-01-01T00:00:00.000Z', claimKeys: ['rate'], sourceHash: 'a'.repeat(64), scopeVerified: true };
      await db.insert(mailThread).values({ id: threadId, transportId: TRANSPORT_ID,
        threadRootId: `<${threadId}@example.com>`, subject: 'Booking' });
      await db.insert(message).values({ id: parentMessageId, transportId: TRANSPORT_ID, threadId,
        direction: 'inbound', fromAddress: 'guest@example.com', toAddresses: ['nava@example.com'],
        subject: 'Booking', textBody: 'Need help', receivedAt: new Date('2026-07-06T10:00:00Z') });
      const threadStateVersion = await loadLiveThreadStateVersion(db, { transportId: TRANSPORT_ID, threadId });
      await db.insert(aiDraftGeneration).values({ id: generationId, transportId: TRANSPORT_ID, threadId,
        requestedByUserId: 'user-navaai', contextMessageIds: [parentMessageId], model: 'approved-local-test',
        promptVersion: 'draft-v1', status: 'succeeded', outcome: 'candidate', threadStateVersion, evidence: [evidence] });
      await db.insert(mailDraft).values({ id: draftId, transportId: TRANSPORT_ID, threadId,
        createdByUserId: 'user-navaai', status: 'active', origin: 'ai', generationId,
        replyToMessageId: parentMessageId, toAddresses: ['guest@example.com'], subject: 'Re: Booking', htmlBody: body });
      await db.insert(mailDraftRevision).values({ id: revisionId, draftId, generationId, actorUserId: 'user-navaai',
        kind: 'ai_generated', toAddresses: ['guest@example.com'], ccAddresses: [], bccAddresses: [],
        subject: 'Re: Booking', textBody: 'Candidate', htmlBody: body, attachments: [] });
      await insertTrustedCandidateRun(db, { generationId, threadId, triggerMessageId: parentMessageId });
      const caller = await callerFor('user-navaai', { db, requestedTransportId: TRANSPORT_ID });
      const approval = await caller.drafts.approve({ draftId, subject: 'Re: Booking', html: body, text: '',
        to: ['guest@example.com'], cc: [], bcc: [], attachments: [] });
      const smtpSend = vi.fn<SmtpTransport['send']>().mockResolvedValue({ messageId: 'deferred@zero.test',
        accepted: ['guest@example.com'], rejected: [] });
      __setSmtpTransportForTests({ kind: 'fake', send: smtpSend });
      const assertCurrent = draftApprovalModule.assertDraftApprovalCurrent;
      let busy = true;
      vi.spyOn(draftApprovalModule, 'assertDraftApprovalCurrent').mockImplementation(async (input) => {
        if (busy && input.queueMessageId && (phase === 'claim' ? input.lockQuoteOrigin : !input.lockQuoteOrigin)) {
          const [draft] = await input.db.select({ isSent: mailDraft.isSent }).from(mailDraft).where(eq(mailDraft.id, draftId));
          if (draft?.isSent) throw quoteSourceBusyError();
        }
        return assertCurrent(input);
      });
      const queued = await caller.mail.send({ threadId, draftId, to: ['guest@example.com'],
        subject: 'Re: Booking', message: body, draftApproval: approval });
      expect(queued).toMatchObject({ queued: true });
      if (undo > 0) {
        await __forceSendAtPastForTests(queued.messageId, TRANSPORT_ID, db);
        await expect(flushDue({ db })).resolves.toEqual({ flushed: 0 });
      }
      const [held] = await db.select().from(outboundSendQueue).where(eq(outboundSendQueue.messageId, queued.messageId));
      expect(held).toMatchObject({ status: 'pending', attempts: 1, smtpAttemptedAt: null,
        lastError: JSON.stringify({ code: 'QUOTE_SOURCE_BUSY' }) });
      expect(held!.sendAt.getTime()).toBeGreaterThan(Date.now());
      expect(smtpSend).not.toHaveBeenCalled();
      const [stillClaimed] = await db.select({ status: mailDraft.status, isSent: mailDraft.isSent })
        .from(mailDraft).where(eq(mailDraft.id, draftId));
      expect(stillClaimed).toEqual({ status: 'sent', isSent: true });
      if (changed) await db.insert(message).values({ id: randomUUID(), transportId: TRANSPORT_ID, threadId,
        direction: 'inbound', fromAddress: 'guest@example.com', textBody: 'Updated request', receivedAt: new Date() });
      busy = false;
      await __forceSendAtPastForTests(queued.messageId, TRANSPORT_ID, db);
      await expect(flushDue({ db })).resolves.toEqual({ flushed: changed ? 0 : 1 });
      expect(smtpSend).toHaveBeenCalledTimes(changed ? 0 : 1);
      const [finalDraft] = await db.select({ status: mailDraft.status, isSent: mailDraft.isSent })
        .from(mailDraft).where(eq(mailDraft.id, draftId));
      expect(finalDraft).toEqual(changed ? { status: 'active', isSent: false } : { status: 'sent', isSent: true });
    });
  }, 30000);

  it('rejects an approval mutation interleaved after validation and before enqueue', async () => {
    await withSeededTestDb(async (db) => {
      process.env.UNDO_SEND_SECONDS = '30';
      process.env.MAIL_SELF_BCC = 'false';
      const threadId = randomUUID();
      const parentMessageId = randomUUID();
      const draftId = randomUUID();
      const generationId = randomUUID();
      const revisionId = randomUUID();
      const body = '<p>Interleaving approval</p>';
      const evidence = {
        kind: 'hms' as const,
        id: `evidence-${generationId}`,
        toolId: 'hms_quote_stay',
        toolVersion: '1',
        propertyCode: 'HRCEN',
        observedAt: '2026-07-06T10:00:00.000Z',
        expiresAt: '2099-01-01T00:00:00.000Z',
        claimKeys: ['rate'],
        sourceHash: 'd'.repeat(64),
        scopeVerified: true,
      };

      await db.insert(mailThread).values({
        id: threadId,
        transportId: TRANSPORT_ID,
        threadRootId: `<${threadId}@example.com>`,
        subject: 'Booking',
        snippet: 'Need help',
        latestMessageAt: new Date('2026-07-06T10:00:00Z'),
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
        receivedAt: new Date('2026-07-06T10:00:00Z'),
      });
      const threadStateVersion = await loadLiveThreadStateVersion(db, {
        transportId: TRANSPORT_ID,
        threadId,
      });
      await db.insert(aiDraftGeneration).values({
        id: generationId,
        transportId: TRANSPORT_ID,
        threadId,
        requestedByUserId: 'user-navaai',
        contextMessageIds: [parentMessageId],
        model: 'approved-local-test',
        promptVersion: 'draft-v1',
        status: 'succeeded',
        outcome: 'candidate',
        threadStateVersion,
        evidence: [evidence],
      });
      await db.insert(mailDraft).values({
        id: draftId,
        transportId: TRANSPORT_ID,
        threadId,
        createdByUserId: 'user-navaai',
        status: 'active',
        origin: 'ai',
        generationId,
        replyToMessageId: parentMessageId,
        toAddresses: ['guest@example.com'],
        subject: 'Re: Booking',
        textBody: 'Candidate',
        htmlBody: body,
      });
      await db.insert(mailDraftRevision).values({
        id: revisionId,
        draftId,
        generationId,
        actorUserId: 'user-navaai',
        kind: 'ai_generated',
        toAddresses: ['guest@example.com'],
        ccAddresses: [],
        bccAddresses: [],
        subject: 'Re: Booking',
        textBody: 'Candidate',
        htmlBody: body,
        attachments: [],
      });
      await insertTrustedCandidateRun(db, {
        generationId,
        threadId,
        triggerMessageId: parentMessageId,
      });

      const caller = await callerFor('user-navaai', {
        db,
        requestedTransportId: TRANSPORT_ID,
      });
      const approval = await caller.drafts.approve({
        draftId,
        subject: 'Re: Booking',
        html: body,
        text: '',
        to: ['guest@example.com'],
        cc: [],
        bcc: [],
        attachments: [],
      });

      const originalAssert = draftApprovalModule.assertDraftApprovalCurrent;
      vi.spyOn(draftApprovalModule, 'assertDraftApprovalCurrent').mockImplementation(
        async (input) => {
          const result = await originalAssert(input);
          // Deterministically invoke the actual EmailComposer save caller
          // after the final pre-enqueue read. The production caller must
          // linearize/reject the now-stale approval before queue insertion.
          await expect(
            caller.drafts.create({
              id: draftId,
              threadId,
              replyToMessageId: parentMessageId,
              to: 'guest@example.com',
              subject: 'Re: Booking (edited)',
              message: '<p>Edited after review</p>',
              body: '<p>Edited after review</p>',
              attachments: [],
            }),
          ).resolves.toEqual({ id: draftId });
          return result;
        },
      );

      await expect(
        caller.mail.send({
          threadId,
          draftId,
          to: ['guest@example.com'],
          subject: 'Re: Booking',
          message: body,
          draftApproval: approval,
        }),
      ).rejects.toMatchObject({ code: 'CONFLICT', message: 'DRAFT_APPROVAL_INVALID' });

      const queued = await db
        .select({ id: outboundSendQueue.id })
        .from(outboundSendQueue)
        .where(eq(outboundSendQueue.transportId, TRANSPORT_ID));
      expect(queued).toHaveLength(0);
    });
  }, 30000);

  it('keeps post-claim editor state coherent when SMTP outcome is unknown', async () => {
    await withSeededTestDb(async (db) => {
      process.env.UNDO_SEND_SECONDS = '30';
      process.env.MAIL_SELF_BCC = 'false';
      const threadId = randomUUID();
      const parentMessageId = randomUUID();
      const draftId = randomUUID();
      const generationId = randomUUID();
      const revisionId = randomUUID();
      const body = '<p>Attempt-fence approval</p>';
      const evidence = {
        kind: 'hms' as const,
        id: `evidence-${generationId}`,
        toolId: 'hms_quote_stay',
        toolVersion: '1',
        propertyCode: 'HRCEN',
        observedAt: '2026-07-06T10:00:00.000Z',
        expiresAt: '2099-01-01T00:00:00.000Z',
        claimKeys: ['rate'],
        sourceHash: 'e'.repeat(64),
        scopeVerified: true,
      };

      await db.insert(mailThread).values({
        id: threadId,
        transportId: TRANSPORT_ID,
        threadRootId: `<${threadId}@example.com>`,
        subject: 'Booking',
        snippet: 'Need help',
        latestMessageAt: new Date('2026-07-06T10:00:00Z'),
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
        receivedAt: new Date('2026-07-06T10:00:00Z'),
      });
      const threadStateVersion = await loadLiveThreadStateVersion(db, {
        transportId: TRANSPORT_ID,
        threadId,
      });
      await db.insert(aiDraftGeneration).values({
        id: generationId,
        transportId: TRANSPORT_ID,
        threadId,
        requestedByUserId: 'user-navaai',
        contextMessageIds: [parentMessageId],
        model: 'approved-local-test',
        promptVersion: 'draft-v1',
        status: 'succeeded',
        outcome: 'candidate',
        threadStateVersion,
        evidence: [evidence],
      });
      await db.insert(mailDraft).values({
        id: draftId,
        transportId: TRANSPORT_ID,
        threadId,
        createdByUserId: 'user-navaai',
        status: 'active',
        origin: 'ai',
        generationId,
        replyToMessageId: parentMessageId,
        toAddresses: ['guest@example.com'],
        subject: 'Re: Booking',
        textBody: 'Candidate',
        htmlBody: body,
      });
      await db.insert(mailDraftRevision).values({
        id: revisionId,
        draftId,
        generationId,
        actorUserId: 'user-navaai',
        kind: 'ai_generated',
        toAddresses: ['guest@example.com'],
        ccAddresses: [],
        bccAddresses: [],
        subject: 'Re: Booking',
        textBody: 'Candidate',
        htmlBody: body,
        attachments: [],
      });
      await insertTrustedCandidateRun(db, {
        generationId,
        threadId,
        triggerMessageId: parentMessageId,
      });

      const caller = await callerFor('user-navaai', {
        db,
        requestedTransportId: TRANSPORT_ID,
      });
      const approval = await caller.drafts.approve({
        draftId,
        subject: 'Re: Booking',
        html: body,
        text: '',
        to: ['guest@example.com'],
        cc: [],
        bcc: [],
        attachments: [],
      });
      const smtpSend = vi
        .fn<SmtpTransport['send']>()
        .mockRejectedValue(new Error('synthetic SMTP outcome unknown'));
      __setSmtpTransportForTests({ kind: 'fake', send: smtpSend });
      const queuedResult = await caller.mail.send({
        threadId,
        draftId,
        to: ['guest@example.com'],
        subject: 'Re: Booking',
        message: body,
        draftApproval: approval,
      });
      expect(queuedResult).toMatchObject({ queued: true });
      await __forceSendAtPastForTests(queuedResult.messageId, TRANSPORT_ID, db);

      const postClaimMessageId = randomUUID();
      __setOutboundAttemptFenceHookForTests(async ({ db: fencedDb }) => {
        // The queue claim is already durable. A real EmailComposer save uses
        // drafts.create with the existing id; it must not rewrite the
        // claimed/sent draft or append an edited revision. Concurrent
        // thread/evidence writes are ordered after this send attempt and
        // affect the next approval.
        await expect(
          caller.drafts.create({
            id: draftId,
            threadId,
            replyToMessageId: parentMessageId,
            to: 'guest@example.com',
            subject: 'Re: Booking (edited)',
            message: '<p>Edited after attempt claim</p>',
            body: '<p>Edited after attempt claim</p>',
            attachments: [],
          }),
        ).rejects.toMatchObject({ code: 'CONFLICT', message: 'DRAFT_SEND_CLAIMED' });
        await fencedDb.insert(message).values({
          id: postClaimMessageId,
          transportId: TRANSPORT_ID,
          threadId,
          direction: 'inbound',
          fromAddress: 'guest@example.com',
          toAddresses: ['nava@example.com'],
          subject: 'Post-claim update',
          textBody: 'This arrives after the send claim.',
          receivedAt: new Date('2026-07-06T10:01:00Z'),
        });
        await fencedDb
          .update(aiDraftGeneration)
          .set({ evidence: [{ ...evidence, sourceHash: 'f'.repeat(64) }] })
          .where(eq(aiDraftGeneration.id, generationId));
      });

      await expect(flushDue({ db })).resolves.toEqual({ flushed: 0 });
      expect(smtpSend).toHaveBeenCalledTimes(1);
      const [queue] = await db
        .select({ status: outboundSendQueue.status, lastError: outboundSendQueue.lastError })
        .from(outboundSendQueue)
        .where(eq(outboundSendQueue.messageId, queuedResult.messageId));
      expect(queue?.status).toBe('sending');
      expect(queue?.lastError).toContain('SMTP_DELIVERY_OUTCOME_UNKNOWN');
      const [sentDraft] = await db
        .select({ status: mailDraft.status, isSent: mailDraft.isSent })
        .from(mailDraft)
        .where(eq(mailDraft.id, draftId));
      expect(sentDraft).toEqual({ status: 'sent', isSent: true });
      const editedRevisions = await db
        .select({ id: mailDraftRevision.id })
        .from(mailDraftRevision)
        .where(and(eq(mailDraftRevision.draftId, draftId), eq(mailDraftRevision.kind, 'edited')));
      expect(editedRevisions).toHaveLength(0);
      const [postClaimMessage] = await db
        .select({ id: message.id })
        .from(message)
        .where(eq(message.id, postClaimMessageId));
      expect(postClaimMessage?.id).toBe(postClaimMessageId);
    });
  }, 30000);

  it('rejects an approval when the server-owned draft release changes', async () => {
    const previousDraftsEnabled = process.env.AI_DRAFTS_ENABLED;
    const previousModelRoute = process.env.AI_MODEL_ROUTE;
    const previousDraftConfig = process.env.AI_APPROVED_LOCAL_DRAFT_CONFIG;
    process.env.AI_DRAFTS_ENABLED = 'true';
    process.env.AI_MODEL_ROUTE = 'approved-local';
    const route = { ...TRUSTED_DRAFT_ROUTE };
    const temporaryAuthorityDirectory = mkdtempSync(join(tmpdir(), 'u6-authority-'));
    const temporaryAuthorityModule = join(temporaryAuthorityDirectory, 'configured.cjs');
    const temporarilyRemovedAuthorityModule = `${temporaryAuthorityModule}.removed`;
    copyFileSync(TRUSTED_DRAFT_MODULE, temporaryAuthorityModule);
    const release = {
      releaseId: 'u6-draft-release-a',
      releaseVersion: '2026.09.09.1',
      sourceRevision: 'source-a',
      fingerprint: 'a'.repeat(64),
      purpose: 'draft' as const,
      capabilityFamilyVersions: { draft: 'u6-draft-v1' },
      issuedAt: '2026-09-09T10:00:00.000Z',
      expiresAt: '2099-01-01T00:00:00.000Z',
      withdrawn: false,
    };
    const descriptor = {
      module: TRUSTED_DRAFT_MODULE,
      route,
      release,
    };
    process.env.AI_APPROVED_LOCAL_DRAFT_CONFIG = JSON.stringify(descriptor);

    try {
      await withSeededTestDb(async (db) => {
        process.env.MAIL_SELF_BCC = 'false';
        const threadId = randomUUID();
        const parentMessageId = randomUUID();
        const draftId = randomUUID();
        const generationId = randomUUID();
        const revisionId = randomUUID();
        const runId = randomUUID();
        const body = '<p>Current release proof</p>';
        const evidence = {
          kind: 'hms' as const,
          id: `evidence-${generationId}`,
          toolId: 'hms_quote_stay',
          toolVersion: '1',
          propertyCode: 'HRCEN',
          observedAt: '2026-07-06T10:00:00.000Z',
          expiresAt: '2099-01-01T00:00:00.000Z',
          claimKeys: ['rate'],
          sourceHash: 'a'.repeat(64),
          scopeVerified: true,
        };

        await db.insert(mailThread).values({
          id: threadId,
          transportId: TRANSPORT_ID,
          threadRootId: `<${threadId}@example.com>`,
          subject: 'Booking',
          snippet: 'Need a current route proof',
          latestMessageAt: new Date('2026-07-06T10:00:00Z'),
        });
        await db.insert(message).values({
          id: parentMessageId,
          transportId: TRANSPORT_ID,
          threadId,
          direction: 'inbound',
          fromAddress: 'guest@example.com',
          toAddresses: ['nava@example.com'],
          subject: 'Booking',
          textBody: 'Need a current route proof',
          receivedAt: new Date('2026-07-06T10:00:00Z'),
        });
        const threadStateVersion = await loadLiveThreadStateVersion(db, {
          transportId: TRANSPORT_ID,
          threadId,
        });
        await db.insert(aiDraftGeneration).values({
          id: generationId,
          transportId: TRANSPORT_ID,
          threadId,
          requestedByUserId: 'user-navaai',
          contextMessageIds: [parentMessageId],
          model: route.modelId,
          promptVersion: 'draft-v1',
          status: 'succeeded',
          outcome: 'candidate',
          threadStateVersion,
          evidence: [evidence],
        });
        await db.insert(mailDraft).values({
          id: draftId,
          transportId: TRANSPORT_ID,
          threadId,
          createdByUserId: 'user-navaai',
          status: 'active',
          origin: 'ai',
          generationId,
          replyToMessageId: parentMessageId,
          toAddresses: ['guest@example.com'],
          subject: 'Re: Booking',
          textBody: 'Current release proof',
          htmlBody: body,
        });
        await db.insert(mailDraftRevision).values({
          id: revisionId,
          draftId,
          generationId,
          actorUserId: 'user-navaai',
          kind: 'ai_generated',
          toAddresses: ['guest@example.com'],
          ccAddresses: [],
          bccAddresses: [],
          subject: 'Re: Booking',
          textBody: 'Current release proof',
          htmlBody: body,
          attachments: [],
        });
        await db.insert(aiWorkflowRun).values({
          id: runId,
          transportId: TRANSPORT_ID,
          threadId,
          triggerMessageId: parentMessageId,
          runKind: 'candidate_draft',
          idempotencyKey: `u6-current-release:${runId}`,
          modelId: route.modelId,
          promptVersion: 'draft-v1',
          state: 'succeeded',
          executorLane: 'default',
          generationId,
          metrics: { routeBinding: { ...route, release } },
          finishedAt: new Date(),
        });

        const caller = await callerFor('user-navaai', {
          db,
          requestedTransportId: TRANSPORT_ID,
        });
        const approvalInput = {
          draftId,
          subject: 'Re: Booking',
          html: body,
          text: '',
          to: ['guest@example.com'],
          cc: [],
          bcc: [],
          attachments: [],
        };
        const approvalPayload = {
          ...approvalInput,
          generationId,
          transportId: TRANSPORT_ID,
          threadId,
          revisionId,
          threadStateVersion,
          evidence: [evidence],
          policyVersion: draftApprovalModule.DRAFT_APPROVAL_POLICY_VERSION,
          approvedByUserId: 'user-navaai',
          approvedAt: new Date().toISOString(),
          origin: 'ai' as const,
          routeBinding: { ...route, release },
        };
        const signingSecret = draftApprovalModule.getDraftApprovalSigningSecret();
        const directApproval = draftApprovalModule.buildDraftApproval(
          approvalPayload,
          signingSecret,
        );
        await expect(
          draftApprovalModule.assertDraftApprovalCurrent({
            db,
            approval: directApproval,
            payload: approvalPayload,
            loadThreadStateVersion: loadLiveThreadStateVersion,
            signingSecret,
          }),
        ).resolves.toBeDefined();
        const approval = await caller.drafts.approve(approvalInput);
        expect(approval).toMatchObject({
          routeBinding: expect.objectContaining({ routeId: route.routeId }),
        });

        // Keep the descriptor unchanged while its configured local module is
        // unavailable; approval revalidation checks path presence only and
        // never initializes the factory/model.
        const unavailableDescriptor = {
          ...descriptor,
          module: temporaryAuthorityModule,
        };
        process.env.AI_APPROVED_LOCAL_DRAFT_CONFIG = JSON.stringify(unavailableDescriptor);
        renameSync(temporaryAuthorityModule, temporarilyRemovedAuthorityModule);
        try {
          await expect(caller.drafts.approve(approvalInput)).rejects.toMatchObject({
            code: 'CONFLICT',
            message: 'DRAFT_APPROVAL_INVALID',
          });
        } finally {
          renameSync(temporarilyRemovedAuthorityModule, temporaryAuthorityModule);
        }
        process.env.AI_APPROVED_LOCAL_DRAFT_CONFIG = JSON.stringify(descriptor);

        process.env.AI_APPROVED_LOCAL_DRAFT_CONFIG = JSON.stringify({
          ...descriptor,
          route: { ...route, routeId: 'u6-current-authority-route-b' },
          release: {
            ...release,
            releaseId: 'u6-draft-release-b',
            sourceRevision: 'source-b',
            fingerprint: 'b'.repeat(64),
          },
        });
        await expect(caller.drafts.approve(approvalInput)).rejects.toMatchObject({
          code: 'CONFLICT',
          message: 'DRAFT_APPROVAL_INVALID',
        });

        process.env.AI_APPROVED_LOCAL_DRAFT_CONFIG = JSON.stringify({
          ...descriptor,
          release: {
            ...release,
            capabilityFamilyVersions: { draft: 'u6-draft-v2' },
          },
        });
        await expect(caller.drafts.approve(approvalInput)).rejects.toMatchObject({
          code: 'CONFLICT',
          message: 'DRAFT_APPROVAL_INVALID',
        });

        delete process.env.AI_APPROVED_LOCAL_DRAFT_CONFIG;
        await expect(caller.drafts.approve(approvalInput)).rejects.toMatchObject({
          code: 'CONFLICT',
          message: 'DRAFT_APPROVAL_INVALID',
        });

        for (const releaseState of [
          { withdrawn: true, expiresAt: release.expiresAt },
          { withdrawn: false, expiresAt: '2020-01-01T00:00:00.000Z' },
        ]) {
          process.env.AI_APPROVED_LOCAL_DRAFT_CONFIG = JSON.stringify({
            ...descriptor,
            release: { ...release, ...releaseState },
          });
          await expect(caller.drafts.approve(approvalInput)).rejects.toMatchObject({
            code: 'CONFLICT',
            message: 'DRAFT_APPROVAL_INVALID',
          });
        }

        const invalidMailAuthorities = [
          JSON.stringify({
            ...descriptor,
            route: { ...route, routeId: 'u6-current-authority-route-b' },
            release: {
              ...release,
              releaseId: 'u6-draft-release-b',
              sourceRevision: 'source-b',
              fingerprint: 'b'.repeat(64),
            },
          }),
          undefined,
          JSON.stringify({
            ...descriptor,
            release: { ...release, withdrawn: true },
          }),
          JSON.stringify({
            ...descriptor,
            release: { ...release, expiresAt: '2020-01-01T00:00:00.000Z' },
          }),
          JSON.stringify({
            ...descriptor,
            release: {
              ...release,
              capabilityFamilyVersions: { draft: 'u6-draft-v2' },
            },
          }),
        ] as const;
        for (const invalidDescriptor of invalidMailAuthorities) {
          if (invalidDescriptor === undefined) delete process.env.AI_APPROVED_LOCAL_DRAFT_CONFIG;
          else process.env.AI_APPROVED_LOCAL_DRAFT_CONFIG = invalidDescriptor;
          await expect(
            caller.mail.send({
              threadId,
              draftId,
              to: ['guest@example.com'],
              subject: 'Re: Booking',
              message: body,
              draftApproval: approval,
            }),
          ).rejects.toMatchObject({ code: 'CONFLICT', message: 'DRAFT_APPROVAL_INVALID' });
        }

        process.env.AI_APPROVED_LOCAL_DRAFT_CONFIG = JSON.stringify(descriptor);
        process.env.UNDO_SEND_SECONDS = '30';
        const smtpSend = vi.fn<SmtpTransport['send']>().mockResolvedValue({
          messageId: 'authority-expiry@zero.test',
          accepted: ['guest@example.com'],
          rejected: [],
        });
        __setSmtpTransportForTests({ kind: 'fake', send: smtpSend });
        const queued = await caller.mail.send({
          threadId,
          draftId,
          to: ['guest@example.com'],
          subject: 'Re: Booking',
          message: body,
          draftApproval: approval,
        });
        expect(queued).toMatchObject({ queued: true });
        await __forceSendAtPastForTests(queued.messageId, TRANSPORT_ID, db);
        process.env.AI_APPROVED_LOCAL_DRAFT_CONFIG = JSON.stringify({
          ...descriptor,
          release: { ...release, expiresAt: '2020-01-01T00:00:00.000Z' },
        });
        await expect(flushDue({ db })).resolves.toEqual({ flushed: 0 });
        expect(smtpSend).not.toHaveBeenCalled();
        const [removedQueue] = await db
          .select({ status: outboundSendQueue.status })
          .from(outboundSendQueue)
          .where(eq(outboundSendQueue.messageId, queued.messageId));
        expect(removedQueue).toBeUndefined();
        const [restored] = await db
          .select({ status: mailDraft.status, isSent: mailDraft.isSent })
          .from(mailDraft)
          .where(eq(mailDraft.id, draftId));
        expect(restored).toEqual({ status: 'active', isSent: false });

        // Re-queue the same signed review and change only the capability
        // family at the final SMTP-attempt fence.
        process.env.AI_APPROVED_LOCAL_DRAFT_CONFIG = JSON.stringify(descriptor);
        const familyApproval = await caller.drafts.approve(approvalInput);
        const familyQueued = await caller.mail.send({
          threadId,
          draftId,
          to: ['guest@example.com'],
          subject: 'Re: Booking',
          message: body,
          draftApproval: familyApproval,
        });
        expect(familyQueued).toMatchObject({ queued: true });
        await __forceSendAtPastForTests(familyQueued.messageId, TRANSPORT_ID, db);
        process.env.AI_APPROVED_LOCAL_DRAFT_CONFIG = JSON.stringify({
          ...descriptor,
          release: {
            ...release,
            capabilityFamilyVersions: { draft: 'u6-draft-v2' },
          },
        });
        await expect(flushDue({ db })).resolves.toEqual({ flushed: 0 });
        expect(smtpSend).not.toHaveBeenCalled();
        const [familyQueue] = await db
          .select({ status: outboundSendQueue.status })
          .from(outboundSendQueue)
          .where(eq(outboundSendQueue.messageId, familyQueued.messageId));
        expect(familyQueue).toBeUndefined();
      });
    } finally {
      if (previousDraftsEnabled === undefined) delete process.env.AI_DRAFTS_ENABLED;
      else process.env.AI_DRAFTS_ENABLED = previousDraftsEnabled;
      if (previousModelRoute === undefined) delete process.env.AI_MODEL_ROUTE;
      else process.env.AI_MODEL_ROUTE = previousModelRoute;
      if (previousDraftConfig === undefined) delete process.env.AI_APPROVED_LOCAL_DRAFT_CONFIG;
      else process.env.AI_APPROVED_LOCAL_DRAFT_CONFIG = previousDraftConfig;
      rmSync(temporaryAuthorityDirectory, { recursive: true, force: true });
    }
  }, 30000);

  it('keeps AI-bound Send anyway blocked after approval when the thread changes', async () => {
    await withSeededTestDb(async (db) => {
      const threadId = randomUUID();
      const parentMessageId = randomUUID();
      const draftId = randomUUID();
      const generationId = randomUUID();
      const body = '<p>Review me</p>';
      const evidence = {
        kind: 'hms' as const,
        id: `evidence-${generationId}`,
        toolId: 'hms_quote_stay',
        toolVersion: '1',
        propertyCode: 'HRCEN',
        observedAt: '2026-07-06T10:00:00.000Z',
        expiresAt: '2099-01-01T00:00:00.000Z',
        claimKeys: ['rate'],
        sourceHash: 'b'.repeat(64),
        scopeVerified: true,
      };
      await db.insert(mailThread).values({
        id: threadId,
        transportId: TRANSPORT_ID,
        threadRootId: `<${threadId}@example.com>`,
        subject: 'Booking',
        snippet: 'Need help',
        latestMessageAt: new Date('2026-07-06T10:00:00Z'),
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
        receivedAt: new Date('2026-07-06T10:00:00Z'),
      });
      const threadStateVersion = await loadLiveThreadStateVersion(db, {
        transportId: TRANSPORT_ID,
        threadId,
      });
      await db.insert(aiDraftGeneration).values({
        id: generationId,
        transportId: TRANSPORT_ID,
        threadId,
        requestedByUserId: 'user-navaai',
        contextMessageIds: [parentMessageId],
        model: 'approved-local-test',
        promptVersion: 'draft-v1',
        status: 'succeeded',
        outcome: 'candidate',
        threadStateVersion,
        evidence: [evidence],
      });
      await db.insert(mailDraft).values({
        id: draftId,
        transportId: TRANSPORT_ID,
        threadId,
        createdByUserId: 'user-navaai',
        status: 'active',
        origin: 'ai',
        generationId,
        replyToMessageId: parentMessageId,
        toAddresses: ['guest@example.com'],
        subject: 'Re: Booking',
        textBody: 'Candidate',
        htmlBody: body,
      });
      await db.insert(mailDraftRevision).values({
        id: randomUUID(),
        draftId,
        generationId,
        actorUserId: 'user-navaai',
        kind: 'ai_generated',
        toAddresses: ['guest@example.com'],
        ccAddresses: [],
        bccAddresses: [],
        subject: 'Re: Booking',
        textBody: 'Candidate',
        htmlBody: body,
        attachments: [],
      });
      await insertTrustedCandidateRun(db, {
        generationId,
        threadId,
        triggerMessageId: parentMessageId,
      });
      const caller = await callerFor('user-navaai', {
        db,
        requestedTransportId: TRANSPORT_ID,
      });
      const approval = await caller.drafts.approve({
        draftId,
        subject: 'Re: Booking',
        html: body,
        text: '',
        to: ['guest@example.com'],
        attachments: [],
      });
      await db.insert(message).values({
        id: randomUUID(),
        transportId: TRANSPORT_ID,
        threadId,
        direction: 'inbound',
        fromAddress: 'guest@example.com',
        toAddresses: ['nava@example.com'],
        subject: 'Updated booking',
        textBody: 'A newer answer arrived',
        receivedAt: new Date('2026-07-06T10:05:00Z'),
      });

      await expect(
        caller.mail.send({
          threadId,
          draftId,
          to: ['guest@example.com'],
          subject: 'Re: Booking',
          message: body,
          draftApproval: approval,
        }),
      ).rejects.toMatchObject({ code: 'CONFLICT', message: 'DRAFT_APPROVAL_INVALID' });

      await expect(
        caller.mail.send({
          threadId,
          draftId,
          to: ['guest@example.com'],
          subject: 'Re: Booking',
          message: body,
          draftApproval: approval,
          confirmStaleDraft: true,
        }),
      ).rejects.toMatchObject({ code: 'CONFLICT', message: 'DRAFT_APPROVAL_INVALID' });
    });
  }, 30000);

  it('cancels a confirmed-zero queue retry when approval becomes stale before transmission', async () => {
    await withSeededTestDb(async (db) => {
      process.env.UNDO_SEND_SECONDS = '0';
      process.env.MAIL_SELF_BCC = 'false';
      const threadId = randomUUID();
      const parentMessageId = randomUUID();
      const draftId = randomUUID();
      const generationId = randomUUID();
      const body = '<p>Zero acceptance</p>';
      const evidence = {
        kind: 'hms' as const,
        id: `evidence-${generationId}`,
        toolId: 'hms_quote_stay',
        toolVersion: '1',
        propertyCode: 'HRCEN',
        observedAt: '2026-07-06T10:00:00.000Z',
        expiresAt: '2099-01-01T00:00:00.000Z',
        claimKeys: ['rate'],
        sourceHash: 'c'.repeat(64),
        scopeVerified: true,
      };
      await db.insert(mailThread).values({
        id: threadId,
        transportId: TRANSPORT_ID,
        threadRootId: `<${threadId}@example.com>`,
        subject: 'Booking',
        snippet: 'Need help',
        latestMessageAt: new Date('2026-07-06T10:00:00Z'),
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
        receivedAt: new Date('2026-07-06T10:00:00Z'),
      });
      const threadStateVersion = await loadLiveThreadStateVersion(db, {
        transportId: TRANSPORT_ID,
        threadId,
      });
      await db.insert(aiDraftGeneration).values({
        id: generationId,
        transportId: TRANSPORT_ID,
        threadId,
        requestedByUserId: 'user-navaai',
        contextMessageIds: [parentMessageId],
        model: 'approved-local-test',
        promptVersion: 'draft-v1',
        status: 'succeeded',
        outcome: 'candidate',
        threadStateVersion,
        evidence: [evidence],
      });
      await db.insert(mailDraft).values({
        id: draftId,
        transportId: TRANSPORT_ID,
        threadId,
        createdByUserId: 'user-navaai',
        status: 'active',
        origin: 'ai',
        generationId,
        replyToMessageId: parentMessageId,
        toAddresses: ['guest@example.com'],
        subject: 'Re: Booking',
        textBody: 'Candidate',
        htmlBody: body,
      });
      await db.insert(mailDraftRevision).values({
        id: randomUUID(),
        draftId,
        generationId,
        actorUserId: 'user-navaai',
        kind: 'ai_generated',
        toAddresses: ['guest@example.com'],
        ccAddresses: [],
        bccAddresses: [],
        subject: 'Re: Booking',
        textBody: 'Candidate',
        htmlBody: body,
        attachments: [],
      });
      await insertTrustedCandidateRun(db, {
        generationId,
        threadId,
        triggerMessageId: parentMessageId,
      });
      const caller = await callerFor('user-navaai', {
        db,
        requestedTransportId: TRANSPORT_ID,
      });
      const approval = await caller.drafts.approve({
        draftId,
        subject: 'Re: Booking',
        html: body,
        text: '',
        to: ['guest@example.com'],
        attachments: [],
      });
      const send = vi.fn<SmtpTransport['send']>().mockResolvedValue({
        messageId: 'zero@zero.test',
        accepted: [],
        rejected: ['guest@example.com'],
      });
      __setSmtpTransportForTests({ kind: 'fake', send });
      await expect(
        caller.mail.send({
          threadId,
          draftId,
          to: ['guest@example.com'],
          subject: 'Re: Booking',
          message: body,
          draftApproval: approval,
        }),
      ).rejects.toThrow('SMTP accepted no recipients');
      const [queue] = await db
        .select()
        .from(outboundSendQueue)
        .where(eq(outboundSendQueue.transportId, TRANSPORT_ID))
        .limit(1);
      expect(queue?.status).toBe('sending');
      await db.insert(message).values({
        id: randomUUID(),
        transportId: TRANSPORT_ID,
        threadId,
        direction: 'inbound',
        fromAddress: 'guest@example.com',
        toAddresses: ['nava@example.com'],
        subject: 'Updated booking',
        textBody: 'Updated',
        receivedAt: new Date('2026-07-06T10:05:00Z'),
      });
      await db
        .update(outboundSendQueue)
        .set({ claimedAt: new Date(Date.now() - 5 * 60 * 1000 - 1) })
        .where(eq(outboundSendQueue.id, queue!.id));
      await expect(flushDue({ db })).resolves.toEqual({ flushed: 0 });
      const [cancelled] = await db
        .select()
        .from(outboundSendQueue)
        .where(eq(outboundSendQueue.id, queue!.id))
        .limit(1);
      expect(cancelled).toBeUndefined();
      const [orphanedMessage] = await db
        .select({ id: message.id })
        .from(message)
        .where(and(eq(message.id, queue!.messageId), eq(message.transportId, TRANSPORT_ID)))
        .limit(1);
      expect(orphanedMessage).toBeUndefined();
      const [reopenedDraft] = await db
        .select({ isSent: mailDraft.isSent, status: mailDraft.status })
        .from(mailDraft)
        .where(and(eq(mailDraft.id, draftId), eq(mailDraft.transportId, TRANSPORT_ID)))
        .limit(1);
      expect(reopenedDraft).toMatchObject({ isSent: false, status: 'active' });
      expect(send).toHaveBeenCalledTimes(1);
    });
  }, 30000);
});
