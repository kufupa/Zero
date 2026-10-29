import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import type { DB } from '../src/db/client.js';
import * as schema from '../src/db/schema/index.js';
import { aiDraftGeneration, aiWorkflowRun, message } from '../src/db/schema/mail.js';
import { mailExtraction, workEvent, workItem } from '../src/db/schema/work.js';
import { consumeHmsCreatePlan, loadHmsCreatePlan, prepareHmsCreatePlan } from '../src/ai/hms-create-plan.js';
import { approveHmsWrite } from '../src/ai/hms-approval.js';
import { staffQuoteSourceHash } from '../src/ai/staff-quote-workflow.js';
import { CASE_READ, CASE_STAY_ID, PLAN_NOW, quotedPlanFixture } from './helpers/hms-create-plan-fixture.js';
import { seedInboxThread } from './helpers/seed-inbox-thread.js';
import { withIngestionDb } from './helpers/ingestion-db.js';

const scope = { transportId: 'transport-centurion', actorUserId: 'staff-1' };
const email = 'centurion@legacyhotels.co.za';

async function seed(db: DB) {
  const { revision, input: template } = await quotedPlanFixture();
  await seedInboxThread(db, { threadId: 'thread-1', transportId: scope.transportId, transportEmail: email,
    messageId: 'quote-message', subject: 'Please quote', textBody: 'A quote request' });
  await seedInboxThread(db, { threadId: 'thread-1', transportId: scope.transportId, transportEmail: email,
    messageId: 'selected-message', subject: 'Please book', textBody: 'The selected booking request' });
  const [quoteMail] = await db.select().from(message).where(eq(message.id, 'quote-message')).limit(1);
  const [caseRead] = await db.insert(mailExtraction).values({ messageId: 'selected-message', extractorVersion: 'test-v1',
    status: 'succeeded', kind: 'booking', payload: CASE_READ, createdAt: new Date(PLAN_NOW.getTime() - 120_000) }).returning();
  const [item] = await db.insert(workItem).values({ transportId: scope.transportId, threadId: 'thread-1',
    sourceMessageId: 'selected-message', kind: 'booking', extractionId: caseRead!.id, state: { selectedCase: 'case-1', stayPreviews: {
      [CASE_STAY_ID]: { status: 'previewed', digest: template.previewDigest, expiresAt: PLAN_NOW.getTime() + 600_000 },
    } } }).returning();
  await db.insert(aiDraftGeneration).values({ id: 'quote-generation', transportId: scope.transportId,
    threadId: 'thread-1', requestedByUserId: scope.actorUserId, contextMessageIds: ['quote-message'],
    model: 'staff-approved-native', promptVersion: 'staff-quote-v1', status: 'succeeded',
    createdAt: new Date(PLAN_NOW.getTime() - 60_000) });
  await db.insert(aiWorkflowRun).values({ id: template.quoteRunId, transportId: scope.transportId, threadId: 'thread-1',
    triggerMessageId: 'quote-message', runKind: 'candidate_draft', idempotencyKey: 'quote-fixture',
    modelId: 'staff-approved-native', promptVersion: 'staff-quote-v1', state: 'succeeded', generationId: 'quote-generation', metrics: {
      staffQuoteAttestation: { version: 1, kind: 'staff_approved_quote', transportId: scope.transportId,
        userId: scope.actorUserId, threadId: 'thread-1', messageId: 'quote-message', sourceHash: staffQuoteSourceHash(quoteMail!),
        selectionEpoch: 1, inputRevision: 1, inputDigest: 'input-digest', authorizationId: revision.authorizationId,
        revisionIds: [revision.id], header: { company: '', agency: '' } },
      reservationistResult: { quoteRevisionIds: [revision.id], quoteRevisions: [revision], proposalFacts: [] },
    } });
  return { itemId: item!.id, input: { ...template, workItemId: item!.id } };
}

async function claim(db: DB, itemId: string) {
  const [item] = await db.select().from(workItem).where(eq(workItem.id, itemId));
  const claimId = randomUUID();
  await db.update(workItem).set({ state: { ...item!.state, paneStaySaveClaims: { [CASE_STAY_ID]: claimId },
    stays: { [CASE_STAY_ID]: { status: 'unknown', confirmationNumber: null, screenshotRef: null } } } }).where(eq(workItem.id, itemId));
  return claimId;
}

describe('durable create-plan approval', () => {
  it('stores the displayed plan, uses only its captured stay, and consumes one grant', async () => {
    await withIngestionDb(async ({ db, url }) => {
      const { itemId, input } = await seed(db);
      const envelope = await prepareHmsCreatePlan(db, scope, input, PLAN_NOW);
      expect(envelope.plan).toMatchObject({ propertyCode: 'HRCEN', workItemId: itemId,
        sourceMessageId: 'selected-message', quote: { sourceMessageId: 'quote-message', totalMinor: 22051,
          appliedToBooking: 'unverified', inventoryHeld: false },
        steps: [{ id: CASE_STAY_ID, stay: { firstName: 'Proof', lastName: 'Labtest', childAges: [6] },
          sideEffects: { confirmationSendMail: false, confirmationRecipient: null, nativeAddOns: [] } }] });
      expect(envelope.plan.quote.nightly).toEqual([
        { date: '2027-09-14', amountMinor: 10001 }, { date: '2027-09-15', amountMinor: 12050 },
      ]);
      const ref = { transportId: scope.transportId, workItemId: itemId, planId: envelope.plan.id, digest: envelope.digest };
      await expect(loadHmsCreatePlan(db, { ...ref, digest: '0'.repeat(64) })).rejects.toThrow('plan_changed');
      envelope.plan.steps[0]!.stay.firstName = 'Modified client copy';
      const stored = await loadHmsCreatePlan(db, ref);
      expect(stored.plan.steps[0]!.stay.firstName).toBe('Proof');
      await expect(consumeHmsCreatePlan(db, { ...ref, actorUserId: scope.actorUserId, claimId: randomUUID() }, PLAN_NOW))
        .rejects.toThrow('claim_missing');
      const claimId = await claim(db, itemId);
      await expect(approveHmsWrite({ db, ...scope, workItemId: itemId, now: PLAN_NOW })).rejects.toMatchObject({ refusal: 'needs_check_open' });
      // The test helper's normal pool has one connection; use two so the transactions can overlap.
      const pool = postgres(url, { max: 2, onnotice: () => undefined });
      const concurrentDb = drizzle(pool, { schema });
      let attempts: PromiseSettledResult<unknown>[];
      try {
        await Promise.all([pool`SELECT 1`, pool`SELECT 1`]);
        attempts = await Promise.allSettled([1, 2].map(() => consumeHmsCreatePlan(concurrentDb,
          { ...ref, actorUserId: scope.actorUserId, claimId }, PLAN_NOW)));
      } finally {
        await pool.end();
      }
      expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
      expect(attempts.filter((attempt) => attempt.status === 'rejected')).toHaveLength(1);
      const events = await db.select().from(workEvent).where(eq(workEvent.workItemId, itemId));
      expect(events.filter((event) => event.type === 'approval.granted')).toHaveLength(1);
      expect(events.filter((event) => event.type === 'approval.consumed')).toHaveLength(1);
      const granted = events.find((event) => event.type === 'approval.granted')!;
      expect(granted.value).toMatchObject({ actorUserId: scope.actorUserId, planDigest: ref.digest,
        plan: { steps: [{ stay: { firstName: 'Proof' } }] } });
      expect(events.find((event) => event.type === 'approval.consumed')!.payloadHash).toBe(granted.payloadHash);
    });
  });

  it('refuses an edited case, selected email, preview or expired review', async () => {
    await withIngestionDb(async ({ db }) => {
      const { itemId, input } = await seed(db);
      const envelope = await prepareHmsCreatePlan(db, scope, input, PLAN_NOW);
      const claimId = await claim(db, itemId);
      const ref = { ...scope, workItemId: itemId, planId: envelope.plan.id, digest: envelope.digest, claimId };
      await expect(consumeHmsCreatePlan(db, ref, new Date(PLAN_NOW.getTime() + 600_000))).rejects.toThrow('plan_expired_or_changed');
      const [claimed] = await db.select().from(workItem).where(eq(workItem.id, itemId));
      await db.update(workItem).set({ state: { ...claimed!.state, selectedCase: 'case-2' } }).where(eq(workItem.id, itemId));
      await expect(consumeHmsCreatePlan(db, ref, PLAN_NOW)).rejects.toThrow('plan_changed');
      await db.update(workItem).set({ state: claimed!.state }).where(eq(workItem.id, itemId));
      await db.update(message).set({ textBody: 'Changed booking request' }).where(eq(message.id, 'selected-message'));
      await expect(consumeHmsCreatePlan(db, ref, PLAN_NOW)).rejects.toThrow('plan_changed');
      await db.update(message).set({ textBody: 'The selected booking request' }).where(eq(message.id, 'selected-message'));
      await db.update(workItem).set({ state: { ...claimed!.state, stayPreviews: {} } }).where(eq(workItem.id, itemId));
      await expect(consumeHmsCreatePlan(db, ref, PLAN_NOW)).rejects.toThrow('preview_changed');
      const approvals = await db.select().from(workEvent).where(and(eq(workEvent.workItemId, itemId), eq(workEvent.type, 'approval.granted')));
      expect(approvals).toHaveLength(0);
    });
  });

  it('does not let another mailbox, a changed revision or a changed plan approve the stay', async () => {
    await withIngestionDb(async ({ db }) => {
      const { itemId, input } = await seed(db);
      await expect(prepareHmsCreatePlan(db, { ...scope, transportId: 'wrong-mailbox' }, input, PLAN_NOW)).rejects.toThrow('work_item_missing');
      const first = await prepareHmsCreatePlan(db, scope, input, PLAN_NOW);
      const second = await prepareHmsCreatePlan(db, scope, input, PLAN_NOW);
      await expect(loadHmsCreatePlan(db, { transportId: scope.transportId, workItemId: itemId,
        planId: first.plan.id, digest: first.digest })).rejects.toThrow('plan_changed');
      const claimId = await claim(db, itemId);
      await db.update(workItem).set({ revisionSeq: 1 }).where(eq(workItem.id, itemId));
      await expect(consumeHmsCreatePlan(db, { ...scope, workItemId: itemId, planId: second.plan.id,
        digest: second.digest, claimId }, PLAN_NOW)).rejects.toThrow('plan_expired_or_changed');
    });
  });

  it('refuses a create plan while the existing HMS write runner is in flight', async () => {
    await withIngestionDb(async ({ db }) => {
      const { itemId, input } = await seed(db);
      await db.insert(aiWorkflowRun).values({ id: 'hms-write-1', transportId: scope.transportId, threadId: 'thread-1',
        triggerMessageId: 'selected-message', runKind: 'hms_write', idempotencyKey: 'hms-write:fixture',
        modelId: 'none', promptVersion: 'hms-write/1', state: 'queued', workItemId: itemId });
      await expect(prepareHmsCreatePlan(db, scope, input, PLAN_NOW)).rejects.toMatchObject({ refusal: 'write_in_flight' });
    });
  });

  it('refuses another one-room plan after any saved or uncertain room in that case', async () => {
    await withIngestionDb(async ({ db }) => {
      const { itemId, input } = await seed(db);
      const [item] = await db.select().from(workItem).where(eq(workItem.id, itemId));
      await db.update(workItem).set({ state: { ...item!.state, stays: {
        other: { status: 'booked', confirmationNumber: '123456-1', screenshotRef: null },
      } } }).where(eq(workItem.id, itemId));
      await expect(prepareHmsCreatePlan(db, scope, input, PLAN_NOW)).rejects.toThrow('stay_already_attempted');
    });
  });

  it('refuses a different room recorded after the one-room claim was made', async () => {
    await withIngestionDb(async ({ db }) => {
      const { itemId, input } = await seed(db);
      const envelope = await prepareHmsCreatePlan(db, scope, input, PLAN_NOW);
      const claimId = await claim(db, itemId);
      const [item] = await db.select().from(workItem).where(eq(workItem.id, itemId));
      await db.update(workItem).set({ state: { ...item!.state, stays: { ...(item!.state.stays as object),
        other: { status: 'booked', confirmationNumber: '123456-1', screenshotRef: null },
      } } }).where(eq(workItem.id, itemId));
      await expect(consumeHmsCreatePlan(db, { ...scope, workItemId: itemId, planId: envelope.plan.id,
        digest: envelope.digest, claimId }, PLAN_NOW)).rejects.toThrow('stay_already_attempted');
    });
  });

  it('refuses a newer staff quote even if it is still running or was requested by someone else', async () => {
    await withIngestionDb(async ({ db }) => {
      const { itemId, input } = await seed(db);
      const envelope = await prepareHmsCreatePlan(db, scope, input, PLAN_NOW);
      const claimId = await claim(db, itemId);
      await db.insert(aiDraftGeneration).values({ id: 'newer-quote', transportId: scope.transportId,
        threadId: 'thread-1', requestedByUserId: 'staff-2', contextMessageIds: ['selected-message'],
        model: 'staff-approved-native', promptVersion: 'staff-quote-v1', status: 'running', createdAt: PLAN_NOW });
      await expect(consumeHmsCreatePlan(db, { ...scope, workItemId: itemId, planId: envelope.plan.id,
        digest: envelope.digest, claimId }, PLAN_NOW)).rejects.toThrow('quote_superseded');
      const approvals = await db.select().from(workEvent).where(and(eq(workEvent.workItemId, itemId), eq(workEvent.type, 'approval.granted')));
      expect(approvals).toHaveLength(0);
    });
  });

  it('refuses a case re-extraction after staff saw the plan', async () => {
    await withIngestionDb(async ({ db }) => {
      const { itemId, input } = await seed(db);
      const envelope = await prepareHmsCreatePlan(db, scope, input, PLAN_NOW);
      expect(envelope.plan.caseRead?.id).toBeTruthy();
      const claimId = await claim(db, itemId);
      const [changed] = await db.insert(mailExtraction).values({ messageId: 'selected-message', extractorVersion: 'test-v2',
        status: 'succeeded', kind: 'booking', createdAt: PLAN_NOW,
        payload: { ...CASE_READ, contact: { name: 'Changed', email: null, phone: null } } }).returning();
      const ref = { ...scope, workItemId: itemId, planId: envelope.plan.id, digest: envelope.digest, claimId };
      await expect(consumeHmsCreatePlan(db, ref, PLAN_NOW)).rejects.toThrow('case_read_superseded');
      await db.update(workItem).set({ extractionId: changed!.id }).where(eq(workItem.id, itemId));
      await expect(consumeHmsCreatePlan(db, ref, PLAN_NOW)).rejects.toThrow('plan_changed');
    });
  });

  it('refuses case reads whose order is ambiguous at the same timestamp', async () => {
    await withIngestionDb(async ({ db }) => {
      const { input } = await seed(db);
      await db.insert(mailExtraction).values({ messageId: 'selected-message', extractorVersion: 'test-tie',
        status: 'succeeded', kind: 'booking', payload: CASE_READ, createdAt: new Date(PLAN_NOW.getTime() - 120_000) });
      await expect(prepareHmsCreatePlan(db, scope, input, PLAN_NOW)).rejects.toThrow('case_read_superseded');
    });
  });
});
