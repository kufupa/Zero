import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { DB } from '../db/client.js';
import { attachment, message } from '../db/schema/mail.js';
import { workEvent, workItem } from '../db/schema/work.js';
import { fileAttachmentPresence } from '../mail/ingest/attachment-evidence.js';
import { lockCanonicalMailbox } from '../mail/ingest/canonical-identity.js';
import { CREATE_GUARANTEES, blockingCreateMatches, createGuaranteeCode, isLabtestGuest, sameCreateGuest, validCreateDates } from '../../tooling/hms-cloud/cloud-create-policy.mjs';
import { isCancelledStatus } from '../../tooling/hms-cloud/cancel-stay-rules.mjs';
import { cloudWriterCurrent, withCloudCredentialLease, type CloudCredentialLease } from '../../tooling/hms-cloud/cloud-session.mjs';
import { getPropertyRegistration } from '../../tooling/hms-cloud/property-registry.mjs';
import { effectiveWorkflowPolicy } from '../../tooling/hms-cloud/hms-workflow-policy.mjs';
import { bindHmsMailboxProperty, isDaVinciMailboxOrigin } from '../hms/mailbox-hms-origin-bind.js';
import { acquisitionWithin, assertTargetAliasesHeld, createPostgresTargetAliasLock, isPropertyReadLockDeadline,
  PANE_PROPERTY_LOCK_WAIT_MS, type HeldTargetAliasLock } from '../hms/property-read-lock.js';
import { canonicalJson } from './draft-approval.js';
import { safeParseStoredMailExtraction } from './extraction/stored-mail-extraction.js';
import { formStays } from './work-items.js';
import { selfSentPreStayCandidate } from './existing-stay-information.js';
import { persistHmsShots, verifyStoredHmsShot, type HmsShotMeta } from './hms-shots-store.js';
import { captureHmsLabtestDispatchEpoch, claimHmsLabtestDispatch, HmsLabtestDispatchError, hmsLabtestIntentTarget, nativeCreateSaveDigest,
  readResolvedHmsLabtestCreates, resolveHmsLabtestDispatch, resolveNeverDispatchedCreate,
  type HmsLabtestIntent, type HmsLabtestWriteHandle } from './hms-labtest-dispatch.js';
import { canonicalSourceBodyText, classifyMailSource } from './mail-source.js';
import { lockCreateActorAccess, lockCreateActorSession } from './pane-create-actor-lock.js';
import { paneStayHmsTargetForTransport } from './pane-stay-spawn-env.js';
import { cloudCreatePolicyIssue, digestPaneCloudCreateProof, mapPaneStayToCloudCreateInput } from './pane-create-cloud-input.js';
import { assertNoCreateDispatchFence, type CreateFenceTransaction } from './pane-create-dispatch-fence.js';
import { activePaneCreateIdentity, currentPaneCreateDatesMatch, legacyPaneCreateRoomId, paneCreateIdentitySchema, paneCreateRoomAliases, paneCreateRoomId,
  type PaneCreateIdentity } from './pane-create-scope.js';
import { lockCreateSourceForCreate as lockCreateSource, withLockedCreateSourceForCreate as withLockedCreateSource,
  type LockedCreateSource } from './pane-create-source-loader.js';
import { hmsDispatchTargetKey, hmsDispatchTargetKeys, hmsDispatchTargetSchema, type HmsDispatchTarget } from './hms-dispatch-target.js';
import { consumeStaffGoAtDispatch, formDigest, hmsAllocationOperationId, hmsStateDigest, prepareNativeHmsWrite } from './hms-approval.js';
import { hmsConfigurationIdentities, preparationDigest } from '../hms/hms-preparation.js';
import { propertyCodeSchema, resolvePropertyScope, type PropertySwitch } from '../hms/property-registry.js';
import { propertyConfigurationForScope } from '../hms/rate-catalogue.js';
import type { VerifiedStaffGo } from '../hms/staff-go-authority.js';
import type { AiRunFence } from './run-ledger.js';
import { PANE_PREVIEW_TTL_MS, PANE_SAVE_UNCONFIRMED, paneStayCreateTarget, paneStayDigest, paneStayModeRefusal,
  paneStayCloudTargetLock, paneStaySaveLoaders, registerPaneRun, type PaneStay, type PaneStayResult } from './pane-stay-save.js';
import { staffQuoteSourceHash } from './staff-quote-workflow.js';
import { reservationWorkflowV2DraftSchema, type ReservationWorkflowV2Observation } from './reservation-workflow-v2-contract.js';
import { lockReservationWorkflowV2Source, RESERVATION_WORKFLOW_V2_STATE_KEY,
  reservationWorkflowV2DraftOf, withReservationWorkflowV2Draft } from './reservation-workflow-v2-state.js';

const cloudPreviewSource = z.object({ messageId: z.string().trim().min(1).max(200),
  threadId: z.string().trim().min(1).max(200), sourceHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const cloudPreviewSelection = z.object({
  source: cloudPreviewSource,
  identity: paneCreateIdentitySchema, nativeGuestId: z.string().regex(/^\d+$/).optional(),
  expectedSeq: z.number().int().nonnegative().safe().optional(), expectedExtractionId: z.string().uuid().optional(),
}).strict().refine((selection) => (selection.expectedSeq === undefined) === (selection.expectedExtractionId === undefined),
  { message: 'Expected sequence and extraction must be supplied together.' });
type Input = { transportId: string; mailboxAddress: string; actorUserId: string; workItemId: string; stayId: string;
  sessionId?: string; sessionProfile?: 'legacy' | 'remote';
  selection: z.infer<typeof cloudPreviewSelection>; stay: PaneStay; batch?: PaneCloudBatch };
export type PaneCloudBatch =
  | { kind: 'start'; id: string; rooms: Array<{ stayId: string; selection: z.infer<typeof cloudPreviewSelection>;
      stay: PaneStay; previewDigest: string }> }
  | { kind: 'continue'; id: string; index: number };
type Native = { outcome?: unknown; issue?: unknown; guestCandidates?: unknown; applied?: { guaranteeType?: unknown };
  ratePlanAvailability?: unknown; ratePlanIssue?: { issue?: unknown };
  requestBinding?: { request?: unknown; digest?: unknown }; screenshots?: Record<string, unknown>;
  writerSessionClosed?: unknown; save?: { dispatchCallbacksDrained?: unknown };
  confirmation?: unknown; nativeStayId?: unknown; readback?: { fields?: unknown; mismatches?: unknown } };
type NativeContinuation = (() => Promise<unknown>) & { proveNeverDispatched?: () => unknown };
type NativeOptions = { capturePrepareScreenshot?: boolean; requireExplicitGuestSelection?: boolean; expectedRequestDigest?: string;
  allowRealGuest?: boolean; expectedGuest?: { firstName: string; lastName: string }; cloudTargetKey?: string;
  signal?: AbortSignal; transportId?: string; credentialLease?: CloudCredentialLease;
  authorizeCandidate?: (request: unknown) => Promise<boolean>;
  dispatchCandidate?: (request: unknown, next: NativeContinuation, evidence: unknown) => Promise<unknown>;
  verifyLabtestMatches?: (census: unknown) => Promise<boolean> };
export const paneCloudPreviewLoaders: {
  runtimeReady: () => boolean;
  authorityReady: () => boolean;
  run: (input: Record<string, unknown>, options: NativeOptions) => Promise<Native>;
  verifySiblings: (census: unknown, siblings: BatchSibling[], propertyCode: string) => Promise<boolean>;
} = {
  // Enable only after all competing HRCEN writers are held or use the shared
  // durable claim. Preview remains available while this cutover flag is off.
  authorityReady: () => process.env.PANE_CLOUD_CREATE_DISPATCH === 'on',
  runtimeReady: () => {
    try {
      const require = createRequire(new URL('../../tooling/stagehand/package.json', import.meta.url));
      return (require('playwright/package.json') as { version?: unknown }).version === '1.63.0';
    } catch { return false; }
  },
  run: async (input, options) => {
    const tool = await import(new URL('../../tooling/hms-cloud/create-reservation.mjs', import.meta.url).href) as {
      createReservation: (input: Record<string, unknown>, options: unknown) => Promise<Native>;
    };
    return tool.createReservation(input, options);
  },
  verifySiblings: async (census, siblings, propertyCode) => {
    const tool = await import(new URL('../../tooling/hms-cloud/batch-sibling-readback.mjs', import.meta.url).href) as {
      censusMatchesApprovedSiblings: (census: unknown, siblings: BatchSibling[], options: { propertyCode: string }) => boolean;
    };
    return tool.censusMatchesApprovedSiblings(census, siblings, { propertyCode });
  },
};
const refused = (reason: string): PaneStayResult => ({ status: 'refused', reason });

const cursorSchema = z.object({ extractionId: z.string().uuid(), revision: z.number().int().nonnegative(),
  revisionHead: z.number().int().nonnegative(), seq: z.number().int().nonnegative() }).strict();
type Cursor = z.infer<typeof cursorSchema>;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const hmsPriceSchema = z.object({ averageRate: z.string().trim().min(1).max(64), totalRate: z.string().trim().min(1).max(64),
  currency: z.string().trim().min(1).max(16).nullable() });
function savedHmsPrice(fields: unknown): z.infer<typeof hmsPriceSchema> | undefined {
  if (!Array.isArray(fields)) return undefined;
  const field = (name: string) => {
    const matches = fields.filter((item) => item && typeof item === 'object' && item.name === name);
    const value: unknown = matches.length === 1 ? matches[0].value : undefined;
    return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
  };
  const averageRate = field('averagerate'), totalRate = field('totalrate');
  const currencies = [field('averageratecurr'), field('totalratecurr'), field('currency')].filter(Boolean)
    .map((value) => value.toUpperCase() === 'R' ? 'ZAR' : value.toUpperCase());
  if (!currencies.length && [averageRate, totalRate].every((value) => /^(?:R|ZAR)\s*\d/i.test(value) || /\bZAR$/i.test(value))) {
    currencies.push('ZAR');
  }
  const currency = currencies.length && currencies.every((value) => value === currencies[0]) ? currencies[0] : null;
  const parsed = hmsPriceSchema.safeParse({ averageRate, totalRate, currency });
  return parsed.success ? parsed.data : undefined;
}
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const day = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(day.valueOf()) && day.toISOString().slice(0, 10) === value;
});
const grantSchema = z.object({ version: z.literal('pane-cloud-preview/v1'), grantId: z.string().uuid(),
  digest, actorUserId: z.string().min(1), sessionId: z.string().min(1), sessionProfile: z.enum(['legacy', 'remote']),
  accessId: z.string().min(1), source: cloudPreviewSource,
  identity: paneCreateIdentitySchema, nativeGuestId: z.string().regex(/^\d+$/), cursor: cursorSchema,
  sourceDigest: digest, stateDigest: digest, requestDigest: digest, stayDigest: digest,
  selection: cloudPreviewSelection.optional(), stay: z.record(z.string(), z.unknown()).optional(),
  capturedAt: z.string().datetime({ offset: true }).optional(), price: hmsPriceSchema.optional(),
  approvedRequest: z.record(z.string(), z.unknown()),
  previewShot: z.object({ runId: z.string().uuid(), sha256: digest }).strict(), expiresAt: z.number().finite() }).strict();
type Grant = z.infer<typeof grantSchema>;
const PREVIEWS = 'cloudCreatePreviews';
const BATCH = 'cloudCreateBatch';
const PAST_BATCHES = 'cloudCreatePastBatches';
const BATCH_HOLDS = 'cloudCreateBatchHolds';
const hash = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const batchSchema = z.object({ version: z.literal('pane-cloud-batch/v1'), id: z.string().uuid(), goGrantId: z.string().uuid().optional(),
  rooms: z.array(z.object({ stayId: z.string().regex(/^[A-Za-z0-9_-]{1,120}$/), grant: grantSchema }).strict()).min(2).max(8),
  digest }).strict();
type StoredBatch = z.infer<typeof batchSchema>;
const batchRoomOperationId = (batch: StoredBatch, room: StoredBatch['rooms'][number]) =>
  batch.goGrantId ? hmsAllocationOperationId(batch.goGrantId, room.stayId) : room.grant.grantId;
type BatchSibling = { confirmation: string; nativeStayId: string; approvedRequest: Record<string, unknown>; requestDigest: string;
  ratePlanAvailability: { averageRate: string; totalRate: string; currency: string } };
type CreateWorkerContext = { go: VerifiedStaffGo; fence: AiRunFence; signal: AbortSignal;
  heldTargetLock: HeldTargetAliasLock; credentialLease: CloudCredentialLease; siblings: BatchSibling[] };

function createTarget(stay: PaneStay): HmsDispatchTarget | null {
  const parsed = hmsDispatchTargetSchema.safeParse({ propertyCode: stay.propertyCode, kind: 'create',
    firstName: stay.firstName, lastName: stay.lastName, arrival: stay.arrival });
  return parsed.success && parsed.data.kind === 'create' ? parsed.data : null;
}

function createMode(stay: PaneStay) {
  const code = propertyCodeSchema.safeParse(stay.propertyCode);
  if (!code.success) return 'off' as const;
  return paneStaySaveLoaders.mode?.() ?? effectiveWorkflowPolicy(process.env, code.data, 'create').admittedMode;
}
function createAuthorityReady(stay: PaneStay) {
  return stay.propertyCode === 'HRCEN' ? paneCloudPreviewLoaders.authorityReady() : createMode(stay) !== 'off';
}

// The Centurion alias can report on; real guests require its dedicated flag.
function createAdmission(mode: 'off' | 'lab' | 'on', stay: PaneStay, preview = false) {
  const allowRealGuest = !isLabtestGuest(stay) && (preview ? mode !== 'off' : mode === 'on' && (stay.propertyCode !== 'HRCEN' || process.env.PANE_WRITE_CREATE === 'on'));
  if (!isLabtestGuest(stay) && !allowRealGuest) return { reason: 'cloud_preview_labtest_only', allowRealGuest: false };
  const reason = paneStayModeRefusal(preview && (allowRealGuest || mode === 'off') ? 'on' : mode, stay);
  if (reason) return { reason, allowRealGuest };
  if (!validCreateDates(stay.arrival, stay.departure, allowRealGuest)) {
    return { reason: allowRealGuest ? 'current_or_future_arrival_required' : 'pane_save_arrival_2027_required', allowRealGuest };
  }
  return { reason: null, allowRealGuest };
}

async function currentCursor(db: DB, input: Input): Promise<Cursor> {
  const [item] = await db.select({ extractionId: workItem.extractionId, revision: workItem.revision,
    revisionHead: workItem.revisionHead, seq: workItem.revisionSeq }).from(workItem)
    .where(and(eq(workItem.id, input.workItemId), eq(workItem.transportId, input.transportId))).limit(1);
  const parsed = cursorSchema.safeParse(item);
  if (!parsed.success) throw new Error('create_source_stale');
  return parsed.data;
}

function sourceKey(input: Input, cursor: Cursor) {
  return { transportId: input.transportId, workItemId: input.workItemId, threadId: input.selection.source.threadId,
    messageId: input.selection.source.messageId, cursor };
}

/** The source guards checkSource can throw; every caller maps them to the same clear scope refusal, never raw. */
const CLOUD_CREATE_SOURCE_GUARD = /^cloud_create_(source_changed|property_mismatch|existing_booking|scope_changed|source_blocked)$/;

/** Recheck the exact source, extraction, mailbox and staff access while their rows are locked. */
async function checkSource(tx: CreateFenceTransaction, source: LockedCreateSource, input: Input, accessId?: string) {
  await assertNoCreateDispatchFence(tx, { transportId: input.transportId, workItemId: input.workItemId });
  const actor = await lockCreateActorAccess(tx, { transportId: input.transportId, actorUserId: input.actorUserId, accessId });
  const mail = source.snapshot.source;
  if (mail.historyOnly || mail.sourceProvenance?.attention != null || staffQuoteSourceHash(mail) !== input.selection.source.sourceHash ||
      actor.mailboxAddress !== input.mailboxAddress) throw new Error('cloud_create_source_changed');
  const thread = await tx.select({ id: message.id, direction: message.direction, fromAddress: message.fromAddress,
    ownerHeaderValue: message.ownerHeaderValue, toAddresses: message.toAddresses, ccAddresses: message.ccAddresses })
    .from(message).where(and(eq(message.transportId, input.transportId), eq(message.threadId, input.selection.source.threadId)))
    .orderBy(message.id).limit(513).for('share');
  const selected = thread.find((row) => row.id === mail.id);
  if (thread.length > 512 || !selected || !bindHmsMailboxProperty({ transportId: input.transportId,
    propertyCode: input.stay.propertyCode, origin: selected }).ok ||
      (input.stay.propertyCode === 'HRCEN' &&
        thread.some((row) => (row.id === mail.id || row.direction === 'inbound') && isDaVinciMailboxOrigin(row)))) {
    throw new Error('cloud_create_property_mismatch');
  }
  const payload = source.effectivePayload;
  if (!activePaneCreateIdentity(payload, source.item.state, input.selection.identity,
    { legacyKey: input.stayId === legacyPaneCreateRoomId(input.selection.identity) })) throw new Error('cloud_create_scope_changed');
  if (input.selection.expectedSeq !== undefined &&
      !currentPaneCreateDatesMatch(payload, source.item.state, input.selection.identity, input.stay, input.selection.source)) {
    throw new Error('cloud_create_scope_changed');
  }
  const sourceBodyText = canonicalSourceBodyText({ textBody: mail.textBody, htmlBody: mail.htmlBody });
  const confirmations = payload && Array.isArray(payload.confirmationNumbers)
    ? payload.confirmationNumbers.filter((value): value is string => typeof value === 'string') : [];
  if (!actor.mailboxAddress || selfSentPreStayCandidate({ fromAddress: mail.fromAddress, mailboxAddress: actor.mailboxAddress,
    subject: mail.subject, confirmationNumbers: confirmations, bodyText: sourceBodyText })) {
    throw new Error('cloud_create_existing_booking');
  }
  // The pane hides channel and automated sources, but an older Create request
  // can still reach this seam; reclassify the locked source with the same shared
  // rules. Only a persisted non-inline file proves attachment presence; unproven
  // enumeration stays unknown and keeps the mail reviewable rather than skipped.
  const [fileAttachment] = await tx.select({ id: attachment.id }).from(attachment)
    .where(and(eq(attachment.messageId, mail.id), eq(attachment.isInline, false))).limit(1);
  if (classifyMailSource({ fromAddress: mail.fromAddress, subject: mail.subject,
    bodyText: sourceBodyText,
    hasAttachments: fileAttachmentPresence(fileAttachment != null, mail.sourceProvenance) }).kind !== 'direct') {
    throw new Error('cloud_create_source_blocked');
  }
  // Staff may edit the booking. The grant binds their reviewed form and selected
  // room identity; the native request fence checks the same values before Save.
  const state = { ...source.item.state };
  for (const key of [PREVIEWS, BATCH, PAST_BATCHES, BATCH_HOLDS, 'stayPreviews', 'stays']) delete state[key];
  if (state.propertyCode !== undefined && state.propertyCode !== input.stay.propertyCode) throw new Error('cloud_create_property_mismatch');
  state.propertyCode = input.stay.propertyCode;
  return { sourceDigest: source.sourceDigest, stateDigest: createHash('sha256').update(canonicalJson(state)).digest('hex'),
    accessId: actor.accessId };
}

function grantOf(state: Record<string, unknown>, stayId: string): Grant | null {
  const previews = state[PREVIEWS];
  if (!previews || typeof previews !== 'object' || Array.isArray(previews)) return null;
  const parsed = grantSchema.safeParse((previews as Record<string, unknown>)[stayId]);
  return parsed.success ? parsed.data : null;
}
function sameGrant(grant: Grant, input: Input, previewDigest: string): boolean {
  const { digest: grantDigest, ...draft } = grant;
  return grantDigest === previewDigest && hash(draft) === grantDigest && grant.actorUserId === input.actorUserId && grant.expiresAt > Date.now() &&
    grant.sessionId === input.sessionId && grant.sessionProfile === input.sessionProfile &&
    grant.stayDigest === paneStayDigest(input.stay) && grant.nativeGuestId === input.selection.nativeGuestId &&
    !!grant.selection && !!grant.stay && canonicalJson(grant.selection) === canonicalJson(input.selection) &&
    canonicalJson(grant.stay) === canonicalJson(input.stay) &&
    canonicalJson(grant.source) === canonicalJson(input.selection.source) &&
    canonicalJson(grant.identity) === canonicalJson(input.selection.identity);
}
function matchesSource(current: { sourceDigest: string; stateDigest: string; accessId: string }, expected: {
  sourceDigest: string; stateDigest: string; accessId: string;
}): boolean {
  return current.sourceDigest === expected.sourceDigest && current.stateDigest === expected.stateDigest && current.accessId === expected.accessId;
}
function preparedStay(state: Record<string, unknown>, stayId: string, raw: Record<string, unknown>): boolean {
  const grant = grantOf(state, stayId);
  return raw.status === undefined && !!grant && canonicalJson(raw) === canonicalJson(grant.stay) &&
    raw.propertyCode === grant.approvedRequest.propertyCode;
}
function staysClear(state: Record<string, unknown>, target?: HmsDispatchTarget): boolean {
  const stays = state.stays;
  if (stays === undefined) return true;
  if (!stays || typeof stays !== 'object' || Array.isArray(stays)) return false;
  return Object.entries(stays).every(([stayId, raw]) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
    const row = raw as Record<string, unknown>;
    if (preparedStay(state, stayId, row)) return true;
    if (row.status === 'booked' && typeof row.confirmationNumber === 'string' && row.confirmationNumber.trim()) return true;
    const other = hmsDispatchTargetSchema.safeParse(row.cloudCreateTarget);
    return Boolean(target && row.status === 'unknown' && other.success && other.data.kind === 'create' &&
      hmsDispatchTargetKey(other.data) !== hmsDispatchTargetKey(target));
  });
}
const hasStay = (state: Record<string, unknown>, stayId: string) =>
  !!state.stays && typeof state.stays === 'object' && !Array.isArray(state.stays) &&
    Object.hasOwn(state.stays, stayId) && (() => {
      const raw = (state.stays as Record<string, unknown>)[stayId];
      return !raw || typeof raw !== 'object' || Array.isArray(raw) || !preparedStay(state, stayId, raw as Record<string, unknown>);
    })();
const matchesRoomId = (stayId: string, identity: PaneCreateIdentity) =>
  stayId === paneCreateRoomId(identity) || stayId === legacyPaneCreateRoomId(identity);
// A prior receipt under either key belongs to this room, or is ambiguous and must be checked in HMS.
const hasIdentityStay = (state: Record<string, unknown>, identity: PaneCreateIdentity) =>
  paneCreateRoomAliases(identity).some((id) => hasStay(state, id));
const previewShotValid = (grant: Grant, input: Input) => verifyStoredHmsShot({ ...grant.previewShot, name: 'filled.png',
  owner: `${input.actorUserId}:${input.transportId}`, propertyCode: input.stay.propertyCode!, workItemId: input.workItemId });

function storedBatch(state: Record<string, unknown>, id: string): StoredBatch | null {
  const current = state[BATCH];
  const past = state[PAST_BATCHES];
  const archived = past && typeof past === 'object' && !Array.isArray(past) ? (past as Record<string, unknown>)[id] : undefined;
  const parsed = batchSchema.safeParse((current as { id?: unknown } | undefined)?.id === id ? current : archived);
  if (!parsed.success || parsed.data.id !== id) return null;
  const { digest: actual, ...body } = parsed.data;
  return hash(body) === actual && new Set(body.rooms.map((room) => room.stayId)).size === body.rooms.length ? parsed.data : null;
}

function batchHolds(state: Record<string, unknown>): Record<string, string> | null {
  if (state[BATCH_HOLDS] === undefined) return {};
  const parsed = z.record(z.string().uuid(), z.string().uuid()).safeParse(state[BATCH_HOLDS]);
  return parsed.success ? parsed.data : null;
}

/** An unused preview captured by a stopped Go needs a new preview before a new Go. */
function grantInStoppedBatch(state: Record<string, unknown>, grantId: string): boolean {
  const holds = batchHolds(state);
  if (!holds) return true;
  for (const [id, heldGrantId] of Object.entries(holds)) {
    const batch = storedBatch(state, id);
    if (!batch || !batch.rooms.some((room) => batchRoomOperationId(batch, room) === heldGrantId) ||
        batch.rooms.some((room) => room.grant.grantId === grantId)) return true;
  }
  return false;
}

type CreateDispatchTarget = Extract<HmsDispatchTarget, { kind: 'create' }>;
export type CloudCreateHoldProjection = {
  target: CreateDispatchTarget;
  batch?: { id: string; rooms: Array<{ stayId: string; target: CreateDispatchTarget }> };
};

/** Positive Create target provenance, separate from a stopped-Go projection. */
export function cloudCreateBookedTargetOf(state: Record<string, unknown>, stayId: string): CreateDispatchTarget | null {
  const stays = state.stays;
  if (!stays || typeof stays !== 'object' || Array.isArray(stays)) return null;
  const row = (stays as Record<string, unknown>)[stayId];
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const saved = row as Record<string, unknown>, target = hmsDispatchTargetSchema.safeParse(saved.cloudCreateTarget);
  return saved.status === 'booked' && typeof saved.confirmationNumber === 'string' && saved.confirmationNumber.trim() &&
    saved.cloudCreateVerified === true && z.string().uuid().safeParse(saved.cloudCreateGrantId).success &&
    target.success && target.data.kind === 'create' ? target.data : null;
}

/** Read-only display of a stopped Create target and its sealed original Go. */
export function cloudCreateHoldOf(state: Record<string, unknown>, stayId: string): CloudCreateHoldProjection | null {
  const stays = state.stays;
  if (!stays || typeof stays !== 'object' || Array.isArray(stays)) return null;
  const raw = (stays as Record<string, unknown>)[stayId];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  const unknown = row.status === 'unknown';
  if (!unknown && (row.status !== 'booked' || typeof row.confirmationNumber !== 'string' ||
      !row.confirmationNumber.trim())) return null;
  const target = hmsDispatchTargetSchema.safeParse(row.cloudCreateTarget);
  if (unknown && (!z.string().uuid().safeParse(row.cloudCreateGrantId).success ||
      !target.success || target.data.kind !== 'create')) return null;
  const holds = batchHolds(state);
  if (!holds) return null;

  // A missing or corrupt manifest cannot be mistaken for an independently held single room.
  const current = state[BATCH], archived = state[PAST_BATCHES];
  if (archived !== undefined && (!archived || typeof archived !== 'object' || Array.isArray(archived))) return null;
  if (Object.entries((archived ?? {}) as Record<string, unknown>).some(([id, value]) =>
    !value || typeof value !== 'object' || Array.isArray(value) || (value as Record<string, unknown>).id !== id)) return null;
  const raws = [current, ...Object.values((archived ?? {}) as Record<string, unknown>)].filter((value) => value !== undefined);
  const batches: StoredBatch[] = [];
  for (const value of raws) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const id = (value as Record<string, unknown>).id;
    const batch = typeof id === 'string' ? storedBatch(state, id) : null;
    if (!batch || batches.some((other) => other.id === batch.id)) return null;
    batches.push(batch);
  }
  if (!unknown && row.cloudCreateRecovered === true && row.cloudCreateRecoveredBatchId === null &&
      z.string().uuid().safeParse(row.cloudCreateGrantId).success && target.success && target.data.kind === 'create' &&
      !Object.values(holds).includes(row.cloudCreateGrantId as string) &&
      !batches.some((batch) => batch.rooms.some((room) => batchRoomOperationId(batch, room) === row.cloudCreateGrantId))) {
    return { target: target.data };
  }
  // Recovery intentionally keeps the batch hold, but older recovered rows did
  // not retain their original target/grant. Reconstruct that binding only
  // from the held grant in the sealed manifest for this exact stay.
  const recovered = unknown ? [] : batches.flatMap((batch) => batch.rooms.filter((room) =>
    room.stayId === stayId && batchRoomOperationId(batch, room) === holds[batch.id]).map((room) => ({ batch, room })));
  if (!unknown && recovered.length !== 1) return null;
  const grantId = unknown ? row.cloudCreateGrantId : batchRoomOperationId(recovered[0]!.batch, recovered[0]!.room);
  if (!unknown && row.cloudCreateGrantId !== undefined && row.cloudCreateGrantId !== grantId) return null;
  const heldIds = Object.entries(holds).filter(([, value]) => value === grantId).map(([id]) => id);
  if (heldIds.length > 1) return null;
  const related = batches.filter((batch) => batch.rooms.some((room) => batchRoomOperationId(batch, room) === grantId));
  if (heldIds.length === 0) return unknown && target.success && target.data.kind === 'create' && related.length === 0
    ? { target: target.data } : null;
  if (related.length !== 1 || related[0]?.id !== heldIds[0]) return null;
  const batch = related[0]!;
  const rooms: NonNullable<CloudCreateHoldProjection['batch']>['rooms'] = [];
  const grantIds = new Set<string>();
  for (const room of batch.rooms) {
    const { digest: grantDigest, ...grantBody } = room.grant;
    const request = z.object({ propertyCode: z.string(),
      guest: z.object({ nativeId: z.string().regex(/^\d+$/), firstName: z.string(), lastName: z.string() }).passthrough(),
      stay: z.object({ arrival: z.string() }).passthrough() }).passthrough().safeParse(room.grant.approvedRequest);
    if (grantIds.has(room.grant.grantId) || hash(grantBody) !== grantDigest ||
        hash(room.grant.approvedRequest) !== room.grant.requestDigest ||
        !matchesRoomId(room.stayId, room.grant.identity) ||
        !request.success || request.data.guest.nativeId !== room.grant.nativeGuestId) return null;
    grantIds.add(room.grant.grantId);
    const memberTarget = hmsDispatchTargetSchema.safeParse({ propertyCode: request.data.propertyCode, kind: 'create',
      firstName: request.data.guest.firstName, lastName: request.data.guest.lastName, arrival: request.data.stay.arrival });
    if (!memberTarget.success || memberTarget.data.kind !== 'create') return null;
    rooms.push({ stayId: room.stayId, target: memberTarget.data });
  }
  const held = batch.rooms.find((room) => room.stayId === stayId && batchRoomOperationId(batch, room) === grantId);
  const heldTarget = rooms.find((room) => room.stayId === stayId)?.target;
  if (!held || !heldTarget || ((unknown || row.cloudCreateTarget !== undefined) &&
      (!target.success || target.data.kind !== 'create' || hmsDispatchTargetKey(heldTarget) !== hmsDispatchTargetKey(target.data)))) return null;
  return { target: heldTarget, batch: { id: batch.id, rooms } };
}

/** Check whether every room in the current batch has durable positive evidence. */
async function previousBatchComplete(tx: CreateFenceTransaction, state: Record<string, unknown>, input: Input): Promise<boolean> {
  const raw = state[BATCH];
  if (raw === undefined) return true;
  const id = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>).id : null;
  const batch = typeof id === 'string' ? storedBatch(state, id) : null;
  const stays = state.stays && typeof state.stays === 'object' && !Array.isArray(state.stays)
    ? state.stays as Record<string, unknown> : null;
  if (!batch || !stays) return false;
  const completed = await readResolvedHmsLabtestCreates(tx, input.workItemId);
  const confirmations = new Set<string>();
  for (const room of batch.rooms) {
    const prior = stays[room.stayId];
    if (!prior || typeof prior !== 'object' || Array.isArray(prior)) return false;
    const row = prior as Record<string, unknown>, confirmation = row.confirmationNumber;
    if (row.status !== 'booked' || typeof confirmation !== 'string' || !confirmation.trim() || confirmations.has(confirmation)) return false;
    const evidence = completed.filter(({ intent, resolution }) =>
      intent.transportId === input.transportId && intent.actorUserId === room.grant.actorUserId &&
      intent.grantId === batchRoomOperationId(batch, room) && intent.stayId === room.stayId &&
      intent.approvedDigest === room.grant.requestDigest && intent.sourceDigest === room.grant.sourceDigest &&
      intent.nativeGuestId === room.grant.nativeGuestId && resolution.confirmation === confirmation);
    if (evidence.length !== 1) return false;
    confirmations.add(confirmation);
  }
  return true;
}

/** The first Save transaction captures every previewed room under the single Go. */
async function prepareBatch(tx: CreateFenceTransaction, source: LockedCreateSource, input: Input, grant: Grant,
  previewDigest: string, goGrantId?: string): Promise<{ batch: StoredBatch; pastBatches?: Record<string, unknown> } | null> {
  const batch = input.batch;
  if (!batch || batch.kind !== 'start') return null;
  if (!z.string().uuid().safeParse(batch.id).success || batch.rooms.length < 2 || batch.rooms.length > 8 ||
      new Set(batch.rooms.map((room) => room.stayId)).size !== batch.rooms.length ||
      batch.rooms[0]?.stayId !== input.stayId || batch.rooms[0]?.previewDigest !== previewDigest) {
    throw new Error('cloud_batch_stale');
  }
  let pastBatches: Record<string, unknown> | undefined;
  const raw = source.item.state[BATCH];
  const id = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>).id : null;
  const holds = batchHolds(source.item.state);
  // Positive recovery can complete every room without releasing the original
  // batch hold. Its sealed manifest must survive the next unrelated Go.
  if (!await previousBatchComplete(tx, source.item.state, input) ||
      (typeof id === 'string' && holds && Object.hasOwn(holds, id))) {
    const previous = typeof id === 'string' ? storedBatch(source.item.state, id) : null;
    const archived = source.item.state[PAST_BATCHES];
    if (!previous || (archived !== undefined && (!archived || typeof archived !== 'object' || Array.isArray(archived))) ||
        (archived && Object.hasOwn(archived, previous.id)) || !holds ||
        !previous.rooms.some((room) => batchRoomOperationId(previous, room) === holds[previous.id])) throw new Error('cloud_batch_stale');
    // Preserve the prior manifest and its in-flight hold while a separate batch runs.
    pastBatches = { ...(archived as Record<string, unknown> | undefined), [previous.id]: previous };
  }
  const rooms: StoredBatch['rooms'] = [];
  for (const room of batch.rooms) {
    const roomInput: Input = { ...input, stayId: room.stayId, stay: room.stay, selection: room.selection, batch: undefined };
    const candidate = grantOf(source.item.state, room.stayId);
    const current = await checkSource(tx, source, roomInput, grant.accessId);
    const roomTarget = createTarget(room.stay);
    if (!candidate || grantInStoppedBatch(source.item.state, candidate.grantId) ||
        !matchesRoomId(room.stayId, room.selection.identity) ||
        !sameGrant(candidate, roomInput, room.previewDigest) || !matchesSource(current, candidate) ||
        canonicalJson(candidate.source) !== canonicalJson(grant.source) ||
        canonicalJson(candidate.cursor) !== canonicalJson(grant.cursor) ||
        !roomTarget || !staysClear(source.item.state, roomTarget) || hasIdentityStay(source.item.state, room.selection.identity) ||
        createAdmission(createMode(room.stay), room.stay).reason ||
        !await previewShotValid(candidate, roomInput)) throw new Error('cloud_batch_stale');
    rooms.push({ stayId: room.stayId, grant: candidate });
  }
  const body = { version: 'pane-cloud-batch/v1' as const, id: batch.id, ...(goGrantId ? { goGrantId } : {}), rooms };
  return { batch: batchSchema.parse({ ...body, digest: hash(body) }), ...(pastBatches ? { pastBatches } : {}) };
}

/** Earlier confirmations come from this item's server-written evidence, never client JSON. */
async function checkedSiblings(tx: CreateFenceTransaction, state: Record<string, unknown>, input: Input,
  grant: Grant, previewDigest: string): Promise<BatchSibling[]> {
  if (!input.batch || input.batch.kind !== 'continue') throw new Error('cloud_batch_stale');
  const batch = storedBatch(state, input.batch.id), index = input.batch.index;
  const holds = batchHolds(state);
  const stays = state.stays as Record<string, unknown> | undefined;
  if (!batch || !Number.isInteger(index) || index < 1 || index >= batch.rooms.length ||
      batch.rooms[index]?.stayId !== input.stayId || batch.rooms[index]?.grant.digest !== previewDigest ||
      canonicalJson(batch.rooms[index]?.grant) !== canonicalJson(grant) || !holds || Object.hasOwn(holds, batch.id) ||
      batch.rooms.some((room) => (stays?.[room.stayId] as Record<string, unknown> | undefined)?.status === 'unknown')) {
    throw new Error('cloud_batch_stale');
  }
  const completed = await readResolvedHmsLabtestCreates(tx, input.workItemId);
  const siblings: BatchSibling[] = [];
  for (const room of batch.rooms.slice(0, index)) {
    const previous = stays?.[room.stayId] as Record<string, unknown> | undefined;
    const confirmation = previous?.confirmationNumber;
    const evidence = completed.filter(({ intent, resolution }) =>
      intent.transportId === input.transportId && intent.actorUserId === input.actorUserId &&
      intent.grantId === batchRoomOperationId(batch, room) && intent.stayId === room.stayId &&
      intent.approvedDigest === room.grant.requestDigest && intent.sourceDigest === room.grant.sourceDigest &&
      intent.nativeGuestId === room.grant.nativeGuestId && resolution.confirmation === confirmation);
    if (previous?.status !== 'booked' || typeof confirmation !== 'string' || !confirmation.trim() || !room.grant.price?.currency ||
        typeof previous.nativeStayId !== 'string' || !/^\d{1,100}$/.test(previous.nativeStayId) ||
        evidence.length !== 1 || evidence[0]?.resolution.recovered === true) {
      throw new Error('cloud_batch_stale');
    }
    siblings.push({ confirmation, nativeStayId: previous.nativeStayId, approvedRequest: room.grant.approvedRequest,
      requestDigest: room.grant.requestDigest, ratePlanAvailability: { ...room.grant.price, currency: room.grant.price.currency } });
  }
  if (new Set(siblings.map((item) => item.confirmation)).size !== siblings.length) throw new Error('cloud_batch_stale');
  return siblings;
}

async function saveScreenshots(native: Native, input: Input, beforeSha256: string) {
  const before = native.screenshots?.before;
  if (typeof before !== 'string') return null;
  const dir = dirname(before), match = /^hms-cloud-create-([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/.exec(basename(dir));
  if (!match || before !== join('/tmp', basename(dir), 'before.png') || native.screenshots?.after !== join(dir, 'after.png')) return null;
  const runId = match[1]!, owner = `${input.actorUserId}:${input.transportId}`;
  await copyFile(join(dir, 'after.png'), join(dir, 'saved.png'));
  registerPaneRun({ runId, dir, owner, now: Date.now() });
  const shots = await persistHmsShots({ propertyCode: input.stay.propertyCode!, workItemId: input.workItemId, runId, sourceDir: dir, owner, now: Date.now() }).catch(() => null);
  const saved = shots?.find((shot) => shot.name === 'saved.png');
  if (!shots || !shots.some((shot) => shot.name === 'before.png' && shot.sha256 === beforeSha256) ||
      !saved || !await verifyStoredHmsShot({ runId, name: 'saved.png', sha256: saved.sha256, owner,
        propertyCode: input.stay.propertyCode!, workItemId: input.workItemId }, 'saved.png')) return null;
  return { runId, screenshots: ['before.png', 'saved.png'], shots };
}

/** Persist the last clean preimage and before image before creating an UNKNOWN intent. */
async function createRecoveryEvidence(value: unknown, input: Input, siblings: BatchSibling[]) {
  const parsed = z.object({ beforeScreenshot: z.string(), preimage: z.object({ outcome: z.literal('clear'),
    firstName: z.string().min(1), lastName: z.string().min(1), arrival: isoDate, departure: isoDate,
    searchedDateRange: z.object({ from: isoDate, to: isoDate }),
    expiresAt: z.string().datetime(),
    coverage: z.object({ displayed: z.number().int().nonnegative().safe(), total: z.number().int().nonnegative().safe(),
      complete: z.literal(true) }),
    sameArrival: z.array(z.object({ confirmation: z.string().regex(/^\d{6,10}-\d{1,2}$/), firstName: z.string().min(1), lastName: z.string().min(1),
      arrival: isoDate, departure: isoDate, status: z.string().refine(value => value === 'Reserved' || isCancelledStatus(value)) }).passthrough()),
    verifiedExisting: z.literal(true).optional(),
  }).passthrough(), writer: z.unknown().optional(), guaranteeDisplay: z.string().min(1).max(200) }).strict().safeParse(value);
  const matchingSiblings = siblings.filter((sibling) => {
    const request = sibling.approvedRequest as { guest?: unknown; stay?: { arrival?: unknown } };
    return sameCreateGuest(request.guest, input.stay) && request.stay?.arrival === input.stay.arrival;
  });
  const guarantee = createGuaranteeCode(input.stay.guaranteeType);
  const blockingMatches = parsed.success ? blockingCreateMatches(parsed.data.preimage.sameArrival) : [];
  if (!parsed.success || parsed.data.preimage.firstName !== input.stay.firstName ||
      parsed.data.preimage.lastName !== input.stay.lastName || parsed.data.preimage.arrival !== input.stay.arrival ||
      parsed.data.preimage.departure !== input.stay.departure || input.stay.arrival >= input.stay.departure ||
      parsed.data.preimage.searchedDateRange.from > input.stay.arrival ||
      parsed.data.preimage.searchedDateRange.to < input.stay.arrival ||
      Date.parse(parsed.data.preimage.expiresAt) <= Date.now() ||
      parsed.data.preimage.coverage.displayed !== parsed.data.preimage.coverage.total ||
      parsed.data.preimage.coverage.displayed < parsed.data.preimage.sameArrival.length ||
      !guarantee || (input.stay.propertyCode === 'HRCEN' && parsed.data.guaranteeDisplay !== CREATE_GUARANTEES[guarantee]) ||
      (input.stay.propertyCode !== 'HRCEN' && input.stay.guaranteeType !== guarantee && parsed.data.guaranteeDisplay !== input.stay.guaranteeType) ||
      !cloudWriterCurrent(parsed.data.writer) ||
      blockingMatches.length !== matchingSiblings.length ||
      (siblings.length > 0 && parsed.data.preimage.verifiedExisting !== true) ||
      new Set(parsed.data.preimage.sameArrival.map((row) => row.confirmation)).size !== parsed.data.preimage.sameArrival.length ||
      parsed.data.preimage.sameArrival.some((row) => !sameCreateGuest(row, input.stay) || row.arrival !== input.stay.arrival) ||
      blockingMatches.some((row) => !matchingSiblings.some((sibling) => sibling.confirmation === row.confirmation))) {
    throw new Error('cloud_create_preimage_unavailable');
  }
  const before = parsed.data.beforeScreenshot, dir = dirname(before);
  const match = /^hms-cloud-create-([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/.exec(basename(dir));
  if (!match || before !== join('/tmp', basename(dir), 'before.png')) throw new Error('cloud_create_before_unavailable');
  const runId = match[1]!, owner = `${input.actorUserId}:${input.transportId}`;
  const shots = await persistHmsShots({ propertyCode: input.stay.propertyCode!, workItemId: input.workItemId, runId, sourceDir: dir, owner, now: Date.now() });
  const shot = shots?.find((item) => item.name === 'before.png');
  if (!shot || !await verifyStoredHmsShot({ runId, name: 'before.png', sha256: shot.sha256, owner,
    propertyCode: input.stay.propertyCode!, workItemId: input.workItemId }, 'before.png')) throw new Error('cloud_create_before_unavailable');
  const { firstName, lastName, arrival, departure, searchedDateRange, coverage, expiresAt, sameArrival } = parsed.data.preimage;
  return { beforeShot: { runId, sha256: shot.sha256 },
    preimage: { firstName, lastName, arrival, departure, searchedDateRange, coverage, expiresAt, sameArrival },
    batchManifest: siblings, guaranteeDisplay: parsed.data.guaranteeDisplay, writer: parsed.data.writer };
}

/** Preview the exact request; a one-use Go grant is issued only when saving is enabled. */
export async function previewPaneCloud(db: DB, input: Input): Promise<PaneStayResult & { guestCandidates?: unknown[] }> {
  if (!cloudPreviewSelection.safeParse(input.selection).success ||
      !matchesRoomId(input.stayId, input.selection.identity)) return refused('pane_preview_binding_required');
  const target = paneStayCreateTarget({ transportId: input.transportId, propertyCode: input.stay.propertyCode });
  if (!target.ok) return refused('pane_save_property_mismatch');
  input = { ...input, stay: { ...input.stay, propertyCode: target.target.propertyCode } };
  const dispatchTarget = createTarget(input.stay);
  if (!dispatchTarget) return refused('guest_name_required');
  const initialMode = createMode(input.stay);
  const admission = createAdmission(initialMode, input.stay, true);
  if (admission.reason) return refused(admission.reason);
  if (!paneCloudPreviewLoaders.runtimeReady()) return refused('cloud_create_runtime_unavailable');
  const mapped = mapPaneStayToCloudCreateInput(input.stay, 'prepare', input.selection.nativeGuestId,
    { allowRealGuest: admission.allowRealGuest });
  if (mapped.outcome !== 'ok') return refused(mapped.reason);
  try {
    const scope = resolvePropertyScope({ transportId: input.transportId,
      ...(target.target.propertyCode === 'HRCEN' ? {} : { propertySwitch: target.target.propertyCode as PropertySwitch }) });
    const policyIssue = cloudCreatePolicyIssue((await propertyConfigurationForScope(scope)).formPolicy, mapped.input);
    if (policyIssue) return refused(policyIssue);
    const cursor = await currentCursor(db, input);
    if (input.selection.expectedSeq !== undefined &&
        (input.selection.expectedSeq !== cursor.seq || input.selection.expectedExtractionId !== cursor.extractionId)) {
      return refused('cloud_create_scope_changed');
    }
    const key = sourceKey(input, cursor);
    const before = await withLockedCreateSource(db, key, (tx, source) => checkSource(tx, source, input));
    const sourceUnchanged = async () => {
      const after = await withLockedCreateSource(db, key, (tx, source) => checkSource(tx, source, input, before.accessId));
      return matchesSource(after, before);
    };
    const native = await paneCloudPreviewLoaders.run(mapped.input, { transportId: input.transportId, capturePrepareScreenshot: Boolean(input.selection.nativeGuestId),
      requireExplicitGuestSelection: !input.selection.nativeGuestId, allowRealGuest: admission.allowRealGuest,
      expectedGuest: { firstName: input.stay.firstName, lastName: input.stay.lastName },
      cloudTargetKey: hmsDispatchTargetKey(dispatchTarget) });
    if (!input.selection.nativeGuestId && ['guest_ambiguous', 'guest_choice_required', 'guest_not_found'].includes(String(native.issue)) && Array.isArray(native.guestCandidates)) {
      if (!await sourceUnchanged()) return refused('cloud_create_scope_changed');
      const candidates = native.guestCandidates.flatMap((value) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
        const row = value as Record<string, unknown>;
        if (typeof row.nativeId !== 'string' || !/^\d+$/.test(row.nativeId) ||
            typeof row.firstName !== 'string' || typeof row.lastName !== 'string' ||
            row.firstName.trim().toLowerCase() !== input.stay.firstName.trim().toLowerCase() ||
            row.lastName.trim().toLowerCase() !== input.stay.lastName.trim().toLowerCase()) return [];
        return [{ nativeId: row.nativeId, firstName: row.firstName, lastName: row.lastName,
          ...(typeof row.city === 'string' && row.city ? { city: row.city } : {}),
          ...(typeof row.country === 'string' && row.country ? { country: row.country } : {}) }];
      }).slice(0, 50);
      return { ...refused(native.issue === 'guest_not_found' ? 'guest_not_found' : 'guest_choice_required'), guestCandidates: candidates };
    }
    if (!input.selection.nativeGuestId) return refused('prepared_guest_identity_required');
    if (native.ratePlanIssue?.issue === 'RATE_PRICE_UNCONFIRMED') {
      if (!await sourceUnchanged()) return refused('cloud_create_scope_changed');
      return refused('cloud_price_unavailable');
    }
    if (native.outcome !== 'prepared' || !native.requestBinding) return refused('cloud_preview_unavailable');
    const price = hmsPriceSchema.safeParse(native.ratePlanAvailability);
    if (!price.success) return refused('cloud_price_unavailable');
    const proof = digestPaneCloudCreateProof(input.stay, native.requestBinding.request, native.applied?.guaranteeType,
      input.selection.nativeGuestId, true, admission.allowRealGuest);
    if (proof.outcome !== 'ok' || native.requestBinding.digest !== proof.normalizedRequestDigest) return refused('cloud_create_proof_mismatch');
    const shot = native.screenshots?.filled;
    if (typeof shot !== 'string') return refused('cloud_preview_unavailable');
    const dir = dirname(shot), match = /^hms-cloud-create-([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/.exec(basename(dir));
    if (!match || shot !== join('/tmp', basename(dir), 'filled.png')) return refused('cloud_preview_unavailable');
    const owner = `${input.actorUserId}:${input.transportId}`, runId = match[1]!;
    registerPaneRun({ runId, dir, owner, now: Date.now() });
    const shots = await persistHmsShots({ propertyCode: target.target.propertyCode, workItemId: input.workItemId, runId, sourceDir: dir, owner, now: Date.now() });
    const filled = shots?.find((item) => item.name === 'filled.png');
    if (!filled || !await verifyStoredHmsShot({ runId, name: filled.name, sha256: filled.sha256,
      owner, propertyCode: target.target.propertyCode, workItemId: input.workItemId })) return refused('cloud_preview_unavailable');
    return await withLockedCreateSource(db, key, async (tx, source) => {
      const after = await checkSource(tx, source, input, before.accessId);
      if (!matchesSource(after, before)) return refused('cloud_create_scope_changed');
      if (!staysClear(source.item.state, dispatchTarget)) return refused('cloud_create_recovery_required');
      if (hasIdentityStay(source.item.state, input.selection.identity)) return refused('pane_stay_already_booked');
      const currentMode = createMode(input.stay);
      const currentAdmission = createAdmission(currentMode, input.stay, true);
      if (currentAdmission.reason) return refused(currentAdmission.reason);
      const sessionBinding = z.object({ sessionId: z.string().min(1), sessionProfile: z.enum(['legacy', 'remote']) })
        .safeParse({ sessionId: input.sessionId, sessionProfile: input.sessionProfile });
      if (initialMode === 'off' || currentMode === 'off' ||
          (admission.allowRealGuest && (currentMode !== 'on' || (input.stay.propertyCode === 'HRCEN' && process.env.PANE_WRITE_CREATE !== 'on'))) ||
          currentAdmission.allowRealGuest !== admission.allowRealGuest ||
          !createAuthorityReady(input.stay) || !sessionBinding.success) {
        return { status: 'ok' as const, outcome: 'preview_only', runId, screenshots: ['filled.png'], hmsPrice: price.data };
      }
      await lockCreateActorSession(tx, { actorUserId: input.actorUserId, ...sessionBinding.data });
      const draft = { version: 'pane-cloud-preview/v1' as const, grantId: randomUUID(), actorUserId: input.actorUserId,
        ...sessionBinding.data, accessId: after.accessId, source: input.selection.source, identity: input.selection.identity,
        nativeGuestId: input.selection.nativeGuestId!, cursor, sourceDigest: after.sourceDigest, stateDigest: after.stateDigest,
        requestDigest: proof.normalizedRequestDigest, stayDigest: paneStayDigest(input.stay), approvedRequest: proof.request,
        selection: input.selection, stay: input.stay, capturedAt: new Date().toISOString(), price: price.data,
        previewShot: { runId, sha256: filled.sha256 }, expiresAt: Date.now() + PANE_PREVIEW_TTL_MS };
      const grant = grantSchema.parse({ ...draft, digest: hash(draft) });
      const previews = source.item.state[PREVIEWS];
      if (previews !== undefined && (!previews || typeof previews !== 'object' || Array.isArray(previews))) return refused('cloud_preview_unavailable');
      const stays = source.item.state.stays;
      if (stays !== undefined && (!stays || typeof stays !== 'object' || Array.isArray(stays))) return refused('cloud_preview_unavailable');
      const state = { ...source.item.state, propertyCode: target.target.propertyCode,
        [PREVIEWS]: { ...(previews as Record<string, unknown> | undefined), [input.stayId]: grant },
        stays: { ...(stays as Record<string, unknown> | undefined), [input.stayId]: input.stay } };
      await tx.update(workItem).set({ state, updatedAt: new Date() }).where(eq(workItem.id, input.workItemId));
      return { status: 'ok' as const, outcome: 'previewed', previewDigest: grant.digest, runId, screenshots: ['filled.png'], hmsPrice: price.data };
    });
  } catch (error) {
    const sourceChanged = error instanceof Error && /^(create_source_|create_actor_|create_fence_|cloud_create_(source_changed|property_mismatch|existing_booking|scope_changed|source_blocked))/.test(error.message);
    return refused(sourceChanged ? 'cloud_create_scope_changed' : 'cloud_preview_unavailable');
  }
}

/** Seal the ordered room previews into one source- and session-bound staff receipt. */
export async function preparePaneCloudWrite(db: DB, input: {
  transportId: string; mailboxAddress: string; actorUserId: string; sessionId: string;
  sessionProfile: 'legacy' | 'remote'; workItemId: string; propertySwitch?: PropertySwitch;
  rooms: Array<{ stayId: string; previewDigest: string }>;
}) {
  if (!input.rooms.length || input.rooms.length > 8 || new Set(input.rooms.map(room => room.stayId)).size !== input.rooms.length) {
    throw new Error('cloud_batch_stale');
  }
  const scope = resolvePropertyScope({ transportId: input.transportId, propertySwitch: input.propertySwitch });
  const configuration = await propertyConfigurationForScope(scope);
  const [item] = await db.select().from(workItem).where(and(eq(workItem.id, input.workItemId),
    eq(workItem.transportId, input.transportId))).limit(1);
  if (!item || item.state.propertyCode !== scope.propertyCode) throw new Error('cloud_create_scope_changed');
  const stays = item.state.stays;
  if (!stays || typeof stays !== 'object' || Array.isArray(stays)) throw new Error('cloud_batch_stale');
  const aliases = new Set<string>();
  const grants: Grant[] = [];
  const expectedRooms = new Set<string>();
  const requestedRooms = new Set<string>();
  const allocations: Array<{ allocationId: string; businessDigest: string; observationRef: string }> = [];
  for (const room of input.rooms) {
    const grant = grantOf(item.state, room.stayId);
    const row = (stays as Record<string, unknown>)[room.stayId];
    if (!grant?.stay || !grant.selection || !grant.capturedAt || !grant.price ||
        !row || typeof row !== 'object' || Array.isArray(row) || !preparedStay(item.state, room.stayId, row as Record<string, unknown>)) {
      throw new Error('cloud_batch_stale');
    }
    const roomInput: Input = { ...input, stayId: room.stayId, selection: grant.selection, stay: grant.stay as unknown as PaneStay };
    const target = createTarget(roomInput.stay);
    const mapped = mapPaneStayToCloudCreateInput(roomInput.stay, 'prepare', grant.nativeGuestId, { allowRealGuest: true });
    if (!target || target.propertyCode !== scope.propertyCode || !sameGrant(grant, roomInput, room.previewDigest) ||
        mapped.outcome !== 'ok' || cloudCreatePolicyIssue(configuration.formPolicy, mapped.input) ||
        !await previewShotValid(grant, roomInput)) throw new Error('cloud_batch_stale');
    const current = await withLockedCreateSource(db, sourceKey(roomInput, grant.cursor), async (tx, source) => {
      const checked = await checkSource(tx, source, roomInput, grant.accessId).catch((error: unknown) => {
        // The same source guards the preview already maps to one clear refusal; prepare never leaks their raw names.
        if (error instanceof Error && CLOUD_CREATE_SOURCE_GUARD.test(error.message)) throw new Error('cloud_create_scope_changed');
        throw error;
      });
      const parsed = safeParseStoredMailExtraction(source.effectivePayload);
      if (!parsed.success) throw new Error('cloud_batch_stale');
      const groups = formStays(parsed.data, source.item.state).filter(group => group.id === grant.identity.stayId);
      if (groups.length !== 1) throw new Error('cloud_batch_stale');
      for (const row of groups[0]!.rows) {
        const path = `stays[${grant.identity.stayId}].rows[${row.id}].count`;
        const count = Object.hasOwn(source.item.state, path) ? source.item.state[path] : row.rooms;
        if (!Number.isInteger(count) || (count as number) < 1 || (count as number) > 8) throw new Error('cloud_batch_stale');
        for (let index = 1; index <= (count as number); index++) expectedRooms.add(`${grant.identity.stayId}:${row.id}:${index}`);
      }
      return checked;
    });
    if (!matchesSource(current, grant) || grants.some(other => canonicalJson(other.source) !== canonicalJson(grant.source) ||
      canonicalJson(other.cursor) !== canonicalJson(grant.cursor))) throw new Error('cloud_batch_stale');
    for (const alias of hmsDispatchTargetKeys(target)) aliases.add(alias);
    const rowId = grant.identity.rowId === grant.identity.stayId ? `${grant.identity.stayId}_row` : grant.identity.rowId;
    requestedRooms.add(`${grant.identity.stayId}:${rowId}:${grant.identity.roomIndex}`);
    grants.push(grant);
    allocations.push({ allocationId: room.stayId, businessDigest: preparationDigest(grant.stay), observationRef: grant.grantId });
  }
  if (expectedRooms.size !== requestedRooms.size || [...expectedRooms].some(room => !requestedRooms.has(room))) {
    throw new Error('cloud_batch_stale');
  }
  const first = grants[0]!;
  const capturedAt = grants.map(grant => grant.capturedAt!).sort()[0]!;
  return prepareNativeHmsWrite({ db, transportId: input.transportId, workItemId: input.workItemId,
    actorUserId: input.actorUserId, sessionId: input.sessionId, sessionProfile: input.sessionProfile,
    propertySwitch: input.propertySwitch,
    expectedBusinessDigest: formDigest(item.state), expectedSourceHash: first.source.sourceHash,
    expectedRevision: item.revisionSeq, expectedSeq: item.revisionSeq,
    native: { operation: 'create', allocations, targetAliases: [...aliases].sort(),
      nativeObservation: { beforeDigest: hash(grants.map((grant, index) => ({ stayId: input.rooms[index]!.stayId,
        previewDigest: grant.digest, requestDigest: grant.requestDigest, previewShot: grant.previewShot,
        capturedAt: grant.capturedAt, price: grant.price }))), capturedAt,
        price: grants.map(grant => grant.price), warnings: [] },
      ...hmsConfigurationIdentities(scope, configuration, 'create') } });
}

/** Consume one reviewed grant, write one fenced stay, and require fresh readback. */
export async function commitPaneCloud(db: DB, input: Input, previewDigest: string,
  worker: CreateWorkerContext): Promise<PaneStayResult & { nativeStayId?: string; observationRef?: string }> {
  if (!cloudPreviewSelection.safeParse(input.selection).success || !z.string().uuid().safeParse(input.workItemId).success ||
      !/^[A-Za-z0-9_-]{1,120}$/.test(input.stayId) || !matchesRoomId(input.stayId, input.selection.identity)) {
    return refused('pane_preview_binding_required');
  }
  const target = paneStayCreateTarget({ transportId: input.transportId, propertyCode: input.stay.propertyCode });
  if (!target.ok) return refused('pane_save_property_mismatch');
  input = { ...input, stay: { ...input.stay, propertyCode: target.target.propertyCode } };
  const dispatchTarget = createTarget(input.stay);
  if (!dispatchTarget) return refused('guest_name_required');
  const admission = createAdmission(createMode(input.stay), input.stay);
  if (admission.reason) return refused(admission.reason);
  if (!createAuthorityReady(input.stay)) return refused('cloud_create_authority_unavailable');
  if (!paneCloudPreviewLoaders.runtimeReady()) return refused('cloud_create_runtime_unavailable');
  const mapped = mapPaneStayToCloudCreateInput(input.stay, 'commit', input.selection.nativeGuestId,
    { allowRealGuest: admission.allowRealGuest });
  if (mapped.outcome !== 'ok') return refused(mapped.reason);
  if (!digest.safeParse(previewDigest).success) return refused('pane_save_preview_required');
  const property = getPropertyRegistration(target.target.propertyCode);
  const operationId = hmsAllocationOperationId(worker.go.grant.grantId, input.stayId);
  if (!property?.active || worker.go.grant.operation !== 'create' || worker.go.grant.workItemId !== input.workItemId ||
      worker.go.grant.propertyCode !== property.propertyCode || worker.go.grant.tenantId !== property.expectedTenant ||
      worker.go.grant.transportId !== input.transportId || worker.go.actorUserId !== input.actorUserId ||
      worker.go.sessionId !== input.sessionId || worker.go.sessionProfile !== input.sessionProfile ||
      worker.go.preparation.workflowContext || !worker.go.preparation.allocations?.some(row => row.allocationId === input.stayId)) {
    return refused('pane_save_preview_required');
  }
  try {
    assertTargetAliasesHeld(worker.heldTargetLock, { tenantId: property.expectedTenant, propertyCode: property.propertyCode,
      targetAliases: [...new Set([...worker.go.preparation.targetAliases, ...hmsDispatchTargetKeys(dispatchTarget)])] });
  } catch { return refused('pane_save_lock_unavailable'); }
  let claimAttempted = false;
  const dispatch: { handle: HmsLabtestWriteHandle | null } = { handle: null };
  let beforeSha256: string | null = null;
  let claimError: unknown;
  let authorizationError: unknown;
  const noClaimResult = () => {
    if ((claimError instanceof HmsLabtestDispatchError && claimError.reason === 'occupied') ||
        (authorizationError instanceof Error && authorizationError.message === 'cloud_create_recovery_required')) {
      return refused('cloud_create_recovery_required');
    }
    if (authorizationError) return refused('cloud_create_scope_changed');
    return refused(claimAttempted ? PANE_SAVE_UNCONFIRMED : 'cloud_create_unavailable');
  };
  try {
    return await (async (lockSignal: AbortSignal) => {
      const currentMode = createMode(input.stay);
      const currentAdmission = createAdmission(currentMode, input.stay);
      if (currentAdmission.reason || currentAdmission.allowRealGuest !== admission.allowRealGuest) {
        return refused(currentAdmission.reason ?? 'pane_save_flag_off');
      }
      if (!createAuthorityReady(input.stay)) return refused('cloud_create_authority_unavailable');
      const [item] = await db.select({ state: workItem.state }).from(workItem)
        .where(and(eq(workItem.id, input.workItemId), eq(workItem.transportId, input.transportId))).limit(1);
      if (item && !staysClear(item.state, dispatchTarget)) return refused('cloud_create_recovery_required');
      if (item && hasIdentityStay(item.state, input.selection.identity)) return refused('pane_stay_already_booked');
      const grant = item && grantOf(item.state, input.stayId);
      if (!grant || !sameGrant(grant, input, previewDigest) || !await previewShotValid(grant, input)) return refused('pane_save_preview_required');
      const key = sourceKey(input, grant.cursor);
      const epoch = await captureHmsLabtestDispatchEpoch(db, dispatchTarget, input.workItemId);
      let siblings: BatchSibling[] = [];
      if (input.batch?.kind === 'continue') {
        siblings = await withLockedCreateSource(db, key, async (tx, source) => {
          const current = await checkSource(tx, source, input, grant.accessId);
          if (!matchesSource(current, grant)) throw new Error('cloud_batch_stale');
          return checkedSiblings(tx, source.item.state, input, grant, previewDigest);
        });
      }
      if (canonicalJson(siblings) !== canonicalJson(worker.siblings)) return refused('cloud_batch_stale');
      let verifiedSiblings = false;
      const native = await paneCloudPreviewLoaders.run(mapped.input, {
        signal: lockSignal, transportId: input.transportId, credentialLease: worker.credentialLease,
        expectedRequestDigest: grant.requestDigest, allowRealGuest: admission.allowRealGuest,
        expectedGuest: { firstName: input.stay.firstName, lastName: input.stay.lastName },
        cloudTargetKey: hmsDispatchTargetKey(dispatchTarget),
        authorizeCandidate: async () => !lockSignal?.aborted && grant.expiresAt > Date.now() && createAuthorityReady(input.stay) &&
          !createAdmission(createMode(input.stay), input.stay).reason,
        ...(siblings.length ? { verifyLabtestMatches: async (census: unknown) => {
          verifiedSiblings = await paneCloudPreviewLoaders.verifySiblings(census, siblings, property.propertyCode);
          return verifiedSiblings;
        } } : {}),
        dispatchCandidate: async (request, next, evidence) => {
          lockSignal?.throwIfAborted();
          const firstRequestDigest = nativeCreateSaveDigest(request);
          if (siblings.length && !verifiedSiblings) throw new Error('cloud_batch_readback_unavailable');
          const recovery = await createRecoveryEvidence(evidence, input, siblings);
          const checked = digestPaneCloudCreateProof(input.stay, grant.approvedRequest, recovery.guaranteeDisplay, grant.nativeGuestId, true, admission.allowRealGuest);
          if (checked.outcome !== 'ok' || checked.normalizedRequestDigest !== grant.requestDigest ||
              canonicalJson(checked.request) !== canonicalJson(grant.approvedRequest)) {
            throw new Error('cloud_create_recovery_invalid');
          }
          claimAttempted = true;
          try {
            dispatch.handle = await claimHmsLabtestDispatch(db, { workItemId: input.workItemId, transportId: input.transportId,
            actorUserId: input.actorUserId, grantId: operationId, propertyCode: property.propertyCode,
            firstName: input.stay.firstName, lastName: input.stay.lastName, target: dispatchTarget,
            nativeGuestId: grant.nativeGuestId, operation: 'create', stayId: input.stayId, sourceDigest: grant.sourceDigest,
            approvedDigest: grant.requestDigest, requestDigest: firstRequestDigest,
            recovery: { request: grant.approvedRequest, previewShot: grant.previewShot, ...recovery } }, async (tx, claim) => {
            try {
              const consumed = await consumeStaffGoAtDispatch(tx, worker.fence, lockSignal, input.stayId);
              if (consumed.grant.grantId !== worker.go.grant.grantId || consumed.payloadHash !== worker.go.payloadHash ||
                  consumed.grant.preparedRef !== worker.go.grant.preparedRef || consumed.grant.propertyCode !== property.propertyCode) {
                throw new Error('cloud_create_dispatch_stale');
              }
              assertTargetAliasesHeld(worker.heldTargetLock, { tenantId: property.expectedTenant, propertyCode: property.propertyCode,
                targetAliases: [...new Set([...worker.go.preparation.targetAliases, ...hmsDispatchTargetKeys(dispatchTarget)])] });
              // Once v2 owns this email, an old pane cannot start a separate Create.
              // The same transaction lock serializes this check with v2 seeding/Go.
              await lockCanonicalMailbox(tx as unknown as DB, input.transportId);
              await lockReservationWorkflowV2Source(tx, input.transportId, input.selection.source.messageId);
              const [v2] = await tx.select({ id: workItem.id }).from(workItem).where(and(
                eq(workItem.transportId, input.transportId), eq(workItem.threadId, input.selection.source.threadId),
                eq(workItem.sourceMessageId, input.selection.source.messageId),
                sql`${workItem.state} ? ${RESERVATION_WORKFLOW_V2_STATE_KEY}`)).limit(1);
              if (v2) throw new Error('cloud_create_scope_changed');
              await lockCreateSource(tx, key, async (lockedTx, source) => {
              const current = await checkSource(lockedTx, source, input, grant.accessId);
              const liveGrant = grantOf(source.item.state, input.stayId), stays = source.item.state.stays;
              const mode = createMode(input.stay);
              if (claim.stayId !== input.stayId || !liveGrant || grantInStoppedBatch(source.item.state, liveGrant.grantId) ||
                  !sameGrant(liveGrant, input, previewDigest) ||
                  !matchesSource(current, grant) || !staysClear(source.item.state, dispatchTarget) ||
                  hasIdentityStay(source.item.state, input.selection.identity) ||
                  createAdmission(mode, input.stay).reason || createAdmission(mode, input.stay).allowRealGuest !== admission.allowRealGuest ||
                  !createAuthorityReady(input.stay) ||
                  !await previewShotValid(grant, input)) throw new Error('cloud_create_dispatch_stale');
              await lockCreateActorSession(lockedTx, { actorUserId: input.actorUserId,
                sessionId: input.sessionId, sessionProfile: input.sessionProfile });
              const startedBatch = await prepareBatch(lockedTx, source, input, grant, previewDigest, worker.go.grant.grantId);
              if (input.batch?.kind === 'continue' &&
                  canonicalJson(await checkedSiblings(lockedTx, source.item.state, input, grant, previewDigest)) !== canonicalJson(siblings)) {
                throw new Error('cloud_batch_stale');
              }
              if (!sameGrant(liveGrant, input, previewDigest) || Date.parse(recovery.preimage.expiresAt) <= Date.now()) {
                throw new Error('cloud_create_dispatch_stale');
              }
              const holds = batchHolds(source.item.state);
              if (!holds || (input.batch && Object.hasOwn(holds, input.batch.id))) throw new Error('cloud_batch_stale');
              const state = { ...source.item.state,
                ...(startedBatch ? { [BATCH]: startedBatch.batch,
                  ...(startedBatch.pastBatches ? { [PAST_BATCHES]: startedBatch.pastBatches } : {}) } : {}),
                ...(input.batch ? { [BATCH_HOLDS]: { ...holds, [input.batch.id]: operationId } } : {}),
                stays: { ...(stays as Record<string, unknown> | undefined), [input.stayId]: {
                  ...grant.stay, status: 'unknown', confirmationNumber: null, screenshotRef: null, cloudCreateGrantId: operationId,
                  cloudCreateTarget: dispatchTarget } } };
              await lockedTx.update(workItem).set({ state, updatedAt: new Date() }).where(eq(workItem.id, input.workItemId));
              });
            } catch (error) { authorizationError = error; throw error; }
            }, epoch);
          } catch (error) { claimError = error; throw error; }
          try {
            beforeSha256 = recovery.beforeShot.sha256;
            if (Date.parse(recovery.preimage.expiresAt) <= Date.now()) throw new Error('cloud_create_preimage_expired');
            const live = createAdmission(createMode(input.stay), input.stay);
            if (live.reason || live.allowRealGuest !== admission.allowRealGuest || !createAuthorityReady(input.stay)) {
              throw new Error('cloud_create_dispatch_stale');
            }
            // Commit is the authority boundary. Source/access changes after this
            // point cannot change the captured, already-approved native request.
            lockSignal?.throwIfAborted();
            return await next();
          } catch (error) {
            // The route permanently disarms before issuing this one-use proof.
            // It remains valid even when the initial callback drain has timed out.
            const proof = next.proveNeverDispatched?.();
            if (proof && dispatch.handle) {
              try {
                await resolveNeverDispatchedCreate(db, dispatch.handle, proof, request, async (tx, intent) => {
                  await recordNeverDispatchedCreate(tx, intent);
                });
                dispatch.handle = null;
              } catch { /* Ambiguous resolution remains held. */ }
            }
            throw error;
          }
        },
      });
      if (!dispatch.handle) {
        if (!claimAttempted && native.issue === 'RATE_PRICE_UNCONFIRMED') return refused('cloud_price_unavailable');
        return noClaimResult();
      }
      const shots = beforeSha256 ? await saveScreenshots(native, input, beforeSha256) : null;
      const savedShot = shots?.shots.find((shot) => shot.name === 'saved.png');
      if (native.outcome !== 'saved' || native.writerSessionClosed !== true || native.save?.dispatchCallbacksDrained !== true ||
          typeof native.confirmation !== 'string' || !native.confirmation.trim() ||
          typeof native.nativeStayId !== 'string' || !/^\d{1,100}$/.test(native.nativeStayId) || !Array.isArray(native.readback?.fields) ||
          !Array.isArray(native.readback.mismatches) || native.readback.mismatches.length !== 0 || !shots || !savedShot) {
        return { ...refused(PANE_SAVE_UNCONFIRMED), ...shots };
      }
      const confirmationNumber = native.confirmation;
      const nativeStayId = native.nativeStayId;
      const observationRef = randomUUID();
      const nativeReadback = JSON.parse(JSON.stringify({ ...native.readback, confirmation: confirmationNumber, nativeStayId })) as Record<string, unknown>;
      const readbackDigest = hmsStateDigest(nativeReadback);
      lockSignal.throwIfAborted();
      await resolveHmsLabtestDispatch(db, dispatch.handle, { operation: 'create', confirmation: confirmationNumber, nativeStayId,
        nativeReadback, readbackDigest, savedShot: { runId: shots.runId, sha256: savedShot.sha256 } }, async (tx, intent) => {
        if (intent.workItemId !== input.workItemId || intent.transportId !== input.transportId ||
            intent.actorUserId !== input.actorUserId || intent.grantId !== operationId || intent.stayId !== input.stayId ||
            intent.approvedDigest !== grant.requestDigest) throw new Error('cloud_create_result_scope_changed');
        await recordRecoveredCreate(tx, intent, { confirmation: confirmationNumber, readbackDigest,
          savedShot: { runId: shots.runId, sha256: savedShot.sha256 }, shots: shots.shots,
          nativeReadback, nativeStayId, observationRef }, input.batch?.id, false);
      });
      const hmsPrice = savedHmsPrice(native.readback.fields);
      return { status: 'ok', outcome: 'committed', confirmationNumber, clickedSave: true,
        nativeStayId, observationRef, ...(hmsPrice ? { hmsPrice } : {}), ...shots };
    })(worker.signal);
  } catch (error) {
    if (claimAttempted) return noClaimResult();
    if (error instanceof HmsLabtestDispatchError && error.reason === 'occupied') {
      return refused('cloud_create_recovery_required');
    }
    return refused(isPropertyReadLockDeadline(error) ? 'refused_lock_busy' : 'cloud_create_unavailable');
  }
}

/** Execute only the ordered previews sealed in the worker's verified staff receipt. */
export async function executePreparedPaneCreateRun({ db, go, fence, signal }: {
  db: DB; go: VerifiedStaffGo; fence: AiRunFence; signal?: AbortSignal;
}) {
  const prepared = go.preparation, allocations = prepared.allocations;
  if (prepared.workflowContext || go.grant.operation !== 'create' || !allocations?.length || allocations.length > 8) {
    throw new Error('cloud_create_preparation_invalid');
  }
  const property = getPropertyRegistration(go.grant.propertyCode), databaseUrl = process.env.DATABASE_URL;
  if (!property?.active || !databaseUrl || property.expectedTenant !== go.grant.tenantId) {
    throw new Error('cloud_create_lock_unavailable');
  }
  const [item] = await db.select({ state: workItem.state }).from(workItem).where(and(
    eq(workItem.id, go.grant.workItemId), eq(workItem.transportId, go.grant.transportId))).limit(1);
  if (!item || formDigest(item.state) !== prepared.businessDigest) throw new Error('cloud_create_scope_changed');
  const actor = await db.transaction(tx => lockCreateActorAccess(tx, { transportId: go.grant.transportId, actorUserId: go.actorUserId }));
  if (!actor.mailboxAddress) throw new Error('cloud_create_scope_changed');
  const rooms = allocations.map(allocation => {
    const grant = grantOf(item.state, allocation.allocationId);
    if (!grant?.stay || !grant.selection || !grant.price || (allocations.length > 1 && !grant.price.currency) || !grant.capturedAt || grant.grantId !== allocation.observationRef ||
        preparationDigest(grant.stay) !== allocation.businessDigest) throw new Error('cloud_create_preparation_invalid');
    const input: Input = { transportId: go.grant.transportId, mailboxAddress: actor.mailboxAddress!,
      actorUserId: go.actorUserId, sessionId: go.sessionId, sessionProfile: go.sessionProfile,
      workItemId: go.grant.workItemId, stayId: allocation.allocationId, selection: grant.selection,
      stay: grant.stay as unknown as PaneStay };
    if (!sameGrant(grant, input, grant.digest)) throw new Error('cloud_create_preparation_invalid');
    return { grant, input };
  });
  const snapshotDigest = hash(rooms.map(({ grant, input }) => ({ stayId: input.stayId,
    previewDigest: grant.digest, requestDigest: grant.requestDigest, previewShot: grant.previewShot,
    capturedAt: grant.capturedAt, price: grant.price })));
  const capturedAt = rooms.map(({ grant }) => grant.capturedAt!).sort()[0]!;
  if (snapshotDigest !== prepared.nativeObservation.beforeDigest || capturedAt !== prepared.nativeObservation.capturedAt ||
      canonicalJson(rooms.map(({ grant }) => grant.price)) !== canonicalJson(prepared.nativeObservation.price)) {
    throw new Error('cloud_create_preparation_invalid');
  }
  const siblingTools = await import(new URL('../../tooling/hms-cloud/batch-sibling-readback.mjs', import.meta.url).href) as {
    verifyApprovedBatchSiblings: (siblings: BatchSibling[], options: Record<string, unknown>) => Promise<boolean>;
  };
  const aliases = new Set(prepared.targetAliases), siblings: BatchSibling[] = [];
  const results: Array<PaneStayResult & { allocationId: string; nativeStayId?: string; observationRef?: string }> = [];
  for (const [index, room] of rooms.entries()) {
    signal?.throwIfAborted();
    const lock = createPostgresTargetAliasLock({ tenantId: property.expectedTenant, propertyCode: property.propertyCode,
      targetAliases: [...aliases], databaseUrl });
    const result: PaneStayResult & { nativeStayId?: string; observationRef?: string } = await lock.withLock(async (_connection, targetSignal, heldTargetLock) => {
      const currentSignal = signal ? AbortSignal.any([signal, targetSignal]) : targetSignal;
      return withCloudCredentialLease(property.propertyCode, async credentialLease => {
        if (siblings.length && !await siblingTools.verifyApprovedBatchSiblings(siblings, { propertyCode: property.propertyCode,
          transportId: go.grant.transportId, signal: currentSignal, credentialLease })) return refused('cloud_batch_readback_unavailable');
        currentSignal.throwIfAborted();
        const batch: PaneCloudBatch | undefined = rooms.length === 1 ? undefined : index === 0
          ? { kind: 'start', id: go.grant.grantId, rooms: rooms.map(({ grant, input }) => ({ stayId: input.stayId,
            selection: input.selection, stay: input.stay, previewDigest: grant.digest })) }
          : { kind: 'continue', id: go.grant.grantId, index };
        return commitPaneCloud(db, { ...room.input, batch }, room.grant.digest,
          { go, fence, signal: currentSignal, heldTargetLock, credentialLease, siblings });
      }, { signal: currentSignal });
    }, { ...acquisitionWithin(PANE_PROPERTY_LOCK_WAIT_MS), ...(signal ? { signal } : {}) });
    results.push({ allocationId: room.input.stayId, ...result });
    if (result.status !== 'ok' || result.outcome !== 'committed' || !result.confirmationNumber ||
        !result.nativeStayId || !result.observationRef) {
      return { status: 'needs_reconcile' as const, issue: result.reason ?? 'cloud_create_batch_incomplete', results };
    }
    const saved = hmsDispatchTargetSchema.safeParse({ propertyCode: property.propertyCode, kind: 'saved',
      confirmation: result.confirmationNumber, nativeStayId: result.nativeStayId });
    if (!saved.success) return { status: 'needs_reconcile' as const, issue: 'cloud_create_target_unverified', results };
    for (const alias of hmsDispatchTargetKeys(saved.data)) aliases.add(alias);
    if (index + 1 < rooms.length) {
      const price = room.grant.price;
      if (!price?.currency) return { status: 'needs_reconcile' as const, issue: 'cloud_create_price_unverified', results };
      siblings.push({ confirmation: result.confirmationNumber, nativeStayId: result.nativeStayId,
        approvedRequest: room.grant.approvedRequest, requestDigest: room.grant.requestDigest,
        ratePlanAvailability: { ...price, currency: price.currency } });
    }
  }
  return { status: 'succeeded' as const, operationId: go.grant.grantId, observationRef: results.at(-1)!.observationRef!, results };
}

/** Clear only the original unknown row, atomically with its no-dispatch event. */
async function recordNeverDispatchedCreate(tx: CreateFenceTransaction, intent: HmsLabtestIntent) {
  if (intent.operation !== 'create' || !intent.stayId) throw new Error('cloud_create_recovery_scope_changed');
  const [current] = await tx.select({ state: workItem.state }).from(workItem)
    .where(and(eq(workItem.id, intent.workItemId), eq(workItem.transportId, intent.transportId))).limit(1).for('update');
  const stays = current?.state.stays;
  if (!stays || typeof stays !== 'object' || Array.isArray(stays)) throw new Error('cloud_create_recovery_scope_changed');
  const stay = (stays as Record<string, unknown>)[intent.stayId] as Record<string, unknown> | undefined;
  if (!stay || stay.status !== 'unknown' || stay.cloudCreateGrantId !== intent.grantId ||
      stay.confirmationNumber !== null || stay.screenshotRef !== null) throw new Error('cloud_create_recovery_scope_changed');
  const remaining = { ...stays } as Record<string, unknown>;
  const prepared = grantOf(current.state, intent.stayId);
  if (prepared?.stay) remaining[intent.stayId] = prepared.stay;
  else delete remaining[intent.stayId];
  const state: Record<string, unknown> = { ...current.state, stays: remaining };
  const holds = batchHolds(state);
  if (!holds) throw new Error('cloud_create_recovery_scope_changed');
  const heldBatches = Object.entries(holds).filter(([, grantId]) => grantId === intent.grantId);
  if (heldBatches.length > 1) throw new Error('cloud_create_recovery_scope_changed');
  if (heldBatches.length === 1) {
    delete holds[heldBatches[0]![0]];
    state[BATCH_HOLDS] = holds;
  }
  const rawBatch = state[BATCH];
  const batchId = rawBatch && typeof rawBatch === 'object' && !Array.isArray(rawBatch)
    ? (rawBatch as Record<string, unknown>).id : null;
  const batch = typeof batchId === 'string' ? storedBatch(state, batchId) : null;
  // If the first room provably never left the browser, no room in this batch
  // was saved. Discard its spent manifest so a fresh review can start again.
  // Keep partial batches when any earlier room has a durable outcome.
  if (batch?.rooms[0]?.stayId === intent.stayId && batchRoomOperationId(batch, batch.rooms[0]) === intent.grantId &&
      batch.rooms.every((room) => {
        const row = remaining[room.stayId];
        return !row || typeof row === 'object' && !Array.isArray(row) && preparedStay(state, room.stayId, row as Record<string, unknown>);
      })) delete state[BATCH];
  await tx.update(workItem).set({ state, updatedAt: new Date() })
    .where(eq(workItem.id, intent.workItemId));
}

const refs = z.object({ previewShot: grantSchema.shape.previewShot, beforeShot: grantSchema.shape.previewShot }).passthrough();

export type CreateRecoveryProof = { confirmation: string; readbackDigest: string;
  savedShot: { runId: string; sha256: string }; shots: HmsShotMeta[]; nativeReadback: Record<string, unknown>;
  nativeStayId?: string; observationRef?: string };

/** Serialize recovery with writes for the same Cloud create target. */
export async function withRecoveryLock<T>(intent: HmsLabtestIntent, action: (signal?: AbortSignal) => Promise<T>): Promise<T> {
  const target = paneStayHmsTargetForTransport(intent.transportId, intent.propertyCode);
  const dispatchTarget = hmsLabtestIntentTarget(intent);
  if (!target.ok || target.target.propertyCode !== intent.propertyCode ||
      !dispatchTarget || dispatchTarget.kind !== 'create') {
    throw new Error('cloud_create_recovery_property_unavailable');
  }
  const lock = paneStaySaveLoaders.lock ?? paneStayCloudTargetLock(target.target, dispatchTarget, { kind: 'independent_cloud' });
  if (!lock) throw new Error('cloud_create_recovery_lock_unavailable');
  return lock.withLock(action, acquisitionWithin(PANE_PROPERTY_LOCK_WAIT_MS));
}

/** This uses the fixed read-only HMS reader, never caller-provided proof. */
export async function proveCreateRecovery(intent: HmsLabtestIntent, signal?: AbortSignal): Promise<CreateRecoveryProof> {
  const parsed = refs.safeParse(intent.recovery);
  if (!parsed.success) throw new Error('cloud_create_recovery_evidence_unavailable');
  const owner = `${intent.actorUserId}:${intent.transportId}`;
  for (const [name, ref] of [['filled.png', parsed.data.previewShot], ['before.png', parsed.data.beforeShot]] as const) {
    if (!await verifyStoredHmsShot({ ...ref, name, owner, propertyCode: intent.propertyCode, workItemId: intent.workItemId }, name)) {
      throw new Error('cloud_create_recovery_evidence_unavailable');
    }
  }
  const reader = await import(new URL('../../tooling/hms-cloud/create-positive-recovery.mjs', import.meta.url).href) as {
    provePositiveCreateRecovery: (intent: HmsLabtestIntent, options: { signal?: AbortSignal }) => Promise<{
      outcome: string; confirmation?: unknown; readback?: unknown; screenshot?: unknown;
    }>;
  };
  const observed = await reader.provePositiveCreateRecovery(intent, { signal });
  if (observed.outcome !== 'verified' || typeof observed.confirmation !== 'string' ||
      !/^\d{6,10}-\d{1,2}$/.test(observed.confirmation) || !observed.readback ||
      typeof observed.readback !== 'object' || Array.isArray(observed.readback) ||
      !Buffer.isBuffer(observed.screenshot) || observed.screenshot.length > 20 * 1024 * 1024) {
    throw new Error('cloud_create_recovery_readback_unavailable');
  }
  const runId = randomUUID(), dir = await mkdtemp(join(tmpdir(), 'hms-create-recovery-'));
  try {
    await writeFile(join(dir, 'saved.png'), observed.screenshot, { flag: 'wx', mode: 0o600 });
    const shots = await persistHmsShots({ propertyCode: intent.propertyCode, workItemId: intent.workItemId,
      runId, sourceDir: dir, owner, now: Date.now() });
    const saved = shots?.find((item) => item.name === 'saved.png');
    if (!shots || !saved || !await verifyStoredHmsShot({ runId, name: 'saved.png', sha256: saved.sha256,
      owner, propertyCode: intent.propertyCode, workItemId: intent.workItemId }, 'saved.png')) {
      throw new Error('cloud_create_recovery_evidence_unavailable');
    }
    const nativeReadback = JSON.parse(JSON.stringify({ ...observed.readback as Record<string, unknown>, confirmation: observed.confirmation })) as Record<string, unknown>;
    const nativeStayId = typeof nativeReadback.nativeStayId === 'string' ? nativeReadback.nativeStayId : undefined;
    signal?.throwIfAborted();
    return { confirmation: observed.confirmation, readbackDigest: hmsStateDigest(nativeReadback),
      savedShot: { runId, sha256: saved.sha256 }, shots,
      nativeReadback, ...(nativeStayId ? { nativeStayId } : {}) };
  } finally { await rm(dir, { recursive: true, force: true }); }
}

/** Update only the original unknown stay and retain durable proof on the same transaction. */
export async function recordRecoveredCreate(tx: CreateFenceTransaction, intent: HmsLabtestIntent, proof: CreateRecoveryProof,
  completedBatchId?: string, operatorRecovery = true) {
  if (intent.operation !== 'create' || !intent.stayId) throw new Error('cloud_create_recovery_scope_changed');
  const [current] = await tx.select({ state: workItem.state }).from(workItem)
    .where(and(eq(workItem.id, intent.workItemId), eq(workItem.transportId, intent.transportId))).limit(1).for('update');
  if (!current) throw new Error('cloud_create_recovery_scope_changed');
  // A v2 draft can be seeded while an earlier legacy dispatch is unresolved.
  // Choose the recovery path from the original intent, not the current state.
  // Partial v2 markers fail closed instead of falling through to legacy recovery.
  const recovery = intent.recovery;
  const v2Intent = ['requestId', 'allocationId', 'operationId'].some((key) => Object.hasOwn(recovery, key));
  if (v2Intent) {
    const draft = reservationWorkflowV2DraftOf(current.state);
    const requestId = typeof recovery.requestId === 'string' ? recovery.requestId : '';
    const allocationId = typeof recovery.allocationId === 'string' ? recovery.allocationId : '';
    const operationId = typeof recovery.operationId === 'string' ? recovery.operationId : '';
    const prior = draft?.operationResults.find((result) => result.id === operationId && result.workflow === 'create' &&
      result.requestId === requestId && result.allocationId === allocationId && result.status === 'unknown');
    if (!draft || !requestId || !allocationId || !operationId ||
        intent.grantId !== operationId.toLowerCase() || intent.stayId !== `${requestId}_${allocationId}` ||
        intent.transportId !== draft.transportId || intent.propertyCode !== draft.propertyCode ||
        intent.sourceDigest !== draft.source.sourceHash || !prior || proof.confirmation.length > 40 ||
        !proof.nativeReadback || proof.nativeReadback.confirmation !== proof.confirmation) {
      throw new Error('reservation_workflow_v2_create_recovery_scope_changed');
    }
    const observation: ReservationWorkflowV2Observation = {
      ref: randomUUID(), generationId: draft.generationId, kind: 'stay_candidate', status: 'complete', observedAt: new Date().toISOString(),
      propertyCode: draft.propertyCode, sourceMessageId: draft.source.messageId, sourceRefs: [],
      criteria: { workflow: 'create', requestId, allocationId, operationId, recovered: true,
        draftRevision: prior.draftRevision, sourceHash: draft.source.sourceHash },
      coverage: { complete: true, notes: [] },
      result: { confirmation: proof.confirmation, nativeReadback: proof.nativeReadback,
        readbackDigest: proof.readbackDigest, savedShot: proof.savedShot,
        ratePlanAvailability: recovery.ratePlanAvailability ?? null,
        arAccountProfileId: recovery.arAccountProfileId ?? null },
    };
    const observations = [...draft.observations, observation];
    const summary = `Recovered confirmed native Create ${proof.confirmation} from fresh HMS readback`;
    const operationResults = [...draft.operationResults.filter((result) => result.id !== operationId), {
      ...prior, status: 'succeeded' as const, observationRefs: [observation.ref], updatedAt: new Date().toISOString(), summary,
    }];
    const nextDraft = reservationWorkflowV2DraftSchema.parse({ ...draft, observations, operationResults });
    const state = withReservationWorkflowV2Draft(current.state, nextDraft);
    await tx.update(workItem).set({ state, updatedAt: new Date() }).where(eq(workItem.id, intent.workItemId));
    await tx.insert(workEvent).values({ workItemId: intent.workItemId, actorKind: 'system', type: 'write.evidence',
      fieldPath: `reservationWorkflowV2:operationResults:${operationId}`,
      value: { id: operationId, requestId, allocationId, workflow: 'create', status: 'succeeded',
        observationRefs: [observation.ref], recovered: true },
      evidence: { sourceHash: draft.source.sourceHash, confirmation: proof.confirmation, readbackDigest: proof.readbackDigest } });
    return;
  }
  const stays = current.state.stays;
  if (!stays || typeof stays !== 'object' || Array.isArray(stays)) throw new Error('cloud_create_recovery_scope_changed');
  const stay = (stays as Record<string, unknown>)[intent.stayId] as Record<string, unknown> | undefined;
  if (!stay || stay.status !== 'unknown' || stay.cloudCreateGrantId !== intent.grantId) {
    throw new Error('cloud_create_recovery_scope_changed');
  }
  const recoveredTarget = hmsLabtestIntentTarget(intent);
  const storedTarget = hmsDispatchTargetSchema.safeParse(stay.cloudCreateTarget);
  if (!recoveredTarget || recoveredTarget.kind !== 'create' ||
      (stay.cloudCreateTarget !== undefined && (!storedTarget.success ||
        hmsDispatchTargetKey(storedTarget.data) !== hmsDispatchTargetKey(recoveredTarget)))) {
    throw new Error('cloud_create_recovery_scope_changed');
  }
  let legacyHolds: Record<string, string> | undefined;
  if (operatorRecovery && current.state[BATCH_HOLDS] === undefined && current.state[BATCH] !== undefined) {
    const raw = current.state[BATCH];
    const id = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>).id : null;
    const batch = typeof id === 'string' ? storedBatch(current.state, id) : null;
    if (!batch) throw new Error('cloud_create_recovery_scope_changed');
    const members = batch.rooms.filter((room) => batchRoomOperationId(batch, room) === intent.grantId);
    if (members.length > 1 || (members.length === 1 && (members[0]!.stayId !== intent.stayId ||
        members[0]!.grant.requestDigest !== intent.approvedDigest || members[0]!.grant.nativeGuestId !== intent.nativeGuestId))) {
      throw new Error('cloud_create_recovery_scope_changed');
    }
    if (members.length === 1) legacyHolds = { [batch.id]: intent.grantId };
  }
  let releasedHolds: Record<string, string> | undefined;
  if (completedBatchId) {
    const holds = batchHolds(current.state);
    if (!holds || holds[completedBatchId] !== intent.grantId) throw new Error('cloud_create_recovery_scope_changed');
    releasedHolds = { ...holds };
    delete releasedHolds[completedBatchId];
  }
  const recoveredBatches = Object.entries(legacyHolds ?? batchHolds(current.state) ?? {})
    .filter(([, grantId]) => grantId === intent.grantId).map(([id]) => id);
  if (operatorRecovery && recoveredBatches.length > 1) throw new Error('cloud_create_recovery_scope_changed');
  const observationRef = proof.observationRef ?? randomUUID();
  const nativeStayId = proof.nativeStayId ?? (typeof proof.nativeReadback.nativeStayId === 'string' ? proof.nativeReadback.nativeStayId : undefined);
  if (!operatorRecovery && (!nativeStayId || !/^\d{1,100}$/.test(nativeStayId))) throw new Error('cloud_create_recovery_scope_changed');
  const state = { ...current.state, ...(legacyHolds ? { [BATCH_HOLDS]: legacyHolds } : {}),
    ...(releasedHolds ? { [BATCH_HOLDS]: releasedHolds } : {}),
    stays: { ...stays, [intent.stayId]: { ...stay, status: 'booked',
    confirmationNumber: proof.confirmation, screenshotRef: { runId: proof.savedShot.runId, name: 'saved.png' },
    runId: proof.savedShot.runId, shots: proof.shots, cloudCreateVerified: true,
    cloudCreateTarget: recoveredTarget, cloudCreateGrantId: intent.grantId, readbackDigest: proof.readbackDigest,
    observationRef, ...(nativeStayId ? { nativeStayId } : {}),
    ...(operatorRecovery ? { cloudCreateRecovered: true, cloudCreateRecoveredBatchId: recoveredBatches[0] ?? null } : {}) } } };
  await tx.update(workItem).set({ state, updatedAt: new Date() }).where(eq(workItem.id, intent.workItemId));
  await tx.insert(workEvent).values({ id: observationRef, workItemId: intent.workItemId, actorKind: 'system', type: 'write.evidence',
    fieldPath: `stays:${intent.stayId}`, value: { operation: 'create', operationId: intent.grantId,
      propertyCode: intent.propertyCode, confirmation: proof.confirmation, nativeStayId: nativeStayId ?? null,
      readbackDigest: proof.readbackDigest, savedShot: proof.savedShot, recovered: operatorRecovery } });
}
