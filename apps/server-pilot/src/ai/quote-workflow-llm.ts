import {
  CENTURION_HOTEL_RULES,
  lunaAnalysisSchema,
  type LunaAnalysis,
} from './reservationist-decision.js';
import type { SyncedQuoteSelection } from './quote-workflow-synced-selection.js';
import type { ModelAdapter, ModelInvokeResult } from './bedrock/adapter.js';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { maskCardNumbers } from './card-mask.js';
import { createHash } from 'node:crypto';

const THREAD_MESSAGE_MAX = 8_000;
const THREAD_TOTAL_MAX = 40_000;
const ATTACHMENT_TEXT_MAX = 20_000;
const MAX_SCANNED_PDFS = 3;
const DEFAULT_DEADLINE_MS = 25_000;

export const K2_MAPPING = `Map hotel-rule workflow names onto this schema: "create" is create_booking; "skip" and "spam" are other. Rooms-only group asks are workflow=quote with the stated quantity even at 10+ rooms (engine quotes per group, max 8 groups); set rooms_only_group. Do not set conference_or_group for rooms-only. Venue hire, DDR, delegates, or packages are workflow=other with conference_or_group (handle manually). Never output prices except verbatim claims in rateClaims. rateClaims[].quote must be an exact contiguous substring of the email, thread or attachment text; if no exact span exists, omit the claim. Never paraphrase, tidy, complete, or invent a quoted amount. Extras (shuttle, dinner, transfers) become missing questions, not invented prices. adultsPerRoom is adults in EACH room; "6 adults in 3 rooms" is 2. "single room" means 1 adult per room. A double or twin room with no headcount means 2 adults. Never ask for room type, board or rate; the hotel defaults those. Emit one task per distinct piece of PMS work, in the order staff would do it. Different date sets for the same ask become separate quote tasks. "Quote then book if OK" becomes quote then create_booking. A single simple ask is one task.`;

/** The response schema the model fills. Hashed into the version so a schema change also misses the cache. */
const LUNA_RESPONSE_JSON = JSON.stringify(
  zodToJsonSchema(lunaAnalysisSchema, { $refStrategy: 'none' }),
);

export const QUOTE_WORKFLOW_PROMPT_VERSION = createHash('sha256')
  .update(CENTURION_HOTEL_RULES)
  .update('\n')
  .update(K2_MAPPING)
  .update('\n')
  .update(LUNA_RESPONSE_JSON)
  // Bumped with the review rows a cached analysis carries, so no cache entry replays the old rows.
  .update('\nattachment-review/2')
  .digest('hex')
  .slice(0, 16);

export type QuoteWorkflowFallbackReason = 'timeout' | 'error' | 'invalid_output' | 'disabled';

/** Model-call facts for the HITL ledger. Optional fields appear only when reported. */
export type QuoteWorkflowTelemetry = {
  /** Wall time of the analyse call, including the model round trip when one was made. */
  latencyMs: number;
  modelId?: string;
  /** Adapter protocol and route, from the adapter's provenance. */
  provider?: string;
  modelRoute?: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    costUsd?: number;
    usageSource?: 'reported' | 'unknown';
  };
};

export type AnalyseQuoteSelectionResult =
  | { source: 'luna'; analysis: LunaAnalysis; telemetry?: QuoteWorkflowTelemetry }
  | {
      source: 'regex_fallback';
      fallbackReason: QuoteWorkflowFallbackReason;
      telemetry?: QuoteWorkflowTelemetry;
    };

/** The model every quote analyse requests. */
const LUNA_REQUESTED_MODEL_ID = 'gpt-6-luna';

function telemetryFrom(
  result: ModelInvokeResult | undefined,
  startedAt: number,
): QuoteWorkflowTelemetry {
  const latencyMs = Date.now() - startedAt;
  // A call was attempted but produced no result (timeout or error): report what was requested.
  if (!result) return { latencyMs, modelId: LUNA_REQUESTED_MODEL_ID };
  const usage = result.usage;
  return {
    latencyMs,
    modelId: result.modelId || LUNA_REQUESTED_MODEL_ID,
    ...(result.provenance
      ? { provider: result.provenance.protocol, modelRoute: result.provenance.routeId }
      : {}),
    ...(usage && typeof usage.inputTokens === 'number' && typeof usage.outputTokens === 'number'
      ? {
          usage: {
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            costUsd:
              typeof usage.estimatedCostUsd === 'number' ? usage.estimatedCostUsd : undefined,
            usageSource: result.provenance?.usageSource,
          },
        }
      : {}),
  };
}

export type MappedQuoteDecision = {
  intent: 'quote' | 'other';
  groups: Array<{
    id: string;
    arrivalDate?: string;
    departureDate?: string;
    quantity?: number;
    adults?: number;
    childrenAges: number[];
    board: 'dinner_bb' | 'bb' | 'room_only' | 'unknown';
    roomPreference?: string;
    organisation?: string;
    specialRequests: string[];
    fields: Record<string, 'extracted' | 'staff_corrected' | 'missing' | 'defaulted'>;
  }>;
  secondaryAsks: string[];
  alternatives: string[];
  missing: Array<{ field: string; question: string }>;
};

function isPdfMagic(data: Uint8Array): boolean {
  if (data.byteLength <= 5) return false;
  return new TextDecoder().decode(data.subarray(0, 5)) === '%PDF-';
}

export function quoteWorkflowLlmEnabled(
  env: Record<string, string | undefined> | NodeJS.ProcessEnv,
): boolean {
  const flag = env.QUOTE_WORKFLOW_LLM;
  if (flag !== undefined && flag !== 'on' && flag !== 'off') {
    throw new Error(`QUOTE_WORKFLOW_LLM must be unset, 'on', or 'off'`);
  }
  if (flag === 'off') return false;
  if (flag === 'on') return true;
  return Boolean(env.AZURE_OPENAI_BASE_URL && env.AZURE_FOUNDRY_API_KEY);
}

export type QuoteTreatAs = 'quote' | 'create_booking';

export function buildQuoteWorkflowPrompt(
  selection: SyncedQuoteSelection,
  options?: { treatAs?: QuoteTreatAs; staffNote?: string },
): {
  system: string;
  user: string;
  files: Array<{ filename: string; mediaType: string; data: Uint8Array }>;
} {
  const parts: string[] = [];
  const staffNote = options?.staffNote?.trim();
  if (staffNote) {
    parts.push(`Staff note (top-priority evidence):\n${maskCardNumbers(staffNote)}`);
  }
  if (selection.receivedAt) {
    parts.push(`Received at: ${selection.receivedAt.slice(0, 10)}`);
  }
  parts.push(`Subject:\n${maskCardNumbers(selection.subject)}`);
  parts.push(`Body:\n${maskCardNumbers(selection.bodyText)}`);

  let threadBudget = THREAD_TOTAL_MAX;
  const threadChunks: string[] = [];
  for (const message of selection.preceding) {
    if (threadBudget <= 0) break;
    const masked = maskCardNumbers(message.bodyText).slice(0, THREAD_MESSAGE_MAX);
    const next = masked.slice(0, threadBudget);
    if (!next) continue;
    threadChunks.push(next);
    threadBudget -= next.length;
  }
  if (threadChunks.length) {
    parts.push(`Thread (oldest first):\n${threadChunks.join('\n---\n')}`);
  }

  const files: Array<{ filename: string; mediaType: string; data: Uint8Array }> = [];
  const attachmentChunks: string[] = [];
  for (const attachment of selection.attachments) {
    if (attachment.text) {
      attachmentChunks.push(
        `--- ${attachment.filename} ---\n${maskCardNumbers(attachment.text).slice(0, ATTACHMENT_TEXT_MAX)}`,
      );
    }
    // Scanned PDF bytes cannot be PAN-masked; accepted for model file input only.
    if (attachment.pdf && files.length < MAX_SCANNED_PDFS && isPdfMagic(attachment.pdf)) {
      files.push({
        filename: attachment.filename,
        mediaType: 'application/pdf',
        data: attachment.pdf,
      });
    }
  }
  if (attachmentChunks.length) {
    parts.push(`Attachments:\n${attachmentChunks.join('\n')}`);
  }

  const treatAsLine = options?.treatAs
    ? options.treatAs === 'create_booking'
      ? 'Staff override: treat this mail as a booking. Extract stay groups and use workflow create_booking even if you would otherwise classify it as other.'
      : 'Staff override: treat this mail as a quote. Extract stay groups and use workflow quote even if you would otherwise classify it as other.'
    : '';
  const staffNoteLine = staffNote
    ? 'The staff note is a first-class evidence source. rateClaims and evidence quotes may be exact contiguous substrings of the staff note.'
    : '';
  return {
    system: `${CENTURION_HOTEL_RULES}\n${K2_MAPPING}${treatAsLine ? `\n${treatAsLine}` : ''}${staffNoteLine ? `\n${staffNoteLine}` : ''}`,
    user: parts.join('\n\n'),
    files,
  };
}

export function validIsoDate(value: string | null): string | undefined {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  const utc = new Date(Date.UTC(year, month - 1, day));
  if (
    utc.getUTCFullYear() !== year ||
    utc.getUTCMonth() !== month - 1 ||
    utc.getUTCDate() !== day
  ) {
    return undefined;
  }
  return value;
}

function fieldState(value: unknown): 'extracted' | 'missing' {
  return value === null || value === undefined ? 'missing' : 'extracted';
}

function hotelDefaultedQuestion(field: string): boolean {
  return /^(roomType|roomPreference|room_type|board)$/i.test(field);
}

function defaultBoard(
  partyKind: LunaAnalysis['party']['kind'],
): MappedQuoteDecision['groups'][number]['board'] {
  return partyKind === 'government' ? 'dinner_bb' : 'bb';
}

function mapStatedOrDefaultBoard(
  board: LunaAnalysis['groups'][number]['board'],
  partyKind: LunaAnalysis['party']['kind'],
): MappedQuoteDecision['groups'][number]['board'] {
  if (board === null) return defaultBoard(partyKind);
  return board === 'dbb' ? 'dinner_bb' : board;
}

function venueOrEventManual(analysis: LunaAnalysis): boolean {
  return analysis.flags.includes('conference_or_group');
}

function roomsOnlyInfoNeeded(analysis: LunaAnalysis): boolean {
  return (
    analysis.flags.includes('rooms_only_group') ||
    analysis.groups.some((group) => (group.rooms ?? 0) >= 10)
  );
}

const VENUE_MANUAL_QUESTION = 'Venue / DDR / delegates / packages: handle manually';
const ROOMS_ONLY_INFO_QUESTION = 'Rooms-only group: quoting with stated quantity';

export function isAmendOrCancelWorkflow(
  workflow: LunaAnalysis['workflow'],
): workflow is 'amend' | 'cancel' {
  return workflow === 'amend' || workflow === 'cancel';
}

/** Route payload for an existing-booking change. Null for every other workflow. */
export type QuoteAmendment = {
  kind: 'amend' | 'cancel';
  confirmationNumber: string | null;
  guestLastName: string | null;
  arrival: string | null;
  departure: string | null;
  requestedChange: string | null;
};

export function amendmentFromAnalysis(analysis: LunaAnalysis): QuoteAmendment | null {
  if (!isAmendOrCancelWorkflow(analysis.workflow)) return null;
  return {
    kind: analysis.workflow,
    confirmationNumber: analysis.confirmationNumber ?? null,
    guestLastName: analysis.guestLastName ?? null,
    arrival: analysis.arrival ?? null,
    departure: analysis.departure ?? null,
    requestedChange: analysis.requestedChange ?? null,
  };
}

const REQUESTED_CHANGE_MAX = 300;

/**
 * Amendment fields are display and lookup hints, so keep only what the source supports:
 * the confirmation number must appear verbatim, dates must be real ISO days, and the
 * change line is card-masked and capped rather than failing the whole analysis.
 */
function groundedAmendmentFields(
  analysis: LunaAnalysis,
  sourceText: string,
): Pick<LunaAnalysis, 'confirmationNumber' | 'arrival' | 'departure' | 'requestedChange'> {
  const confirmation = analysis.confirmationNumber?.trim() ?? '';
  const change = analysis.requestedChange?.trim() ?? '';
  return {
    confirmationNumber: confirmation && sourceText.includes(confirmation) ? confirmation : null,
    arrival: validIsoDate(analysis.arrival ?? null) ?? null,
    departure: validIsoDate(analysis.departure ?? null) ?? null,
    requestedChange: change ? maskCardNumbers(change).slice(0, REQUESTED_CHANGE_MAX) : null,
  };
}

/** Pane mapping. Does not read `tasks` (K14: measured/displayed only). */
export function mapLlmDecision(
  analysis: LunaAnalysis,
  options?: { treatAs?: QuoteTreatAs },
): MappedQuoteDecision {
  const missing: Array<{ field: string; question: string }> = [];
  const staffQuote = Boolean(options?.treatAs);
  const notQuote = analysis.workflow === 'other' || isAmendOrCancelWorkflow(analysis.workflow);
  if ((notQuote || venueOrEventManual(analysis)) && !staffQuote) {
    const routed = analysis.missing.filter((item) => !hotelDefaultedQuestion(item.field));
    if (venueOrEventManual(analysis)) {
      routed.unshift({ field: 'handle_manually', question: VENUE_MANUAL_QUESTION });
    }
    return {
      intent: 'other',
      groups: [],
      secondaryAsks: [],
      alternatives: [],
      missing: routed,
    };
  }
  const groups = analysis.groups.map((group, index) => {
    const arrivalDate = validIsoDate(group.arrival);
    const departureDate = validIsoDate(group.departure);
    if (group.arrival && !arrivalDate) {
      missing.push({
        field: 'arrivalDate',
        question: `Arrival date for group ${index + 1} is not a valid ISO calendar date.`,
      });
    }
    if (group.departure && !departureDate) {
      missing.push({
        field: 'departureDate',
        question: `Departure date for group ${index + 1} is not a valid ISO calendar date.`,
      });
    }
    const boardDefaulted = group.board === null;
    const board: MappedQuoteDecision['groups'][number]['board'] = mapStatedOrDefaultBoard(
      group.board,
      analysis.party.kind,
    );
    return {
      id: `g${index + 1}`,
      ...(arrivalDate ? { arrivalDate } : {}),
      ...(departureDate ? { departureDate } : {}),
      ...(group.rooms !== null ? { quantity: group.rooms } : {}),
      ...(group.adultsPerRoom !== null ? { adults: group.adultsPerRoom } : {}),
      childrenAges: group.childAges,
      board,
      ...(group.roomPreference ? { roomPreference: group.roomPreference } : {}),
      ...(analysis.party.name ? { organisation: analysis.party.name } : {}),
      specialRequests: [] as string[],
      fields: {
        arrivalDate: arrivalDate ? ('extracted' as const) : ('missing' as const),
        departureDate: departureDate ? ('extracted' as const) : ('missing' as const),
        quantity: fieldState(group.rooms),
        adults: fieldState(group.adultsPerRoom),
        board: boardDefaulted ? ('defaulted' as const) : fieldState(group.board),
      },
    };
  });
  if (groups.length === 0) {
    groups.push({
      id: 'g1',
      childrenAges: [],
      board: defaultBoard(analysis.party.kind),
      specialRequests: [],
      fields: {
        arrivalDate: 'missing',
        departureDate: 'missing',
        quantity: 'missing',
        adults: 'missing',
        board: 'defaulted',
      },
    });
    missing.push({
      field: 'stay',
      question: 'Stay dates, rooms and occupancy for this quote?',
    });
  }
  for (const item of analysis.missing) {
    if (!hotelDefaultedQuestion(item.field)) missing.push(item);
  }
  if (roomsOnlyInfoNeeded(analysis)) {
    missing.unshift({ field: 'rooms_only_group', question: ROOMS_ONLY_INFO_QUESTION });
  }
  return { intent: 'quote', groups, secondaryAsks: [], alternatives: [], missing };
}

function fallbackReasonFromError(error: unknown): 'timeout' | 'error' {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') return 'timeout';
    if (/timeout|aborted/i.test(error.message)) return 'timeout';
  }
  return 'error';
}

export async function analyseQuoteSelection(input: {
  selection: SyncedQuoteSelection;
  adapter: ModelAdapter | null;
  enabled: boolean;
  deadlineMs?: number;
  treatAs?: QuoteTreatAs;
  staffNote?: string;
}): Promise<AnalyseQuoteSelectionResult> {
  const started = Date.now();
  if (!input.enabled || !input.adapter) {
    // No model call was attempted, so no modelId is reported.
    return {
      source: 'regex_fallback',
      fallbackReason: 'disabled',
      telemetry: { latencyMs: Date.now() - started },
    };
  }
  const deadlineMs = input.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const controller = new AbortController();
  const prompt = buildQuoteWorkflowPrompt(input.selection, {
    treatAs: input.treatAs,
    staffNote: input.staffNote,
  });
  const responseSchema = zodToJsonSchema(lunaAnalysisSchema, { $refStrategy: 'none' }) as Record<
    string,
    unknown
  >;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let result: ModelInvokeResult | undefined;
  const invokePromise = input.adapter.invoke({
    modelId: LUNA_REQUESTED_MODEL_ID,
    systemPrompt: prompt.system,
    userPrompt: prompt.user,
    files: prompt.files,
    responseSchema,
    signal: controller.signal,
    deadlineAt: Date.now() + deadlineMs,
  });
  void invokePromise.catch(() => undefined);
  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        const error = new Error('timeout');
        error.name = 'TimeoutError';
        reject(error);
      }, deadlineMs);
    });
    result = await Promise.race([invokePromise, timeoutPromise]);
    const parsed = lunaAnalysisSchema.safeParse(result.output);
    if (!parsed.success) {
      return {
        source: 'regex_fallback',
        fallbackReason: 'invalid_output',
        telemetry: telemetryFrom(result, started),
      };
    }
    const sourceText = prompt.user;
    const staffNote = input.staffNote?.trim() ?? '';
    const verbatim = <T extends { quote: string }>(items: T[]) =>
      items.filter((item) => Boolean(item.quote) && sourceText.includes(item.quote));
    return {
      source: 'luna',
      analysis: {
        ...parsed.data,
        evidence: verbatim(parsed.data.evidence).map((item) =>
          staffNote && staffNote.includes(item.quote)
            ? { ...item, source: 'staff_note' as const }
            : item,
        ),
        rateClaims: verbatim(parsed.data.rateClaims),
        ...groundedAmendmentFields(parsed.data, sourceText),
      },
      telemetry: telemetryFrom(result, started),
    };
  } catch (error) {
    return {
      source: 'regex_fallback',
      fallbackReason: fallbackReasonFromError(error),
      telemetry: telemetryFrom(result, started),
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
