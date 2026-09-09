import {
  MAIL_BASELINE_INTERPRETATION_VERSION,
  type MailBaselineDelivery,
  type MailBaselineEvidence,
  type MailBaselineSource,
  type MailBaselineSourceBasis,
} from '../metrics/mail-baseline.js';
import type { LocalModelRouteEvidence, LocalModelTransport } from './bedrock/local.js';
import { resolveExtractionModelAdapter } from './local-model-routing.js';
import type { ModelAdapter } from './bedrock/adapter.js';
import { createHash } from 'node:crypto';
import { z } from 'zod';

export const MAIL_BASELINE_EXTRACTION_VERSION = 'mail-baseline-extraction-v1';

const MAIL_BASELINE_ASK_CODES = [
  'reservation',
  'price',
  'payment',
  'stay',
  'document',
  'general',
  'unknown',
] as const;
type MailBaselineAskCode = (typeof MAIL_BASELINE_ASK_CODES)[number];

const mailBaselineSemanticOutputSchema = z
  .object({
    asks: z
      .array(
        z
          .object({
            askCode: z.enum(MAIL_BASELINE_ASK_CODES),
            requiresHotelResponse: z.boolean().default(false),
            requiresCustomerInformation: z.boolean().default(false),
            noReplyRequired: z.boolean().default(false),
            workState: z
              .enum(['open', 'partially_complete', 'complete', 'not_required', 'unknown'])
              .default('unknown'),
          })
          .strict(),
      )
      .default([]),
    answers: z
      .array(
        z
          .object({
            askCode: z.enum(MAIL_BASELINE_ASK_CODES),
            eventType: z
              .enum(['answer', 'clarification', 'acknowledgement', 'forward', 'work_update'])
              .default('answer'),
            answerState: z.enum(['supported', 'partial', 'unknown']).default('unknown'),
            workState: z
              .enum(['open', 'partially_complete', 'complete', 'not_required', 'unknown'])
              .default('unknown'),
            substantive: z.boolean().default(false),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();

export type MailBaselineSemanticOutput = z.infer<typeof mailBaselineSemanticOutputSchema>;

const MAIL_BASELINE_SEMANTIC_RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    asks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          askCode: { type: 'string', enum: [...MAIL_BASELINE_ASK_CODES] },
          requiresHotelResponse: { type: 'boolean' },
          requiresCustomerInformation: { type: 'boolean' },
          noReplyRequired: { type: 'boolean' },
          workState: { type: 'string' },
        },
        required: ['askCode'],
      },
    },
    answers: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          askCode: { type: 'string', enum: [...MAIL_BASELINE_ASK_CODES] },
          eventType: { type: 'string' },
          answerState: { type: 'string' },
          workState: { type: 'string' },
          substantive: { type: 'boolean' },
        },
        required: ['askCode'],
      },
    },
  },
  required: ['asks', 'answers'],
} as const;

export type MailBaselineExtractionRoute = {
  available: boolean;
  reason: 'approved_route_unavailable' | 'approved_route_invalid' | null;
  route: string | null;
  adapter?: ModelAdapter;
};

export function resolveMailBaselineExtractionRoute(input: {
  approvedRoute?: string | null;
  route?: LocalModelRouteEvidence;
  transport?: LocalModelTransport;
}): MailBaselineExtractionRoute {
  // A marker is never route approval. Require the same purpose-bound local
  // route evidence and in-process transport used by the existing adapter
  // resolver; validation constructs no client and invokes no transport.
  if (input.approvedRoute !== 'approved-local' || !input.route || !input.transport) {
    return { available: false, reason: 'approved_route_unavailable', route: null };
  }
  try {
    const adapter = resolveExtractionModelAdapter({
      route: input.route,
      transport: input.transport,
    });
    return { available: true, reason: null, route: input.route.routeId, adapter };
  } catch {
    return { available: false, reason: 'approved_route_invalid', route: null };
  }
}

export type MailBaselineSourceMessage = {
  id: string;
  transportId: string;
  threadId: string;
  direction: 'inbound' | 'outbound';
  fromAddress: string;
  toAddresses?: readonly string[];
  ccAddresses?: readonly string[];
  bccAddresses?: readonly string[];
  subject?: string | null;
  /** Body is consumed only by the producer and is never returned/persisted. */
  textBody?: string | null;
  receivedAt?: string | Date | null;
  sentAt?: string | Date | null;
  createdAt: string | Date;
  messageIdHeader?: string | null;
  inReplyTo?: string | null;
  references?: readonly string[] | null;
  sendEvidence?: MailBaselineDelivery | null;
  source?: MailBaselineSource;
  sourceBasis?: MailBaselineSourceBasis;
};

export type MailBaselineExtractionInput = {
  sourceVintage: string;
  observationCutoff: string | Date;
  interpretationVersion?: string;
  classifierVersion?: string | null;
  reviewerVersion?: string | null;
  /** Present only after a purpose-bound approved extraction adapter validates output. */
  semanticOutput?: MailBaselineSemanticOutput;
  message: MailBaselineSourceMessage;
};

export type MailBaselineExtractionResult = {
  extractionVersion: string;
  interpretationVersion: string;
  sourceVintage: string;
  sourceBasis: MailBaselineSourceBasis;
  eventAt: string | null;
  evidence: readonly MailBaselineEvidence[];
};

export type MailBaselineModelUsage = {
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
};

export type MailBaselineRoutedExtractionResult = {
  extraction: MailBaselineExtractionResult;
  modelUsage: MailBaselineModelUsage | null;
  semanticRoute: 'approved_local_extraction' | 'unavailable_source_observation';
};

function asDate(value: string | Date | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  const parsed = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function normalizeAddress(address: string): string {
  return address.trim().toLowerCase().replace(/^.*</, '').replace(/>.*$/, '');
}

function canonicalMessageId(value: string | null | undefined): string | null {
  const normalized = value?.trim().replace(/^<|>$/g, '').toLowerCase();
  return normalized || null;
}

function eventClock(message: MailBaselineSourceMessage): {
  at: Date | null;
  basis: MailBaselineSourceBasis;
} {
  if (message.sourceBasis === 'availability') {
    return { at: null, basis: 'availability' };
  }
  if (message.direction === 'inbound') {
    const received = asDate(message.receivedAt);
    if (received) return { at: received, basis: message.sourceBasis ?? 'source_event' };
  } else {
    const sent = asDate(message.sentAt);
    if (sent) return { at: sent, basis: message.sourceBasis ?? 'source_event' };
  }
  const created = asDate(message.createdAt);
  return created
    ? { at: created, basis: message.source === 'import' ? 'import_created_at' : 'first_known' }
    : { at: null, basis: 'unknown' };
}

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 24);
}

function isInternalAddress(address: string): boolean {
  const normalized = normalizeAddress(address);
  return /@(legacyhotels\.co\.za|mail\.legacyhotels\.com|branding\.legacyhotels\.co\.za)$/.test(
    normalized,
  );
}

function isAutomatedMessage(message: MailBaselineSourceMessage, body: string): boolean {
  const from = normalizeAddress(message.fromAddress);
  return (
    /^(?:no[-_.]?reply|mailer[-_.]?daemon|postmaster)@/i.test(from) ||
    /(?:automatic reply|auto(?:matic)?-?reply|out of office|delivery status notification|mail delivery subsystem|do not reply)/i.test(
      `${message.subject ?? ''}\n${body}`,
    )
  );
}

function isInternalForward(message: MailBaselineSourceMessage, body: string): boolean {
  const recipients = [
    ...(message.toAddresses ?? []),
    ...(message.ccAddresses ?? []),
    ...(message.bccAddresses ?? []),
  ];
  return (
    (message.direction === 'outbound' &&
      recipients.length > 0 &&
      recipients.every(isInternalAddress) &&
      /^(?:fwd?|tr|wg):/i.test(message.subject ?? '')) ||
    /(?:^|\n)\s*forwarded message:/i.test(body)
  );
}

function isAcknowledgement(message: MailBaselineSourceMessage, body: string): boolean {
  return (
    message.direction === 'outbound' &&
    /(?:received your (?:email|request)|thank you for (?:your|the) (?:email|request)|we(?:'| wi)ll get back to you)/i.test(
      `${message.subject ?? ''}\n${body}`,
    ) &&
    !/\b(?:confirm|confirmed|quote|rate|reservation|booking|payment|invoice|folio|arrival|departure)\b/i.test(
      body,
    )
  );
}

function askSignals(subject: string, body: string): MailBaselineAskCode[] {
  const text = `${subject}\n${body}`;
  const asks: MailBaselineAskCode[] = [];
  const add = (code: MailBaselineAskCode) => {
    if (!asks.includes(code)) asks.push(code);
  };
  if (/\b(?:reservation|booking|confirmation)\b/i.test(text)) add('reservation');
  if (/\b(?:price|rate|quote|cost|how much)\b/i.test(text)) add('price');
  if (/\b(?:payment|deposit|receipt|folio|invoice)\b/i.test(text)) add('payment');
  if (/\b(?:arrival|departure|check[- ]?in|check[- ]?out|stay dates?)\b/i.test(text)) add('stay');
  if (/\b(?:document|attachment|attached)\b/i.test(text)) add('document');
  if (asks.length === 0 && /\?|\b(?:please|could you|can you|kindly|confirm|advise)\b/i.test(text))
    add('general');
  return asks;
}

function deliveryFor(message: MailBaselineSourceMessage): MailBaselineDelivery | null {
  if (message.sendEvidence) return message.sendEvidence;
  if (message.direction !== 'outbound') return null;
  return { status: 'unknown' };
}

function deliveryAcceptanceKnown(
  message: MailBaselineSourceMessage,
  delivery: MailBaselineDelivery | null,
): boolean {
  if (!delivery) return false;
  if (delivery.status === 'accepted' || delivery.status === 'partial') {
    return asDate(delivery.acceptedAt) !== null;
  }
  return delivery.status === 'sent' && message.source === 'external_sent';
}

function baseEvidence(
  input: MailBaselineExtractionInput,
  clock: ReturnType<typeof eventClock>,
): Omit<
  MailBaselineEvidence,
  | 'id'
  | 'requestId'
  | 'askId'
  | 'eventType'
  | 'requiresHotelResponse'
  | 'requiresCustomerInformation'
  | 'answerState'
  | 'workState'
  | 'substantive'
  | 'delivery'
> {
  const message = input.message;
  return {
    threadId: message.threadId,
    transportId: message.transportId,
    direction: message.direction,
    eventAt: clock.at?.toISOString() ?? null,
    observedAt: clock.at?.toISOString() ?? null,
    source: message.source ?? (message.direction === 'outbound' ? 'external_sent' : 'mail_event'),
    sourceBasis: clock.basis,
    sourceMessageId: message.id,
    linkStrength:
      message.inReplyTo || (message.references?.length ?? 0) > 0 ? 'header' : 'ambiguous',
    classifierVersion: input.classifierVersion ?? MAIL_BASELINE_EXTRACTION_VERSION,
    reviewerVersion: input.reviewerVersion ?? null,
  };
}

/**
 * Produce compact semantic facts from one committed message. This is an
 * analytics-only producer; it never changes folders/read state or calls a
 * model. A missing event clock is retained as unknown evidence.
 */
export function extractMailBaselineEvidence(
  input: MailBaselineExtractionInput,
): MailBaselineExtractionResult {
  const message = input.message;
  const body = message.textBody ?? '';
  const subject = message.subject ?? '';
  const clock = eventClock(message);
  const base = baseEvidence(input, clock);
  const availabilityClock = clock.at === null || clock.basis === 'availability';
  const automated = isAutomatedMessage(message, body);
  const forwarded = isInternalForward(message, body);
  const acknowledgement = isAcknowledgement(message, body);
  const asks = askSignals(subject, body);
  const semanticOutput = input.semanticOutput;
  const semanticAskByCode = new Map((semanticOutput?.asks ?? []).map((ask) => [ask.askCode, ask]));
  const semanticAnswerByCode = new Map(
    (semanticOutput?.answers ?? []).map((answer) => [answer.askCode, answer]),
  );
  const evidence: MailBaselineEvidence[] = [];

  if (message.direction === 'inbound' && !automated) {
    const askCodes: MailBaselineAskCode[] = semanticOutput
      ? semanticOutput.asks.length > 0
        ? semanticOutput.asks.map((ask) => ask.askCode)
        : ['unknown']
      : asks.length > 0
        ? asks
        : ['unknown'];
    const inboundHeader = canonicalMessageId(message.messageIdHeader);
    for (const askCode of askCodes) {
      const semanticAsk = semanticAskByCode.get(askCode);
      const unresolved =
        askCode === 'unknown' || !semanticAsk || semanticAsk.workState === 'unknown';
      const askId = inboundHeader
        ? `${message.threadId}:header:${hash(inboundHeader)}:${askCode}`
        : `${message.threadId}:${message.id}:${askCode}`;
      evidence.push({
        ...base,
        id: `${message.id}:ask:${askCode}`,
        requestId: `${message.threadId}:request`,
        askId,
        eventType: 'ask',
        requiresHotelResponse: !unresolved && semanticAsk?.requiresHotelResponse === true,
        requiresCustomerInformation:
          !unresolved && semanticAsk?.requiresCustomerInformation === true,
        noReplyRequired: !unresolved && semanticAsk?.noReplyRequired === true,
        answerState: unresolved ? 'unknown' : null,
        workState: unresolved ? 'unknown' : (semanticAsk?.workState ?? 'unknown'),
        substantive: false,
        delivery: null,
        ...(unresolved
          ? {
              unknownReason: availabilityClock
                ? 'availability_clock_unavailable'
                : askCode === 'unknown'
                  ? 'no_supported_ask'
                  : semanticOutput
                    ? 'model_unknown_ask'
                    : 'semantic_route_unavailable',
            }
          : {}),
      });
    }
  }

  if (message.direction === 'outbound') {
    const header =
      canonicalMessageId(message.inReplyTo) ?? canonicalMessageId(message.references?.at(-1));
    const eventType = forwarded ? 'forward' : acknowledgement ? 'acknowledgement' : 'answer';
    const delivery = deliveryFor(message);
    const accepted =
      delivery?.status === 'accepted' ||
      delivery?.status === 'partial' ||
      delivery?.status === 'sent';
    const acceptanceKnown = deliveryAcceptanceKnown(message, delivery);
    const answerCodes: MailBaselineAskCode[] = semanticOutput
      ? semanticOutput.answers.length > 0
        ? semanticOutput.answers.map((answer) => answer.askCode)
        : ['unknown']
      : asks.length > 0
        ? asks
        : ['unknown'];
    for (const askCode of answerCodes) {
      const semanticAnswer = semanticAnswerByCode.get(askCode);
      const semanticEventType = semanticAnswer?.eventType;
      const substantive =
        !automated &&
        !forwarded &&
        !acknowledgement &&
        semanticAnswer?.substantive === true &&
        /\S/.test(body) &&
        accepted &&
        acceptanceKnown;
      const askId = header
        ? `${message.threadId}:header:${hash(header)}:${askCode}`
        : `${message.threadId}:unresolved`;
      evidence.push({
        ...base,
        id: `${message.id}:${semanticEventType ?? eventType}:${askCode}`,
        requestId: `${message.threadId}:request`,
        askId,
        eventType: semanticEventType ?? eventType,
        requiresHotelResponse: false,
        requiresCustomerInformation: false,
        answerState: substantive
          ? delivery?.status === 'partial'
            ? 'partial'
            : (semanticAnswer?.answerState ?? 'supported')
          : 'unknown',
        workState: substantive ? (semanticAnswer?.workState ?? 'complete') : 'unknown',
        substantive,
        linkStrength: header ? 'header' : 'ambiguous',
        delivery,
        unknownReason: availabilityClock
          ? 'availability_clock_unavailable'
          : !acceptanceKnown
            ? 'recipient_acceptance_unavailable'
            : semanticAnswer
              ? null
              : semanticOutput
                ? 'model_answer_missing'
                : 'semantic_route_unavailable',
      });
    }
  }

  return {
    extractionVersion: MAIL_BASELINE_EXTRACTION_VERSION,
    interpretationVersion: input.interpretationVersion ?? MAIL_BASELINE_INTERPRETATION_VERSION,
    sourceVintage: input.sourceVintage,
    sourceBasis: clock.basis,
    eventAt: clock.at?.toISOString() ?? null,
    evidence,
  };
}

/**
 * Invoke only an already-resolved purpose-bound extraction adapter. The model
 * sees the producer's message context; the returned projection remains body
 * free and is validated before semantic facts are emitted.
 */
export async function extractMailBaselineWithApprovedRoute(
  input: MailBaselineExtractionInput,
  route: MailBaselineExtractionRoute,
  options: { signal?: AbortSignal; deadlineAt?: number } = {},
): Promise<MailBaselineRoutedExtractionResult> {
  if (!route.available || !route.adapter) {
    return {
      extraction: extractMailBaselineEvidence(input),
      modelUsage: null,
      semanticRoute: 'unavailable_source_observation',
    };
  }
  const result = await route.adapter.invoke({
    modelId: 'approved-local',
    systemPrompt:
      'Classify one committed mail message into compact request/response facts. Return JSON only. Do not include or repeat the message body.',
    userPrompt: JSON.stringify({
      direction: input.message.direction,
      fromAddress: input.message.fromAddress,
      toAddresses: input.message.toAddresses ?? [],
      subject: input.message.subject ?? '',
      textBody: input.message.textBody ?? '',
      messageIdHeader: input.message.messageIdHeader ?? null,
      inReplyTo: input.message.inReplyTo ?? null,
      references: input.message.references ?? [],
      sendEvidence: input.message.sendEvidence ?? null,
    }),
    responseSchema: MAIL_BASELINE_SEMANTIC_RESPONSE_SCHEMA,
    signal: options.signal,
    deadlineAt: options.deadlineAt,
  });
  const semanticOutput = mailBaselineSemanticOutputSchema.parse(result.output);
  return {
    extraction: extractMailBaselineEvidence({
      ...input,
      classifierVersion: input.classifierVersion ?? 'mail-baseline-semantic-v1',
      semanticOutput,
    }),
    modelUsage: result.usage,
    semanticRoute: 'approved_local_extraction',
  };
}
