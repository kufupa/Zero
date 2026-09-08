/** Model-facing read-tool facade.
 *
 * Inputs are closed and opaque.  The implementation delegates to the trusted
 * executor; it never accepts URLs, selectors, scripts, or PMS record IDs.
 */
import { reservationContextRequestSchema } from './reservation-context-contract.js';
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
export const agentReadRequestSchema = z.union([
  hmsFindReservationInputSchema,
  hmsReadReservationInputSchema,
  hmsQuoteStayInputSchema,
]);

export type AgentReadRequest =
  | z.infer<typeof hmsFindReservationInputSchema>
  | z.infer<typeof hmsReadReservationInputSchema>
  | z.infer<typeof hmsQuoteStayInputSchema>;

export type AgentReadTool = {
  id: 'hms_find_reservation' | 'hms_read_reservation' | 'hms_quote_stay';
  description: string;
  inputSchema: z.ZodTypeAny;
  execute: (input: AgentReadRequest) => ReturnType<typeof executeRead>;
};

export function createAgentReadTools(
  context: ReadExecutionContext,
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
