import {
  CENTURION_HOTEL_RULES,
  lunaAnalysisSchema,
  type LunaAnalysis,
} from './reservationist-decision.js';
import type { SyncedQuoteSelection } from './quote-workflow-synced-selection.js';
import type { ModelAdapter } from './bedrock/adapter.js';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { maskCardNumbers } from './card-mask.js';

const THREAD_MESSAGE_MAX = 8_000;
const THREAD_TOTAL_MAX = 40_000;
const ATTACHMENT_TEXT_MAX = 20_000;
const MAX_SCANNED_PDFS = 3;
const DEFAULT_DEADLINE_MS = 25_000;

const K2_MAPPING = `Map hotel-rule workflow names onto this schema: "create" is create_booking; "skip" and "spam" are other. Groups of 10+ rooms, delegates or events set the conference_or_group flag. Never output prices except verbatim claims in rateClaims. rateClaims[].quote must be an exact contiguous substring of the email, thread or attachment text; if no exact span exists, omit the claim. Never paraphrase, tidy, complete, or invent a quoted amount. Extras (shuttle, dinner, transfers) become missing questions, not invented prices. adultsPerRoom is adults in EACH room; "6 adults in 3 rooms" is 2. Emit one task per distinct piece of PMS work, in the order staff would do it. Different date sets for the same ask become separate quote tasks. "Quote then book if OK" becomes quote then create_booking. A single simple ask is one task.`;

export type QuoteWorkflowFallbackReason = 'timeout' | 'error' | 'invalid_output' | 'disabled';

export type AnalyseQuoteSelectionResult =
  | { source: 'luna'; analysis: LunaAnalysis }
  | { source: 'regex_fallback'; fallbackReason: QuoteWorkflowFallbackReason };

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
    fields: Record<string, 'extracted' | 'staff_corrected' | 'missing'>;
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

export function buildQuoteWorkflowPrompt(selection: SyncedQuoteSelection): {
  system: string;
  user: string;
  files: Array<{ filename: string; mediaType: string; data: Uint8Array }>;
} {
  const parts: string[] = [];
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

  return {
    system: `${CENTURION_HOTEL_RULES}\n${K2_MAPPING}`,
    user: parts.join('\n\n'),
    files,
  };
}

function validIsoDate(value: string | null): string | undefined {
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

/** Pane mapping. Does not read `tasks` (K14: measured/displayed only). */
export function mapLlmDecision(analysis: LunaAnalysis): MappedQuoteDecision {
  const missing: Array<{ field: string; question: string }> = [];
  if (analysis.workflow === 'other') {
    return { intent: 'other', groups: [], secondaryAsks: [], alternatives: [], missing };
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
    const board: MappedQuoteDecision['groups'][number]['board'] =
      group.board === 'dbb' ? 'dinner_bb' : group.board === null ? 'unknown' : group.board;
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
        board: fieldState(group.board),
      },
    };
  });
  if (groups.length === 0) {
    groups.push({
      id: 'g1',
      childrenAges: [],
      board: 'unknown',
      specialRequests: [],
      fields: {
        arrivalDate: 'missing',
        departureDate: 'missing',
        quantity: 'missing',
        adults: 'missing',
        board: 'missing',
      },
    });
    missing.push({
      field: 'stay',
      question: 'Stay dates, rooms and occupancy for this quote?',
    });
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
}): Promise<AnalyseQuoteSelectionResult> {
  if (!input.enabled || !input.adapter) {
    return { source: 'regex_fallback', fallbackReason: 'disabled' };
  }
  const deadlineMs = input.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const controller = new AbortController();
  const prompt = buildQuoteWorkflowPrompt(input.selection);
  const responseSchema = zodToJsonSchema(lunaAnalysisSchema, { $refStrategy: 'none' }) as Record<
    string,
    unknown
  >;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const invokePromise = input.adapter.invoke({
    modelId: 'gpt-6-luna',
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
    const result = await Promise.race([invokePromise, timeoutPromise]);
    const parsed = lunaAnalysisSchema.safeParse(result.output);
    if (!parsed.success) {
      return { source: 'regex_fallback', fallbackReason: 'invalid_output' };
    }
    const sourceText = prompt.user;
    return {
      source: 'luna',
      analysis: {
        ...parsed.data,
        evidence: parsed.data.evidence.filter((item) => Boolean(item.quote) && sourceText.includes(item.quote)),
      },
    };
  } catch (error) {
    return { source: 'regex_fallback', fallbackReason: fallbackReasonFromError(error) };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
