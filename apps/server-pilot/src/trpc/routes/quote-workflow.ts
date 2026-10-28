import {
  loadSyncedQuoteSelectionFromMailbox,
  type SyncedQuoteSelection,
} from '../../ai/quote-workflow-synced-selection.js';
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
import { isNoReplyAddress } from '../../mail/conversation-signals.js';
import { recordStaffNote } from '../../ai/work-events.js';
import {
  loadStayCommit,
  recordStayCommit,
  stayCommitFromPaneResult,
  stayCommitGuard,
  workItemIdForMail,
} from '../../ai/work-items.js';
import { getDb } from '../../db/client.js';
import { mailboxProcedure, router } from '../trpc.js';
import { quotePaneConfigForProperty } from '../../hms/rate-catalogue.js';
import { quoteTargetForTransport } from '../../hms/hms-quote-target.js';
import { refuseProperty } from '../../hms/property-refusal.js';
import { resolvePropertyTransport } from '../../../tooling/playwright-quote/property-registry.mjs';
import { z } from 'zod';

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
    .regex(/^[A-Za-z0-9_-]{1,40}$/)
    .optional(),
  workItemId: z.string().uuid().optional(),
});

export type LoadSyncedSelection = (input: {
  transportId: string;
  internetMessageId?: string;
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
  candidate: ((input: { transportId: string; internetMessageId: string }) => Promise<VoucherCandidate | null>) | null;
  readText: ((files: QuoteAttachmentRow[], signal: AbortSignal) => Promise<SyncedQuoteAttachment[]>) | null;
} = {
  candidate: null,
  readText: null,
};

const voucherFindInput = z.object({ internetMessageId: z.string().min(1).max(998) });

/**
 * Only internetMessageId selects the mail. storeId, entryId and folderEntryId are
 * optional and unused, so the web preview can analyse a thread without Outlook ids.
 */
export const analyseSelectionInput = z.object({
  internetMessageId: z.string().optional(),
  storeId: z.string().optional(),
  entryId: z.string().optional(),
  folderEntryId: z.string().optional(),
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
        internetMessageId,
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
      if (note && internetMessageId) {
        const transportId = ctx.activeTransportId;
        const userId = ctx.sessionUser.id;
        void (async () => {
          const workItemId = await workItemIdForMail(getDb(), { transportId, internetMessageId });
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
    });
    if (!candidate) return { status: 'unsynced' };
    const files = candidate.attachments.filter((attachment) => !attachment.isInline);
    const voucher = isVoucherMail({
      subject: candidate.subject,
      bodyText: candidate.bodyText,
      attachmentNames: files.map((attachment) => attachment.filename),
    });
    if (!voucher) return { status: 'not_voucher' };
    const readable = voucherReadFiles(files);
    const texts = await (voucherLoaders.readText ?? readVoucherAttachmentText)(readable, AbortSignal.timeout(15_000));
    // A voucher PDF whose text was not read (over the reader's cap, scanned, or unreadable) is counted for the card.
    const withText = new Set(texts.filter((entry) => entry.text?.trim()).map((entry) => entry.id));
    return {
      status: 'voucher',
      messageId: candidate.messageId,
      threadId: candidate.threadId,
      guest: extractVoucherGuest({
        subject: candidate.subject,
        bodyText: candidate.bodyText,
        attachmentTexts: texts.map((text) => text.text ?? ''),
      }),
      file: pickVoucherFile(files),
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
    .use(({ ctx, next }) =>
      recordToolOutcome(
        () => ({
          kind: 'stay_preview',
          transportId: ctx.activeTransportId,
          messageId: null,
          userId: ctx.sessionUser.id,
        }),
        classifyStayPreview,
        next,
      ),
    )
    .mutation(async ({ input, ctx }) => {
    const { stayId, workItemId, ...stay } = input;
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
    .input(paneStayInput.extend({ previewDigest: z.string().regex(/^[0-9a-f]{64}$/) }))
    .use(({ input, ctx, next }) =>
      recordToolOutcome(
        () => ({
          kind: 'stay_commit',
          transportId: ctx.activeTransportId,
          messageId: null,
          userId: ctx.sessionUser.id,
        }),
        (value: PaneStayResult) => classifyStayCommit(value, input.previewDigest),
        next,
      ),
    )
    .mutation(async ({ input, ctx }) => {
      const { previewDigest, stayId, workItemId, ...stay } = input;
      const owner = `${ctx.sessionUser.id}:${ctx.activeTransportId}`;
      const previewPersist =
        workItemId && stayId
          ? createWorkItemPreviewPersist(getDb(), ctx.activeTransportId, PANE_PREVIEW_TTL_MS)
          : undefined;
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
