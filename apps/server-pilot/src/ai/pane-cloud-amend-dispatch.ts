import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type { DB } from '../db/client.js';
import { workEvent } from '../db/schema/work.js';
import { canonicalJson } from './draft-approval.js';
import { cloudAmendPreservedSchema } from './cloud-amend-price-projection.js';
import { formDigest, hmsWriteEvidenceKey, lockConsumedCloudAmendApproval, retainedPricesForApproval, type consumeHmsWriteApproval } from './hms-approval.js';
import { claimHmsLabtestDispatch, resolveHmsLabtestDispatch, type HmsLabtestWriteHandle } from './hms-labtest-dispatch.js';
import { cloudAmendChangesSchema, cloudAmendFirstPilotScopeSupported, cloudAmendSourceBindingSchema, lockBoundCloudAmendSource } from './pane-cloud-amend.js';
import type { AiRunFence } from './run-ledger.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const native = z.object({
  source: z.literal('record_view_ext_model'), propertyCode: z.literal('HRCEN'),
  firstName: z.literal('Proof'), lastName: z.literal('Labtest'), status: z.literal('Reserved'),
  confirmation: z.string().regex(/^\d{6,}-\d+$/), guestId: z.string().regex(/^\d{1,30}$/),
  reservationStayId: z.string().regex(/^\d{1,100}$/), reservationId: z.string().regex(/^\d{1,100}$/),
  recordId: z.string().regex(/^\d{1,100}$/), roomType: z.string().regex(/^[A-Z0-9]{1,12}$/),
  arrival: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => value >= '2027-01-01'),
  departure: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), ratePlan: z.string().regex(/^[A-Z0-9]{1,12}$/),
  adults: z.number().int().min(1).max(16), children: z.number().int().min(0).max(9),
  childAges: z.union([z.array(z.number().int().min(0).max(17)).max(9), z.literal('unknown')]),
}).passthrough();
export const cloudAmendDispatchFormSchema = z.object({
  action: z.literal('amend'), confirmation: z.string().regex(/^\d{6,}-\d+$/),
  arrival: z.string(), fields: cloudAmendChangesSchema, previewDigest: digest,
  cloudAmend: z.object({ binding: cloudAmendSourceBindingSchema, nativeDigest: digest, preserved: cloudAmendPreservedSchema,
    preimage: z.object({ native }).passthrough(), approvedPrices: z.object({ version: z.literal(1),
      currency: z.string().regex(/^[A-Z]{3}$/), fields: z.record(z.string(), z.unknown()) }).strict() }).strict(),
}).passthrough();
const processIdentity = z.object({ pid: z.number().int().safe().min(2), started: z.string().regex(/^\d+$/) }).strict();
const writerIdentity = z.object({ host: digest, bootId: z.string().uuid(), pidNamespace: z.string().regex(/^pid:\[\d+\]$/),
  node: processIdentity, browser: processIdentity }).strict();
const step = z.object({ operationDigest: digest, phase: z.enum(['amend.availability', 'amend.save']),
  requestDigest: digest, beforeEvidence: z.object({ eventId: z.string().uuid(), sha256: digest }).strict(),
  writer: writerIdentity }).strict();
type Consumed = Awaited<ReturnType<typeof consumeHmsWriteApproval>>;
type DispatchTx = Parameters<Parameters<DB['transaction']>[0]>[0];

/** The pre-effect screenshot must already be sealed on this exact run. */
async function requireEvidence(tx: DispatchTx, input: {
  transportId: string; workItemId: string; runId: string; eventId: string; sha256: string;
}, name: 'before.png' | 'after.png'): Promise<void> {
  const [row] = await tx.select({ value: workEvent.value, evidence: workEvent.evidence }).from(workEvent)
    .where(and(eq(workEvent.id, input.eventId), eq(workEvent.workItemId, input.workItemId),
      eq(workEvent.type, 'write.evidence'), eq(workEvent.actorKind, 'system'), isNull(workEvent.fieldPath)))
    .limit(1).for('share');
  const value = z.object({ runId: z.string().uuid(), name: z.literal(name) }).passthrough().safeParse(row?.value);
  const evidence = z.object({ key: z.string(), sha256: digest, bytes: z.number().int().min(8).max(10 * 1024 * 1024),
    contentType: z.literal('image/png') }).passthrough().safeParse(row?.evidence);
  const key = hmsWriteEvidenceKey({ ...input, name });
  if (!value.success || value.data.runId !== input.runId || !evidence.success || evidence.data.sha256 !== input.sha256 ||
      evidence.data.key !== key) {
    throw new Error('CLOUD_AMEND_EVIDENCE_INVALID');
  }
}
const requireBeforeEvidence = (tx: DispatchTx, input: Parameters<typeof requireEvidence>[1]) =>
  requireEvidence(tx, input, 'before.png');

/** Both sealed images must still belong to the same write run at resolution. */
export async function requireCloudAmendEvidence(tx: DispatchTx, input: {
  transportId: string; workItemId: string; runId: string;
  before: { eventId: string; sha256: string }; after: { eventId: string; sha256: string };
}) {
  const { before, after, ...scope } = input;
  await requireEvidence(tx, { ...scope, ...before }, 'before.png');
  await requireEvidence(tx, { ...scope, ...after }, 'after.png');
}

/**
 * Server-only adapter for the native request fence. It does not validate the
 * HMS payload itself, enable a worker, close an UNKNOWN hold, or start a write.
 * A caller must first match the immutable request and full approved draft.
 */
export function cloudAmendDispatchCallbacks(input: {
  db: DB; fence: AiRunFence; transportId: string; workItemId: string; consumed: Consumed; expectedEpoch: string;
}, deps: {
  claim?: typeof claimHmsLabtestDispatch;
  lockSource?: typeof lockBoundCloudAmendSource;
  lockApproval?: typeof lockConsumedCloudAmendApproval;
  checkEvidence?: typeof requireBeforeEvidence;
  writerCurrent?: (identity: z.infer<typeof writerIdentity>) => boolean;
} = {}) {
  const parsed = cloudAmendDispatchFormSchema.safeParse(input.consumed.form), authority = input.consumed.authority;
  if (!parsed.success || !authority || !digest.safeParse(input.expectedEpoch).success ||
      !z.string().uuid().safeParse(input.workItemId).success ||
      !z.string().uuid().safeParse(input.consumed.grantId).success ||
      parsed.data.confirmation !== parsed.data.cloudAmend.preimage.native.confirmation ||
      parsed.data.arrival !== parsed.data.cloudAmend.preimage.native.arrival ||
      !cloudAmendFirstPilotScopeSupported(parsed.data.cloudAmend.preimage.native, parsed.data.fields) ||
      !retainedPricesForApproval(parsed.data.cloudAmend.approvedPrices)) {
    throw new Error('CLOUD_AMEND_AUTHORITY_INVALID');
  }
  const approvedDigest = formDigest(input.consumed.form);
  const { binding, preimage } = parsed.data.cloudAmend;
  const claim = deps.claim ?? claimHmsLabtestDispatch;
  const lockSource = deps.lockSource ?? lockBoundCloudAmendSource;
  const lockApproval = deps.lockApproval ?? lockConsumedCloudAmendApproval;
  const checkEvidence = deps.checkEvidence ?? requireBeforeEvidence;
  let attempted = false, approvedClaim: string | null = null;

  return {
    operationDigest: approvedDigest,
    async authorizeFirst(raw: z.input<typeof step>): Promise<HmsLabtestWriteHandle> {
      const requested = step.parse(raw);
      if (attempted || requested.operationDigest !== approvedDigest) throw new Error('CLOUD_AMEND_APPROVAL_CHANGED');
      attempted = true; // A lost commit response must never be retried.
      // The native session supplies the identity of its owned Node/browser
      // pair. Without it an UNKNOWN could not be reconciled after a crash.
      const writerCurrent = deps.writerCurrent ?? (await import('../../tooling/playwright-quote/centurion-stay360.mjs') as unknown as {
        centurionWriterCurrent?: (identity: z.infer<typeof writerIdentity>) => boolean;
      }).centurionWriterCurrent;
      if (!writerCurrent?.(requested.writer)) throw new Error('CLOUD_AMEND_WRITER_UNVERIFIED');
      const current = preimage.native;
      const claimInput: Parameters<typeof claimHmsLabtestDispatch>[1] = {
        workItemId: input.workItemId, transportId: input.transportId, actorUserId: authority.actorUserId,
        grantId: input.consumed.grantId, propertyCode: 'HRCEN', firstName: 'Proof', lastName: 'Labtest',
        nativeGuestId: preimage.native.guestId, operation: 'amend', sourceDigest: binding.digest,
        approvedDigest, requestDigest: requested.requestDigest,
        recovery: { version: 1, firstPhase: requested.phase, confirmation: current.confirmation, reservationStayId: current.reservationStayId,
          reservationId: current.reservationId, recordId: current.recordId,
          before: { arrival: current.arrival, departure: current.departure, adults: current.adults,
            children: current.children, childAges: current.childAges, roomType: current.roomType, ratePlan: current.ratePlan },
          approved: parsed.data.fields, nativeDigest: parsed.data.cloudAmend.nativeDigest,
          approvedPrices: parsed.data.cloudAmend.approvedPrices, preserved: parsed.data.cloudAmend.preserved,
          hmsBeforeDigest: input.consumed.hmsBeforeDigest, beforeEvidence: requested.beforeEvidence, writer: requested.writer },
      };
      const encoded = canonicalJson(claimInput);
      const handle = await claim(input.db, claimInput, async (tx) => {
        const item = await lockSource(tx, { workItemId: input.workItemId, transportId: input.transportId, binding });
        if (!item) throw new Error('CLOUD_AMEND_SOURCE_CHANGED');
        await lockApproval(tx, { fence: input.fence, transportId: input.transportId, item,
          grantId: input.consumed.grantId, approvedDigest, authority });
        await checkEvidence(tx, { transportId: input.transportId, workItemId: input.workItemId, runId: input.fence.runId,
          eventId: requested.beforeEvidence.eventId, sha256: requested.beforeEvidence.sha256 });
        if (!writerCurrent(requested.writer)) throw new Error('CLOUD_AMEND_WRITER_UNVERIFIED');
      }, input.expectedEpoch);
      approvedClaim = encoded;
      return handle;
    },
    /** A result may resolve only the exact immutable intent this process claimed. */
    assertResolutionIntent(intent: Parameters<Parameters<typeof resolveHmsLabtestDispatch>[3]>[1]): void {
      const { version: _version, kind: _kind, holdId: _holdId, ownerDigest: _ownerDigest, ...claimed } = intent;
      if (!approvedClaim || canonicalJson(claimed) !== approvedClaim) throw new Error('CLOUD_AMEND_INTENT_CHANGED');
    },
  };
}
