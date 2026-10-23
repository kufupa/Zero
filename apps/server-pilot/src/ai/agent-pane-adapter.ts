/** Pane producer: Mastra reservationist decision → LunaAnalysis. Caller supplies runners; no live HMS here. */
import { RequestContext } from '@mastra/core/request-context';
import { BILLING_SOP } from './aop/billing-sop.js';
import { agentThreadPrompt, type AgentCaseMessage } from './agent-decision-to-ops.js';
import { maskCardNumbers } from './card-mask.js';
import { lunaProviderOptions } from './bedrock/luna.js';
import type { QuoteTreatAs, QuoteWorkflowTelemetry } from './quote-workflow-llm.js';
import type { SyncedQuoteSelection } from './quote-workflow-synced-selection.js';
import {
  createReservationistAgent,
  createReservationistTools,
  reservationistDecisionSchema,
  type ReservationistContext,
  type ReservationistDecision,
  type ReservationistRunners,
} from './reservationist-agent.js';
import { hotelRulesForProperty, type LunaAnalysis } from './reservationist-decision.js';
import {
  classifyWorkflow,
  classifierInputFromSelection,
  formatWorkflowHint,
  panePreclassifyEnabled,
  shouldAttachWorkflowHint,
  type ClassifierResult,
} from './workflow-classifier/index.js';

const DEFAULT_DEADLINE_MS = 25_000;
const MAX_STEPS = 10;
/** Billing only: on a fresh 99 it scored 38 vs 31 with no SOP; the other SOPs together scored lower. */
const PANE_AOP_SOPS = { send_document: BILLING_SOP } as const;
const LUNA_MODEL_ID = 'gpt-6-luna';

const WORKFLOW_TO_LUNA: Record<ReservationistDecision['workflow'], LunaAnalysis['workflow']> = {
  quote: 'quote',
  create: 'create_booking',
  skip: 'skip',
  spam: 'skip',
  other: 'other',
  amend: 'amend',
  cancel: 'cancel',
  forward_to_partner: 'forward_to_partner',
  send_document: 'send_document',
  payment_ack: 'payment_ack',
  clarify: 'clarify',
  acknowledge: 'acknowledge',
  hms_todo: 'hms_todo',
};

export type AnalyseSelectionWithAgentResult =
  | { source: 'luna'; analysis: LunaAnalysis; telemetry?: QuoteWorkflowTelemetry }
  | { source: 'regex_fallback'; fallbackReason: 'agent_error'; telemetry?: QuoteWorkflowTelemetry };

function sourceTextOf(selection: SyncedQuoteSelection): string {
  return [
    selection.subject,
    selection.bodyText,
    ...selection.preceding.map((message) => message.bodyText),
    ...selection.attachments.map((attachment) => attachment.text ?? ''),
  ].join('\n');
}

function groupFromStayAsk(
  stay: NonNullable<ReservationistDecision['stayAsk']>,
): LunaAnalysis['groups'][number] {
  const rooms = stay.rooms;
  return {
    arrival: stay.arrivalDate,
    departure: stay.departureDate,
    dateEvidence: null,
    rooms,
    adultsPerRoom: rooms > 0 ? Math.ceil(stay.adults / rooms) : stay.adults,
    childAges: Array.from({ length: Math.max(0, stay.children) }, () => 0),
    board: null,
    roomPreference: null,
    guestNames: [],
  };
}

function confirmationTokenInSource(source: string, confirmation: string): boolean {
  const escaped = confirmation.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![A-Za-z0-9-])${escaped}(?![A-Za-z0-9-])`).test(source);
}

function extraMissing(decision: ReservationistDecision): LunaAnalysis['missing'] {
  const rows: LunaAnalysis['missing'] = decision.missing.map((field) => ({ field, question: field }));
  const todo = [decision.todoReason, decision.todoNextStep].filter(Boolean).join(' ');
  if (todo) rows.push({ field: decision.todoTarget ?? 'hms_todo', question: todo });
  return rows;
}

export function agentDecisionToLunaAnalysis(
  decision: ReservationistDecision,
  selection: SyncedQuoteSelection,
): LunaAnalysis {
  const source = sourceTextOf(selection);
  const confirmation = decision.confirmationNumber?.trim() ?? '';
  return {
    workflow: WORKFLOW_TO_LUNA[decision.workflow],
    flags: [],
    groups: decision.stayAsk ? [groupFromStayAsk(decision.stayAsk)] : [],
    party: { kind: null, name: null, reference: null },
    rateClaims: [],
    missing: extraMissing(decision),
    evidence: [],
    tasks: [],
    confirmationNumber: confirmation && confirmationTokenInSource(source, confirmation) ? confirmation : null,
    requestedChange: decision.requestedChange ?? null,
    todoTarget: decision.workflow === 'hms_todo' ? (decision.todoTarget ?? null) : null,
  };
}

function escapeEmailBody(text: string): string {
  return text.replace(/[<>]/g, (ch) => (ch === '<' ? '&lt;' : '&gt;'));
}

function promptDirection(direction: string | undefined): string {
  return direction === 'outbound' || direction === 'staff' ? 'staff' : 'inbound';
}

function maskedMessage(
  id: string,
  text: string,
  extras: Partial<AgentCaseMessage> = {},
): AgentCaseMessage {
  return {
    id,
    direction: promptDirection(extras.direction),
    eventAt: extras.eventAt ?? null,
    from: extras.from ?? '',
    subject: extras.subject ?? '',
    text: escapeEmailBody(maskCardNumbers(text)),
  };
}

const PANE_WRITE_OFF = 'pane analysis: writes off';

/** HMS read lookups only. PDF / document / create runners never reach the pane agent. */
export function paneAnalysisTools(runners: Pick<ReservationistRunners, 'quote' | 'party'>) {
  const tools = createReservationistTools({
    quote: runners.quote,
    party: runners.party,
    pdf: async () => {
      throw new Error(PANE_WRITE_OFF);
    },
    validateCreate: async () => ({ ok: false, errors: [PANE_WRITE_OFF] }),
  });
  return { quote_stay: tools.quote_stay, party_lookup: tools.party_lookup };
}

export function selectionToAgentPrompt(
  selection: SyncedQuoteSelection,
  options?: { treatAs?: QuoteTreatAs; staffNote?: string; workflowHint?: string },
): string {
  const parts: string[] = [];
  const staffNote = options?.staffNote?.trim();
  if (staffNote) parts.push(`Staff note (top-priority evidence):\n${maskCardNumbers(staffNote)}`);
  const workflowHint = options?.workflowHint?.trim();
  if (workflowHint) parts.push(workflowHint);
  if (options?.treatAs === 'create_booking') {
    parts.push('Staff override: treat this mail as a booking (workflow create).');
  } else if (options?.treatAs === 'quote') {
    parts.push('Staff override: treat this mail as a quote.');
  }
  parts.push(
    agentThreadPrompt({
      trigger: maskedMessage(selection.messageId ?? 'selected', selection.bodyText, {
        eventAt: selection.receivedAt ?? null,
        from: selection.fromAddress ?? '',
        subject: maskCardNumbers(selection.subject),
      }),
      context: selection.preceding.map((message, index) =>
        maskedMessage(`preceding-${index}`, message.bodyText, { direction: message.direction }),
      ),
    }),
  );
  const attachments = selection.attachments
    .filter((attachment) => attachment.text)
    .map((attachment) => `--- ${attachment.filename} ---\n${maskCardNumbers(attachment.text ?? '')}`);
  if (attachments.length) parts.push(`Attachments:\n${attachments.join('\n')}`);
  return parts.join('\n\n');
}

function telemetry(startedAt: number): QuoteWorkflowTelemetry {
  return { latencyMs: Date.now() - startedAt, modelId: LUNA_MODEL_ID };
}

function agentError(startedAt: number): AnalyseSelectionWithAgentResult {
  return { source: 'regex_fallback', fallbackReason: 'agent_error', telemetry: telemetry(startedAt) };
}

export async function analyseSelectionWithAgent(input: {
  selection: SyncedQuoteSelection;
  model: NonNullable<Parameters<typeof createReservationistAgent>[0]['model']>;
  /** Omitted in the live pane: the agent classifies with no tools (no HMS from analysis). */
  runners?: ReservationistRunners;
  deadlineMs?: number;
  treatAs?: QuoteTreatAs;
  staffNote?: string;
  /** HMS property for hotel rules. Omitted and unknown stay HRCEN. */
  propertyCode?: string;
  classify?: (input: ReturnType<typeof classifierInputFromSelection>) => Promise<ClassifierResult | null>;
}): Promise<AnalyseSelectionWithAgentResult> {
  const started = Date.now();
  const deadlineMs = input.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let workflowHint: string | undefined;
  if (panePreclassifyEnabled()) {
    try {
      const classify = input.classify ?? classifyWorkflow;
      const classified = await classify(classifierInputFromSelection(input.selection));
      if (classified && shouldAttachWorkflowHint(classified.confidence)) {
        workflowHint = formatWorkflowHint(classified);
      }
    } catch {
      workflowHint = undefined;
    }
  }
  try {
    const agent = createReservationistAgent({
      model: input.model,
      runners: input.runners,
      tools: input.runners ? paneAnalysisTools(input.runners) : {},
      aopSops: PANE_AOP_SOPS,
    });
    const propertyCode = input.propertyCode === 'HRDAV' ? 'HRDAV' : 'HRCEN';
    const requestContext = new RequestContext<ReservationistContext>([
      ['propertyCode', propertyCode],
      ['hotelRules', hotelRulesForProperty(propertyCode)],
      ['liveQuoteOk', true],
    ]);
    const generatePromise = agent.generate(
      selectionToAgentPrompt(input.selection, {
        treatAs: input.treatAs,
        staffNote: input.staffNote,
        workflowHint,
      }),
      {
        maxSteps: MAX_STEPS,
        requestContext,
        providerOptions: lunaProviderOptions('medium'),
        structuredOutput: { schema: reservationistDecisionSchema },
        abortSignal: controller.signal,
      },
    );
    void generatePromise.catch(() => undefined);
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        const error = new Error('timeout');
        error.name = 'TimeoutError';
        reject(error);
      }, deadlineMs);
    });
    const result = await Promise.race([generatePromise, timeoutPromise]);
    const parsed = reservationistDecisionSchema.safeParse(result.object);
    if (!parsed.success) return agentError(started);
    const analysis = agentDecisionToLunaAnalysis(parsed.data, input.selection);
    if (input.treatAs) analysis.workflow = input.treatAs;
    return { source: 'luna', analysis, telemetry: telemetry(started) };
  } catch {
    return agentError(started);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
