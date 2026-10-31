import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ModelAdapter } from './bedrock/adapter.js';
import { createAzureLunaModel, LunaModelAdapter } from './bedrock/luna.js';
import type { LunaAnalysis } from './reservationist-decision.js';
import { analyseQuoteSources, type QuoteWorkflowAnalysis } from './quote-workflow-analyse.js';
import {
  buildCreatePrefill,
  DIRECT_BOOKING_DEFAULTS,
  type BuildCreatePrefillOutput,
} from './aop/create-prefill.js';
import {
  buildHmsTodoCard,
  extractBillingAskKind,
  extractPopFacts,
  type HmsTodoCardInput,
} from './hms-todo-card.js';
import {
  amendmentFromAnalysis,
  mapLlmDecision,
  type MappedQuoteDecision,
  type QuoteTreatAs,
  type QuoteWorkflowFallbackReason,
  type QuoteWorkflowTelemetry,
} from './quote-workflow-llm.js';
import { analyseWithPaneBrain } from './pane-brain.js';
import {
  analyseInputKey,
  recordAgentRunCapped,
  type AgentRunDraft,
  type AgentRunRecorder,
  type AgentRunTrigger,
} from './hitl-recorder.js';
import { canonicalMessageId } from '../mail/ingest/message-id.js';
import {
  applyThreadConfirmationOverlay,
  type OverlayPayload,
  type SyncedQuoteAttachment,
  type SyncedQuoteSelection,
} from './quote-workflow-synced-selection.js';
import { attachmentMattersForReview, unreadReasonWords } from './quote-attachment-review.js';
import { stayDateSourceText, stayDateYearEvidenceText } from './stay-date-anchoring.js';
import { aopQuoteChannelFromSender } from './aop-playbook.js';
import { resolvePropertyTransport } from '../../tooling/playwright-quote/property-registry.mjs';

/**
 * Luna analyse of a synced mail, shared by the pane route and the inbound
 * warmer. Both must read and write the same cache file for the same mail, so
 * the cache key, the default directory and the post-loader body live only here.
 */

/** Default cache dir: apps/server-pilot/.private/luna-analyse-cache from src/ai or dist/ai. */
export function defaultAnalyseCacheDirFor(moduleUrl: string): string {
  return fileURLToPath(new URL('../../.private/luna-analyse-cache', moduleUrl));
}

const DEFAULT_ANALYSE_CACHE_DIR = defaultAnalyseCacheDirFor(import.meta.url);

/** Explicit override, then LUNA_ANALYSE_CACHE_DIR, then the default (off under vitest). */
export function resolveAnalyseCacheDir(override: string | null): string | null {
  if (override) return override;
  if (process.env.LUNA_ANALYSE_CACHE_DIR) return process.env.LUNA_ANALYSE_CACHE_DIR;
  if (process.env.VITEST) return null;
  return DEFAULT_ANALYSE_CACHE_DIR;
}

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

/**
 * Same normalisation the ingest writes to message.messageIdHeader (strip <>, unquote,
 * lowercase). The pane's raw id, the warmer's stored header and the synced loader's
 * exact match then meet on one key. Null when the id is empty.
 */
export function canonicalInternetMessageId(raw: string | null | undefined): string | null {
  return canonicalMessageId(raw?.trim());
}

export function analyseCachePath(input: {
  internetMessageId: string;
  sourceHash: string;
  promptVersion: string;
  cacheDir: string;
  treatAs?: QuoteTreatAs;
  /** The mailbox transport. The same mail under another transport is another cache entry. */
  transportId: string;
}): string {
  const canonical = canonicalInternetMessageId(input.internetMessageId) ?? input.internetMessageId;
  const id = canonical.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80);
  const treat = input.treatAs ?? 'auto';
  const transport = createHash('sha256').update(input.transportId).digest('hex').slice(0, 12);
  return join(
    input.cacheDir,
    `${transport}_${id}_${input.sourceHash.slice(0, 16)}_${input.promptVersion}_${treat}.json`,
  );
}

/** A cache entry and when it was written. The write time bounds the origin lookup for entries that name no run. */
export async function readAnalyseCacheEntry(
  path: string,
): Promise<{ payload: Record<string, unknown>; writtenAt: Date } | null> {
  try {
    const writtenAt = (await stat(path)).mtime;
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return { payload: parsed as Record<string, unknown>, writtenAt };
  } catch {
    return null;
  }
}

export async function readAnalyseCache(path: string): Promise<Record<string, unknown> | null> {
  return (await readAnalyseCacheEntry(path))?.payload ?? null;
}

/** Only a Luna-ready entry is reused; regex fallback is never cached. */
export function isReusableAnalyseCache(hit: Record<string, unknown> | null): boolean {
  return Boolean(hit && hit.status === 'ready' && hit.source === 'luna');
}

async function writeAnalyseCache(dir: string, path: string, payload: unknown): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(payload), { mode: 0o600 });
}

function unreadAttachments(
  attachments: SyncedQuoteAttachment[],
  mode: 'bytes' | 'text' = 'bytes',
): SyncedQuoteAttachment[] {
  const unread =
    mode === 'text'
      ? attachments.filter((attachment) => !String(attachment.text ?? '').trim())
      : attachments.filter((attachment) => !attachment.bytesPresent && !attachment.text);
  // Only files that may hold a booking count, so one unread signature never raises a row or the banner.
  return unread.filter((attachment) =>
    attachmentMattersForReview({
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      byteSize: attachment.byteSize,
    }),
  );
}

/** A readable attachment can still need a staff review when ambiguous number groups were masked. */
export function numberGroupReviewItems(
  attachments: Array<Pick<SyncedQuoteAttachment, 'id' | 'filename' | 'mimeType' | 'byteSize'> & {
    readFailure?: string;
    reviewReason?: string;
  }>,
) {
  return attachments
    .filter((attachment) =>
      attachment.readFailure === 'ambiguous number groups' || attachment.reviewReason === 'ambiguous number groups',
    )
    .filter((attachment) => attachmentMattersForReview({
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      byteSize: attachment.byteSize,
    }))
    .map((attachment) => ({
      id: `number-review:${attachment.id}`,
      kind: 'document_failure' as const,
      rank: 'unread_source' as const,
      text: 'Some number groups may be room numbers or card details. Check the original source.',
      sourceLabel: attachment.filename,
      sourceRef: attachment.id,
      sourceKind: 'attachment' as const,
      filename: attachment.filename,
      blocking: false as const,
    }));
}

/** One item per unread source, plus a staff warning when card-like number groups were masked. */
export function documentFailureItems(
  attachments: SyncedQuoteAttachment[],
  mode: 'bytes' | 'text' = 'bytes',
) {
  const unread = unreadAttachments(attachments, mode).map((attachment) => {
    const words = unreadReasonWords(attachment.readFailure);
    return {
      id: `unread:${attachment.id}`,
      kind: 'document_failure' as const,
      rank: 'unread_source' as const,
      text: `Nava can't read ${attachment.filename}${words ? ` (${words})` : ''} — open it if it has booking details.`,
      sourceLabel: attachment.filename,
      sourceRef: attachment.id,
      sourceKind: 'attachment' as const,
      filename: attachment.filename,
      ...(words ? {} : { reason: attachment.readFailure ?? 'Content unavailable; review the original attachment.' }),
      // Needs review, never a stop: the quote can still run without an unread file.
      blocking: false as const,
    };
  });
  return [...unread, ...numberGroupReviewItems(attachments)];
}

export function questionItems(missing: Array<{ field: string; question: string }>) {
  return missing.map((item, index) => ({
    id: `missing:${item.field}:${index}`,
    kind: 'question' as const,
    rank: 'secondary' as const,
    text: item.question,
    sourceLabel: item.field,
    blocking: false as const,
  }));
}

/**
 * Luna-shaped carrier for a staff override on the regex fallback. The pane reads the
 * booking choice from luna.workflow (as on the Luna path), so this must pass
 * lunaAnalysisSchema for the server booking-draft calls that echo it back.
 */
function fallbackLunaCarrier(treatAs: QuoteTreatAs, analysis: QuoteWorkflowAnalysis): LunaAnalysis {
  return {
    workflow: treatAs,
    flags: [],
    groups: analysis.groups.map((group) => ({
      arrival: group.arrivalDate ?? null,
      departure: group.departureDate ?? null,
      dateEvidence: null,
      rooms: group.quantity ?? null,
      adultsPerRoom: group.adults ?? null,
      childAges: [...group.childrenAges],
      board: group.board === 'unknown' ? null : group.board === 'dinner_bb' ? 'dbb' : group.board,
      roomPreference: null,
      guestNames: [],
    })),
    party: { kind: null, name: null, reference: null },
    rateClaims: [],
    missing: [],
    evidence: [],
    tasks: [
      {
        kind: treatAs,
        groupIndexes: analysis.groups.map((_, index) => index),
        note: 'Staff override on the regex fallback.',
      },
    ],
  };
}

const LUNA_UNAVAILABLE_ITEM = {
  id: 'luna-unavailable',
  kind: 'question' as const,
  rank: 'secondary' as const,
  text: 'Nava is unavailable, so the stay details come from the email text. Check the dates and room count below. Edit the room count directly, since a note cannot change it. A note can still correct dates and adults.',
  sourceLabel: 'Selected message',
  blocking: false as const,
};

export function resolveAdapter(
  enabled: boolean,
  injected: ModelAdapter | null | undefined,
): { enabled: boolean; adapter: ModelAdapter | null } {
  if (!enabled) return { enabled: false, adapter: null };
  if (injected) return { enabled: true, adapter: injected };
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

export type AnalyseSyncedOptions = {
  /** Canonical RFC Message-ID for the cache key. Absent means no cache. */
  internetMessageId?: string;
  treatAs?: QuoteTreatAs;
  staffNote?: string;
  selectionEpoch: number;
  cacheDir: string | null;
  promptVersion: string;
  /** The mailbox transport, part of the cache key. The pane and the warmer must pass the same one. */
  transportId: string;
  /** Injected model seam. Absent or null means the production Luna adapter when enabled. */
  adapter?: ModelAdapter | null;
  /** Read only after a cache miss, so a cache hit never touches the flag or env. */
  llmEnabled: () => boolean;
  /** Ledger seam. Absent or null records nothing (HITL_LEDGER off). */
  recorder?: AgentRunRecorder | null;
  /** Stamped on each run. Only pane runs carry a session user and open an episode. */
  recordAs?: { trigger: AgentRunTrigger; userId: string | null };
};

export type AnalyseSyncedOutcome =
  | { kind: 'cache_hit' }
  | { kind: 'luna'; cached: boolean }
  | { kind: 'fallback'; reason: QuoteWorkflowFallbackReason };

type LedgerContext = {
  recorder: AgentRunRecorder;
  draft: Pick<
    AgentRunDraft,
    | 'trigger'
    | 'userId'
    | 'transportId'
    | 'threadId'
    | 'messageId'
    | 'inputHash'
    | 'inputKey'
    | 'promptVersion'
    | 'treatAs'
    | 'staffNotePresent'
  >;
};

/** Ledger context for one analyse, or null when nothing is recorded. */
function ledgerContextFor(
  synced: SyncedQuoteSelection,
  options: AnalyseSyncedOptions,
  sourceHash: () => string,
): LedgerContext | null {
  const { recorder, recordAs } = options;
  if (!recorder || !recordAs || !synced.messageId || !synced.threadId) return null;
  const inputHash = sourceHash();
  const treatAs = options.treatAs ?? null;
  return {
    recorder,
    draft: {
      trigger: recordAs.trigger,
      userId: recordAs.userId,
      transportId: options.transportId,
      threadId: synced.threadId,
      messageId: synced.messageId,
      inputHash,
      inputKey: analyseInputKey({
        transportId: options.transportId,
        messageId: synced.messageId,
        sourceHash: inputHash,
        promptVersion: options.promptVersion,
        treatAs,
      }),
      promptVersion: options.promptVersion,
      treatAs,
      staffNotePresent: Boolean(options.staffNote?.trim()),
    },
  };
}

function usageOf(telemetry: QuoteWorkflowTelemetry | undefined): AgentRunDraft['usage'] {
  const usage = telemetry?.usage;
  if (!usage) return null;
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    costUsd: usage.costUsd ?? null,
    usageSource: usage.usageSource ?? null,
  };
}

/**
 * The mapped suggestion the pane pre-fills, without the raw model output. Every branch (fresh model answer,
 * regex fallback, cache hit) uses this one helper, so the first displayed snapshot holds the same fields.
 * Amendment fields (guest name, dates, confirmation) are flat paths such as "amendment.guestLastName".
 */
function suggestedFieldsOf(payload: Record<string, unknown>): Record<string, unknown> {
  const amendment = payload.amendment;
  const amendmentPaths: Record<string, unknown> =
    amendment && typeof amendment === 'object' && !Array.isArray(amendment)
      ? Object.fromEntries(
          Object.entries(amendment as Record<string, unknown>).map(([key, value]) => [
            `amendment.${key}`,
            value ?? null,
          ]),
        )
      : {};
  return {
    intent: payload.intent ?? null,
    groups: payload.groups ?? [],
    secondaryAsks: payload.secondaryAsks ?? [],
    alternatives: payload.alternatives ?? [],
    ...amendmentPaths,
  };
}

/**
 * Adds analysisRunId only when the run was recorded. A cache entry stores the id of the run that produced it,
 * so a later hit links to that run and not to whichever run is newest for the input.
 */
function withAnalysisRunId<T extends object>(
  payload: T,
  analysisRunId: string | null,
): T & { analysisRunId?: string } {
  return analysisRunId
    ? { ...payload, analysisRunId }
    : (payload as T & { analysisRunId?: string });
}

/**
 * mapLlmDecision anchors yearless and mixed-year stay dates into mapped.groups. The staff overlay matches Luna's
 * groups to staff stays by date, so copy the mapped dates back onto Luna's groups by position. A stale date makes
 * the overlay miss that stay and drop its guestNames. Other Luna fields are left as they are.
 */
function lunaWithMappedDates(luna: LunaAnalysis, mapped: MappedQuoteDecision): LunaAnalysis {
  return {
    ...luna,
    groups: luna.groups.map((group, index) => {
      const stay = mapped.groups[index];
      if (!stay) return group;
      return { ...group, arrival: stay.arrivalDate ?? null, departure: stay.departureDate ?? null };
    }),
  };
}

const MAX_PREFILL_ROOMS = 20;

export function currentSourceText(synced: SyncedQuoteSelection): string {
  return [
    synced.subject,
    synced.bodyText,
    ...synced.attachments.map((attachment) => attachment.text ?? ''),
  ].join('\n');
}

export async function hmsTodoCardFromLuna(
  luna: LunaAnalysis | HmsTodoCardInput | null | undefined,
  attachments: SyncedQuoteAttachment[],
  sourceText = '',
  propertyCode?: string,
) {
  if (!luna) return null;
  const workflow = luna.workflow?.trim().toLowerCase();
  const groups = (luna as LunaAnalysis).groups;
  const arrival = groups?.[0]?.arrival?.trim() || null;
  const isNewBooking =
    Array.isArray(groups) &&
    (workflow === 'create' || workflow === 'create_booking' || workflow === 'new_booking' || workflow === 'booking');
  let prefill: BuildCreatePrefillOutput | null = null;
  // Group-sized asks (or a bad count) get no per-room prefill; the card still shows.
  const roomTotal = Array.isArray(groups) ? groups.reduce((sum, group) => sum + (group.rooms ?? 1), 0) : 0;
  if (isNewBooking && arrival && Number.isSafeInteger(roomTotal) && roomTotal <= MAX_PREFILL_ROOMS) {
    try {
      const party = (luna as LunaAnalysis).party;
      prefill = await buildCreatePrefill({
        arrival,
        departure: groups[0]?.departure ?? null,
        nights: null,
        rooms: groups.flatMap((group) =>
          Array.from({ length: Math.max(group.rooms ?? 1, 0) }, (_, index) => ({
            adults: group.adultsPerRoom ?? 1,
            childAges: [...(group.childAges ?? [])],
            roomTypeText: group.roomPreference ?? null,
            guestName: group.guestNames?.[index] ?? null,
          })),
        ),
        boardText: groups[0]?.board ?? null,
        rateText: null,
        agencyName: party?.kind === 'agency' ? (party.name ?? null) : null,
        organizationName:
          party?.kind === 'organization' || party?.kind === 'government' ? (party.name ?? null) : null,
        voucherNumber: null,
        bookerName: null,
        bookerEmail: null,
        billingReference: party?.reference ?? null,
        paidBy: null,
        partyKind:
          party?.kind === 'agency' || party?.kind === 'organization' || party?.kind === 'government'
            ? party.kind
            : null,
        defaults:
          party?.kind === 'agency' || party?.kind === 'organization' || party?.kind === 'government'
            ? { track: null, sourceOfBusiness: null, guaranteeType: null }
            : { ...DIRECT_BOOKING_DEFAULTS },
        ...(propertyCode ? { propertyCode } : {}),
      });
    } catch {
      prefill = null;
    }
  }
  const pop = extractPopFacts(sourceText, {
    rateClaims: (luna as LunaAnalysis).rateClaims,
    guestLastName: (luna as HmsTodoCardInput).guestLastName,
    party: (luna as HmsTodoCardInput).party,
  });
  if (pop.amountText && attachments.some((attachment) => (attachment.text ?? '').includes(pop.amountText!))) {
    pop.amountSource = 'attachment';
  }
  return buildHmsTodoCard({
    ...luna,
    attachmentFilenames: attachments.map((attachment) => attachment.filename),
    prefill,
    pop,
    documentKind: extractBillingAskKind(sourceText),
  });
}

async function hmsTodoCardFromCached(
  luna: unknown,
  attachments: SyncedQuoteAttachment[],
  sourceText = '',
  propertyCode?: string,
) {
  if (!luna || typeof luna !== 'object' || Array.isArray(luna)) return null;
  return hmsTodoCardFromLuna(luna as HmsTodoCardInput, attachments, sourceText, propertyCode);
}

/**
 * Cache-or-analyse for one synced selection. Returns the route payload plus an
 * outcome so callers (the warmer) can log without re-deriving it.
 */
export async function analyseSyncedSelection(
  synced: SyncedQuoteSelection,
  options: AnalyseSyncedOptions,
) {
  const { cacheDir, internetMessageId, treatAs, staffNote } = options;
  const started = Date.now();
  const resolvedProperty = resolvePropertyTransport(options.transportId);
  const propertyCode = resolvedProperty.kind === 'property' ? resolvedProperty.property.propertyCode : undefined;
  let sourceHashMemo: string | undefined;
  const sourceHash = () => (sourceHashMemo ??= hashSyncedQuoteSelection(synced, { staffNote }));
  const ledger = ledgerContextFor(synced, options, sourceHash);
  const cacheFile =
    internetMessageId && cacheDir
      ? analyseCachePath({
          internetMessageId,
          sourceHash: sourceHash(),
          promptVersion: options.promptVersion,
          cacheDir,
          treatAs,
          transportId: options.transportId,
        })
      : null;
  if (cacheFile) {
    const entry = await readAnalyseCacheEntry(cacheFile);
    const hit = entry?.payload ?? null;
    if (entry && hit && isReusableAnalyseCache(hit)) {
      // The producing run id is link data for the ledger. It is not part of the answer the pane shows.
      const { analysisRunId: producingRunId, ...cached } = hit;
      const payload = {
        ...cached,
        sourceRevision: options.selectionEpoch,
        hmsTodoCard: await hmsTodoCardFromCached(
          cached.luna,
          synced.attachments,
          currentSourceText(synced),
          propertyCode,
        ),
      };
      const analysisRunId = ledger
        ? await recordAgentRunCapped(ledger.recorder, {
            ...ledger.draft,
            cacheStatus: 'hit',
            source: 'luna',
            fallbackReason: null,
            workflow: typeof hit.workflow === 'string' ? hit.workflow : null,
            provider: null,
            modelId: null,
            modelRoute: null,
            latencyMs: Date.now() - started,
            usage: null,
            output: null,
            suggestedFields: suggestedFieldsOf(payload),
            producingRunId: typeof producingRunId === 'string' ? producingRunId : null,
            cacheWrittenAt: entry.writtenAt,
          })
        : null;
      const withId = withAnalysisRunId(payload, analysisRunId);
      return {
        payload: applyThreadConfirmationOverlay(
          {
            ...withId,
            luna: hit.luna as OverlayPayload['luna'],
            amendment: hit.amendment as OverlayPayload['amendment'],
            reviewItems: hit.reviewItems as OverlayPayload['reviewItems'],
          },
          synced.threadConfirmation,
        ),
        outcome: { kind: 'cache_hit' } as const,
      };
    }
  }
  const unread = unreadAttachments(synced.attachments);
  const attachmentReviews = documentFailureItems(synced.attachments);
  const resolved = resolveAdapter(options.llmEnabled(), options.adapter);
  const llm = await analyseWithPaneBrain({
    selection: synced,
    adapter: resolved.adapter,
    enabled: resolved.enabled,
    deadlineMs: 25_000,
    treatAs,
    staffNote,
  });
  if (llm.source === 'luna') {
    const flags: LunaAnalysis['flags'] = unread.length
      ? Array.from(new Set([...llm.analysis.flags, 'attachment_unread' as const]))
      : llm.analysis.flags;
    const luna: LunaAnalysis = {
      ...llm.analysis,
      flags,
      ...(treatAs ? { workflow: treatAs } : {}),
    };
    const mapped = mapLlmDecision(luna, {
      treatAs,
      dateAnchor: {
        receivedAt: synced.receivedAt,
        sourceText: stayDateSourceText(synced),
        subjectText: synced.subject,
        yearEvidenceText: stayDateYearEvidenceText(synced),
        staffNote,
      },
      channel: aopQuoteChannelFromSender({
        fromAddress: synced.fromAddress,
        subject: synced.subject,
        bodyText: synced.bodyText,
      }),
      ...(resolvedProperty.kind === 'property'
        ? { propertyCode: resolvedProperty.property.propertyCode }
        : {}),
    });
    const dated = lunaWithMappedDates(luna, mapped);
    const payload = {
      status: 'ready' as const,
      intent: mapped.intent,
      groups: mapped.groups,
      missingQuoteReplyFields: mapped.missingQuoteReplyFields,
      secondaryAsks: mapped.secondaryAsks,
      alternatives: mapped.alternatives,
      reviewItems: [...attachmentReviews, ...questionItems(mapped.missing)],
      source: 'luna' as const,
      aiUnavailable: false as const,
      luna: dated,
      workflow: luna.workflow,
      amendment: amendmentFromAnalysis(luna),
      hmsTodoCard: await hmsTodoCardFromLuna(dated, synced.attachments, currentSourceText(synced), propertyCode),
      sourceRevision: options.selectionEpoch,
      ratePlan: mapped.ratePlan,
      delivery: mapped.delivery,
    };
    // Record first, so the cache entry can name the run that produced it. Recording is capped, so the
    // entry is written without a run id when the ledger is slow, off, or failed.
    const analysisRunId = ledger
      ? await recordAgentRunCapped(ledger.recorder, {
          ...ledger.draft,
          cacheStatus: 'miss',
          source: 'luna',
          fallbackReason: null,
          workflow: luna.workflow,
          provider: llm.telemetry?.provider ?? null,
          modelId: llm.telemetry?.modelId ?? null,
          modelRoute: llm.telemetry?.modelRoute ?? null,
          latencyMs: llm.telemetry?.latencyMs ?? Date.now() - started,
          usage: usageOf(llm.telemetry),
          output: luna,
          suggestedFields: suggestedFieldsOf(payload),
        })
      : null;
    let cached = false;
    if (cacheFile && cacheDir) {
      try {
        await writeAnalyseCache(cacheDir, cacheFile, withAnalysisRunId(payload, analysisRunId));
        cached = true;
      } catch {
        /* analysis still returns; cache is best-effort */
      }
    }
    return {
      payload: applyThreadConfirmationOverlay(
        withAnalysisRunId(payload, analysisRunId),
        synced.threadConfirmation,
      ),
      outcome: { kind: 'luna', cached } as const,
    };
  }
  const analysis = analyseQuoteSources({
    subject: synced.subject,
    bodyText: synced.bodyText,
    preceding: synced.preceding,
    attachments: synced.attachments,
    staffNote,
    treatAs,
  });
  // A staff override always quotes; the booking choice rides on workflow and luna.
  const override = treatAs
    ? {
        intent: 'quote' as const,
        workflow: treatAs,
        luna: fallbackLunaCarrier(treatAs, analysis),
      }
    : { luna: null };
  const payload = {
    status: 'ready' as const,
    ...analysis,
    ...override,
    reviewItems: [
      ...documentFailureItems(synced.attachments, 'text'),
      ...(treatAs ? [LUNA_UNAVAILABLE_ITEM] : []),
    ],
    source: 'regex_fallback' as const,
    fallbackReason: llm.fallbackReason,
    aiUnavailable: true as const,
    amendment: null,
    hmsTodoCard: await hmsTodoCardFromLuna(
      override.luna,
      synced.attachments,
      currentSourceText(synced),
      propertyCode,
    ),
    sourceRevision: options.selectionEpoch,
  };
  const analysisRunId = ledger
    ? await recordAgentRunCapped(ledger.recorder, {
        ...ledger.draft,
        cacheStatus: 'miss',
        source: 'regex_fallback',
        fallbackReason: llm.fallbackReason,
        workflow: treatAs ?? null,
        provider: llm.telemetry?.provider ?? null,
        modelId: llm.telemetry?.modelId ?? null,
        modelRoute: llm.telemetry?.modelRoute ?? null,
        latencyMs: llm.telemetry?.latencyMs ?? Date.now() - started,
        usage: usageOf(llm.telemetry),
        output: null,
        suggestedFields: suggestedFieldsOf(payload),
      })
    : null;
  return {
    payload: applyThreadConfirmationOverlay(
      withAnalysisRunId(payload, analysisRunId),
      synced.threadConfirmation,
    ),
    outcome: { kind: 'fallback', reason: llm.fallbackReason } as const,
  };
}
