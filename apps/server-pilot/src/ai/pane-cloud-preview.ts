import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { DB } from '../db/client.js';
import { message } from '../db/schema/mail.js';
import { workItem } from '../db/schema/work.js';
import { centurionWriterCurrent } from '../../tooling/playwright-quote/centurion-stay360.mjs';
import { isDaVinciMailboxOrigin } from '../hms/mailbox-hms-origin-bind.js';
import { acquisitionWithin, isPropertyReadLockDeadline, PANE_PROPERTY_LOCK_WAIT_MS } from '../hms/property-read-lock.js';
import { canonicalJson } from './draft-approval.js';
import { isSelfSentPreStayInformationMail } from './existing-stay-information.js';
import { persistHmsShots, verifyStoredHmsShot, type HmsShotMeta } from './hms-shots-store.js';
import { captureHmsLabtestDispatchEpoch, claimHmsLabtestDispatch, HmsLabtestDispatchError, resolveHmsLabtestDispatch,
  type HmsLabtestIntent, type HmsLabtestWriteHandle } from './hms-labtest-dispatch.js';
import { lockCreateActorAccess, lockCreateActorSession } from './pane-create-actor-lock.js';
import { digestPaneCloudCreateProof, mapPaneStayToCloudCreateInput } from './pane-create-cloud-input.js';
import { assertNoCreateDispatchFence, type CreateFenceTransaction } from './pane-create-dispatch-fence.js';
import { activePaneCreateIdentity, paneCreateIdentitySchema } from './pane-create-scope.js';
import { lockCreateSource, withLockedCreateSource, type LockedCreateSource } from './pane-create-source-loader.js';
import { PANE_PREVIEW_TTL_MS, PANE_SAVE_UNCONFIRMED, paneStayCreateTarget, paneStayDigest, paneStayModeRefusal,
  paneStayPropertyLock, paneStaySaveLoaders, paneStaySaveMode, registerPaneRun, type PaneStay, type PaneStayResult } from './pane-stay-save.js';
import { staffQuoteSourceHash } from './staff-quote-workflow.js';

export const cloudPreviewSelection = z.object({
  source: z.object({ messageId: z.string().trim().min(1).max(200), threadId: z.string().trim().min(1).max(200),
    sourceHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  identity: paneCreateIdentitySchema, nativeGuestId: z.string().regex(/^\d+$/).optional(),
}).strict();
type Input = { transportId: string; mailboxAddress: string; actorUserId: string; workItemId: string; stayId: string;
  sessionId?: string; sessionProfile?: 'legacy' | 'remote';
  selection: z.infer<typeof cloudPreviewSelection>; stay: PaneStay };
type Native = { outcome?: unknown; issue?: unknown; guestCandidates?: unknown; applied?: { guaranteeType?: unknown };
  requestBinding?: { request?: unknown; digest?: unknown }; screenshots?: Record<string, unknown>;
  writerSessionClosed?: unknown; save?: { dispatchCallbacksDrained?: unknown };
  confirmation?: unknown; readback?: { fields?: unknown; mismatches?: unknown } };
type NativeOptions = { capturePrepareScreenshot?: boolean; requireExplicitGuestSelection?: boolean; expectedRequestDigest?: string;
  authorizeCandidate?: (request: unknown) => Promise<boolean>;
  dispatchCandidate?: (request: unknown, next: () => Promise<unknown>, evidence: unknown) => Promise<unknown> };
export const paneCloudPreviewLoaders: {
  runtimeReady: () => boolean;
  authorityReady: () => boolean;
  run: (input: Record<string, unknown>, options: NativeOptions) => Promise<Native>;
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
};
const refused = (reason: string): PaneStayResult => ({ status: 'refused', reason });

const cursorSchema = z.object({ extractionId: z.string().uuid(), revision: z.number().int().nonnegative(),
  revisionHead: z.number().int().nonnegative(), seq: z.number().int().nonnegative() }).strict();
type Cursor = z.infer<typeof cursorSchema>;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const day = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(day.valueOf()) && day.toISOString().slice(0, 10) === value;
});
const labDate = isoDate.refine((value) => value >= '2027-01-01');
const grantSchema = z.object({ version: z.literal('pane-cloud-preview/v1'), grantId: z.string().uuid(),
  digest, actorUserId: z.string().min(1), sessionId: z.string().min(1), sessionProfile: z.enum(['legacy', 'remote']),
  accessId: z.string().min(1), source: cloudPreviewSelection.shape.source,
  identity: paneCreateIdentitySchema, nativeGuestId: z.string().regex(/^\d+$/), cursor: cursorSchema,
  sourceDigest: digest, stateDigest: digest, requestDigest: digest, stayDigest: digest,
  approvedRequest: z.record(z.string(), z.unknown()),
  previewShot: z.object({ runId: z.string().uuid(), sha256: digest }).strict(), expiresAt: z.number().finite() }).strict();
type Grant = z.infer<typeof grantSchema>;
const PREVIEWS = 'cloudCreatePreviews';
const hash = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');

/** Hash the exact intercepted request; the native fence separately validates every approved field. */
function nativeSaveDigest(raw: unknown): string {
  if (!raw || typeof raw !== 'object') throw new Error('cloud_create_request_unavailable');
  const request = raw as { method?: () => string; url?: () => string; headers?: () => Record<string, string>;
    postDataBuffer?: () => Buffer | null };
  if (request.method?.() !== 'POST' || typeof request.url !== 'function' || typeof request.headers !== 'function' ||
      typeof request.postDataBuffer !== 'function') throw new Error('cloud_create_request_unavailable');
  const url = new URL(request.url()), contentType = request.headers()['content-type'] ?? '';
  const bytes = request.postDataBuffer();
  if (url.origin !== 'https://hmsweb.hms.eu1.inforcloudsuite.com' || url.pathname !== '/web/base/OSRESV.HDR' ||
      url.hash || [...url.searchParams].length !== 1 || url.searchParams.get('pageaction') !== 'SAVE' ||
      !/^application\/x-www-form-urlencoded(?:;|$)/i.test(contentType) || !Buffer.isBuffer(bytes) ||
      bytes.length === 0 || bytes.length > 1024 * 1024) throw new Error('cloud_create_request_unavailable');
  return createHash('sha256').update(JSON.stringify(['POST', url.href, contentType])).update('\0').update(bytes).digest('hex');
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

/** Recheck the exact source, extraction, mailbox and staff access while their rows are locked. */
async function checkSource(tx: CreateFenceTransaction, source: LockedCreateSource, input: Input, accessId?: string) {
  await assertNoCreateDispatchFence(tx, { transportId: input.transportId, workItemId: input.workItemId });
  const actor = await lockCreateActorAccess(tx, { transportId: input.transportId, actorUserId: input.actorUserId, accessId });
  const mail = source.snapshot.source;
  if (mail.historyOnly || staffQuoteSourceHash(mail) !== input.selection.source.sourceHash ||
      actor.mailboxAddress !== input.mailboxAddress) throw new Error('cloud_create_source_changed');
  const thread = await tx.select({ id: message.id, direction: message.direction, fromAddress: message.fromAddress,
    ownerHeaderValue: message.ownerHeaderValue, toAddresses: message.toAddresses, ccAddresses: message.ccAddresses })
    .from(message).where(and(eq(message.transportId, input.transportId), eq(message.threadId, input.selection.source.threadId)))
    .orderBy(message.id).limit(513).for('share');
  if (thread.length > 512 || !thread.some((row) => row.id === mail.id) ||
      thread.some((row) => (row.id === mail.id || row.direction === 'inbound') && isDaVinciMailboxOrigin(row))) {
    throw new Error('cloud_create_property_mismatch');
  }
  const payload = source.snapshot.extraction.payload;
  if (!activePaneCreateIdentity(payload, source.item.state, input.selection.identity)) throw new Error('cloud_create_scope_changed');
  const confirmations = payload && Array.isArray(payload.confirmationNumbers)
    ? payload.confirmationNumbers.filter((value): value is string => typeof value === 'string') : [];
  if (!actor.mailboxAddress || isSelfSentPreStayInformationMail({ fromAddress: mail.fromAddress, mailboxAddress: actor.mailboxAddress,
    subject: mail.subject, confirmationNumbers: confirmations })) throw new Error('cloud_create_existing_booking');
  // Staff may edit the booking. The grant binds their reviewed form and selected
  // room identity; the native request fence checks the same values before Save.
  const state = { ...source.item.state };
  for (const key of [PREVIEWS, 'stayPreviews', 'stays']) delete state[key];
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
    canonicalJson(grant.source) === canonicalJson(input.selection.source) &&
    canonicalJson(grant.identity) === canonicalJson(input.selection.identity);
}
function matchesSource(current: { sourceDigest: string; stateDigest: string; accessId: string }, expected: {
  sourceDigest: string; stateDigest: string; accessId: string;
}): boolean {
  return current.sourceDigest === expected.sourceDigest && current.stateDigest === expected.stateDigest && current.accessId === expected.accessId;
}
function staysClear(state: Record<string, unknown>): boolean {
  const stays = state.stays;
  if (stays === undefined) return true;
  if (!stays || typeof stays !== 'object' || Array.isArray(stays)) return false;
  return Object.values(stays).every((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
    const row = raw as Record<string, unknown>;
    return row.status === 'booked' && typeof row.confirmationNumber === 'string' && Boolean(row.confirmationNumber.trim());
  });
}
const hasStay = (state: Record<string, unknown>, stayId: string) =>
  !!state.stays && typeof state.stays === 'object' && !Array.isArray(state.stays) && Object.hasOwn(state.stays, stayId);
const previewShotValid = (grant: Grant, input: Input) => verifyStoredHmsShot({ ...grant.previewShot, name: 'filled.png',
  owner: `${input.actorUserId}:${input.transportId}`, propertyCode: 'HRCEN', workItemId: input.workItemId });

async function saveScreenshots(native: Native, input: Input, beforeSha256: string) {
  const before = native.screenshots?.before;
  if (typeof before !== 'string') return null;
  const dir = dirname(before), match = /^hms-cloud-create-([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/.exec(basename(dir));
  if (!match || before !== join('/tmp', basename(dir), 'before.png') || native.screenshots?.after !== join(dir, 'after.png')) return null;
  const runId = match[1]!, owner = `${input.actorUserId}:${input.transportId}`;
  await copyFile(join(dir, 'after.png'), join(dir, 'saved.png'));
  registerPaneRun({ runId, dir, owner, now: Date.now() });
  const shots = await persistHmsShots({ propertyCode: 'HRCEN', workItemId: input.workItemId, runId, sourceDir: dir, owner, now: Date.now() }).catch(() => null);
  const saved = shots?.find((shot) => shot.name === 'saved.png');
  if (!shots || !shots.some((shot) => shot.name === 'before.png' && shot.sha256 === beforeSha256) ||
      !saved || !await verifyStoredHmsShot({ runId, name: 'saved.png', sha256: saved.sha256, owner,
        propertyCode: 'HRCEN', workItemId: input.workItemId }, 'saved.png')) return null;
  return { runId, screenshots: ['before.png', 'saved.png'], shots };
}

/** Persist the last clean preimage and before image before creating an UNKNOWN intent. */
async function createRecoveryEvidence(value: unknown, input: Input) {
  const processIdentity = z.object({ pid: z.number().int().safe().min(2), started: z.string().regex(/^\d+$/) }).strict();
  const writerIdentity = z.object({ host: digest, bootId: z.string().uuid(), pidNamespace: z.string().regex(/^pid:\[\d+\]$/),
    node: processIdentity, browser: processIdentity }).strict();
  const parsed = z.object({ beforeScreenshot: z.string(), preimage: z.object({ outcome: z.literal('clear'),
    arrival: labDate, departure: labDate, searchedDateRange: z.object({ from: isoDate, to: isoDate }),
    expiresAt: z.string().datetime(),
    coverage: z.object({ displayed: z.number().int().nonnegative().safe(), total: z.number().int().nonnegative().safe(),
      complete: z.literal(true) }),
    sameArrival: z.array(z.unknown()).length(0),
  }).passthrough(), writer: writerIdentity, guaranteeDisplay: z.string().min(1).max(200) }).strict().safeParse(value);
  if (!parsed.success || parsed.data.preimage.arrival !== input.stay.arrival ||
      parsed.data.preimage.departure !== input.stay.departure || input.stay.arrival >= input.stay.departure ||
      parsed.data.preimage.searchedDateRange.from > input.stay.arrival ||
      parsed.data.preimage.searchedDateRange.to < input.stay.arrival ||
      Date.parse(parsed.data.preimage.expiresAt) <= Date.now() ||
      parsed.data.preimage.coverage.displayed !== parsed.data.preimage.coverage.total ||
      !centurionWriterCurrent(parsed.data.writer)) {
    throw new Error('cloud_create_preimage_unavailable');
  }
  const before = parsed.data.beforeScreenshot, dir = dirname(before);
  const match = /^hms-cloud-create-([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/.exec(basename(dir));
  if (!match || before !== join('/tmp', basename(dir), 'before.png')) throw new Error('cloud_create_before_unavailable');
  const runId = match[1]!, owner = `${input.actorUserId}:${input.transportId}`;
  const shots = await persistHmsShots({ propertyCode: 'HRCEN', workItemId: input.workItemId, runId, sourceDir: dir, owner, now: Date.now() });
  const shot = shots?.find((item) => item.name === 'before.png');
  if (!shot || !await verifyStoredHmsShot({ runId, name: 'before.png', sha256: shot.sha256, owner,
    propertyCode: 'HRCEN', workItemId: input.workItemId }, 'before.png')) throw new Error('cloud_create_before_unavailable');
  const { arrival, departure, searchedDateRange, coverage, expiresAt, sameArrival } = parsed.data.preimage;
  return { beforeShot: { runId, sha256: shot.sha256 }, preimage: { arrival, departure, searchedDateRange, coverage, expiresAt, sameArrival },
    writer: parsed.data.writer, guaranteeDisplay: parsed.data.guaranteeDisplay };
}

/** Preview the exact request; a one-use Go grant is issued only when saving is enabled. */
export async function previewPaneCloud(db: DB, input: Input): Promise<PaneStayResult & { guestCandidates?: unknown[] }> {
  if (!cloudPreviewSelection.safeParse(input.selection).success ||
      input.stayId !== `${input.selection.identity.stayId}_${input.selection.identity.roomIndex}`) return refused('pane_preview_binding_required');
  const target = paneStayCreateTarget({ transportId: input.transportId, propertyCode: input.stay.propertyCode });
  if (!target.ok || target.target.propertyCode !== 'HRCEN' || target.target.browserSlot !== 'centurion') return refused('pane_save_property_mismatch');
  if (input.stay.firstName !== 'Proof' || input.stay.lastName !== 'Labtest' || input.stay.arrival < '2027-01-01') {
    return refused('cloud_preview_labtest_only');
  }
  const initialMode = paneStaySaveLoaders.mode?.() ?? paneStaySaveMode();
  const modeReason = paneStayModeRefusal(initialMode === 'off' ? 'on' : initialMode, input.stay);
  if (modeReason) return refused(modeReason);
  if (!paneCloudPreviewLoaders.runtimeReady()) return refused('cloud_create_runtime_unavailable');
  const mapped = mapPaneStayToCloudCreateInput(input.stay, 'prepare', input.selection.nativeGuestId);
  if (mapped.outcome !== 'ok') return refused(mapped.reason);
  try {
    const cursor = await currentCursor(db, input), key = sourceKey(input, cursor);
    const before = await withLockedCreateSource(db, key, (tx, source) => checkSource(tx, source, input));
    const sourceUnchanged = async () => {
      const after = await withLockedCreateSource(db, key, (tx, source) => checkSource(tx, source, input, before.accessId));
      return matchesSource(after, before);
    };
    const native = await paneCloudPreviewLoaders.run(mapped.input, { capturePrepareScreenshot: Boolean(input.selection.nativeGuestId),
      requireExplicitGuestSelection: !input.selection.nativeGuestId });
    if (!input.selection.nativeGuestId && ['guest_ambiguous', 'guest_choice_required'].includes(String(native.issue)) && Array.isArray(native.guestCandidates)) {
      if (!await sourceUnchanged()) return refused('cloud_create_scope_changed');
      const candidates = native.guestCandidates.flatMap((value) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
        const row = value as Record<string, unknown>;
        if (typeof row.nativeId !== 'string' || !/^\d+$/.test(row.nativeId) || row.firstName !== input.stay.firstName || row.lastName !== input.stay.lastName) return [];
        return [{ nativeId: row.nativeId, firstName: row.firstName, lastName: row.lastName,
          ...(typeof row.city === 'string' && row.city ? { city: row.city } : {}),
          ...(typeof row.country === 'string' && row.country ? { country: row.country } : {}) }];
      }).slice(0, 50);
      return { ...refused('guest_choice_required'), guestCandidates: candidates };
    }
    if (!input.selection.nativeGuestId) return refused('prepared_guest_identity_required');
    if (native.outcome !== 'prepared' || !native.requestBinding) return refused('cloud_preview_unavailable');
    const proof = digestPaneCloudCreateProof(input.stay, native.requestBinding.request, native.applied?.guaranteeType, input.selection.nativeGuestId);
    if (proof.outcome !== 'ok' || native.requestBinding.digest !== proof.normalizedRequestDigest) return refused('cloud_create_proof_mismatch');
    const shot = native.screenshots?.filled;
    if (typeof shot !== 'string') return refused('cloud_preview_unavailable');
    const dir = dirname(shot), match = /^hms-cloud-create-([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/.exec(basename(dir));
    if (!match || shot !== join('/tmp', basename(dir), 'filled.png')) return refused('cloud_preview_unavailable');
    const owner = `${input.actorUserId}:${input.transportId}`, runId = match[1]!;
    registerPaneRun({ runId, dir, owner, now: Date.now() });
    const shots = await persistHmsShots({ propertyCode: 'HRCEN', workItemId: input.workItemId, runId, sourceDir: dir, owner, now: Date.now() });
    const filled = shots?.find((item) => item.name === 'filled.png');
    if (!filled || !await verifyStoredHmsShot({ runId, name: filled.name, sha256: filled.sha256,
      owner, propertyCode: 'HRCEN', workItemId: input.workItemId })) return refused('cloud_preview_unavailable');
    return await withLockedCreateSource(db, key, async (tx, source) => {
      const after = await checkSource(tx, source, input, before.accessId);
      if (!matchesSource(after, before)) return refused('cloud_create_scope_changed');
      if (!staysClear(source.item.state)) return refused('cloud_create_recovery_required');
      if (hasStay(source.item.state, input.stayId)) return refused('pane_stay_already_booked');
      const currentMode = paneStaySaveLoaders.mode?.() ?? paneStaySaveMode();
      const sessionBinding = z.object({ sessionId: z.string().min(1), sessionProfile: z.enum(['legacy', 'remote']) })
        .safeParse({ sessionId: input.sessionId, sessionProfile: input.sessionProfile });
      if (initialMode === 'off' || currentMode === 'off' || paneStayModeRefusal(currentMode, input.stay) ||
          !paneCloudPreviewLoaders.authorityReady() || !sessionBinding.success) {
        return { status: 'ok' as const, outcome: 'preview_only', runId, screenshots: ['filled.png'] };
      }
      await lockCreateActorSession(tx, { actorUserId: input.actorUserId, ...sessionBinding.data });
      const draft = { version: 'pane-cloud-preview/v1' as const, grantId: randomUUID(), actorUserId: input.actorUserId,
        ...sessionBinding.data, accessId: after.accessId, source: input.selection.source, identity: input.selection.identity,
        nativeGuestId: input.selection.nativeGuestId!, cursor, sourceDigest: after.sourceDigest, stateDigest: after.stateDigest,
        requestDigest: proof.normalizedRequestDigest, stayDigest: paneStayDigest(input.stay), approvedRequest: proof.request,
        previewShot: { runId, sha256: filled.sha256 }, expiresAt: Date.now() + PANE_PREVIEW_TTL_MS };
      const grant = grantSchema.parse({ ...draft, digest: hash(draft) });
      const previews = source.item.state[PREVIEWS];
      if (previews !== undefined && (!previews || typeof previews !== 'object' || Array.isArray(previews))) return refused('cloud_preview_unavailable');
      const state = { ...source.item.state, [PREVIEWS]: { ...(previews as Record<string, unknown> | undefined), [input.stayId]: grant } };
      await tx.update(workItem).set({ state, updatedAt: new Date() }).where(eq(workItem.id, input.workItemId));
      return { status: 'ok' as const, outcome: 'previewed', previewDigest: grant.digest, runId, screenshots: ['filled.png'] };
    });
  } catch (error) {
    const sourceChanged = error instanceof Error && /^(create_source_|create_actor_|create_fence_|cloud_create_(source_changed|property_mismatch|existing_booking|scope_changed))/.test(error.message);
    return refused(sourceChanged ? 'cloud_create_scope_changed' : 'cloud_preview_unavailable');
  }
}

/** Consume one reviewed grant, write one fenced fake stay, and require fresh readback. */
export async function commitPaneCloud(db: DB, input: Input, previewDigest: string): Promise<PaneStayResult> {
  if (!cloudPreviewSelection.safeParse(input.selection).success || !z.string().uuid().safeParse(input.workItemId).success ||
      !/^[A-Za-z0-9_-]{1,40}$/.test(input.stayId) || input.stayId !== `${input.selection.identity.stayId}_${input.selection.identity.roomIndex}`) {
    return refused('pane_preview_binding_required');
  }
  const target = paneStayCreateTarget({ transportId: input.transportId, propertyCode: input.stay.propertyCode });
  if (!target.ok || target.target.propertyCode !== 'HRCEN' || target.target.browserSlot !== 'centurion') return refused('pane_save_property_mismatch');
  if (input.stay.firstName !== 'Proof' || input.stay.lastName !== 'Labtest' || input.stay.arrival < '2027-01-01') return refused('cloud_preview_labtest_only');
  const modeReason = paneStayModeRefusal(paneStaySaveLoaders.mode?.() ?? paneStaySaveMode(), input.stay);
  if (modeReason) return refused(modeReason);
  if (!paneCloudPreviewLoaders.authorityReady()) return refused('cloud_create_authority_unavailable');
  if (!paneCloudPreviewLoaders.runtimeReady()) return refused('cloud_create_runtime_unavailable');
  const mapped = mapPaneStayToCloudCreateInput(input.stay, 'commit', input.selection.nativeGuestId);
  if (mapped.outcome !== 'ok') return refused(mapped.reason);
  if (!digest.safeParse(previewDigest).success) return refused('pane_save_preview_required');
  const lock = paneStaySaveLoaders.lock ?? paneStayPropertyLock(target.target);
  if (!lock) return refused('pane_save_lock_unavailable');
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
    return await lock.withLock(async () => {
      const currentMode = paneStaySaveLoaders.mode?.() ?? paneStaySaveMode();
      const reason = paneStayModeRefusal(currentMode, input.stay);
      if (reason) return refused(reason);
      if (!paneCloudPreviewLoaders.authorityReady()) return refused('cloud_create_authority_unavailable');
      const [item] = await db.select({ state: workItem.state }).from(workItem)
        .where(and(eq(workItem.id, input.workItemId), eq(workItem.transportId, input.transportId))).limit(1);
      if (item && !staysClear(item.state)) return refused('cloud_create_recovery_required');
      if (item && hasStay(item.state, input.stayId)) return refused('pane_stay_already_booked');
      const grant = item && grantOf(item.state, input.stayId);
      if (!grant || !sameGrant(grant, input, previewDigest) || !await previewShotValid(grant, input)) return refused('pane_save_preview_required');
      const key = sourceKey(input, grant.cursor);
      const epoch = await captureHmsLabtestDispatchEpoch(db);
      const native = await paneCloudPreviewLoaders.run(mapped.input, {
        expectedRequestDigest: grant.requestDigest,
        authorizeCandidate: async () => grant.expiresAt > Date.now(),
        dispatchCandidate: async (request, next, evidence) => {
          const firstRequestDigest = nativeSaveDigest(request);
          const recovery = await createRecoveryEvidence(evidence, input);
          const checked = digestPaneCloudCreateProof(input.stay, grant.approvedRequest, input.stay.guaranteeType, grant.nativeGuestId);
          if (checked.outcome !== 'ok' || checked.normalizedRequestDigest !== grant.requestDigest ||
              canonicalJson(checked.request) !== canonicalJson(grant.approvedRequest)) {
            throw new Error('cloud_create_recovery_invalid');
          }
          claimAttempted = true;
          try {
            dispatch.handle = await claimHmsLabtestDispatch(db, { workItemId: input.workItemId, transportId: input.transportId,
            actorUserId: input.actorUserId, grantId: grant.grantId, propertyCode: 'HRCEN', firstName: 'Proof', lastName: 'Labtest',
            nativeGuestId: grant.nativeGuestId, operation: 'create', stayId: input.stayId, sourceDigest: grant.sourceDigest,
            approvedDigest: grant.requestDigest, requestDigest: firstRequestDigest,
            recovery: { request: grant.approvedRequest, previewShot: grant.previewShot, ...recovery } }, async (tx, claim) => {
            try { await lockCreateSource(tx, key, async (lockedTx, source) => {
              const current = await checkSource(lockedTx, source, input, grant.accessId);
              const liveGrant = grantOf(source.item.state, input.stayId), stays = source.item.state.stays;
              const mode = paneStaySaveLoaders.mode?.() ?? paneStaySaveMode();
              if (claim.stayId !== input.stayId || !liveGrant || !sameGrant(liveGrant, input, previewDigest) ||
                  !matchesSource(current, grant) || !staysClear(source.item.state) || hasStay(source.item.state, input.stayId) ||
                  paneStayModeRefusal(mode, input.stay) || !paneCloudPreviewLoaders.authorityReady() ||
                  !await previewShotValid(grant, input)) throw new Error('cloud_create_dispatch_stale');
              await lockCreateActorSession(lockedTx, { actorUserId: input.actorUserId,
                sessionId: input.sessionId, sessionProfile: input.sessionProfile });
              if (!sameGrant(liveGrant, input, previewDigest) || Date.parse(recovery.preimage.expiresAt) <= Date.now()) {
                throw new Error('cloud_create_dispatch_stale');
              }
              const previews = { ...(source.item.state[PREVIEWS] as Record<string, unknown>) };
              delete previews[input.stayId];
              const state = { ...source.item.state, [PREVIEWS]: previews,
                stays: { ...(stays as Record<string, unknown> | undefined), [input.stayId]: {
                  status: 'unknown', confirmationNumber: null, screenshotRef: null, cloudCreateGrantId: grant.grantId } } };
              await lockedTx.update(workItem).set({ state, updatedAt: new Date() }).where(eq(workItem.id, input.workItemId));
            }); } catch (error) { authorizationError = error; throw error; }
            }, epoch);
          } catch (error) { claimError = error; throw error; }
          beforeSha256 = recovery.beforeShot.sha256;
          if (Date.parse(recovery.preimage.expiresAt) <= Date.now()) throw new Error('cloud_create_preimage_expired');
          // Commit is the authority boundary. Source/access changes after this
          // point cannot change the captured, already-approved native request.
          return await next();
        },
      });
      if (!dispatch.handle) return noClaimResult();
      const shots = beforeSha256 ? await saveScreenshots(native, input, beforeSha256) : null;
      const savedShot = shots?.shots.find((shot) => shot.name === 'saved.png');
      if (native.outcome !== 'saved' || native.writerSessionClosed !== true || native.save?.dispatchCallbacksDrained !== true ||
          typeof native.confirmation !== 'string' || !native.confirmation.trim() || !Array.isArray(native.readback?.fields) ||
          !Array.isArray(native.readback.mismatches) || native.readback.mismatches.length !== 0 || !shots || !savedShot) {
        return { ...refused(PANE_SAVE_UNCONFIRMED), ...shots };
      }
      const confirmationNumber = native.confirmation;
      await resolveHmsLabtestDispatch(db, dispatch.handle, { operation: 'create', confirmation: confirmationNumber,
        readbackDigest: hash(native.readback), savedShot: { runId: shots.runId, sha256: savedShot.sha256 } }, async (tx, intent) => {
        if (intent.workItemId !== input.workItemId || intent.transportId !== input.transportId ||
            intent.actorUserId !== input.actorUserId || intent.grantId !== grant.grantId || intent.stayId !== input.stayId ||
            intent.approvedDigest !== grant.requestDigest) throw new Error('cloud_create_result_scope_changed');
        await recordRecoveredCreate(tx, intent, { confirmation: confirmationNumber, readbackDigest: hash(native.readback),
          savedShot: { runId: shots.runId, sha256: savedShot.sha256 }, shots: shots.shots });
      });
      return { status: 'ok', outcome: 'committed', confirmationNumber, clickedSave: true, ...shots };
    }, acquisitionWithin(PANE_PROPERTY_LOCK_WAIT_MS));
  } catch (error) {
    if (claimAttempted) return noClaimResult();
    return refused(isPropertyReadLockDeadline(error) ? 'refused_lock_busy' : 'cloud_create_unavailable');
  }
}

const refs = z.object({ previewShot: grantSchema.shape.previewShot, beforeShot: grantSchema.shape.previewShot }).passthrough();

export type CreateRecoveryProof = { confirmation: string; readbackDigest: string;
  savedShot: { runId: string; sha256: string }; shots: HmsShotMeta[] };

/** Serialize against the same property operation lock as the original pane writer. */
export async function withRecoveryLock<T>(intent: HmsLabtestIntent, action: () => Promise<T>): Promise<T> {
  const target = paneStayCreateTarget({ transportId: intent.transportId, propertyCode: 'HRCEN' });
  if (!target.ok || target.target.propertyCode !== 'HRCEN' || target.target.browserSlot !== 'centurion') {
    throw new Error('cloud_create_recovery_property_unavailable');
  }
  const lock = paneStayPropertyLock(target.target);
  if (!lock) throw new Error('cloud_create_recovery_lock_unavailable');
  return lock.withLock(action, acquisitionWithin(PANE_PROPERTY_LOCK_WAIT_MS));
}

/** This uses the fixed read-only HMS reader, never caller-provided proof. */
export async function proveCreateRecovery(intent: HmsLabtestIntent): Promise<CreateRecoveryProof> {
  const parsed = refs.safeParse(intent.recovery);
  if (!parsed.success) throw new Error('cloud_create_recovery_evidence_unavailable');
  const owner = `${intent.actorUserId}:${intent.transportId}`;
  for (const [name, ref] of [['filled.png', parsed.data.previewShot], ['before.png', parsed.data.beforeShot]] as const) {
    if (!await verifyStoredHmsShot({ ...ref, name, owner, propertyCode: 'HRCEN', workItemId: intent.workItemId }, name)) {
      throw new Error('cloud_create_recovery_evidence_unavailable');
    }
  }
  const reader = await import(new URL('../../tooling/hms-cloud/create-positive-recovery.mjs', import.meta.url).href) as {
    provePositiveCreateRecovery: (intent: HmsLabtestIntent) => Promise<{
      outcome: string; confirmation?: unknown; readback?: unknown; screenshot?: unknown;
    }>;
  };
  const observed = await reader.provePositiveCreateRecovery(intent);
  if (observed.outcome !== 'verified' || typeof observed.confirmation !== 'string' ||
      !/^\d{6,10}-\d{1,2}$/.test(observed.confirmation) || !observed.readback ||
      !Buffer.isBuffer(observed.screenshot) || observed.screenshot.length > 20 * 1024 * 1024) {
    throw new Error('cloud_create_recovery_readback_unavailable');
  }
  const runId = randomUUID(), dir = await mkdtemp(join(tmpdir(), 'hms-create-recovery-'));
  try {
    await writeFile(join(dir, 'saved.png'), observed.screenshot, { flag: 'wx', mode: 0o600 });
    const shots = await persistHmsShots({ propertyCode: 'HRCEN', workItemId: intent.workItemId,
      runId, sourceDir: dir, owner, now: Date.now() });
    const saved = shots?.find((item) => item.name === 'saved.png');
    if (!shots || !saved || !await verifyStoredHmsShot({ runId, name: 'saved.png', sha256: saved.sha256,
      owner, propertyCode: 'HRCEN', workItemId: intent.workItemId }, 'saved.png')) {
      throw new Error('cloud_create_recovery_evidence_unavailable');
    }
    return { confirmation: observed.confirmation, readbackDigest: hash(observed.readback),
      savedShot: { runId, sha256: saved.sha256 }, shots };
  } finally { await rm(dir, { recursive: true, force: true }); }
}

/** Update only the original unknown stay and retain durable proof on the same transaction. */
export async function recordRecoveredCreate(tx: CreateFenceTransaction, intent: HmsLabtestIntent, proof: CreateRecoveryProof) {
  if (intent.operation !== 'create' || !intent.stayId) throw new Error('cloud_create_recovery_scope_changed');
  const [current] = await tx.select({ state: workItem.state }).from(workItem)
    .where(and(eq(workItem.id, intent.workItemId), eq(workItem.transportId, intent.transportId))).limit(1).for('update');
  if (!current) throw new Error('cloud_create_recovery_scope_changed');
  const stays = current.state.stays;
  if (!stays || typeof stays !== 'object' || Array.isArray(stays)) throw new Error('cloud_create_recovery_scope_changed');
  const stay = (stays as Record<string, unknown>)[intent.stayId] as Record<string, unknown> | undefined;
  if (!stay || stay.status !== 'unknown' || stay.cloudCreateGrantId !== intent.grantId) {
    throw new Error('cloud_create_recovery_scope_changed');
  }
  const state = { ...current.state, stays: { ...stays, [intent.stayId]: { status: 'booked',
    confirmationNumber: proof.confirmation, screenshotRef: { runId: proof.savedShot.runId, name: 'saved.png' },
    runId: proof.savedShot.runId, shots: proof.shots } } };
  await tx.update(workItem).set({ state, updatedAt: new Date() }).where(eq(workItem.id, intent.workItemId));
}
