import { hydrateStoredWorkState } from '../../ai/stored-work-state.js';
import {
  loadSyncedQuoteSelectionFromMailbox,
  resolveThreadConfirmationEvidence,
  isHmsConfirmation,
  type SyncedQuoteSelection,
} from '../../ai/quote-workflow-synced-selection.js';
import { paneSourceContentHashSchema, paneSourceSelectionSchema, type PaneSourceSelection } from '../../mail/pane-source-selection.js';
import {
  quoteWorkflowLlmEnabled,
  QUOTE_WORKFLOW_PROMPT_VERSION,
} from '../../ai/quote-workflow-llm.js';
import {
  analyseSyncedSelection,
  canonicalInternetMessageId,
  resolveAnalyseCacheDir,
} from '../../ai/quote-workflow-analyse-selection.js';
import type { ModelAdapter } from '../../ai/bedrock/adapter.js';
import { resolveAgentRunRecorder, type AgentRunRecorder } from '../../ai/hitl-recorder.js';
import { classifyStayCommit, classifyStayPreview, recordToolOutcome } from '../../ai/hitl-tool-run.js';
import {
  extractVoucherGuest,
  isVoucherMail,
  loadVoucherCandidate,
  pickVoucherFile,
  readVoucherAttachmentText,
  readSelectedVoucherAttachment,
  voucherFileMetadata,
  voucherFilingFiles,
  voucherReadFiles,
  type VoucherCandidate,
  type VoucherFindReply,
} from '../../ai/voucher-find.js';
import type { QuoteAttachmentRow, SyncedQuoteAttachment } from '../../ai/quote-workflow-synced-selection.js';
import {
  PANE_BOOKER_EMAIL_MAX,
  PANE_BOOKER_NAME_MAX,
  PANE_MARKET_SEGMENT_MAX,
  PANE_PARTY_NAME_MAX,
  PANE_PARTY_NATIVE_ID_MAX,
  PANE_PREVIEW_TTL_MS,
  PANE_RESERVATION_NOTE_MAX,
  runPaneStay,
  type PaneStayResult,
} from '../../ai/pane-stay-save.js';
import { createWorkItemPreviewPersist } from '../../ai/pane-stay-preview-persist.js';
import { cloudPreviewSelection, commitPaneCloud, previewPaneCloud } from '../../ai/pane-cloud-preview.js';
import { isNoReplyAddress } from '../../mail/conversation-signals.js';
import { recordStaffNote } from '../../ai/work-events.js';
import {
  loadStayCommit,
  recordStayCommit,
  stayCommitFromPaneResult,
  stayCommitGuard,
  workItemIdForMail,
  formStays,
  requestPayload,
} from '../../ai/work-items.js';
import { getDb, type DB } from '../../db/client.js';
import { mailThread, message } from '../../db/schema/mail.js';
import { mailExtraction, workEvent, workItem } from '../../db/schema/work.js';
import { staffQuoteSourceHash } from '../../ai/staff-quote-workflow.js';
import { boundAmendRateRequest, boundSourceRateRequest, ratePartyBindingKey, ratePartyBindingSchema,
  ratePartySelectionSchema, type RateContext, type RatePartySelection } from '../../ai/hms-availability.js';
import { rateContextKey, recommendRateCandidate, orderRateCandidates, type RateCandidate, type RateRecommendation } from '../../ai/rate-options.js';
import { amendRequestId, projectAmendRequests } from '../../ai/pane-amend-draft.js';
import { safeParseStoredMailExtraction } from '../../ai/extraction/stored-mail-extraction.js';
import { hmsJobQueueEnabled, queueRateCandidatesHmsJob, readRateCandidatesHmsJob, readHmsJobView } from '../../ai/hms-jobs.js';
import type { HmsCloudRateLookup } from '../../ai/hms-cloud-saved-stay-find.js';
import { paneStayHmsTargetForTransport } from '../../ai/pane-stay-spawn-env.js';
import { loadPaneRateHistory } from '../../ai/pane-rate-recommendation.js';
import { withLockedCreateSourceForCreate as withLockedCreateSource } from '../../ai/pane-create-source-loader.js';
import { MANUAL_CREATE_KEY, manualCreatePayload } from '../../ai/manual-create-source.js';
import { assertNoCreateDispatchFence } from '../../ai/pane-create-dispatch-fence.js';
import { advancePaneRevision } from '../../ai/work-item-revision.js';
import { and, eq } from 'drizzle-orm';
import { mailboxProcedure, router } from '../trpc.js';
import { quotePaneConfigForProperty } from '../../hms/rate-catalogue.js';
import { quoteTargetForTransport } from '../../hms/hms-quote-target.js';
import { refuseProperty } from '../../hms/property-refusal.js';
import { resolvePropertyTransport } from '../../../tooling/playwright-quote/property-registry.mjs';
import { z } from 'zod';
import { TRPCError } from '@trpc/server';

export { hashSyncedQuoteSelection } from '../../ai/quote-workflow-analyse-selection.js';

const paneParty = z.object({
  nativeId: z.string().trim().min(1).max(PANE_PARTY_NATIVE_ID_MAX).optional(),
  name: z.string().trim().min(1).max(PANE_PARTY_NAME_MAX),
});

// A blank optional text is the same as no text: the runner never types it and the digest never counts it.
const paneOptionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((value) => value || undefined)
    .optional();

export const paneStayInput = z.object({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  arrival: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  departure: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  adults: z.number().int().min(0).max(16),
  sourceOfBusiness: z.string().min(1),
  roomType: z.string().min(1),
  ratePlan: z.string().min(1),
  track: z.string().min(1),
  guaranteeType: z.string().min(1),
  marketSegment: paneOptionalText(PANE_MARKET_SEGMENT_MAX),
  guestoptin4: z.boolean().optional(),
  childAges: z.array(z.number().int().min(0).max(17)).max(16).optional(),
  cmsMessageId: z.string().trim().min(1).max(8).optional(),
  propertyCode: z.string().min(1).optional(),
  bookingAgency: paneParty.extend({ id: z.string().trim().min(1).max(PANE_PARTY_NATIVE_ID_MAX).optional() }).refine((party) => !party.id || !party.nativeId || party.id === party.nativeId).optional(),
  organization: paneParty.optional(),
  reservationNote: paneOptionalText(PANE_RESERVATION_NOTE_MAX),
  bookerName: paneOptionalText(PANE_BOOKER_NAME_MAX),
  bookerEmail: paneOptionalText(PANE_BOOKER_EMAIL_MAX),
  confirmationSendMail: z.boolean().optional(),
  confirmationRecipient: z
    .object({
      mode: z.enum(['self', 'client', 'custom']),
      address: z
        .string()
        .trim()
        .min(1)
        .max(255)
        .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/),
    })
    .optional(),
  stayId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,120}$/)
    .optional(),
  workItemId: z.string().uuid().optional(),
  createSelection: cloudPreviewSelection.optional(),
});
const batchRoomInput = paneStayInput.extend({
  stayId: z.string().regex(/^[A-Za-z0-9_-]{1,120}$/), workItemId: z.string().uuid(),
  createSelection: cloudPreviewSelection, previewDigest: z.string().regex(/^[0-9a-f]{64}$/),
});
const paneCloudBatchInput = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('start'), id: z.string().uuid(), rooms: z.array(batchRoomInput).min(2).max(8) }).strict(),
  z.object({ kind: z.literal('continue'), id: z.string().uuid(), index: z.number().int().min(1).max(7) }).strict(),
]);

export type LoadSyncedSelection = (input: {
  transportId: string;
  userId?: string;
  contentHash?: string;
  internetMessageId?: string;
  selection?: PaneSourceSelection;
  entryId?: string;
  storeId?: string;
  signal?: AbortSignal;
}) => Promise<SyncedQuoteSelection | null>;

/**
 * Default mailbox reader uses getDb() + message/attachment tables.
 * Tests may replace this. Never enqueue HMS from this module.
 */
export const quoteWorkflowLoaders: {
  loadSyncedSelection: LoadSyncedSelection | null;
  adapter: ModelAdapter | null;
  llmEnabled: (() => boolean) | null;
  /** Tests set a temp dir. Production uses apps/server-pilot/.private/luna-analyse-cache. */
  analyseCacheDir: string | null;
  promptVersion: string | null;
  /** HITL ledger sink. Only read when HITL_LEDGER=on; production resolves the DB recorder. */
  agentRunRecorder: AgentRunRecorder | null;
} = {
  loadSyncedSelection: null,
  adapter: null,
  llmEnabled: null,
  analyseCacheDir: null,
  promptVersion: null,
  agentRunRecorder: null,
};

/** Test seams for the voucher route: the stored candidate and the PDF text reader. Null uses the real ones. */
export const voucherLoaders: {
  candidate: ((input: { transportId: string; internetMessageId: string; selection?: PaneSourceSelection }) => Promise<VoucherCandidate | null>) | null;
  readText: ((files: QuoteAttachmentRow[], signal: AbortSignal) => Promise<SyncedQuoteAttachment[]>) | null;
} = {
  candidate: null,
  readText: null,
};

const voucherFindInput = z.object({ internetMessageId: z.string().min(1).max(998),
  selection: paneSourceSelectionSchema.optional(), attachmentId: z.string().min(1).max(200).optional() });

const rateBinding = z.object({
  workItemId: z.string().uuid(),
  source: z.object({ threadId: z.string().trim().min(1).max(200), messageId: z.string().trim().min(1).max(200),
    sourceHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  request: z.object({ requestId: z.string().regex(/^[a-f0-9]{64}$/),
    stayId: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/), rowId: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/).nullable(),
    roomIndex: z.number().int().nonnegative().max(7).nullable() }).strict(),
  expectedSeq: z.number().int().nonnegative().safe(),
  expectedExtractionId: z.string().uuid().optional(),
}).strict();
export const rateCandidatesInput = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('start'), binding: rateBinding,
    typedRatePlan: z.string().regex(/^[A-Z0-9]{1,12}$/).optional(), forceRefresh: z.boolean().optional() }).strict(),
  z.object({ kind: z.literal('read'), binding: rateBinding, jobId: z.string().uuid() }).strict(),
]);
export const rateContextSelectionInput = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('read'), binding: rateBinding }).strict(),
  z.object({ kind: z.literal('select'), binding: rateBinding, selection: ratePartySelectionSchema }).strict(),
]);

async function selectedRateSource(db: DB, binding: z.infer<typeof rateBinding>, transportId: string) {
  const [selected] = await db.select({ item: workItem, mail: message, thread: mailThread, extraction: mailExtraction })
    .from(workItem)
    .innerJoin(message, and(eq(message.id, workItem.sourceMessageId), eq(message.transportId, workItem.transportId)))
    .innerJoin(mailThread, and(eq(mailThread.id, workItem.threadId), eq(mailThread.transportId, workItem.transportId)))
    .innerJoin(mailExtraction, and(eq(mailExtraction.id, workItem.extractionId), eq(mailExtraction.messageId, message.id)))
    .where(and(eq(workItem.id, binding.workItemId), eq(workItem.transportId, transportId),
      eq(message.id, binding.source.messageId), eq(mailThread.id, binding.source.threadId))).limit(1);
  if (!selected) return null;
  const manual = manualCreatePayload({ item: selected.item, extraction: selected.extraction, source: selected.mail });
  return selected.mail.threadId === binding.source.threadId && selected.mail.direction === 'inbound' &&
    !selected.mail.historyOnly && !selected.thread.historyOnly && selected.thread.trashedAt === null &&
    selected.mail.sourceProvenance?.attention == null &&
    (Object.hasOwn(selected.item.state, MANUAL_CREATE_KEY) ? Boolean(manual) : selected.extraction.status === 'succeeded') &&
    !['done', 'dismissed'].includes(selected.item.status) && selected.item.revisionSeq === binding.expectedSeq &&
    (binding.expectedExtractionId === undefined || selected.extraction.id === binding.expectedExtractionId) &&
    staffQuoteSourceHash(selected.mail) === binding.source.sourceHash ? { ...selected, payload: manual ?? selected.extraction.payload } : null;
}

function storedRatePartyBinding(state: Record<string, unknown>, binding: z.infer<typeof rateBinding>, extractionId: string, actorId: string) {
  const stored = state[ratePartyBindingKey(binding.request)];
  const record = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored as Record<string, unknown> : null;
  const selection = record?.selection && typeof record.selection === 'object' && !Array.isArray(record.selection)
    ? record.selection as Record<string, unknown> : null;
  const { agency, ...canonical } = selection ?? {};
  const hydrated = record && selection ? { ...record, selection: { ...canonical,
    ...(canonical.bookingAgency !== undefined || agency !== undefined ? { bookingAgency: Object.hasOwn(canonical, 'bookingAgency') ? canonical.bookingAgency : agency } : {}) } } : stored;
  const parsed = ratePartyBindingSchema.safeParse(hydrated);
  const parsedRecord = parsed.success ? parsed.data : null;
  return parsedRecord && parsedRecord.selectedBy === actorId && parsedRecord.extractionId === extractionId && parsedRecord.requestId === binding.request.requestId &&
    parsedRecord.stayId === binding.request.stayId && parsedRecord.rowId === binding.request.rowId &&
    parsedRecord.roomIndex === binding.request.roomIndex && parsedRecord.source.threadId === binding.source.threadId &&
    parsedRecord.source.messageId === binding.source.messageId && parsedRecord.source.sourceHash === binding.source.sourceHash ? parsedRecord : null;
}
export type RateCandidatesReply = {
  status: 'queued' | 'running' | 'ready' | 'blocked' | 'failed' | 'stale';
  requestId: string; jobId: string | null; contextKey: string | null; context: RateContext | null;
  observedAt: string | null; expiresAt: string | null;
  coverage: { candidateList: 'complete' | 'partial' | 'unknown'; reason: string | null };
  options: RateCandidate[]; recommendation: RateRecommendation | null;
  issues: Array<{ code: 'missing' | 'invalid' | 'conflict' | 'target_required' | 'not_checked' | 'unsupported' | 'identity_changed';
    fieldPath: string | null; message: string; blocksPrepare: boolean; blocksGo: boolean }>;
};

function rateRefusal(requestId: string, status: 'blocked' | 'failed' | 'stale', reason: string, message: string): RateCandidatesReply {
  return { status, requestId, jobId: null, contextKey: null, context: null, observedAt: null, expiresAt: null,
    coverage: { candidateList: 'unknown', reason }, options: [], recommendation: null,
    issues: [{ code: status === 'stale' ? 'identity_changed' : status === 'failed' ? 'not_checked' : 'unsupported',
      fieldPath: null, message, blocksPrepare: false, blocksGo: false }] };
}

/**
 * Selection narrows the RFC match to a verified web message or synced Outlook locator when available.
 */
export const analyseSelectionInput = z.object({
  internetMessageId: z.string().optional(),
  contentHash: paneSourceContentHashSchema.optional(),
  storeId: z.string().optional(),
  entryId: z.string().optional(),
  folderEntryId: z.string().optional(),
  selection: paneSourceSelectionSchema.optional(),
  selectionEpoch: z.number().int(),
  treatAs: z.enum(['quote', 'create_booking']).optional(),
  staffNote: z.string().max(4000).optional(),
});

export const runStepInput = z.object({
  stepId: z.string().min(1),
  selectionEpoch: z.number().int(),
  inputRevision: z.number().int(),
  inputs: z.record(z.unknown()),
});

export const quoteWorkflowRouter = router({
  searchCreateGuests: mailboxProcedure.input(z.object({
    binding: rateBinding, lastName: z.string().trim().min(1).max(PANE_BOOKER_NAME_MAX),
  }).strict()).mutation(async ({ input, ctx }) => {
    const db = getDb();
    const { binding } = input;
    const unavailable = { status: 'unavailable' as const, candidates: [], partial: false };
    const selected = await selectedRateSource(db, binding, ctx.activeTransportId);
    const target = paneStayHmsTargetForTransport(ctx.activeTransportId);
    if (!selected || !target.ok || target.target.propertyCode !== 'HRCEN') return unavailable;
    const parsed = safeParseStoredMailExtraction(selected.payload);
    if (!parsed.success || amendRequestId(binding.source, binding.request.stayId) !== binding.request.requestId ||
        binding.request.rowId === null || binding.request.roomIndex === null) return unavailable;
    const stay = formStays(parsed.data, hydrateStoredWorkState(selected.item.state)).find((item) => item.id === binding.request.stayId);
    const sourceStay = requestPayload(parsed.data, hydrateStoredWorkState(selected.item.state), selected.item.kind).stays
      .find((item) => item.id === binding.request.stayId);
    const action = sourceStay?.action ?? (parsed.data.stays.length === 1
      ? parsed.data.action ?? (selected.item.kind === 'booking' ? 'new_booking' : null) : null);
    if (!stay || !['new_booking', 'quote_availability'].includes(action ?? '') || !(stay.rows.some((row) => row.id === binding.request.rowId) ||
        (!stay.rows.length && binding.request.rowId === `${stay.id}_row`))) return unavailable;
    try {
      const tool = await import(new URL('../../../tooling/hms-cloud/booking-lookup-session.mjs', import.meta.url).href) as {
        withBookingLookupSession: (operation: (session: { runTool: (request: Record<string, unknown>) => Promise<unknown> }) => Promise<unknown>,
          options: { memory: null }) => Promise<unknown>;
      };
      const result = await tool.withBookingLookupSession(async ({ runTool }) => {
        const search = await runTool({ tool: 'searchGuestProfiles', field: 'lastName', query: input.lastName }) as {
          outcome?: string; searchId?: string; candidates?: unknown[]; hasMoreLoaded?: boolean;
          coverage?: { loaded?: number; possiblyTruncated?: boolean };
        };
        if (search.outcome !== 'matches' && search.outcome !== 'no_match') return null;
        let rows = search.candidates ?? [];
        const loaded = search.coverage?.loaded ?? rows.length;
        if (search.hasMoreLoaded && search.searchId) {
          rows = [];
          for (let offset = 0; offset < Math.min(loaded, 200); offset += 50) {
            const view = await runTool({ tool: 'inspectGuestProfileCandidates', searchId: search.searchId, offset, limit: 50 }) as
              { outcome?: string; candidates?: unknown[] };
            if (view.outcome !== 'current' || !Array.isArray(view.candidates)) return null;
            rows.push(...view.candidates);
          }
        }
        const candidates = rows.flatMap((row) => {
          if (!row || typeof row !== 'object') return [];
          const value = row as Record<string, unknown>;
          if (typeof value.nativeId !== 'string' || !/^\d+$/.test(value.nativeId) ||
              typeof value.firstName !== 'string' || typeof value.lastName !== 'string') return [];
          return [{ nativeId: value.nativeId, firstName: value.firstName, lastName: value.lastName,
            ...(typeof value.city === 'string' ? { city: value.city } : {}),
            ...(typeof value.country === 'string' ? { country: value.country } : {}) }];
        });
        return { candidates, partial: search.coverage?.possiblyTruncated !== false || loaded > 200 };
      }, { memory: null }) as { candidates: Array<{ nativeId: string; firstName: string; lastName: string; city?: string; country?: string }>;
        partial: boolean } | null;
      if (!result || !await selectedRateSource(db, binding, ctx.activeTransportId)) return unavailable;
      return { status: 'ready' as const, ...result };
    } catch { return unavailable; }
  }),

  rateContextSelection: mailboxProcedure.input(rateContextSelectionInput).mutation(async ({ input, ctx }) => {
    const { binding } = input;
    const db = getDb();
    const refuse = (status: 'blocked' | 'stale', reason: string) =>
      ({ status, reason, requestId: binding.request.requestId, selection: null });
    const selected = await selectedRateSource(db, binding, ctx.activeTransportId);
    if (!selected) return refuse('stale', 'SOURCE_OR_REVISION_CHANGED');
    const target = paneStayHmsTargetForTransport(ctx.activeTransportId);
    if (!target.ok || target.target.propertyCode !== 'HRCEN') return refuse('blocked', 'PROPERTY_CONTEXT_UNSUPPORTED');
    const parsed = safeParseStoredMailExtraction(selected.payload);
    if (!parsed.success || amendRequestId(binding.source, binding.request.stayId) !== binding.request.requestId) {
      return refuse('stale', 'REQUEST_IDENTITY_CHANGED');
    }
    const sourceStay = requestPayload(parsed.data, hydrateStoredWorkState(selected.item.state), selected.item.kind).stays.find(stay => stay.id === binding.request.stayId);
    const action = sourceStay?.action ?? (parsed.data.stays.length === 1
      ? parsed.data.action ?? (selected.item.kind === 'quote' ? 'quote_availability' : selected.item.kind === 'booking' ? 'new_booking' : null)
      : null);
    const workflow = action === 'quote_availability' ? 'quote' : action === 'new_booking' ? 'create' : null;
    const stay = formStays(parsed.data, hydrateStoredWorkState(selected.item.state)).find(stay => stay.id === binding.request.stayId);
    if (!workflow) return refuse('blocked', 'RATE_SELECTION_WORKFLOW_UNSUPPORTED');
    if (!stay || binding.request.rowId === null || !stay.rows.some(row => row.id === binding.request.rowId) ||
        (workflow === 'quote' ? binding.request.roomIndex !== null : binding.request.roomIndex === null)) {
      return refuse('stale', 'ROOM_IDENTITY_CHANGED');
    }
    const previous = storedRatePartyBinding(hydrateStoredWorkState(selected.item.state), binding, selected.extraction.id, ctx.sessionUser.id);
    if (input.kind === 'read') return { status: 'ready' as const, reason: previous ? null : 'RATE_PARTY_SELECTION_REQUIRED',
      requestId: binding.request.requestId, seq: selected.item.revisionSeq, selection: previous?.selection ?? null };
    if (input.selection.kind === 'selected') {
      for (const [kind, pick] of [['agency', input.selection.agency], ['company', input.selection.organization]] as const) {
        if (!pick) continue;
        const job = await readHmsJobView({ transportId: ctx.activeTransportId, runId: pick.jobId,
          threadId: binding.source.threadId, messageId: binding.source.messageId, sourceHash: binding.source.sourceHash,
          selectedActorId: ctx.sessionUser.id }, db);
        const at = job?.asOf ? Date.parse(job.asOf) : NaN;
        const rows = job?.result?.results;
        const nameKey = (name: string) => name.trim().replace(/\s+/g, ' ').toLowerCase();
        if (job?.status !== 'done' || job.request?.kind !== 'party' ||
            (job.request.partyKind && job.request.partyKind !== kind) || !Number.isFinite(at) || at > Date.now() ||
            Date.now() - at >= 5 * 60_000 || !Array.isArray(rows) || rows.filter(row => row && typeof row === 'object' &&
              row.kind === kind && row.nativeId === pick.nativeId && typeof row.name === 'string' &&
              nameKey(row.name) === nameKey(pick.name)).length !== 1) {
          return refuse('blocked', 'RATE_PARTY_JOB_UNVERIFIED');
        }
      }
    }
    try {
      return await withLockedCreateSource(db, { transportId: ctx.activeTransportId, threadId: binding.source.threadId,
        messageId: binding.source.messageId, workItemId: binding.workItemId,
        cursor: { extractionId: selected.extraction.id, revision: selected.item.revision,
          revisionHead: selected.item.revisionHead, seq: binding.expectedSeq } }, async (tx, current) => {
        if (staffQuoteSourceHash(current.snapshot.source) !== binding.source.sourceHash ||
            current.snapshot.source.sourceProvenance?.attention != null) return refuse('stale', 'SOURCE_OR_REVISION_CHANGED');
        await assertNoCreateDispatchFence(tx, { transportId: ctx.activeTransportId, workItemId: binding.workItemId });
        const existing = storedRatePartyBinding(current.item.state, binding, selected.extraction.id, ctx.sessionUser.id);
        const selection: RatePartySelection = { ...input.selection,
          ratePlan: Object.hasOwn(input.selection, 'ratePlan') ? input.selection.ratePlan : existing?.selection.ratePlan ?? null };
        if (existing && JSON.stringify(existing.selection) === JSON.stringify(selection)) {
          return { status: 'recorded' as const, reason: null, requestId: binding.request.requestId, selection: existing.selection,
            previousSeq: current.item.revisionSeq, seq: current.item.revisionSeq, revision: current.item.revision,
            revisionHead: current.item.revisionHead, workItemExtractionId: selected.extraction.id };
        }
        const record = ratePartyBindingSchema.parse({ version: 1, source: binding.source, extractionId: selected.extraction.id,
          ...binding.request, workflow, selectedBy: ctx.sessionUser.id, selectedAt: new Date().toISOString(), selection });
        const fieldPath = ratePartyBindingKey(binding.request);
        const state = { ...hydrateStoredWorkState(current.item.state), [fieldPath]: record };
        const advanced = advancePaneRevision({ revision: current.item.revision, revisionHead: current.item.revisionHead,
          seq: current.item.revisionSeq, previousState: current.item.state, nextState: state, extractionId: selected.extraction.id });
        await tx.insert(workEvent).values({ workItemId: binding.workItemId, actorKind: 'user', actorUserId: ctx.sessionUser.id,
          type: 'field.edit', fieldPath, value: record, evidence: { ...advanced.evidence, rateLookupOnly: true } });
        await tx.update(workItem).set({ state, revision: advanced.revision, revisionHead: advanced.revisionHead,
          revisionSeq: current.item.revisionSeq + 1, updatedAt: new Date() }).where(eq(workItem.id, binding.workItemId));
        return { status: 'recorded' as const, reason: null, requestId: binding.request.requestId, selection: record.selection,
          previousSeq: current.item.revisionSeq, seq: current.item.revisionSeq + 1, revision: advanced.revision,
          revisionHead: advanced.revisionHead, workItemExtractionId: selected.extraction.id };
      });
    } catch { return refuse('stale', 'RATE_SELECTION_CHANGED'); }
  }),
  rateCandidates: mailboxProcedure.input(rateCandidatesInput).mutation(async ({ input, ctx }): Promise<RateCandidatesReply> => {
    const { binding } = input;
    const db = getDb();
    const selected = await selectedRateSource(db, binding, ctx.activeTransportId);
    const requestId = binding.request.requestId;
    const refuse = (status: 'blocked' | 'failed' | 'stale', reason: string, message: string) =>
      rateRefusal(requestId, status, reason, message);
    if (!selected) return refuse('stale', 'SOURCE_OR_REVISION_CHANGED', 'This request has changed. Refresh the email.');
    const target = paneStayHmsTargetForTransport(ctx.activeTransportId);
    if (!target.ok || target.target.propertyCode !== 'HRCEN') return refuse('blocked', 'PROPERTY_CONTEXT_UNSUPPORTED', 'Rate lookup is not available for this hotel yet.');
    const payload = safeParseStoredMailExtraction(selected.payload);
    if (!payload.success || amendRequestId(binding.source, binding.request.stayId) !== requestId) {
      return refuse('stale', 'REQUEST_IDENTITY_CHANGED', 'This stay request has changed. Refresh the email.');
    }
    const state = hydrateStoredWorkState(selected.item.state);
    const stay = formStays(payload.data, state).find(stay => stay.id === binding.request.stayId);
    if (!stay || (binding.request.rowId !== null &&
        !stay.rows.some(row => row.id === binding.request.rowId))) {
      return refuse('stale', 'ROOM_IDENTITY_CHANGED', 'This room request has changed. Refresh the email.');
    }
    const sourceStay = requestPayload(payload.data, state, selected.item.kind).stays.find(stay => stay.id === binding.request.stayId);
    const action = sourceStay?.action ?? (payload.data.stays.length === 1
      ? payload.data.action ?? (selected.item.kind === 'quote' ? 'quote_availability' : selected.item.kind === 'booking' ? 'new_booking'
        : selected.item.kind === 'amendment' ? 'amend' : null) : null);
    const request = action === 'amend'
      ? projectAmendRequests(binding.source, payload.data, state).requests.find(request => request.requestId === requestId)
      : undefined;
    const row = stay.rows.find(row => row.id === binding.request.rowId) ?? stay.rows[0];
    let projected: ReturnType<typeof boundAmendRateRequest> | ReturnType<typeof boundSourceRateRequest>;
    if (request) {
      if (binding.request.roomIndex !== null || stay.rows.length > 1) return refuse('blocked', 'MULTI_ROOM_AMEND_CONTEXT_UNSUPPORTED', 'Choose one saved room before checking its rates.');
      const countPath = row ? `stays[${stay.id}].rows[${row.id}].count` : null;
      const count = countPath && Object.hasOwn(state, countPath) ? state[countPath] : row?.rooms;
      if ((count != null && count !== 1) || (countPath && Object.hasOwn(state, countPath) && count === null)) {
        return refuse('blocked', 'MULTI_ROOM_AMEND_CONTEXT_UNSUPPORTED', 'Rate lookup currently checks one saved room at a time.');
      }
      const savedTarget = request.fields.value.target as { confirmation?: unknown; arrival?: unknown } | null;
      if (!savedTarget || typeof savedTarget.confirmation !== 'string' || typeof savedTarget.arrival !== 'string') {
        return refuse('blocked', 'SAVED_TARGET_REQUIRED', 'Find the saved stay before checking rates.');
      }
      const saved = await readHmsJobView({ transportId: ctx.activeTransportId, threadId: binding.source.threadId,
        messageId: binding.source.messageId, sourceHash: binding.source.sourceHash, selectedActorId: ctx.sessionUser.id,
        kind: 'find', confirmation: savedTarget.confirmation, arrival: savedTarget.arrival }, db);
      const lookup = saved?.result?.rateLookup as HmsCloudRateLookup | undefined;
      const readTime = lookup?.observedAt ? Date.parse(lookup.observedAt) : NaN;
      if (!lookup || saved?.status !== 'done' || saved.result?.outcome !== 'found' ||
          !Number.isFinite(readTime) || readTime > Date.now() || Date.now() - readTime >= 5 * 60_000) {
        return refuse('blocked', 'SAVED_CONTEXT_READ_REQUIRED', 'Refresh the saved stay to verify its company, agency and room details.');
      }
      projected = boundAmendRateRequest({ propertyCode: target.target.propertyCode, requestId,
        stayId: binding.request.stayId, rowId: binding.request.rowId ?? row?.id ?? null,
        fields: { ...request.fields.value, adults: request.fields.value.adults ?? row?.adultsPerRoom ?? null },
        state, lookup, ...(input.kind === 'start' && input.typedRatePlan ? { typedRatePlan: input.typedRatePlan } : {}) });
    } else {
      const workflow = action === 'quote_availability' ? 'quote' : action === 'new_booking' ? 'create' : null;
      if (!workflow) return refuse('blocked', 'RATE_WORKFLOW_UNSUPPORTED', 'Rates can be checked for a quote, new booking or saved-stay amendment.');
      const party = storedRatePartyBinding(state, binding, selected.extraction.id, ctx.sessionUser.id);
      if (!party || party.workflow !== workflow) return refuse('blocked', 'RATE_PARTY_SELECTION_REQUIRED', 'Choose verified company or agency details, or explicitly choose no company or agency, before checking rates.');
      if (binding.request.rowId === null) return refuse('stale', 'ROOM_IDENTITY_CHANGED', 'Choose the current room request before checking rates.');
      projected = boundSourceRateRequest({ propertyCode: target.target.propertyCode, requestId, workflow, stay,
        rowId: binding.request.rowId, roomIndex: binding.request.roomIndex, state, selection: party.selection,
        sourceRowExists: Boolean(sourceStay?.rows.some(row => row.id === binding.request.rowId)),
        childAgeWarning: payload.data.missing.some(item => /child/i.test(`${item.field} ${item.question}`)),
        ...(input.kind === 'start' && input.typedRatePlan ? { typedRatePlan: input.typedRatePlan } : {}) });
    }
    if ('reason' in projected) return refuse('blocked', projected.reason, 'Complete the stay and verified company or agency details before checking rates. Prepare can still check the chosen rate.');
    const scope = { transportId: ctx.activeTransportId, threadId: binding.source.threadId,
      messageId: binding.source.messageId, sourceHash: binding.source.sourceHash, workItemId: binding.workItemId,
      requestId, userId: ctx.sessionUser.id, extractionId: selected.extraction.id,
      draftContextKey: projected.draftContextKey,
      roomBindingKey: JSON.stringify([binding.request.stayId, binding.request.rowId, binding.request.roomIndex]) };
    let runId: string;
    if (input.kind === 'start') {
      if (!hmsJobQueueEnabled()) return refuse('blocked', 'RATE_QUEUE_DISABLED', 'Rate lookup is not available right now. Prepare can still check the chosen rate.');
      runId = (await queueRateCandidatesHmsJob({ ...scope, request: projected.request,
        partyContextVerified: true, forceRefresh: input.forceRefresh }, db)).run.id;
    } else runId = input.jobId;
    const job = await readRateCandidatesHmsJob({ ...scope, runId }, db);
    if (!job || job.request?.kind !== 'availability' || !job.request.rateContext) {
      return refuse('stale', 'RATE_JOB_CONTEXT_CHANGED', 'The stay details changed. Check rates again.');
    }
    const context = { ...projected.request.rateContext!, typedRatePlan: job.request.rateContext.typedRatePlan };
    const contextKey = rateContextKey(context);
    if (rateContextKey(job.request.rateContext) !== contextKey) return refuse('stale', 'RATE_JOB_CONTEXT_CHANGED', 'The stay details changed. Check rates again.');
    const reply: RateCandidatesReply = { status: job.status === 'queued' || job.status === 'retrying' ? 'queued' : 'running',
      requestId, jobId: job.runId, contextKey, context, observedAt: null, expiresAt: null,
      coverage: { candidateList: 'unknown', reason: null }, options: [], recommendation: null, issues: [] };
    if (job.status === 'failed') return { ...refuse('failed', 'RATE_READ_FAILED', 'Rates could not be checked. Refresh to try again.'), jobId: runId, contextKey, context };
    if (job.status !== 'done') return reply;
    if (job.result?.outcome === 'blocked') return { ...refuse('blocked', String(job.result.error ?? 'NATIVE_CONTEXT_UNSUPPORTED'), 'HMS could not verify this rate context. Prepare can still check the chosen rate.'), jobId: runId, contextKey, context };
    if (job.result?.outcome !== 'read' || job.result.contextKey !== contextKey || !Array.isArray(job.result.rateCandidates)) {
      return { ...refuse('failed', 'RATE_RESULT_UNVERIFIED', 'HMS did not return verified rate observations.'), jobId: runId, contextKey, context };
    }
    const observedAt = typeof job.result.observedAt === 'string' ? job.result.observedAt : null;
    const observed = observedAt ? Date.parse(observedAt) : NaN;
    if (!Number.isFinite(observed) || observed > Date.now() || Date.now() - observed >= 5 * 60_000) {
      return { ...refuse('stale', 'RATE_OBSERVATION_EXPIRED', 'These rate observations have expired. Check rates again.'), jobId: runId, contextKey, context };
    }
    const history = await loadPaneRateHistory(context, db, selected.mail.receivedAt);
    const options = orderRateCandidates(context, job.result.rateCandidates as RateCandidate[], history);
    const coverage = job.result.coverage as { candidateList?: 'complete' | 'partial' | 'unknown'; reason?: string | null } | undefined;
    return { ...reply, status: 'ready', observedAt, expiresAt: new Date(observed + 5 * 60_000).toISOString(),
      coverage: { candidateList: coverage?.candidateList ?? 'unknown', reason: coverage?.reason ?? null }, options,
      recommendation: recommendRateCandidate({ ...context, typedRatePlan: projected.explicitCode ?? context.typedRatePlan }, options, projected.unchangedCode, history),
      issues: [{ code: 'not_checked', fieldPath: null,
        message: 'Nightly prices are observations. Prepare checks the chosen rate, full stay and retained pricing.',
        blocksPrepare: false, blocksGo: false }, ...history.issues.map(reason => ({ code: 'not_checked' as const,
          fieldPath: null, message: reason === 'NO_NATIVE_ID_BOUND_RATE_HISTORY'
            ? 'No rate history is linked to these native company and agency IDs.' : 'Some rate history is unavailable; native rate observations are still shown.',
          blocksPrepare: false, blocksGo: false }))] };
  }),
  rateCatalogue: mailboxProcedure.query(async ({ ctx }) => {
    const resolved = resolvePropertyTransport(ctx.activeTransportId);
    if (resolved.kind === 'collector') {
      refuseProperty({ code: 'collector_no_hotel', transportId: resolved.transportId });
    }
    if (resolved.kind === 'refusal') refuseProperty(resolved);
    const config = await quotePaneConfigForProperty(resolved.property.propertyCode, resolved.transportId);
    if (!config) refuseProperty({ code: 'not_set_up', transportId: resolved.transportId });
    return config;
  }),
  /** Server-backed Make quote: DV mailboxes only when HMS_DAVINCI_MAKE_QUOTE=on. Writes stay ungated here. */
  makeQuote: mailboxProcedure.query(({ ctx }) => {
    const resolved = quoteTargetForTransport(ctx.activeTransportId);
    return {
      makeQuote: resolved.ok,
      propertyCode: resolved.ok ? resolved.target.propertyCode : null,
    };
  }),
  analyseSelection: mailboxProcedure
    .input(analyseSelectionInput)
    .mutation(async ({ input, ctx }) => {
      // One canonical id for the loader's exact match and for the cache key.
      const internetMessageId = canonicalInternetMessageId(input.internetMessageId) ?? undefined;
      const loader =
        quoteWorkflowLoaders.loadSyncedSelection ?? loadSyncedQuoteSelectionFromMailbox;
      const synced = await loader({
        transportId: ctx.activeTransportId,
        userId: ctx.sessionUser.id,
        contentHash: input.contentHash,
        internetMessageId,
        ...(input.selection ? { selection: input.selection } : {}),
        entryId: input.entryId,
        storeId: input.storeId,
        signal: AbortSignal.timeout(15_000),
      });
      if (!synced) {
        return { status: 'unsynced' as const };
      }
      const { payload, outcome } = await analyseSyncedSelection(synced, {
        internetMessageId,
        treatAs: input.treatAs,
        staffNote: input.staffNote,
        selectionEpoch: input.selectionEpoch,
        cacheDir: resolveAnalyseCacheDir(quoteWorkflowLoaders.analyseCacheDir),
        transportId: ctx.activeTransportId,
        promptVersion: quoteWorkflowLoaders.promptVersion ?? QUOTE_WORKFLOW_PROMPT_VERSION,
        adapter: quoteWorkflowLoaders.adapter,
        llmEnabled: () =>
          quoteWorkflowLoaders.llmEnabled?.() ?? quoteWorkflowLlmEnabled(process.env),
        recorder: resolveAgentRunRecorder(process.env, quoteWorkflowLoaders.agentRunRecorder),
        recordAs: { trigger: 'pane', userId: ctx.sessionUser.id },
      });
      if (outcome.kind === 'fallback') {
        console.warn('quote_workflow_fallback', outcome.reason);
      }
      // The "Tell Nava" text is kept masked on the mail's work item (v5 B2). Best effort and not awaited: a slow database
      // never holds the answer, and a note that fails to save is logged, not thrown.
      const note = input.staffNote?.trim();
      const messageId = synced.messageId;
      const threadId = synced.threadId;
      if (note && internetMessageId && (!input.selection || messageId)) {
        const transportId = ctx.activeTransportId;
        const userId = ctx.sessionUser.id;
        void (async () => {
          const workItemId = await workItemIdForMail(getDb(), { transportId, internetMessageId,
            selection: messageId && threadId ? { kind: 'web', messageId, threadId } : input.selection,
            expectedMessageId: messageId });
          if (workItemId) await recordStaffNote(getDb(), { workItemId, userId, note });
        })().catch((error: unknown) => {
          console.warn('staff_note_not_kept', error instanceof Error ? error.message : 'unknown');
        });
      }
      // The sender decides whether staff can answer, so the pane hides Insert draft for an automated one. Read per request.
      return { ...payload, noReplySender: isNoReplyAddress(synced.fromAddress) };
    }),
  // Read-only. Voucher or POP mail gets the guest surname and arrival read from its text, and the file to save. The
  // stored subject and body decide it, so an ordinary email reads no attachment bytes. Nothing is booked or changed.
  voucherFind: mailboxProcedure.input(voucherFindInput).query(async ({ input, ctx }): Promise<VoucherFindReply> => {
    const internetMessageId = canonicalInternetMessageId(input.internetMessageId);
    if (!internetMessageId) return { status: 'unsynced' };
    const candidate = await (voucherLoaders.candidate ?? loadVoucherCandidate)({
      transportId: ctx.activeTransportId,
      internetMessageId,
      ...(input.selection ? { selection: input.selection } : {}),
    });
    if (!candidate) return { status: 'unsynced' };
    const files = candidate.attachments.filter((attachment) => !attachment.isInline);
    const voucher = isVoucherMail({
      subject: candidate.subject,
      bodyText: candidate.bodyText,
      attachmentNames: files.map((attachment) => attachment.filename),
    });
    if (!voucher) return { status: 'not_voucher' };
    const filingFiles = voucherFilingFiles(files);
    const selected = input.attachmentId ? filingFiles.find((file) => file.id === input.attachmentId) : undefined;
    if (input.attachmentId && !selected) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'The selected PDF is unavailable for this email.' });
    }
    // Once staff select a file, only that file supplies voucher facts. Never
    // let another attachment's text determine where this file is filed.
    const readable = selected ? [selected] : voucherReadFiles(files);
    const signal = AbortSignal.timeout(15_000);
    const scope = {
          transportId: ctx.activeTransportId, messageId: candidate.messageId, internetMessageId,
          ...(input.selection ? { selection: input.selection } : {}),
        };
    const selectedRead = selected && !voucherLoaders.readText
      ? await readSelectedVoucherAttachment(selected, signal, scope) : null;
    const target = paneStayHmsTargetForTransport(ctx.activeTransportId);
    if (selected && !voucherLoaders.readText && !selectedRead && target.ok && target.target.propertyCode === 'HRCEN') {
      throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'The selected PDF changed or is unavailable.' });
    }
    const texts = voucherLoaders.readText ? await voucherLoaders.readText(readable, signal)
      : selectedRead ? selectedRead.texts : await readVoucherAttachmentText(readable, signal, scope);
    const confirmation = resolveThreadConfirmationEvidence([
      { filename: '', text: `${candidate.subject}\n${candidate.bodyText}` },
      ...texts.map((entry) => ({ filename: '', text: entry.text })),
    ]).confirmation;
    // A voucher PDF whose text was not read (over the reader's cap, scanned, or unreadable) is counted for the card.
    const withText = new Set(texts.filter((entry) => entry.text?.trim()).map((entry) => entry.id));
    return {
      status: 'voucher',
      messageId: candidate.messageId,
      threadId: candidate.threadId,
      guest: { ...extractVoucherGuest({
        subject: candidate.subject,
        bodyText: candidate.bodyText,
        attachmentTexts: texts.map((text) => text.text ?? ''),
      }), ...(confirmation && isHmsConfirmation(confirmation) ? { confirmationNumber: confirmation } : {}) },
      file: selected ? voucherFileMetadata(selected) : pickVoucherFile(files),
      files: filingFiles.map(voucherFileMetadata),
      ...(selectedRead ? { documentSource: selectedRead.source } : {}),
      unreadPdfs: readable.filter((file) => !withText.has(file.id)).length,
    };
  }),
  runStep: mailboxProcedure.input(runStepInput).mutation(async () => {
    return {
      status: 'integration_unavailable' as const,
      reason:
        'Live staff quote execution is workstation.executeStaffQuote. Do not call ai.enqueueHmsRead from this UI route.',
    };
  }),
  previewStay: mailboxProcedure
    .input(paneStayInput)
    .use(({ input, ctx, next }) =>
      recordToolOutcome(
        () => ({
          kind: 'stay_preview',
          transportId: ctx.activeTransportId,
          messageId: input.createSelection?.source.messageId ?? null,
          userId: ctx.sessionUser.id,
        }),
        classifyStayPreview,
        next,
      ),
    )
    .mutation(async ({ input, ctx }) => {
    const { stayId, workItemId, createSelection, confirmationSendMail, ...stay } = input;
    const target = resolvePropertyTransport(ctx.activeTransportId);
    if (target.kind === 'property' && target.property.propertyCode === 'HRCEN') {
      if (!workItemId || !stayId || !createSelection) return { status: 'refused' as const, reason: 'pane_preview_binding_required' };
      return previewPaneCloud(getDb(), { transportId: ctx.activeTransportId, mailboxAddress: ctx.transportEmail,
        actorUserId: ctx.sessionUser.id, sessionId: ctx.sessionUser.sessionId, sessionProfile: ctx.sessionUser.sessionProfile,
        workItemId, stayId, selection: createSelection, stay: { ...stay, confirmationSendMail } });
    }
    const owner = `${ctx.sessionUser.id}:${ctx.activeTransportId}`;
    const previewPersist =
      workItemId && stayId
        ? createWorkItemPreviewPersist(getDb(), ctx.activeTransportId, PANE_PREVIEW_TTL_MS)
        : undefined;
    return runPaneStay({
      mode: 'preview',
      stay,
      owner,
      workItemId,
      stayId,
      previewPersist,
    });
  }),
  commitStay: mailboxProcedure
    .input(
      paneStayInput.extend({
        previewDigest: z.string().regex(/^[0-9a-f]{64}$/),
        // Rooms 2+ of one booking name room 1's stay; the server reads its confirmation from this work item.
        parentStayId: z.string().trim().min(1).max(200).optional(),
        batch: paneCloudBatchInput.optional(),
      }),
    )
    .use(({ input, ctx, next }) =>
      recordToolOutcome(
        () => ({
          kind: 'stay_commit',
          transportId: ctx.activeTransportId,
          messageId: input.createSelection?.source.messageId ?? null,
          userId: ctx.sessionUser.id,
        }),
        (value: PaneStayResult) => classifyStayCommit(value, input.previewDigest),
        next,
      ),
    )
    .mutation(async ({ input, ctx }) => {
      const { previewDigest, stayId, workItemId, parentStayId, createSelection, confirmationSendMail, batch, ...stay } = input;
      const target = resolvePropertyTransport(ctx.activeTransportId);
      if (target.kind === 'property' && target.property.propertyCode === 'HRCEN') {
        if (!workItemId || !stayId || !createSelection) return { status: 'refused' as const, reason: 'pane_preview_binding_required' };
        if (parentStayId) return { status: 'refused' as const, reason: 'pane_save_parent_unsupported' };
        if (batch?.kind === 'start' && batch.rooms.some((room) => room.workItemId !== workItemId)) {
          return { status: 'refused' as const, reason: 'pane_preview_binding_required' };
        }
        const cloudBatch = batch?.kind === 'start' ? { ...batch, rooms: batch.rooms.map((room) => {
          const { stayId: roomId, workItemId: _workItemId, createSelection: selection, previewDigest: roomDigest, ...roomStay } = room;
          return { stayId: roomId, selection, previewDigest: roomDigest, stay: roomStay };
        }) } : batch;
        return commitPaneCloud(getDb(), { transportId: ctx.activeTransportId, mailboxAddress: ctx.transportEmail,
          actorUserId: ctx.sessionUser.id, sessionId: ctx.sessionUser.sessionId, sessionProfile: ctx.sessionUser.sessionProfile,
          workItemId, stayId, selection: createSelection, stay: { ...stay, confirmationSendMail }, batch: cloudBatch }, previewDigest);
      }
      if (batch) return { status: 'refused' as const, reason: 'pane_batch_property_unsupported' };
      const owner = `${ctx.sessionUser.id}:${ctx.activeTransportId}`;
      const previewPersist =
        workItemId && stayId
          ? createWorkItemPreviewPersist(getDb(), ctx.activeTransportId, PANE_PREVIEW_TTL_MS)
          : undefined;
      let parentConfirmation: string | undefined;
      if (parentStayId) {
        const parent =
          workItemId && stayId && parentStayId !== stayId
            ? await loadStayCommit(getDb(), { transportId: ctx.activeTransportId, workItemId, stayId: parentStayId })
            : undefined;
        if (!parent?.confirmationNumber || parent.status !== 'booked') {
          return { status: 'refused' as const, reason: 'pane_save_parent_not_booked' };
        }
        parentConfirmation = parent.confirmationNumber;
      }
      if (workItemId && stayId) {
        const existing = await loadStayCommit(getDb(), {
          transportId: ctx.activeTransportId,
          workItemId,
          stayId,
        });
        const guard = stayCommitGuard(existing);
        if (guard.action === 'refuse') {
          return { status: 'refused' as const, reason: guard.reason };
        }
      }
      const result = await runPaneStay({
        mode: 'commit',
        stay,
        previewDigest,
        owner,
        workItemId,
        stayId,
        previewPersist,
        ...(parentConfirmation ? { parentConfirmation } : {}),
      });
      if (workItemId && stayId) {
        const record = stayCommitFromPaneResult(result);
        if (record) {
          try {
            await recordStayCommit(getDb(), {
              transportId: ctx.activeTransportId,
              workItemId,
              stayId,
              record,
            });
          } catch (error) {
            console.warn('stay_commit_persist_failed', { stayId, workItemId, error });
          }
        }
      }
      return result;
    }),
});
