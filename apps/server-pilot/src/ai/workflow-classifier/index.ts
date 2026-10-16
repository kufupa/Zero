import { z } from 'zod';
import type { ModelAdapter } from '../bedrock/adapter.js';
import { createAzureLunaModel, LunaModelAdapter } from '../bedrock/luna.js';
import type { ReservationistDecision } from '../reservationist-decision.js';

export const BODY_HEAD_CHARS = 600;

export const COARSE_WORKFLOWS = [
  'new_booking',
  'quote_availability',
  'amend',
  'cancel',
  'payment_proof',
  'billing',
  'group_event',
  'other_actionable',
  'no_action',
] as const;
export type CoarseWorkflow = (typeof COARSE_WORKFLOWS)[number];
export type ClassifierConfidence = 'high' | 'medium' | 'low';

export type ClassifierInput = {
  subject: string;
  attachmentNames: string[];
  bodyHead: string;
};

export type ClassifierResult = {
  workflow: CoarseWorkflow;
  confidence: ClassifierConfidence;
};

/** Agent catalog names the pane schema accepts. Hint uses these, not 9-class labels. */
export const COARSE_TO_AGENT = {
  new_booking: 'create',
  quote_availability: 'quote',
  amend: 'amend',
  cancel: 'cancel',
  payment_proof: 'payment_ack',
  billing: 'send_document',
  group_event: 'forward_to_partner',
  other_actionable: 'other',
  no_action: 'skip',
} as const satisfies Record<CoarseWorkflow, ReservationistDecision['workflow']>;

const COARSE_SET = new Set<string>(COARSE_WORKFLOWS);
const CONF_SET = new Set<string>(['high', 'medium', 'low']);

/** Verbatim 9-class DEF from runs/gepa/labelclean.py. */
export const WORKFLOW_CLASSIFIER_DEF = `Workflows (pick exactly one):
- new_booking: guest/agent/company asks to make a reservation, sends a booking/voucher/rooming for a NEW stay, or accepts a quote ("please book", "go ahead").
- quote_availability: asks for rates, availability, a quotation or a proposal; nothing booked yet.
- amend: change an EXISTING reservation (dates, rooms, names, guests, extras, special requests on a booked stay).
- cancel: cancel an existing reservation (all or part).
- payment_proof: sends proof of payment / remittance / deposit confirmation / card authorisation for a stay.
- billing: asks for an invoice, pro forma, folio, statement, credit note, or a billing correction/query.
- group_event: conference, event, function or group block (≈10+ rooms or a venue/meal package), incl. rooming lists for a group.
- other_actionable: needs staff action but none of the above (lost property, general question, complaint, supplier, internal ops).
- no_action: FYI / thanks / auto-reply / newsletter / spam / already resolved; staff do nothing.`;

const classifierResultSchema = z.object({
  workflow: z.enum(COARSE_WORKFLOWS),
  confidence: z.enum(['high', 'medium', 'low']),
});

export const CLASSIFIER_RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['workflow', 'confidence'],
  properties: {
    workflow: { type: 'string', enum: [...COARSE_WORKFLOWS] },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
  },
} as const;

export function panePreclassifyEnabled(env: NodeJS.Dict<string> = process.env): boolean {
  return env.PANE_PRECLASSIFY === 'on';
}

export function shouldAttachWorkflowHint(confidence: ClassifierConfidence): boolean {
  return confidence !== 'low';
}

export function formatWorkflowHint(result: ClassifierResult): string {
  return `Workflow (pre-classified, confidence ${result.confidence}): ${COARSE_TO_AGENT[result.workflow]}. Override only with clear evidence.`;
}

export function classifierInputFromSelection(selection: {
  subject: string;
  bodyText: string;
  attachments: ReadonlyArray<{ filename: string }>;
}): ClassifierInput {
  return {
    subject: selection.subject,
    attachmentNames: selection.attachments.map((row) => row.filename).filter(Boolean),
    bodyHead: (selection.bodyText ?? '').slice(0, BODY_HEAD_CHARS),
  };
}

export function buildClassifierPrompt(input: ClassifierInput): string {
  const attachments = input.attachmentNames.join(', ');
  return `Hotel reservations staff glance at the subject and the start of an email to know what kind of work it is. Do the same.
${WORKFLOW_CLASSIFIER_DEF}
Return JSON only: {"workflow": "<one>", "confidence": "high|medium|low"}
Subject: ${input.subject}
Attachments: ${attachments}
Body start: ${input.bodyHead}`;
}

export function parseStoredClassifier(usage: unknown): ClassifierResult | null {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return null;
  const raw = (usage as Record<string, unknown>).classifier;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const workflow = (raw as { workflow?: unknown }).workflow;
  const confidence = (raw as { confidence?: unknown }).confidence;
  if (typeof workflow !== 'string' || typeof confidence !== 'string') return null;
  if (!COARSE_SET.has(workflow) || !CONF_SET.has(confidence)) return null;
  return { workflow: workflow as CoarseWorkflow, confidence: confidence as ClassifierConfidence };
}

export function mergeClassifierUsage(
  usage: Record<string, unknown> | null | undefined,
  result: ClassifierResult,
): Record<string, unknown> {
  return { ...(usage ?? {}), classifier: result };
}

export function parseClassifierOutput(text: string): ClassifierResult | null {
  const match = /\{[\s\S]*\}/.exec(text);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]) as { workflow?: unknown; confidence?: unknown };
    if (typeof parsed.workflow !== 'string' || typeof parsed.confidence !== 'string') return null;
    if (!COARSE_SET.has(parsed.workflow) || !CONF_SET.has(parsed.confidence)) return null;
    return classifierResultSchema.parse(parsed);
  } catch {
    return null;
  }
}

const TODO_TO_COARSE: Record<string, CoarseWorkflow> = {
  create: 'new_booking',
  amend: 'amend',
  cancel: 'cancel',
  quote: 'quote_availability',
  post_payment: 'payment_proof',
  document: 'billing',
};

export function agentDecisionToCoarseWorkflow(decision: {
  workflow: string;
  todoTarget?: string | null;
}): CoarseWorkflow | null {
  switch (decision.workflow) {
    case 'quote':
      return 'quote_availability';
    case 'create':
      return 'new_booking';
    case 'amend':
      return 'amend';
    case 'cancel':
      return 'cancel';
    case 'payment_ack':
      return 'payment_proof';
    case 'send_document':
      return 'billing';
    case 'forward_to_partner':
      return 'group_event';
    case 'skip':
    case 'spam':
    case 'acknowledge':
      return 'no_action';
    case 'other':
    case 'clarify':
      return 'other_actionable';
    case 'hms_todo':
      return TODO_TO_COARSE[decision.todoTarget ?? ''] ?? 'other_actionable';
    default:
      return null;
  }
}

export type ClassifierInvoke = (prompt: string) => Promise<string>;

function defaultAdapter(): ModelAdapter {
  return new LunaModelAdapter({
    model: createAzureLunaModel(),
    reasoningEffort: 'medium',
    routeId: 'azure_luna_preclassify',
    modelId: 'gpt-6-luna',
    protocol: 'azure-foundry-responses',
  });
}

export async function classifyWorkflow(
  input: ClassifierInput,
  options: { invoke?: ClassifierInvoke; adapter?: ModelAdapter; signal?: AbortSignal } = {},
): Promise<ClassifierResult | null> {
  if (options.invoke) {
    return parseClassifierOutput(await options.invoke(buildClassifierPrompt(input)));
  }
  const adapter = options.adapter ?? defaultAdapter();
  const result = await adapter.invoke({
    modelId: 'gpt-6-luna',
    systemPrompt: 'Return JSON only.',
    userPrompt: buildClassifierPrompt(input),
    responseSchema: CLASSIFIER_RESPONSE_SCHEMA,
    signal: options.signal,
  });
  return parseClassifierOutput(JSON.stringify(result.output));
}
