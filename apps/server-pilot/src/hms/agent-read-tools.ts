/** Model-facing read-tool facade.
 *
 * Inputs are closed and opaque.  The implementation delegates to the trusted
 * executor; it never accepts URLs, selectors, scripts, or PMS record IDs.
 */
import {
  PROPERTY_KNOWLEDGE_CONTRACT_VERSION,
  PROPERTY_KNOWLEDGE_TOOL_ID,
  propertyKnowledgeAudienceSchema,
  propertyKnowledgeReadRequestSchema,
  propertyKnowledgeReadResultSchema,
  type PropertyKnowledgeAudience,
  type PropertyKnowledgeReadResult,
} from '../ai/property-knowledge-contract.js';
import {
  readPropertyKnowledge,
  type PropertyKnowledgeReader,
  type PropertyKnowledgeReadContextInput,
} from '../ai/property-knowledge-read.js';
import { reservationContextRequestSchema } from './reservation-context-contract.js';
import { assertCurrentAppAccessProof } from './requester-authorization.js';
import { executeRead, type ReadExecutionContext } from './read-service.js';
import { quoteRequestSchema } from './quote-request-normalization.js';
import { readRefSchema } from './read-service-contracts.js';
import { z } from 'zod';

/** Public tool inputs intentionally omit the dispatcher discriminator. */
export const hmsFindReservationInputSchema = z.object({ candidateId: readRefSchema }).strict();
export const hmsReadReservationInputSchema = reservationContextRequestSchema
  .omit({ toolId: true })
  .strict();
export const hmsQuoteStayInputSchema = z
  .object({
    quoteRequestRef: readRefSchema,
    detail: z.enum(['summary', 'detail']).default('summary'),
  })
  .strict();
export const propertyReadKnowledgeInputSchema = propertyKnowledgeReadRequestSchema;
export const agentReadRequestSchema = z.union([
  hmsFindReservationInputSchema,
  hmsReadReservationInputSchema,
  hmsQuoteStayInputSchema,
  propertyReadKnowledgeInputSchema,
]);

export type AgentReadRequest =
  | z.infer<typeof hmsFindReservationInputSchema>
  | z.infer<typeof hmsReadReservationInputSchema>
  | z.infer<typeof hmsQuoteStayInputSchema>
  | z.infer<typeof propertyReadKnowledgeInputSchema>;

export type AgentReadToolResult =
  | Awaited<ReturnType<typeof executeRead>>
  | PropertyKnowledgeReadResult;

export type AgentReadTool = {
  id:
    | 'hms_find_reservation'
    | 'hms_read_reservation'
    | 'hms_quote_stay'
    | 'property_read_knowledge';
  description: string;
  inputSchema: z.ZodTypeAny;
  execute: (input: AgentReadRequest) => Promise<AgentReadToolResult>;
};

export type AgentReadToolsOptions = {
  /** Server-wired local/storage reader; never constructed from model input. */
  propertyKnowledgeReader?: PropertyKnowledgeReader;
  /** Presentation audience, not an additional application role. */
  propertyKnowledgeAudience?: PropertyKnowledgeAudience;
};

export function createAgentReadTools(
  context: ReadExecutionContext,
  options: AgentReadToolsOptions = {},
): Readonly<Record<string, AgentReadTool>> {
  return {
    hms_find_reservation: {
      id: 'hms_find_reservation',
      description: 'Find a reservation from a trusted opaque candidate reference.',
      inputSchema: hmsFindReservationInputSchema,
      execute: (input) => hmsFindReservation(context, hmsFindReservationInputSchema.parse(input)),
    },
    hms_read_reservation: {
      id: 'hms_read_reservation',
      description:
        'Read entitled reservation sections from a trusted scoped reservation reference.',
      inputSchema: hmsReadReservationInputSchema,
      execute: (input) => hmsReadReservation(context, hmsReadReservationInputSchema.parse(input)),
    },
    hms_quote_stay: {
      id: 'hms_quote_stay',
      description:
        'Read trusted nightly quote facts from a producer-minted opaque request reference.',
      inputSchema: hmsQuoteStayInputSchema,
      execute: (input) => hmsQuoteStay(context, hmsQuoteStayInputSchema.parse(input)),
    },
    property_read_knowledge: {
      id: 'property_read_knowledge',
      description:
        'Read current approved generic property knowledge from a server-authorized local or attachment source; it does not replace reservation-specific booked policy.',
      inputSchema: propertyReadKnowledgeInputSchema,
      execute: (input) =>
        propertyReadKnowledge(
          context,
          options.propertyKnowledgeReader,
          propertyReadKnowledgeInputSchema.parse(input),
          options.propertyKnowledgeAudience ?? 'customer',
        ),
    },
  };
}

export async function hmsFindReservation(
  context: ReadExecutionContext,
  input: z.input<typeof hmsFindReservationInputSchema>,
) {
  const parsed = hmsFindReservationInputSchema.parse(input);
  return executeRead(context, { toolId: 'hms_find_reservation', candidateId: parsed.candidateId });
}

export async function hmsReadReservation(
  context: ReadExecutionContext,
  input: z.input<typeof hmsReadReservationInputSchema>,
) {
  const parsed = hmsReadReservationInputSchema.parse(input);
  return executeRead(context, { toolId: 'hms_read_reservation', ...parsed });
}

export async function hmsQuoteStay(
  context: ReadExecutionContext,
  input: z.input<typeof hmsQuoteStayInputSchema>,
) {
  const parsed = hmsQuoteStayInputSchema.parse(input);
  const quoteRequest = context.quoteRequests?.get(parsed.quoteRequestRef);
  if (!quoteRequest) throw new Error('quote request reference is not authorized in this context');
  return executeRead(context, {
    toolId: 'hms_quote_stay',
    quoteRequestRef: parsed.quoteRequestRef,
    quoteRequest: quoteRequestSchema.parse(quoteRequest),
    detail: parsed.detail,
  });
}

/**
 * Thin model-free adapter for the non-PMS property knowledge reader.  The
 * property scope comes from the trusted execution context; callers cannot
 * provide a property code, document ref, URL, locator or role claim.
 */
export async function propertyReadKnowledge(
  context: ReadExecutionContext,
  reader: PropertyKnowledgeReader | undefined,
  input: z.input<typeof propertyReadKnowledgeInputSchema>,
  audience: PropertyKnowledgeAudience = 'customer',
): Promise<PropertyKnowledgeReadResult> {
  const parsed = propertyReadKnowledgeInputSchema.parse(input);
  const parsedAudience = propertyKnowledgeAudienceSchema.parse(audience);
  if (context.requireCurrentAppAccess) {
    assertCurrentAppAccessProof({
      proof: context.currentAppAccessProof,
      requesterAuthorizationId: context.requester.authorizationId,
      context: {
        transportId: context.transportId,
        threadId: context.threadId,
        triggerMessageId: context.triggerMessageId,
      },
      now: context.now(),
    });
  }
  if (!reader) {
    return propertyKnowledgeReadResultSchema.parse({
      toolId: PROPERTY_KNOWLEDGE_TOOL_ID,
      schemaVersion: PROPERTY_KNOWLEDGE_CONTRACT_VERSION,
      status: 'unavailable',
      scopeRef: context.propertyCode,
      data: null,
      evidence: [],
      issues: [
        {
          code: 'SOURCE_UNAVAILABLE',
          detail: 'property knowledge reader is not server-configured',
        },
      ],
    });
  }
  const readerContext: PropertyKnowledgeReadContextInput = {
    propertyRef: context.propertyCode,
    audience: parsedAudience,
    now: context.now(),
    signal: context.signal,
  };
  return readPropertyKnowledge(reader, parsed, readerContext);
}
