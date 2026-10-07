import {
  loadSyncedQuoteSelectionFromMailbox,
  type SyncedQuoteAttachment,
  type SyncedQuoteSelection,
} from '../../ai/quote-workflow-synced-selection.js';
import {
  analyseQuoteSelection,
  mapLlmDecision,
  quoteWorkflowLlmEnabled,
  QUOTE_WORKFLOW_PROMPT_VERSION,
  type QuoteTreatAs,
} from '../../ai/quote-workflow-llm.js';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAzureLunaModel, LunaModelAdapter } from '../../ai/bedrock/luna.js';
import { analyseQuoteSources } from '../../ai/quote-workflow-analyse.js';
import type { LunaAnalysis } from '../../ai/reservationist-decision.js';
import type { ModelAdapter } from '../../ai/bedrock/adapter.js';
import { runPaneStay } from '../../ai/pane-stay-save.js';
import { mailboxProcedure, router } from '../trpc.js';
import { z } from 'zod';

const paneStayInput = z.object({
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
  childAges: z.array(z.number().int()).max(16).optional(),
  propertyCode: z.string().min(1).optional(),
});

export type LoadSyncedSelection = (input: {
  transportId: string;
  internetMessageId?: string;
  entryId: string;
  storeId: string;
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
} = {
  loadSyncedSelection: null,
  adapter: null,
  llmEnabled: null,
  analyseCacheDir: null,
  promptVersion: null,
};

const DEFAULT_ANALYSE_CACHE_DIR = fileURLToPath(
  new URL('../../../.private/luna-analyse-cache', import.meta.url),
);

export function hashSyncedQuoteSelection(
  selection: SyncedQuoteSelection,
  extras?: { staffNote?: string },
): string {
  const hash = createHash('sha256');
  hash.update(selection.subject);
  hash.update('\0');
  hash.update(selection.bodyText);
  hash.update('\0');
  hash.update(selection.receivedAt ?? '');
  for (const message of selection.preceding) {
    hash.update('\0');
    hash.update(message.bodyText);
  }
  for (const attachment of selection.attachments) {
    hash.update('\0');
    hash.update(attachment.id);
    hash.update('\0');
    hash.update(attachment.filename);
    hash.update('\0');
    hash.update(attachment.text ?? '');
    hash.update('\0');
    hash.update(attachment.bytesPresent ? '1' : '0');
    if (attachment.pdf) hash.update(Buffer.from(attachment.pdf));
  }
  if (extras?.staffNote?.trim()) {
    hash.update('\0staffNote\n');
    hash.update(extras.staffNote.trim());
  }
  return hash.digest('hex');
}

function resolveAnalyseCacheDir(): string | null {
  if (quoteWorkflowLoaders.analyseCacheDir) return quoteWorkflowLoaders.analyseCacheDir;
  if (process.env.LUNA_ANALYSE_CACHE_DIR) return process.env.LUNA_ANALYSE_CACHE_DIR;
  if (process.env.VITEST) return null;
  return DEFAULT_ANALYSE_CACHE_DIR;
}

function analyseCachePath(input: {
  internetMessageId: string;
  sourceHash: string;
  promptVersion: string;
  cacheDir: string;
  treatAs?: QuoteTreatAs;
}): string {
  const id = input.internetMessageId.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80);
  const treat = input.treatAs ?? 'auto';
  return join(
    input.cacheDir,
    `${id}_${input.sourceHash.slice(0, 16)}_${input.promptVersion}_${treat}.json`,
  );
}

async function readAnalyseCache(path: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readFile(path, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function writeAnalyseCache(dir: string, path: string, payload: unknown): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(payload), { mode: 0o600 });
}

export const analyseSelectionInput = z.object({
  internetMessageId: z.string().optional(),
  storeId: z.string().min(1),
  entryId: z.string().min(1),
  folderEntryId: z.string().min(1),
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

function unreadAttachments(
  attachments: SyncedQuoteAttachment[],
  mode: 'bytes' | 'text' = 'bytes',
): SyncedQuoteAttachment[] {
  if (mode === 'text') {
    return attachments.filter((attachment) => !String(attachment.text ?? '').trim());
  }
  return attachments.filter((attachment) => !attachment.bytesPresent && !attachment.text);
}

function documentFailureItems(
  attachments: SyncedQuoteAttachment[],
  mode: 'bytes' | 'text' = 'bytes',
) {
  return unreadAttachments(attachments, mode).map((attachment) => ({
    id: `unread:${attachment.id}`,
    kind: 'document_failure' as const,
    rank: 'unread_source' as const,
    text: `Attachment ${attachment.filename} could not be read (${attachment.readFailure ?? 'unavailable'}). Review it manually.`,
    sourceLabel: attachment.filename,
    sourceRef: attachment.id,
    sourceKind: 'attachment' as const,
    filename: attachment.filename,
    reason: attachment.readFailure ?? 'Content unavailable; review the original attachment.',
    blocking: true as const,
  }));
}

function questionItems(missing: Array<{ field: string; question: string }>) {
  return missing.map((item, index) => ({
    id: `missing:${item.field}:${index}`,
    kind: 'question' as const,
    rank: 'secondary' as const,
    text: item.question,
    sourceLabel: item.field,
    blocking: false as const,
  }));
}

function resolveAdapter(enabled: boolean): { enabled: boolean; adapter: ModelAdapter | null } {
  if (!enabled) return { enabled: false, adapter: null };
  if (quoteWorkflowLoaders.adapter) {
    return { enabled: true, adapter: quoteWorkflowLoaders.adapter };
  }
  try {
    return {
      enabled: true,
      adapter: new LunaModelAdapter({
        model: createAzureLunaModel(),
        reasoningEffort: 'medium',
        routeId: 'azure_quote',
        modelId: 'gpt-6-luna',
        protocol: 'azure-openai-responses',
      }),
    };
  } catch {
    return { enabled: false, adapter: null };
  }
}

export const quoteWorkflowRouter = router({
  analyseSelection: mailboxProcedure
    .input(analyseSelectionInput)
    .mutation(async ({ input, ctx }) => {
      const loader =
        quoteWorkflowLoaders.loadSyncedSelection ?? loadSyncedQuoteSelectionFromMailbox;
      const synced = await loader({
        transportId: ctx.activeTransportId,
        internetMessageId: input.internetMessageId,
        entryId: input.entryId,
        storeId: input.storeId,
        signal: AbortSignal.timeout(15_000),
      });
      if (!synced) {
        return { status: 'unsynced' as const };
      }
      const cacheDir = resolveAnalyseCacheDir();
      const promptVersion =
        quoteWorkflowLoaders.promptVersion ?? QUOTE_WORKFLOW_PROMPT_VERSION;
      const cacheFile =
        input.internetMessageId && cacheDir
          ? analyseCachePath({
              internetMessageId: input.internetMessageId,
              sourceHash: hashSyncedQuoteSelection(synced, { staffNote: input.staffNote }),
              promptVersion,
              cacheDir,
              treatAs: input.treatAs,
            })
          : null;
      if (cacheFile) {
        const hit = await readAnalyseCache(cacheFile);
        if (hit && hit.status === 'ready') {
          return { ...hit, sourceRevision: input.selectionEpoch };
        }
      }
      const unread = unreadAttachments(synced.attachments);
      const attachmentReviews = documentFailureItems(synced.attachments);
      const requested = quoteWorkflowLoaders.llmEnabled?.() ?? quoteWorkflowLlmEnabled(process.env);
      const resolved = resolveAdapter(requested);
      const llm = await analyseQuoteSelection({
        selection: synced,
        adapter: resolved.adapter,
        enabled: resolved.enabled,
        deadlineMs: 25_000,
        treatAs: input.treatAs,
        staffNote: input.staffNote,
      });
      const payload =
        llm.source === 'luna'
          ? (() => {
              const flags: LunaAnalysis['flags'] = unread.length
                ? Array.from(new Set([...llm.analysis.flags, 'attachment_unread' as const]))
                : llm.analysis.flags;
              const luna: LunaAnalysis = {
                ...llm.analysis,
                flags,
                ...(input.treatAs ? { workflow: input.treatAs } : {}),
              };
              const mapped = mapLlmDecision(luna, { treatAs: input.treatAs });
              return {
                status: 'ready' as const,
                intent: mapped.intent,
                groups: mapped.groups,
                secondaryAsks: mapped.secondaryAsks,
                alternatives: mapped.alternatives,
                reviewItems: [...attachmentReviews, ...questionItems(mapped.missing)],
                source: 'luna' as const,
                aiUnavailable: false as const,
                luna,
                workflow: luna.workflow,
                sourceRevision: input.selectionEpoch,
              };
            })()
          : (() => {
              console.warn('quote_workflow_fallback', llm.fallbackReason);
              const analysis = analyseQuoteSources({
                subject: synced.subject,
                bodyText: synced.bodyText,
                preceding: synced.preceding,
                attachments: synced.attachments,
              });
              return {
                status: 'ready' as const,
                ...analysis,
                reviewItems: documentFailureItems(synced.attachments, 'text'),
                source: 'regex_fallback' as const,
                fallbackReason: llm.fallbackReason,
                aiUnavailable: true as const,
                luna: null,
                sourceRevision: input.selectionEpoch,
              };
            })();
      if (cacheFile && cacheDir) {
        await writeAnalyseCache(cacheDir, cacheFile, payload);
      }
      return payload;
    }),
  runStep: mailboxProcedure.input(runStepInput).mutation(async () => {
    return {
      status: 'integration_unavailable' as const,
      reason:
        'Live staff quote execution is workstation.executeStaffQuote. Do not call ai.enqueueHmsRead from this UI route.',
    };
  }),
  previewStay: mailboxProcedure.input(paneStayInput).mutation(async ({ input }) => {
    return runPaneStay({ mode: 'preview', stay: input });
  }),
  commitStay: mailboxProcedure.input(paneStayInput).mutation(async ({ input }) => {
    return runPaneStay({ mode: 'commit', stay: input });
  }),
});
