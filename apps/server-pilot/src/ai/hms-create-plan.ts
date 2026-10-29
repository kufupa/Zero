import { randomUUID } from 'node:crypto';
import { and, asc, eq, gte, ne } from 'drizzle-orm';
import { z } from 'zod';
import type { DB } from '../db/client.js';
import { aiDraftGeneration, aiWorkflowRun, attachment, mailboxTransport, message } from '../db/schema/mail.js';
import { workEvent, workItem } from '../db/schema/work.js';
import { occupiedDates, PRICED_QUOTE_REUSE_MS, quoteDigest, type QuoteRevision } from '../quote-proposal/quote-revision.js';
import { profileFor, stayBookFieldRefusal } from '../../tooling/playwright-quote/property-profile.mjs';
import { resolvePropertyTransport } from '../../tooling/playwright-quote/property-registry.mjs';
import { assertReservationistResultFreshForAction } from './draft-approval.js';
import { isSelfSentPreStayInformationMail } from './existing-stay-information.js';
import { assertNoOpenWrite, hmsStateDigest } from './hms-approval.js';
import { paneStayDigest, PANE_PREVIEW_TTL_MS } from './pane-stay-save.js';
import { stayPreviewGrantOf, stayPreviewOf } from './pane-stay-preview-persist.js';
import { staffQuoteSourceHash } from './staff-quote-workflow.js';
import { stayCommitOf } from './work-items.js';

const PLAN_KEY = 'hmsCreatePlan';
const DIGEST = /^[a-f0-9]{64}$/;
const requiredText = (max: number) => z.string().max(max).refine((s) => s.trim().length > 0);
const party = z.object({
  name: requiredText(100),
  nativeId: z.string().trim().min(1).max(40).optional(),
  id: z.string().trim().min(1).max(40).optional(),
}).strict();

/** The create runner's supported request. An unrecognized side effect must never be silently stripped. */
export const hmsCreateStayInput = z.object({
  firstName: requiredText(200), lastName: requiredText(200),
  arrival: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), departure: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  adults: z.number().int().min(1).max(16), childAges: z.array(z.number().int().min(0).max(17)).max(16).optional(),
  sourceOfBusiness: requiredText(200), roomType: requiredText(200), ratePlan: requiredText(200),
  track: requiredText(200), guaranteeType: requiredText(200),
  cmsMessageId: z.string().trim().min(1).max(8), propertyCode: z.string().optional(),
  bookingAgency: party.optional(), organization: party.optional(),
  reservationNote: z.string().max(2000).optional(), bookerName: z.string().max(50).optional(),
  bookerEmail: z.string().max(80).optional(), marketSegment: z.string().max(80).optional(),
  guestoptin4: z.boolean().optional(),
  // The current card includes this UI flag; the runner derives it from the recipient instead.
  confirmationSendMail: z.literal(false).optional(),
}).strict().transform(({ confirmationSendMail: _send, ...stay }) => stay);

export const prepareHmsCreatePlanInput = z.object({
  workItemId: z.string().uuid(), stayId: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
  quoteRunId: requiredText(200), revisionId: requiredText(200), groupId: requiredText(200),
  previewDigest: z.string().regex(DIGEST), stay: hmsCreateStayInput,
}).strict();
const staffQuoteAttestation = z.object({
  version: z.literal(1), kind: z.literal('staff_approved_quote'), transportId: requiredText(200),
  userId: requiredText(200), threadId: requiredText(200), messageId: requiredText(200),
  sourceHash: z.string().regex(DIGEST), authorizationId: requiredText(200), revisionIds: z.array(z.string()).min(1),
  rowPrices: z.array(z.unknown()).optional(), dinnerAddOnRequired: z.boolean().optional(),
}).passthrough();
const quoteResult = z.object({
  quoteRevisionIds: z.array(z.string()), quoteRevisions: z.array(z.record(z.unknown())),
  proposalFacts: z.array(z.unknown()).optional(),
}).passthrough();
export type HmsCreatePlanInput = z.input<typeof prepareHmsCreatePlanInput>;
type ParsedInput = z.output<typeof prepareHmsCreatePlanInput>;

export class HmsCreatePlanError extends Error {
  constructor(readonly reason: string) { super(reason); this.name = 'HmsCreatePlanError'; }
}
function refuse(reason: string): never { throw new HmsCreatePlanError(reason); }

type WorkRow = typeof workItem.$inferSelect;
type Context = {
  item: WorkRow;
  propertyCode: string;
  selectedSourceHash: string;
  quoteSourceMessageId: string;
  quoteSourceHash: string;
  revision: QuoteRevision;
  previewExpiresAt: number;
};

function caseStateDigest(state: Record<string, unknown>): string {
  const { hmsCreatePlan: _plan, stayPreviews: _previews, paneStaySaveClaims: _claims, stays: _stays, ...caseState } = state;
  return hmsStateDigest(caseState);
}

/** The source row and attachment identities bind the case, without copying the mail into an approval. */
async function selectedMailHash(db: DB, mail: typeof message.$inferSelect): Promise<string> {
  const files = await db.select({
    id: attachment.id, name: attachment.filename, mimeType: attachment.mimeType,
    size: attachment.sizeBytes, sha256: attachment.sha256, s3Key: attachment.s3Key, inline: attachment.isInline,
  }).from(attachment).where(eq(attachment.messageId, mail.id)).orderBy(asc(attachment.id));
  if (files.some((file) => !file.inline && !DIGEST.test(file.sha256 ?? ''))) refuse('attachment_identity_unverified');
  return quoteDigest({
    id: mail.id, transportId: mail.transportId, threadId: mail.threadId, direction: mail.direction,
    from: mail.fromAddress, to: mail.toAddresses, cc: mail.ccAddresses, bcc: mail.bccAddresses, subject: mail.subject,
    text: mail.textBody, html: mail.htmlBody, files,
  });
}

export function assertHmsCreatePlanQuote(revision: QuoteRevision, input: ParsedInput, now: Date): void {
  const { id, ...data } = revision;
  if (id !== `quote:${quoteDigest(data)}` || id !== input.revisionId || revision.version !== 1 ||
      !Array.isArray(revision.groups) || revision.groups.length !== 1 || revision.held !== false ||
      revision.inventoryStatus !== 'observed_not_held') refuse('quote_invalid');
  const group = revision.groups[0];
  if (!group || group.id !== input.groupId || group.quantity !== 1 ||
      !Array.isArray(group.childAges) || group.children !== group.childAges.length ||
      group.childAges.some((age) => !Number.isInteger(age) || age < 0 || age > 17) || !DIGEST.test(group.sourceHash) ||
      !group.sourceRef || !group.toolVersion || !Number.isFinite(Date.parse(group.observedAt)) ||
      Date.parse(group.observedAt) > now.getTime() ||
      Date.parse(revision.sourceFreshness?.observedAt ?? '') !== Date.parse(group.observedAt) ||
      !revision.sourceFreshness?.sourceRefs?.includes(group.sourceRef)) refuse('quote_invalid');
  try { assertReservationistResultFreshForAction({ version: 1, quoteRevisions: [revision] }, now); }
  catch { refuse('quote_expired'); }
  const stay = input.stay;
  const sortedAges = (ages: number[]) => [...ages].sort((a, b) => a - b);
  if (group.arrivalDate !== stay.arrival || group.departureDate !== stay.departure ||
      group.adults !== stay.adults || quoteDigest(sortedAges(group.childAges)) !== quoteDigest(sortedAges(stay.childAges ?? [])) ||
      group.roomCode !== stay.roomType || group.rateCode !== stay.ratePlan) refuse('quote_scope_changed');
  let dates: string[];
  try { dates = occupiedDates(stay.arrival, stay.departure); } catch { return refuse('quote_invalid'); }
  if (!/^[A-Z]{3}$/.test(group.currency) || revision.currency !== group.currency ||
      !Array.isArray(group.nightly) || group.nightly.length !== dates.length || group.nightly.some((night, i) =>
        night.date !== dates[i] || !Number.isSafeInteger(night.amountMinor) || night.amountMinor <= 0) ||
      !Number.isSafeInteger(group.perRoomMinor) || group.perRoomMinor !== group.nightly.reduce((n, night) => n + night.amountMinor, 0) ||
      group.totalMinor !== group.perRoomMinor || revision.totalMinor !== group.totalMinor) refuse('quote_prices_unverified');

  // The create runner currently types company names without selecting or reading back the native company ID.
  if (stay.organization || group.context?.organization) refuse('company_create_unverified');
  const quotedAgency = group.context?.agency as { id?: unknown; nativeId?: unknown; name?: unknown } | undefined;
  const agency = stay.bookingAgency;
  const agencyId = agency?.nativeId ?? agency?.id;
  const quotedId = quotedAgency?.id ?? quotedAgency?.nativeId;
  if (Boolean(agency) !== Boolean(quotedAgency) ||
      (agency && (!agencyId || (agency.id && agency.nativeId && agency.id !== agency.nativeId) ||
        String(quotedId ?? '') !== agencyId ||
        (typeof quotedAgency?.name === 'string' && quotedAgency.name.trim().toLowerCase() !== agency.name.trim().toLowerCase())))) {
    refuse('agency_scope_changed');
  }
}

async function loadContext(db: DB, item: WorkRow, input: ParsedInput, now: Date): Promise<Context> {
  if (item.status === 'done' || item.status === 'dismissed') refuse('work_item_closed');
  if (item.kind !== 'quote' && item.kind !== 'booking') refuse('case_not_supported');
  if (!item.threadId || !item.sourceMessageId) refuse('source_mail_missing');
  await assertNoOpenWrite(db, item.id);
  const property = resolvePropertyTransport(item.transportId);
  if (property.kind !== 'property' || property.property.propertyCode !== 'HRCEN') refuse('property_unsupported');
  const propertyCode = property.property.propertyCode;
  if (input.stay.propertyCode && input.stay.propertyCode !== propertyCode) refuse('property_changed');
  const fieldRefusal = stayBookFieldRefusal(input.stay, profileFor(propertyCode));
  if (fieldRefusal) refuse(fieldRefusal);
  const preview = stayPreviewGrantOf(stayPreviewOf(item.state, input.stayId), input.previewDigest, now.getTime());
  if (!preview || paneStayDigest(input.stay) !== input.previewDigest) refuse('preview_changed');

  const [selected] = await db.select().from(message).where(and(
    eq(message.id, item.sourceMessageId), eq(message.transportId, item.transportId), eq(message.threadId, item.threadId),
  )).limit(1);
  const [mailbox] = await db.select({ email: mailboxTransport.email }).from(mailboxTransport)
    .where(eq(mailboxTransport.id, item.transportId)).limit(1);
  if (!selected || !mailbox) refuse('source_mail_missing');
  if (isSelfSentPreStayInformationMail({ fromAddress: selected.fromAddress, mailboxAddress: mailbox.email, subject: selected.subject })) {
    refuse('existing_stay_information');
  }
  const [run] = await db.select().from(aiWorkflowRun).where(and(
    eq(aiWorkflowRun.id, input.quoteRunId), eq(aiWorkflowRun.transportId, item.transportId),
    eq(aiWorkflowRun.threadId, item.threadId), eq(aiWorkflowRun.runKind, 'candidate_draft'), eq(aiWorkflowRun.state, 'succeeded'),
  )).limit(1);
  const parsedAttestation = staffQuoteAttestation.safeParse(run?.metrics?.staffQuoteAttestation);
  const parsedResult = quoteResult.safeParse(run?.metrics?.reservationistResult);
  if (!run || !parsedAttestation.success || !parsedResult.success) refuse('quote_not_found');
  const attestation = parsedAttestation.data;
  const result = parsedResult.data;
  if (attestation.transportId !== item.transportId || attestation.threadId !== item.threadId ||
      attestation.messageId !== run.triggerMessageId || !attestation.revisionIds.includes(input.revisionId) ||
      !result.quoteRevisionIds.includes(input.revisionId)) refuse('quote_not_found');
  if (attestation.rowPrices?.length || attestation.dinnerAddOnRequired || result.proposalFacts?.length) refuse('quote_extra_not_supported');
  if (!run.generationId) refuse('quote_not_found');
  const [generation] = await db.select().from(aiDraftGeneration).where(and(
    eq(aiDraftGeneration.id, run.generationId), eq(aiDraftGeneration.transportId, item.transportId),
    eq(aiDraftGeneration.threadId, item.threadId), eq(aiDraftGeneration.model, 'staff-approved-native'),
    eq(aiDraftGeneration.requestedByUserId, attestation.userId), eq(aiDraftGeneration.status, 'succeeded'),
  )).limit(1);
  if (!generation || !generation.contextMessageIds.includes(run.triggerMessageId)) refuse('quote_not_found');
  // Any later staff quote in this thread can change this one-room case. A tie is ambiguous, so fail closed.
  const [newer] = await db.select({ id: aiDraftGeneration.id }).from(aiDraftGeneration).where(and(
    eq(aiDraftGeneration.transportId, item.transportId), eq(aiDraftGeneration.threadId, item.threadId),
    eq(aiDraftGeneration.model, 'staff-approved-native'), ne(aiDraftGeneration.id, generation.id),
    gte(aiDraftGeneration.createdAt, generation.createdAt),
  )).limit(1);
  if (newer) refuse('quote_superseded');
  const revisions = result.quoteRevisions.filter((row) => row.id === input.revisionId) as unknown as QuoteRevision[];
  if (revisions.length !== 1 || revisions[0]!.authorizationId !== attestation.authorizationId || revisions[0]!.propertyCode !== propertyCode) {
    refuse('quote_not_found');
  }
  const [quoteSource] = await db.select().from(message).where(and(
    eq(message.id, run.triggerMessageId), eq(message.transportId, item.transportId), eq(message.threadId, item.threadId),
  )).limit(1);
  if (!quoteSource || staffQuoteSourceHash(quoteSource) !== attestation.sourceHash) refuse('quote_source_changed');
  assertHmsCreatePlanQuote(revisions[0]!, input, now);
  return {
    item, propertyCode, selectedSourceHash: await selectedMailHash(db, selected),
    quoteSourceMessageId: quoteSource.id, quoteSourceHash: attestation.sourceHash,
    revision: revisions[0]!, previewExpiresAt: preview.expiresAt,
  };
}

function buildPlan(input: ParsedInput, context: Context, prepared: { id: string; at: string; by: string }) {
  const group = context.revision.groups[0]!;
  const expiresAt = Math.min(context.previewExpiresAt, Date.parse(prepared.at) + PANE_PREVIEW_TTL_MS,
    Date.parse(group.observedAt) + PRICED_QUOTE_REUSE_MS, Date.parse(context.revision.sourceFreshness!.expiresAt));
  if (!Number.isFinite(expiresAt)) refuse('quote_invalid');
  return {
    version: 1 as const, id: prepared.id, preparedAt: prepared.at, preparedBy: prepared.by,
    expiresAt: new Date(expiresAt).toISOString(),
    propertyCode: context.propertyCode, transportId: context.item.transportId, workItemId: context.item.id,
    workItemRevision: context.item.revisionSeq, caseStateDigest: caseStateDigest(context.item.state), threadId: context.item.threadId!,
    sourceMessageId: context.item.sourceMessageId!, selectedSourceHash: context.selectedSourceHash,
    quote: {
      runId: input.quoteRunId, revisionId: input.revisionId, groupId: input.groupId,
      sourceMessageId: context.quoteSourceMessageId, sourceHash: context.quoteSourceHash,
      observedAt: group.observedAt, sourceRef: group.sourceRef, sourceDigest: group.sourceHash,
      currency: group.currency, nightly: group.nightly.map(({ date, amountMinor }) => ({ date, amountMinor })),
      totalMinor: group.totalMinor, inventoryHeld: false as const, appliedToBooking: 'unverified' as const,
    },
    steps: [{ id: input.stayId, kind: 'create_stay' as const, stay: input.stay, previewDigest: input.previewDigest,
      sideEffects: { confirmationSendMail: false as const, confirmationRecipient: null,
        guestOptIn: input.stay.guestoptin4 === true, nativeAddOns: [] as never[] } }],
  };
}

export type HmsCreatePlan = ReturnType<typeof buildPlan>;
export type HmsCreatePlanEnvelope = { plan: HmsCreatePlan; digest: string };

/** Persist the exact, server-built plan that will be shown before the one approval click. */
export async function prepareHmsCreatePlan(db: DB, scope: { transportId: string; actorUserId: string }, raw: HmsCreatePlanInput, now = new Date()): Promise<HmsCreatePlanEnvelope> {
  const parsed = prepareHmsCreatePlanInput.safeParse(raw);
  if (!parsed.success || !scope.actorUserId || !Number.isFinite(now.getTime())) refuse('plan_input_invalid');
  const input = parsed.data;
  return db.transaction(async (tx) => {
    const [item] = await tx.select().from(workItem).where(and(eq(workItem.id, input.workItemId), eq(workItem.transportId, scope.transportId))).limit(1).for('update');
    if (!item) refuse('work_item_missing');
    if (stayCommitOf(item.state, input.stayId) || item.state.paneStaySaveClaims) refuse('stay_already_attempted');
    const context = await loadContext(tx as DB, item, input, now);
    const plan = buildPlan(input, context, { id: randomUUID(), at: now.toISOString(), by: scope.actorUserId });
    const envelope = { plan, digest: hmsStateDigest(plan) };
    await tx.update(workItem).set({ state: { ...item.state, [PLAN_KEY]: envelope }, updatedAt: now }).where(eq(workItem.id, item.id));
    return envelope;
  });
}

/** Load by ID and displayed digest; no caller-supplied stay or price is accepted on approval. */
export async function loadHmsCreatePlan(db: DB, scope: { transportId: string; workItemId: string; planId: string; digest: string }): Promise<HmsCreatePlanEnvelope> {
  const [item] = await db.select({ state: workItem.state }).from(workItem)
    .where(and(eq(workItem.id, scope.workItemId), eq(workItem.transportId, scope.transportId))).limit(1);
  const envelope = item?.state[PLAN_KEY] as HmsCreatePlanEnvelope | undefined;
  if (!envelope?.plan || envelope.plan.id !== scope.planId || envelope.digest !== scope.digest ||
      !DIGEST.test(scope.digest) || hmsStateDigest(envelope.plan) !== scope.digest) refuse('plan_changed');
  return envelope;
}

/** Called after the property-wide commit claim and immediately before invoking the existing runner. */
export async function consumeHmsCreatePlan(db: DB, scope: { transportId: string; actorUserId: string; workItemId: string; planId: string; digest: string; claimId: string }, now = new Date()): Promise<HmsCreatePlan> {
  return db.transaction(async (tx) => {
    const [item] = await tx.select().from(workItem).where(and(eq(workItem.id, scope.workItemId), eq(workItem.transportId, scope.transportId))).limit(1).for('update');
    const envelope = item?.state[PLAN_KEY] as HmsCreatePlanEnvelope | undefined;
    if (!item || !envelope?.plan || envelope.plan.id !== scope.planId || envelope.digest !== scope.digest ||
        !DIGEST.test(scope.digest) || hmsStateDigest(envelope.plan) !== scope.digest) refuse('plan_changed');
    const plan = envelope.plan;
    if (!scope.actorUserId || !Number.isFinite(now.getTime()) || !Number.isFinite(Date.parse(plan.preparedAt)) ||
        Date.parse(plan.preparedAt) > now.getTime() || !Number.isFinite(Date.parse(plan.expiresAt)) || Date.parse(plan.expiresAt) <= now.getTime() ||
        plan.workItemRevision !== item.revisionSeq || !Array.isArray(plan.steps) || plan.steps.length !== 1) refuse('plan_expired_or_changed');
    const step = plan.steps[0]!;
    if (!step || typeof step !== 'object' || typeof step.id !== 'string') refuse('plan_changed');
    const claims = item.state.paneStaySaveClaims as Record<string, unknown> | undefined;
    const claimed = stayCommitOf(item.state, step.id);
    if (!claims || claims[step.id] !== scope.claimId || claimed?.status !== 'unknown' || claimed.confirmationNumber !== null) refuse('claim_missing');
    const parsed = prepareHmsCreatePlanInput.safeParse({ workItemId: item.id, stayId: step.id,
      quoteRunId: plan.quote?.runId, revisionId: plan.quote?.revisionId, groupId: plan.quote?.groupId,
      previewDigest: step.previewDigest, stay: step.stay });
    if (!parsed.success) refuse('plan_changed');
    const context = await loadContext(tx as DB, item, parsed.data, now);
    const rebuilt = buildPlan(parsed.data, context, { id: plan.id, at: plan.preparedAt, by: plan.preparedBy });
    if (hmsStateDigest(rebuilt) !== scope.digest) refuse('plan_changed');
    const [existing] = await tx.select({ id: workEvent.id }).from(workEvent).where(eq(workEvent.id, plan.id)).limit(1);
    if (existing) refuse('plan_already_consumed');
    const grant = { kind: 'create_stay_plan', grantId: plan.id, actorUserId: scope.actorUserId,
      transportId: scope.transportId, workItemId: item.id, planDigest: scope.digest, plan };
    const payloadHash = hmsStateDigest(grant);
    await tx.insert(workEvent).values({ id: plan.id, workItemId: item.id, at: now, actorKind: 'user',
      actorUserId: scope.actorUserId, type: 'approval.granted', payloadHash, expiresAt: new Date(plan.expiresAt), value: grant });
    await tx.insert(workEvent).values({ workItemId: item.id, at: now, actorKind: 'system',
      type: 'approval.consumed', payloadHash, value: { grantId: plan.id, planDigest: scope.digest, claimId: scope.claimId } });
    return rebuilt;
  });
}
