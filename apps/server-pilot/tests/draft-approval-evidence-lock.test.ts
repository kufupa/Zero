import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DB } from '../src/db/client.js';
import { user } from '../src/db/schema/auth.js';
import { aiDraftGeneration, aiWorkflowRun, mailDraft, mailDraftRevision, mailboxTransport, mailThread, message } from '../src/db/schema/mail.js';
import { TRANSPORT_EMAIL, TRANSPORT_ID, TRANSPORT_OWNER_HEADER } from '../src/db/seed.js';
import { assertDraftApprovalCurrent, buildDraftApproval, claimDraftApprovalForSend, DRAFT_APPROVAL_POLICY_VERSION, type DraftApprovalPayload } from '../src/ai/draft-approval.js';
import { loadLiveThreadStateVersion } from '../src/ai/drafts.js';
import { withQuoteSourceBusyHold } from '../src/hms/quote-source-contention.js';
import { assertQueuedDraftApproval } from '../src/mail/send/outbound-queue.js';
import { openTestDbSession, probeTestDb, TEST_DB_AVAILABLE } from './helpers/test-db.js';

const reachable = await probeTestDb();
const signingSecret = 'synthetic-test-secret';
const route = { routeId: 'evidence-lock-route', modelId: 'evidence-lock-model', purpose: 'draft' as const,
  protocol: 'in_process' as const, access: 'current_app' as const, egress: 'none' as const,
  retention: 'bounded' as const, usage: 'reported' as const };
const release = { releaseId: 'evidence-lock-release', releaseVersion: '1', sourceRevision: 'synthetic',
  fingerprint: 'd'.repeat(64), purpose: 'draft' as const, capabilityFamilyVersions: { draft: '1' },
  issuedAt: '2026-01-01T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z', withdrawn: false };
const modulePath = new URL('./fixtures/u6-approved-local-draft.cjs', import.meta.url).pathname;

afterEach(() => vi.unstubAllEnvs());

describe.skipIf(!TEST_DB_AVAILABLE || !reachable)('approved draft evidence transaction fence (disposable DB)', () => {
  it.each([
    ['enqueue', 'selected run'], ['SMTP claim', 'selected run'],
    ['enqueue', 'another candidate'], ['SMTP claim', 'another candidate'],
    ['enqueue', 'generation evidence'], ['SMTP claim', 'generation evidence'],
  ] as const)('holds the %s when %s is changing, then observes the committed change', async (claim, changing) => {
    const setup = openTestDbSession(), reader = openTestDbSession(), writer = openTestDbSession();
    const threadId = randomUUID(), messageId = randomUUID(), userId = randomUUID();
    const generationId = randomUUID(), draftId = randomUUID(), revisionId = randomUUID();
    const selectedRunId = randomUUID(), pendingRunId = randomUUID();
    let releaseWriter!: () => void, signalWriter!: (error?: unknown) => void;
    const gate = new Promise<void>((resolve) => { releaseWriter = resolve; });
    const ready = new Promise<unknown>((resolve) => { signalWriter = resolve; });
    let holding: Promise<unknown> | undefined;
    let releaseReader = () => {};
    let holdingReader: Promise<unknown> | undefined;
    try {
      vi.stubEnv('BETTER_AUTH_SECRET', signingSecret);
      vi.stubEnv('AI_MODEL_ROUTE', 'approved-local');
      vi.stubEnv('AI_APPROVED_LOCAL_DRAFT_CONFIG', JSON.stringify({ module: modulePath, route, release }));
      await setup.db.insert(mailboxTransport).values({ id: TRANSPORT_ID, email: TRANSPORT_EMAIL,
        ownerHeaderValue: TRANSPORT_OWNER_HEADER }).onConflictDoNothing();
      await setup.db.insert(user).values({ id: userId, name: 'Synthetic staff', email: `${userId}@example.invalid`, emailVerified: true });
      await setup.db.insert(mailThread).values({ id: threadId, transportId: TRANSPORT_ID, threadRootId: threadId });
      await setup.db.insert(message).values({ id: messageId, transportId: TRANSPORT_ID, threadId,
        direction: 'inbound', fromAddress: 'guest@example.invalid', toAddresses: [TRANSPORT_EMAIL] });
      await setup.db.insert(aiDraftGeneration).values({ id: generationId, transportId: TRANSPORT_ID, threadId,
        requestedByUserId: userId, model: route.modelId, promptVersion: 'test', status: 'succeeded', evidence: [] });
      await setup.db.insert(mailDraft).values({ id: draftId, transportId: TRANSPORT_ID, threadId,
        createdByUserId: userId, replyToMessageId: messageId, generationId, origin: 'ai', status: 'active' });
      await setup.db.insert(mailDraftRevision).values({ id: revisionId, draftId, generationId, kind: 'created' });
      const runBase = { transportId: TRANSPORT_ID, threadId, triggerMessageId: messageId, generationId,
        runKind: 'candidate_draft' as const, modelId: route.modelId, promptVersion: 'test',
        metrics: { routeBinding: { ...route, release } } };
      await setup.db.insert(aiWorkflowRun).values({ ...runBase, id: selectedRunId,
        idempotencyKey: selectedRunId, state: 'succeeded', finishedAt: new Date('2026-10-01T00:00:00Z') });
      await setup.db.insert(aiWorkflowRun).values({ ...runBase, id: pendingRunId,
        idempotencyKey: pendingRunId, state: 'running' });
      const threadStateVersion = await loadLiveThreadStateVersion(setup.db, { transportId: TRANSPORT_ID, threadId });
      const payload: DraftApprovalPayload = { draftId, generationId, transportId: TRANSPORT_ID, threadId, revisionId,
        threadStateVersion, evidence: [], policyVersion: DRAFT_APPROVAL_POLICY_VERSION, approvedByUserId: userId,
        approvedAt: new Date().toISOString(), origin: 'ai', subject: 'Synthetic', html: '<p>Hello</p>', text: 'Hello',
        to: ['guest@example.invalid'], cc: [], bcc: [], attachments: [], routeBinding: { ...route, release } };
      const approval = buildDraftApproval(payload, signingSecret);
      const smtp = { from: TRANSPORT_EMAIL, to: payload.to, cc: payload.cc, bcc: payload.bcc,
        subject: payload.subject, html: payload.html, text: payload.text };

      holding = writer.db.transaction(async (tx) => {
        await tx.execute(sql`set local lock_timeout = '3s'`);
        if (changing === 'generation evidence') {
          await tx.update(aiDraftGeneration).set({ evidence: [{ changed: true }] }).where(eq(aiDraftGeneration.id, generationId));
        } else {
          const target = changing === 'selected run' ? selectedRunId : pendingRunId;
          await tx.update(aiWorkflowRun).set({ state: 'succeeded', finishedAt: new Date('2026-10-02T00:00:00Z'),
            metrics: { modelRouteUnavailable: true } }).where(eq(aiWorkflowRun.id, target));
        }
        signalWriter();
        await gate;
      });
      void holding.catch((error) => signalWriter(error));
      const writerError = await ready;
      if (writerError) throw writerError;

      const claimAttempt = withQuoteSourceBusyHold(() => reader.db.transaction(async (tx) => {
        await tx.execute(sql`set local lock_timeout = '250ms'`);
        if (claim === 'enqueue') return claimDraftApprovalForSend({ db: tx as unknown as DB, approval, payload,
          signingSecret, queueMessageId: 'synthetic-queue-id', loadThreadStateVersion: async () => threadStateVersion });
        return assertQueuedDraftApproval(approval, smtp, tx as unknown as DB, undefined, { lockQuoteOrigin: true });
      }));
      await expect(claimAttempt).rejects.toThrow('The email is being updated. Wait a moment, then try again.');
      const [draft] = await setup.db.select({ status: mailDraft.status }).from(mailDraft).where(eq(mailDraft.id, draftId));
      expect(draft?.status).toBe('active');
      releaseWriter();
      await holding;
      await expect(assertDraftApprovalCurrent({ db: setup.db, approval, payload, signingSecret,
        loadThreadStateVersion: async () => threadStateVersion })).rejects.toThrow(changing === 'generation evidence'
          ? 'draft evidence changed after approval' : 'approved draft route unavailable');
      if (claim === 'enqueue' && changing === 'selected run') {
        await setup.db.update(aiWorkflowRun).set({ metrics: { routeBinding: { ...route, release } } })
          .where(eq(aiWorkflowRun.id, selectedRunId));
        let signalReader!: (error?: unknown) => void;
        const readerGate = new Promise<void>((resolve) => { releaseReader = resolve; });
        const readerReady = new Promise<unknown>((resolve) => { signalReader = resolve; });
        holdingReader = reader.db.transaction(async (tx) => {
          await assertDraftApprovalCurrent({ db: tx as unknown as DB, approval, payload, signingSecret,
            loadThreadStateVersion: async () => threadStateVersion, lockQuoteOrigin: true });
          signalReader();
          await readerGate;
        });
        void holdingReader.catch((error) => signalReader(error));
        const readerError = await readerReady;
        if (readerError) throw readerError;
        const blocked = (action: (db: DB) => Promise<unknown>) => withQuoteSourceBusyHold(() =>
          writer.db.transaction(async (tx) => {
            await tx.execute(sql`set local lock_timeout = '250ms'`);
            await action(tx as unknown as DB);
          }));
        for (const id of [selectedRunId, pendingRunId]) {
          await expect(blocked(async (db) => { await db.update(aiWorkflowRun).set({ metrics: { changed: true } })
            .where(eq(aiWorkflowRun.id, id)); })).rejects.toThrow('The email is being updated.');
        }
        await expect(blocked(async (db) => { await db.update(aiDraftGeneration).set({ evidence: [{ changed: true }] })
          .where(eq(aiDraftGeneration.id, generationId)); })).rejects.toThrow('The email is being updated.');
        const newRunId = randomUUID();
        await expect(blocked(async (db) => { await db.insert(aiWorkflowRun).values({ ...runBase, id: newRunId,
          idempotencyKey: newRunId, state: 'running' }); })).rejects.toThrow('The email is being updated.');
        releaseReader();
        await holdingReader;
      }
    } finally {
      releaseWriter();
      releaseReader();
      await holding?.catch(() => undefined);
      await holdingReader?.catch(() => undefined);
      await setup.db.delete(mailThread).where(eq(mailThread.id, threadId)).catch(() => undefined);
      await setup.db.delete(user).where(eq(user.id, userId)).catch(() => undefined);
      await Promise.all([setup.close(), reader.close(), writer.close()]);
    }
  }, 20_000);
});
