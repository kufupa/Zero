import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { DB } from '../src/db/client.js';
import { aiWorkflowRun, message } from '../src/db/schema/mail.js';
import { workEvent, workItem } from '../src/db/schema/work.js';
import { consumeHmsCreatePlan, loadHmsCreatePlan, prepareHmsCreatePlan } from '../src/ai/hms-create-plan.js';
import { approveHmsWrite } from '../src/ai/hms-approval.js';
import { staffQuoteSourceHash } from '../src/ai/staff-quote-workflow.js';
import { PLAN_NOW, quotedPlanFixture } from './helpers/hms-create-plan-fixture.js';
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
  const [item] = await db.insert(workItem).values({ transportId: scope.transportId, threadId: 'thread-1',
    sourceMessageId: 'selected-message', kind: 'booking', state: { selectedCase: 'case-1', stayPreviews: {
      room1: { status: 'previewed', digest: template.previewDigest, expiresAt: PLAN_NOW.getTime() + 600_000 },
    } } }).returning();
  await db.insert(aiWorkflowRun).values({ id: template.quoteRunId, transportId: scope.transportId, threadId: 'thread-1',
    triggerMessageId: 'quote-message', runKind: 'candidate_draft', idempotencyKey: 'quote-fixture',
    modelId: 'staff-approved-native', promptVersion: 'staff-quote-v1', state: 'succeeded', metrics: {
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
  await db.update(workItem).set({ state: { ...item!.state, paneStaySaveClaims: { room1: claimId },
    stays: { room1: { status: 'unknown', confirmationNumber: null, screenshotRef: null } } } }).where(eq(workItem.id, itemId));
  return claimId;
}

describe('durable create-plan approval', () => {
  it('stores the displayed plan, uses only its captured stay, and consumes one grant', async () => {
    await withIngestionDb(async ({ db }) => {
      const { itemId, input } = await seed(db);
      const envelope = await prepareHmsCreatePlan(db, scope, input, PLAN_NOW);
      expect(envelope.plan).toMatchObject({ propertyCode: 'HRCEN', workItemId: itemId,
        sourceMessageId: 'selected-message', quote: { sourceMessageId: 'quote-message', totalMinor: 22051,
          appliedToBooking: 'unverified', inventoryHeld: false },
        steps: [{ id: 'room1', stay: { firstName: 'Proof', lastName: 'Labtest', childAges: [6] },
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
      const attempts = await Promise.allSettled([1, 2].map(() => consumeHmsCreatePlan(db,
        { ...ref, actorUserId: scope.actorUserId, claimId }, PLAN_NOW)));
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
});
